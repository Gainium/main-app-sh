process.env.NODE_ENV = 'testing'

/**
 * The hourly global pairs sync must leave OKX Europe (`source: 'my'`) pairs
 * alone. They share the exchange id (okx / okxLinear) with the global docs,
 * but the global instrument feed never lists them — so a sync that reads them
 * deletes every one, every run, until the EU refresher re-creates them.
 *
 * Drives the real `updateExchangeInfo` with a fake exchange feed and an
 * in-memory `pairs` collection queried through `sift` (the matcher mongoose
 * itself uses), so `$ne` on a missing field behaves as Mongo does.
 *
 * Enforces specs/119 §3.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import sift from 'sift'
import { ExchangeEnum, OKXSource, StatusEnum } from '../../../types'
import { pairDb } from '../../db/dbInit'
import RedisClient from '../../db/redis'
import { updateExchangeInfo } from './exchange'

const info = (pair: string, base: string) => ({
  pair,
  code: pair,
  wsCode: pair,
  baseAsset: {
    name: base,
    minAmount: 1,
    step: 1,
    maxAmount: 1e6,
    maxMarketAmount: 1e6,
  },
  quoteAsset: { name: 'USDT', minAmount: 1, precision: 2 },
  maxOrders: 100,
  priceAssetPrecision: 2,
})

describe('global pairs sync vs OKX Europe pairs (spec 119 §3)', () => {
  let rows: any[]
  let deleted: string[]
  let created: string[]
  const saved: Record<string, any> = {}

  before(() => {
    for (const k of ['readData', 'createData', 'updateData', 'deleteManyData'])
      saved[k] = (pairDb as any)[k]
    saved.redis = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => ({ publish: () => 0 })
    ;(pairDb as any).readData = async (filter: any) => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: rows.filter(sift(filter)) },
    })
    ;(pairDb as any).createData = async (d: any) => {
      created.push(d.pair)
      return { status: StatusEnum.ok }
    }
    ;(pairDb as any).updateData = async () => ({ status: StatusEnum.ok })
    ;(pairDb as any).deleteManyData = async (f: any) => {
      deleted.push(...f._id.$in)
      rows = rows.filter((r) => !f._id.$in.includes(r._id))
      return { status: StatusEnum.ok }
    }
  })
  after(() => {
    Object.assign(pairDb as any, {
      readData: saved.readData,
      createData: saved.createData,
      updateData: saved.updateData,
      deleteManyData: saved.deleteManyData,
    })
    ;(RedisClient as any).getInstance = saved.redis
  })

  it('keeps source:my docs, still prunes a delisted global pair, and creates nothing for EU pairs', async () => {
    const btc = info('BTC-USDT-SWAP', 'BTC')
    const eth = info('ETH-USDT-SWAP', 'ETH')
    rows = [
      { _id: 'g-btc', exchange: ExchangeEnum.okxLinear, ...btc },
      { _id: 'g-eth', exchange: ExchangeEnum.okxLinear, ...eth },
      {
        _id: 'g-old',
        exchange: ExchangeEnum.okxLinear,
        ...info('OLD-USDT-SWAP', 'OLD'),
      },
      {
        _id: 'eu-btc',
        exchange: ExchangeEnum.okxLinear,
        source: OKXSource.my,
        ...info('BTC-USD_UM_XPERP', 'BTC'),
      },
      {
        _id: 'eu-aapl',
        exchange: ExchangeEnum.okxLinear,
        source: OKXSource.my,
        ...info('AAPL-USD_UM_XPERP', 'AAPL'),
      },
    ]
    deleted = []
    created = []
    const ec: any = {
      chooseExchangeFactory: (provider: ExchangeEnum) =>
        provider === ExchangeEnum.okxLinear
          ? () => ({
              getAllExchangeInfo: async () => ({
                status: 'OK',
                data: [btc, eth],
              }),
            })
          : null,
    }
    await updateExchangeInfo(ec)
    expect(deleted).to.deep.equal(['g-old'])
    expect(rows.map((r) => r._id)).to.include.members(['eu-btc', 'eu-aapl'])
    expect(created).to.deep.equal([])
  })
})
