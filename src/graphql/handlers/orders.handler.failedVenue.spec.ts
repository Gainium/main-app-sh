process.env.NODE_ENV = 'testing'

/**
 * Spec 259 — a failed per-account venue read must not look like an account
 * with no open orders / positions. Venues are fake exchange factories; the DB
 * reads after the venue fan-out are stubbed.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { ExchangeEnum, StatusEnum } from '../../../types'

const load = createRequire(__filename)
const dbInit = load('../../db/dbInit')
const handler = load('./orders.handler')

const DBS = ['dcaDealsDb', 'comboDealsDb', 'botDb', 'pairDb', 'orderDb']
let saved: Record<string, any> = {}

const position = {
  symbol: 'BTCUSDT',
  positionAmt: '0.5',
  positionSide: 'LONG',
  updateTime: 1,
  isolated: true,
  leverage: '5',
  entryPrice: '60000',
}
const order = {
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'LIMIT',
  orderId: 1,
  status: 'NEW',
  price: '60000',
  origQty: '0.1',
  executedQty: '0',
  clientOrderId: 'c1',
  updateTime: 1,
}

type Mode = 'ok' | 'notok' | 'throw' | 'late'

const account = (uuid: string, provider = ExchangeEnum.binanceUsdm) =>
  ({ uuid, provider, name: uuid, key: 'k', secret: 's' }) as any

const answer = (mode: Mode, ok: any) => {
  if (mode === 'ok') {
    return Promise.resolve({ status: StatusEnum.ok, reason: null, data: [ok] })
  }
  if (mode === 'notok') {
    return Promise.resolve({
      status: StatusEnum.notok,
      reason: 'Invalid API-key',
      data: null,
    })
  }
  if (mode === 'throw') {
    return Promise.reject(new Error('socket hang up'))
  }
  return new Promise<any>(() => undefined)
}

/** Fake ExchangeChooser: each account answers per `modes[uuid]`. */
const ec = (modes: Record<string, Mode>, accounts: any[]) => {
  let i = 0
  return {
    chooseExchangeFactory: () => () => {
      const mode = modes[accounts[i++].uuid]
      return {
        futures_getPositions: () => answer(mode, position),
        getAllOpenOrders: () => answer(mode, order),
      }
    },
  }
}

const orders = (modes: Record<string, Mode>) => {
  const accounts = Object.keys(modes).map((u) => account(u))
  return handler.getAllOpenOrders(accounts, ec(modes, accounts), 100)
}
const positions = (modes: Record<string, Mode>) => {
  const accounts = Object.keys(modes).map((u) => account(u))
  return handler.getAllOpenPositions(accounts, 'u1', ec(modes, accounts), 100)
}

describe('spec 259 — failed venue reads are reported, not listed as empty', () => {
  before(() => {
    for (const d of DBS) {
      saved[d] = {
        readData: dbInit[d].readData,
        aggregate: dbInit[d].aggregate,
      }
      const empty = async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: [] },
      })
      dbInit[d].readData = empty
      dbInit[d].aggregate = empty
    }
  })
  after(() => {
    for (const d of DBS) {
      dbInit[d].readData = saved[d].readData
      dbInit[d].aggregate = saved[d].aggregate
    }
    saved = {}
  })

  for (const [name, run] of [
    ['orders', orders],
    ['positions', positions],
  ] as const) {
    describe(name, () => {
      for (const mode of ['notok', 'throw', 'late'] as Mode[]) {
        it(`§3.1 single account that is ${mode} answers NOTOK with the cause`, async () => {
          const res = await run({ a1: mode })
          expect(res.status).to.equal(StatusEnum.notok)
          expect(res.data).to.equal(null)
          expect(res.reason).to.contain('a1')
          expect(res.reason).to.contain(ExchangeEnum.binanceUsdm)
          if (mode === 'notok') {
            expect(res.reason).to.contain('Invalid API-key')
          }
          if (mode === 'throw') {
            expect(res.reason).to.contain('socket hang up')
          }
          if (mode === 'late') {
            expect(res.reason).to.contain('100ms')
          }
        })
      }

      it('§3.2 keeps the answered accounts and names the failed one in reason', async () => {
        const res = await run({ a1: 'notok', a2: 'ok', a3: 'late' })
        expect(res.status).to.equal(StatusEnum.ok)
        expect(res.data.map((r: any) => r.exchangeUUID)).to.deep.equal(['a2'])
        expect(res.reason).to.contain('a1')
        expect(res.reason).to.contain('a3')
        expect(res.reason).to.not.contain('a2')
      })

      it('§3.3 every account failed answers NOTOK', async () => {
        const res = await run({ a1: 'notok', a2: 'throw' })
        expect(res.status).to.equal(StatusEnum.notok)
        expect(res.reason).to.contain('a1')
        expect(res.reason).to.contain('a2')
      })

      it('§3.4 all accounts answered: reason stays null', async () => {
        const res = await run({ a1: 'ok', a2: 'ok' })
        expect(res.status).to.equal(StatusEnum.ok)
        expect(res.reason).to.equal(null)
        expect(res.data).to.have.length(2)
      })
    })
  }
})
