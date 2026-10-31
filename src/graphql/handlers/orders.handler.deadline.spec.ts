process.env.NODE_ENV = 'testing'

/**
 * Spec 214 — one slow exchange must not hang the open positions / open
 * orders lists. Venues are fake exchange factories; the DB reads after the
 * venue fan-out are stubbed.
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

const empty = async () => ({
  status: StatusEnum.ok,
  reason: null,
  data: { result: [] },
})
const DBS = ['dcaDealsDb', 'comboDealsDb', 'botDb', 'pairDb', 'orderDb']
let saved: Record<string, any> = {}

const never = () => new Promise<any>(() => undefined)

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

const account = (uuid: string, provider: ExchangeEnum) =>
  ({ uuid, provider, name: uuid, key: 'k', secret: 's' }) as any

/** Fake ExchangeChooser: venues in `slow` never answer, others at once. */
const ec = (slow: Set<string>, accounts: any[]) => {
  let i = 0
  return {
    chooseExchangeFactory: () => () => {
      const isSlow = slow.has(accounts[i++].uuid)
      return {
        futures_getPositions: () =>
          isSlow
            ? never()
            : Promise.resolve({ status: StatusEnum.ok, data: [position] }),
        getAllOpenOrders: () =>
          isSlow
            ? never()
            : Promise.resolve({ status: StatusEnum.ok, data: [order] }),
      }
    },
  }
}

describe('spec 214 — per-exchange deadline on open lists', () => {
  before(() => {
    for (const d of DBS) {
      saved[d] = {
        readData: dbInit[d].readData,
        aggregate: dbInit[d].aggregate,
      }
      dbInit[d].readData = empty
      dbInit[d].aggregate = async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: [] },
      })
    }
  })
  after(() => {
    for (const d of DBS) {
      dbInit[d].readData = saved[d].readData
      dbInit[d].aggregate = saved[d].aggregate
    }
    saved = {}
  })

  const accounts = [
    account('hl', ExchangeEnum.hyperliquidLinear),
    account('bn', ExchangeEnum.binanceUsdm),
  ]

  it('§4.1 returns the healthy venue positions when another never answers', async () => {
    const t0 = Date.now()
    const res = await handler.getAllOpenPositions(
      accounts,
      'u1',
      ec(new Set(['hl']), accounts),
      100,
    )
    expect(Date.now() - t0).to.be.lessThan(1000)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(res.data.map((p: any) => p.exchangeUUID)).to.deep.equal(['bn'])
  })

  it('§4.1 returns the healthy venue orders when another never answers', async () => {
    const t0 = Date.now()
    const res = await handler.getAllOpenOrders(
      accounts,
      ec(new Set(['hl']), accounts),
      100,
    )
    expect(Date.now() - t0).to.be.lessThan(1000)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(res.data.map((o: any) => o.exchangeUUID)).to.deep.equal(['bn'])
  })

  it('§4.2 waits for a slow venue when no deadline is passed', async () => {
    const outcome = await Promise.race([
      handler
        .getAllOpenPositions(accounts, 'u1', ec(new Set(['hl']), accounts))
        .then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still waiting'), 300)),
    ])
    expect(outcome).to.equal('still waiting')
  })

  it('§4.3 exports the list deadline used by the GraphQL queries', () => {
    expect(handler.OPEN_LIST_DEADLINE_MS).to.equal(15_000)
  })
})
