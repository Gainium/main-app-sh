process.env.NODE_ENV = 'testing'

/**
 * Spec 228 — a page of `GET /api/v2/deals/:dealType` must be read off an
 * index in sort order, not sorted in memory over every deal the user owns.
 *
 * The listing sorts by `{createTime: -1, _id: -1}` (spec 065's unique
 * tiebreaker). The deal collections only declared indexes ending in
 * `createTime`, so no index could deliver `_id` order inside a `createTime`
 * tie: the planner read ALL of the user's matching deals, sorted them in
 * memory, and then skipped/limited to 20 — on every page.
 *
 * Drives the REAL handler out of `v2API()` against in-memory Mongo (the same
 * harness as `v2PaginationTiebreaker.ts`) and reads the plan that actually
 * executed from the database profiler, so the assertion is about the query
 * the endpoint really sends, not a hand-copied one.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import mongoose from 'mongoose'
import { comboDealsDb, dcaDealsDb } from '../../src/db/dbInit'
import models from '../../src/db/model'
import { registerIndexes } from '../../src/db/schema'
import v2API from '../../src/server/v2/api'

const USER = '65a000000000000000000228'
/** Deals per collection. Large enough that a full read dwarfs one page. */
const DEALS = 600
const PAGE_SIZE = 20
/** createTime repeats this many times, so every page boundary cuts a tie. */
const TIE = 7

type Page = { data: { _id?: string; id?: string }[]; meta: { count: number } }

const readPage = (
  handler: any,
  dealType: string,
  page: number,
  status?: string,
) =>
  new Promise<Page>((resolve, reject) => {
    const req = {
      params: { dealType },
      query: { page: `${page}`, ...(status ? { status } : {}) },
      userData: { id: USER },
      fieldSelection: undefined,
      paperContext: false,
    }
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code
        return this
      },
      send(body: Page) {
        if (this.statusCode !== 200) {
          reject(new Error(`handler answered ${this.statusCode}`))
          return
        }
        resolve(body)
      },
    }
    handler(req, res).catch(reject)
  })

type Seed = {
  _id: mongoose.Types.ObjectId
  createTime: number
  status: string
  type?: string
  paperContext?: boolean
  isDeleted?: boolean
}

const seedDeals = (): Seed[] => {
  const docs: Seed[] = []
  for (let i = 0; i < DEALS; i++) {
    docs.push({
      _id: new mongoose.Types.ObjectId(),
      createTime: 1_700_000_000_000 + Math.floor(i / TIE) * 60_000,
      status: i % 10 === 0 ? 'open' : 'closed',
      // A few rows the endpoint must filter out, so the FETCH filter is real.
      ...(i % 50 === 1 ? { paperContext: true } : {}),
      ...(i % 50 === 2 ? { isDeleted: true } : {}),
      ...(i % 50 === 3 ? { type: 'terminal' } : {}),
    })
  }
  return docs
}

/** What the endpoint should return, computed without the database. */
const expectedIds = (
  docs: Seed[],
  dealType: string,
  page: number,
  status?: string,
) =>
  docs
    .filter(
      (d) =>
        // The combo-deal schema declares no `isDeleted`, so `strictQuery`
        // strips that predicate from the combo filter (it is never written
        // on a combo deal in production either).
        (dealType === 'combo' || !d.isDeleted) &&
        d.paperContext !== true &&
        (dealType !== 'dca' || d.type !== 'terminal') &&
        (!status || d.status === status),
    )
    .sort((a, b) =>
      b.createTime !== a.createTime
        ? b.createTime - a.createTime
        : b._id.toHexString().localeCompare(a._id.toHexString()),
    )
    .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    .map((d) => d._id.toHexString())

/** The last `find` the endpoint sent to `collection`, as the profiler saw it. */
const lastFind = async (collection: string) => {
  const db = mongoose.connection.db!
  const [entry] = await db
    .collection('system.profile')
    .find({ ns: `${db.databaseName}.${collection}`, op: 'query' })
    .sort({ ts: -1 })
    .limit(1)
    .toArray()
  return entry as unknown as {
    hasSortStage?: boolean
    docsExamined: number
    keysExamined: number
    planSummary: string
  }
}

describe('v2 deal listing reads one page off an index', () => {
  let handler: any
  const seeded: Record<string, Seed[]> = {}

  before(async function () {
    this.timeout(120_000)
    registerIndexes()
    await dcaDealsDb.syncIndexes()
    await comboDealsDb.syncIndexes()

    for (const [name, model] of [
      ['dcadeals', models.dcaDeal],
      ['combodeals', models.comboDeal],
    ] as const) {
      await model.collection.deleteMany({ userId: USER })
      const docs = seedDeals()
      seeded[name] = docs
      // Raw insert: the fixture carries only the fields the query touches.
      await model.collection.insertMany(
        docs.map((d) => ({ ...d, userId: USER, botId: 'bot-228' })),
      )
    }

    await mongoose.connection.db!.command({ profile: 2 })

    const api = v2API(undefined as any, {} as any)
    const route = api.get.get('/api/v2/deals/:dealType')
    expect(route, 'GET /api/v2/deals/:dealType is registered').to.not.equal(
      undefined,
    )
    handler = route!.handler
  })

  after(async () => {
    await mongoose.connection.db!.command({ profile: 0 })
    await models.dcaDeal.collection.deleteMany({ userId: USER })
    await models.comboDeal.collection.deleteMany({ userId: USER })
    // No disconnect: the processing suite shares one connection across files
    // and v2PaginationTiebreaker.ts runs after this one and closes it.
  })

  const cases: {
    dealType: 'dca' | 'combo'
    collection: string
    status?: string
  }[] = [
    { dealType: 'dca', collection: 'dcadeals', status: 'closed' },
    { dealType: 'dca', collection: 'dcadeals' },
    { dealType: 'combo', collection: 'combodeals', status: 'closed' },
    { dealType: 'combo', collection: 'combodeals' },
  ]

  for (const { dealType, collection, status } of cases) {
    for (const page of [1, 10]) {
      const label = `${dealType} ${status ?? 'no status'} page ${page}`

      // §5.1 — no in-memory sort; work bounded by the page, not the history.
      it(`${label}: no blocking sort, examines about one page`, async function () {
        this.timeout(30_000)
        await readPage(handler, dealType, page, status)
        const p = await lastFind(collection)
        expect(p, `no profiled find on ${collection}`).to.not.equal(undefined)
        expect(
          p.hasSortStage ?? false,
          `${label} sorted in memory (${p.planSummary})`,
        ).to.equal(false)
        // skip + limit, plus the few rows the FETCH filter discards on the way.
        const bound = page * PAGE_SIZE * 1.5
        expect(
          p.docsExamined,
          `${label} examined ${p.docsExamined} docs for one page (${p.planSummary})`,
        ).to.be.at.most(bound)
      })

      // §5.2 — same rows, same order as before.
      it(`${label}: rows and order unchanged`, async function () {
        this.timeout(30_000)
        const body = await readPage(handler, dealType, page, status)
        expect(body.data.map((d) => `${d._id ?? d.id}`)).to.deep.equal(
          expectedIds(seeded[collection], dealType, page, status),
        )
      })
    }
  }
})
