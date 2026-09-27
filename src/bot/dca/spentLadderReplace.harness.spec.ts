process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `115` — once every configured safety order of a
 * DCA deal has filled, rebuilding the deal's orders (a deal-settings edit)
 * must not place a safety order again.
 *
 * Shape of the reproduction (prod, 2026-09-27): a SHORT spot deal, TIA-USDT,
 * `ordersCount: 6`, all six safety sells FILLED, the last at 0.4925. The user
 * edited the deal's TP; `updateDealSettings` rebuilt the ladder, which put
 * level 6 one tick away at 0.4926, and ran `createCurrentDealOrders @ 0.4925`
 * (the deal's `lastPrice`). With `left === 0` the method took its "no count"
 * branch, kept every level on the far side of the price, and a 209.72 TIA
 * sell was sent again — refused for balance, bot left in error.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places anything — `placeOrders` is a recorder.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum, OrderSideEnum } from '../../../types'
import { createRequire } from 'module'

const DEAL_ID = '6aaa4e6b4569030e99219809'

type Fixture = {
  isLong: boolean
  symbol: string
  entry: number
  /** The ladder as `createInitialDealOrders` rebuilds it on the edit. */
  ladder: { price: number; qty: number }[]
  /** Where each level actually filled — the last one a tick off the rebuild. */
  fills: number[]
  lastPrice: number
}

const SHORT: Fixture = {
  isLong: false,
  symbol: 'TIAUSDT',
  entry: 0.4,
  ladder: [
    { price: 0.42, qty: 12.5 },
    { price: 0.44, qty: 25 },
    { price: 0.455, qty: 50 },
    { price: 0.47, qty: 100 },
    { price: 0.48, qty: 150 },
    { price: 0.4926, qty: 209.72 },
  ],
  fills: [0.42, 0.44, 0.455, 0.47, 0.48, 0.4925],
  lastPrice: 0.4925,
}

const LONG: Fixture = {
  isLong: true,
  symbol: 'ETHUSDT',
  entry: 2480.02,
  ladder: [
    { price: 2455.22, qty: 0.0081 },
    { price: 2430.42, qty: 0.0165 },
    { price: 2405.62, qty: 0.0333 },
    { price: 2390.1, qty: 0.05 },
    { price: 2385.5, qty: 0.06 },
    { price: 2380.81, qty: 0.0672 },
  ],
  fills: [2455.22, 2430.42, 2405.62, 2390.1, 2385.5, 2380.82],
  lastPrice: 2380.82,
}

const settings: any = {
  dcaCondition: 'percentage',
  ordersCount: 6,
  activeOrdersCount: 6,
  useSmartOrders: false,
  useDca: true,
  dcaCustom: [],
  indicators: [],
  useTp: true,
  tpPerc: '1.05',
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  trailingTp: false,
  trailingSl: false,
  useMultiTp: false,
  multiTp: [],
  useSl: false,
  useMultiSl: false,
  multiSl: [],
  slPerc: '-10',
  moveSL: false,
}

const initialOrders = (f: Fixture): any[] =>
  f.ladder.map((l, i) => ({
    number: i + 1,
    price: l.price,
    qty: l.qty,
    side: f.isLong ? OrderSideEnum.buy : OrderSideEnum.sell,
    newClientOrderId: `D-RO-level${i + 1}`,
    type: TypeOrderEnum.dealRegular,
    dealId: DEAL_ID,
    dcaLevel: i + 1,
  }))

/** The base order plus the first `filled` safety orders, FILLED. */
const filledRows = (f: Fixture, filled: number): any[] => [
  {
    clientOrderId: 'D-BO-base',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    status: 'FILLED',
    price: `${f.entry}`,
    side: f.isLong ? 'BUY' : 'SELL',
  },
  ...f.fills.slice(0, filled).map((p, i) => ({
    clientOrderId: `D-RO-filled${i + 1}`,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    status: 'FILLED',
    origQty: `${f.ladder[i].qty}`,
    executedQty: `${f.ladder[i].qty}`,
    price: `${p}`,
    side: f.isLong ? 'BUY' : 'SELL',
  })),
]

const deal = (f: Fixture, filled: number): any => ({
  _id: DEAL_ID,
  symbol: { symbol: f.symbol, baseAsset: 'X', quoteAsset: 'USDT' },
  status: 'open',
  levels: { all: 7, complete: 1 + filled },
  funds: [],
  pendingAddFunds: [],
  reduceFunds: [],
  flags: [],
  initialPrice: f.entry,
  lastPrice: f.lastPrice,
  avgPrice: f.entry,
  settings: { ...settings, avgPrice: f.entry },
  tpSlTargetFilled: [],
  dynamicAr: [],
})

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  futures = false
  coinm = false
  combo = false
  hedge = false
  orders = new Map()
  data: any = {
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (f: Fixture, filled: number) => {
  const rows = filledRows(f, filled)
  const findDeal: any = {
    deal: deal(f, filled),
    initialOrders: initialOrders(f),
    currentOrders: [],
  }
  class TestBot extends Helper {
    public placed: any[][] = []
    public errors: string[] = []
    isLong = f.isLong
    getDeal(id: string) {
      return id === DEAL_ID ? findDeal : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      dealId,
      defaultStatuses,
    }: {
      status?: string | string[]
      dealId?: string
      defaultStatuses?: boolean
    }) {
      const wanted = defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : status
          ? [status].flat()
          : undefined
      return rows.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return { priceAssetPrecision: 4 }
    }
    async getLatestPrice() {
      return f.lastPrice
    }
    /** The TP is appended after the safety-order selection this suite pins. */
    async getTPOrder() {
      return []
    }
    async createInitialDealOrders() {
      return initialOrders(f)
    }
    getDealInitialOrders() {
      return initialOrders(f)
    }
    async cancelAllOrder() {}
    async getCommDeal() {
      return 0
    }
    updateDealBalances() {}
    saveDeal() {
      return new Promise(() => undefined)
    }
    /** `MainBot.findDiff` against an empty book: everything is new. */
    findDiff(newGrids: any[] | null) {
      return { new: newGrids ?? [], cancel: [] }
    }
    async placeOrders(_b: string, _s: string, _d: string, diff: any) {
      this.placed.push(diff.new)
    }
    resendPendingFunds() {}
    async afterDealUpdate() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: any) {
      this.errors.push(typeof m === 'string' ? m : m?.message)
    }
  }
  return new TestBot()
}

const currentSafetyPrices = async (f: Fixture, filled: number) => {
  const bot: any = buildBot(f, filled)
  const current = await bot.createCurrentDealOrders(
    f.symbol,
    f.lastPrice,
    initialOrders(f),
    f.entry,
    f.entry,
    DEAL_ID,
    false,
    deal(f, filled),
  )
  return current
    .filter((o: any) => o.type === TypeOrderEnum.dealRegular)
    .map((o: any) => o.price)
}

describe('a spent DCA ladder is not placed again (spec 115)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  for (const [name, f] of [
    ['SHORT', SHORT],
    ['LONG', LONG],
  ] as const) {
    describe(name, () => {
      it('§1.1 all levels FILLED: createCurrentDealOrders keeps no safety order', async () => {
        expect(await currentSafetyPrices(f, 6)).to.deep.equal([])
      })

      it('§1.1 all levels FILLED: updateDealSettings({tpPerc, trailingTp}) places no safety order', async () => {
        const bot: any = buildBot(f, 6)
        await bot.updateDealSettings(DEAL_ID, {
          tpPerc: '25',
          trailingTp: true,
          trailingTpPerc: '0.3',
        })
        expect(bot.placed).to.have.length(1)
        expect(
          bot.placed[0].filter(
            (o: any) => o.type === TypeOrderEnum.dealRegular,
          ),
        ).to.deep.equal([])
      })

      it('§4.2 control: one level unfilled is still placed', async () => {
        const f5 = { ...f, lastPrice: f.fills[4] }
        expect(await currentSafetyPrices(f5, 5)).to.deep.equal([
          f.ladder[5].price,
        ])
      })
    })
  }
})
