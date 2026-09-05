process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec 009 §2.1 / §2.2 / §2.3 (issue #658).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded shape of DCA deal 69f1b27faeba7a4880365abb (bot
 * 69de6e9e10716872ece23ce8, XAUTUSDT SHORT on paperBitgetUsdm, base order 0.02,
 * five multi-TP targets of 20 % each), and feeds its answers to the real
 * `shouldRearmTpTargets`. `createDCABotHelper` is a mixin factory, so the
 * helper is built on a minimal base class: no stack, DB, Redis or exchange
 * connection is needed.
 *
 * Run: npx ts-node -T src/bot/dca/multiTpCompletion.harness.ts
 */
import createDCABotHelper from '../dcaHelper'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, OrderSizeTypeEnum } from '../../../types'
import { shouldRearmTpTargets } from './multiTpCompletion'

/** The bot's five take-profit targets, as configured in production. */
const MULTI_TP = [
  { uuid: 't1', target: '1', amount: '20' },
  { uuid: 't2', target: '2', amount: '20' },
  { uuid: 't3', target: '3', amount: '20' },
  { uuid: 't4', target: '4', amount: '20' },
  { uuid: 't5', target: '5', amount: '20' },
]

const settings: any = {
  useMultiTp: true,
  multiTp: MULTI_TP,
  useMultiSl: false,
  multiSl: [],
  useTp: true,
  tpPerc: '1',
  slPerc: '5',
  baseOrderSize: '0.02',
  orderSizeType: OrderSizeTypeEnum.base,
  useFixedTPPrices: false,
  dealCloseCondition: 'perc',
  indicators: [],
  strategy: 'SHORT',
}

/** bitget USDT-M XAUTUSDT: two decimals on quantity and on price. */
const EXCHANGE_INFO: any = {
  symbol: 'XAUTUSDT',
  priceAssetPrecision: 2,
  baseAssetPrecision: 2,
  baseAsset: { minAmount: 0.01, step: 0.01, asset: 'XAUT' },
  quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
}

/** The deal's average entry price, as recorded in `paperFutures`. */
const AVG_PRICE = 4570.72

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  data: any = {
    settings,
    exchange: ExchangeEnum.paperBitgetUsdm,
    flags: [],
    strategy: 'SHORT',
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

type OrderRow = {
  qty: string
  executedQty: string
  typeOrder: string
  clientOrderId: string
  status: string
}

const Helper: any = createDCABotHelper(FakeBase as any)

class TestBot extends Helper {
  public futures = true
  public isLong = false
  public combo = false
  public coinm = false
  public kucoinSpot = false
  public zeroFee = false
  public tpAr = false
  public hedge = false
  public filledRows: OrderRow[] = []
  public dealDoc: any

  async getExchangeInfo() {
    return EXCHANGE_INFO
  }
  async getAggregatedSettings() {
    return settings
  }
  async getUserFee() {
    return { maker: 0.0004, taker: 0.0004 }
  }
  async baseAssetPrecision() {
    return 2
  }
  async getUsdRate() {
    return 1
  }
  async profitBase() {
    return false
  }
  getOrdersByStatusAndDealId({ status }: any) {
    const want = Array.isArray(status) ? status : [status]
    return this.filledRows.filter((r) => want.includes(r.status))
  }
  findBaseOrderByDeal() {
    return this.filledRows.find((r) => r.typeOrder === 'dealStart')
  }
  getDeal() {
    return this.dealDoc ? { deal: this.dealDoc, currentOrders: [] } : undefined
  }
  getPendingReduceFunds() {
    return { base: 0, quote: 0 }
  }
  getOrderId(prefix: string) {
    return `${prefix}-${this.filledRows.length}`
  }
  handleDebug() {}
  handleLog() {}
  handleErrors() {}
  getLatestPrice() {
    return 4525
  }
}

const deal = (tpSlTargetFilled: string[], tpFilledHistory: any[]) => ({
  _id: 'deal1',
  symbol: { symbol: 'XAUTUSDT' },
  size: 0.02,
  avgPrice: AVG_PRICE,
  lastPrice: AVG_PRICE,
  initialPrice: AVG_PRICE,
  settings,
  tpSlTargetFilled,
  tpFilledHistory,
  tpHistory: [],
  currentBalances: { base: 0.02, quote: 0 },
  initialBalances: { base: 0.02, quote: 91.41 },
  status: 'open',
})

const baseOrder: OrderRow = {
  qty: '0.02',
  executedQty: '0.02',
  typeOrder: 'dealStart',
  clientOrderId: 'BO',
  status: 'FILLED',
}

const tpRow = (i: number, qty: number): OrderRow => ({
  qty: `${qty}`,
  executedQty: `${qty}`,
  typeOrder: 'dealTP',
  clientOrderId: `TP${i}`,
  status: 'FILLED',
})

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
  }
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      expected ${JSON.stringify(
      expected,
    )}, got ${JSON.stringify(actual)}`,
  )
}

async function main() {
  const bot: any = new (TestBot as any)('bot', ExchangeEnum.paperBitgetUsdm)
  const tp = (d: any, aggregate = false) =>
    bot.getTPOrder(
      'XAUTUSDT',
      AVG_PRICE,
      [],
      AVG_PRICE,
      AVG_PRICE,
      'deal1',
      d,
      aggregate,
    )

  // §2.1 — five configured targets, two orders, the whole position armed.
  bot.filledRows = [baseOrder]
  bot.dealDoc = deal([], [])
  const armed = await tp(bot.dealDoc)
  check('§2.1 orders armed for 5 targets on a 0.02 position', armed?.length, 2)
  check(
    '§2.1 quantity armed covers the whole position',
    armed?.reduce((a: number, o: any) => a + o.qty, 0),
    0.02,
  )

  // §2.2 — one target filled: 0.01 is still open, the deal must stay open.
  const targets = armed.map((o: any) => o.tpSlTarget)
  bot.filledRows = [baseOrder, tpRow(0, 0.01)]
  bot.dealDoc = deal([targets[0]], [{ id: targets[0], price: 4521.39, qty: 0.01 }])
  const afterOne = (await tp(bot.dealDoc, true))?.[0]?.qty
  check('§2.2 remaining after one fill', afterOne, 0.01)
  check(
    '§1.1 the deal with 0.01 left keeps its targets armed',
    shouldRearmTpTargets({
      configuredTargets: MULTI_TP.length,
      filledTargets: 1,
      remainingQty: afterOne,
    }),
    true,
  )

  // §2.2/§2.3 — both servable targets filled: nothing is left to close.
  bot.filledRows = [baseOrder, tpRow(0, 0.01), tpRow(1, 0.01)]
  bot.dealDoc = deal(
    targets,
    armed.map((o: any) => ({ id: o.tpSlTarget, price: o.price, qty: o.qty })),
  )
  const afterBoth = (await tp(bot.dealDoc, true))?.[0]?.qty
  check('§2.2 remaining after both fills', afterBoth, 0)
  check(
    '§2.3 the engine still emits a take-profit for a target it cannot serve',
    (await tp(bot.dealDoc))?.length,
    1,
  )
  check(
    '§1.1 the deal with nothing left to close is finished (was: re-arm forever)',
    shouldRearmTpTargets({
      configuredTargets: MULTI_TP.length,
      filledTargets: 2,
      remainingQty: afterBoth,
    }),
    false,
  )
  console.log(
    `\nold completion test (total > filled): 5 > 2 = ${
      MULTI_TP.length > 2
    } -> re-arm forever`,
  )

  // End to end: drive the REAL processFilledOrder for the fill that empties the
  // position, and record which branch it takes.
  const drive = async (
    label: string,
    filledRows: OrderRow[],
    dealDoc: any,
    order: any,
  ) => {
    const calls: string[] = []
    bot.filledRows = filledRows
    bot.dealDoc = dealDoc
    bot.loadingComplete = true
    bot.processedFilled = new Map()
    bot.allowToPlaceOrders = new Set()
    bot.shouldProceed = () => true
    bot.setLastStreamData = () => {}
    bot.checkDealsMoveSL = async () => {}
    bot.updateDeal = async () => {
      calls.push('updateDeal (re-arm)')
    }
    bot.closeDeal = async () => {
      calls.push('closeDeal')
    }
    await bot.processFilledOrder(order)
    check(label, calls, ['closeDeal'])
  }

  await drive(
    'end to end: the fill that empties the position closes the deal',
    [baseOrder, tpRow(0, 0.01), tpRow(1, 0.01)],
    deal(
      [targets[0]],
      [{ id: targets[0], price: 4521.39, qty: 0.01 }],
    ),
    {
      botId: 'bot',
      dealId: 'deal1',
      clientOrderId: 'TP1',
      typeOrder: 'dealTP',
      tpSlTarget: targets[1],
      sl: false,
      symbol: 'XAUTUSDT',
      price: `${4475.72}`,
      executedQty: '0.01',
      updateTime: 1,
    },
  )
  console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
