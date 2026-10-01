import {
  CloseConditionEnum,
  DCACloseTriggerEnum,
  IndicatorAction,
  IndicatorSection,
  intervalMap,
  type ExchangeIntervals,
  type SettingsIndicators,
} from '../../types'

/**
 * Approval of a signal-based take-profit close.
 *
 * When a take-profit close signal (a close-deal indicator group, or a webhook
 * `close` action) is about to close a deal, `closeAllDeals` asks
 * {@link DealCloseApprovalContext} a final yes/no per deal, after the
 * minimum-profit check. The engine's own answer is always yes; a deployment
 * may override the hook to add its own filter.
 *
 * Never asked for: stop loss of any kind, manual / API closes, force closes
 * (liquidation, `ignoreSettings` webhooks, automatic cancels), take profit by
 * resting orders, or bot stop.
 */

/** What produced the close signal. */
export type DealCloseTrigger = 'indicator' | 'webhook'

export type DealCloseSignal = {
  timeframe?: string
  conditions?: string[]
}

export type DealCloseApprovalContext = {
  botId: string
  dealId: string
  symbol: string
  trigger: DealCloseTrigger
  signal?: DealCloseSignal
  time: number
  /** Set by a refusing hook; recorded on the bot's `Deal` event. */
  refusalReason?: string
}

/**
 * Which signal-based take profit this close is, or null when it is not one
 * (and the hook must not be asked). Pure.
 */
export const resolveDealCloseTrigger = (p: {
  closeTrigger?: DCACloseTriggerEnum
  slSource?: boolean
  force?: boolean
  useTp?: boolean
  dealCloseCondition?: CloseConditionEnum | string
}): DealCloseTrigger | null => {
  if (p.force || p.slSource || !p.useTp) {
    return null
  }
  if (
    p.closeTrigger === DCACloseTriggerEnum.tp &&
    p.dealCloseCondition === CloseConditionEnum.techInd
  ) {
    return 'indicator'
  }
  if (
    p.closeTrigger === DCACloseTriggerEnum.webhook &&
    p.dealCloseCondition === CloseConditionEnum.webhook
  ) {
    return 'webhook'
  }
  return null
}

/**
 * The take-profit close indicator conditions of a bot, and the shortest of
 * their timeframes (the one whose next candle can produce the next signal).
 */
export const buildDealCloseSignal = (
  indicators?: Pick<
    SettingsIndicators,
    | 'type'
    | 'indicatorAction'
    | 'indicatorCondition'
    | 'indicatorValue'
    | 'indicatorInterval'
    | 'indicatorLength'
    | 'section'
  >[],
): DealCloseSignal | undefined => {
  const close = (indicators ?? []).filter(
    (i) =>
      i.indicatorAction === IndicatorAction.closeDeal &&
      i.section !== IndicatorSection.sl,
  )
  if (!close.length) {
    return undefined
  }
  let timeframe: string | undefined
  let shortest = Infinity
  for (const i of close) {
    const ms = intervalMap[i.indicatorInterval as ExchangeIntervals]
    if (ms && ms < shortest) {
      shortest = ms
      timeframe = i.indicatorInterval
    }
  }
  return {
    timeframe,
    conditions: close.map((i) =>
      `${i.type}(${i.indicatorLength ?? ''}) ${i.indicatorCondition ?? ''} ${
        i.indicatorValue ?? ''
      } @${i.indicatorInterval}`.replace(/\s+/g, ' '),
    ),
  }
}

export const dealCloseHeldDescription = (reason?: string) =>
  `Close signal held by extension: ${reason?.trim() || 'no reason given'}`
