/**
 * Whether a grid order the venue reports cancelled had been resting on the
 * book, as opposed to being refused the moment it was placed.
 *
 * Both reach `processCanceledOrder` as the same `CANCELED`, and they call for
 * opposite things. A refusal (an order the venue cancels in the same instant it
 * acknowledges it) is a level that will not rest: retrying it re-sends a
 * refused order and keeping it reserves funds for nothing, so it is pruned
 * (spec 077). A level that rested and was later cancelled — the venue's
 * cancel-all, or the user cancelling it on the exchange — is still part of the
 * ladder, and pruning it left a minigrid whose every level was cancelled with
 * no orders at all, holding what it had bought with nothing to sell it back.
 * Spec 179 §4.1.
 *
 * Judged from the order's own timestamps: `transactTime` is when it was placed
 * (the venue's, once the placement answer arrives; the write-ahead time before
 * that) and `updateTime` is the cancel report's. Without both there is no
 * evidence it ever rested, so it is treated as a refusal — the behaviour before
 * spec 179.
 */
export const GRID_LEVEL_REST_MS = 60_000

export const wasRestingWhenCanceled = (
  order: { transactTime?: number; updateTime?: number },
  restMs = GRID_LEVEL_REST_MS,
): boolean => {
  const placedAt = Number(order.transactTime)
  const canceledAt = Number(order.updateTime)
  if (!(placedAt > 0) || !(canceledAt > 0)) {
    return false
  }
  return canceledAt - placedAt >= restMs
}
