process.env.NODE_ENV = 'testing'

/**
 * A paper grid order was written ahead with the `'-1'` placeholder and a
 * bot-worker restart cut it off before it reached paper-trading. Paper-trading
 * answers every lookup for it with exactly `Unknown order`, which the bot did
 * not read as a "no such order", so the order was never retired and its level
 * never placed again.
 *
 * Spec: `specs/241.a-paper-order-cut-off-by-a-restart-is-never-retired.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB — the real `getOrder` and `noteOrderNotFound` run off the
 * prototype against a fake venue that answers like paper-trading does.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot, { isDefinitiveOrderNotFound } from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'CMB-GR-pppppppppppp'
/** Paper-trading's reason for a lookup of an order it does not hold. */
const PAPER_UNKNOWN = 'Unknown order'
const MIN = 60 * 1000

const notok = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

function grid(exchange: ExchangeEnum, ageMs: number) {
  const at = Date.now() - ageMs
  return {
    symbol: 'BTCUSDT',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '100',
    origPrice: '100',
    origQty: '1',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'LIMIT',
    typeOrder: 'dealGrid',
    dealId: 'deal',
    exchange,
    exchangeUUID: '',
    updateTime: at,
    transactTime: at,
  } as any
}

function bot(exchange: ExchangeEnum) {
  const rec = { getOrder: [] as string[], db: [] as any[] }
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = 'bot'
  b.data = { exchange, exchangeUUID: '', paperContext: true, flags: [] }
  b.orders = new Map()
  b.ordersKeys = new Set()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.newlyQuarantined = []
  b.exchange = {
    returnBad: () => (e: Error) => notok(e.message),
    async getOrder(req: { newClientOrderId: string }) {
      rec.getOrder.push(req.newClientOrderId)
      return notok(PAPER_UNKNOWN)
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  for (const k of [
    'handleLog',
    'handleDebug',
    'handleWarn',
    'handleError',
    'handleErrors',
  ]) {
    b[k] = () => undefined
  }
  b.emit = () => undefined
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  return { bot: b, rec }
}

describe('a paper order cut off by a restart is retired (spec 241)', () => {
  it("§4.1 paper's exact `Unknown order` is a definitive not-found on a paper exchange", () => {
    for (const ex of [
      ExchangeEnum.paperBybitUsdm,
      ExchangeEnum.paperBinance,
      ExchangeEnum.paperKraken,
    ]) {
      expect(isDefinitiveOrderNotFound(notok(PAPER_UNKNOWN), ex), ex).to.be.true
    }
  })

  it('§4.2 the same reason is left alone on a live venue, or with no venue given', () => {
    for (const ex of [
      ExchangeEnum.bybitUsdm,
      ExchangeEnum.binance,
      ExchangeEnum.kraken,
      undefined,
    ]) {
      expect(isDefinitiveOrderNotFound(notok(PAPER_UNKNOWN), ex), `${ex}`).to.be
        .false
    }
  })

  it("§4.2 Kraken's `EOrder:Unknown order` is not matched, on any venue", () => {
    for (const ex of [
      ExchangeEnum.kraken,
      ExchangeEnum.paperKraken,
      undefined,
    ]) {
      expect(
        isDefinitiveOrderNotFound(notok('EOrder:Unknown order'), ex),
        `${ex}`,
      ).to.be.false
    }
    // Exact match only: other wordings that merely contain it stay ambiguous.
    expect(
      isDefinitiveOrderNotFound(
        notok('unknown order'),
        ExchangeEnum.paperBybitUsdm,
      ),
    ).to.be.false
  })

  it('§4.3 a paper -1 order past the never-placed floor is retired as CANCELED', async () => {
    const ex = ExchangeEnum.paperBybitUsdm
    const { bot: b, rec } = bot(ex)
    const o = grid(ex, 10 * MIN)
    b.orders.set(CLIENT_ID, o)
    const res = await b.getOrder(CLIENT_ID, 'BTCUSDT', false)
    expect(rec.getOrder, 'asked paper by the client id').to.deep.equal([
      CLIENT_ID,
    ])
    expect(res.reason).to.equal(PAPER_UNKNOWN)
    expect(isDefinitiveOrderNotFound(res, b.data.exchange)).to.equal(true)
    expect(b.noteOrderNotFound(o, `${res.reason}`)).to.equal(true)
    expect(rec.db.map((d) => d.status)).to.deep.equal(['CANCELED'])
    expect(b.orders.has(CLIENT_ID)).to.equal(false)
  })

  it('§4.3 a paper -1 order younger than the floor is left alone', () => {
    const ex = ExchangeEnum.paperBybitUsdm
    const { bot: b, rec } = bot(ex)
    const o = grid(ex, 1 * MIN)
    b.orders.set(CLIENT_ID, o)
    expect(isDefinitiveOrderNotFound(notok(PAPER_UNKNOWN), ex)).to.equal(true)
    expect(b.noteOrderNotFound(o, PAPER_UNKNOWN)).to.equal(false)
    expect(rec.db).to.deep.equal([])
    expect(b.orders.get(CLIENT_ID)?.status).to.equal('NEW')
  })

  it('§4.2 control: on a live venue the same answer is not definitive, so nothing is retired', async () => {
    const ex = ExchangeEnum.bybitUsdm
    const { bot: b, rec } = bot(ex)
    b.orders.set(CLIENT_ID, grid(ex, 10 * MIN))
    const res = await b.getOrder(CLIENT_ID, 'BTCUSDT', false)
    expect(isDefinitiveOrderNotFound(res, b.data.exchange)).to.equal(false)
    expect(rec.db).to.deep.equal([])
    expect(b.orders.get(CLIENT_ID)?.status).to.equal('NEW')
  })
})
