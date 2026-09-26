/**
 * "In positions" — what a user's bots currently hold, in USD (main-app spec
 * 019 §4). Pure: the exposures come from deal/bot documents, the USD prices
 * from the caller.
 *
 * - DCA / terminal / hedge-DCA / combo / hedge-combo deal: its current usage,
 *   in the asset it is held in — quote for spot long and USD-M futures, base
 *   for spot short and COIN-M.
 * - Grid bot (current exposure, same meaning as a DCA deal's current usage):
 *   futures → entry notional of the open position (quote); spot → the base
 *   the bot holds (base). COIN-M grids cannot be sized server-side (contract
 *   size) and are reported as unpriced, never silently dropped.
 */
import { StrategyEnum } from '../../types'

export type Exposure = {
  exchange: string
  exchangeUUID: string
  asset: string
  amount: number
}

export type ExposureDealDoc = {
  strategy?: string
  exchange?: string
  exchangeUUID?: string
  symbol?: { baseAsset?: string; quoteAsset?: string }
  settings?: { futures?: boolean; coinm?: boolean }
  usage?: { current?: { base?: number; quote?: number } }
}

export type ExposureGridDoc = {
  exchange?: string
  exchangeUUID?: string
  symbol?: { baseAsset?: string; quoteAsset?: string }
  settings?: { futures?: boolean; coinm?: boolean }
  position?: { qty?: number; price?: number } | null
  currentBalances?: { base?: number; quote?: number } | null
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/** null = cannot be expressed as an asset amount (counted as unpriced). */
export const dealExposure = (d: ExposureDealDoc): Exposure | null => {
  if (!d.exchange || !d.symbol?.baseAsset || !d.symbol?.quoteAsset) return null
  const futures = !!d.settings?.futures
  const coinm = !!d.settings?.coinm
  const long = d.strategy !== StrategyEnum.short
  const inBase = futures ? coinm : !long
  const amount = inBase
    ? num(d.usage?.current?.base)
    : num(d.usage?.current?.quote)
  return {
    exchange: d.exchange,
    exchangeUUID: d.exchangeUUID ?? '',
    asset: inBase ? d.symbol.baseAsset : d.symbol.quoteAsset,
    amount: Math.abs(amount),
  }
}

export const gridExposure = (b: ExposureGridDoc): Exposure | null => {
  if (!b.exchange || !b.symbol?.baseAsset || !b.symbol?.quoteAsset) return null
  if (b.settings?.futures) {
    if (b.settings.coinm) return null
    return {
      exchange: b.exchange,
      exchangeUUID: b.exchangeUUID ?? '',
      asset: b.symbol.quoteAsset,
      amount: Math.abs(num(b.position?.qty) * num(b.position?.price)),
    }
  }
  return {
    exchange: b.exchange,
    exchangeUUID: b.exchangeUUID ?? '',
    asset: b.symbol.baseAsset,
    amount: Math.max(0, num(b.currentBalances?.base)),
  }
}

export const exposureKey = (e: Pick<Exposure, 'exchangeUUID' | 'asset'>) =>
  `${e.exchangeUUID}:${e.asset}`

/** Groups exposures per exchange account + asset, summing amounts. */
export const groupExposures = (exposures: Exposure[]) => {
  const groups = new Map<string, Exposure & { items: number }>()
  for (const e of exposures) {
    const key = exposureKey(e)
    const g = groups.get(key)
    if (g) {
      g.amount += e.amount
      g.items += 1
    } else {
      groups.set(key, { ...e, items: 1 })
    }
  }
  return groups
}

export type InPositionsResult = {
  inPositionsUsd: number
  inPositionsCount: number
  inPositionsUnpriced: number
}

/**
 * `usdPerUnit` maps `${exchangeUUID}:${asset}` → USD price of one unit (0 or
 * missing = unpriced). A group with a non-zero amount and no price is
 * excluded from the sum and its items counted as unpriced.
 */
export const sumInPositions = (
  docs: (Exposure | null)[],
  usdPerUnit: Map<string, number>,
): InPositionsResult => {
  let unpriced = docs.filter((d) => d === null).length
  let usd = 0
  for (const g of groupExposures(
    docs.filter((d): d is Exposure => !!d),
  ).values()) {
    if (!g.amount) continue
    const price = usdPerUnit.get(exposureKey(g)) ?? 0
    if (!(price > 0)) {
      unpriced += g.items
      continue
    }
    usd += g.amount * price
  }
  return {
    inPositionsUsd: usd,
    inPositionsCount: docs.length,
    inPositionsUnpriced: unpriced,
  }
}
