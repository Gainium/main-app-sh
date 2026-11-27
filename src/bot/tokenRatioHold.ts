/**
 * Spec 296 — hold a spot deal whose pair the venue re-denominated.
 *
 * When a venue changes a token's ratio (a split or a reverse split) during a
 * halt, the pair reopens at a multiple of its old price and every account's
 * base balance is converted by the same ratio, while our deal documents keep
 * the old units. Trading such a deal fights the venue: the take profit is
 * priced in old units, a stop or a buy-back closes the wrong quantity, and the
 * close books a profit that never happened. Until the deal is rescaled (spec
 * 295's planner), the only correct thing to do is nothing.
 *
 * Pure: plain numbers in, a verdict out. The caller reads them.
 *
 * The evidence and why it is safe:
 *
 * - `avgPrice / price` must be ≥ {@link PRICE_JUMP} or ≤ 1/{@link PRICE_JUMP}.
 *   This is the cheap gate: below it nothing is read, so a deal that is not
 *   far from its entry behaves exactly as before.
 * - `baselineBase` is the account's base balance in a portfolio snapshot taken
 *   before the deal was created, so it precedes any change the deal lived
 *   through. `venueBase` is the balance now.
 * - For a fall (a split), the factor is `(venueBase − buysSince) / baseline`.
 *   Every recorded buy since the snapshot is subtracted and every recorded sell
 *   is ignored, so the figure is a LOWER bound on how much the balance grew by
 *   itself. When nothing outside our fills changed the balance, it is ≤ 1 and
 *   the deal is never held, however far the price fell.
 * - For a rise (a reverse split), the factor is `(venueBase + sellsSince) /
 *   baseline`, an UPPER bound on the shrink. With no outside change it is ≥ 1.
 * - The factor must move the same way as the price, by at least
 *   {@link PRICE_JUMP}, and lie within {@link FACTOR_BAND}× of the price
 *   factor. The price factor includes the market move during the halt (on the
 *   SNDKB event the ratio was 8 while deals priced 9.2× to 15.7× above the
 *   reopen), so the band is loose on purpose; it is not a ±10% match.
 *
 * What it cannot tell apart: base that reached the account outside our
 * recorded fills (a deposit, or a buy placed on the venue directly) while the
 * deal is that far from its entry. That balance DID jump, by a factor near the
 * price's; the deal is held and the user is told how to release it (a manual
 * close still runs).
 */

/** The price must be this far from the deal's average, either way. */
export const PRICE_JUMP = 2

/** The balance factor must lie within this multiple of the price factor. */
export const FACTOR_BAND = 2.5

/** How long one verdict stands before the evidence is read again. */
export const TOKEN_RATIO_RECHECK_MS = 10 * 60 * 1000

/**
 * A portfolio snapshot used as the baseline must be keyed at least this long
 * before the deal was created. A snapshot document is keyed by the user's
 * local day and overwritten through that day, so its content can be up to
 * ~38h after its key; 48h puts the content before the deal for any timezone.
 */
export const SNAPSHOT_LEAD_MS = 48 * 60 * 60 * 1000

export type TokenRatioEvidence = {
  /** The deal's average entry price. */
  avgPrice: number
  /** The pair's price now. */
  price: number
  /** Base on this account in the baseline snapshot; null when none. */
  baselineBase: number | null
  /** Base on this account now (free + locked); null when unreadable. */
  venueBase: number | null
  /** Base bought by recorded fills on the pair since the baseline. */
  buysSince: number
  /** Base sold by recorded fills on the pair since the baseline. */
  sellsSince: number
}

export type TokenRatioVerdict =
  | { hold: false; reason: string }
  | { hold: true; priceFactor: number; balanceFactor: number }

/** `avg / price` when the price is past the gate, else null. */
export const priceJumpFactor = (
  avgPrice: number,
  price: number,
): number | null => {
  if (!(avgPrice > 0) || !(price > 0)) {
    return null
  }
  const p = avgPrice / price
  return p >= PRICE_JUMP || p <= 1 / PRICE_JUMP ? p : null
}

export const tokenRatioVerdict = (e: TokenRatioEvidence): TokenRatioVerdict => {
  const p = priceJumpFactor(e.avgPrice, e.price)
  if (p === null) {
    return { hold: false, reason: 'price within range' }
  }
  if (
    e.baselineBase === null ||
    !(e.baselineBase > 0) ||
    e.venueBase === null ||
    !Number.isFinite(e.venueBase)
  ) {
    return { hold: false, reason: 'balance unverified' }
  }
  const buys = Math.max(0, e.buysSince || 0)
  const sells = Math.max(0, e.sellsSince || 0)
  const fell = p > 1
  const f = fell
    ? (e.venueBase - buys) / e.baselineBase
    : (e.venueBase + sells) / e.baselineBase
  const moved = fell ? f >= PRICE_JUMP : f <= 1 / PRICE_JUMP
  if (!moved) {
    return { hold: false, reason: 'balance did not jump' }
  }
  if (f / p > FACTOR_BAND || p / f > FACTOR_BAND) {
    return { hold: false, reason: 'balance factor unlike the price factor' }
  }
  return { hold: true, priceFactor: p, balanceFactor: f }
}

const fmt = (v: number) => (v >= 1 ? v.toFixed(1) : (1 / v).toFixed(1))

/** The one bot message a held pair writes. */
export const tokenRatioHeldMessage = (a: {
  symbol: string
  priceFactor: number
  balanceFactor: number
}) =>
  `Deals on ${a.symbol} are on hold: the price is ${fmt(a.priceFactor)}x ${
    a.priceFactor > 1 ? 'below' : 'above'
  } their average and the ${a.symbol} balance on the exchange is ${fmt(
    a.balanceFactor,
  )}x ${
    a.balanceFactor > 1 ? 'larger' : 'smaller'
  } with no trades to explain it, which is what an exchange token ratio change (split or redenomination) looks like. Take profit, safety orders and automatic closes are paused until the deals are converted to the new units. A manual close still runs.`
