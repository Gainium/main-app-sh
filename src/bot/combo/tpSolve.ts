/**
 * The Combo take-profit / stop-loss equation, and its inverse.
 *
 * A combo deal's percentage is **not** a price move. It is the deal's whole
 * P&L — realized grid profit, funding, the open position marked at some price,
 * minus commissions — divided by the deal's *usage*, i.e. the funds it has
 * deployed. So "TP 1.1%" means "1.1% of usage", and on a deal that has
 * laddered deep that can be a small absolute number.
 *
 * `getDealStopLossPriceCombo` needs the price that hits a target percentage;
 * `claculateTpSlFromPrice` needs the percentage at a price, and the engine
 * feeds the first into the second on every recalculation to check they agree.
 * They are one equation solved two ways, and they were maintained as two
 * hand-written copies — a term added to one and missed in the other produces
 * no error, just a take profit that fires at the wrong number. They live here
 * together so the round-trip can be pinned by a test.
 *
 * Sign convention: `funding` is signed, negative when the deal paid. Amounts
 * are all denominated in the deal's profit currency — quote normally, base for
 * `profitBase` deals (spot `profitCurrency: 'base'`, and every coin-margined
 * future). `computeFunding` already denominates the accrual in the settlement
 * asset, which is the same asset in both cases, so no conversion is needed.
 */

export interface ComboTpSolveInput {
  isLong: boolean
  /** Profit is denominated in the base asset rather than the quote asset. */
  profitBase: boolean
  initialBalances: { base: number; quote: number }
  currentBalances: { base: number; quote: number }
  /** Realized profit so far (for a combo: the grid profit booked to date). */
  profit: number
  /** Funding accrued so far, signed — negative means the deal paid it. */
  funding: number
  /** Estimated commissions across the deal's fills so far. */
  fullFee: number
  /** Fee rate used to price the exit itself. */
  fee: number
  /** Usage the percentage is measured against (max or current, per settings). */
  denominator: number
}

/**
 * The position size and cost basis both directions of the equation share.
 * Exported because they are the first two numbers you want when a take profit
 * has to be reconstructed after the fact from a log line.
 */
export function comboSolveParts(i: ComboTpSolveInput) {
  const longMult = i.isLong ? 1 : -1
  const qty = i.isLong
    ? i.currentBalances.base
    : i.initialBalances.base - i.currentBalances.base
  // Reconstructs the position's cost basis: the balance delta still has the
  // grid profit credited into it, so `profit` is added back to cancel it out.
  // Funding is deliberately absent — it never touches `currentBalances`, it is
  // applied to `profit` when the deal closes.
  const quote =
    (i.isLong
      ? i.initialBalances.quote - i.currentBalances.quote
      : i.currentBalances.quote) + (i.profitBase ? 0 : i.profit * longMult)
  return { longMult, qty, quote }
}

/** The deal's P&L if the position were closed at `price`. */
export function comboPnlAtPrice(i: ComboTpSolveInput, price: number): number {
  const { longMult, qty, quote } = comboSolveParts(i)
  const quoteTp = qty * price
  const base = quote / price + (i.profitBase ? i.profit * longMult : 0)
  return (
    i.profit +
    i.funding +
    (i.profitBase ? qty - base : quoteTp - quote) * longMult -
    i.fullFee -
    (i.profitBase ? qty * i.fee : quoteTp * i.fee)
  )
}

/** That P&L as a fraction of usage — the number the TP/SL setting names. */
export function comboPercentAtPrice(
  i: ComboTpSolveInput,
  price: number,
): number {
  return comboPnlAtPrice(i, price) / i.denominator
}

/**
 * The price at which `comboPercentAtPrice` equals `target`.
 *
 * Returns `null` when usage is zero — there is no percentage to hit, and the
 * caller must not place a level.
 *
 * In the `profitBase` branch `profit` cancels out of the P&L (it appears once
 * directly and once through `base`), which is why `funding` is subtracted only
 * inside the target group there and not beside the `qty` term: adding it in
 * both places would apply it twice.
 */
export function comboPriceForTarget(
  i: ComboTpSolveInput,
  target: number,
): number | null {
  if (!i.denominator) {
    return null
  }
  const { longMult, qty, quote } = comboSolveParts(i)
  if (i.profitBase) {
    return (
      quote /
      (qty -
        i.profit * longMult -
        (target * i.denominator -
          i.profit -
          i.funding +
          i.fullFee +
          qty * i.fee) /
          longMult)
    )
  }
  return (
    (target * i.denominator +
      i.fullFee -
      i.profit -
      i.funding +
      quote * longMult) /
    (qty * (longMult - i.fee))
  )
}
