import {
  BotStartTypeEnum,
  CloseConditionEnum,
  StartConditionEnum,
} from '../../types'

/**
 * The fields of a boot-query row that decide when a bot is resumed.
 * Everything is optional: a row from an older projection orders as "rest".
 */
export type RestartOrderRow = {
  deals?: { active?: number }
  settings?: {
    startCondition?: string
    dealCloseCondition?: string
    dealCloseConditionSL?: string
    botActualStart?: string
  }
}

/**
 * Projection a boot query adds so its rows can be ordered by
 * {@link restartResumeOrder}.
 */
export const restartOrderProjection = {
  'deals.active': 1,
  'settings.startCondition': 1,
  'settings.dealCloseCondition': 1,
  'settings.dealCloseConditionSL': 1,
  'settings.botActualStart': 1,
} as const

/** True for a bot that a webhook signal drives: starts, closes or is switched by one. */
export function isWebhookDriven(row: RestartOrderRow): boolean {
  const s = row.settings
  if (!s) return false
  return (
    s.startCondition === StartConditionEnum.tradingviewSignals ||
    s.dealCloseCondition === CloseConditionEnum.webhook ||
    s.dealCloseConditionSL === CloseConditionEnum.webhook ||
    s.botActualStart === BotStartTypeEnum.webhook
  )
}

/**
 * 0 = webhook-driven with an open deal, 1 = webhook-driven, 2 = an open deal,
 * 3 = the rest. Lower resumes first.
 */
export function restartResumeTier(row: RestartOrderRow): number {
  const open = (row.deals?.active ?? 0) > 0
  const webhook = isWebhookDriven(row)
  if (webhook && open) return 0
  if (webhook) return 1
  if (open) return 2
  return 3
}

/**
 * The order a restarted bot service resumes its bots in.
 *
 * Resumes are paced (the boot-resume stagger spreads ~9k DCA bots over ~30s),
 * so a bot's position in this list is most of its time-to-ready. A webhook
 * signal has a sender that gave up after a few seconds and a short shelf life
 * (`WEBHOOK_SIGNAL_MAX_AGE_MS`), and an open deal has a position on the
 * exchange that its TP/SL is supposed to be guarding, so those go first. A
 * bot with neither is waiting for its own start condition and loses nothing
 * by resuming a few seconds later. Stable within a tier.
 */
export function restartResumeOrder<T extends RestartOrderRow>(rows: T[]): T[] {
  return rows
    .map((row, i) => ({ row, i, tier: restartResumeTier(row) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((r) => r.row)
}
