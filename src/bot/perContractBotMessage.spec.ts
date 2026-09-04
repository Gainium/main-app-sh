process.env.NODE_ENV = 'testing'

/**
 * spec 007 — a per-contract refusal must get a per-contract bot message.
 *
 * Production, bot 6a68b12a4d587ad420559315 (bybitLinear): 21 Bybit TradFi perps
 * refused with "You must sign the required agreement before trading this
 * contract", 16 of the 20 refusal windows overlapping another — and ONE
 * `botMessages` row (`count: 75`, `bucket: 0`) standing in for all of them,
 * whose `symbol` is whichever contract failed last. The agreement is signed per
 * contract, so a user told about one of six blocked contracts cannot act on the
 * other five.
 *
 * These drive the REAL `processError` off the prototype with a hand-built
 * `this` (same idiom as main-app's `tests/processErrorForce.ts`), capturing what
 * the upsert was keyed on. `force: true` is passed deliberately: it bypasses the
 * Redis-backed re-raise cooldown so the test needs no I/O and stays about the
 * coalescing key alone. The cooldown key — the OTHER half of §1.2.3 — is pinned
 * separately below, off `buildCooldownKey`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { isPerSymbolSubType } from './errorRulesCache'
import { StatusEnum } from '../../types'

const AGREEMENT = 'Agreement required'
const VENUE_MESSAGE =
  'You must sign the required agreement before trading this contract.'
const BOT_ID = '6a68b12a4d587ad420559315'
const USER_ID = '66d6bf5becb6591c9ded5b26'
/** The bot's first configured pair — deliberately NOT one of the refused ones. */
const FIRST_PAIR = 'USELESSUSDT'
const CONTRACT_A = 'MSTRUSDT'
const CONTRACT_B = 'SNOWUSDT'

type Upsert = { key: Record<string, unknown>; set: Record<string, unknown> }

let upserts: Upsert[] = []
let raised: string[] = []

/**
 * `Object.create` keeps the real prototype reachable, so everything
 * `processError` calls on itself — including the private `canRaiseUserAlert` —
 * runs for real. Only the edges (db, socket, bot state) are stubbed.
 */
function fakeBot() {
  return Object.assign(Object.create((MainBot as any).prototype), {
    ignoreErrors: false,
    dryRun: false,
    botId: BOT_ID,
    userId: USER_ID,
    botType: 'dca',
    errorsMap: new Map<string, number>(),
    data: {
      paperContext: false,
      exchange: 'bybitLinear',
      exchangeUUID: 'uuid-1',
      status: 'open',
      settings: {
        name: 'Long Future Snipper',
        pair: [FIRST_PAIR, 'QUSDT', 'SNXXUSDT'],
        type: 'simple',
      },
    },
    messagesDb: {
      createData: async (doc: Record<string, unknown>) => {
        upserts.push({ key: doc, set: doc })
        return { status: StatusEnum.ok, data: { _id: `id-${upserts.length}` } }
      },
      // Every distinct key is a distinct row, and a row's first write has
      // count 1 — the same thing `$inc` gives the real call.
      updateData: async (
        key: Record<string, unknown>,
        update: Record<string, any>,
      ) => {
        const serialized = JSON.stringify(key)
        const seen = upserts.filter(
          (u) => JSON.stringify(u.key) === serialized,
        ).length
        upserts.push({ key, set: update.$set })
        return {
          status: StatusEnum.ok,
          data: { _id: `id-${serialized}`, count: seen + 1 },
        }
      },
    },
    pushLogs: () => undefined,
    handleError: () => undefined,
    handleWarn: () => undefined,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    updateData: () => undefined,
    setRangeOrError: () => undefined,
    cbEmit: () => undefined,
    emit: (event: string, data: any) => {
      if (event === 'bot message') raised.push(`${data.symbol}`)
    },
  })
}

async function refuse(bot: any, subType: string, symbol?: string) {
  await (MainBot as any).prototype.processError.call(
    bot,
    BOT_ID,
    subType,
    false, // terminal
    true, // setError
    true, // sendError
    `Bot ${BOT_ID} Reason ${VENUE_MESSAGE} Method limitOrders()`,
    Date.now(),
    VENUE_MESSAGE,
    true, // force — see the header note
    symbol,
  )
}

/** The `symbol` each written row is keyed on, or undefined when it is not keyed on one. */
const keyedSymbols = () => upserts.map((u) => u.key.symbol)

describe('spec 007 — per-contract bot messages', () => {
  beforeEach(() => {
    upserts = []
    raised = []
  })

  describe('§1.1.1 two blocked contracts, two rows', () => {
    it('refusals on different contracts do not share a coalescing key', async () => {
      const bot = fakeBot()
      await refuse(bot, AGREEMENT, CONTRACT_A)
      await refuse(bot, AGREEMENT, CONTRACT_B)
      expect(upserts.length).to.equal(2)
      expect(JSON.stringify(upserts[0].key)).to.not.equal(
        JSON.stringify(upserts[1].key),
      )
      expect(keyedSymbols()).to.deep.equal([CONTRACT_A, CONTRACT_B])
    })

    it('each contract is reported to the user in its own right', async () => {
      const bot = fakeBot()
      await refuse(bot, AGREEMENT, CONTRACT_A)
      await refuse(bot, AGREEMENT, CONTRACT_B)
      expect(raised).to.deep.equal([CONTRACT_A, CONTRACT_B])
    })

    it('a repeat of the SAME contract still folds into its own row', async () => {
      const bot = fakeBot()
      await refuse(bot, AGREEMENT, CONTRACT_A)
      await refuse(bot, AGREEMENT, CONTRACT_A)
      expect(JSON.stringify(upserts[0].key)).to.equal(
        JSON.stringify(upserts[1].key),
      )
      // count reached 2, so no second notification.
      expect(raised).to.deep.equal([CONTRACT_A])
    })
  })

  describe('§1.1.3 bot-level subTypes are untouched', () => {
    it('an account-wide condition keeps one row per bot however many pairs hit it', async () => {
      const bot = fakeBot()
      await refuse(bot, 'API keys error', CONTRACT_A)
      await refuse(bot, 'API keys error', CONTRACT_B)
      expect(upserts.length).to.equal(2)
      expect(JSON.stringify(upserts[0].key)).to.equal(
        JSON.stringify(upserts[1].key),
      )
      expect(keyedSymbols()).to.deep.equal([undefined, undefined])
      expect(raised).to.deep.equal([CONTRACT_A])
    })
  })

  describe('§1.2.3 the re-raise cooldown is scoped the same way', () => {
    it('a per-contract subType keys the cooldown on the contract', () => {
      expect(
        (MainBot as any).prototype.buildCooldownKey.call(
          { userId: USER_ID },
          false,
          BOT_ID,
          AGREEMENT,
          CONTRACT_A,
        ),
      ).to.deep.equal([BOT_ID, AGREEMENT, CONTRACT_A])
    })

    it('a bot-level subType keys the cooldown on the bot, as before', () => {
      expect(
        (MainBot as any).prototype.buildCooldownKey.call(
          { userId: USER_ID },
          false,
          BOT_ID,
          'API keys error',
          CONTRACT_A,
        ),
      ).to.deep.equal([BOT_ID, 'API keys error'])
    })

    it('a terminal deal still keys on user + subType + symbol', () => {
      expect(
        (MainBot as any).prototype.buildCooldownKey.call(
          { userId: USER_ID },
          true,
          BOT_ID,
          AGREEMENT,
          CONTRACT_A,
        ),
      ).to.deep.equal([USER_ID, AGREEMENT, CONTRACT_A])
    })
  })

  describe('§3 which subTypes are per-contract', () => {
    it('the agreement a venue requires is signed per contract', () => {
      expect(isPerSymbolSubType(AGREEMENT)).to.equal(true)
    })
    it('a rejected API key is not', () => {
      expect(isPerSymbolSubType('API keys error')).to.equal(false)
    })
    it('an unclassified subType is not', () => {
      expect(isPerSymbolSubType('Uncategorized')).to.equal(false)
      expect(isPerSymbolSubType(undefined)).to.equal(false)
    })
  })
})
