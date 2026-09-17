process.env.NODE_ENV = 'testing'

/**
 * End-to-end reproduction for spec `052` §1.2 — the claim that the limit-only
 * entry fallback writes NO `botmessages` row — settled against a real database
 * rather than by reading the code path.
 *
 * `limitOnlyEntryReport.spec.ts` stubs `processError`, so it can only show that
 * the branch calls it correctly. This harness does not stub it: it borrows the
 * REAL `MainBot.prototype.processError` and the REAL `botMessageDb`, drives the
 * REAL `dcaHelper.placeBaseOrder` through a venue that refuses market orders for
 * limit-only mode, and then reads the collection back out.
 *
 * Nothing about production is touched: it resolves its connection through the
 * app's own helper and writes only under its own synthetic bot id, which it
 * deletes on the way in and on the way out.
 *
 * `utils.sleep` is neutralised before `dcaHelper` is loaded — see the note in
 * the spec file.
 *
 * Measured against the local stack, ten reposition ticks on a book that stays
 * in limit-only mode:
 *
 *   before this spec's change — 0 `botmessages` rows
 *   after                     — 1 row, `showUser: true`, `count: 1`
 *
 * Run (local stack):
 *   DOTENV_CONFIG_PATH=../.env \
 *   MONGO_DB_URI="mongodb://<user>:<pwd>@localhost:27017/gainium" \
 *   npx ts-node -T -r dotenv/config src/bot/limitOnlyEntryReport.harness.ts
 */
import mongoose from 'mongoose'
import utils from '../utils'
import MainBot from './main'
import { botMessageDb } from '../db/dbInit'
import mongo from '../db/data'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import { limitOnlyEntryReplaced } from './utils'
import { ExchangeEnum, OrderTypeEnum } from '../../types'

// Must run before `dcaHelper` is loaded — hence the dynamic import in `main()`.
;(utils as unknown as { sleep: (ms: number) => Promise<void> }).sleep =
  async () => undefined

/**
 * The local stack's Mongo, resolved by the app's OWN connection helper
 * (`src/db/data.ts`) rather than by a URI rebuilt here — same credentials, same
 * precedence rules, and no second copy to drift.
 *
 * Note `NODE_ENV=testing` makes that helper prefer an in-memory Mongo unless
 * `MONGO_DB_URI` is set, so the run below reports which one it got: an
 * in-memory database proves the write path just as well, but it is not the
 * local stack and should not be mistaken for it.
 */
const mongoUri = () => mongo.connection()

/** Synthetic — this file is public, and the real ids belong in the issue. */
const BOT_ID = '000000000000000000000b52'
const USER_ID = '000000000000000000000452'
const DEAL_ID = '000000000000000000000d52'
const SYMBOL = 'SYND-USDC'

/** Coinbase Advanced Trade, verbatim. */
const LIMIT_ONLY_REFUSAL =
  'Orderbook is in limit only mode - please use limit order type'

/**
 * The reporting path, borrowed off `MainBot` rather than reimplemented. These
 * are the methods `processError` reaches for; taking them from the prototype is
 * what makes this a test of the real thing.
 */
const REAL_METHODS = [
  'processError',
  'buildCooldownKey',
  'canRaiseUserAlert',
  'pushLogs',
  '_handleLog',
  'handleError',
  'handleWarn',
  'emit',
  'cbEmit',
] as const

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  log = false
  ignoreErrors = false
  lastLogs: any[] = []
  errorsMap = new Map<string, number>()
  /** The real DAO, over the real connection. */
  messagesDb = botMessageDb
  /** `emit` publishes through this; undefined makes it a no-op (optional call). */
  redisDb = undefined
  data: any = {
    settings: {
      type: 'regular',
      pair: [SYMBOL],
      futures: true,
      name: 'HARNESS',
    },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
    status: 'active',
    vars: null,
    flags: [],
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

for (const m of REAL_METHODS) {
  ;(FakeBase.prototype as any)[m] = (MainBot.prototype as any)[m]
}

const buildBot = (Helper: any, startOrderType: OrderTypeEnum) => {
  const events: any[] = []
  class TestBot extends Helper {
    events = events
    exchange = {}
    slippageRetry = 5
    dealTimersMap = new Map()
    startTimeoutTime = new Map()
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)

    async getAggregatedSettings() {
      return { startOrderType, useLimitPrice: false, baseOrderPrice: '0' }
    }
    getDeal() {
      return { deal: { _id: DEAL_ID, status: 'start', createTime: 1 } }
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async getBaseOrder(
      _symbol: string,
      _dealId: string,
      forceMarket: boolean,
      _p: any,
      _count: number,
      _fixSize: number,
      _sizes: any,
      _orderSizeType: any,
      forceLimit: boolean,
    ) {
      const type = forceLimit
        ? OrderTypeEnum.limit
        : forceMarket
          ? OrderTypeEnum.market
          : startOrderType
      return {
        clientOrderId: `D-BASE-${type}`,
        type,
        typeOrder: 'dealStart',
        origQty: '100',
        price: '0.0066',
        side: 'BUY',
        symbol: SYMBOL,
        dealId: DEAL_ID,
      }
    }
    /** A book in limit-only mode: refuses MARKET, accepts LIMIT. */
    async sendOrderToExchange(order: any) {
      if (order.type === OrderTypeEnum.market) {
        return LIMIT_ONLY_REFUSAL
      }
      return { ...order, status: 'NEW' }
    }
    botEventDb = {
      createData: async (row: any) => {
        events.push(row)
        return { status: 'OK', data: { _id: 'e1' } }
      },
    }
    updateDealLastPrices() {}
    async saveDeal() {}
    handleLog() {}
    handleDebug() {}
    async handleErrors() {}
    async handleOrderErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    resetPending() {}
    async closeDealById() {}
    async startDeal() {}
    setOrder() {}
    ordersDb = { createData: async () => ({ status: 'OK' }) }
  }
  return new TestBot()
}

const rows = () =>
  mongoose.connection
    .collection('botmessages')
    .find({ botId: BOT_ID })
    .toArray()

const show = (label: string, docs: any[]) => {
  console.log(`\n--- ${label}: ${docs.length} botmessages row(s) ---`)
  for (const d of docs) {
    console.log(
      JSON.stringify(
        {
          subType: d.subType,
          type: d.type,
          showUser: d.showUser,
          isDeleted: d.isDeleted,
          symbol: d.symbol,
          count: d.count,
          message: d.message,
        },
        null,
        2,
      ),
    )
  }
}

let failures = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures++
}

async function main() {
  const uri = await mongoUri()
  await mongoose.connect(uri)
  console.log(`connected: ${uri.replace(/\/\/[^@]*@/, '//***@')}`)
  await mongoose.connection
    .collection('botmessages')
    .deleteMany({ botId: BOT_ID })

  const { default: dcaHelper } = await import('./dcaHelper')
  const Helper = (dcaHelper as any)(FakeBase as any)

  show('BEFORE (clean fixture)', await rows())

  // Ten reposition ticks against a book that stays in limit-only mode — the
  // production shape of spec §2.4.
  const bot: any = buildBot(Helper, OrderTypeEnum.market)
  for (let tick = 0; tick < 10; tick++) {
    await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID, false)
    await new Promise((r) => setTimeout(r, 0))
  }
  // `processError` is fire-and-forget behind a mutex; let its write land.
  await new Promise((r) => setTimeout(r, 750))

  const after = await rows()
  show('AFTER (10 limit-only ticks)', after)

  check('exactly one botmessages row was written', after.length === 1)
  const row = after[0] ?? {}
  check(
    `subType is "${limitOnlyEntryReplaced}"`,
    row.subType === limitOnlyEntryReplaced,
  )
  check('the row is visible to the user (showUser)', row.showUser === true)
  check(
    'the row is not born dismissed (isDeleted false)',
    row.isDeleted === false,
  )
  check('it is a warning, not a bot error', row.type === 'warning')
  check('it is labelled with the pair that refused', row.symbol === SYMBOL)
  check('ten ticks coalesced into one row', (row.count ?? 0) === 1)
  check(
    'the message tells the user to change the entry settings',
    typeof row.message === 'string' &&
      row.message.includes('entry settings') &&
      row.message.includes('LIMIT') &&
      row.message.includes(SYMBOL),
  )
  check('the bot event feed got exactly one row too', bot.events.length === 1)

  await mongoose.connection
    .collection('botmessages')
    .deleteMany({ botId: BOT_ID })
  await mongoose.disconnect()
  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
