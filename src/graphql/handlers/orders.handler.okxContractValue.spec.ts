process.env.NODE_ENV = 'testing'

/**
 * Spec 296 — OKX USDT-swap open positions apply the contract value once on
 * read, and the close converts coins back to contracts once.
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

/** OKX X-Perp rows as the connector maps them: step = ctVal × minSz (1). */
const pairs = [
  { pair: 'ETH-USD_UM_XPERP', ctVal: 0.001, step: 0.001 },
  { pair: 'PEPE-USD_UM_XPERP', ctVal: 1e6, step: 1e6 },
  { pair: 'ONDO-USD_UM_XPERP', ctVal: 10, step: 10 },
  { pair: 'SUI-USD_UM_XPERP', ctVal: 1, step: 1 },
  // ctVal-1 swaps with a fractional lot (spec 297): step = minSz < 1
  { pair: 'LINK-USDT', ctVal: 1, step: 0.1 },
  { pair: 'SOL-USDT', ctVal: 1, step: 0.01 },
  { pair: 'GOOGL-USD_UM_XPERP', ctVal: 1, step: 0.01 },
].map((p) => ({
  pair: p.pair,
  exchange: ExchangeEnum.okxLinear,
  baseAsset: { name: 'X', step: p.step, multiplier: p.ctVal },
  quoteAsset: { name: 'USDC' },
}))

const venue = (symbol: string, pos: string) => ({
  symbol,
  positionAmt: pos,
  positionSide: 'LONG',
  updateTime: 1,
  isolated: true,
  leverage: '5',
  entryPrice: '1',
})

const read = async (symbol: string, pos: string) => {
  const res = await handler.getAllOpenPositions(
    [
      {
        uuid: 'a1',
        provider: ExchangeEnum.okxLinear,
        name: 'a1',
        key: 'k',
        secret: 's',
      },
    ],
    'u1',
    {
      chooseExchangeFactory: () => () => ({
        futures_getPositions: async () => ({
          status: StatusEnum.ok,
          reason: null,
          data: [venue(symbol, pos)],
        }),
      }),
    },
    1000,
  )
  expect(res.status).to.equal(StatusEnum.ok)
  return +res.data[0].quantity
}

const close = (symbol: string, coins: number) =>
  handler.okxLinearCloseContracts(
    coins,
    pairs.find((p) => p.pair === symbol),
  )

describe('spec 296 — OKX swap position size applies ctVal once', () => {
  before(() => {
    for (const d of DBS) {
      saved[d] = {
        readData: dbInit[d].readData,
        aggregate: dbInit[d].aggregate,
      }
      const rows = d === 'pairDb' ? pairs : []
      dbInit[d].readData = async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: rows },
      })
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

  it('§1.1/§1.2 ETH ctVal 0.001: 9717 contracts read 9.717 and close 9717', async () => {
    const q = await read('ETH-USD_UM_XPERP', '9717')
    expect(q).to.be.closeTo(9.717, 1e-9)
    expect(close('ETH-USD_UM_XPERP', q)).to.equal(9717)
  })

  it('§1.1/§1.2 PEPE ctVal 1e6: 1842 contracts read 1.842e9 and close 1842', async () => {
    const q = await read('PEPE-USD_UM_XPERP', '1842')
    expect(q).to.equal(1.842e9)
    expect(close('PEPE-USD_UM_XPERP', q)).to.equal(1842)
  })

  it('§1.1/§1.2 ONDO ctVal 10: 37 contracts read 370 and close 37', async () => {
    const q = await read('ONDO-USD_UM_XPERP', '-37')
    expect(q).to.equal(370)
    expect(close('ONDO-USD_UM_XPERP', q)).to.equal(37)
  })

  it('§1.3 SUI ctVal 1, step 1: 250 contracts read 250 and close 250', async () => {
    expect(await read('SUI-USD_UM_XPERP', '250')).to.equal(250)
    expect(close('SUI-USD_UM_XPERP', 250)).to.equal(250)
  })

  it('spec 297 §1.1/§1.2 LINK-USDT ctVal 1, step 0.1: 50 contracts read 50 and close 50', async () => {
    const q = await read('LINK-USDT', '50')
    expect(q).to.equal(50)
    expect(close('LINK-USDT', q)).to.equal(50)
  })

  it('spec 297 §1.1/§1.2 SOL-USDT ctVal 1, step 0.01: 12.34 contracts read 12.34 and close 12.34', async () => {
    const q = await read('SOL-USDT', '-12.34')
    expect(q).to.equal(12.34)
    expect(close('SOL-USDT', q)).to.equal(12.34)
  })

  it('spec 297 §1.1/§1.2 X-Perp ctVal 1, step 0.01: 1.47 contracts read 1.47 and close 1.47', async () => {
    const q = await read('GOOGL-USD_UM_XPERP', '1.47')
    expect(q).to.equal(1.47)
    expect(close('GOOGL-USD_UM_XPERP', q)).to.equal(1.47)
  })
})
