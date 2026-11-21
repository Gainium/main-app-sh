process.env.NODE_ENV = 'testing'

/**
 * Spec `248` — Restore must not bring back a deal that never opened.
 *
 * Drives the REAL `Bot.restoreDeal` off the prototype over in-memory DB fakes:
 * no Mongo, no worker threads. The refused shape is spec `241`'s retired
 * refused-start deal: one `CANCELED` base row with `orderId: '-1'` and nothing
 * executed.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot from './index'
import { DCADealStatusEnum, StatusEnum } from '../../types'
import {
  dealHoldsPosition,
  RESTORE_NEVER_OPENED_REASON,
} from './dca/restoreDealGuard'

/** Synthetic ids — this file is public. */
const USER_ID = 'user-248'
const BOT_ID = '000000000000000000000248'
const DEAL_ID = '000000000000000000002480'

const refusedEntryRow = {
  orderId: '-1',
  status: 'CANCELED',
  executedQty: '0',
  origQty: '0.079',
  typeOrder: 'dealStart',
}
const filledEntryRow = {
  orderId: '91827364',
  status: 'FILLED',
  executedQty: '0.079',
  origQty: '0.079',
  typeOrder: 'dealStart',
}
/** A terminal import: no venue call, but the position is real. */
const importedEntryRow = {
  orderId: '-1',
  status: 'FILLED',
  executedQty: '50000000',
  origQty: '50000000',
  typeOrder: 'dealStart',
}

const harness = (
  orders: any[],
  deal: Record<string, unknown> = { avgPrice: 0, levels: { all: 4, complete: 0 } },
) => {
  const dealWrites: any[] = []
  const botWrites: any[] = []
  const events: any[] = []
  const posted: any[] = []
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaDealsDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: {
          _id: DEAL_ID,
          botId: BOT_ID,
          userId: USER_ID,
          status: DCADealStatusEnum.canceled,
          symbol: { symbol: 'XAUTUSD' },
          ...deal,
        },
      },
    }),
    updateData: async (...args: any[]) => {
      dealWrites.push(args)
      return { status: StatusEnum.ok, reason: null, data: 'ok' }
    },
  }
  bot.orderDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: orders },
    }),
  }
  bot.dcaBotDb = {
    updateData: async (...args: any[]) => {
      botWrites.push(args)
      return { status: StatusEnum.ok, reason: null, data: 'ok' }
    },
  }
  bot.botEventDb = { createData: (e: any) => events.push(e) }
  bot.dcaBots = [{ id: BOT_ID, userId: USER_ID, worker: 1 }]
  bot.getWorkerById = () => ({ postMessage: (m: any) => posted.push(m) })
  return { bot, dealWrites, botWrites, events, posted }
}

describe('spec 248 — dealHoldsPosition (§4.1)', () => {
  it('a refused-start deal (CANCELED, -1, nothing executed) holds nothing', () => {
    expect(
      dealHoldsPosition({
        orders: [refusedEntryRow],
        avgPrice: 0,
        levelsComplete: 0,
      }),
    ).to.equal(false)
  })

  it('a filled entry holds a position, even when the ledger reads 0', () => {
    expect(
      dealHoldsPosition({ orders: [filledEntryRow], avgPrice: 0, levelsComplete: 0 }),
    ).to.equal(true)
  })

  it('a partly filled, then canceled, entry holds a position', () => {
    expect(
      dealHoldsPosition({
        orders: [{ ...filledEntryRow, status: 'CANCELED', executedQty: '0.03' }],
        avgPrice: 3836.7,
        levelsComplete: 0,
      }),
    ).to.equal(true)
  })

  it('a terminal import (FILLED, -1) holds a position', () => {
    expect(
      dealHoldsPosition({ orders: [importedEntryRow], avgPrice: 0.0000485, levelsComplete: 1 }),
    ).to.equal(true)
  })

  it('with no order rows it falls back to the deal ledger', () => {
    expect(
      dealHoldsPosition({ orders: [], avgPrice: 0, levelsComplete: 0 }),
    ).to.equal(false)
    expect(
      dealHoldsPosition({ orders: [], avgPrice: 12.5, levelsComplete: 1 }),
    ).to.equal(true)
  })
})

describe('spec 248 — Bot.restoreDeal', () => {
  it('§4.2 refuses a spec-241 retired refused-start deal and writes nothing', async () => {
    const { bot, dealWrites, botWrites, events, posted } = harness([refusedEntryRow])
    const res = await bot.restoreDeal(USER_ID, BOT_ID, DEAL_ID, false)
    expect(res).to.deep.equal({
      status: StatusEnum.notok,
      reason: RESTORE_NEVER_OPENED_REASON,
      data: null,
    })
    expect(dealWrites, 'deal writes').to.have.length(0)
    expect(botWrites, 'bot counter writes').to.have.length(0)
    expect(events, 'botevents').to.have.length(0)
    expect(posted, 'worker messages').to.have.length(0)
  })

  it('§4.3 still restores a canceled deal with a filled base', async () => {
    const { bot, dealWrites, botWrites, events, posted } = harness(
      [filledEntryRow, { ...refusedEntryRow, typeOrder: 'dealRegular' }],
      { avgPrice: 3836.7, levels: { all: 4, complete: 1 } },
    )
    const res = await bot.restoreDeal(USER_ID, BOT_ID, DEAL_ID, false)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(dealWrites).to.have.length(1)
    expect(dealWrites[0][1].$set.status).to.equal(DCADealStatusEnum.open)
    expect(botWrites).to.have.length(1)
    expect(events).to.have.length(1)
    expect(posted).to.have.length(1)
  })

  it('§4.3 still restores a terminal import', async () => {
    const { bot, dealWrites } = harness([importedEntryRow], {
      avgPrice: 0.0000485,
      levels: { all: 1, complete: 1 },
    })
    const res = await bot.restoreDeal(USER_ID, BOT_ID, DEAL_ID, false)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(dealWrites).to.have.length(1)
  })
})
