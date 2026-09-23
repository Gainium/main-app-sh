import { DCADealStatusEnum, OrderStatusType } from '../../../types'

/**
 * A base order that stopped part-filled.
 *
 * `startDeal` — the only thing that gives a deal an average price, a cost, a
 * usage figure, a take-profit and a stop-loss — is reached exclusively from
 * `processFilledOrder`, so only a base order the engine holds as `FILLED` ever
 * opens a deal. A base order left `PARTIALLY_FILLED` therefore keeps its deal
 * in `start` indefinitely, even though the venue has already executed part of
 * it and the account is holding that position untracked.
 *
 * `checkBaseOrder` is the engine's answer to "the entry did not complete in
 * time", and both of its branches act only when the order is neither `FILLED`
 * nor `PARTIALLY_FILLED`. The enter-market branch is the LAST check a deal
 * gets — it clears the reposition timer on the way in and is itself the timer
 * that fired — so a partial fill seen there ends the deal's life as a thing
 * anything will look at again. There is no periodic sweep for `start` deals;
 * the bot's restore path is the only other visitor, and it runs once per start.
 *
 * The same stranding has a second, worse shape: the VENUE ends the order while
 * it is part filled, so the row goes straight to `CANCELED`/`EXPIRED` carrying
 * its executed quantity. `checkBaseOrder` cannot even be the one to notice,
 * because its timers are armed only for a LIMIT entry — a MARKET entry arms
 * nothing, and for it the order queue's cancel callback is the engine's whole
 * knowledge of the order.
 *
 * Specs `specs/038…` and `specs/048…`.
 */
export type PartialBaseEntryInputs = {
  /** Status of the deal's `dealStart` row, as the engine currently holds it. */
  orderStatus: OrderStatusType | string | null | undefined
  /** The deal's own status. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /**
   * Whether a further check is still scheduled for this deal.
   *
   * This is the whole reason the decision is not simply "is it partly filled".
   * While the enter-market check is still armed, a partial fill is allowed to
   * go on filling — cancelling it at the reposition timer's 10 s would end
   * entries that were about to complete, and would change repositioning for
   * every bot. The engine expresses "a check is still coming" as the presence
   * of timer state for the deal in this process: `dealTimersMap` holds an entry
   * from the moment `placeBaseOrder` arms anything, and holds nothing at all
   * for a deal the process has not placed a base order for — which is exactly
   * the restore path's situation after a bot start.
   */
  hasPendingCheck: boolean
  /**
   * What the venue reports as executed on the row, as the engine holds it.
   *
   * Only consulted for a TERMINAL status — a `PARTIALLY_FILLED` row states a
   * fill by being that status, and spec 038 deliberately does not ask how much.
   */
  executedQty?: string | number | null
  /**
   * When the venue last touched the row.
   *
   * Only consulted for a TERMINAL status, and for the reason
   * `processCanceledOrder` already applies it to a cancelled take-profit: a
   * cancel row written from a REST response rather than a stream event can
   * carry a bogus `executedQty` alongside `updateTime: -1`, and production
   * holds such rows. Opening a deal on an invented fill is worse — and
   * silently so — than the stranding this settles. Spec 048 §4.1.
   */
  updateTime?: number | null
}

/** Statuses after which the venue will never move the order again. */
const terminalStatuses = new Set(['CANCELED', 'EXPIRED'])

/**
 * A terminal row that nonetheless holds a position: the venue ended the order
 * and told us, in the same message, how much of it had already executed.
 *
 * No upper bound on the quantity. The cancelled-take-profit rule declines at
 * `executedQty >= origQty` because a full execution is the `FILLED` path's to
 * close; here the equivalent guard is the deal's own status (below), and
 * refusing a fully-executed-but-only-reported-as-cancelled entry would leave
 * exactly the stranding this exists to remove. Spec 048 §4.1.
 */
export function terminalEntryHoldsAFill(
  orderStatus: OrderStatusType | string | null | undefined,
  executedQty: string | number | null | undefined,
  updateTime: number | null | undefined,
): boolean {
  if (!orderStatus || !terminalStatuses.has(`${orderStatus}`)) {
    return false
  }
  const executed = +(executedQty ?? 0)
  if (!isFinite(executed) || executed <= 0) {
    return false
  }
  return typeof updateTime === 'number' && updateTime > 0
}

/**
 * Whether a part-filled base order should be settled now: remainder cancelled,
 * deal opened on the quantity the venue actually executed.
 *
 * Deliberately NOT consulted:
 *
 * - the order's TYPE. A LIMIT entry stops part-filled with a live remainder on
 *   the book; a MARKET entry on a thin spot book stops part-filled with nothing
 *   resting at all. Both strand the deal identically, and the cancel handles
 *   both — a remainder that is already gone comes back through the venue's
 *   unknown-order path, which reports what really happened.
 * - how MUCH filled. Any executed quantity is a position the account holds, and
 *   the deal is the only thing that would ever close it.
 */
export function shouldSettlePartialBaseEntry(
  args: PartialBaseEntryInputs,
): boolean {
  const { orderStatus, dealStatus, hasPendingCheck, executedQty, updateTime } =
    args
  if (
    orderStatus !== 'PARTIALLY_FILLED' &&
    !terminalEntryHoldsAFill(orderStatus, executedQty, updateTime)
  ) {
    return false
  }
  // Re-opening a deal that is already open, or reviving a terminal one, would
  // be far worse than the stranding this fixes.
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  return !hasPendingCheck
}

/** How long after the cancel report the deal is looked at again. */
export const canceledBaseEntryDelayMs = 15_000

/** What the cancelled-entry decision reads. */
export type UnfilledBaseEntryCancelInputs = {
  /** Status of the `dealStart` row the cancel report is about. */
  orderStatus: OrderStatusType | string | null | undefined
  /** What the venue reports as executed on it. */
  executedQty?: string | number | null
  /** The deal's own status. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /** Timer state for the deal — see {@link PartialBaseEntryInputs}. */
  hasPendingCheck: boolean
  /** Whether this bot asked for the cancel (`isOwnCancel`). */
  ownCancel: boolean
  /** Other `dealStart` rows of the deal still resting on the venue. */
  liveEntries?: number
}

/**
 * A base order someone else cancelled before any of it traded.
 *
 * The deal has nothing on the venue and no position, but stays in `start`, and
 * `restoreWork` re-sends the entry on every worker start — a trade the user
 * cancelled comes back each deploy, and a `start` deal offers no action in the
 * dashboard to end it. Cancelling the deal is what a cancel from the dashboard
 * would have done.
 *
 * Only `CANCELED`: an `EXPIRED` row is the venue ending the order on its own
 * terms, not the account holder deciding against the trade. Everything the
 * engine cancels itself — a reposition, a re-size, a close — is either
 * recorded by `noteOwnCancel`, covered by the deal's timers, or happens after
 * the deal has already left `start`.
 */
export function isUnattributedUnfilledBaseEntryCancel(
  args: UnfilledBaseEntryCancelInputs,
): boolean {
  const {
    orderStatus,
    executedQty,
    dealStatus,
    hasPendingCheck,
    ownCancel,
    liveEntries = 0,
  } = args
  if (orderStatus !== 'CANCELED') {
    return false
  }
  const executed = +(executedQty || 0)
  if (!isFinite(executed) || executed > 0) {
    return false
  }
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  return !ownCancel && !hasPendingCheck && liveEntries === 0
}

/** What the top-up decision reads. */
export type TopUpSettledBaseEntryInputs = {
  /** What the settled row executed, as the venue reported it. */
  executedQty?: string | number | null
  /** What it asked for — the user's configured base order size, in base units. */
  origQty?: string | number | null
  /** When the venue last touched the row. */
  updateTime?: number | null
  /** Now. */
  now: number
  /**
   * The bot's own entry window —
   * `orderLimitRepositionTimeout + enterMarketTimeout`.
   *
   * Not a constant: a bot that widened its `limitTimeout` widened the period
   * in which "enter at market" is still the answer it asked for, and this
   * widens with it.
   */
  entryWindowMs: number
}

/**
 * How much later than the venue's last touch a settle may still buy the
 * missing part of the entry: the bot's entry window plus this, for venue and
 * order-queue latency between the last fill and the settle firing.
 */
const topUpSlackMs = 60_000

/**
 * Whether a settled base entry should be topped back up to the size its owner
 * configured, with a market order for the difference.
 *
 * `settlePartialBaseEntry` opens the deal on whatever executed. That is right
 * — the account is holding it — but it is only half the answer: the user asked
 * for a base order of a stated size, and the entry machinery is allowed to
 * change how that size is bought, not how much. Production settles a median
 * 39.6 % of the requested quantity.
 *
 * AGE is what decides it, not which caller is settling. Two of the three act
 * seconds after the venue last touched the order — the enter-market timer, and
 * the order queue's cancel callback for a MARKET entry, which arms no timer at
 * all — while the third is the bot's restore path, which spec `038` measured
 * recovering rows 2 h 41 m and 9.9 h old. Buying into a nine-hour-old entry at
 * today's price is not the market entry the user asked for. Both live paths sit
 * inside the bot's own entry window; the restore path's rows are orders of
 * magnitude outside it.
 *
 * Spec `057` §4.1/§4.2.
 */
export function shouldTopUpSettledBaseEntry(
  args: TopUpSettledBaseEntryInputs,
): boolean {
  const { executedQty, origQty, updateTime, now, entryWindowMs } = args
  const executed = Number(executedQty)
  const requested = Number(origQty)
  if (
    !isFinite(executed) ||
    !isFinite(requested) ||
    requested <= 0 ||
    executed <= 0 ||
    executed >= requested
  ) {
    return false
  }
  // Same reason `terminalEntryHoldsAFill` insists on it: a row written from a
  // REST response can carry `updateTime: -1`, and a row that cannot be dated
  // cannot be shown to be current.
  if (typeof updateTime !== 'number' || updateTime <= 0) {
    return false
  }
  return now - updateTime <= entryWindowMs + topUpSlackMs
}

/** A base-entry row as one report of it describes it. */
export type SettledBaseEntryRow = {
  status: OrderStatusType | string | null | undefined
  executedQty?: string | null
  price?: string | null
  updateTime?: number | null
}

/** What the deal should be opened on. */
export type SettledBaseEntryFill = {
  executedQty: string
  price: string
  updateTime: number
}

/**
 * Which report of a settled base entry states what it traded: the row the
 * cancel came back with, or the row the engine held when it asked.
 *
 * `cancelOrderOnExchange` copies every field of the venue's cancel RESPONSE
 * onto the order — `executedQty` and `price` included, only `clientOrderId`,
 * `origQty` and `origPrice` are spared — and a cancel response is not obliged
 * to be a fill report. Kraken spot's is synthesised wholesale with
 * `executedQty: '0'` and `price: '0'`, so by the time the settle reads its
 * answer the fill the user stream had already delivered is a zero, the
 * promotion guard inside `cancelOrderOnExchange` declines on that zero, and
 * the deal strands with a position nothing is tracking. An order's executed
 * quantity never decreases, so a response that reports less than we already
 * read is an ABSENCE of information, not a correction. Spec 059 §4.1.
 *
 * `null` means book nothing, and the two ways of getting there are different:
 * a cancel that ENDED the order without stating a fill is a settled entry that
 * genuinely traded nothing, while no answer at all leaves a remainder that may
 * still be resting — opening a deal on a fraction of that would double-book
 * it. Both keep the caller's warn.
 */
export function settledBaseEntryFill(
  settled: SettledBaseEntryRow | null | undefined,
  observed: SettledBaseEntryRow,
): SettledBaseEntryFill | null {
  if (!settled?.status || !terminalStatuses.has(`${settled.status}`)) {
    return null
  }
  const stated = terminalEntryHoldsAFill(
    settled.status,
    settled.executedQty,
    settled.updateTime,
  )
    ? settled
    : // The response ended the order but said nothing about what it traded,
      // so its `price` is not a fill price either — both come from the report
      // that does state one. `CANCELED` is asserted rather than read off
      // `observed`, whose status is the pre-cancel one (`PARTIALLY_FILLED`):
      // what is being dated and sized here is the ended order.
      terminalEntryHoldsAFill(
          'CANCELED',
          observed.executedQty,
          observed.updateTime,
        )
      ? observed
      : null
  if (!stated) {
    return null
  }
  return {
    executedQty: `${stated.executedQty}`,
    price: `${stated.price ?? settled.price}`,
    updateTime: stated.updateTime as number,
  }
}

/** The `dealStart` rows a deal has, as the restore path reads them. */
export type RestoreBaseEntryRow = {
  status: OrderStatusType | string | null | undefined
  executedQty?: string | number | null
  updateTime?: number | null
}

/**
 * Which of a `start` deal's `dealStart` rows the restore path should act on.
 *
 * The read this replaces filtered `CANCELED` out in the query, which made a
 * base order the venue had cancelled after a partial fill invisible: the deal
 * fell through to "never started" and the entry was RE-PLACED, buying on top of
 * a position the account was already holding. Production shows that happening
 * twice on consecutive worker starts for one deal.
 *
 * Strictly additive to that behaviour — whenever the old query returned a row,
 * this returns the same one. A cancelled row is used only when nothing else is
 * there AND it carries an executed quantity; a cancelled row with no fill is
 * still ignored, so a deal whose entry was cancelled outright still re-places
 * it and no venue round trip is added for it. Spec 048 §4.2.
 */
export function pickRestoreBaseEntry<T extends RestoreBaseEntryRow>(
  rows: T[] | null | undefined,
): T | undefined {
  const notCanceled = (rows ?? []).find((r) => r.status !== 'CANCELED')
  if (notCanceled) {
    return notCanceled
  }
  return (rows ?? []).find((r) =>
    terminalEntryHoldsAFill(r.status, r.executedQty, r.updateTime),
  )
}
