/**
 * How much fee-order base a combo close may sweep along with the position.
 *
 * A combo bot with `feeOrder` on buys a little extra base so the venue's fee
 * can be paid without eating into the position. When the deal closes by close
 * order, that remainder is sold in the SAME order as the position — otherwise
 * it is stranded as dust, and on a pair with a large minimum order size it can
 * never be sold at all. That is a deliberate design decision, not an accident:
 * the alternative left users holding unsellable remainders.
 *
 * The quantity to sweep is tracked on the deal as `feeBalance` — credited when
 * one of the deal's fee orders fills, drawn down as entry fees consume it.
 *
 * The trap: `feeBalance` is a stored number, and a deal can carry a POSITIVE
 * one without ever having bought any fee base — a bot-level balance is handed
 * to whichever deal is open, and nothing checks that the base still exists.
 * Adding an unbacked credit asks the venue to sell base the account does not
 * hold, and the venue refuses the close. Nothing about the deal then changes,
 * so the identical quantity is re-sent on every later attempt and the deal can
 * never close on its own.
 *
 * So the credit is clamped to what this deal's own fee orders actually bought.
 * A deal that bought fee base still sweeps it (the 2024 behaviour is intact);
 * a deal that bought none sweeps nothing and closes at its true position.
 */
export function backedFeeDust({
  feeBalance,
  feeOrderBase,
}: {
  /**
   * The deal's `feeBalance`, already converted to BASE units by the caller
   * (the kucoin new-fee variant stores it in quote and divides by the deal's
   * initial price first). May be negative — fees drew it below zero — or
   * positive but unbacked.
   */
  feeBalance: number
  /**
   * Base bought by this deal's OWN filled fee orders. The ceiling: the credit
   * cannot exceed what was actually purchased for it.
   */
  feeOrderBase: number
}): number {
  if (!Number.isFinite(feeBalance) || !Number.isFinite(feeOrderBase)) {
    return 0
  }
  return Math.min(Math.max(0, feeBalance), Math.max(0, feeOrderBase))
}
