process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `030` — a manual deal close reports success without
 * acting.
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
 * Nothing here writes: the branch under test must stay read-only, or it would
 * re-close the deals that are already terminal (spec 030 §3).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  verdictForMissingDealOnClose,
  unactionedCloseMessage,
} from './dealOutcome'
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
  dbWrites: number
}

/**
 * A bot whose in-memory map is empty — the production state — over a database
 * that reports `dbStatus` for the deal (or nothing at all when it is `null`).
 */
const buildBot = (dbStatus: DCADealStatusEnum | null) => {
  const raised: Raised = { events: [], errors: [], warns: [], dbWrites: 0 }
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
            ? { _id: DEAL_ID, botId: BOT_ID, status: dbStatus, symbol: SYMBOL }
            : null,
        },
      }),
      updateData: async () => {
        raised.dbWrites++
        return { status: 'OK', data: { result: null } }
      },
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
) => {
  const bot: any = buildBot(dbStatus)
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
      const raised = await closeMissing(
        DCADealStatusEnum.start,
        DCACloseTriggerEnum.timer,
      )
      expect(raised.events).to.have.length(0)
      expect(raised.errors).to.have.length(0)
    })

    it('§5.3 the branch never writes to the deal', async () => {
      for (const status of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.start,
        DCADealStatusEnum.canceled,
        DCADealStatusEnum.closed,
        null,
      ]) {
        const raised = await closeMissing(status, DCACloseTriggerEnum.manual)
        expect(raised.dbWrites, `${status}`).to.equal(0)
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
})
