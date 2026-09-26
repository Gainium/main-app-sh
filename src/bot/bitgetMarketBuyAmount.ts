/**
 * The base quantity a Bitget spot MARKET BUY for `qty` is funded for.
 *
 * Bitget sizes a spot market buy in the quote coin and fills
 * `⌊amount ÷ fillPrice⌋` on the base step. A buy fills at the ask, which sits
 * at or above the last trade the engine sized it at, so an amount of exactly
 * `qty × last` comes back one step short whenever the ask is above the last
 * trade at all — and a one-step top-up converts to zero and is refused
 * (`parameter verification exception size 0.000 > 0`).
 *
 * Funding half a step more makes the round-down land on `qty` for every fill
 * price in `last × qty/(qty + step/2) … last × (qty + step/2)/qty`: never more
 * than `qty` at the sizing price itself, and a one-step top-up fills at any ask
 * up to 1.5 × last. The half step is the midpoint between filling one step
 * short and one step over.
 * `specs/113.a-bitget-spot-market-buy-is-funded-at-last-trade.md` §3.
 */
export function bitgetSpotMarketBuyQty(
  qty: number,
  step: number | undefined | null,
): number {
  if (!step || !Number.isFinite(step) || step <= 0) {
    return qty
  }
  return qty + step / 2
}
