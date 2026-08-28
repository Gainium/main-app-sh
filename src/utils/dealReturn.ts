import { ComboTpBase, StrategyEnum } from '../../types'

/**
 * The per-deal realized return (as a FRACTION, not a percentage) that the
 * "Deal Returns" scatter plots — one point per closed deal.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A BOT METHOD. The number itself is not
 * new: `DCABotHelper.botUpdateStats` has always computed it and written it to
 * the `botProfitChart` collection, and `sendDealClosedAlert` computes the same
 * thing again for the close alert. Both live on a running bot instance and
 * read `this.futures` / `this.coinm` / `this.isLong` / `getAggregatedSettings()`,
 * so neither can be called from a GraphQL resolver. Every input, though, is
 * already frozen onto the DEAL document at open time (`deal.settings` is a
 * snapshot of the bot settings that deal was opened under, `deal.strategy` is
 * its direction), so the math is expressible over the deal alone — which is
 * what lets `getBotProfitChartData` derive the series from closed deals
 * instead of reading a denormalized collection that can silently miss rows.
 *
 * Keep this identical to the `perc` expression in `botUpdateStats`. The three
 * pieces it mirrors:
 *
 *  • WHICH usage is the denominator — the capital the deal actually tied up.
 *    Quote side for a long spot deal and for USDⓈ-M futures, base side for a
 *    short spot deal and for COIN-M (where the margin IS the base asset).
 *  • FULL vs FILLED usage — combo only. A combo bot taking profit on the full
 *    grid measures against `usage.max`; one taking profit per filled leg
 *    measures against `usage.current`. Plain DCA is always `current`.
 *  • The `multiplyUsage` conversion — `profit.total` is denominated in the
 *    profit currency, so when that currency differs from the usage side the
 *    denominator has to cross `avgPrice` to match it.
 */

/** Deal fields this needs — a lean projection satisfies it. */
export interface DealReturnDeal {
  profit?: { total?: number | null } | null
  usage?: {
    max?: { base?: number | null; quote?: number | null } | null
    current?: { base?: number | null; quote?: number | null } | null
  } | null
  avgPrice?: number | null
  strategy?: StrategyEnum | string | null
  settings?: {
    futures?: boolean | null
    coinm?: boolean | null
    profitCurrency?: string | null
    comboTpBase?: ComboTpBase | string | null
    useTp?: boolean | null
    useSl?: boolean | null
  } | null
}

/** Mirror of `DCABotHelper.comboBasedOn` over the deal's own settings. */
const comboBasedOn = (settings: NonNullable<DealReturnDeal['settings']>) =>
  settings.comboTpBase && !settings.useTp && !settings.useSl
    ? ComboTpBase.filled
    : !settings.comboTpBase || settings.comboTpBase === ComboTpBase.full
      ? ComboTpBase.full
      : ComboTpBase.filled

/**
 * @param deal   closed deal (lean doc is fine)
 * @param combo  true for combo/hedgeCombo bots — selects full-vs-filled usage
 * @returns the return as a fraction (0.0177 = +1.77%), or null when the deal
 *          carries no usable return: a zero-profit close (`botUpdateStats`
 *          skips those too) or a degenerate denominator.
 */
export const dealReturnPercentage = (
  deal: DealReturnDeal,
  combo = false,
): number | null => {
  const profit = deal.profit?.total
  if (typeof profit !== 'number' || !isFinite(profit) || profit === 0) {
    return null
  }
  const settings = deal.settings ?? {}
  const futures = !!settings.futures
  const coinm = !!settings.coinm
  const isLong = deal.strategy !== StrategyEnum.short
  // `profitBase` — mirror of DCABotHelper.profitBase.
  const profitBase =
    (futures && coinm) || (!futures && settings.profitCurrency === 'base')

  const full = combo && comboBasedOn(settings) === ComboTpBase.full
  const baseUsage =
    (full ? deal.usage?.max?.base : deal.usage?.current?.base) ?? 0
  const quoteUsage =
    (full ? deal.usage?.max?.quote : deal.usage?.current?.quote) ?? 0
  const usage = futures
    ? coinm
      ? baseUsage
      : quoteUsage
    : isLong
      ? quoteUsage
      : baseUsage

  const avgPrice = deal.avgPrice ?? 0
  const multiplyUsage = futures
    ? 1
    : isLong
      ? profitBase
        ? 1 / avgPrice
        : 1
      : profitBase
        ? 1
        : avgPrice

  const perc = profit / (usage * multiplyUsage)
  return isFinite(perc) ? perc : null
}

export default dealReturnPercentage
