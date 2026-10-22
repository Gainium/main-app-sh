import { normalizeReason } from './limitOnlyEntry'

/**
 * Exchange rejections that mean "there is nothing left to close" — the position
 * is already flat (or on the other side), so a reduce-only closing order can
 * never be accepted. Retrying is pointless; the deal must be booked closed.
 */
export const positionAlreadyClosedReasons = [
  // Hyperliquid
  'reduce only order would increase position',
  // Binance -2022
  'ReduceOnly Order is rejected',
  // Bybit
  'current position is zero, cannot fix reduce-only order qty',
  'reduce-only order has same side with current position',
  // OKX 51169 / 51023
  "You don't have any positions in this contract",
  'Position does not exist',
  // OKX again, and a DIFFERENT message from the one above — not a spelling of
  // it: "Order failed because you don't have any positions in this direction
  // for this contract to reduce or close." Stored as the clause rather than
  // the sentence, because the words around it are decoration the venue has
  // reworded before while the clause is the condition. Missing this one left
  // futures deals `open` forever, re-refusing the same close on every attempt
  // against a position the venue says is not there.
  'positions in this direction for this contract',
  // dYdX — camelCase; matched via the normalisation in
  // isPositionAlreadyClosedReason, not literally
  'wouldNotReducePosition',
  'no position to close',
]

export function isPositionAlreadyClosedReason(text: string): boolean {
  const haystack = normalizeReason(`${text ?? ''}`)
  return positionAlreadyClosedReasons.some(
    (r) => haystack.indexOf(normalizeReason(r)) !== -1,
  )
}
