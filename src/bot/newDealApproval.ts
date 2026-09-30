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
}

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
      } @${i.indicatorInterval}`.replace(/\s+/g, ' '),
    ),
  }
}

export const newDealSkippedDescription = (reason?: string) =>
  `New deal skipped by extension: ${reason?.trim() || 'no reason given'}`
