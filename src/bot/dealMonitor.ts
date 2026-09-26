import { IdMute, IdMutex } from '../utils/mutex'
import {
  PriceMessage,
  StrategyEnum,
  BotMarginTypeEnum,
  ComboTpBase,
  InputDeal,
  DCADealFlags,
} from '../../types'
import {
  /* comboBotDb, */ comboDealsDb,
  /* dcaBotDb,  */ dcaDealsDb,
} from '../db/dbInit'
import { computeDealUnrealizedNet } from './dealUnrealizedPnl'

/**
 * The legacy `stats.unrealizedProfit` is persisted only when a window closes
 * with a new drawdown/run-up or a profit/loss flip, so a quiet deal's stored
 * value can be hours old. The fee-inclusive fields (main-app spec 019 §5) are
 * what the dashboard ranks and sums on, so a change to them also forces a
 * persist, at most this often per deal.
 */
export const NET_STATS_REFRESH_MS = 10 * 60 * 1000

type DealStatsMap = {
  start: number
  drawdownPercent: number
  runUpPercent: number
  avgDealPrice: number
  timeInLoss: number
  timeInProfit: number
  timeCountStart: number
  currentCount: 'loss' | 'profit'
  wasChanged: boolean
  unrealizedProfit: number
  usage: number
  maxUsage: number
  botId: string
  /** Fee-inclusive uPnL in USD (spec 019 §5); undefined when not computable. */
  unrealizedProfitNet?: number
  unrealizedPercentNet?: number
  valueUsd?: number
  /** Last time the fee-inclusive fields were persisted. */
  netPersistedAt?: number
  /** Value of `unrealizedProfitNet` at the last persist. */
  netPersistedValue?: number
}

const mutex = new IdMutex()

export class DealMonitor {
  private stats: Map<string, DealStatsMap>
  private static instance: DealMonitor

  private constructor() {
    this.stats = new Map()
  }

  public static getInstance() {
    if (!DealMonitor.instance) {
      DealMonitor.instance = new DealMonitor()
    }
    return DealMonitor.instance
  }

  /**
   * Flush a deal's tracked stats and stop tracking it.
   *
   * `completeStats` only runs on the sample that closes a window, so every
   * measurement taken since the last one — up to a full sampling interval of
   * drawdown, run-up and time-in-loss — used to be thrown away when the deal
   * closed. Flushing here keeps it. Unlike the grid path this takes no final
   * measurement: the deal-close path does not carry the deal snapshot, usd
   * rate and fee `addDealStats` needs. Spec 064 §4.3.
   */
  public async removeDealStats(id: string, combo = false) {
    const stats = this.stats.get(id)
    if (stats?.wasChanged) {
      await this.completeStats(combo, id, +new Date(), { ...stats })
    }
    this.stats.delete(id)
  }

  @IdMute(
    mutex,
    (_combo: boolean, _data: unknown, _usdRate: number, deal: InputDeal) =>
      `${deal._id.toString()}stats`,
    10,
  )
  public async addDealStats(
    combo: boolean,
    data: PriceMessage,
    usdRate: number,
    deal: InputDeal,
    fee: number,
  ) {
    const { price, time } = data
    const dealId = deal._id.toString()
    const stats = this.stats.get(dealId)
    if (stats && (data.time - stats.start <= 30 * 1000 || !stats.wasChanged)) {
      this.updateDealStats(combo, deal, stats, price, usdRate, time, fee)
    } else {
      if (stats) {
        await this.completeStats(combo, dealId, data.time, { ...stats })
      }
      this.addNewDeal(deal, dealId, price, time)
    }
  }

  private updateDealStats(
    combo: boolean,
    deal: InputDeal,
    stats: DealStatsMap,
    price: number,
    usdRate: number,
    time: number,
    fee: number,
  ) {
    const { avgPrice, strategy } = deal
    const { comboTpBase } = deal.settings
    if (avgPrice === 0) {
      return
    }
    const long = strategy === StrategyEnum.long
    const leverage = deal.settings.futures
      ? deal.settings.marginType !== BotMarginTypeEnum.inherit
        ? (deal.settings.leverage ?? 1)
        : 1
      : 1
    let newPercent =
      ((long ? price - avgPrice : avgPrice - price) / avgPrice) * leverage -
      fee * 2
    const profitBase =
      (deal.settings.futures && deal.settings.coinm) ||
      (!deal.settings.futures && deal.settings.profitCurrency === 'base')
    let unrealizedPnL =
      strategy && price
        ? (long
            ? deal.currentBalances.base * price +
              deal.currentBalances.quote -
              deal.initialBalances.quote
            : deal.currentBalances.quote -
              (deal.initialBalances.base - deal.currentBalances.base) * price) *
          usdRate
        : undefined
    let unrealizedProfit = unrealizedPnL
    let usage = price
      ? deal.settings.futures
        ? deal.settings.coinm
          ? (combo ? deal.usage.max.base : deal.usage.current.base) * price
          : combo
            ? deal.usage.max.quote
            : deal.usage.current.quote
        : long
          ? combo
            ? deal.usage.max.quote
            : deal.usage.current.quote
          : (combo ? deal.usage.max.base : deal.usage.current.base) * price
      : undefined
    let maxUsage = price
      ? deal.settings.futures
        ? deal.settings.coinm
          ? deal.usage.max.base * price
          : deal.usage.max.quote
        : long
          ? deal.usage.max.quote
          : deal.usage.max.base * price
      : undefined
    maxUsage = (maxUsage ?? 0) * usdRate * (profitBase ? price : 1)
    usage = (usage ?? 0) * usdRate * (profitBase ? price : 1)
    if (!combo && (deal.reduceFunds?.length || deal.tpFilledHistory?.length)) {
      const reduceFundsBase = (deal.reduceFunds ?? []).reduce(
        (acc, r) => acc + r.qty,
        0,
      )
      const reduceFundsQuote = (deal.reduceFunds ?? []).reduce(
        (acc, r) => acc + r.qty * r.price,
        0,
      )
      const tpFilledBase = deal.flags?.includes(DCADealFlags.newMultiTp)
        ? (deal.tpFilledHistory?.reduce((acc, v) => acc + v.qty, 0) ?? 0)
        : 0
      const tpFilledQuote = deal.flags?.includes(DCADealFlags.newMultiTp)
        ? (deal.tpFilledHistory?.reduce((acc, v) => acc + v.qty * v.price, 0) ??
          0)
        : 0
      usage = price
        ? deal.settings.futures
          ? deal.settings.coinm
            ? (combo
                ? deal.usage.max.base
                : deal.usage.current.base + reduceFundsBase + tpFilledBase) *
              price
            : combo
              ? deal.usage.max.quote
              : deal.usage.current.quote + reduceFundsQuote + tpFilledQuote
          : long
            ? combo
              ? deal.usage.max.quote
              : deal.usage.current.quote + reduceFundsQuote + tpFilledQuote
            : (combo
                ? deal.usage.max.base
                : deal.usage.current.base + reduceFundsBase + tpFilledBase) *
              price
        : undefined
      usage = (usage ?? 0) * usdRate * (profitBase ? price : 1)
      const feeAmount = fee !== undefined ? (usage ?? 0) * fee * 2 : undefined
      unrealizedPnL =
        unrealizedPnL && feeAmount !== undefined
          ? unrealizedPnL - feeAmount
          : undefined
      if (unrealizedPnL) {
        unrealizedProfit = unrealizedPnL
      }
      newPercent =
        unrealizedPnL && price && usage ? (unrealizedPnL / usage) * 100 : 0
      // `unrealizedPnL` already carries `usdRate` (it is built from the gross
      // value above). Multiplying again here applied the quote→USD rate twice
      // to every non-USD-quoted deal with a reduce-funds or partial-TP fill.
    }
    if (combo) {
      const qty = long
        ? deal.currentBalances.base
        : deal.initialBalances.base - deal.currentBalances.base
      let quote =
        (long
          ? deal.initialBalances.quote - deal.currentBalances.quote
          : deal.currentBalances.quote) +
        (profitBase ? 0 : deal.profit.total * (long ? 1 : -1))
      const quoteTp = qty * price
      let base =
        quote / price + (profitBase ? deal.profit.total * (long ? 1 : -1) : 0)
      let commission = deal.settings.futures
        ? deal.settings.coinm
          ? qty * fee
          : qty * price * fee
        : profitBase
          ? qty * fee
          : qty * price * fee

      const comboBasedOn =
        !comboTpBase || comboTpBase === ComboTpBase.full
          ? ComboTpBase.full
          : ComboTpBase.filled
      const usageBase =
        comboBasedOn === ComboTpBase.full
          ? deal.usage.max.base
          : deal.usage.current.base
      const usageQuote =
        comboBasedOn === ComboTpBase.full
          ? deal.usage.max.quote
          : deal.usage.current.quote
      const maxUsageBase = deal.usage.max.base

      const maxUsageQuote = deal.usage.max.quote

      let total =
        deal.profit.total +
        (profitBase ? qty - base : quoteTp - quote) * (long ? 1 : -1) -
        commission
      if (
        typeof deal.profit.pureBase !== 'undefined' &&
        typeof deal.profit.pureQuote !== 'undefined' &&
        typeof deal.feePaid !== 'undefined' &&
        `${deal.feePaid}` !== 'null' &&
        `${deal.profit.pureBase}` !== 'null' &&
        `${deal.profit.pureQuote}` !== 'null' &&
        deal.currentBalances.quote >= 0 &&
        deal.currentBalances.base >= 0
      ) {
        quote = long
          ? deal.initialBalances.quote - deal.currentBalances.quote
          : deal.currentBalances.quote
        base = quote / price
        commission = profitBase
          ? deal.feePaid
            ? (deal.feePaid.base ?? 0) +
              (deal.feePaid.quote ?? 0) / deal.avgPrice
            : 0
          : deal.feePaid
            ? (deal.feePaid.base ?? 0) * deal.avgPrice +
              (deal.feePaid.quote ?? 0)
            : 0
        total =
          (profitBase ? qty - base : quoteTp - quote) * (long ? 1 : -1) -
          commission
      }

      const denominator = deal.settings.futures
        ? deal.settings.coinm
          ? usageBase
          : usageQuote
        : long
          ? usageQuote * (profitBase ? 1 / price : 1)
          : usageBase * (profitBase ? 1 : price)
      newPercent = total / denominator
      unrealizedProfit = total * usdRate * (profitBase ? price : 1)
      usage = denominator * usdRate * (profitBase ? price : 1)
      maxUsage = deal.settings.futures
        ? deal.settings.coinm
          ? maxUsageBase
          : maxUsageQuote
        : long
          ? maxUsageQuote * (profitBase ? 1 / price : 1)
          : maxUsageBase * (profitBase ? 1 : price)
      maxUsage = maxUsage * usdRate * (profitBase ? price : 1)
    }
    if (newPercent > 0 && newPercent > stats.runUpPercent) {
      stats.runUpPercent = newPercent
      stats.wasChanged = true
    } else if (newPercent < 0 && newPercent * -1 > stats.drawdownPercent) {
      stats.drawdownPercent = newPercent * -1
      stats.wasChanged = true
    }

    if (time > stats.timeCountStart) {
      if (
        (long ? price >= avgPrice : price < avgPrice) &&
        stats.currentCount === 'loss'
      ) {
        stats.timeInLoss += time - stats.timeCountStart - 1
        stats.timeCountStart = time
        stats.currentCount = 'profit'
        stats.wasChanged = true
      } else if (
        (long ? price < avgPrice : price >= avgPrice) &&
        stats.currentCount === 'profit'
      ) {
        stats.timeInProfit += time - stats.timeCountStart - 1
        stats.timeCountStart = time
        stats.currentCount = 'loss'
        stats.wasChanged = true
      }
    }
    if (stats.wasChanged && unrealizedProfit) {
      stats.unrealizedProfit = unrealizedProfit
      stats.usage = usage ?? 0
      stats.maxUsage = maxUsage ?? 0
    }
    this.updateNetStats(combo, deal, stats, price, usdRate, time, fee)
    this.stats.set(deal._id.toString(), stats)
  }

  /**
   * Fee-inclusive uPnL, P&L % and value (spec 019 §5). Always kept current in
   * memory; forces a persist when the value moved and the last persist of it
   * is older than {@link NET_STATS_REFRESH_MS}.
   */
  private updateNetStats(
    combo: boolean,
    deal: InputDeal,
    stats: DealStatsMap,
    price: number,
    usdRate: number,
    time: number,
    fee: number,
  ) {
    const net = computeDealUnrealizedNet(deal, price, usdRate, fee, combo)
    if (!net) {
      return
    }
    stats.unrealizedProfitNet = net.unrealizedUsd
    stats.unrealizedPercentNet = net.percent
    stats.valueUsd = net.valueUsd
    if (
      net.unrealizedUsd !== stats.netPersistedValue &&
      time - (stats.netPersistedAt ?? 0) >= NET_STATS_REFRESH_MS
    ) {
      stats.wasChanged = true
    }
  }

  private addNewDeal(deal: InputDeal, id: string, price: number, time: number) {
    const { avgPrice } = deal
    const long = deal.strategy === StrategyEnum.long
    // A window that just closed wrote the fee-inclusive fields; the deal
    // snapshot the bot hands us does not see that write, so carry the persist
    // marker over from the previous window rather than re-reading it stale.
    const previous = this.stats.get(id)
    this.stats.set(id, {
      start: time,
      drawdownPercent: deal.stats?.drawdownPercent ?? 0,
      runUpPercent: deal.stats?.runUpPercent ?? 0,
      avgDealPrice: avgPrice,
      timeCountStart: time,
      currentCount:
        (deal.stats?.currentCount ??
        (long ? price >= avgPrice : price < avgPrice))
          ? 'profit'
          : 'loss',
      timeInLoss: 0,
      timeInProfit: 0,
      wasChanged: false,
      unrealizedProfit: deal.stats?.unrealizedProfit ?? 0,
      botId: deal.botId,
      usage: deal.stats?.usage ?? 0,
      maxUsage: deal.stats?.maxUsage ?? 0,
      netPersistedAt:
        previous?.netPersistedAt ??
        (deal.stats?.updatedAt ? +new Date(deal.stats.updatedAt) : 0),
      netPersistedValue:
        previous?.netPersistedValue ?? deal.stats?.unrealizedProfitNet,
    })
  }

  private async completeStats(
    combo: boolean,
    id: string,
    time: number,
    stats: DealStatsMap,
  ) {
    const timeInLoss =
      stats.timeInLoss +
      (stats.currentCount === 'loss'
        ? Math.max(0, time - stats.timeCountStart)
        : 0)
    const timeInProfit =
      stats.timeInProfit +
      (stats.currentCount === 'profit'
        ? Math.max(0, time - stats.timeCountStart)
        : 0)
    const db = (combo ? comboDealsDb : dcaDealsDb) as typeof dcaDealsDb
    await db.updateData(
      { _id: id },
      {
        $max: {
          'stats.drawdownPercent': stats.drawdownPercent,
          'stats.runUpPercent': stats.runUpPercent,
        },
        $inc: {
          'stats.timeInLoss': timeInLoss,
          'stats.timeInProfit': timeInProfit,
          'stats.trackTime': timeInLoss + timeInProfit,
        },
        $set: {
          'stats.timeCountStart': time,
          'stats.currentCount': stats.currentCount,
          'stats.unrealizedProfit': stats.unrealizedProfit,
          'stats.usage': stats.usage,
          'stats.maxUsage': stats.maxUsage,
          ...(typeof stats.unrealizedProfitNet === 'number'
            ? {
                'stats.unrealizedProfitNet': stats.unrealizedProfitNet,
                'stats.unrealizedPercentNet': stats.unrealizedPercentNet,
                'stats.valueUsd': stats.valueUsd,
              }
            : {}),
          'stats.updatedAt': new Date(time),
        },
      },
    )
    if (typeof stats.unrealizedProfitNet === 'number') {
      stats.netPersistedAt = time
      stats.netPersistedValue = stats.unrealizedProfitNet
    }
    /*  if (stats.unrealizedProfit) {
      const db = (combo ? comboBotDb : dcaBotDb) as typeof dcaBotDb
      await db.updateData(
        { _id: stats.botId },
        { $set: { unrealizedProfit: stats.unrealizedProfit } },
      )
    } */
    stats.wasChanged = false
    this.stats.set(id, stats)
  }
}
