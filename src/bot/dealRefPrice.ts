/**
 * The reference price a deal's percentage exits are measured from, and the
 * guard that keeps it from being zeroed by a settings edit.
 *
 * A deal carries two averages:
 *
 *   - `deal.avgPrice`   — computed by the engine from the filled orders.
 *   - `deal.settings.avgPrice` — the user-facing "breakeven price" override,
 *     re-synced to `deal.avgPrice` on every fill.
 *
 * Every percentage exit is a multiple of that reference: the trailing take
 * profit's arm price, move SL's trigger price, and the stop-loss level all
 * come out of it. So a reference of `0` does not degrade the exit — it
 * removes it:
 *
 *   - `getTrailingSettings` returns `trailingTpPrice = 0`, and `checkTrailing`
 *     gates the arm branch on that value being truthy. Trailing TP can then
 *     never arm no matter how far price runs, and because `trailingTp` also
 *     suppresses the resting TP limit order, the deal is left with no take
 *     profit of any kind while `bestPrice` keeps updating, so from the outside
 *     it still looks actively managed.
 *   - `getDealMoveSlPrice` returns a trigger of `0`, and `checkDealsMoveSL`
 *     tests `last >= required` for a long — true on the first tick.
 *   - `getDealSlRefPrice` returns `0` under `baseSlOn: avg`, putting the stop
 *     at `0`: unreachable for a long, and instantly hit for a short.
 *
 * That is why these read `||` and not `??`. `0 ?? x` is `0`; only `||` treats
 * "no usable reference" as "fall back to the computed average", which is what
 * the rest of dcaHelper has always done at its other call sites.
 */

/** True for a value that can serve as a deal's reference price. */
export function isUsableRefPrice(value: unknown): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

/**
 * The reference price to measure a deal's percentage exits from: the user's
 * breakeven override when it is usable, otherwise the engine's computed
 * average. Never returns the override's `0`.
 */
export function dealRefPrice(
  settingsAvgPrice: number | undefined,
  dealAvgPrice: number,
): number {
  return isUsableRefPrice(settingsAvgPrice)
    ? (settingsAvgPrice as number)
    : dealAvgPrice
}

/**
 * Drop an unusable `avgPrice` from an incoming deal-settings patch.
 *
 * Fixing the reads alone would be a band-aid: the zero is *persisted*, so it
 * keeps breaking every future read and re-ships itself on the next edit. The
 * dashboard's mass deal-edit seeds its form from the bot-form defaults, which
 * carry `avgPrice: 0`, then diffs that against each selected deal's real
 * average and sends the difference — zeroing every deal in the selection at
 * once. The single-deal edit then perpetuates it, because it seeds the field
 * with `settings.avgPrice ?? deal.avgPrice` and `0 ?? x` is `0`.
 *
 * Rather than trust each of the several clients that can reach
 * `updateDealSettings` (both dashboards, `/api/updateDeal`, the v2 API and the
 * AI deal tools), refuse the value here. Omitting the key leaves the deal's
 * existing override intact; the engine re-syncs it from `deal.avgPrice` on the
 * next fill either way.
 */
export function withoutUnusableAvgPrice<T extends { avgPrice?: number }>(
  settings: T,
): T {
  if (!('avgPrice' in settings) || isUsableRefPrice(settings.avgPrice)) {
    return settings
  }
  const { avgPrice: _dropped, ...rest } = settings
  return rest as T
}
