import { DCADealStatusEnum, DCATypeEnum } from '../../../types'

/**
 * How long a DCA deal may sit in `start` before the hourly sweep
 * (`closeOldStartDeals`) cancels it.
 */
export const OLD_START_DEAL_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The query the stuck-start sweep uses to pick DCA deals to cancel.
 *
 * A terminal deal with a limit entry is a resting limit order the user placed
 * on purpose; it waits in `start` until the price reaches it, and the sweep
 * must leave it alone. The exclusion is a `$nor`, not a top-level `$not`:
 * `$not` is only a field-level operator, so mongoose's `strictQuery` strips it
 * from the filter without an error and the exclusion silently disappears.
 *
 * Spec `specs/121.old-start-sweep-cancels-terminal-limit-orders.md`.
 */
export const oldStartDcaDealsFilter = (now: number) => ({
  status: DCADealStatusEnum.start,
  $nor: [{ type: DCATypeEnum.terminal, 'settings.useLimitPrice': true }],
  createTime: {
    $lt: now - OLD_START_DEAL_AGE_MS,
  },
})
