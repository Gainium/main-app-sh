import ExpirableMap from '../utils/expirableMap'
import {
  BotLiveStats,
  ExchangeEnum,
  StrategyEnum,
  Prices,
  StatusEnum,
  DCABotSettings,
  OrderSizeTypeEnum,
  BotStats,
  Symbols,
  ClearComboBotSchema,
  ComboTpBase,
  ClearBotSchema,
  GridLiveStats,
  BotSettings,
  BotMarginTypeEnum,
  PositionSide,
} from '../../types'
import { MathHelper } from '../utils/math'
import ExchangeChooser from '../exchange/exchangeChooser'
import { removePaperFormExchangeName } from '../exchange/helpers'
import utils, { isCoinm } from '../utils'
import { IdMute, IdMutex } from '../utils/mutex'
import { botDb, comboBotDb, dcaBotDb } from '../db/dbInit'
import logger from '../utils/logger'

const { findUSDRate } = utils

const math = new MathHelper()
const mutexStats = new IdMutex(500)
const mutex = new IdMutex()

export type CalculateDCALiveStatsParams = {
  bot: Pick<
    ClearComboBotSchema,
    | '_id'
    | 'exchange'
    | 'workingShift'
    | 'profit'
    | 'symbol'
    | 'usage'
    | 'currentBalances'
    | 'initialBalances'
    | 'dealsStatsForBot'
    | 'dealsReduceForBot'
    | 'deals'
  > & {
    settings: Pick<
      DCABotSettings,
      | 'strategy'
      | 'futures'
      | 'coinm'
      | 'orderSizeType'
      | 'useReinvest'
      | 'profitCurrency'
    >
    stats: {
      numerical: {
        general: Pick<BotStats['numerical']['general'], 'netProfitPerc'>
      }
    }
  }
  fee: number
  combo: boolean
}

export type CalculateGridLiveStatsParams = {
  bot: Pick<
    ClearBotSchema,
    | '_id'
    | 'stats'
    | 'symbol'
    | 'initialBalances'
    | 'initialPrice'
    | 'usdRate'
    | 'exchange'
    | 'profit'
    | 'status'
    | 'position'
    | 'currentBalances'
    | 'lastPrice'
    | 'lastUsdRate'
    | 'workingShift'
  > & {
    settings: Pick<
      BotSettings,
      | 'profitCurrency'
      | 'marginType'
      | 'leverage'
      | 'budget'
      | 'pair'
      | 'futures'
    >
  }
}

class BotMonitor {
  static instance: BotMonitor

  static getInstance() {
    if (!BotMonitor.instance) {
      BotMonitor.instance = new BotMonitor()
    }
    return BotMonitor.instance
  }

  private latestPrices: ExpirableMap<ExchangeEnum, Prices> = new ExpirableMap(
    60 * 1000,
  )

  @IdMute(mutex, (exchange: ExchangeEnum) => `getLatestPrices-${exchange}`)
  private async getLatestPrices(_exchange: ExchangeEnum) {
    const exchange = removePaperFormExchangeName(_exchange)
    let prices = this.latestPrices.get(exchange)
    if (!prices) {
      const e = ExchangeChooser.chooseExchangeFactory(exchange)
      if (e) {
        const instance = e('', '')
        const result = await instance.getAllPrices()
        if (result.status === StatusEnum.ok && result.data.length) {
          prices = result.data.map((p) => ({ ...p, exchange }))
          this.latestPrices.set(exchange, prices)
        }
      }
    }
    return prices || []
  }
  private sumBalances(
    balances: Map<string, number>,
    rates: { [key: string]: Prices[0] },
    symbols: Symbols[],
    base?: boolean,
  ) {
    return [...balances.entries()].reduce((acc, [key, value]) => {
      const sym = symbols.filter(
        (s) => s.baseAsset === key || s.quoteAsset === key,
      )
      if (!sym.length) return acc
      const rate = sym.map((s) => rates[s.symbol]).filter(Boolean)[0]
      if (!rate) return acc
      return acc + value * (base ? 1 / rate.price : rate.price)
    }, 0)
  }
  private sumPureBalances(balances: Map<string, number>) {
    return [...balances.entries()].reduce((acc, [_, value]) => {
      return acc + value
    }, 0)
  }

  @IdMute(
    mutexStats,
    ({ bot: { _id } }: CalculateDCALiveStatsParams) =>
      `calculateDCALiveStats-${_id}`,
  )
  async calculateDCALiveStats({
    bot,
    fee,
    combo,
  }: CalculateDCALiveStatsParams) {
    try {
      const latestPrices = await this.getLatestPrices(bot.exchange)
      const workingTime =
        bot.workingShift && bot.workingShift.length > 0
          ? bot.workingShift.reduce((acc, v) => {
              if (v.end) {
                acc += v.end - v.start
              } else if (!v.end) {
                acc += new Date().getTime() - v.start
              }
              return acc
            }, 0)
          : 0

      let avgDaily =
        (bot.profit?.totalUsd || 0) /
        math.round(workingTime / (24 * 60 * 60 * 1000), 4)

      let resWork = ''
      let count: number
      count = Math.floor(workingTime / (24 * 60 * 60 * 1000))
      if (count >= 1) {
        resWork = `${resWork}${resWork.length ? ' ' : ''}${count}d`
      }
      count = Math.floor(workingTime / (60 * 60 * 1000))
      if (count >= 1) {
        resWork = `${resWork}${resWork.length ? ' ' : ''}${count % 24}h`
      }
      count = Math.floor(workingTime / (60 * 1000))
      if (count >= 1) {
        resWork = `${resWork}${resWork.length ? ' ' : ''}${count % 60}min`
      }
      if (resWork === '') {
        resWork = `${Math.floor(workingTime / 1000)}s`
      }
      let unPnl = 0
      let unPnlPerc = 0
      let currentValues = 0
      let comboDealCurrentValues = 0
      const long = bot.settings.strategy === StrategyEnum.long
      const symbols = Array.from(bot.symbol.values())
      const baseAsset = bot.symbol.values().next().value?.baseAsset ?? ''
      const quoteAsset = bot.symbol.values().next().value?.quoteAsset ?? ''
      const usdRate = bot.settings.futures
        ? bot.settings.coinm
          ? findUSDRate(baseAsset, latestPrices, bot.exchange)
          : findUSDRate(quoteAsset, latestPrices, bot.exchange)
        : long
          ? findUSDRate(quoteAsset, latestPrices, bot.exchange)
          : findUSDRate(baseAsset, latestPrices, bot.exchange)
      const usdRatesQuote = symbols.reduce(
        (acc: { [key: string]: number }, value) => ({
          ...acc,
          [value.symbol]: findUSDRate(
            value.quoteAsset,
            latestPrices,
            bot.exchange,
          ),
        }),
        {} as { [key: string]: number },
      )
      const usdRatesBase = symbols.reduce(
        (acc: { [key: string]: number }, value) => ({
          ...acc,
          [value.symbol]: findUSDRate(
            value.baseAsset,
            latestPrices,
            bot.exchange,
          ),
        }),
        {} as { [key: string]: number },
      )

      const active =
        bot.usage.current.quote !== 0 || bot.usage.current.base !== 0
      let maxValue =
        (bot.settings.futures
          ? bot.settings.coinm
            ? bot.usage.max.base
            : bot.usage.max.quote
          : long
            ? bot.usage.max.quote
            : bot.usage.max.base) * usdRate
      let avgDailyPerc = avgDaily / maxValue
      let annualizedReturn = 0
      if (!isNaN(avgDailyPerc) && isFinite(avgDailyPerc) && avgDailyPerc) {
        const compound =
          [OrderSizeTypeEnum.percFree, OrderSizeTypeEnum.percTotal].includes(
            bot.settings.orderSizeType,
          ) || bot.settings.useReinvest
        annualizedReturn = compound
          ? ((1 + avgDailyPerc) ** 365 - 1) * 100
          : avgDailyPerc * 365 * 100
        if (annualizedReturn > Number.MAX_SAFE_INTEGER) {
          annualizedReturn = Infinity
        } else {
          annualizedReturn = math.round(annualizedReturn, 2)
        }
      }
      let profitPerc =
        typeof bot.stats?.numerical.general.netProfitPerc !== 'undefined' &&
        `${bot.stats?.numerical.general.netProfitPerc}` !== 'null' &&
        bot.stats?.numerical.general.netProfitPerc
          ? bot.stats.numerical.general.netProfitPerc
          : (bot.profit?.totalUsd ?? 0) / maxValue
      profitPerc = math.round(profitPerc * 100, 2)
      maxValue = math.round(maxValue, 2)
      avgDailyPerc = math.round(avgDailyPerc * 100, 2)
      avgDaily = math.round(avgDaily, 2, avgDaily < 0, avgDaily > 0)
      const botSymbols = [
        ...new Map(
          symbols
            .concat(
              ...[...bot.currentBalances.base.keys()].map((key) => {
                const quoteKey =
                  bot.currentBalances.quote.keys().next().value ?? ''
                const name1 = `${key}${quoteKey}`
                const name2 = `${key}-${quoteKey}`
                return [
                  {
                    symbol: name1,
                    baseAsset: key,
                    quoteAsset: quoteKey,
                  },
                  {
                    symbol: name2,
                    baseAsset: key,
                    quoteAsset: quoteKey,
                  },
                ]
              }),
              ...[...bot.currentBalances.quote.keys()].flatMap((key) => {
                const baseKey =
                  bot.currentBalances.base.keys().next().value ?? ''
                const name1 = `${baseKey}${key}`
                const name2 = `${baseKey}${key}`
                return [
                  {
                    symbol: name1,
                    baseAsset: baseKey,
                    quoteAsset: key,
                  },
                  {
                    symbol: name2,
                    baseAsset: baseKey,
                    quoteAsset: key,
                  },
                ]
              }),
            )
            .map((s) => [s.symbol, s]),
        ).values(),
      ]
      const findRates = latestPrices
        .filter((lp) => botSymbols.map((bs) => bs.symbol).includes(lp.pair))
        .reduce((acc, lp) => ({ ...acc, [lp.pair]: lp }), {}) as {
        [key: string]: Prices[0]
      }
      if (active && latestPrices.length > 0) {
        currentValues = math.round(
          (bot.settings.futures
            ? bot.settings.coinm
              ? bot.usage.current.base
              : bot.usage.current.quote
            : long
              ? bot.usage.current.quote
              : bot.usage.current.base) * usdRate,
        )
        if (Object.values(findRates).some((r) => r.price !== 0)) {
          unPnl = long
            ? this.sumBalances(
                bot.currentBalances.base,
                findRates,
                botSymbols,
              ) +
              this.sumPureBalances(bot.currentBalances.quote) -
              this.sumPureBalances(bot.initialBalances.quote)
            : this.sumBalances(
                bot.currentBalances.quote,
                findRates,
                botSymbols,
                true,
              ) -
              (this.sumPureBalances(bot.initialBalances.base) -
                this.sumPureBalances(bot.currentBalances.base))
          if (bot.settings.futures) {
            if (bot.settings.coinm) {
              unPnl = long
                ? this.sumPureBalances(bot.currentBalances.base) +
                  this.sumBalances(
                    bot.currentBalances.quote,
                    findRates,
                    botSymbols,
                    true,
                  ) -
                  this.sumBalances(
                    bot.initialBalances.quote,
                    findRates,
                    botSymbols,
                    true,
                  )
                : this.sumBalances(
                    bot.currentBalances.quote,
                    findRates,
                    botSymbols,
                    true,
                  ) -
                  (this.sumPureBalances(bot.initialBalances.base) -
                    this.sumPureBalances(bot.currentBalances.base))
            } else {
              unPnl = long
                ? this.sumBalances(
                    bot.currentBalances.base,
                    findRates,
                    botSymbols,
                  ) +
                  this.sumPureBalances(bot.currentBalances.quote) -
                  this.sumPureBalances(bot.initialBalances.quote)
                : this.sumPureBalances(bot.currentBalances.quote) -
                  (this.sumBalances(
                    bot.initialBalances.base,
                    findRates,
                    botSymbols,
                  ) -
                    this.sumBalances(
                      bot.currentBalances.base,
                      findRates,
                      botSymbols,
                    ))
            }
          }
          unPnl *= usdRate
          if (combo && 'dealsStatsForBot' in bot) {
            unPnl = 0
            bot.dealsStatsForBot.map((d) => {
              const price = findRates[d.symbol]?.price
              const profitBase =
                (bot.settings.futures && bot.settings.coinm) ||
                (!bot.settings.futures &&
                  bot.settings.profitCurrency === 'base')
              const qty = long
                ? (d.currentBalances?.base ?? 0)
                : (d.initialBalances?.base ?? 0) -
                  (d.currentBalances?.base ?? 0)
              let quote =
                (long
                  ? (d.initialBalances?.quote ?? 0) -
                    (d.currentBalances?.quote ?? 0)
                  : (d.currentBalances?.quote ?? 0)) +
                (profitBase ? 0 : d.profit.total * (long ? 1 : -1))
              const quoteTp = qty * price
              let base =
                quote / price +
                (profitBase ? d.profit.total * (long ? 1 : -1) : 0)
              let commission = bot.settings.futures
                ? bot.settings.coinm
                  ? qty * fee
                  : qty * price * fee
                : profitBase
                  ? qty * fee
                  : qty * price * fee
              let total =
                d.profit.total +
                (profitBase ? qty - base : quoteTp - quote) * (long ? 1 : -1) -
                commission
              if (
                typeof d.profit.pureBase !== 'undefined' &&
                typeof d.profit.pureQuote !== 'undefined' &&
                typeof d.feePaid !== 'undefined' &&
                `${d.feePaid}` !== 'null' &&
                `${d.profit.pureBase}` !== 'null' &&
                `${d.profit.pureQuote}` !== 'null' &&
                d.currentBalances.quote >= 0 &&
                d.currentBalances.base >= 0
              ) {
                quote = long
                  ? d.initialBalances.quote - d.currentBalances.quote
                  : d.currentBalances.quote
                base = quote / price
                commission = profitBase
                  ? d.feePaid
                    ? (d.feePaid.base ?? 0) +
                      (d.feePaid.quote ?? 0) / d.avgPrice
                    : 0
                  : d.feePaid
                    ? (d.feePaid.base ?? 0) * d.avgPrice +
                      (d.feePaid.quote ?? 0)
                    : 0
                total =
                  (profitBase ? qty - base : quoteTp - quote) *
                    (long ? 1 : -1) -
                  commission
              }
              const comboBasedOn =
                !d.comboTpBase || d.comboTpBase === ComboTpBase.full
                  ? ComboTpBase.full
                  : ComboTpBase.filled
              const usageBase =
                comboBasedOn === ComboTpBase.full
                  ? d.usage.max.base
                  : d.usage.current.base
              const usageQuote =
                comboBasedOn === ComboTpBase.full
                  ? d.usage.max.quote
                  : d.usage.current.quote
              comboDealCurrentValues +=
                (bot.settings.futures
                  ? bot.settings.coinm
                    ? usageBase
                    : usageQuote
                  : long
                    ? usageQuote
                    : usageBase) * usdRate
              unPnl +=
                total *
                (profitBase ? usdRatesBase[d.symbol] : usdRatesQuote[d.symbol])
            })
          }
          let usage = combo ? comboDealCurrentValues || maxValue : currentValues
          let tpUsage = 0
          if (!combo && bot.dealsReduceForBot?.length) {
            for (const d of bot.dealsReduceForBot) {
              const u = math.round(
                bot.settings.futures
                  ? bot.settings.coinm
                    ? d.base
                    : d.quote
                  : long
                    ? d.quote
                    : d.base,
              )
              usage += u
              tpUsage += u
              unPnl += d.profitUsd
            }
          }

          if (!combo && !tpUsage) {
            unPnlPerc = unPnl / usage
            unPnlPerc -= fee * 2
            unPnl = usage * unPnlPerc
          }
          if (!combo && tpUsage) {
            const feeAmount = Math.max(0, usage - tpUsage) * fee
            unPnl -= feeAmount
            unPnlPerc = unPnl / usage
          }
          if (combo) {
            unPnlPerc = unPnl / usage
          }
          unPnlPerc = math.round(unPnlPerc * 100, 2)
        }
      }

      const usdRateBaseValues = Object.values(usdRatesBase)
      const basePrecision =
        usdRateBaseValues.length === 1
          ? math.getPrecision(usdRateBaseValues[0])
          : 0

      const usdRateQuoteValues = Object.values(usdRatesQuote)
      const quotePrecision =
        usdRateQuoteValues.length === 1
          ? math.getPrecision(usdRateQuoteValues[0])
          : 0

      unPnl = active ? math.round(unPnl, 2, unPnl < 0, unPnl > 0) : 0
      bot.usage = {
        current: {
          base: math.round(bot.usage.current.base, basePrecision),
          quote: math.round(bot.usage.current.quote, quotePrecision),
        },
        max: {
          base: math.round(bot.usage.max.base, basePrecision),
          quote: math.round(bot.usage.max.quote, quotePrecision),
        },
      }

      const totalUsd = math.round(bot.profit?.totalUsd || 0, 2)

      const result: BotLiveStats = {
        currentCost: currentValues,
        maxCost: maxValue,
        relativeCost: currentValues / maxValue || 0,
        relativeCostString: `$${math.round(currentValues, 2)} / $${math.round(
          maxValue,
          2,
        )}`,
        totalProfit: totalUsd,
        relativeProfit: profitPerc,
        value: unPnl,
        relativeValue: unPnlPerc,
        avgDaily,
        avgDailyRelative: avgDailyPerc,
        annualizedReturn,
        tradingTimeString: resWork,
        tradingTimeNumber: workingTime,
        dealsTotal: bot.deals.all,
      }

      logger.debug(
        `[BotStatsMonitor] | ${bot._id} | Live stats calculated: ${JSON.stringify(result)}`,
      )

      if (combo) {
        await comboBotDb.updateData(
          { _id: `${bot._id}` },
          { liveStats: result, unrealizedProfit: unPnl },
        )
      } else {
        await dcaBotDb.updateData(
          { _id: `${bot._id}` },
          { liveStats: result, unrealizedProfit: unPnl },
        )
      }
    } catch (e) {
      logger.error(
        `[BotStatsMonitor] | ${bot._id} | Error calculating live stats: ${e}| input: ${JSON.stringify({ bot, fee, combo })}`,
      )
    }
  }

  @IdMute(
    mutexStats,
    ({ bot: { _id } }: CalculateGridLiveStatsParams) =>
      `calculateGridLiveStats-${_id}`,
  )
  async calculateGridLiveStats({ bot }: CalculateGridLiveStatsParams) {
    const latestPrices = await this.getLatestPrices(bot.exchange)
    let initialBalance = 0
    if (bot.initialBalances && bot.initialPrice && bot.usdRate) {
      initialBalance =
        (bot.initialBalances.base * bot.initialPrice +
          bot.initialBalances.quote) *
        bot.usdRate
    }
    let valueCurrent = 0
    let valueChange = 0
    let notUseValueChange = false
    const leverage =
      bot.settings.marginType !== BotMarginTypeEnum.inherit
        ? (bot.settings.leverage ?? 1)
        : 1
    let usdRateBudget = 1
    const findPrice = latestPrices.find((p) => p.pair === bot.settings.pair)
    if (bot.status !== 'closed') {
      if (!findPrice) {
        notUseValueChange = true
      }
      const usdRate = findUSDRate(
        bot.symbol.quoteAsset,
        latestPrices,
        bot.exchange,
      )
      usdRateBudget = usdRate
      if (bot.settings.futures && findPrice) {
        const current = bot.position
        if (!current) {
          notUseValueChange = true
        } else {
          const diff =
            current.side === PositionSide.LONG
              ? +findPrice.price - current.price
              : current.price - +findPrice.price

          // Spec 064: see the note in `helper.ts` `tpSl()`. The live value of
          // the position is `qty * (lastPrice − entry)`.
          const val = current.qty * diff
          valueCurrent = bot.profit.totalUsd + initialBalance / leverage + val
          valueChange = bot.profit.totalUsd + val
        }
      } else if (bot.currentBalances && findPrice && bot.symbol) {
        const profitBase = bot.settings.profitCurrency === 'base'
        valueCurrent =
          (bot.currentBalances.base +
            (profitBase
              ? ((bot.profit.freeTotal || bot.profit?.total) ?? 0)
              : 0)) *
            findPrice.price +
          bot.currentBalances.quote +
          (!profitBase ? ((bot.profit.freeTotal || bot.profit?.total) ?? 0) : 0)

        if (usdRate) {
          valueCurrent *= usdRate
        }
      }
    } else if (
      bot.status === 'closed' &&
      bot.lastPrice &&
      bot.lastUsdRate &&
      bot.currentBalances
    ) {
      if (bot.settings.futures) {
        valueCurrent = bot.profit.totalUsd + initialBalance / leverage
        valueChange = bot.profit.totalUsd
      } else {
        valueCurrent =
          bot.currentBalances.base * bot.lastPrice + bot.currentBalances.quote
        valueCurrent += bot.profit?.total || 0
        valueCurrent *= bot.lastUsdRate
      }
    } else {
      notUseValueChange = true
    }
    if (isCoinm(bot.exchange) && bot.status === 'closed') {
      usdRateBudget = findUSDRate(
        bot.symbol.baseAsset,
        latestPrices,
        bot.exchange,
      )
    }
    const valueChangeUsd = notUseValueChange
      ? 0
      : bot.settings.futures
        ? math.round(valueChange, 2)
        : math.round(math.round(valueCurrent) - math.round(initialBalance), 2)
    valueChange = notUseValueChange
      ? 0
      : bot.settings.futures
        ? math.round((valueChange / (initialBalance / leverage)) * 100, 2)
        : math.round(
            ((valueCurrent - initialBalance) / (initialBalance / leverage)) *
              100,
            2,
          )
    const workingTime =
      bot.workingShift && bot.workingShift.length > 0
        ? bot.workingShift.reduce((acc, v) => {
            if (v.end) {
              acc += v.end - v.start
            } else if (!v.end) {
              acc += new Date().getTime() - v.start
            }
            return acc
          }, 0)
        : 0
    const avgDaily = math.round(
      (bot.profit?.totalUsd || 0) /
        math.round(workingTime / (24 * 60 * 60 * 1000), 4),
      2,
    )
    let resWork = ''
    let count: number
    count = Math.floor(workingTime / (24 * 60 * 60 * 1000))
    if (count >= 1) {
      resWork = `${resWork} ${count}d`
    }
    count = Math.floor(workingTime / (60 * 60 * 1000))
    if (count >= 1) {
      resWork = `${resWork} ${count % 24}h`
    }
    count = Math.floor(workingTime / (60 * 1000))
    if (count >= 1) {
      resWork = `${resWork} ${count % 60}min`
    }
    if (resWork === '') {
      resWork = `${Math.floor(workingTime / 1000)}s`
    }
    const val =
      bot.initialBalances && bot.initialPrice && bot.usdRate
        ? math.round(initialBalance * bot.usdRate, 2)
        : 0
    let avgDailyPerc = avgDaily / initialBalance
    let annualizedReturn = 0
    if (!isNaN(avgDailyPerc) && isFinite(avgDailyPerc) && avgDailyPerc) {
      annualizedReturn = avgDailyPerc * 365 * 100
      if (annualizedReturn > Number.MAX_SAFE_INTEGER) {
        annualizedReturn = Infinity
      } else {
        annualizedReturn = math.round(annualizedReturn, 2)
      }
    }
    avgDailyPerc = math.round(avgDailyPerc * 100, 2)
    const result: GridLiveStats = {
      budget: math.round(
        bot.settings.budget *
          (bot.usdRate || usdRateBudget) *
          (isCoinm(bot.exchange) ? bot.initialPrice || 1 : 1),
        2,
      ),
      value: math.round(valueCurrent || val, 2),
      valueChange: valueChangeUsd,
      valueChangePerc: valueChange,
      avgDaily,
      avgDailyPerc,
      annualizedReturn,
      freePorfit: bot.profit.freeTotal,
      freeProfitUsd: bot.profit.freeTotalUsd,
      totalProfit: math.round(bot.profit?.total || 0, 2),
      totalProfitUsd: math.round(bot.profit?.totalUsd || 0, 2),
      tradingTime: workingTime,
      tradingTimeString: resWork,
    }
    logger.debug(
      `[BotStatsMonitor] | ${bot._id} | Live stats calculated: ${JSON.stringify(result)}`,
    )
    await botDb.updateData({ _id: `${bot._id}` }, { liveStats: result })
  }
}

export default BotMonitor

const botMonitor = BotMonitor.getInstance()
export { botMonitor }
