process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `188.a-close-request-resends-a-take-profit-that-already-filled`.
 *
 * Drives the REAL `dcaHelper.closeDealById` and `cancelAllOrder` off the mixin
 * over the sequence recorded in prod (spec §2): binance HOMEUSDT, a close
 * request whose cancel sweep found the deal's take-profit already FILLED on the
 * venue. The fill's own close runs in the background; the request used to
 * prepare and send a second, full-size take-profit anyway.
 *
 * Nothing here opens a connection or places anything: the venue send is
 * recorded. Harness shape from `limitOnlyCloseRemainder.spec.ts` (spec 157).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { CloseDCATypeEnum, ExchangeEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0188'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0188'
const TP_ID = 'x-BKSVA3NTD-TP-uk8j-0188'
const QTY = 4387

/** The resting take-profit the close request is about to cancel. */
const restingTp = (extra: any = {}): any => ({
  clientOrderId: TP_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'HOMEUSDT',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'NEW',
  price: '0.005135',
  origQty: `${QTY}`,
  executedQty: '0',
  updateTime: 1792592101000,
  ...extra,
})

const makeDeal = () => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'HOMEUSDT', baseAsset: 'HOME', quoteAsset: 'USDT' },
  lastPrice: 0.005135,
  tpHistory: [],
  levels: { all: 1, complete: 1 },
  profit: { total: 0, totalUsd: 0 },
})

let Helper: any

/**
 * @param cancelFills the venue answers the take-profit's cancel with FILLED
 *   (the `_handleUnknownOrder` "Real order … status: FILLED" path)
 * @param onFill what the background `handleUnknownOrder` hand-off does before
 *   the request reaches its send: nothing yet, or the fill's `closeDeal`
 *   already marked the deal closed
 */
const makeBot = (
  opts: {
    cancelFills: boolean
    onFill?: 'nothing' | 'closed'
    settings?: any
    tp?: any
  } = { cancelFills: false },
) => {
  const deal = makeDeal()
  const sent: any[] = []
  const handedOff: any[] = []
  const settings = opts.settings ?? {}
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public exchange = {}
    public allowToPlaceOrders = new Map()
    public closeDealTimer = new Map()
    public dealTimersMap = new Map()
    public startTimeoutTime = new Map()
    public loadingComplete = true
    public isLong = true
    public futures = false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    public data: any = {
      exchange: ExchangeEnum.binance,
      settings: { name: 'bot', pair: ['HOMEUSDT'], type: 'regular' },
      flags: [],
    }
    /** The order map, as `getOrdersByStatusAndDealId` reads it. */
    public book: any[] = [restingTp(opts.tp)]
    getOrdersByStatusAndDealId({ status, dealId }: any) {
      const wanted = [status].flat()
      return this.book.filter(
        (o: any) =>
          wanted.includes(o.status) && (dealId ? o.dealId === dealId : true),
      )
    }
    getDeal(id: string) {
      return id === DEAL_ID && deal.status !== 'gone'
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    async getAggregatedSettings() {
      return settings
    }
    async clearDealTimer() {}
    saveDeal() {
      return Promise.resolve()
    }
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange(o: any) {
      if (!opts.cancelFills) {
        o.status = 'CANCELED'
        return o
      }
      // `_handleUnknownOrder`: the venue says FILLED, the row is re-set in
      // the order map with that status and returned.
      o.status = 'FILLED'
      o.executedQty = o.origQty
      return o
    }
    handleUnknownOrder(o: any) {
      // Fire-and-forget, as `cancelAllOrder` calls it.
      handedOff.push(o.clientOrderId)
      if (opts.onFill === 'closed') {
        // `closeDeal` lands while the request is preparing its order
        // (prod: 41 ms after the hand-off, 191 ms before the send).
        setTimeout(() => {
          this.pendingClose.add(DEAL_ID)
          deal.status = 'closed'
        }, 40)
      }
    }
    async prepareTpOrder() {
      return {
        side: 'SELL',
        qty: QTY,
        price: 0.005135,
        type: 'dealTP',
        newClientOrderId: 'x-BKSVA3NTD-TP-vMYA-0188',
      }
    }
    async getExchangeInfo() {
      return {
        pair: 'HOMEUSDT',
        priceAssetPrecision: 6,
        baseAsset: { minAmount: 1, step: 1, name: 'HOME' },
        quoteAsset: { minAmount: 5, step: 0.00000001, name: 'USDT' },
      }
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(grid: any, additional: any) {
      sent.push({ ...grid, orderType: additional.type })
      return { ...grid, clientOrderId: grid.newClientOrderId, status: 'NEW' }
    }
    async announceLeftOpenPosition() {}
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
  return { bot, deal, sent, handedOff }
}

const close = (bot: any) =>
  bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    CloseDCATypeEnum.closeByMarket,
    true,
    false,
    false,
    false,
    '',
    undefined,
    false,
  )

describe('a close request whose sweep finds the take-profit FILLED (spec 188)', () => {
  before(function () {
    // One ts-node compile of a 32k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§4.1 cancelAllOrder returns the orders whose cancel came back FILLED', async () => {
    const { bot, handedOff } = makeBot({ cancelFills: true })
    const filled = await bot.cancelAllOrder(0, DEAL_ID, true)
    expect(filled.map((o: any) => [o.clientOrderId, o.status])).to.deep.equal([
      [TP_ID, 'FILLED'],
    ])
    expect(handedOff).to.deep.equal([TP_ID])
  })

  it('§1/§4.2 the fill has not closed the deal yet: no second take-profit is sent (deal 6ad862f1 replay)', async () => {
    const { bot, sent, handedOff } = makeBot({
      cancelFills: true,
      onFill: 'nothing',
    })
    await close(bot)
    expect(handedOff).to.deep.equal([TP_ID])
    expect(sent).to.have.length(0)
  })

  it('§4.2 the fill closed the deal during the request: nothing is sent', async () => {
    const { bot, sent } = makeBot({ cancelFills: true, onFill: 'closed' })
    await close(bot)
    expect(sent).to.have.length(0)
  })

  it('§1 unchanged: an ordinary close (sweep cancels normally) sends its close order', async () => {
    const { bot, sent } = makeBot({ cancelFills: false })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
      ['SELL', QTY, 'MARKET'],
    ])
  })

  it('§4.3 a multi-TP target fill does not close the position: the rest is still closed', async () => {
    const { bot, sent } = makeBot({
      cancelFills: true,
      onFill: 'nothing',
      settings: { useMultiTp: true },
      tp: { tpSlTarget: 't1' },
    })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
      ['SELL', QTY, 'MARKET'],
    ])
  })
})
