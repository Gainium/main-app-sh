process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `030` — a manual deal close reports success without
 * acting — and for spec `046`, which narrows it.
 *
 * Two layers:
 *
 *  - the pure verdict (`verdictForMissingDealOnClose`), which decides whether a
 *    close request that found no deal in the worker's map is a harmless
 *    duplicate or a request that was answered `ok` and then dropped;
 *  - the REAL `dcaHelper.closeDealById`, driven over the mixin with a minimal
 *    base class, replaying the production sequence: the API accepted
 *    `closeDCADeal(... 'cancel' ...)` for deal `6a9ca65c…` at 22:11:58.196Z and
 *    the engine answered `[WARN] Deal 6a9ca65c… not found when close` 8 ms
 *    later, while the database still held the deal as `open`. Two days on it was
 *    still `open`, and the user — told the cancel had succeeded — sold the coins
 *    by hand at the exchange.
 *
 * The branch stays read-only for every shape spec `030` measured. Spec `046`
 * carves out exactly one: a deal the database reports as `start` whose every
 * order row carries the no-venue-id placeholder, which the hourly stuck-start
 * sweep could otherwise never retire.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  verdictForMissingDealOnClose,
  unactionedCloseMessage,
  strandedStartCancelMessage,
} from './dealOutcome'
import {
  isRetirableStrandedStart,
  STRANDED_START_GRACE_MS,
} from './strandedStartClose'
import { closeNotActioned } from '../utils'
import {
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  ExchangeEnum,
} from '../../../types'

/**
 * Fixture ids. Synthetic on purpose — this file is public, and the identifiers
 * of the account the case came from belong in the private issue, not here.
 */
const DEAL_ID = '000000000000000000000d01'
const BOT_ID = '000000000000000000000b01'
const USER_ID = '000000000000000000000401'
const SYMBOL = { symbol: 'ZRX-USDC', baseAsset: 'ZRX', quoteAsset: 'USDC' }

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  closeAfterTpFilled = false
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL.symbol] },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
    flags: [],
  }
  /** `MainBot`'s "this instance still owns the bot" gate — always true there. */
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  events: any[]
  errors: any[]
  warns: string[]
  dbWrites: any[]
}

/** The production row of deal `6a86d694…`: written, never acknowledged. */
const UNACKED_BASE_ROW = {
  orderId: '-1',
  status: 'NEW',
  type: 'MARKET',
  typeOrder: 'dealStart',
  origQty: '0.04',
  executedQty: '0',
}

/** Old enough that no placement could still be in flight. */
const LONG_AGO = () => Date.now() - 26 * 24 * 60 * 60 * 1000

/**
 * A bot whose in-memory map is empty — the production state — over a database
 * that reports `dbStatus` for the deal (or nothing at all when it is `null`).
 */
const buildBot = (
  dbStatus: DCADealStatusEnum | null,
  orders: any[] = [UNACKED_BASE_ROW],
  createTime: number = LONG_AGO(),
) => {
  const raised: Raised = { events: [], errors: [], warns: [], dbWrites: [] }
  class TestBot extends Helper {
    raised = raised
    /** The defect's precondition: the deal is simply not here. */
    getDeal() {
      return undefined
    }
    getOpenDeals() {
      return []
    }
    dealsDb = {
      readData: async () => ({
        status: 'OK',
        data: {
          result: dbStatus
            ? {
                _id: DEAL_ID,
                botId: BOT_ID,
                status: dbStatus,
                symbol: SYMBOL,
                createTime,
              }
            : null,
        },
      }),
      updateData: async (search: any, update: any) => {
        raised.dbWrites.push({ search, update })
        return { status: 'OK', data: { _id: DEAL_ID } }
      },
    }
    ordersDb = {
      readData: async () => ({ status: 'OK', data: { result: orders } }),
    }
    botEventDb = {
      createData: async (row: any) => {
        raised.events.push(row)
        return { status: 'OK', data: { _id: 'e1' } }
      },
    }
    async processError(...args: any[]) {
      raised.errors.push(args)
    }
    async clearDealTimer() {}
    handleLog() {}
    handleDebug() {}
    handleWarn(log: string) {
      raised.warns.push(log)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
    stop() {}
  }
  return new TestBot()
}

const closeMissing = async (
  dbStatus: DCADealStatusEnum | null,
  trigger?: DCACloseTriggerEnum,
  orders?: any[],
  createTime?: number,
) => {
  const bot: any = buildBot(dbStatus, orders, createTime)
  await bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    'cancel',
    true,
    false,
    false,
    false,
    '',
    undefined,
    false,
    trigger,
  )
  return bot.raised as Raised
}

describe('a manual close reports success without acting (spec 030)', () => {
  describe('§4.1 the verdict', () => {
    it('a deal the database does not hold claims nothing', () => {
      expect(
        verdictForMissingDealOnClose(undefined, DCACloseTriggerEnum.manual),
      ).to.equal('silent')
    })

    it('an already-terminal deal is a duplicate request, not a failure', () => {
      for (const status of [
        DCADealStatusEnum.closed,
        DCADealStatusEnum.canceled,
      ]) {
        expect(
          verdictForMissingDealOnClose(status, DCACloseTriggerEnum.manual),
          status,
        ).to.equal('silent')
      }
    })

    it('a live deal on a user- or API-initiated close is a lost request', () => {
      for (const status of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.start,
        DCADealStatusEnum.error,
      ]) {
        for (const trigger of [
          DCACloseTriggerEnum.manual,
          DCACloseTriggerEnum.api,
        ]) {
          expect(
            verdictForMissingDealOnClose(status, trigger),
            `${status}/${trigger}`,
          ).to.equal('report')
        }
      }
    })

    it('an internal engine retry on a live deal stays silent', () => {
      // Deal `6a86d694…` has been `start` and retried hourly since 2026-08-20:
      // 518 of the window's 576 warnings, none of them a request anybody was
      // answered `ok` for. Reporting these would be a notification an hour,
      // forever.
      for (const trigger of [
        DCACloseTriggerEnum.timer,
        DCACloseTriggerEnum.tp,
        DCACloseTriggerEnum.sl,
        DCACloseTriggerEnum.bot,
        DCACloseTriggerEnum.base,
        DCACloseTriggerEnum.auto,
        DCACloseTriggerEnum.webhook,
        DCACloseTriggerEnum.liquidation,
        DCACloseTriggerEnum.combined,
        DCACloseTriggerEnum.indicator,
        DCACloseTriggerEnum.trailing,
        undefined,
      ]) {
        expect(
          verdictForMissingDealOnClose(DCADealStatusEnum.start, trigger),
          `${trigger}`,
        ).to.equal('silent')
      }
    })

    it('the message names the deal and its pair', () => {
      const message = unactionedCloseMessage(DEAL_ID, SYMBOL.symbol)
      expect(message).to.contain(DEAL_ID)
      expect(message).to.contain(SYMBOL.symbol)
    })
  })

  describe('§4.2 the engine', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('the reported case reaches the user', async () => {
      const raised = await closeMissing(
        DCADealStatusEnum.open,
        DCACloseTriggerEnum.manual,
      )
      expect(raised.events, 'bot event').to.have.length(1)
      expect(raised.events[0].deal).to.equal(DEAL_ID)
      expect(raised.events[0].symbol).to.equal(SYMBOL.symbol)
      expect(raised.errors, 'notification').to.have.length(1)
      const [, subType, , setError, sendError] = raised.errors[0]
      expect(subType).to.equal(closeNotActioned)
      // A lost request is not a broken bot — it must not error-state it.
      expect(setError, 'setError').to.equal(false)
      expect(sendError, 'sendError').to.equal(true)
      // The user-initiated report is never swallowed by the re-raise backoff:
      // cancelling two deals in a row has to report both.
      expect(raised.errors[0][8], 'force').to.equal(true)
    })

    it('the benign duplicate keeps today behaviour: a log line and nothing else', async () => {
      const raised = await closeMissing(
        DCADealStatusEnum.canceled,
        DCACloseTriggerEnum.manual,
      )
      expect(raised.events).to.have.length(0)
      expect(raised.errors).to.have.length(0)
      expect(raised.warns.join()).to.contain('not found when close')
    })

    it('the hourly internal retry stays a log line', async () => {
      // A `start` deal whose entry order DID reach the venue: spec `046` leaves
      // it exactly where spec `030` did, because something may still be resting
      // on the exchange.
      const raised = await closeMissing(
        DCADealStatusEnum.start,
        DCACloseTriggerEnum.timer,
        [{ ...UNACKED_BASE_ROW, orderId: '6aa0f18f6ec3ef5f4b3e5fec' }],
      )
      expect(raised.events).to.have.length(0)
      expect(raised.errors).to.have.length(0)
    })

    it('§5.3 the branch never writes to the deal', async () => {
      // Narrowed by spec `046` §4.3: every shape here is one it does NOT act on
      // — `start` carries a venue-acked order row, so only the exact stranded
      // shape in the `046` block below is allowed through.
      const acked = [{ ...UNACKED_BASE_ROW, orderId: '77771234' }]
      for (const status of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.start,
        DCADealStatusEnum.canceled,
        DCADealStatusEnum.closed,
        null,
      ]) {
        const raised = await closeMissing(
          status,
          DCACloseTriggerEnum.manual,
          acked,
        )
        expect(raised.dbWrites, `${status}`).to.have.length(0)
      }
    })

    it('the warning is still logged in every case', async () => {
      const raised = await closeMissing(
        DCADealStatusEnum.open,
        DCACloseTriggerEnum.manual,
      )
      expect(raised.warns.join()).to.contain('not found when close')
    })
  })

  describe('the sweep can retire a forgotten stranded start (spec 046)', () => {
    describe('§4.1 the predicate', () => {
      const base = {
        dealStatus: DCADealStatusEnum.start,
        createTime: LONG_AGO(),
        now: Date.now(),
        orders: [UNACKED_BASE_ROW],
      }

      it('the production shape is retirable', () => {
        expect(isRetirableStrandedStart(base)).to.equal(true)
      })

      it('only a `start` deal is retirable', () => {
        for (const dealStatus of [
          DCADealStatusEnum.open,
          DCADealStatusEnum.error,
          DCADealStatusEnum.closed,
          DCADealStatusEnum.canceled,
          undefined,
          null,
        ]) {
          expect(
            isRetirableStrandedStart({ ...base, dealStatus } as any),
            `${dealStatus}`,
          ).to.equal(false)
        }
      })

      it('a venue-acked order row blocks the retirement', () => {
        // Deal `6aa0f18f…`: a resting LIMIT entry with a real venue id. Marking
        // the deal cancelled would orphan an order that can still fill.
        expect(
          isRetirableStrandedStart({
            ...base,
            orders: [
              { ...UNACKED_BASE_ROW, orderId: '6aa0f18f6ec3ef5f4b3e5fec' },
            ],
          }),
        ).to.equal(false)
        // One acked row among many is still one too many.
        expect(
          isRetirableStrandedStart({
            ...base,
            orders: [UNACKED_BASE_ROW, { ...UNACKED_BASE_ROW, orderId: '991' }],
          }),
        ).to.equal(false)
      })

      it('a row that moved base blocks the retirement', () => {
        // The combo placeholder shape spec `029` describes: no venue id, yet
        // `executedQty === origQty`.
        expect(
          isRetirableStrandedStart({
            ...base,
            orders: [
              {
                ...UNACKED_BASE_ROW,
                typeOrder: 'dealRegular',
                executedQty: '0.04',
              },
            ],
          }),
        ).to.equal(false)
      })

      it('a deal young enough to be a placement in flight is left alone', () => {
        const now = Date.now()
        expect(
          isRetirableStrandedStart({
            ...base,
            now,
            createTime: now - (STRANDED_START_GRACE_MS - 1000),
          }),
          'inside the grace',
        ).to.equal(false)
        expect(
          isRetirableStrandedStart({
            ...base,
            now,
            createTime: now - (STRANDED_START_GRACE_MS + 1000),
          }),
          'outside the grace',
        ).to.equal(true)
      })

      it('an unreadable creation time is left alone', () => {
        for (const createTime of [undefined, null, NaN, 'soon' as any]) {
          expect(
            isRetirableStrandedStart({ ...base, createTime }),
            `${createTime}`,
          ).to.equal(false)
        }
      })

      it('a deal holding no order row at all is retirable', () => {
        // The spec `039` shape, reached after the fact rather than at placement.
        expect(isRetirableStrandedStart({ ...base, orders: [] })).to.equal(true)
      })

      it('the message names the deal and its pair', () => {
        const message = strandedStartCancelMessage(DEAL_ID, SYMBOL.symbol)
        expect(message).to.contain(DEAL_ID)
        expect(message).to.contain(SYMBOL.symbol)
      })
    })

    describe('§4.2 the engine', () => {
      before(function () {
        this.timeout(180000)
        Helper = loadModule('../dcaHelper').default(FakeBase as any)
      })

      it('the sweep retires the stranded deal and records it', async () => {
        const raised = await closeMissing(
          DCADealStatusEnum.start,
          DCACloseTriggerEnum.auto,
        )
        expect(raised.dbWrites, 'deal write').to.have.length(1)
        const { search, update } = raised.dbWrites[0]
        // Never clobber a deal that moved on between the read and the write.
        expect(search).to.deep.equal({
          _id: DEAL_ID,
          status: DCADealStatusEnum.start,
        })
        expect(update.$set.status).to.equal(DCADealStatusEnum.canceled)
        expect(update.$set.closeTrigger).to.equal(DCACloseTriggerEnum.auto)
        expect(update.$set.closeTime).to.be.a('number')
        expect(update.$set.updateTime).to.be.a('number')

        expect(raised.events, 'bot event').to.have.length(1)
        expect(raised.events[0].deal).to.equal(DEAL_ID)
        expect(raised.events[0].symbol).to.equal(SYMBOL.symbol)
        // Nothing is broken for the user to act on, and the sweep can catch up
        // on many of these at once.
        expect(raised.errors, 'no notification').to.have.length(0)
        // The "not actioned" report is the other outcome, not a second one.
        expect(
          raised.events[0].description,
          'not the unactioned-close wording',
        ).to.not.contain('Please retry closing it')
      })

      it('a user-initiated close of the same deal retires it too', async () => {
        const raised = await closeMissing(
          DCADealStatusEnum.start,
          DCACloseTriggerEnum.manual,
        )
        expect(raised.dbWrites).to.have.length(1)
        expect(raised.dbWrites[0].update.$set.closeTrigger).to.equal(
          DCACloseTriggerEnum.manual,
        )
        // …and is NOT also told the request was dropped: it was not.
        expect(raised.errors).to.have.length(0)
      })

      it('the warning is still logged', async () => {
        const raised = await closeMissing(
          DCADealStatusEnum.start,
          DCACloseTriggerEnum.auto,
        )
        expect(raised.warns.join()).to.contain('not found when close')
      })
    })
  })
})
