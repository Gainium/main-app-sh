process.env.NODE_ENV = 'testing'

/**
 * Spec `110` — a reload does not place a second copy of a pending add-funds or
 * reduce-funds order that is still resting.
 *
 * Modelled on the reproduction: a deal whose pending limit
 * add-funds `{ qty: 40 quote, limitPrice: 0.1192 }` already had its order
 * resting when a keep-orders reload ran. The reload re-sent every pending
 * entry, so the venue got a second 0.1192 order next to the first (and the
 * deal's other resting additions, re-sent the same way, each filled twice).
 *
 * Drives the REAL `resendPendingFunds` and the REAL `addDealFunds` on a
 * minimal base class; `sendOrderToExchange` is a recorder, so nothing is
 * placed. `reduceDealFunds` is a recorder too — its own sizing is out of scope.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum } from '../../../types'
import { splitPendingFunds } from './pendingFundsResend'

const DEAL_ID = '6a0000000000000000000110'
const SYMBOL = 'HYPEUSDT'
const ADD_ID = '5e1d0f00-0000-4000-8000-000000000110'
const REDUCE_ID = '0b3a1f7e-0000-4000-8000-000000000001'

const pendingAdd = {
  id: ADD_ID,
  qty: '40',
  limitPrice: '0.1192',
  useLimitPrice: true,
  type: 'fixed',
  asset: 'quote',
}
const pendingReduce = {
  id: REDUCE_ID,
  qty: '100',
  limitPrice: '0.15',
  useLimitPrice: true,
  type: 'fixed',
  asset: 'base',
}

const addOrder = (status: string, addFundsId = ADD_ID): any => ({
  clientOrderId: `D-ROA-${status}-${addFundsId.slice(0, 4)}`,
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealRegular,
  status,
  price: '0.1192',
  origQty: '336',
  executedQty: status === 'FILLED' ? '336' : '0',
  side: 'BUY',
  addFundsId,
})
const reduceOrder = (status: string): any => ({
  clientOrderId: `D-TPR-${status}`,
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealTP,
  status,
  price: '0.15',
  origQty: '100',
  executedQty: '0',
  side: 'SELL',
  reduceFundsId: REDUCE_ID,
})
/** A plain resting safety order: never matches an entry. */
const safetyOrder: any = {
  clientOrderId: 'D-RO-level8',
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealRegular,
  status: 'NEW',
  price: '0.11162',
  origQty: '2544',
  executedQty: '0',
  side: 'BUY',
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = false
  hedge = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    exchange: ExchangeEnum.hyperliquid,
    exchangeUUID: 'ex',
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (orders: any[], pending: { add?: any[]; reduce?: any[] }) => {
  const fullDeal: any = {
    deal: {
      _id: DEAL_ID,
      symbol: { symbol: SYMBOL, baseAsset: 'HYPE', quoteAsset: 'USDT' },
      status: 'open',
      levels: { all: 22, complete: 19 },
      pendingAddFunds: pending.add ?? [],
      pendingReduceFunds: pending.reduce ?? [],
    },
    initialOrders: [],
    currentOrders: [],
  }
  class TestBot extends Helper {
    public sent: any[] = []
    public reduced: any[] = []
    public saved: any[] = []
    getDeal(id: string) {
      return id === DEAL_ID ? fullDeal : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    saveDeal(_d: any, patch: any) {
      this.saved.push(patch)
      return Promise.resolve()
    }
    async getLatestPrice() {
      return 0.1323
    }
    async baseAssetPrecision() {
      return 0
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { minAmount: 1, step: 1, name: 'HYPE' },
        quoteAsset: { minAmount: 10, step: 0.01, name: 'USDT' },
        priceAssetPrecision: 4,
      }
    }
    getOrderId(prefix: string) {
      return `${prefix}-x`
    }
    async sendOrderToExchange(order: any) {
      this.sent.push(order)
      return { ...order, status: 'NEW' }
    }
    async reduceDealFunds(...args: any[]) {
      this.reduced.push(args[2])
    }
    updateUsage() {}
    updateAssets() {}
    updateDealBalances() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return { bot: new TestBot() as any, fullDeal }
}

/** `resendPendingFunds` fires `addDealFunds` without awaiting it, as before. */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('spec 110 — pending add/reduce funds on reload', () => {
  describe('splitPendingFunds (pure)', () => {
    it('§2.1 an entry whose order rests stays standing', () => {
      const r = splitPendingFunds(
        [pendingAdd],
        [addOrder('NEW'), safetyOrder],
        'addFundsId',
      )
      expect(r.resend).to.deep.equal([])
      expect(r.standing).to.deep.equal([pendingAdd])
    })
    it('§2.1 PARTIALLY_FILLED and FILLED also stand', () => {
      for (const s of ['PARTIALLY_FILLED', 'FILLED']) {
        const r = splitPendingFunds([pendingAdd], [addOrder(s)], 'addFundsId')
        expect(r.resend, s).to.deep.equal([])
      }
    })
    it('§2.2 an entry whose order was cancelled, or has no order, is re-sent', () => {
      expect(
        splitPendingFunds([pendingAdd], [addOrder('CANCELED')], 'addFundsId')
          .resend,
      ).to.deep.equal([pendingAdd])
      expect(
        splitPendingFunds([pendingAdd], [safetyOrder], 'addFundsId').resend,
      ).to.deep.equal([pendingAdd])
    })
    it('§2.3 a reduce entry matches on reduceFundsId only', () => {
      expect(
        splitPendingFunds(
          [pendingReduce],
          [reduceOrder('NEW')],
          'reduceFundsId',
        ).resend,
      ).to.deep.equal([])
      expect(
        splitPendingFunds(
          [{ ...pendingAdd, id: REDUCE_ID }],
          [reduceOrder('NEW')],
          'addFundsId',
        ).resend,
      ).to.have.length(1)
    })
  })

  describe('resendPendingFunds (real dcaHelper)', () => {
    before(function () {
      // One ts-node compile of a 26k-line module.
      this.timeout(240000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('§1.1 keep-orders reload with a resting limit add-funds places no second order', async () => {
      const { bot, fullDeal } = buildBot([addOrder('NEW'), safetyOrder], {
        add: [pendingAdd],
      })
      bot.resendPendingFunds(fullDeal)
      await settle()
      expect(bot.sent).to.deep.equal([])
      expect(fullDeal.deal.pendingAddFunds).to.deep.equal([pendingAdd])
    })

    it('§1.2 the order was cancelled (user start / settings update): it is placed again', async () => {
      const { bot, fullDeal } = buildBot([addOrder('CANCELED'), safetyOrder], {
        add: [pendingAdd],
      })
      bot.resendPendingFunds(fullDeal)
      await settle()
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].price).to.equal('0.1192')
      expect(bot.sent[0].origQty).to.equal('336')
      expect(bot.sent[0].side).to.equal('BUY')
      // The old entry is replaced by the re-sent order's own.
      expect(fullDeal.deal.pendingAddFunds).to.have.length(1)
      expect(fullDeal.deal.pendingAddFunds[0].id).to.not.equal(ADD_ID)
    })

    it('§1.3 only the missing one of two entries is re-sent', async () => {
      const other = { ...pendingAdd, id: 'other-id', limitPrice: '0.1274' }
      const { bot, fullDeal } = buildBot([addOrder('NEW'), safetyOrder], {
        add: [pendingAdd, other],
      })
      bot.resendPendingFunds(fullDeal)
      await settle()
      expect(bot.sent.map((o: any) => o.price)).to.deep.equal(['0.1274'])
      expect(fullDeal.deal.pendingAddFunds.map((p: any) => p.id)).to.include(
        ADD_ID,
      )
    })

    it('§1.4 a resting reduce-funds order is not re-sent; a missing one is', async () => {
      let r = buildBot([reduceOrder('NEW')], { reduce: [pendingReduce] })
      r.bot.resendPendingFunds(r.fullDeal)
      await settle()
      expect(r.bot.reduced).to.deep.equal([])
      expect(r.fullDeal.deal.pendingReduceFunds).to.deep.equal([pendingReduce])

      r = buildBot([reduceOrder('CANCELED')], { reduce: [pendingReduce] })
      r.bot.resendPendingFunds(r.fullDeal)
      await settle()
      const { id: _id, ...settings } = pendingReduce
      expect(r.bot.reduced).to.deep.equal([settings])
      expect(r.fullDeal.deal.pendingReduceFunds).to.deep.equal([])
    })
  })
})
