process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `139.single-position-per-pair`.
 *
 * Drives the REAL engine methods (`openNewDeal`, `addPositionEntry`,
 * `checkInDynamicRange`, `updateDeal`'s add-funds branch, `adoptDeals`,
 * `mergeDeals`) off the mixin prototype (`Object.create`, as
 * `mergedDeals.harness.spec.ts` does), the REAL `Bot.changeDCABot` /
 * `Bot.prepareDCABot`, the REAL v2 update check and the REAL read-side stats
 * folds. No Mongo, Redis, venue or bot stack; collaborators are stubs that
 * record what they are asked.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, afterEach, before, after } from 'mocha'
import { expect } from 'chai'
import createDCABotHelper from '../dcaHelper'
import MainBot from '../main'
import Bot from '../index'
import { ConditionLatch } from '../conditionLatch'
import { MathHelper } from '../../utils/math'
import { checkDCABotSettings } from '../utils'
import { foldBotWindowStats } from '../botWindowStats'
import { peakCapitalBySymbol } from '../pairStats'
import {
  maxPositionEntriesOf,
  pairsWithSeveralOpenDeals,
  planPositionsByPair,
  positionEntriesOf,
  SINGLE_POSITION_ASAP_SPACING_REASON,
  SINGLE_POSITION_CLOSE_AFTER_OPENED_REASON,
  SINGLE_POSITION_MULTIPLE_OPEN_PREFIX,
  SINGLE_POSITION_START_BOT_REASON,
  singlePositionSettingsError,
} from './singlePosition'
import DCABacktesting from '@gainium/backtester/dist/dca'
import { StrategyContextManager } from '@gainium/backtester/dist/dca/strategy/context'
import { DCAOrderTypeEnum } from '@gainium/backtester/dist/types'
import type {
  DCABacktestingResult,
  FullBar,
  Symbols,
} from '@gainium/backtester/dist/types'
import { dcaBacktesterInput } from '../../backtest/process/backtestWrapper/dcaInput'
import {
  BotStatusEnum,
  CooldownUnits,
  DCADealStatusEnum,
  DynamicPriceFilterDirectionEnum,
  DynamicPriceFilterPriceTypeEnum,
  ExchangeEnum,
  StartConditionEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const BOT_ID = '000000000000000000000b39'
const OTHER_BOT = '000000000000000000000b40'
const USER_ID = '000000000000000000000a39'
const POSITION = '000000000000000000000d01'
const DEAL_B = '000000000000000000000d02'
const DEAL_C = '000000000000000000000d03'
const SYMBOL = 'BTCUSDT'

const ok = <T>(result: T) => ({
  status: StatusEnum.ok,
  reason: null,
  data: { result },
})

/** Settings a valid ASAP single-position bot runs with. */
const spSettings = (over: Record<string, unknown> = {}) => ({
  name: 'sp',
  pair: [SYMBOL],
  strategy: 'LONG',
  startCondition: StartConditionEnum.asap,
  singlePosition: true,
  useDynamicPriceFilter: true,
  dynamicPriceFilterDeviation: '2',
  maxNumberOfOpenDeals: '1',
  useDca: true,
  ordersCount: 5,
  type: 'regular',
  ...over,
})

const fullDeal = (id: string, over: Record<string, unknown> = {}): any => ({
  deal: {
    _id: id,
    botId: BOT_ID,
    userId: USER_ID,
    status: DCADealStatusEnum.open,
    strategy: 'LONG',
    symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
    createTime: 1_000,
    positionEntries: 1,
    profit: { total: 0, totalUsd: 0 },
    settings: { useDca: false, avgPrice: 100 },
    levels: { all: 1, complete: 1 },
    initialBalances: { base: 0, quote: 100 },
    currentBalances: { base: 1, quote: 0 },
    funds: [],
    pendingAddFunds: [],
    tpHistory: [],
    lastPrice: 100,
    avgPrice: 100,
    initialPrice: 100,
    ...over,
  },
  initialOrders: [],
  currentOrders: [],
  previousOrders: [],
  closeBySl: false,
  notCheckSl: false,
  closeByTp: false,
})

/** A DCA helper instance off the prototype, with the engine's I/O stubbed. */
const helper = (settings: Record<string, unknown> = spSettings()) => {
  const Helper: any = createDCABotHelper(MainBot as any)
  const bot: any = Object.create(Helper.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = 'dca'
  for (const [k, v] of [
    ['combo', false],
    ['futures', false],
    ['coinm', false],
    ['isLong', true],
    ['hedge', false],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }
  bot.data = {
    status: BotStatusEnum.open,
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'u',
    paperContext: true,
    settings,
    lastPricesPerSymbol: [],
  }
  bot.loadingComplete = true
  bot.pairs = new Set([SYMBOL])
  bot.openNewDealTimer = new Map()
  bot.dealUpdateOrders = new Map()
  bot.ordersInBetweenUpdates = new Set()
  bot.allowedMethods = new Set([
    'checkInDynamicRange',
    'sendMaxDealsReachedAlert',
  ])
  bot.standingConditionLatch = new ConditionLatch(24 * 3600 * 1000)
  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = (reason: string) => ({ status: 'NOTOK', reason })
  bot.shouldProceed = () => true
  bot.updateData = () => undefined
  bot.emit = () => undefined
  bot.getAggregatedSettings = async () => bot.data.settings
  bot.getLatestPrice = async () => 100
  bot.getOrdersByStatusAndDealId = () => []
  bot.getOrderFromMap = () => undefined
  bot.botEventDb = { createData: () => undefined }
  return bot
}

/** The gates of `addPositionEntry`, all passing; each test flips one. */
const entryGates = (bot: any) => {
  const calls = {
    addDealFunds: [] as any[],
    newDeal: 0,
    reported: [] as unknown[][],
    approval: [] as any[],
    checkMaxDeals: 0,
  }
  bot.checkInRange = async () => true
  bot.checkBalanceGate = async () => ({ status: true })
  bot.checkCooldownStart = async () => ({ status: true })
  bot.checkCooldownStop = async () => ({ status: true })
  bot.refuseDealBelowExchangeMin = async () => false
  bot.approveNewDeal = async (ctx: unknown) => {
    calls.approval.push(ctx)
    return true
  }
  bot.getBaseOrder = async () => ({
    origQty: '0.5',
    price: '100',
    type: 'MARKET',
  })
  bot.addDealFunds = async (...args: unknown[]) => {
    calls.addDealFunds.push(args)
  }
  bot.openNewDealBody = async () => {
    calls.newDeal += 1
  }
  bot.checkMaxDeals = async () => {
    calls.checkMaxDeals += 1
    return true
  }
  bot.reportMaxDealsReached = (...args: unknown[]) => {
    calls.reported.push(args)
  }
  return calls
}

describe('spec 139 §2 / §7 — the pure rules', () => {
  it('§7.1 ASAP needs a dynamic filter with a deviation or a start cooldown', () => {
    const asap = {
      singlePosition: true,
      startCondition: StartConditionEnum.asap,
    }
    expect(singlePositionSettingsError(asap)).to.equal(
      SINGLE_POSITION_ASAP_SPACING_REASON,
    )
    expect(
      singlePositionSettingsError({ ...asap, useDynamicPriceFilter: true }),
      'a filter with no deviation does not space entries',
    ).to.equal(SINGLE_POSITION_ASAP_SPACING_REASON)
    expect(
      singlePositionSettingsError({
        ...asap,
        useDynamicPriceFilter: true,
        dynamicPriceFilterUnderValue: '5',
      }),
      'over / under without the deviation leaves the engine filter unarmed',
    ).to.equal(SINGLE_POSITION_ASAP_SPACING_REASON)
    expect(
      singlePositionSettingsError({
        ...asap,
        useDynamicPriceFilter: true,
        dynamicPriceFilterDeviation: '1',
      }),
    ).to.equal(null)
    expect(
      singlePositionSettingsError({
        ...asap,
        useCooldown: true,
        cooldownAfterDealStart: true,
        cooldownAfterDealStartInterval: 5,
        cooldownAfterDealStartUnits: CooldownUnits.minutes,
      }),
    ).to.equal(null)
  })

  it('§7.4 other start conditions have no requirement; off is never refused', () => {
    expect(
      singlePositionSettingsError({
        singlePosition: true,
        startCondition: StartConditionEnum.ti,
      }),
    ).to.equal(null)
    expect(
      singlePositionSettingsError({
        singlePosition: false,
        startCondition: StartConditionEnum.asap,
      }),
    ).to.equal(null)
  })

  it('§2.3.3 close after X deals opened is refused', () => {
    expect(
      singlePositionSettingsError({
        singlePosition: true,
        startCondition: StartConditionEnum.ti,
        useBotController: true,
        useCloseAfterXopen: true,
      }),
    ).to.equal(SINGLE_POSITION_CLOSE_AFTER_OPENED_REASON)
  })

  it('§2.2 maxPositionEntries is a string; empty / 0 / garbage = no limit', () => {
    expect(maxPositionEntriesOf('3')).to.equal(3)
    for (const v of ['', '0', undefined, 'x', '-2']) {
      expect(maxPositionEntriesOf(v), `${v}`).to.equal(0)
    }
    expect(positionEntriesOf({})).to.equal(1)
  })

  it('§5.1 one position per pair: the oldest deal is the target', () => {
    const deals = [
      { _id: 'c', createTime: 3, symbol: { symbol: 'A' } },
      { _id: 'a', createTime: 1, symbol: { symbol: 'A' } },
      { _id: 'x', createTime: 2, symbol: { symbol: 'B' } },
    ]
    const plans = planPositionsByPair(deals)
    const a = plans.find((p) => p.symbol === 'A')!
    expect(a.target._id).to.equal('a')
    expect(a.sources.map((s) => s._id)).to.deep.equal(['c'])
    expect(plans.find((p) => p.symbol === 'B')!.sources).to.have.length(0)
    expect(pairsWithSeveralOpenDeals(deals)).to.deep.equal(['A'])
  })
})

describe('spec 139 §8 — a server-side backtest simulates single position', () => {
  const HOUR = 3600e3
  const FROM = Date.UTC(2026, 0, 1)
  const PAIR = 'AAA_USDT'
  const symbol: Symbols = {
    pair: PAIR,
    exchange: ExchangeEnum.binance,
    baseAsset: { name: 'AAA', minAmount: 0.0001, maxAmount: 1e9, step: 0.0001 },
    quoteAsset: { name: 'USDT', minAmount: 1 },
    maxOrders: 200,
    priceAssetPrecision: 4,
  } as Symbols
  // A falling-then-recovering market: an ASAP position takes entries on
  // the way down (cooldown-spaced) and closes on the way back up.
  const bars: FullBar[] = Array.from({ length: 120 }, (_, i) => {
    const p = (k: number) => 100 + 10 * Math.sin(k / 15) - k * 0.02
    const open = p(i - 1)
    const close = p(i)
    return {
      time: FROM + i * HOUR,
      open,
      close,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      volume: 1000,
      symbol: PAIR,
    }
  })
  /** A request's `payload.data` as the dashboard / v2 API send it. */
  const requestData = (over: Record<string, unknown> = {}): any => ({
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'u',
    interval: '1h',
    userFee: 0.001,
    balances: [{ asset: 'USDT', free: '1000000', locked: '0' }],
    from: FROM,
    to: FROM + bars.length * HOUR,
    combo: false,
    fullResult: true,
    settings: {
      name: 'sp',
      pair: [PAIR],
      strategy: 'LONG',
      futures: false,
      coinm: false,
      leverage: 1,
      profitCurrency: 'quote',
      orderSizeType: 'quote',
      orderFixedIn: 'quote',
      baseOrderSize: '100',
      orderSize: '100',
      startOrderType: 'MARKET',
      startCondition: StartConditionEnum.asap,
      dcaCondition: 'percentage',
      useDca: true,
      ordersCount: 4,
      activeOrdersCount: 4,
      step: '1.5',
      stepScale: '1.2',
      volumeScale: '1.3',
      minimumDeviation: '0',
      useTp: true,
      tpPerc: '2',
      useSl: false,
      dealCloseCondition: 'tp',
      dealCloseConditionSL: 'tp',
      closeDealType: 'closeByMarket',
      maxNumberOfOpenDeals: '1',
      maxDealsPerPair: '1',
      indicators: [],
      indicatorGroups: [],
      useCooldown: true,
      cooldownAfterDealStart: true,
      cooldownAfterDealStartInterval: 3,
      cooldownAfterDealStartUnits: CooldownUnits.hours,
      singlePosition: true,
      maxPositionEntries: '3',
      ...over,
    },
  })
  const prices = [{ symbol: PAIR, price: 100 }]
  let runNo = 0
  const backtest = async (data: any) => {
    StrategyContextManager.setActiveContext(`core-single-position-${++runNo}`)
    // `useFile` reads bars back from a CSV the worker's loader writes; this
    // run hands the bars in directly.
    const bt = new DCABacktesting({
      ...dcaBacktesterInput(data, prices, [symbol]),
      useFile: false,
    })
    return (await bt.test([
      { bar: bars, interval: '1h' as any },
    ])) as DCABacktestingResult
  }

  it('§8.1 the worker hands the backtester singlePosition and maxPositionEntries', () => {
    const input = dcaBacktesterInput(requestData(), prices, [symbol])
    expect(input.settings).to.include({
      singlePosition: true,
      maxPositionEntries: '3',
    })
    expect(input.symbols).to.deep.equal([symbol])
    expect(input.prices).to.deep.equal(prices)
  })

  it('§8.2 the backtest runs: one position per pair, entries, no safety orders', async () => {
    const r = await backtest(requestData())
    expect(r.deals.length).to.be.greaterThan(0)
    const sorted = [...r.deals].sort((a, b) => a.startTime - b.startTime)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startTime).to.be.at.least(
        sorted[i - 1].closedTime as number,
      )
    }
    const entries = r.deals.map((d) => d.positionEntries ?? 0)
    expect(Math.max(...entries), 'a position took entries').to.be.greaterThan(1)
    expect(
      Math.max(...entries),
      'maxPositionEntries caps a position',
    ).to.be.at.most(3)
    for (const d of r.deals) {
      expect(
        d.filledOrders.filter((o) => o.type === DCAOrderTypeEnum.dca),
        'safety orders are off',
      ).to.have.length(0)
    }
  })

  it('§8.2 the same bot without the setting runs as before', async () => {
    const r = await backtest(
      requestData({ singlePosition: false, maxPositionEntries: undefined }),
    )
    expect(r.deals.length).to.be.greaterThan(0)
    expect(r.deals.every((d) => (d.positionEntries ?? 1) <= 1)).to.equal(true)
  })
})

describe('spec 139 §3.1 — every start path on a held pair is an entry', () => {
  it('a pair with an open position gets an entry, never a second deal', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    const position = fullDeal(POSITION)
    bot.getOpenDeals = () => [position]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.newDeal).to.equal(0)
    expect(
      calls.checkMaxDeals,
      '§3.2.1 the deal limit is not consulted',
    ).to.equal(0)
    expect(calls.addDealFunds).to.have.length(1)
    const [, dealId, settings] = calls.addDealFunds[0]
    expect(dealId).to.equal(POSITION)
    expect(settings).to.include({
      qty: '0.5',
      positionEntry: true,
      useLimitPrice: false,
    })
  })

  it('"+ New deal" (openNewDealMan) routes through the same invariant', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDealMan(SYMBOL)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.newDeal).to.equal(0)
    expect(calls.addDealFunds).to.have.length(1)
  })

  it('a pair with no position opens a deal as before', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => []
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.newDeal).to.equal(1)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('two concurrent signals on an empty pair open one deal', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => []
    let release: () => void = () => undefined
    bot.openNewDealBody = async () => {
      calls.newDeal += 1
      await new Promise<void>((r) => (release = r))
    }
    const first = bot.openNewDeal(BOT_ID, SYMBOL)
    await new Promise((r) => setTimeout(r, 0))
    await bot.openNewDeal(BOT_ID, SYMBOL)
    release()
    await first
    expect(calls.newDeal).to.equal(1)
  })

  it('a bot without the setting is untouched', async () => {
    const bot = helper(spSettings({ singlePosition: false }))
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.newDeal).to.equal(1)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('combo and hedge legs ignore the setting', () => {
    const combo = helper()
    Object.defineProperty(combo, 'combo', { value: true })
    expect(combo.singlePositionActive).to.equal(false)
    const leg = helper()
    leg.data.parentBotId = OTHER_BOT
    expect(leg.singlePositionActive).to.equal(false)
    expect(helper().singlePositionActive).to.equal(true)
  })
})

describe('spec 139 §3.2 — the gates of an entry', () => {
  it('§3.2.2 a full position refuses through the max-deals latch, scope entries', async () => {
    const bot = helper(spSettings({ maxPositionEntries: '3' }))
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [fullDeal(POSITION, { positionEntries: 3 })]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
    expect(calls.reported).to.deep.equal([['entries', SYMBOL, 3, 3]])
  })

  it('§3.2.2 the latch reports a full position once', () => {
    const bot = helper()
    const sent: unknown[] = []
    bot.sendMaxDealsReachedAlert = async (...a: unknown[]) => {
      sent.push(a)
    }
    bot.asapMaxDealsLatch = new ConditionLatch(0)
    bot.reportMaxDealsReached('entries', SYMBOL, 3, 3)
    bot.reportMaxDealsReached('entries', SYMBOL, 3, 3)
    expect(sent).to.deep.equal([['entries', SYMBOL, 3, 3]])
  })

  it('§3.2.3 / §3.2.4 a price filter refusal adds nothing', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.checkInRange = async () => false
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('§3.2.5 a start cooldown refuses and re-arms an ASAP bot', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.checkCooldownStart = async () => ({
      status: false,
      last: Date.now(),
      cooldown: 60_000,
    })
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
    expect(bot.openNewDealTimer.has(SYMBOL)).to.equal(true)
    clearTimeout(bot.openNewDealTimer.get(SYMBOL))
  })

  it('§3.2.6 a balance shortfall refuses the entry', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.checkBalanceGate = async () => ({
      status: false,
      required: 50,
      available: 1,
    })
    bot.reduceToAvailableRatio = async () => ({ ratio: null })
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('§3.2.6 an entry below the exchange minimum is refused', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.refuseDealBelowExchangeMin = async () => true
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('§3.2.7 approval hooks see an entry into the position', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.approval[0]).to.include({
      entry: true,
      dealId: POSITION,
      symbol: SYMBOL,
    })
    bot.approveNewDeal = async () => false
    calls.addDealFunds.length = 0
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
  })

  it('§3.2.8 a bot in monitoring adds no entry from a start signal', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.data.status = BotStatusEnum.monitoring
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    let notOpened = 0
    await bot.openNewDeal(BOT_ID, SYMBOL, false, false, 0, () => {
      notOpened += 1
    })
    expect(calls.addDealFunds).to.have.length(0)
    expect(calls.newDeal).to.equal(0)
    expect(notOpened).to.equal(1)
    expect(calls.reported, 'no "position full" report either').to.have.length(0)
  })

  it('§3.2.8 the same rule as a new deal: refused on an empty pair too, a manual start passes both', async () => {
    // Empty pair: the real `openNewDealBody` refuses a monitoring bot.
    const empty = helper()
    entryGates(empty)
    delete empty.openNewDealBody
    empty.data.status = BotStatusEnum.monitoring
    empty.getOpenDeals = () => []
    let notOpened = 0
    await empty.openNewDeal(BOT_ID, SYMBOL, false, false, 0, () => {
      notOpened += 1
    })
    expect(notOpened).to.equal(1)
    // "+ New deal" (`skip`) opens a deal in monitoring, so it adds an entry.
    const bot = helper()
    const calls = entryGates(bot)
    bot.data.status = BotStatusEnum.monitoring
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDealMan(SYMBOL)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.addDealFunds).to.have.length(1)
  })

  it('§3.3 a limit base order makes a limit entry', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getBaseOrder = async () => ({
      origQty: '0.5',
      price: '99',
      type: 'LIMIT',
    })
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds[0][2]).to.include({
      useLimitPrice: true,
      limitPrice: '99',
    })
  })

  it('§3.2.4 the dynamic filter measures from the last entry, not the average', async () => {
    const run = async (singlePosition: boolean) => {
      const bot = helper(
        spSettings({
          singlePosition,
          dynamicPriceFilterDeviation: '5',
          dynamicPriceFilterDirection: DynamicPriceFilterDirectionEnum.under,
          dynamicPriceFilterPriceType: DynamicPriceFilterPriceTypeEnum.avg,
        }),
      )
      bot.getDealsByStatusAndSymbol = () => []
      bot.data.lastPricesPerSymbol = [
        { symbol: SYMBOL, avg: 100, entry: 90, time: 5 },
      ]
      return bot.checkInDynamicRange(SYMBOL, 94)
    }
    // The average (100) would let 94 in (< 95); the last entry (90) does not
    // (94 is not < 85.5).
    expect(await run(false)).to.equal(true)
    expect(await run(true)).to.equal(false)
  })
})

describe('spec 139 §3.5 — one entry in flight per position', () => {
  it('a resting entry skips the next signal, unreported', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [
      fullDeal(POSITION, {
        pendingAddFunds: [{ id: 'p', qty: '1', positionEntry: true }],
      }),
    ]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
    expect(calls.reported).to.have.length(0)
  })

  it('a filled entry not booked yet skips; once booked it does not', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    const order = { clientOrderId: 'E1', status: 'FILLED', positionEntry: true }
    bot.getOrderFromMap = (id: string) => (id === 'E1' ? order : undefined)
    bot.notePositionEntrySent(POSITION, 'E1')
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
    bot.dealUpdateOrders.set(POSITION, new Set(['E1']))
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(1)
  })

  it('a position whose base order has not filled is in flight', async () => {
    const bot = helper()
    const calls = entryGates(bot)
    bot.getOpenDeals = () => [
      fullDeal(POSITION, { status: DCADealStatusEnum.start }),
    ]
    await bot.openNewDeal(BOT_ID, SYMBOL)
    expect(calls.addDealFunds).to.have.length(0)
    expect(calls.newDeal).to.equal(0)
  })
})

describe('spec 139 §3.4 — an entry fill', () => {
  it('counts the entry, re-bases the trail, moves the filter reference and cooldown', async () => {
    const bot = helper()
    const position = fullDeal(POSITION, {
      pendingAddFunds: [{ id: 'af1', qty: '0.5', positionEntry: true }],
      bestPrice: 120,
    })
    const saved: any[] = []
    const lastPrices: any[] = []
    const lastTime: any[] = []
    let armed = 0
    let tpRebuilt = 0
    bot.orders = new Map()
    bot.getDeal = () => position
    bot.computeObservedFeeLedger = async () => null
    bot.getAvgPrice = async () => ({ avg: 95, display: 95 })
    bot.createCurrentDealOrders = async () => {
      tpRebuilt += 1
      return []
    }
    bot.updateDealBalances = async () => undefined
    bot.checkDealSlMethods = async () => undefined
    bot.checkDealsPriceExtremum = () => undefined
    bot.carryStopLossLatches = () => undefined
    bot.saveDeal = (_d: unknown, patch: unknown) => {
      saved.push(patch)
      return Promise.resolve()
    }
    bot.updateUsage = () => undefined
    bot.updateAssets = () => undefined
    bot.updateDealLastPrices = (_b: string, override?: unknown) => {
      if (override) {
        lastPrices.push(override)
      }
    }
    bot.updateDealLastTime = (...a: unknown[]) => lastTime.push(a)
    bot.placeOrders = () => undefined
    bot.findDiff = () => []
    bot.armNextPositionEntry = () => {
      armed += 1
    }
    await bot.updateDeal(BOT_ID, {
      clientOrderId: 'E1',
      dealId: POSITION,
      symbol: SYMBOL,
      price: '90',
      executedQty: '0.5',
      side: 'BUY',
      typeOrder: TypeOrderEnum.dealRegular,
      addFundsId: 'af1',
      positionEntry: true,
      updateTime: 10,
    })
    expect(position.deal.positionEntries).to.equal(2)
    expect(position.deal.bestPrice).to.equal(0)
    expect(saved).to.deep.include({ positionEntries: 2, bestPrice: 0 })
    expect(lastPrices[0]).to.include({ symbol: SYMBOL, entry: 90, avg: 90 })
    expect(lastTime[0].slice(0, 2)).to.deep.equal([BOT_ID, 'opened'])
    expect(lastTime[0][3]).to.equal(SYMBOL)
    expect(tpRebuilt, '§3.4.4 the TP is rebuilt over the new size').to.equal(1)
    expect(armed).to.equal(1)
  })
})

describe('spec 139 §4 — adoption', () => {
  const originalClose = (Bot.prototype as any).closeDCADeal
  afterEach(() => {
    ;(Bot.prototype as any).closeDCADeal = originalClose
  })

  const adoptionBot = () => {
    const bot = helper()
    const log: string[] = []
    const position = fullDeal(POSITION, {
      tpHistory: [{ id: 't0', qty: 0.1, price: 110 }],
    })
    const local = fullDeal(DEAL_B, { createTime: 2_000 })
    const deals: Record<string, any> = { [POSITION]: position, [DEAL_B]: local }
    const orderUpdates: any[] = []
    const emitted: any[] = []
    const saved: any[] = []
    bot.getDeal = (id: string) => deals[id]
    bot.dealsDb = {
      readData: async () =>
        ok([
          { ...local.deal, tpHistory: [{ id: 't1', qty: 0.2, price: 111 }] },
          {
            ...fullDeal(DEAL_C).deal,
            botId: OTHER_BOT,
            createTime: 3_000,
          },
        ]),
      updateManyData: async (_q: unknown, u: any) => {
        log.push(`mark ${JSON.stringify(u.$set)}`)
        return ok(null)
      },
    }
    bot.closeDealById = async (_b: string, id: string) => {
      log.push(`cancel ${id} child=${local.deal.child}`)
    }
    ;(Bot.prototype as any).closeDCADeal = async (
      _u: string,
      botId: string,
      id: string,
    ) => {
      log.push(`cancel ${id} via ${botId}`)
    }
    bot.ordersDb = {
      readData: async () =>
        ok([
          {
            clientOrderId: 'b-bo',
            dealId: DEAL_B,
            botId: BOT_ID,
            status: 'FILLED',
            side: 'BUY',
            typeOrder: TypeOrderEnum.dealStart,
            price: '90',
            executedQty: '1',
          },
          {
            clientOrderId: 'c-so',
            dealId: DEAL_C,
            botId: OTHER_BOT,
            status: 'FILLED',
            side: 'BUY',
            typeOrder: TypeOrderEnum.dealRegular,
            price: '80',
            executedQty: '1',
          },
        ]),
      updateData: async (q: unknown, u: unknown) => {
        orderUpdates.push([q, u])
        return ok(null)
      },
    }
    bot.deleteOrder = () => undefined
    bot.setOrder = () => undefined
    bot.emit = (event: string, payload: any) => emitted.push([event, payload])
    bot.getAvgPrice = async () => ({ avg: 90, display: 90 })
    bot.updateDealBalances = async () => undefined
    bot.saveDeal = (_d: unknown, patch: unknown) => {
      saved.push(patch)
      return Promise.resolve()
    }
    bot.rebuildDealOrders = async () => {
      log.push('rebuild')
    }
    bot.updateUsage = async () => undefined
    bot.checkDealSlMethods = async () => {
      log.push('sl')
    }
    return { bot, log, position, orderUpdates, emitted, saved }
  }

  it('keeps the target, marks before cancelling, re-points fills and recomputes', async function () {
    this.timeout(10_000)
    const { bot, log, position, orderUpdates, emitted, saved } = adoptionBot()
    const r = await bot.adoptDeals(POSITION, [DEAL_B, DEAL_C, POSITION])
    expect(r.status).to.equal(StatusEnum.ok)

    const mark = `mark {"child":true,"parentId":"${POSITION}"}`
    expect(log[0]).to.equal(mark)
    expect(log[1]).to.equal(`cancel ${DEAL_B} child=true`)
    expect(log[2]).to.equal(`cancel ${DEAL_C} via ${OTHER_BOT}`)
    expect(log).to.include('rebuild')
    expect(log.indexOf('rebuild')).to.be.lessThan(log.indexOf('sl'))

    // §4.2.3: every entry fill is the position's now, as an entry.
    expect(orderUpdates).to.have.length(2)
    for (const [, u] of orderUpdates) {
      expect(u.$set).to.include({
        dealId: POSITION,
        botId: BOT_ID,
        typeOrder: TypeOrderEnum.dealRegular,
        positionEntry: true,
      })
      expect(u.$set.addFundsId).to.be.a('string')
    }
    // §4.2.4
    expect(position.deal._id).to.equal(POSITION)
    expect(position.deal.createTime).to.equal(1_000)
    expect(position.deal.positionEntries).to.equal(3)
    expect(position.deal.adoptedIds).to.deep.equal([DEAL_B, DEAL_C])
    expect(position.deal.funds).to.deep.equal([
      { price: 90, qty: 1 },
      { price: 80, qty: 1 },
    ])
    expect(position.deal.tpHistory.map((t: any) => t.id)).to.deep.equal([
      't0',
      't1',
    ])
    expect(position.deal.settings.useDca).to.equal(false)
    expect(position.deal.avgPrice).to.equal(90)
    expect(position.deal.parent, '§4.3 not flagged parent').to.not.equal(true)
    expect(saved[0]).to.include({ positionEntries: 3 })
    // §4.2.6
    expect(emitted.filter(([e]) => e === 'bot update')).to.have.length(2)
    expect(emitted.map(([e]) => e)).to.include('bot deal update')
    // The adopted fills are booked, not in flight.
    expect(bot.dealUpdateOrders.get(POSITION).has('b-bo')).to.equal(true)
  })

  it('refuses a target that is not open, and combo / hedge bots', async () => {
    const { bot } = adoptionBot()
    const r = await bot.adoptDeals('nope', [DEAL_B])
    expect(r.reason).to.match(/must be an open deal/)
    const combo = helper()
    Object.defineProperty(combo, 'combo', { value: true })
    expect((await combo.adoptDeals(POSITION, [DEAL_B])).reason).to.match(
      /combo/,
    )
    const leg = helper()
    leg.data.parentBotId = OTHER_BOT
    expect((await leg.adoptDeals(POSITION, [DEAL_B])).reason).to.match(/hedge/)
  })

  it('§5.2.4 a merge on a held pair is routed to an adoption', async () => {
    const bot = helper()
    bot.getOpenDeals = () => [fullDeal(POSITION)]
    bot.dealsDb = {
      readData: async () =>
        ok([{ ...fullDeal(DEAL_C).deal, botId: OTHER_BOT }]),
    }
    const routed: unknown[] = []
    bot.adoptDeals = async (...a: unknown[]) => {
      routed.push(a)
    }
    bot.mergeDealsBody = async () => {
      throw new Error('a plain merge would leave two deals on the pair')
    }
    await bot.mergeDeals([DEAL_C])
    expect(routed).to.deep.equal([[POSITION, [DEAL_C]]])
  })

  it('§5.2.2 a merge into a pair with no position stays a merge', async () => {
    const bot = helper()
    bot.getOpenDeals = () => []
    bot.dealsDb = {
      readData: async () =>
        ok([{ ...fullDeal(DEAL_C).deal, botId: OTHER_BOT }]),
    }
    let merged = 0
    bot.mergeDealsBody = async () => {
      merged += 1
    }
    await bot.mergeDeals([DEAL_C])
    expect(merged).to.equal(1)
  })
})

describe('spec 139 §5.1 / §2.5 / §7 — changeDCABot', () => {
  const botDoc = (over: Record<string, unknown> = {}) => ({
    _id: BOT_ID,
    userId: USER_ID,
    status: 'open',
    exchange: ExchangeEnum.binance,
    settings: spSettings({ singlePosition: false }),
    stats: { numerical: { general: {} }, chart: [] },
    ...over,
  })

  const harness = (
    doc: ReturnType<typeof botDoc>,
    openDeals: { symbol: { symbol: string } }[] = [],
    running = true,
  ) => {
    const writes: any[] = []
    const posted: any[] = []
    const bot: any = Object.create((Bot as any).prototype)
    bot.useBots = true
    bot.dcaBots = running ? [{ id: BOT_ID, userId: USER_ID, worker: 'w' }] : []
    bot.getWorkerById = () => ({ postMessage: (m: unknown) => posted.push(m) })
    bot.getBot = async () => ({ status: StatusEnum.ok, data: doc })
    bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
    bot.recordChangeTrail = () => undefined
    bot.pairsDb = { readData: async () => ok([]) }
    bot.dcaDealsDb = { readData: async () => ok(openDeals) }
    bot.dcaBotDb = {
      readData: async () => ok(doc),
      updateData: async (_f: unknown, u: unknown) => {
        writes.push(u)
        return { status: StatusEnum.ok, reason: '', data: doc }
      },
    }
    return { bot, writes, posted }
  }

  const twoOnBtc = [
    { symbol: { symbol: SYMBOL } },
    { symbol: { symbol: SYMBOL } },
    { symbol: { symbol: 'ETHUSDT' } },
  ]

  it('§5.1.2 refuses while a pair holds more than one open deal', async () => {
    const { bot, writes } = harness(botDoc(), twoOnBtc)
    const r = await bot.changeDCABot(
      { id: BOT_ID, singlePosition: true },
      USER_ID,
      false,
    )
    expect(r.status).to.equal(StatusEnum.notok)
    expect(r.reason).to.equal(
      `${SINGLE_POSITION_MULTIPLE_OPEN_PREFIX}${SYMBOL}`,
    )
    expect(writes).to.have.length(0)
  })

  it('§5.1.2 adoptOpenDeals lets it through and the worker adopts', async () => {
    const { bot, writes, posted } = harness(botDoc(), twoOnBtc)
    await bot.changeDCABot(
      { id: BOT_ID, singlePosition: true, adoptOpenDeals: true },
      USER_ID,
      false,
    )
    const saved = writes[0].$set.settings
    expect(saved.singlePosition).to.equal(true)
    expect(saved, 'not a setting').to.not.have.property('adoptOpenDeals')
    expect(posted[0]).to.include({ method: 'enableSinglePosition' })
    expect(posted[0].args).to.deep.equal([BOT_ID, true])
  })

  it('§5.1.4 a stopped bot with open deals is refused', async () => {
    const { bot } = harness(
      botDoc({ status: 'closed' }),
      [{ symbol: { symbol: SYMBOL } }],
      false,
    )
    const r = await bot.changeDCABot(
      { id: BOT_ID, singlePosition: true },
      USER_ID,
      false,
    )
    expect(r.reason).to.equal(SINGLE_POSITION_START_BOT_REASON)
  })

  it('a stopped bot without open deals switches freely', async () => {
    const { bot, writes } = harness(botDoc({ status: 'closed' }), [], false)
    await bot.changeDCABot({ id: BOT_ID, singlePosition: true }, USER_ID, false)
    expect(writes[0].$set.settings.singlePosition).to.equal(true)
  })

  it('§2.5 switching it resets the "since last change" stats', async () => {
    const { bot, writes } = harness(botDoc({ status: 'closed' }), [], false)
    await bot.changeDCABot({ id: BOT_ID, singlePosition: true }, USER_ID, false)
    expect(writes.some((w) => 'resetStatsAfter' in (w.$set ?? {}))).to.equal(
      true,
    )
  })

  it('§7.2 ASAP without spacing is refused (GraphQL path)', async () => {
    const { bot, writes } = harness(botDoc({ status: 'closed' }))
    const r = await bot.changeDCABot(
      { id: BOT_ID, singlePosition: true, useDynamicPriceFilter: false },
      USER_ID,
      false,
    )
    expect(r.reason).to.equal(SINGLE_POSITION_ASAP_SPACING_REASON)
    expect(writes).to.have.length(0)
  })

  it('§2.4 a hedge leg ignores the setting', async () => {
    const { bot, writes } = harness(
      botDoc({ status: 'closed', parentBotId: OTHER_BOT }),
    )
    await bot.changeDCABot(
      { id: BOT_ID, singlePosition: true, useDynamicPriceFilter: false },
      USER_ID,
      false,
    )
    expect(writes[0].$set.settings.singlePosition).to.equal(false)
  })

  it('§7.2 createDCABot refuses ASAP without spacing', async () => {
    const bot: any = Object.create((Bot as any).prototype)
    const r = await bot.prepareDCABot(
      USER_ID,
      spSettings({ useDynamicPriceFilter: false, exchange: 'binance' }),
      false,
    )
    expect(r.reason).to.equal(SINGLE_POSITION_ASAP_SPACING_REASON)
  })
})

describe('spec 139 §7.2 — the v2 update check', () => {
  it('refuses ASAP without spacing on the merged settings', () => {
    const r = checkDCABotSettings(
      spSettings({
        singlePosition: false,
        useDynamicPriceFilter: false,
      }) as any,
      { singlePosition: true },
      false,
    )
    expect(r).to.deep.equal({
      status: StatusEnum.notok,
      reason: SINGLE_POSITION_ASAP_SPACING_REASON,
    })
  })

  it('accepts the setting, the entry limit and adoptOpenDeals', () => {
    const r = checkDCABotSettings(
      spSettings({ singlePosition: false }) as any,
      {
        singlePosition: true,
        maxPositionEntries: '4',
        adoptOpenDeals: true,
      } as any,
      false,
    )
    expect(r.status).to.equal(StatusEnum.ok)
  })

  it('combo bots refuse it', () => {
    const r = checkDCABotSettings(
      spSettings({ singlePosition: false }) as any,
      { singlePosition: true },
      true,
    )
    expect(r.status).to.equal(StatusEnum.notok)
  })
})

describe('spec 139 §4.2.5 — the take profit after an adoption (live order map)', () => {
  // A USDM long position of 3 entries (avg 82819.4, TP 0.003) adopts two
  // 0.001 deals filled at 82836.3. Built on the REAL order / deal maps,
  // `saveDeal` (which swaps the map's deal copy), `getAvgPrice`,
  // `updateDealBalances`, `rebuildDealOrders`, `createCurrentDealOrders` and
  // `getTPOrder`; only venue I/O and side bookkeeping are stubbed. What the
  // venue is asked to place is what `placeOrders` receives.
  const T = '000000000000000000000d11'
  const S1 = '000000000000000000000d12'
  const S2 = '000000000000000000000d13'
  const fill = (
    id: string,
    dealId: string,
    price: number,
    typeOrder: TypeOrderEnum,
    extra: Record<string, unknown> = {},
  ) => ({
    clientOrderId: id,
    dealId,
    botId: BOT_ID,
    userId: USER_ID,
    status: 'FILLED',
    side: 'BUY',
    typeOrder,
    price: `${price}`,
    origPrice: `${price}`,
    origQty: '0.001',
    executedQty: '0.001',
    updateTime: 1,
    symbol: SYMBOL,
    ...extra,
  })

  const liveBot = () => {
    const bot = helper(
      spSettings({
        useTp: true,
        tpPerc: '1',
        dealCloseCondition: 'tp',
        dealCloseConditionSL: 'tp',
        useDca: false,
        orderSizeType: 'base',
        baseOrderSize: '0.001',
        indicators: [],
        multiTp: [],
        futures: true,
      }),
    )
    Object.defineProperty(bot, 'futures', { value: true, configurable: true })
    Object.assign(bot, {
      math: new MathHelper(),
      orders: new Map(),
      ordersKeys: new Set(),
      orderStatusMap: new Map(),
      orderDealMap: new Map(),
      orderStatuses: ['NEW', 'PARTIALLY_FILLED'],
      deals: new Map(),
      dealStatusMap: new Map(),
      dealSymbolMap: new Map(),
      profitBaseDealMap: new Map(),
      sharedStream: { addOrder() {}, removeOrder() {} },
      brokerCode: '',
      data: { ...helper().data, flags: [], settings: bot.data.settings },
    })
    delete bot.getOrdersByStatusAndDealId
    delete bot.getOrderFromMap
    delete bot.getAggregatedSettings
    for (const k of ['setOrdersToRedis', 'setDealToRedis']) {
      bot[k] = () => undefined
    }
    bot.handleErrors = (r: string) => {
      throw new Error(r)
    }
    bot.getExchangeInfo = async () => ({
      pair: SYMBOL,
      baseAsset: { name: 'BTC', minAmount: 0.001, step: 0.001 },
      quoteAsset: { name: 'USDT', minAmount: 5 },
      priceAssetPrecision: 1,
    })
    bot.getUserFee = async () => ({ maker: 0.0002, taker: 0.0004 })
    bot.baseAssetPrecision = async () => 3
    bot.getUsdRate = async () => 1
    bot.getLatestPrice = async () => 82813.5
    bot.getLeverageMultipler = async () => 1
    bot.getCommDeal = async () => 0
    bot.computeObservedFeeLedger = async () => null
    bot.getLastStreamData = () => undefined
    for (const k of [
      'updateUsage',
      'updateAssets',
      'checkDealSlMethods',
      'removeDealFromStopLossMethods',
      'checkAllowedMethods',
      'setClassProperties',
      'setCloseByTimer',
      'checkTPLevel',
      'resendPendingFunds',
      'afterDealUpdate',
      'checkDealsPriceExtremum',
      'carryStopLossLatches',
      'updateDealLastPrices',
      'updateDealLastTime',
      'armNextPositionEntry',
    ]) {
      bot[k] = async () => undefined
    }
    const deal = {
      ...fullDeal(T).deal,
      positionEntries: 3,
      settings: {
        useDca: false,
        avgPrice: 82819.4,
        tpPerc: '1',
        useTp: true,
        dealCloseCondition: 'tp',
      },
      levels: { all: 3, complete: 3 },
      initialBalances: { base: 0, quote: 248.4582 },
      currentBalances: { base: 0.003, quote: 0 },
      funds: [
        { price: 82822.4, qty: 0.001 },
        { price: 82813.5, qty: 0.001 },
      ],
      lastPrice: 82813.5,
      avgPrice: 82819.4,
      initialPrice: 82822.4,
      size: 0.003,
      flags: [],
    }
    const oldTp = {
      qty: 0.003,
      price: 83714.5,
      side: 'SELL',
      type: TypeOrderEnum.dealTP,
      dealId: T,
    }
    bot.setDeal(
      {
        deal,
        initialOrders: [],
        currentOrders: [oldTp],
        previousOrders: [],
        closeBySl: false,
        notCheckSl: false,
        closeByTp: false,
      },
      false,
    )
    for (const o of [
      fill('bo', T, 82822.4, TypeOrderEnum.dealStart),
      fill('roa1', T, 82822.4, TypeOrderEnum.dealRegular, {
        addFundsId: 'a1',
        positionEntry: true,
      }),
      fill('roa2', T, 82813.5, TypeOrderEnum.dealRegular, {
        addFundsId: 'a2',
        positionEntry: true,
      }),
    ]) {
      bot.setOrder(o, false)
    }
    const source = (id: string) => ({
      ...deal,
      _id: id,
      createTime: 2_000,
      funds: [],
      settings: { useDca: true },
    })
    bot.dealsDb = {
      readData: async () => ok([source(S1), source(S2)]),
      updateManyData: async () => ok(null),
      updateData: async () => ok(null),
    }
    bot.ordersDb = {
      readData: async () =>
        ok([
          fill('s1bo', S1, 82836.3, TypeOrderEnum.dealStart),
          fill('s2bo', S2, 82836.3, TypeOrderEnum.dealStart),
        ]),
      updateData: async () => ok(null),
    }
    bot.closeDealById = async () => undefined
    bot.cancelAllOrder = async () => undefined
    const placed: any[] = []
    bot.placeOrders = async (
      _b: string,
      _s: string,
      _d: string,
      o: { new: any[] },
    ) => {
      placed.push(...o.new)
    }
    return { bot, placed }
  }

  it('rests a TP for the whole position at the new average', async function () {
    this.timeout(10_000)
    const { bot, placed } = liveBot()
    await bot.adoptDeals(T, [S1, S2])
    const tps = placed.filter((g) => g.type === TypeOrderEnum.dealTP)
    expect(tps, 'one take profit is placed').to.have.length(1)
    expect(tps[0].qty).to.equal(0.005)
    // avg 82826.1 × 1.01 × the round-trip fee displacement — not the
    // pre-adoption 83714.5 off avg 82819.4.
    expect(tps[0].price).to.equal(83721.3)
    expect(bot.getDeal(T).currentOrders).to.deep.equal(tps)
  })

  it('a further entry after the adoption re-sizes the TP over all six', async function () {
    this.timeout(10_000)
    const { bot, placed } = liveBot()
    await bot.adoptDeals(T, [S1, S2])
    placed.length = 0
    const live = bot.getDeal(T)
    live.deal.pendingAddFunds = [
      { id: 'a3', qty: '0.001', positionEntry: true },
    ]
    const entry = fill('roa3', T, 82700, TypeOrderEnum.dealRegular, {
      addFundsId: 'a3',
      positionEntry: true,
    })
    bot.setOrder(entry, false)
    await bot.updateDeal(BOT_ID, entry)
    await new Promise((r) => setTimeout(r, 20))
    const tps = placed.filter((g) => g.type === TypeOrderEnum.dealTP)
    expect(tps).to.have.length(1)
    expect(tps[0].qty).to.equal(0.006)
    expect(bot.getDeal(T).deal.positionEntries).to.equal(6)
  })
})

describe('spec 139 §6 / §10.2 — a position reads as one deal', () => {
  const H = 3_600_000
  // One position, 3 entries, peak capital $300, closed at +$12. One deal
  // adopted into it: opened after the position, merged away at 3 h.
  const rows = [
    {
      start: H,
      end: 6 * H,
      capital: 300,
      profit: 12,
      profitUsd: 12,
      id: POSITION,
    },
    {
      start: 2 * H,
      end: 3 * H,
      capital: 100,
      profit: 0,
      profitUsd: 0,
      id: DEAL_B,
      parentId: POSITION,
    },
  ]

  it('window stats: one deal, one win, peak capital = the position', () => {
    const s = foldBotWindowStats(rows, null, 7 * H)
    expect(s.closedDeals).to.equal(1)
    expect(s.wins).to.equal(1)
    expect(s.avgDealDuration).to.equal(5 * H)
    expect(s.peakCapitalUsd).to.equal(300)
  })

  it('§6.2 the clamp follows parentId although the target is not flagged parent', () => {
    // The target is older than the adopted deal, so the adopted deal holds
    // no capital of its own.
    const peaks = peakCapitalBySymbol(
      rows.map((r) => ({ ...r, symbol: SYMBOL })),
      7 * H,
    )
    expect(peaks.get(SYMBOL)).to.equal(300)
  })
})

describe('spec 139 §7.2 — the v2 create validator', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { pairDb } = require('../../db/dbInit')
  const { DCA_FORM_DEFAULTS } = require('../../server/v2/botDefaults')
  const {
    validateCreateDCABotInput,
  } = require('../../server/v2/validators/bots')
  /* eslint-enable @typescript-eslint/no-require-imports */
  let originalReadData: unknown

  const post = (extra: Record<string, unknown>) => {
    const body = {
      name: 'sp',
      pair: ['BTC_USDT'],
      startCondition: 'ASAP',
      exchangeUUID: 'e0000000-0000-0000-0000-000000000000',
      ...extra,
    }
    return validateCreateDCABotInput(
      {
        ...DCA_FORM_DEFAULTS,
        ...body,
        type: 'regular',
        futures: false,
        coinm: false,
        exchange: 'binance',
        vars: { list: [], paths: [] },
      },
      body,
      '650da8e761845af24b76e600',
    )
  }

  before(() => {
    originalReadData = pairDb.readData
    pairDb.readData = async () =>
      ok([
        {
          exchange: 'binance',
          pair: SYMBOL,
          baseAsset: { name: 'BTC' },
          quoteAsset: { name: 'USDT' },
        },
      ])
  })
  after(() => {
    pairDb.readData = originalReadData
  })

  it('refuses ASAP without spacing, accepts it with a cooldown', async () => {
    const refused = await post({ singlePosition: true })
    expect(refused.valid).to.equal(false)
    expect(refused.errors).to.deep.include([
      'singlePosition',
      SINGLE_POSITION_ASAP_SPACING_REASON,
    ])
    const accepted = await post({
      singlePosition: true,
      maxPositionEntries: '4',
      useCooldown: true,
      cooldownAfterDealStart: true,
      cooldownAfterDealStartInterval: 10,
      cooldownAfterDealStartUnits: 'minutes',
    })
    expect(accepted.valid, JSON.stringify(accepted.errors)).to.equal(true)
  })
})
