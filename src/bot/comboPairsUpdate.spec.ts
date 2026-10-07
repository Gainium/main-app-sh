process.env.NODE_ENV = 'testing'

/**
 * Multi-coin combo bots change pairs through the same `changeDCABotPairs` path
 * as DCA bots (the v2 `PUT /bots/:botType/:botId` and `.../pairs` routes pass
 * `botType`). For a combo it must read the combo collection, save through
 * `changeComboBot` and hand that save's refusal back to the caller; DCA keeps
 * its existing behaviour.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { BotType, StatusEnum, StrategyEnum } from '../../types'
import Bot from './index'

const BOT_ID = '000000000000000000000c01'
const USER_ID = '000000000000000000000c02'

const pairRow = (base: string) => ({
  pair: `${base}USDT`,
  baseAsset: { name: base, minAmount: 0 },
  quoteAsset: { name: 'USDT', minAmount: 0 },
})

const storedBot = {
  _id: BOT_ID,
  userId: USER_ID,
  exchange: 'paperBinance',
  paperContext: true,
  vars: null,
  symbol: {
    BTCUSDT: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  },
  settings: {
    useMulti: true,
    strategy: StrategyEnum.long,
    pair: ['BTCUSDT', 'ETHUSDT'],
  },
}

const makeBot = (comboSave: { status: StatusEnum; reason: string | null }) => {
  const api: any = Object.create(Bot.prototype)
  const reads: string[] = []
  const calls: { combo?: any; dca?: any } = {}
  const db = (name: string, found: boolean) => ({
    readData: async () => {
      reads.push(name)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: { result: found ? storedBot : null },
      }
    },
  })
  api.userDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: { _id: USER_ID } },
    }),
  }
  api.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  api.pairsDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: ['BTC', 'ETH', 'SOL'].map(pairRow) },
    }),
  }
  api.checkPairs = async (_e: string, pairs: string[]) => ({
    status: StatusEnum.ok,
    data: pairs.map((p) => pairRow(p.split('_')[0])),
  })
  api.checkBotPairsBySettings = async (_e: string, _s: any, pairs: any[]) => ({
    filtered: pairs,
    removed: [],
  })
  api.changeComboBot = async (input: any) => {
    calls.combo = input
    return { ...comboSave, data: null }
  }
  api.changeDCABot = async (input: any) => {
    calls.dca = input
    return { status: StatusEnum.ok, reason: null, data: null }
  }
  return { api, reads, calls, db }
}

describe('changeDCABotPairs for multi-coin combo bots', () => {
  it('reads the combo collection and saves through changeComboBot', async () => {
    const { api, reads, calls, db } = makeBot({
      status: StatusEnum.ok,
      reason: null,
    })
    api.comboBotDb = db('combo', true)
    api.dcaBotDb = db('dca', false)
    const r = await api.changeDCABotPairs(
      USER_ID,
      BOT_ID,
      '',
      { add: ['SOL_USDT'] },
      undefined,
      undefined,
      false,
      BotType.combo,
    )
    expect(r.status).to.equal(StatusEnum.ok)
    expect(reads).to.deep.equal(['combo'])
    expect(calls.dca).to.equal(undefined)
    expect(calls.combo).to.deep.equal({
      id: BOT_ID,
      pair: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    })
  })

  it('hands the combo save refusal back to the caller', async () => {
    const { api, db } = makeBot({
      status: StatusEnum.notok,
      reason: 'Not enough credits. Balance: 1000, Locked: 800, Required: 600',
    })
    api.comboBotDb = db('combo', true)
    api.dcaBotDb = db('dca', false)
    const r = await api.changeDCABotPairs(
      USER_ID,
      BOT_ID,
      '',
      { add: ['SOL_USDT'] },
      undefined,
      undefined,
      false,
      BotType.combo,
    )
    expect(r.status).to.equal(StatusEnum.notok)
    expect(r.reason).to.match(/Not enough credits/)
  })

  it('returnResult computes the pairs without saving (v2 settings update)', async () => {
    const { api, calls, db } = makeBot({ status: StatusEnum.ok, reason: null })
    api.comboBotDb = db('combo', true)
    api.dcaBotDb = db('dca', false)
    const r = await api.changeDCABotPairs(
      USER_ID,
      BOT_ID,
      '',
      undefined,
      ['BTC_USDT', 'SOL_USDT'],
      undefined,
      true,
      BotType.combo,
    )
    expect(r.status).to.equal(StatusEnum.ok)
    expect(r.data.current).to.deep.equal(['BTCUSDT', 'SOLUSDT'])
    expect(calls.combo).to.equal(undefined)
  })

  it('DCA bots still read the DCA collection and save through changeDCABot', async () => {
    const { api, reads, calls, db } = makeBot({
      status: StatusEnum.ok,
      reason: null,
    })
    api.comboBotDb = db('combo', false)
    api.dcaBotDb = db('dca', true)
    const r = await api.changeDCABotPairs(USER_ID, BOT_ID, '', {
      add: ['SOL_USDT'],
    })
    expect(r.status).to.equal(StatusEnum.ok)
    expect(reads).to.deep.equal(['dca'])
    expect(calls.combo).to.equal(undefined)
    expect(calls.dca.pair).to.deep.equal(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
  })
})
