process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec 006 §1.1.1 / §1.1.2 / §3.2.
 *
 * Drives the REAL `dcaHelper.updateEquityStats` — not a reimplementation — over
 * the recorded production state of paper DCA bot 6926c265aeee0f2e5dac9aa4, with
 * `getExchangeInfo` / `getLatestPrice` stubbed so the venue's answer can be
 * chosen. Builds the instance by `Object.create`-ing the prototype, so no
 * stack, DB, Redis or exchange connection is needed.
 *
 * Run: npx ts-node -T src/bot/dca/buyAndHoldEquityStats.harness.ts
 */
import createDCABotHelper from '../dcaHelper'
import MainBot from '../main'
import { ExchangeEnum } from '../../../types'

// The bot, as recorded in production on 2026-09-04.
const RECORDED = {
  bnhSymbol: 'XIONUSDT', // delisted from Bybit; not in settings.pair
  startPrice: 0.89,
  startBalanceAsset: 114330.73529999999,
  startBalanceUsd: 114278.14316176198,
  result: -114330.73529999999,
  perc: -1.0004602116973809,
  lastChartBuyAndHold: 0,
  lastChartEquity: 117049.37397402861,
}

const DAY = 24 * 60 * 60 * 1000

function statsDoc() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  today.setDate(today.getDate() - 1)
  return {
    numerical: {
      general: {
        startBalance: {
          asset: RECORDED.startBalanceAsset,
          usd: RECORDED.startBalanceUsd,
        },
        bestDay: { value: 0 },
        worstDay: { value: 0 },
      },
      ratios: {
        buyAndHold: {
          symbol: RECORDED.bnhSymbol,
          startPrice: RECORDED.startPrice,
          result: RECORDED.result,
          perc: RECORDED.perc,
        },
      },
      loss: {
        seriesEquity: { value: 0, min: 0, max: 0, perc: 0 },
        maxEquityDrawdown: { usd: 0 },
        maxEquityDrawdownPerc: 0,
      },
    },
    // Two prior days, the last one showing the flat-zero benchmark line.
    chart: [
      {
        time: +today - 2 * DAY,
        equity: 117043.26782772428,
        buyAndHold: 4321,
        realizedProfit: RECORDED.startBalanceUsd,
      },
      {
        time: +today - DAY,
        equity: RECORDED.lastChartEquity,
        buyAndHold: RECORDED.lastChartBuyAndHold,
        realizedProfit: RECORDED.startBalanceUsd,
      },
    ],
  }
}

type Venue = { listed: boolean; price: number }

async function run(venue: Venue, chartSeed?: number, ratioSeed?: number) {
  const Helper: any = createDCABotHelper(MainBot as any)
  const bot: any = Object.create(Helper.prototype)

  const stats = statsDoc()
  if (chartSeed !== undefined) {
    stats.chart[stats.chart.length - 1].buyAndHold = chartSeed
  }
  if (ratioSeed !== undefined) {
    stats.numerical.ratios.buyAndHold.result = ratioSeed
    stats.numerical.ratios.buyAndHold.perc =
      ratioSeed / RECORDED.startBalanceUsd
  }

  const priced: string[] = []
  const infoAsked: string[] = []

  bot.botId = '6926c265aeee0f2e5dac9aa4'
  bot.userId = '6279d23c6bf516d657d1ad0c'
  bot.data = {
    exchange: ExchangeEnum.bybit,
    paperContext: true,
    status: 'open',
    settings: { pair: ['SOLUSDT', 'TRXUSDT'], useMulti: true },
    usage: { max: { quote: 1000, base: 0 } },
    profit: { total: 0, totalUsd: 0 },
    stats,
    symbolStats: [],
    ignoreStats: false,
    workingShift: [{ start: Date.now() - 30 * DAY }],
  }
  // `futures` / `coinm` / `isLong` are getters on MainBot — pin them.
  for (const [k, v] of [
    ['futures', false],
    ['coinm', false],
    ['isLong', true],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }
  bot.equityTimer = null
  bot.botType = 'dca'

  // I/O the method reaches for, stubbed.
  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.setEquityTimer = () => undefined
  bot.updateData = async () => undefined
  bot.emit = () => undefined
  bot.getAggregatedSettings = async () => bot.data.settings
  bot.getOpenDeals = () => []
  bot.profitBase = async () => false
  bot.getLeverageMultipler = async () => 1
  bot.getUsdRate = async () => 1
  bot.getEmptyStats = () => ({ stats: statsDoc(), symbolStats: [] })

  // The two calls the fix is about.
  bot.getExchangeInfo = async (s: string) => {
    infoAsked.push(s)
    return venue.listed ? { pair: s, priceAssetPrecision: 4 } : undefined
  }
  bot.getLatestPrice = async (s: string) => {
    priced.push(s)
    // Faithful to MainBot#getLatestPrice: 0 when the venue rejects the symbol.
    return venue.listed ? venue.price : 0
  }

  await bot.updateEquityStats(bot.botId)

  const bnh = bot.data.stats.numerical.ratios.buyAndHold
  const last = bot.data.stats.chart[bot.data.stats.chart.length - 1]
  return {
    result: bnh.result,
    perc: bnh.perc,
    chartBuyAndHold: last.buyAndHold,
    venueRequests: priced.filter((s) => s === RECORDED.bnhSymbol).length,
    infoAsked: infoAsked.filter((s) => s === RECORDED.bnhSymbol).length,
  }
}

function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  console.log('=== A. delisted reference (the reported bot) ===')
  const a = await run({ listed: false, price: 0 })
  check(
    'no venue price request for the unlisted reference (§1.1.2)',
    a.venueRequests === 0 && a.infoAsked > 0,
    `getLatestPrice('${RECORDED.bnhSymbol}') calls=${a.venueRequests}, getExchangeInfo calls=${a.infoAsked}`,
  )
  check(
    'the -100% ratio is not rewritten (§1.1.1)',
    a.result === RECORDED.result && a.perc === RECORDED.perc,
    `result=${a.result} perc=${a.perc} (unchanged from the stored value)`,
  )
  check(
    'the chart benchmark point is carried forward, not zeroed (§1.2.2)',
    a.chartBuyAndHold === RECORDED.lastChartBuyAndHold,
    `chart buyAndHold=${a.chartBuyAndHold}`,
  )

  console.log('\n=== B. delisted reference, chart had a real prior value ===')
  const b = await run({ listed: false, price: 0 }, 4321)
  check(
    'a real prior benchmark survives instead of being flattened to 0',
    b.chartBuyAndHold === 4321,
    `chart buyAndHold=${b.chartBuyAndHold} (was 4321)`,
  )

  console.log(
    '\n=== D. reference delisted TODAY — yesterday’s healthy ratio must survive ===',
  )
  // The discriminating case: a bot whose benchmark was +8,000 USD before the
  // reference stopped being priceable. Pre-fix this is overwritten with
  // -startBalance.asset; post-fix it is left alone.
  const d = await run({ listed: false, price: 0 }, 4321, 8000)
  check(
    'a healthy stored benchmark is not overwritten with -100% (§1.1.1)',
    d.result === 8000,
    `result=${d.result} (seeded 8000; the -100% value would be ${RECORDED.result})`,
  )

  console.log('\n=== C. live reference — the benchmark still updates ===')
  const c = await run({ listed: true, price: 1.78 }, 4321)
  const expectedAsset =
    (RECORDED.startBalanceAsset / RECORDED.startPrice) * 1.78
  const expectedResult = expectedAsset - RECORDED.startBalanceAsset
  check(
    'a priced reference recomputes result/perc',
    Math.abs(c.result - expectedResult) < 1e-6,
    `result=${c.result} expected≈${expectedResult}`,
  )
  check(
    'a priced reference writes a fresh chart point',
    Math.abs(c.chartBuyAndHold - expectedAsset) < 1e-6,
    `chart buyAndHold=${c.chartBuyAndHold} expected≈${expectedAsset}`,
  )
  check(
    'reference doubled in price ⇒ benchmark is positive',
    c.perc > 0,
    `perc=${c.perc}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
