import RedisClient, { RedisWrapper } from '../db/redis'
import { reconcileSweepDb } from '../db/dbInit'
import { KEYS, log, STALE_THRESHOLD_MS } from './utils'
import {
  tick,
  catchRateTick,
  EMPTY_STATE,
  type WatchdogState,
  type WatchdogAction,
  type CatchRateThresholds,
} from './stateMachine'

export type ActionDispatcher = (action: WatchdogAction) => Promise<void>

/** Missed-fill failsafe escalation thresholds (spec §3.4), env-tunable. */
function catchRateThresholds(): CatchRateThresholds {
  return {
    windowMs: Number(process.env.FF_ESCALATE_WINDOW_MS ?? 86_400_000),
    selfHealN: Number(process.env.FF_ESCALATE_SELFHEAL_N ?? 3),
    informN: Number(process.env.FF_ESCALATE_INFORM_N ?? 3),
  }
}

export async function runWatchdogTick(
  dispatch: ActionDispatcher,
): Promise<void> {
  const redis = await RedisClient.getInstance()
  const now = Date.now()

  // 1. Find everything currently past the freshness threshold.
  //    node-redis takes min/max as strings; '(' prefix = exclusive, same as raw Redis syntax.
  const staleIds = await redis.zRangeByScore(
    KEYS.lastEventTime,
    '-inf',
    `(${now - STALE_THRESHOLD_MS}`,
  )

  // 2. Also pull known incidents so we can detect recovery even for accounts
  //    that just dropped off the stale list this tick.
  const incidentIds = await redis.instance?.sMembers(KEYS.activeIncidents)

  const candidateIds = Array.from(
    new Set([...(staleIds ?? []), ...(incidentIds ?? [])]),
  )

  if (candidateIds.length === 0) return
  log(`debug`, `Found ${candidateIds.length} candidates`)
  const staleSet = new Set(staleIds ?? [])

  // 3. Batch-read consumer presence + state hash for every candidate in one round trip.
  //    Cast to `any` here: node-redis's multi() tracks each chained command's
  //    return type, which fights a dynamic-length loop. We parse raw replies
  //    by hand below anyway, so the precise typing buys us nothing here.
  const readMulti = redis.instance?.multi()
  if (!readMulti) return
  for (const id of candidateIds) {
    readMulti.exists(KEYS.hasConsumer(id)).hGetAll(KEYS.watchdogState(id))
  }
  const results = await readMulti.execAsPipeline()
  // results is a flat array, 2 entries per candidate, in the same order queued:
  // [exists0, hgetall0, exists1, hgetall1, ...]

  const writeMulti = redis.instance?.multi()

  if (!writeMulti) return

  for (let i = 0; i < candidateIds.length; i++) {
    const accountId = candidateIds[i]
    const existsResult = results[i * 2] as unknown as number // 1 or 0
    const stateResult = results[i * 2 + 1] as unknown as Record<string, string>

    const hasConsumer = existsResult === 1
    const state = parseState(stateResult)

    const { nextState, actions } = tick({
      accountId,
      now,
      isStale: staleSet.has(accountId),
      hasConsumer,
      state,
    })

    applyStateChange(writeMulti, accountId, state, nextState)

    for (const action of actions) {
      // fire-and-await outside the pipeline — these are side effects
      // (RPC to connector, pub/sub to bots), not Redis writes.
      await dispatch(action)
    }
  }

  await writeMulti.execAsPipeline()

  // Second, independent signal source: catch-rate escalation (spec §3.4).
  // Runs after the staleness pass; never reuses failureCount/backoff.
  await runCatchRateEscalation(dispatch, now).catch((err) => {
    log('warn', 'catch-rate escalation failed', err)
  })
}

/**
 * Missed-fill failsafe escalation (spec §3.4). Groups recent
 * `reconcilesweepcatches` by exchangeUUID and, for chronic offenders, drives
 * the pure {@link catchRateTick} decision: self-heal the stream once, then
 * INFORM USERS once. State rides in the same `watchdogState` hash via the two
 * ff* fields; the staleness fields are never touched here.
 */
async function runCatchRateEscalation(
  dispatch: ActionDispatcher,
  now: number,
): Promise<void> {
  const thresholds = catchRateThresholds()
  const redis = await RedisClient.getInstance()

  // Window count per exchangeUUID (exclude paper — those catches are simulated
  // and must never self-heal a real user's live stream). Mirrors the windowed
  // count the INFORM USERS handler already does in bot/main.ts.
  const windowAgg = await reconcileSweepDb.aggregate<{
    _id: string
    count: number
  }>([
    {
      $match: {
        paperContext: { $ne: true },
        created: { $gt: new Date(now - thresholds.windowMs) },
      },
    },
    { $group: { _id: '$exchangeUUID', count: { $sum: 1 } } },
  ])

  const windowCounts = windowAgg.data?.result ?? []
  if (windowCounts.length === 0) return

  log('debug', `catch-rate: ${windowCounts.length} accounts with catches`)

  for (const { _id: accountId, count: catchCountWindow } of windowCounts) {
    if (!accountId) continue

    const raw = await redis.instance?.hGetAll(KEYS.watchdogState(accountId))
    const state = parseState(raw)

    // Catches strictly after the last self-heal — the "still catching" signal.
    let catchCountSinceSelfHeal = 0
    if (typeof state.ffSelfHealAt === 'number') {
      const sinceAgg = await reconcileSweepDb.countData({
        exchangeUUID: accountId,
        paperContext: { $ne: true },
        created: { $gt: new Date(state.ffSelfHealAt) },
      })
      catchCountSinceSelfHeal = sinceAgg.data?.result ?? 0
    }

    const { ffSelfHealAt, ffInformAt, actions } = catchRateTick({
      accountId,
      now,
      catchCountWindow,
      catchCountSinceSelfHeal,
      state,
      thresholds,
    })

    for (const action of actions) {
      await dispatch(action)
    }

    const ffFields: Record<string, string> = {}
    if (ffSelfHealAt != null) ffFields.ffSelfHealAt = String(ffSelfHealAt)
    if (ffInformAt != null) ffFields.ffInformAt = String(ffInformAt)
    if (Object.keys(ffFields).length > 0) {
      await redis.instance?.hSet(KEYS.watchdogState(accountId), ffFields)
    }
  }
}

function parseState(
  raw: Record<string, string> | null | undefined,
): WatchdogState {
  if (!raw || Object.keys(raw).length === 0) return { ...EMPTY_STATE }
  const state: WatchdogState = {
    failureCount: Number(raw.failureCount ?? 0),
    lastAction: (raw.lastAction as WatchdogState['lastAction']) || null,
    nextCheckAt: Number(raw.nextCheckAt ?? 0),
  }
  // Optional missed-fill failsafe fields — absent on hashes written before
  // §3.4 shipped, so only surface them when actually present.
  if (raw.ffSelfHealAt != null && raw.ffSelfHealAt !== '') {
    state.ffSelfHealAt = Number(raw.ffSelfHealAt)
  }
  if (raw.ffInformAt != null && raw.ffInformAt !== '') {
    state.ffInformAt = Number(raw.ffInformAt)
  }
  return state
}

function applyStateChange(
  multi: ReturnType<NonNullable<RedisWrapper['_instance']>['multi']>,
  accountId: string,
  prevState: WatchdogState,
  nextState: WatchdogState | null,
): void {
  const stateKey = KEYS.watchdogState(accountId)

  if (nextState === null) {
    // Healthy again: drop the staleness fields and the incident marker. Keep
    // the missed-fill failsafe fields (§3.4) if present — they track a
    // different, slower signal and must survive a staleness recovery so the
    // catch-rate escalation doesn't re-fire from scratch.
    if (prevState.ffSelfHealAt != null || prevState.ffInformAt != null) {
      multi.del(stateKey)
      const ffFields: Record<string, string> = {}
      if (prevState.ffSelfHealAt != null) {
        ffFields.ffSelfHealAt = String(prevState.ffSelfHealAt)
      }
      if (prevState.ffInformAt != null) {
        ffFields.ffInformAt = String(prevState.ffInformAt)
      }
      multi.hSet(stateKey, ffFields)
    } else {
      multi.del(stateKey)
    }
    multi.sRem(KEYS.activeIncidents, accountId)
    return
  }

  multi.hSet(stateKey, {
    failureCount: String(nextState.failureCount),
    lastAction: nextState.lastAction ?? '',
    nextCheckAt: String(nextState.nextCheckAt),
  })

  if (nextState.failureCount > 0 && prevState.failureCount === 0) {
    multi.sAdd(KEYS.activeIncidents, accountId)
  }
}
