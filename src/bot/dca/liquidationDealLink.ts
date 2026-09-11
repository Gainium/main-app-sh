/**
 * Linking a venue liquidation back to the deal(s) it ended — spec `040`.
 *
 * `MainBot` builds the liquidation `Order` off the user stream and persists it
 * immediately, but it is built in code shared by every bot type, at a point
 * where nothing yet knows which deal the liquidated position belonged to. So
 * the row lands with no `dealId` — and every per-deal read is keyed on exactly
 * that (`Bot.getDealOrders` matches `{ dealId, botId, status: 'FILLED' }`).
 *
 * The consequence a user sees: a deal that ends `closeTrigger: liquidation`
 * shows only its entry orders. The dashboard's chart markers come from that
 * same list, so it draws no close marker either — the deal simply stops, at a
 * loss, with nothing on it that says why. One reporter watched it happen to
 * ten deals on one bot and concluded the platform was closing trades at random.
 *
 * DCA's `processLiquidationOrder` is the first place that knows the answer: it
 * holds the bot's open deals on the symbol, and closes them. These functions
 * turn "which deals were open before, which are still open after" into the
 * writes that record the link. Pure, so the rule survives a refactor of the
 * method around it.
 */

/**
 * The deals this liquidation ended: open before it, no longer open after.
 *
 * Measured rather than assumed (spec 040 §4.4) — a deal that is still open did
 * not end here, whatever the close was asked to do, and must not be given a
 * closing order it never had.
 */
export const dealsClosedByLiquidation = (
  openBefore: string[],
  openAfter: string[],
): string[] => {
  const stillOpen = new Set(openAfter)
  return [...new Set(openBefore)].filter((id) => id && !stillOpen.has(id))
}

/**
 * `clientOrderId` is uniquely indexed, so a second deal closed by the same
 * venue liquidation cannot reuse it. Deal-scoped and derived, so the row is
 * still recognisably the same liquidation.
 */
export const liquidationCopyClientOrderId = (
  clientOrderId: string,
  dealId: string,
): string => `${clientOrderId}-${dealId}`

export type LiquidationLink =
  /** Stamp the `dealId` onto the row `MainBot` already saved. */
  | { kind: 'claim'; clientOrderId: string; dealId: string }
  /** Save a deal-scoped copy of it, for a further deal the same event closed. */
  | { kind: 'copy'; clientOrderId: string; dealId: string }

/**
 * What to write for each deal the liquidation closed.
 *
 * One venue liquidation can end more than one deal (a DCA bot may hold
 * overlapping deals on the same pair) and one row can only name one deal, so
 * the first deal claims the existing row and the rest get copies (spec 040
 * §4.2). A bot holding one deal per pair — the ordinary case — therefore
 * produces a single field update and no new document.
 */
export const liquidationDealLinks = (
  clientOrderId: string,
  closedDealIds: string[],
): LiquidationLink[] =>
  closedDealIds.map((dealId, i) =>
    i === 0
      ? { kind: 'claim', clientOrderId, dealId }
      : {
          kind: 'copy',
          clientOrderId: liquidationCopyClientOrderId(clientOrderId, dealId),
          dealId,
        },
  )
