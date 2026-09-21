import { IdMute, IdMutex } from '../utils/mutex'
import {
  PriceMessage,
  ProfitLossStats,
  InputGrid,
  PositionSide,
  BotMarginTypeEnum,
} from '../../types'
import { isFutures } from '../utils/index'
import { botDb } from '../db/dbInit'

type GridStatsMap = {
  start: number
  drawdownPercent: number
  runUpPercent: number
  timeInLoss: number
  timeInProfit: number
  timeCountStart: number
  currentCount: 'loss' | 'profit'
  wasChanged: boolean
}

const mutex = new IdMutex()

export class GridMonitor {
  private gridBotDb = botDb
  private stats: Map<string, GridStatsMap>
  private callBacks: Map<string, (data: ProfitLossStats) => void>
  private static instance: GridMonitor

  private constructor() {
    this.stats = new Map()
    this.callBacks = new Map()
  }

  public static getInstance() {
    if (!GridMonitor.instance) {
      GridMonitor.instance = new GridMonitor()
    }
    return GridMonitor.instance
  }

  public addCallback(dealBotId: string, cb: (data: ProfitLossStats) => void) {
    this.callBacks.set(dealBotId, cb)
  }

  @IdMute(
    mutex,
    (_data: unknown, bot: InputGrid) => `${bot._id.toString()}stats`,
    10,
  )
  public async addBotStats(data: PriceMessage, bot: InputGrid) {
    const { price, time } = data
    const dealId = bot._id.toString()
    const stats = this.stats.get(dealId)
    if (stats && (time - stats.start <= 60 * 1000 || !stats.wasChanged)) {
      this.updateDealStats(bot, stats, price, time)
    } else {
      if (stats) {
        await this.completeStats(dealId, time, { ...stats })
      }
      this.addNewBot(bot, price, time)
    }
  }

  private updateDealStats(
    bot: InputGrid,
    stats: GridStatsMap,
    price: number,
    time: number,
  ) {
    const futures = isFutures(bot.exchange)
    const { initialBalances, initialPrice, currentBalances } = bot
    if (initialPrice === undefined) {
      return
    }
    if (bot.realInitialBalances === null) {
      return
    }
    const initialValue =
      initialBalances.base * initialPrice + initialBalances.quote
    let newPerc = 0
    let valueChange = 0
    if (futures) {
      const leverage =
        bot.settings.marginType !== BotMarginTypeEnum.inherit
          ? (bot.settings.leverage ?? 1)
          : 1
      const current = bot.position
      const diff =
        current.side === PositionSide.LONG
          ? price - current.price
          : current.price - price
      // Spec 064: see the note in `helper.ts` `tpSl()` — the drawdown/run-up
      // is tracked against the same value the TP/SL triggers on, so it carries
      // the same correction.
      const val = current.qty * diff
      valueChange = val + bot.profit.total
      newPerc = Math.abs(valueChange / (initialValue / leverage))
    } else {
      const currentValue =
        currentBalances.base * price +
        currentBalances.quote +
        bot.profit.total * (bot.settings.profitCurrency === 'base' ? price : 1)
      valueChange = currentValue - initialValue
      newPerc = Math.abs(currentValue - initialValue) / initialValue
    }
    if (valueChange > 0 && newPerc > stats.runUpPercent) {
      stats.runUpPercent = newPerc
      stats.wasChanged = true
    } else if (valueChange < 0 && newPerc > stats.drawdownPercent) {
      stats.drawdownPercent = newPerc
      stats.wasChanged = true
    }

    // Guarded the way `DealMonitor.updateDealStats` guards it: a sample clocked
    // before the window opened would accumulate a NEGATIVE interval (spec 064
    // §4.4).
    if (time > stats.timeCountStart) {
      if (valueChange > 0 && stats.currentCount === 'loss') {
        stats.timeInLoss += time - stats.timeCountStart - 1
        stats.timeCountStart = time
        stats.currentCount = 'profit'
        stats.wasChanged = true
      } else if (valueChange < 0 && stats.currentCount === 'profit') {
        stats.timeInProfit += time - stats.timeCountStart - 1
        stats.timeCountStart = time
        stats.currentCount = 'loss'
        stats.wasChanged = true
      }
    }
    this.stats.set(bot._id.toString(), stats)
  }

  private addNewBot(bot: InputGrid, price: number, time: number) {
    const { initialBalances, initialPrice, currentBalances } = bot
    if (initialPrice === undefined) {
      return
    }
    const initialValue =
      initialBalances.base * initialPrice + initialBalances.quote
    const futures = isFutures(bot.exchange)
    let valueChange = 0
    if (futures) {
      const current = bot.position
      const diff =
        current.side === PositionSide.LONG
          ? price - current.price
          : current.price - price
      // Spec 064.
      const val = current.qty * diff
      valueChange = val + bot.profit.total
    } else {
      const currentValue =
        currentBalances.base * price +
        currentBalances.quote +
        bot.profit.total * (bot.settings.profitCurrency === 'base' ? price : 1)
      valueChange = currentValue - initialValue
    }
    this.stats.set(bot._id.toString(), {
      start: time,
      drawdownPercent: bot.stats?.drawdownPercent ?? 0,
      runUpPercent: bot.stats?.runUpPercent ?? 0,
      timeCountStart: time,
      currentCount:
        (bot.stats?.currentCount ?? valueChange > 0) ? 'profit' : 'loss',
      timeInLoss: 0,
      timeInProfit: 0,
      wasChanged: false,
    })
  }

  /**
   * Flush a bot's tracked stats and stop tracking it.
   *
   * Nothing used to remove a grid bot from this map, so `completeStats` only
   * ever ran on the NEXT sample after a window closed — and since a bot is
   * sampled at most once a minute, the window it stops in is neither sampled
   * nor written. The deepest drawdown of a stop-loss close was discarded that
   * way. Taking the final measurement here (rather than only flushing what is
   * already in memory) is what makes the flush worth anything: on a bot that
   * stops less than a sampling interval after its last one there is otherwise
   * nothing in memory but the values read back from the document. Spec 064.
   */
  @IdMute(
    mutex,
    (_data: unknown, bot: InputGrid) => `${bot._id.toString()}stats`,
    10,
  )
  public async removeBotStats(data: PriceMessage, bot: InputGrid) {
    const id = bot._id.toString()
    const stats = this.stats.get(id)
    if (stats) {
      this.updateDealStats(bot, stats, data.price, data.time)
      await this.completeStats(id, data.time, {
        ...(this.stats.get(id) ?? stats),
      })
    }
    this.stats.delete(id)
  }

  private async completeStats(id: string, time: number, stats: GridStatsMap) {
    // Clamped the way `DealMonitor.completeStats` clamps it: the flush above
    // is clocked locally while `timeCountStart` comes from the price stream,
    // so an interval can come out negative and must not be `$inc`ed.
    const tracked = Math.max(0, time - stats.timeCountStart)
    const timeInLoss =
      stats.timeInLoss + (stats.currentCount === 'loss' ? tracked : 0)
    const timeInProfit =
      stats.timeInProfit + (stats.currentCount === 'profit' ? tracked : 0)
    await this.gridBotDb.updateData(
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
        'stats.timeCountStart': time,
      },
    )
    stats.wasChanged = false
    this.stats.set(id, stats)
  }
}
