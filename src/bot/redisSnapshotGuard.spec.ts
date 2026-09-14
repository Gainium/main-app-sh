process.env.NODE_ENV = 'testing'

/**
 * A bot's Redis `botData` snapshot must not be restored when its profit total
 * is non-finite.
 *
 * The snapshot is written with `JSON.stringify`, which turns NaN into `null`,
 * while Mongo refuses the NaN and keeps the last good value. Restoring the
 * `null` on a cold restart makes the next deal close compute
 * `null + dealProfit`, resetting the bot's realized profit to zero.
 *
 * Drives the REAL `loadData` off the prototype — no Mongo, Redis or venue.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { StatusEnum } from '../../types'
import { poisonedSnapshotProfitField } from './redisSnapshotGuard'

const STOP = new Error('stop after data is chosen')

const makeBot = (snapshot: any, dbDoc: any) => {
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = 'bot-1'
  bot.serviceRestart = true
  bot.secondRestart = false
  bot.errors = [] as string[]
  bot.startMethod = () => 'm'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleErrors = (e: string) => {
    bot.errors.push(String(e))
  }
  bot.getFromRedis = async (key: string) =>
    key === 'botData' ? JSON.parse(JSON.stringify(snapshot)) : null
  bot.db = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: dbDoc },
    }),
  }
  // Everything after the data source is chosen is out of scope here.
  bot.getUser = async () => {
    throw STOP
  }
  return bot
}

const load = async (bot: any) => {
  try {
    await bot.loadData()
  } catch (e) {
    if (e !== STOP) {
      throw e
    }
  }
}

describe('redis bot snapshot guard', () => {
  describe('poisonedSnapshotProfitField', () => {
    it('accepts a finite profit', () => {
      expect(
        poisonedSnapshotProfitField({ profit: { total: 1.5, totalUsd: -2 } }),
      ).to.equal(null)
    })

    it('flags a NaN that JSON turned into null', () => {
      const snapshot = JSON.parse(
        JSON.stringify({ profit: { total: NaN, totalUsd: 3 } }),
      )
      expect(poisonedSnapshotProfitField(snapshot)).to.equal('profit.total')
    })

    it('flags a non-finite totalUsd', () => {
      expect(
        poisonedSnapshotProfitField({
          profit: { total: 1, totalUsd: Infinity },
        }),
      ).to.equal('profit.totalUsd')
    })

    it('ignores a snapshot without profit', () => {
      expect(poisonedSnapshotProfitField({})).to.equal(null)
      expect(poisonedSnapshotProfitField(null)).to.equal(null)
    })
  })

  describe('loadData on a cold restart', () => {
    const dbDoc = {
      _id: 'bot-1',
      userId: 'user-1',
      status: 'open',
      profit: { total: 91.68, totalUsd: 91.67 },
    }

    it('restores a healthy snapshot from Redis', async () => {
      const snapshot = {
        ...dbDoc,
        profit: { total: 92.25, totalUsd: 92.24 },
      }
      const bot = makeBot(snapshot, dbDoc)
      await load(bot)
      expect(bot.data.profit.total).to.equal(92.25)
      expect(bot.errors).to.deep.equal([])
    })

    it('falls back to the database when the snapshot profit is poisoned', async () => {
      const snapshot = { ...dbDoc, profit: { total: NaN, totalUsd: NaN } }
      const bot = makeBot(snapshot, dbDoc)
      await load(bot)
      expect(bot.data.profit.total).to.equal(91.68)
      expect(bot.data.profit.totalUsd).to.equal(91.67)
      expect(bot.errors).to.have.length(1)
      expect(bot.errors[0]).to.contain('profit.total')
    })
  })
})
