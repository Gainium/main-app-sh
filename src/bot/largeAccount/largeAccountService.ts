/**
 * Large account mode — counts, cache and override I/O (main-app spec 019 §2).
 *
 * The decision itself is pure (`largeAccountRule.ts`). This service:
 * - counts the three signals per trading context with bounded `countDocuments`;
 * - caches the result per user+context for {@link LARGE_ACCOUNT_TTL_MS} in
 *   memory, and persists it on the user (`largeAccountStats.<live|paper>`) so
 *   the hysteresis memory survives a restart and is shared by API processes;
 * - reads and writes the tri-state override (`largeAccountOverride`).
 *
 * No cron: counts are recomputed lazily when a client asks and the cached
 * value is older than the TTL, and dropped from the in-process cache when a
 * bot is created or deleted.
 */
import {
  BotStatusEnum,
  DCADealStatusEnum,
  DCATypeEnum,
  StatusEnum,
} from '../../../types'
import {
  botDb,
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
  userDb,
} from '../../db/dbInit'
import logger from '../../utils/logger'
import {
  LARGE_ACCOUNT_THRESHOLDS,
  LargeAccountCounts,
  LargeAccountOverride,
  LargeAccountOverrideBy,
  decideLargeAccount,
  normalizeOverride,
  userCanEnable,
  userCanRevert,
  userModeChange,
} from './largeAccountRule'

const logPrefix = 'LargeAccount |'

export const LARGE_ACCOUNT_TTL_MS = 10 * 60 * 1000
/** Counts past this are reported as this; far above every threshold. */
const COUNT_CAP = 50_000

const ACTIVE_BOT_STATUSES = [
  BotStatusEnum.open,
  BotStatusEnum.range,
  BotStatusEnum.error,
  BotStatusEnum.monitoring,
]

export type LargeAccountContextStats = LargeAccountCounts & {
  autoActive: boolean
  computedAt: Date
}

export type LargeAccountUserFields = {
  largeAccountOverride?: LargeAccountOverride
  largeAccountOverrideBy?: LargeAccountOverrideBy | null
  largeAccountOverrideAt?: Date
  largeAccountStats?: {
    live?: LargeAccountContextStats
    paper?: LargeAccountContextStats
  }
}

export type LargeAccountView = {
  active: boolean
  source: 'auto' | 'override'
  reason: string | null
  override: LargeAccountOverride
  overrideBy: LargeAccountOverrideBy | null
  canUserEnable: boolean
  canUserRevert: boolean
  paperContext: boolean
  counts: LargeAccountCounts
  thresholds: typeof LARGE_ACCOUNT_THRESHOLDS
  computedAt: Date
}

const contextKey = (paperContext: boolean) => (paperContext ? 'paper' : 'live')

export class LargeAccountService {
  private static instance: LargeAccountService | null = null
  static getInstance() {
    if (!LargeAccountService.instance) {
      LargeAccountService.instance = new LargeAccountService()
    }
    return LargeAccountService.instance
  }

  /** `${userId}:${live|paper}` → stats, in-process. */
  private cache = new Map<string, LargeAccountContextStats>()
  /** Coalesces concurrent recomputes for the same key. */
  private inflight = new Map<string, Promise<LargeAccountContextStats>>()

  /** Drop the in-process cache for a user (bot created or deleted). */
  invalidate(userId: string) {
    for (const ctx of ['live', 'paper']) {
      this.cache.delete(`${userId}:${ctx}`)
      this.dirty.add(`${userId}:${ctx}`)
    }
  }
  /** Keys whose persisted stats must not be trusted until recomputed. */
  private dirty = new Set<string>()

  async countSignals(
    userId: string,
    paperContext: boolean,
  ): Promise<LargeAccountCounts> {
    const paper = paperContext ? { $eq: true } : { $ne: true }
    const botActive = {
      $or: [
        { status: { $in: ACTIVE_BOT_STATUSES } },
        { 'deals.active': { $gt: 0 } },
      ],
    }
    const n = (r: { status: StatusEnum; data?: { result: number } | null }) =>
      r.status === StatusEnum.ok ? (r.data?.result ?? 0) : 0
    const [dca, combo, grid, hedgeDca, hedgeCombo, dcaOpen, comboOpen, term] =
      await Promise.all([
        dcaBotDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            parentBotId: { $exists: false },
            'settings.type': { $ne: DCATypeEnum.terminal },
            ...botActive,
          } as never,
          COUNT_CAP,
        ),
        comboBotDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            parentBotId: { $exists: false },
            'settings.type': { $ne: DCATypeEnum.terminal },
            ...botActive,
          } as never,
          COUNT_CAP,
        ),
        botDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            status: { $in: ACTIVE_BOT_STATUSES },
          } as never,
          COUNT_CAP,
        ),
        hedgeDCABotDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            status: { $in: ACTIVE_BOT_STATUSES },
          } as never,
          COUNT_CAP,
        ),
        hedgeComboBotDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            status: { $in: ACTIVE_BOT_STATUSES },
          } as never,
          COUNT_CAP,
        ),
        // `status: 'open'` exactly (not $in) so the open-only partial index
        // {userId, createTime} serves it; start/error deals are transient.
        dcaDealsDb.countData(
          {
            userId,
            status: DCADealStatusEnum.open,
            paperContext: paper,
          } as never,
          COUNT_CAP,
        ),
        comboDealsDb.countData(
          {
            userId,
            status: DCADealStatusEnum.open,
            paperContext: paper,
          } as never,
          COUNT_CAP,
        ),
        dcaBotDb.countData(
          {
            userId,
            paperContext: paper,
            isDeleted: { $ne: true },
            'settings.type': DCATypeEnum.terminal,
          } as never,
          COUNT_CAP,
        ),
      ])
    return {
      activeBots: n(dca) + n(combo) + n(grid) + n(hedgeDca) + n(hedgeCombo),
      openDeals: n(dcaOpen) + n(comboOpen),
      terminalBots: n(term),
    }
  }

  private async readUser(userId: string) {
    const user = await userDb.readData<
      LargeAccountUserFields & { _id: string }
    >({ _id: userId }, {
      largeAccountOverride: 1,
      largeAccountOverrideBy: 1,
      largeAccountOverrideAt: 1,
      largeAccountStats: 1,
    } as never)
    if (user.status !== StatusEnum.ok || !user.data?.result) {
      return null
    }
    return user.data.result as LargeAccountUserFields
  }

  private async contextStats(
    userId: string,
    paperContext: boolean,
    user: LargeAccountUserFields,
    now: number,
  ): Promise<LargeAccountContextStats> {
    const key = `${userId}:${contextKey(paperContext)}`
    const fresh = (s?: LargeAccountContextStats) =>
      !!s?.computedAt && now - +new Date(s.computedAt) < LARGE_ACCOUNT_TTL_MS
    const cached = this.cache.get(key)
    const dirty = this.dirty.has(key)
    if (!dirty && fresh(cached)) return cached as LargeAccountContextStats
    const stored = user.largeAccountStats?.[contextKey(paperContext)]
    if (!dirty && fresh(stored)) {
      this.cache.set(key, stored as LargeAccountContextStats)
      return stored as LargeAccountContextStats
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const previouslyAutoActive = !!(cached ?? stored)?.autoActive
    this.dirty.delete(key)
    const run = (async () => {
      const counts = await this.countSignals(userId, paperContext)
      const decision = decideLargeAccount(counts, previouslyAutoActive, 'auto')
      const stats: LargeAccountContextStats = {
        ...counts,
        autoActive: decision.autoActive,
        computedAt: new Date(now),
      }
      this.cache.set(key, stats)
      const write = await userDb.updateData(
        { _id: userId } as never,
        {
          $set: { [`largeAccountStats.${contextKey(paperContext)}`]: stats },
        } as never,
      )
      if (write.status !== StatusEnum.ok) {
        logger.warn(
          `${logPrefix} ${userId} cannot persist stats ${write.reason}`,
        )
      }
      return stats
    })()
    this.inflight.set(key, run)
    try {
      return await run
    } finally {
      this.inflight.delete(key)
    }
  }

  async getLargeAccount(
    userId: string,
    paperContext: boolean,
    now = Date.now(),
  ): Promise<LargeAccountView | null> {
    const user = await this.readUser(userId)
    if (!user) return null
    const stats = await this.contextStats(userId, paperContext, user, now)
    const override = normalizeOverride(user.largeAccountOverride)
    const overrideBy =
      override === 'auto' ? null : (user.largeAccountOverrideBy ?? null)
    // The cached stats already carry the hysteresis outcome; re-deciding from
    // them with the same memory is idempotent and applies the override.
    const decision = decideLargeAccount(stats, stats.autoActive, override)
    return {
      active: decision.active,
      source: decision.source,
      reason: decision.reason,
      override,
      overrideBy,
      canUserEnable: userCanEnable(override),
      canUserRevert: userCanRevert(override, overrideBy),
      paperContext,
      counts: {
        activeBots: stats.activeBots,
        openDeals: stats.openDeals,
        terminalBots: stats.terminalBots,
      },
      thresholds: LARGE_ACCOUNT_THRESHOLDS,
      computedAt: stats.computedAt,
    }
  }

  /** The user's own switch: 'on', or back to 'auto' from their own 'on'. */
  async setUserMode(userId: string, mode: string, paperContext: boolean) {
    const user = await this.readUser(userId)
    if (!user) {
      return { status: StatusEnum.notok, reason: 'User not found', data: null }
    }
    const change = userModeChange(
      {
        override: normalizeOverride(user.largeAccountOverride),
        by: user.largeAccountOverrideBy ?? undefined,
      },
      mode,
    )
    if (!change.ok) {
      return { status: StatusEnum.notok, reason: change.reason, data: null }
    }
    const write = await userDb.updateData(
      { _id: userId } as never,
      {
        $set: {
          largeAccountOverride: change.override,
          largeAccountOverrideBy: change.by,
          largeAccountOverrideAt: new Date(),
        },
      } as never,
    )
    if (write.status !== StatusEnum.ok) {
      return { status: StatusEnum.notok, reason: write.reason, data: null }
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: await this.getLargeAccount(userId, paperContext),
    }
  }
}
