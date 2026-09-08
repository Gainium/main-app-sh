process.env.NODE_ENV = 'testing'

/**
 * spec 015 — a bot-level bot message must not re-label itself onto its sibling.
 *
 * Production, parent bot 6a847d1a56c67bb39341fbbb (two DCA children, ETC-USDT
 * and BTC-USDT, both refused with "you don't have any positions in this
 * direction for this contract to reduce or close"): a concurrent insert left
 * TWO `botMessages` rows in the 04:00–05:00Z window of 2026-09-06
 * (`bucket: 496852`), one per contract. For the rest of that hour every
 * occurrence whose contract was not the one the filter matched hit
 * `E11000 … index: botMessageCoalesceKey`, in the upsert AND again in the
 * fallback fold, and was DROPPED — 119 `Cannot record bot message Futures
 * position` warns, exactly half the window's 240 occurrences.
 *
 * `Futures position` is a bot-level subType (not in `isPerSymbolSubType`), so
 * its upsert filter carries no `symbol` — but `symbol` was `$set` on every
 * occurrence and `botMessageCoalesceKey` is UNIQUE on
 * `{userId, botId, subType, showUser, bucket, symbol}`. The `$set` therefore
 * MOVED the row inside the unique index, onto the sibling.
 *
 * Unlike `perContractBotMessage.spec.ts` (which records the upsert KEYS), the
 * fake store here enforces that unique index, because the defect is not what
 * the write is keyed on — it is what the write does to the key.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { StatusEnum } from '../../types'

const SUBTYPE = 'Futures position'
const AGREEMENT = 'Agreement required'
const VENUE_MESSAGE =
  "Order failed because you don't have any positions in this direction for this contract to reduce or close."
/** The two live children of parent 6a847d1a56c67bb39341fbbb. */
const CHILD_A = '6a847d1a56c67bb39341fbb4'
const CHILD_B = '6a847d1a56c67bb39341fbb8'
const PARENT_ID = '6a847d1a56c67bb39341fbbb'
const USER_ID = '6a8476b256c67bb39334d9f0'
const CONTRACT_A = 'ETC-USDT'
const CONTRACT_B = 'BTC-USDT'
/** The parent's first configured pair — deliberately neither of the above. */
const FIRST_PAIR = 'SOL-USDT'
/** Any instant inside prod's `bucket: 496852` (1h windows). */
const IN_BUCKET = 496852 * 60 * 60 * 1000

type Row = Record<string, any>

/** `botMessageCoalesceKey` — UNIQUE, partial on `bucket: {$exists: true}`. */
const COALESCE_KEY = [
  'userId',
  'botId',
  'subType',
  'showUser',
  'bucket',
  'symbol',
]
const indexEntry = (r: Row) =>
  r.bucket === undefined
    ? null // outside the partial filter — not indexed, never collides
    : JSON.stringify(COALESCE_KEY.map((f) => r[f] ?? null))

/**
 * An in-memory `botmessages` that enforces the unique index, so a write which
 * moves a row onto an occupied index entry fails the way Mongo fails it.
 */
class FakeMessages {
  rows: Row[] = []
  private seq = 0

  private matches(row: Row, search: Row) {
    return Object.keys(search).every((k) => row[k] === search[k])
  }

  private collides(candidate: Row, self: Row | null) {
    const entry = indexEntry(candidate)
    if (entry === null) return false
    return this.rows.some((r) => r !== self && indexEntry(r) === entry)
  }

  private e11000(candidate: Row) {
    return {
      status: StatusEnum.notok,
      reason: `MongoServerError: Plan executor error during findAndModify :: caused by :: E11000 duplicate key error collection: gainium.botmessages index: botMessageCoalesceKey dup key: ${indexEntry(
        candidate,
      )}`,
    }
  }

  async createData(doc: Row) {
    const row = { ...doc, _id: `id-${++this.seq}` }
    if (this.collides(row, null)) return this.e11000(row)
    this.rows.push(row)
    return { status: StatusEnum.ok, data: row }
  }

  async updateData(
    search: Row,
    update: Record<string, any>,
    _returnDoc?: boolean,
    _updateTimestamp?: boolean,
    upsert?: boolean,
  ) {
    const found = this.rows.find((r) => this.matches(r, search)) ?? null
    if (!found) {
      if (!upsert) return { status: StatusEnum.notok, reason: 'No match' }
      const row: Row = {
        ...search,
        ...(update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
        _id: `id-${++this.seq}`,
      }
      for (const [k, v] of Object.entries(update.$inc ?? {})) {
        row[k] = (row[k] ?? 0) + (v as number)
      }
      if (this.collides(row, null)) return this.e11000(row)
      this.rows.push(row)
      return { status: StatusEnum.ok, data: row }
    }
    const next: Row = { ...found, ...(update.$set ?? {}) }
    for (const [k, v] of Object.entries(update.$inc ?? {})) {
      next[k] = (next[k] ?? 0) + (v as number)
    }
    if (this.collides(next, found)) return this.e11000(next)
    Object.assign(found, next)
    return { status: StatusEnum.ok, data: found }
  }
}

let db: FakeMessages
let warns: string[] = []

/**
 * `Object.create` keeps the real prototype reachable, so `processError` runs for
 * real; only the edges (db, socket, bot state) are stubbed. One instance per
 * CHILD bot — the children are separate `MainBot`s sharing a `parentBotId`,
 * which is why they hold separate `@IdMute` locks.
 */
function fakeChild(botId: string) {
  return Object.assign(Object.create((MainBot as any).prototype), {
    ignoreErrors: false,
    dryRun: false,
    botId,
    userId: USER_ID,
    botType: 'dca',
    errorsMap: new Map<string, number>(),
    data: {
      paperContext: false,
      parentBotId: PARENT_ID,
      exchange: 'binanceUsdm',
      exchangeUUID: 'uuid-1',
      status: 'open',
      settings: { name: 'Futures parent', pair: [FIRST_PAIR], type: 'simple' },
    },
    messagesDb: db,
    pushLogs: () => undefined,
    handleError: () => undefined,
    handleWarn: (m: string) => warns.push(m),
    handleLog: () => undefined,
    handleDebug: () => undefined,
    updateData: () => undefined,
    setRangeOrError: () => undefined,
    cbEmit: () => undefined,
    emit: () => undefined,
  })
}

/**
 * One refusal. `sendError: false` reproduces production's hidden lane
 * (`showUser: false`), which is what puts the row on the 1h coalesce window
 * (`defaultLogPolicy`) and therefore in `bucket: 496852`.
 */
async function refuse(
  bot: any,
  subType: string,
  symbol: string,
  at = IN_BUCKET,
) {
  await (MainBot as any).prototype.processError.call(
    bot,
    bot.botId,
    subType,
    false, // terminal
    false, // setError
    false, // sendError -> showUser:false, the hidden lane
    `Bot ${bot.botId} Reason ${VENUE_MESSAGE} Method limitOrders()`,
    at,
    VENUE_MESSAGE,
    true, // force — skips the Redis-backed re-raise cooldown, no I/O needed
    symbol,
  )
}

/** The production state of §2.2: both children raced and each inserted a row. */
function seedRacedSiblings() {
  const base = {
    userId: USER_ID,
    botId: PARENT_ID,
    subType: SUBTYPE,
    showUser: false,
    bucket: 496852,
    isDeleted: true,
    count: 1,
  }
  db.rows.push({ ...base, _id: 'seed-a', symbol: CONTRACT_A })
  db.rows.push({ ...base, _id: 'seed-b', symbol: CONTRACT_B })
}

const coalesced = () =>
  db.rows.filter((r) => r.subType === SUBTYPE && r.bucket === 496852)
const totalCount = () => coalesced().reduce((sum, r) => sum + (r.count ?? 0), 0)

describe('spec 015 — a coalesced bot message must not move inside its unique index', () => {
  beforeEach(() => {
    db = new FakeMessages()
    warns = []
  })

  describe('§1.1.1 every occurrence is recorded', () => {
    it('alternating contracts in one bucket never drop a message', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      seedRacedSiblings()
      const before = totalCount()

      for (let i = 0; i < 4; i++) {
        await refuse(a, SUBTYPE, CONTRACT_A)
        await refuse(b, SUBTYPE, CONTRACT_B)
      }

      expect(
        warns.filter((w) => w.startsWith('Cannot record bot message')),
      ).to.deep.equal([])
      expect(totalCount() - before).to.equal(8)
    })

    it('a single bot-level row still absorbs a second contract', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      await refuse(a, SUBTYPE, CONTRACT_A)
      await refuse(b, SUBTYPE, CONTRACT_B)
      await refuse(a, SUBTYPE, CONTRACT_A)

      expect(
        warns.filter((w) => w.startsWith('Cannot record bot message')),
      ).to.deep.equal([])
      expect(coalesced().length).to.equal(1)
      expect(coalesced()[0].count).to.equal(3)
    })
  })

  describe('§1.1.2 one row per bot per window, and it names a contract', () => {
    it('a bot-level subType keeps one row however many contracts hit it', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      await refuse(a, SUBTYPE, CONTRACT_A)
      await refuse(b, SUBTYPE, CONTRACT_B)
      expect(coalesced().length).to.equal(1)
    })

    it('the row names the contract it was opened on, and stops re-labelling', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      await refuse(a, SUBTYPE, CONTRACT_A)
      await refuse(b, SUBTYPE, CONTRACT_B)
      // Never blank: the row's `symbol` is the only record of the contract —
      // neither the log line nor `fullMessage` names it (spec 015 §2.3).
      expect(coalesced()[0].symbol).to.equal(CONTRACT_A)
    })

    it('a new window opens a row on whichever contract fires first in it', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      await refuse(a, SUBTYPE, CONTRACT_A)
      await refuse(b, SUBTYPE, CONTRACT_B, IN_BUCKET + 60 * 60 * 1000)
      const next = db.rows.filter((r) => r.bucket === 496853)
      expect(next.length).to.equal(1)
      expect(next[0].symbol).to.equal(CONTRACT_B)
    })
  })

  describe('§1.1.3 per-contract subTypes are unaffected (spec 007)', () => {
    it('two contracts still get one row each', async () => {
      const a = fakeChild(CHILD_A)
      const b = fakeChild(CHILD_B)
      await refuse(a, AGREEMENT, CONTRACT_A)
      await refuse(b, AGREEMENT, CONTRACT_B)
      const rows = db.rows.filter((r) => r.subType === AGREEMENT)
      expect(rows.length).to.equal(2)
      expect(rows.map((r) => r.symbol).sort()).to.deep.equal(
        [CONTRACT_A, CONTRACT_B].sort(),
      )
      expect(
        warns.filter((w) => w.startsWith('Cannot record bot message')),
      ).to.deep.equal([])
    })

    it('a repeat of the same contract folds into that contract row', async () => {
      const a = fakeChild(CHILD_A)
      await refuse(a, AGREEMENT, CONTRACT_A)
      await refuse(a, AGREEMENT, CONTRACT_A)
      const rows = db.rows.filter((r) => r.subType === AGREEMENT)
      expect(rows.length).to.equal(1)
      expect(rows[0].count).to.equal(2)
    })
  })
})
