process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `040` — a liquidated deal records no closing order.
 *
 * Two layers:
 *
 *  - the pure rule (`dealsClosedByLiquidation`, `liquidationDealLinks`), which
 *    decides which deals a venue liquidation ended and what has to be written
 *    for each of them;
 *  - the REAL `dcaHelper.processLiquidationOrder`, driven over the mixin with a
 *    minimal base class, replaying the reported sequence: a `LONG` futures deal
 *    was liquidated, the liquidation order was persisted `FILLED` at the
 *    liquidation price, and the deal it closed came back from the API with six
 *    orders — every one of them a `BUY`. No close, no chart marker, no
 *    explanation.
 *
 * Fixture ids are synthetic on purpose — this file is public, and the
 * identifiers of the account the case came from belong in the private issue.
 *
 * Run: `npm test` (mocha) from `core`.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  dealsClosedByLiquidation,
  liquidationCopyClientOrderId,
  liquidationDealLinks,
} from './liquidationDealLink'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
  type Order,
} from '../../../types'

const BOT_ID = '000000000000000000000b01'
const USER_ID = '000000000000000000000401'
const DEAL_A = '000000000000000000000d01'
const DEAL_B = '000000000000000000000d02'
const SYMBOL = { symbol: 'BOME-USDC', baseAsset: 'BOME', quoteAsset: 'USDC' }
const LIQ_ID = 'liquidation_1c2e6317'
/** The reported deal's liquidation price, to the tick it was recorded at. */
const LIQ_PRICE = 0.000859

const liquidationOrder = (): Order =>
  ({
    symbol: SYMBOL.symbol,
    orderId: LIQ_ID,
    clientOrderId: LIQ_ID,
    updateTime: 1788991723365,
    price: `${LIQ_PRICE}`,
    origQty: '0',
    executedQty: '0',
    status: 'FILLED',
    type: 'LIMIT',
    side: OrderSideEnum.sell,
    botId: BOT_ID,
    userId: USER_ID,
    exchange: ExchangeEnum.binanceUsdm,
    exchangeUUID: '',
    typeOrder: TypeOrderEnum.liquidation,
    baseAsset: SYMBOL.baseAsset,
    quoteAsset: SYMBOL.quoteAsset,
    origPrice: `${LIQ_PRICE}`,
    reduceOnly: true,
    liquidation: true,
  }) as unknown as Order

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL.symbol] },
    exchange: ExchangeEnum.binanceUsdm,
    paperContext: true,
    flags: [],
  }
  get futures() {
    return true
  }
  get isLong() {
    return true
  }
  get kucoinFullFutures() {
    return false
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Written = {
  /** `{ filter, update }` pairs handed to the orders collection. */
  updates: { filter: any; update: any }[]
  /** Whole order documents saved as new rows. */
  saved: any[]
  warns: string[]
}

/**
 * A bot holding `openDeals` on the symbol whose `closeAllDeals` closes
 * `closes` of them — so a test can express "the close did not take" as well as
 * the ordinary path.
 */
const buildBot = (openDeals: string[], closes: string[] = openDeals) => {
  const written: Written = { updates: [], saved: [], warns: [] }
  let open = [...openDeals]
  class TestBot extends Helper {
    written = written
    getOpenDeals() {
      return open.map((id) => ({
        deal: { _id: id, status: DCADealStatusEnum.open, symbol: SYMBOL },
      }))
    }
    async closeAllDeals() {
      open = open.filter((id) => !closes.includes(id))
    }
    async getLatestPrice() {
      return LIQ_PRICE
    }
    ordersDb = {
      updateData: async (filter: any, update: any) => {
        written.updates.push({ filter, update })
        return { status: 'OK', data: { result: null } }
      },
    }
    async saveOrderToDb(order: any) {
      written.saved.push(order)
    }
    async handleErrors() {}
    handleLog() {}
    handleDebug() {}
    handleWarn(log: string) {
      written.warns.push(log)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

const liquidate = async (openDeals: string[], closes?: string[]) => {
  const bot: any = buildBot(openDeals, closes)
  await bot.processLiquidationOrder(liquidationOrder())
  return bot.written as Written
}

describe('a liquidated deal records no closing order (spec 040)', () => {
  describe('§4.4 which deals the liquidation ended', () => {
    it('a deal that stopped being open was closed by it', () => {
      expect(dealsClosedByLiquidation([DEAL_A], [])).to.deep.equal([DEAL_A])
    })

    it('a deal that is still open was not', () => {
      expect(
        dealsClosedByLiquidation([DEAL_A, DEAL_B], [DEAL_B]),
      ).to.deep.equal([DEAL_A])
    })

    it('nothing open before means nothing to link', () => {
      expect(dealsClosedByLiquidation([], [DEAL_A])).to.deep.equal([])
    })
  })

  describe('§4.2 what gets written', () => {
    it('the ordinary one-deal bot only stamps the row it already has', () => {
      const links = liquidationDealLinks(LIQ_ID, [DEAL_A])
      expect(links).to.deep.equal([
        { kind: 'claim', clientOrderId: LIQ_ID, dealId: DEAL_A },
      ])
    })

    it('a second deal gets its own row, under its own client order id', () => {
      const links = liquidationDealLinks(LIQ_ID, [DEAL_A, DEAL_B])
      expect(links).to.have.length(2)
      expect(links[1].kind).to.equal('copy')
      expect(links[1].dealId).to.equal(DEAL_B)
      // Uniquely indexed — a copy reusing the id would be rejected outright.
      expect(links[1].clientOrderId).to.not.equal(LIQ_ID)
      expect(links[1].clientOrderId).to.equal(
        liquidationCopyClientOrderId(LIQ_ID, DEAL_B),
      )
    })
  })

  describe('§4.1 the engine', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('the reported case: the liquidation is linked to the deal it closed', async () => {
      const written = await liquidate([DEAL_A])
      expect(written.updates, 'one stamped row').to.have.length(1)
      expect(written.updates[0].filter.clientOrderId).to.equal(LIQ_ID)
      expect(written.updates[0].update.dealId).to.equal(DEAL_A)
      expect(
        written.saved,
        'no duplicate row for a single deal',
      ).to.have.length(0)
    })

    it('a second deal closed by the same liquidation gets a copy', async () => {
      const written = await liquidate([DEAL_A, DEAL_B])
      expect(written.updates).to.have.length(1)
      expect(written.updates[0].update.dealId).to.equal(DEAL_A)
      expect(written.saved, 'one copy').to.have.length(1)
      expect(written.saved[0].dealId).to.equal(DEAL_B)
      expect(written.saved[0].clientOrderId).to.equal(
        liquidationCopyClientOrderId(LIQ_ID, DEAL_B),
      )
      // §4.3 — a copy is a copy. Inventing a quantity would put a number into
      // ledgers that have never counted a liquidation.
      expect(written.saved[0].origQty).to.equal('0')
      expect(written.saved[0].executedQty).to.equal('0')
      expect(written.saved[0].typeOrder).to.equal(TypeOrderEnum.liquidation)
      expect(written.saved[0].price).to.equal(`${LIQ_PRICE}`)
    })

    it('a deal the close left open is not given a closing order', async () => {
      const written = await liquidate([DEAL_A, DEAL_B], [DEAL_A])
      expect(written.updates).to.have.length(1)
      expect(written.updates[0].update.dealId).to.equal(DEAL_A)
      expect(written.saved).to.have.length(0)
    })
  })
})
