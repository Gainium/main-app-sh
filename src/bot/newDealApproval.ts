import {
  IndicatorAction,
  StartConditionEnum,
  intervalMap,
  type ExchangeIntervals,
  type SettingsIndicators,
} from '../../types'

/**
 * Last-step approval of a new deal.
 *
 * `openNewDeal` asks {@link NewDealApprovalContext} a final yes/no after every
 * built-in gate (max deals, range, balance, cooldowns, risk/reward, exchange
 * minimum) has passed and immediately before the deal is created. The engine's
 * own answer is always yes; a deployment may override the hook to add its own
 * filter. Manual opens never reach the hook.
 */

/** What started the attempt to open a deal. */
export type NewDealTrigger =
  | 'indicator'
  | 'webhook'
  | 'asap'
  | 'timer'
  | 'dynamic'
  | 'manual'

export type NewDealSignal = {
  timeframe?: string
  conditions?: string[]
  indicatorValues?: Record<string, unknown>
}

export type NewDealApprovalContext = {
  botId: string
  symbol: string
  trigger: NewDealTrigger
  signal?: NewDealSignal
  price?: number
  time: number
  /** Set by a refusing hook; recorded on the bot's `Deal` event. */
  refusalReason?: string
  /**
   * Set by a refusing hook: ask again after this many ms. Only an ASAP bot
   * uses it — nothing else re-attempts an ASAP entry until a deal closes or
   * the bot restarts; other start conditions retry on their next signal.
   */
  retryAfterMs?: number
  /**
   * Set by a refusing hook with `retryAfterMs`: re-attempt this entry then
   * whatever the start condition (with the same trigger), not only on an ASAP
   * bot. Every engine gate runs again on the re-attempt.
   */
  retryOpen?: boolean
  /**
   * Set by an approving hook: open the deal at this multiple of the configured
   * size (base order and every safety order). Applied only where the engine
   * can scale the deal (see {@link applyNewDealSize}); otherwise the deal
   * opens at the configured size and the outcome says why.
   */
  sizeMultiplier?: number
  /**
   * What `sizeMultiplier` scales: `whole` (default) the base order and every
   * DCA order, `base` the base order only (DCA orders keep their size).
   */
  sizeScope?: 'base' | 'whole'
  /**
   * Who asked for `sizeMultiplier`: an approving hook (default), or the
   * `baseOrderSize` of the webhook that triggered the deal. A webhook's size
   * is the sender's explicit choice, so it is not held to the hook bounds —
   * only to the balance and exchange-minimum checks.
   */
  sizeSource?: 'extension' | 'webhook'
  /** An extension's own reference for this approval (e.g. its decision id). */
  extensionRef?: string
  /**
   * Spec 139 §3.2.7: the request adds an entry to the open position `dealId`
   * of a single-position bot instead of opening a deal. A size multiplier is
   * not applied to an entry.
   */
  entry?: boolean
  dealId?: string
}

/** Bounds of a new deal's size multiplier, enforced by the engine. */
export const NEW_DEAL_SIZE_MIN = 0.1
export const NEW_DEAL_SIZE_MAX = 3

/** Why a requested size multiplier was not applied. */
export type NewDealSizeReason =
  | 'not_supported'
  | 'risk_reward'
  | 'size_type'
  | 'reduced_to_available'
  | 'out_of_bounds'
  | 'unsizeable'
  | 'insufficient_balance'
  | 'below_exchange_min'

/** What happened to a requested size multiplier. */
export type NewDealSizeOutcome = {
  requested: number
  /** the multiplier the deal opened with (1 = the configured size) */
  applied: number
  /** what it scaled */
  scope?: 'base' | 'whole'
  reason?: NewDealSizeReason
  source?: 'extension' | 'webhook'
}

const SIZE_REASON_TEXT: Record<NewDealSizeReason, string> = {
  not_supported: 'not available for this deal type',
  risk_reward: 'the size comes from risk/reward',
  size_type: 'the order size follows a percentage of the balance',
  reduced_to_available: 'the deal is already reduced to the available balance',
  out_of_bounds: 'outside the allowed range',
  unsizeable: 'the deal could not be sized',
  insufficient_balance: 'not enough balance for the larger deal',
  below_exchange_min: 'an order would fall under the exchange minimum',
}

export const fmtMultiplier = (m: number) => `${Math.round(m * 100) / 100}×`

/** The `Deal` event text of a requested size (only when it is not 1×). */
export const newDealSizeDescription = (o: NewDealSizeOutcome): string =>
  o.applied !== 1
    ? `Deal opened at ${fmtMultiplier(o.applied)} the configured ${
        o.scope === 'base' ? 'base order' : 'size'
      } (requested by ${o.source === 'webhook' ? 'webhook' : 'extension'})`
    : `Requested size ${fmtMultiplier(o.requested)} not applied (${
        SIZE_REASON_TEXT[o.reason ?? 'unsizeable']
      }) — opened at the configured size`

export const newDealSizeReasonText = (r?: NewDealSizeReason | null) =>
  r ? SIZE_REASON_TEXT[r] : ''

/**
 * Classify an `openNewDeal` call. An explicit label from the call site wins;
 * otherwise the flags and the bot's start condition decide.
 *
 * `skip && !dynamic` is the manual path (`openNewDealMan`: dashboard, API):
 * it skips range and cooldown checks and never asks the hook.
 */
export const resolveNewDealTrigger = (
  skip: boolean,
  dynamic: boolean,
  startCondition?: StartConditionEnum | string,
  explicit?: NewDealTrigger,
): NewDealTrigger => {
  if (skip && !dynamic) {
    return 'manual'
  }
  if (explicit) {
    return explicit
  }
  if (dynamic) {
    return 'dynamic'
  }
  switch (startCondition) {
    case StartConditionEnum.ti:
      return 'indicator'
    case StartConditionEnum.tradingviewSignals:
      return 'webhook'
    case StartConditionEnum.timer:
      return 'timer'
    case StartConditionEnum.manual:
      return 'manual'
    default:
      return 'asap'
  }
}

/**
 * The start-deal indicator conditions of a bot, and the shortest of their
 * timeframes (the one whose next candle can produce the next signal).
 */
export const buildNewDealSignal = (
  indicators?: Pick<
    SettingsIndicators,
    | 'type'
    | 'indicatorAction'
    | 'indicatorCondition'
    | 'indicatorValue'
    | 'indicatorValue2'
    | 'indicatorInterval'
    | 'indicatorLength'
  >[],
): NewDealSignal | undefined => {
  const start = (indicators ?? []).filter(
    (i) => i.indicatorAction === IndicatorAction.startDeal,
  )
  if (!start.length) {
    return undefined
  }
  let timeframe: string | undefined
  let shortest = Infinity
  for (const i of start) {
    const ms = intervalMap[i.indicatorInterval as ExchangeIntervals]
    if (ms && ms < shortest) {
      shortest = ms
      timeframe = i.indicatorInterval
    }
  }
  return {
    timeframe,
    conditions: start.map((i) =>
      `${i.type}(${i.indicatorLength ?? ''}) ${i.indicatorCondition ?? ''} ${
        i.indicatorValue ?? ''
      }${i.indicatorCondition === 'bw' ? `..${i.indicatorValue2 ?? ''}` : ''} @${
        i.indicatorInterval
      }`.replace(/\s+/g, ' '),
    ),
  }
}

export const newDealSkippedDescription = (reason?: string) =>
  `New deal skipped by extension: ${reason?.trim() || 'no reason given'}`
