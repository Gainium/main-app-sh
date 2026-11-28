process.env.NODE_ENV = 'testing'

/**
 * Spec 048 §3.5: a Combo reload never places more exit base than the deal's
 * position.
 *
 * Drives the REAL Combo `getDiffForCheckOrders` → `findDiffCombo` → `findDiff`
 * (the reconcile a user's start / reload and a service restart's
 * `checkOrders` place from). A reload loads the minigrids from the database
 * and `prepareMinigrids` regenerates their lines; a trim the last refill made
 * lived only in memory and is gone. The diff then places the untrimmed lines.
 *
 * Numbers from a futures long: position 0.34, lot step 0.01, the minigrid's
 * regenerated sells 0.18 @ 36.26 + 0.17 @ 41.7 (the refill had trimmed the
 * 36.26 sell to 0.17 before the reload). Fixture ids are synthetic — this
 * file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, TypeOrderEnum } from '../../../types'

const DEAL_ID = '000000000000000000000d48'
const BOT_ID = '000000000000000000000b48'
const MG_ID = '000000000000000000000a48'
const SYMBOL = 'SOXLUSDT'

let Helper: any

const line = (side: OrderSideEnum, price: number, qty: number, n: number) =>
  ({
    number: n,
    price,
    qty,
    side,
    newClientOrderId: `CMB-GR-new-${n}`,
    type: TypeOrderEnum.dealGrid,
    dealId: DEAL_ID,
    minigridId: MG_ID,
  }) as any

const buildBot = (opts: {
  isLong?: boolean
  futures?: boolean
  position: number
  lines: any[]
  resting?: any[]
}) => {
  const isLong = opts.isLong ?? true
  const futures = opts.futures ?? true
  const minigrid = {
    schema: {
      _id: MG_ID,
      dealId: DEAL_ID,
      botId: BOT_ID,
      status: 'active',
      symbol: { symbol: SYMBOL, baseAsset: 'SOXL', quoteAsset: 'USDT' },
    },
    initialGrids: [],
    currentOrders: opts.lines,
  }
  const initialBase = isLong ? 0 : opts.position
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      symbol: { symbol: SYMBOL, baseAsset: 'SOXL', quoteAsset: 'USDT' },
      settings: {},
      lastPrice: 35.74,
      initialBalances: { base: initialBase, quote: 100 },
      currentBalances: {
        base: isLong ? opts.position : 0,
        quote: 100,
      },
      fundsScale: [],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends (Helper as any) {
    botId = BOT_ID
    botType = 'combo'
    combo = true
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'bitgetUsdm',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>(
      (opts.resting ?? []).map((r) => [r.clientOrderId, r]),
    )
    get futures() {
      return futures
    }
    get coinm() {
      return false
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getMinigridByDealId() {
      return [minigrid]
    }
    getOrdersByStatusAndDealId({ status }: { status?: string | string[] }) {
      const statuses = status ? [status].flat() : undefined
      return [...this.orders.values()].filter(
        (o) => !statuses || statuses.includes(o.status),
      )
    }
    async getExchangeInfo() {
      return {
        baseAsset: { step: 0.01, minAmount: 0.01 },
        quoteAsset: { minAmount: 0 },
      }
    }
    async getAggregatedSettings() {
      return {}
    }
    async postUserNotice() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  const bot = new (TestBot as any)()
  // `isLong` is an instance field on the DCA base, so a getter cannot shadow it.
  bot.isLong = isLong
  return { bot, deal, minigrid }
}

const exitSum = (grids: any[], side: OrderSideEnum) =>
  +grids
    .filter((g) => g.side === side && g.type === TypeOrderEnum.dealGrid)
    .reduce((a, g) => a + g.qty, 0)
    .toFixed(8)

describe('a Combo reload places no more exit base than the position (spec 048 §3.5)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('../comboHelper').default()
  })

  it('§3.5.1 a futures long: lines 0.18 + 0.17 over a 0.34 position place 0.34', async () => {
    const { bot, deal } = buildBot({
      position: 0.34,
      lines: [
        line(OrderSideEnum.buy, 35.22, 0.17, 1),
        line(OrderSideEnum.sell, 36.26, 0.18, 2),
        line(OrderSideEnum.sell, 41.7, 0.17, 3),
      ],
    })
    const diff = await bot.getDiffForCheckOrders(deal, [])
    expect(exitSum(diff.new, OrderSideEnum.sell)).to.equal(0.34)
    // Prices, the entry line and the line count are unchanged.
    expect(
      diff.new.map((g: any) => [g.side, g.price]).sort(),
    ).to.deep.equal(
      [
        [OrderSideEnum.buy, 35.22],
        [OrderSideEnum.sell, 36.26],
        [OrderSideEnum.sell, 41.7],
      ].sort(),
    )
    expect(
      diff.new.find((g: any) => g.side === OrderSideEnum.buy).qty,
    ).to.equal(0.17)
  })

  it('§3.5.2 a ladder within the position is placed untouched', async () => {
    const { bot, deal } = buildBot({
      position: 0.35,
      lines: [
        line(OrderSideEnum.sell, 36.26, 0.18, 2),
        line(OrderSideEnum.sell, 41.7, 0.17, 3),
      ],
    })
    const diff = await bot.getDiffForCheckOrders(deal, [])
    expect(diff.new.map((g: any) => g.qty)).to.deep.equal([0.18, 0.17])
  })

  it('§3.5.3 a futures short: buy-backs held to the position', async () => {
    const { bot, deal } = buildBot({
      isLong: false,
      position: 0.34,
      lines: [
        line(OrderSideEnum.buy, 34.12, 0.18, 1),
        line(OrderSideEnum.buy, 33.01, 0.17, 2),
      ],
    })
    const diff = await bot.getDiffForCheckOrders(deal, [])
    expect(exitSum(diff.new, OrderSideEnum.buy)).to.equal(0.34)
  })

  it('§3.5.4 a spot short is not capped (its buy-backs are its profit)', async () => {
    const { bot, deal } = buildBot({
      isLong: false,
      futures: false,
      position: 0.34,
      lines: [
        line(OrderSideEnum.buy, 34.12, 0.18, 1),
        line(OrderSideEnum.buy, 33.01, 0.17, 2),
      ],
    })
    const diff = await bot.getDiffForCheckOrders(deal, [])
    expect(exitSum(diff.new, OrderSideEnum.buy)).to.equal(0.35)
  })
})
