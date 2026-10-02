import type { GridCloseEntry, PositionInBot } from '../../types'

/**
 * The entry a futures grid's open position is valued against for its stats:
 * the close entry the value-changed TP/SL uses (spec 117) while it was
 * computed for this very position, `position.price` otherwise (spec 124 §4.2).
 */
export const gridPositionEntry = (
  position: PositionInBot,
  closeEntry?: GridCloseEntry | null,
): number =>
  closeEntry &&
  closeEntry.side === position.side &&
  closeEntry.qty === position.qty &&
  closeEntry.price === position.price &&
  closeEntry.entry > 0
    ? closeEntry.entry
    : position.price
