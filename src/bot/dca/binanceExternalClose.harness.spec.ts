process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/289.binance-futures-external-close-priced-from-fills.md`.
 *
 * A Binance USDⓈ-M / COIN-M deal whose position was closed outside the bot (a
 * hand close in the Binance app, a liquidation) was booked "profit unknown"
 * at zero: the connector answered no account fills for Binance, and Binance's
 * trade history is per symbol, so a read that names no symbol can never have
 * any. These pin that main-app asks for the deal's own symbol, and that the
 * close is then priced from the venue's closing fills, never from the bot's
 * own.
 *
 * Run: npx mocha -r ts-node/register src/bot/dca/binanceExternalClose.harness.spec.ts
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import Exchange from '../../exchange/exchange'
import {
  DCADealFlags,
  DCADealStatusEnum,
  DCACloseTriggerEnum,
  ExchangeEnum,
  StatusEnum,
  type AccountFill,
} from '../../../types'

const SYMBOL = 'IOTXUSDT'
const DEAL_ID = '000000000000000000000e19'
const DEAL_OPEN = Date.parse('2026-09-17T10:00:00Z')
const DEAL_QTY = 509496

/**
 * Account fills as the connector maps Binance `userTrades` (connector spec
 * `057`): the bot's own orders keep their client id and `source: 'API'`; a
 * hand close in the app has its venue-assigned id blanked and `source: 'WEB'`.
 */
const FILLS: AccountFill[] = [
  {
    fillId: '3',
    orderId: '200',
    clientOrderId: '',
    symbol: SYMBOL,
    side: 'SELL',
    price: '0.01530',
    quantity: '300000',
    timestamp: Date.parse('2026-10-05T12:00:01Z'),
    source: 'WEB',
    fee: '2.295',
  },
  {
    fillId: '2',
    orderId: '200',
    clientOrderId: '',
    symbol: SYMBOL,
    side: 'SELL',
    price: '0.01520',
    quantity: '209496',
    timestamp: Date.parse('2026-10-05T12:00:00Z'),
    source: 'WEB',
    fee: '1.592',
  },
  {
    fillId: '1',
    orderId: '100',
    clientOrderId: 'x-AbCdEf-entry',
    symbol: SYMBOL,
    side: 'BUY',
    price: '0.02100',
    quantity: '509496',
    timestamp: DEAL_OPEN + 1000,
    source: 'API',
    fee: '5.35',
  },
]

const EXPECTED_PRICE = (0.0153 * 300000 + 0.0152 * 209496) / DEAL_QTY

describe('spec 289 §1.1 — the account-fills read names the deal’s symbol', () => {
  const connector = () => {
    const calls: any[] = []
    const ex: any = Object.create((Exchange as any).prototype)
    ex.exchange = ExchangeEnum.binanceUsdm
    ex.getEmptyTimeProfile = () => ({})
    ex.saveTimeProfile = () => undefined
    ex.apiCall = async (call: unknown) => {
      calls.push(call)
      return {
        data: { status: StatusEnum.ok, data: [], reason: null },
        timeProfile: {},
      }
    }
    return { ex, calls }
  }

  it('a symbol is sent as `symbol`', async () => {
    const { ex, calls } = connector()
    await ex.getAccountFills(undefined, SYMBOL)
    expect(calls[0].endpoint).to.equal('accountFills')
    expect(calls[0].params).to.deep.equal({ symbol: SYMBOL })
  })

  it('with a cursor, both are sent', async () => {
    const { ex, calls } = connector()
    await ex.getAccountFills(1795709000000, SYMBOL)
    expect(calls[0].params).to.deep.equal({
      since: '1795709000000',
      symbol: SYMBOL,
    })
  })

  it('a caller that names nothing sends exactly what it did before', async () => {
    const { ex, calls } = connector()
    await ex.getAccountFills()
    expect(calls[0].params).to.equal(undefined)
    await ex.getAccountFills(1795709000000)
    expect(calls[1].params).to.deep.equal({ since: '1795709000000' })
  })
})

class FakeBase {
  botId = '000000000000000000000b19'
  userId = '000000000000000000000419'
  botType = 'dca'
  loadingComplete = true
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.binanceUsdm,
    paperContext: false,
    flags: [],
  }
  get futures() {
    return true
  }
  get kucoinFullFutures() {
    return false
  }
  get hedge() {
    return false
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/**
 * A long bot on Binance USDⓈ-M holding the deal. Like the real connector, the
 * venue answers fills only for a named symbol: Binance publishes no
 * account-wide trade history.
 */
const buildBot = () => {
  const calls = {
    asks: [] as any[][],
    closeDeal: [] as any[],
    events: [] as any[],
    saved: [] as any[],
  }
  let open = true
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL, baseAsset: 'IOTX', quoteAsset: 'USDT' },
      createTime: DEAL_OPEN,
      size: DEAL_QTY,
      flags: [],
    },
  }
  class TestBot extends Helper {
    calls = calls
    combo = false
    isLong = true
    saveDeal(_d: any, update: any) {
      calls.saved.push(update)
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.0005 }
    }
    exchange = {
      getAccountFills: async (...args: any[]) => {
        calls.asks.push(args)
        return {
          status: StatusEnum.ok,
          data: args[1] === SYMBOL ? FILLS : [],
          reason: null,
        }
      },
    }
    getDeal() {
      return open ? deal : undefined
    }
    async closeDeal(...args: any[]) {
      calls.closeDeal.push(args)
      open = false
    }
    botEventDb = {
      createData: (e: any) => calls.events.push(e),
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  return new TestBot() as any
}

describe('spec 289 §1.2 — a Binance futures deal closed by hand is priced from the venue', () => {
  before(function () {
    // One ts-node compile of a very large module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('the evidence read asks for the deal’s own symbol', async () => {
    const bot = buildBot()
    await bot.venueCloseEvidenceFor(bot.getDeal(DEAL_ID))
    expect(bot.calls.asks).to.have.length(1)
    expect(bot.calls.asks[0][1]).to.equal(SYMBOL)
  })

  it('the reported case: closed at the hand close’s price and fee, not “profit unknown”', async () => {
    const bot = buildBot()
    await bot.settleFromVenueFills(DEAL_ID)()
    expect(bot.calls.closeDeal).to.have.length(1)
    const args = bot.calls.closeDeal[0]
    expect(args[1]).to.equal(DEAL_ID)
    expect(args[3], 'priced from the closing fills').to.be.closeTo(
      EXPECTED_PRICE,
      1e-12,
    )
    // Both closing fills reported their fee; the bot's entry fee is not added.
    expect(args[4]).to.be.closeTo(2.295 + 1.592, 1e-9)
    const saved = bot.calls.saved.find((u: any) => u.flags)
    expect(saved.flags).to.include(DCADealFlags.closedExternally)
    expect(saved.flags).to.not.include(DCADealFlags.profitUnknown)
    expect(saved.closeTrigger).to.equal(DCACloseTriggerEnum.manual)
    expect(bot.calls.events[0].description).to.not.contain('profit is unknown')
  })
})
