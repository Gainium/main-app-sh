/**
 * Canonical fee-inclusive unrealized P&L of one active deal (main-app spec 019
 * §5). The dashboard computes the same number with the same formula for the
 * rows it prices live; the stats worker stores this one for everything else,
 * so a server value and a live value agree.
 *
 * Pure: prices, the quote→USD rate and the fee come in as numbers.
 *
 * - DCA / terminal / hedge-DCA leg: gross position P&L in quote units, minus an
 *   open + close fee on the USD usage (`2 × fee × usageUsd`).
 * - Combo / hedge-combo leg: the whole deal's P&L including banked grid profit,
 *   minus the fees actually paid when the deal carries them, else the closing
 *   fee. Never add grid profit on top of it.
 *
 * `usdRate` is always the QUOTE asset's USD rate.
 */
import { DCADealFlags, StrategyEnum } from '../../types'

export type UnrealizedDealInput = {
  strategy?: StrategyEnum | string
  avgPrice?: number
  settings: {
    futures?: boolean
    coinm?: boolean
    profitCurrency?: string
    comboTpBase?: string
  }
  initialBalances: { base: number; quote: number }
  currentBalances: { base: number; quote: number }
  usage: {
    current: { base: number; quote: number }
    max: { base: number; quote: number }
  }
  profit?: {
    total?: number
    pureBase?: number | null
    pureQuote?: number | null
  }
  feePaid?: { base?: number; quote?: number } | null
  reduceFunds?: { qty: number; price: number }[]
  tpFilledHistory?: { qty: number; price: number }[]
  flags?: string[]
}

export type UnrealizedDealResult = {
  unrealizedUsd: number
  usageUsd: number
  percent: number
  valueUsd: number
}

const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

const present = (v: unknown) =>
  typeof v !== 'undefined' && v !== null && `${v}` !== 'null'

export const computeDcaUnrealized = (
  deal: UnrealizedDealInput,
  price: number,
  usdRate: number,
  fee: number,
): UnrealizedDealResult | undefined => {
  const long = deal.strategy === StrategyEnum.long
  const cb = deal.currentBalances
  const ib = deal.initialBalances
  const grossQ = long
    ? cb.base * price + cb.quote - ib.quote
    : cb.quote - (ib.base - cb.base) * price
  const rf = deal.reduceFunds ?? []
  const newMultiTp = !!deal.flags?.includes(DCADealFlags.newMultiTp)
  const tp = newMultiTp ? (deal.tpFilledHistory ?? []) : []
  const rfB = rf.reduce((acc, r) => acc + r.qty, 0)
  const rfQ = rf.reduce((acc, r) => acc + r.qty * r.price, 0)
  const tpB = tp.reduce((acc, r) => acc + r.qty, 0)
  const tpQ = tp.reduce((acc, r) => acc + r.qty * r.price, 0)
  const usageQ = deal.usage.current.quote + rfQ + tpQ
  const usageB = deal.usage.current.base + rfB + tpB
  const usageQuoteUnits = deal.settings.futures
    ? deal.settings.coinm
      ? usageB * price
      : usageQ
    : long
      ? usageQ
      : usageB * price
  const usageUsd = usageQuoteUnits * usdRate
  const feeUsd = 2 * fee * usageUsd
  const unrealizedUsd = grossQ * usdRate - feeUsd
  const percent = usageUsd > 0 ? (unrealizedUsd / usageUsd) * 100 : 0
  return {
    unrealizedUsd,
    usageUsd,
    percent,
    valueUsd: usageUsd + unrealizedUsd,
  }
}

export const computeComboUnrealized = (
  deal: UnrealizedDealInput,
  price: number,
  usdRate: number,
  fee: number,
): UnrealizedDealResult | undefined => {
  const long = deal.strategy === StrategyEnum.long
  const sign = long ? 1 : -1
  const cb = deal.currentBalances
  const ib = deal.initialBalances
  const futures = !!deal.settings.futures
  const coinm = !!deal.settings.coinm
  const profitBase =
    (futures && coinm) || (!futures && deal.settings.profitCurrency === 'base')
  const profitTotal = deal.profit?.total ?? 0
  const avgPrice = deal.avgPrice ?? 0
  const qty = long ? cb.base : ib.base - cb.base
  let total: number
  if (
    present(deal.profit?.pureBase) &&
    present(deal.profit?.pureQuote) &&
    present(deal.feePaid) &&
    cb.base >= 0 &&
    cb.quote >= 0
  ) {
    const quote = long ? ib.quote - cb.quote : cb.quote
    const base = quote / price
    const feePaid = deal.feePaid ?? {}
    const commission = profitBase
      ? (feePaid.base ?? 0) + (avgPrice ? (feePaid.quote ?? 0) / avgPrice : 0)
      : (feePaid.base ?? 0) * avgPrice + (feePaid.quote ?? 0)
    total = (profitBase ? qty - base : qty * price - quote) * sign - commission
  } else {
    const quote =
      (long ? ib.quote - cb.quote : cb.quote) +
      (profitBase ? 0 : profitTotal * sign)
    const base = quote / price + (profitBase ? profitTotal * sign : 0)
    const commission = profitBase ? qty * fee : qty * price * fee
    total =
      profitTotal +
      (profitBase ? qty - base : qty * price - quote) * sign -
      commission
  }
  const toUsd = usdRate * (profitBase ? price : 1)
  const basis =
    deal.settings.comboTpBase === 'filled' ? deal.usage.current : deal.usage.max
  const denominator = futures
    ? coinm
      ? basis.base
      : basis.quote
    : long
      ? basis.quote * (profitBase ? 1 / price : 1)
      : basis.base * (profitBase ? 1 : price)
  const unrealizedUsd = total * toUsd
  const usageUsd = denominator * toUsd
  const percent = denominator > 0 ? (total / denominator) * 100 : 0
  return {
    unrealizedUsd,
    usageUsd,
    percent,
    valueUsd: usageUsd + unrealizedUsd,
  }
}

/**
 * Returns undefined when the value cannot be computed honestly: no price, no
 * USD rate, an unknown fee, no strategy, or a non-finite result.
 */
export const computeDealUnrealizedNet = (
  deal: UnrealizedDealInput,
  price: number | undefined,
  usdRate: number | undefined,
  fee: number | undefined,
  combo: boolean,
): UnrealizedDealResult | undefined => {
  if (!finite(price) || price <= 0) return undefined
  if (!finite(usdRate) || usdRate <= 0) return undefined
  if (!finite(fee) || fee < 0) return undefined
  if (
    deal.strategy !== StrategyEnum.long &&
    deal.strategy !== StrategyEnum.short
  ) {
    return undefined
  }
  if (!deal.currentBalances || !deal.initialBalances || !deal.usage) {
    return undefined
  }
  const result = combo
    ? computeComboUnrealized(deal, price, usdRate, fee)
    : computeDcaUnrealized(deal, price, usdRate, fee)
  if (
    !result ||
    !finite(result.unrealizedUsd) ||
    !finite(result.usageUsd) ||
    !finite(result.percent)
  ) {
    return undefined
  }
  return result
}
