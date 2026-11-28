process.env.NODE_ENV = 'testing'
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot from './index'
import { BotType, DCADealStatusEnum, StatusEnum } from '../../types'

/**
 * A bot whose deals still hold a position must never be deleted, whether or
 * not a worker has it loaded, and the purge must never hard-delete it either.
 * Before this guard, the open-deal check lived inside `if (bot)` (loaded bots
 * only) and the purge deleted every soft-deleted, expired bot with no look at
 * its deals.
 */

type Deal = { _id: string; botId: string; status: DCADealStatusEnum }

const ok = <T>(data: T) => ({ status: StatusEnum.ok, reason: 'ok', data })

const matches = (deal: Deal, search: any) => {
  const ids: string[] | undefined =
    search?.botId?.$in ?? (search?.botId ? [search.botId] : undefined)
  if (ids && !ids.includes(deal.botId)) {
    return false
  }
  const statuses: string[] | undefined = search?.status?.$in
  if (statuses && !statuses.includes(deal.status)) {
    return false
  }
  return true
}

const dealsDb = (deals: Deal[]) => ({
  calls: [] as any[],
  async readData(search: any) {
    return ok({ result: deals.filter((d) => matches(d, search)) })
  },
  async countData(search: any) {
    return ok({ result: deals.filter((d) => matches(d, search)).length })
  },
  async updateManyData(search: any, update: any) {
    this.calls.push({ updateMany: search, update })
    return ok({})
  },
  async deleteManyData(search: any) {
    this.calls.push({ deleteMany: search })
    return ok({})
  },
})

const botDb = (bots: { _id: string }[] = []) => ({
  calls: [] as any[],
  async readData() {
    return ok({ result: bots, count: bots.length })
  },
  async updateData(search: any, update: any) {
    this.calls.push({ update: search, set: update })
    return ok({ vars: { list: [] } })
  },
  async deleteManyData(search: any) {
    this.calls.push({ deleteMany: search })
    return ok({})
  },
})

const sink = () => ({
  calls: [] as any[],
  async deleteManyData(search: any) {
    this.calls.push({ deleteMany: search })
    return ok({})
  },
  async updateManyData(search: any) {
    this.calls.push({ updateMany: search })
    return ok({})
  },
  createData() {
    return ok({})
  },
})

const harness = (opts: {
  dcaDeals?: Deal[]
  comboDeals?: Deal[]
  dcaBots?: { _id: string }[]
  comboBots?: { _id: string }[]
}) => {
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaBots = []
  bot.comboBots = []
  bot.dcaBotDb = botDb(opts.dcaBots)
  bot.comboBotDb = botDb(opts.comboBots)
  bot.botDb = botDb([])
  bot.dcaDealsDb = dealsDb(opts.dcaDeals ?? [])
  bot.comboDealsDb = dealsDb(opts.comboDeals ?? [])
  bot.orderDb = sink()
  bot.botEventDb = sink()
  bot.botMessageDb = sink()
  bot.transactionDb = sink()
  bot.comboTransactionDb = sink()
  bot.comboProfitDb = sink()
  bot.checkBigAccount = () => undefined
  return bot
}

describe('deleteBot refuses a bot whose deals hold a position', () => {
  for (const status of [DCADealStatusEnum.open, DCADealStatusEnum.start]) {
    it(`dca, bot not loaded on any worker, one ${status} deal → refused, nothing written`, async () => {
      const bot = harness({
        dcaDeals: [{ _id: 'd1', botId: 'b1', status }],
      })
      const res = await bot.deleteBot('u1', 'b1', BotType.dca, false, false)
      expect(res.status).to.equal(StatusEnum.notok)
      expect(res.reason).to.equal('Cannot delete bot with active deal')
      expect(bot.dcaBotDb.calls).to.have.length(0)
      expect(bot.dcaDealsDb.calls).to.have.length(0)
    })

    it(`combo, bot not loaded on any worker, one ${status} deal → refused, nothing written`, async () => {
      const bot = harness({
        comboDeals: [{ _id: 'd1', botId: 'b1', status }],
      })
      const res = await bot.deleteBot('u1', 'b1', BotType.combo, false, false)
      expect(res.status).to.equal(StatusEnum.notok)
      expect(res.reason).to.equal('Cannot delete bot with active deal')
      expect(bot.comboBotDb.calls).to.have.length(0)
    })
  }

  it('dca, bot not loaded, only closed/canceled deals → soft-deleted as before', async () => {
    const bot = harness({
      dcaDeals: [
        { _id: 'd1', botId: 'b1', status: DCADealStatusEnum.closed },
        { _id: 'd2', botId: 'b1', status: DCADealStatusEnum.canceled },
        // another bot's open deal must not block this one
        { _id: 'd3', botId: 'b2', status: DCADealStatusEnum.open },
      ],
    })
    const res = await bot.deleteBot('u1', 'b1', BotType.dca, false, false)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(bot.dcaBotDb.calls).to.have.length(1)
    expect(bot.dcaBotDb.calls[0].set.$set.isDeleted).to.equal(true)
    expect(bot.dcaDealsDb.calls[0].updateMany).to.deep.equal({ botId: 'b1' })
  })

  it('combo, bot not loaded, no deals → soft-deleted as before', async () => {
    const bot = harness({})
    const res = await bot.deleteBot('u1', 'b1', BotType.combo, false, false)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(bot.comboBotDb.calls).to.have.length(1)
  })
})

describe('premanenetlyDeleteBots never hard-deletes a bot with an open deal', () => {
  it('skips the dca/combo bots holding open deals, deletes the rest by _id', async () => {
    const bot = harness({
      dcaBots: [{ _id: 'dcaOpen' }, { _id: 'dcaFlat' }],
      comboBots: [{ _id: 'comboOpen' }, { _id: 'comboFlat' }],
      dcaDeals: [
        { _id: 'd1', botId: 'dcaOpen', status: DCADealStatusEnum.open },
        { _id: 'd2', botId: 'dcaFlat', status: DCADealStatusEnum.closed },
      ],
      comboDeals: [
        { _id: 'c1', botId: 'comboOpen', status: DCADealStatusEnum.start },
      ],
    })
    await bot.premanenetlyDeleteBots(true)

    const deleted = (db: any) => db.calls.map((c: any) => c.deleteMany)
    expect(deleted(bot.dcaBotDb)).to.deep.equal([{ _id: { $in: ['dcaFlat'] } }])
    expect(deleted(bot.comboBotDb)).to.deep.equal([
      { _id: { $in: ['comboFlat'] } },
    ])
    // the cascade touches only the bots actually being deleted
    for (const db of [
      bot.orderDb,
      bot.botEventDb,
      bot.botMessageDb,
      bot.dcaDealsDb,
      bot.transactionDb,
      bot.comboTransactionDb,
    ]) {
      const ids = deleted(db).flatMap((s: any) => s.botId.$in)
      expect(ids).to.not.include('dcaOpen')
      expect(ids).to.not.include('comboOpen')
      expect(ids).to.include.members(['dcaFlat', 'comboFlat'])
    }
  })

  it('deletes nothing when every candidate holds an open deal', async () => {
    const bot = harness({
      dcaBots: [{ _id: 'dcaOpen' }],
      dcaDeals: [
        { _id: 'd1', botId: 'dcaOpen', status: DCADealStatusEnum.open },
      ],
    })
    await bot.premanenetlyDeleteBots(true)
    expect(bot.dcaBotDb.calls).to.have.length(0)
    expect(bot.orderDb.calls).to.have.length(0)
    expect(bot.dcaDealsDb.calls).to.have.length(0)
  })
})
