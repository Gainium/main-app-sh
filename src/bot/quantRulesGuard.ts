import RedisClient from '../db/redis'
import logger from '../utils/logger'
import { quantRulesEventDb } from '../db/dbInit'

/**
 * Binance Futures Quantitative Rules (error -4400) cooldown guard.
 *
 * Binance temporarily restricts a futures account when it trips their
 * "Quantitative Rules" (message: "Futures Trading Quantitative Rules violated,
 * only reduceOnly order is allowed, please try again later."):
 *   - Level 1: the affected symbol is restricted for 5 minutes.
 *   - Level 2: the same symbol violates 10 times within 24h -> 2 hours.
 *   - Level 3: 10+ symbols restricted at once -> the WHOLE ACCOUNT is
 *     reduce-only for 2 hours.
 * During a restriction, reduce-only orders and cancels still work.
 *
 * This guard tracks violations per account (= per API key = exchangeUUID) and
 * per symbol, computes the cooldown level/expiry, and lets the bot engine gate
 * order placement so we stop hammering Binance (which would otherwise escalate
 * L1 -> L2 -> L3). It follows the FundingStore pattern: a static class with no
 * instance state, flat namespaced Redis keys, and fail-open semantics — the
 * ONLY state shared across the per-bot-type PM2 workers is Redis.
 *
 * All methods are fail-open: on any Redis error we log and behave as if there
 * were no cooldown, so a Redis blip never wedges order placement.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000

/** Level-2 threshold: same symbol violates >= this many times within 24h. */
const LEVEL2_VIOLATIONS = 10
/** Level-3 threshold: this many symbols restricted at once -> account-wide. */
const LEVEL3_SYMBOLS = 10

const LEVEL1_DURATION_MS = 5 * MIN_MS
const LEVEL2_DURATION_MS = 2 * HOUR_MS
const ACCOUNT_DURATION_MS = 2 * HOUR_MS

const logPrefix = '[QuantRulesGuard]'

/** zset of violation timestamps for one account+symbol (pruned to 24h). */
const violKey = (exchangeUUID: string, symbol: string) =>
  `qr:viol:${exchangeUUID}:${symbol}`

/** JSON {level, until} for one account+symbol cooldown; TTL = cooldown secs. */
const symbolCooldownKey = (exchangeUUID: string, symbol: string) =>
  `qr:cd:${exchangeUUID}:${symbol}`

/** JSON {level:3, until} for a whole-account cooldown; TTL 2h. */
const accountCooldownKey = (exchangeUUID: string) =>
  `qr:cd:${exchangeUUID}:account`

/** zset of currently-restricted symbols; score = until-timestamp (ms). */
const activeSymbolsKey = (exchangeUUID: string) => `qr:active:${exchangeUUID}`

type CooldownState = {
  level: number
  until: number
}

export type RecordViolationInput = {
  userId: string
  exchangeUUID: string
  exchange: string
  symbol: string
  botId?: string
  botType?: string
  dealId?: string
  reason?: string
}

export type RecordViolationResult = {
  /**
   * True when this violation opened a NEW cooldown window (or escalated the
   * level/scope). False when it's a repeat rejection inside an existing window
   * (debounced — don't re-alert / re-log for those).
   */
  isNew: boolean
  scope: 'symbol' | 'account'
  level: number
  /** Cooldown expiry (ms epoch). */
  until: number
  violationCount24h: number
}

export type CheckResult = {
  restricted: boolean
  scope: 'symbol' | 'account' | null
  level: number | null
  /** Cooldown expiry (ms epoch), or null when not restricted. */
  until: number | null
}

const NOT_RESTRICTED: CheckResult = {
  restricted: false,
  scope: null,
  level: null,
  until: null,
}

const parseCooldown = (
  raw: string | null | undefined | void,
): CooldownState | null => {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CooldownState>
    const level = Number(parsed.level)
    const until = Number(parsed.until)
    if (!Number.isFinite(level) || !Number.isFinite(until)) {
      return null
    }
    return { level, until }
  } catch {
    return null
  }
}

export class QuantRulesGuard {
  /**
   * Record a -4400 rejection for an account+symbol and (re)compute the cooldown.
   *
   * Returns whether this opened a NEW window. Repeat rejections inside an
   * existing window return {isNew:false} so callers don't spam the user or the
   * event log. Every NEW window is persisted to the `quantrulesevents`
   * collection.
   */
  static async recordViolation(
    input: RecordViolationInput,
  ): Promise<RecordViolationResult> {
    const { exchangeUUID, symbol } = input
    const now = +new Date()
    try {
      const redis = await RedisClient.getInstance()

      // 1. Record this violation timestamp, prune anything older than 24h,
      //    then count the surviving violations for the symbol.
      const vKey = violKey(exchangeUUID, symbol)
      // Unique member per violation so identical timestamps don't collapse.
      await redis.zAdd(vKey, { score: now, value: `${now}:${Math.random()}` })
      await redis.zRemRangeByScore(vKey, '-inf', `(${now - DAY_MS}`)
      await redis.expire(vKey, Math.ceil(DAY_MS / 1000))
      const members =
        (await redis.zRangeByScore(vKey, now - DAY_MS, '+inf')) ?? []
      const violationCount24h = members.length

      // 2. Compute the symbol cooldown level + duration.
      const level = violationCount24h >= LEVEL2_VIOLATIONS ? 2 : 1
      const durationMs = level === 2 ? LEVEL2_DURATION_MS : LEVEL1_DURATION_MS
      const until = now + durationMs

      // 3. Debounce: if a same-or-higher-level cooldown already exists for
      //    this symbol (key existence implies an active window — its TTL is
      //    the cooldown duration), this is a repeat rejection inside that
      //    window — don't re-alert / re-log and don't slide the expiry.
      //    (Comparing `until` here would be wrong: a repeat always computes a
      //    LATER until, so every in-flight repeat would look "new".)
      const cdKey = symbolCooldownKey(exchangeUUID, symbol)
      const existing = parseCooldown(await redis.get(cdKey))
      if (existing && existing.level >= level) {
        return {
          isNew: false,
          scope: 'symbol',
          level: existing.level,
          until: existing.until,
          violationCount24h,
        }
      }

      // Otherwise set/overwrite the symbol cooldown and register it active.
      await redis.set(
        cdKey,
        JSON.stringify({ level, until }),
        Math.ceil(durationMs / 1000),
      )
      await redis.zAdd(activeSymbolsKey(exchangeUUID), {
        score: until,
        value: symbol,
      })

      // 4. Count currently-active (not-yet-expired) restricted symbols. If we
      //    hit the level-3 threshold and no account cooldown exists yet, open
      //    a whole-account reduce-only window (2h). This is an escalation.
      const aKey = activeSymbolsKey(exchangeUUID)
      await redis.zRemRangeByScore(aKey, '-inf', `(${now}`)
      await redis.expire(aKey, Math.ceil(ACCOUNT_DURATION_MS / 1000))
      const activeSymbols = (await redis.zRangeByScore(aKey, now, '+inf')) ?? []

      let scope: 'symbol' | 'account' = 'symbol'
      let resultLevel = level
      let resultUntil = until

      const accKey = accountCooldownKey(exchangeUUID)
      const existingAccount = parseCooldown(await redis.get(accKey))
      if (activeSymbols.length >= LEVEL3_SYMBOLS && !existingAccount) {
        const accountUntil = now + ACCOUNT_DURATION_MS
        await redis.set(
          accKey,
          JSON.stringify({ level: 3, until: accountUntil }),
          Math.ceil(ACCOUNT_DURATION_MS / 1000),
        )
        scope = 'account'
        resultLevel = 3
        resultUntil = accountUntil
      }

      // 5. Persist the NEW event (symbol window opened/escalated, or account
      //    escalation) to Mongo for the dashboard / admin-app / GraphQL.
      await QuantRulesGuard.persistEvent(input, {
        scope,
        level: resultLevel,
        until: resultUntil,
        violationCount24h,
      })

      return {
        isNew: true,
        scope,
        level: resultLevel,
        until: resultUntil,
        violationCount24h,
      }
    } catch (e) {
      // Fail-open: never let a Redis/Mongo error break the order path. Report
      // as a fresh symbol-level cooldown so the caller still delays the order.
      logger.error(
        `${logPrefix} recordViolation ${exchangeUUID}:${symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
      return {
        isNew: true,
        scope: 'symbol',
        level: 1,
        until: now + LEVEL1_DURATION_MS,
        violationCount24h: 1,
      }
    }
  }

  /**
   * Is placing a (non-reduceOnly) order for this account+symbol currently
   * blocked by a Quantitative Rules cooldown? Account scope wins over symbol
   * scope. Fail-open: on any Redis error, returns restricted=false.
   */
  static async check(
    exchangeUUID: string,
    symbol: string,
  ): Promise<CheckResult> {
    try {
      const redis = await RedisClient.getInstance()
      const now = +new Date()

      const account = parseCooldown(
        await redis.get(accountCooldownKey(exchangeUUID)),
      )
      if (account && account.until > now) {
        return {
          restricted: true,
          scope: 'account',
          level: account.level,
          until: account.until,
        }
      }

      const sym = parseCooldown(
        await redis.get(symbolCooldownKey(exchangeUUID, symbol)),
      )
      if (sym && sym.until > now) {
        return {
          restricted: true,
          scope: 'symbol',
          level: sym.level,
          until: sym.until,
        }
      }

      return NOT_RESTRICTED
    } catch (e) {
      logger.error(
        `${logPrefix} check ${exchangeUUID}:${symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
      return NOT_RESTRICTED
    }
  }

  private static async persistEvent(
    input: RecordViolationInput,
    computed: {
      scope: 'symbol' | 'account'
      level: number
      until: number
      violationCount24h: number
    },
  ): Promise<void> {
    try {
      await quantRulesEventDb.createData({
        userId: input.userId,
        exchangeUUID: input.exchangeUUID,
        exchange: input.exchange,
        // Account-scope events are not tied to a single symbol.
        symbol: computed.scope === 'account' ? undefined : input.symbol,
        scope: computed.scope,
        level: computed.level as 1 | 2 | 3,
        until: new Date(computed.until),
        violationCount24h: computed.violationCount24h,
        botId: input.botId,
        botType: input.botType,
        dealId: input.dealId,
        reason: input.reason,
      })
    } catch (e) {
      logger.error(
        `${logPrefix} persistEvent ${input.exchangeUUID}:${input.symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
    }
  }
}

export default QuantRulesGuard
