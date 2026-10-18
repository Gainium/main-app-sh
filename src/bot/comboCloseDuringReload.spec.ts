process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `173.a-reload-during-a-combo-deal-close-leaves-its-ladders-active`.
 *
 * Drives the REAL Combo `afterDealClose` (and through it the real
 * `processCloseMinigrid` / `saveMinigrid` / `deleteMinigrid`). Only the
 * minigrid DAO is recorded instead of run.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { ComboMinigridStatusEnum, StatusEnum } from '../../types'

const DEAL_ID = '000000000000000000000d73'
const OTHER_DEAL_ID = '000000000000000000000d74'
const BOT_ID = '000000000000000000000b73'

let Helper: any

const minigrid = (id: string, dealId: string) =>
  ({
    schema: {
      _id: id,
      botId: BOT_ID,
      dealId,
      status: ComboMinigridStatusEnum.active,
      symbol: { symbol: 'AAA-USDT', baseAsset: 'AAA', quoteAsset: 'USDT' },
    },
    initialGrids: [],
    currentOrders: [],
  }) as any

const buildBot = () => {
  const updates: { search: any; data: any }[] = []
  const updateMany: { search: any; data: any }[] = []
  class TestBot extends (Helper as any) {
    botId = BOT_ID
    botType = 'combo'
    combo = true
    loadingComplete = true
    data: any = {
      settings: { name: 'bot', pair: ['AAA-USDT'] },
      status: 'open',
      dealsStatsForBot: [],
    }
    updates = updates
    updateMany = updateMany
    shouldProceed() {
      return true
    }
    getDeal() {
      return undefined
    }
    setToRedis() {}
    saveMinigridToRedis() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot = new (TestBot as any)()
  bot.minigridDb = {
    updateData: async (search: any, data: any) => {
      updates.push({ search, data })
      return { status: StatusEnum.ok, data: null, reason: null }
    },
    updateManyData: async (search: any, data: any) => {
      updateMany.push({ search, data })
      return {
        status: StatusEnum.ok,
        data: null,
        reason: 'Data updated. Matched: 4, modified: 4',
      }
    },
  }
  return bot
}

describe('a combo deal close that a reload raced (spec 173)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  it('§1.1.1 closes the ladders in the database when the reload emptied the minigrid maps', async () => {
    const bot = buildBot()
    bot.setMinigrid(minigrid('m1', DEAL_ID), false)
    bot.setMinigrid(minigrid('m2', DEAL_ID), false)
    // A reload's `clearClassProperties` ran while the close was in flight —
    // the same two resets it performs (comboHelper / dcaHelper).
    bot.minigrids = new Map()
    bot.minigridDealMap = new Map()
    await bot.afterDealClose(DEAL_ID)
    expect(bot.updateMany).to.have.length(1)
    expect(bot.updateMany[0].search).to.deep.equal({
      botId: BOT_ID,
      dealId: DEAL_ID,
      status: { $ne: ComboMinigridStatusEnum.closed },
    })
    expect(bot.updateMany[0].data).to.deep.equal({
      $set: { status: ComboMinigridStatusEnum.closed },
    })
  })

  it('§1.1.2 closes in-memory ladders one by one and does not sweep the database', async () => {
    const bot = buildBot()
    bot.setMinigrid(minigrid('m1', DEAL_ID), false)
    bot.setMinigrid(minigrid('m2', DEAL_ID), false)
    bot.setMinigrid(minigrid('m3', OTHER_DEAL_ID), false)
    await bot.afterDealClose(DEAL_ID)
    // `saveMinigrid` is mutex-wrapped; let its queued writes run.
    await new Promise((r) => setTimeout(r, 50))
    expect(bot.updateMany).to.have.length(0)
    expect(
      bot.updates
        .filter((u: any) => u.data.$set.status === 'closed')
        .map((u: any) => u.search._id)
        .sort(),
    ).to.deep.equal(['m1', 'm2'])
    expect(bot.getMinigridByDealId({ dealId: DEAL_ID })).to.have.length(0)
    expect(bot.getMinigridByDealId({ dealId: OTHER_DEAL_ID })).to.have.length(1)
  })

  it('§1.1.3 writes nothing when the bot may not proceed', async () => {
    const bot = buildBot()
    bot.shouldProceed = () => false
    await bot.afterDealClose(DEAL_ID)
    expect(bot.updateMany).to.have.length(0)
  })
})
