process.env.NODE_ENV = 'testing'

/**
 * Spec 142 — trailing ignores price ticks older than the deal's latest fill.
 *
 * In a fast drop the price feed can lag the venue by seconds. A safety order
 * fills, pulls the average (and the take-profit line) down, and the next
 * lagging tick — a price from before that fill — reads as "above the take
 * profit". The trail armed on it, cancelled the remaining safety orders, fired
 * on the next lagging tick and the market close filled below the average.
 *
 * Fixtures mirror a long 25x USDT-perp deal: last safety fill 0.16239 at T,
 * take-profit line 0.1699, 0.1% trail, lagging ticks 0.1707 / 0.17011 stamped
 * about 12 s before T.
 *
 * Drives the REAL `processFilledOrder` (to record the fill) and the REAL
 * `checkTrailing` over a minimal base class: no stack, DB, Redis or exchange.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { isTickBeforeLatestFill } from './tickBeforeFill'
import {
  CloseConditionEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  TrailingModeEnum,
  TypeOrderEnum,
} from '../../../types'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b42'
const DEAL_ID = '000000000000000000000d42'
const SYMBOL = 'ARBUSDT'

const FILL_TIME = 1_700_000_025_097
const FILL_PRICE = 0.16239
const AVG = 0.16906
const ARMING_LINE = 0.1699
const TRAIL = 0.1

const SETTINGS = {
  useTp: true,
  useSl: false,
  trailingTp: true,
  trailingTpPerc: String(TRAIL),
  tpPerc: '0.5',
  dealCloseCondition: CloseConditionEnum.tp,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMultiTp: false,
  multiTp: [],
  useMultiSl: false,
  multiSl: [],
  useMinTP: false,
  moveSL: false,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u42'
  isLong = true
  futures = true
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    status: 'open',
    exchange: ExchangeEnum.bybitUsdm,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const makeDeal = (): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'ARB', quoteAsset: 'USDT' },
  status: DCADealStatusEnum.open,
  trailingMode: undefined,
  trailingLevel: 0,
  bestPrice: 0.1737,
  avgPrice: AVG,
  initialPrice: 0.1737,
  lastPrice: AVG,
  size: 6001.2,
  settings: {},
  tpSlTargetFilled: [],
})

const makeBot = () => {
  let stream: { price: number; time?: number } = { price: 0 }
  class TestBot extends Helper {
    allowedMethods = new Set(['checkTrailing'])
    loadingComplete = true
    processedFilled = new Map()
    ordersInBetweenUpdates = new Set<string>()
    dealsForTrailing = new Map([
      [
        DEAL_ID,
        {
          trailingTp: true,
          skipTp: false,
          trailingSl: false,
          skipSl: true,
          trailingTpPrice: ARMING_LINE,
        },
      ],
    ])
    full: any = { deal: makeDeal(), closeBySl: false, notCheckSl: false }
    triggered: number[] = []
    shouldProceed() {
      return true
    }
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    getLastStreamData() {
      return stream
    }
    async getAggregatedSettings() {
      return SETTINGS
    }
    /** Copy-on-write, like the real `saveDeal`. */
    async saveDeal(d: any, fields?: Record<string, unknown>) {
      if (fields) {
        this.full = { ...d, deal: { ...this.full.deal, ...fields } }
      }
    }
    async triggerTrailing(_id: string, price: number) {
      this.triggered.push(price)
    }
    async updateDeal() {}
    async startDeal() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  const bot = new TestBot() as any
  bot.fill = (time: number) =>
    bot.processFilledOrder({
      botId: BOT_ID,
      dealId: DEAL_ID,
      symbol: SYMBOL,
      clientOrderId: `D-RO-${time}`,
      typeOrder: TypeOrderEnum.dealRegular,
      status: 'FILLED',
      price: String(FILL_PRICE),
      updateTime: time,
    })
  bot.tick = async (price: number, time?: number) => {
    stream = { price, time }
    await bot.checkTrailing(BOT_ID, SYMBOL)
    return bot.full.deal
  }
  return bot
}

describe('spec 142 — trailing ignores ticks older than the latest fill', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.2 does not arm on a lagging tick stamped before the fill', async () => {
    const bot = makeBot()
    await bot.fill(FILL_TIME)

    const afterLag = await bot.tick(0.1707, FILL_TIME - 12_000)
    expect(afterLag.trailingMode).to.equal(undefined)
    expect(afterLag.trailingLevel).to.equal(0)
    expect(bot.triggered).to.deep.equal([])

    const stillLagging = await bot.tick(0.17011, FILL_TIME - 11_400)
    expect(stillLagging.trailingMode).to.equal(undefined)
    expect(bot.triggered).to.deep.equal([])
  })

  it('§4.3 a live tick after the fill below the line does not arm', async () => {
    const bot = makeBot()
    await bot.fill(FILL_TIME)
    const live = await bot.tick(0.16226, FILL_TIME + 1_000)
    expect(live.trailingMode).to.equal(undefined)
  })

  it('§4.3 a live tick after the fill above the line arms as before', async () => {
    const bot = makeBot()
    await bot.fill(FILL_TIME)
    const armed = await bot.tick(0.1707, FILL_TIME + 1_000)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
    expect(armed.trailingLevel).to.be.closeTo(0.1707 * (1 - TRAIL / 100), 1e-9)
    expect(bot.triggered).to.deep.equal([0.1707])
  })

  it('§4.3 a tick at exactly the fill time is not "before" it', async () => {
    const bot = makeBot()
    await bot.fill(FILL_TIME)
    const armed = await bot.tick(0.1707, FILL_TIME)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
  })

  it('§1.3 with no recorded fill the old-stamped tick behaves as today', async () => {
    const bot = makeBot()
    const armed = await bot.tick(0.1707, FILL_TIME - 12_000)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
  })

  it('§4.1 keeps the latest fill when an older fill is processed late', async () => {
    const bot = makeBot()
    await bot.fill(FILL_TIME)
    await bot.fill(FILL_TIME - 5_000)
    expect(bot.latestDealFillTime.get(DEAL_ID)).to.equal(FILL_TIME)
  })
})

describe('spec 142 — isTickBeforeLatestFill', () => {
  it('is true only for a finite tick time strictly before a finite fill', () => {
    expect(isTickBeforeLatestFill(1, 2)).to.equal(true)
    expect(isTickBeforeLatestFill(2, 2)).to.equal(false)
    expect(isTickBeforeLatestFill(3, 2)).to.equal(false)
    expect(isTickBeforeLatestFill(1, undefined)).to.equal(false)
    expect(isTickBeforeLatestFill(undefined, 2)).to.equal(false)
    expect(isTickBeforeLatestFill(NaN, 2)).to.equal(false)
  })
})
