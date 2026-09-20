process.env.NODE_ENV = 'testing'

/**
 * Spec 065 — a paginated v2 listing must deliver every matching row exactly
 * once across a full page walk.
 *
 * `GET /api/v2/user/balances` pages with `skip`/`limit` over a sort key that is
 * not unique: one balance row exists per (user, connection, asset), so an
 * account-wide read ties on `asset` once per connection holding it. Tied
 * documents have no defined relative order and every page is an independent
 * query, so a tie group straddling a page boundary can come back twice on one
 * page and never on the next. The duplicate exactly masks the loss — the page
 * is full and `meta.count` still matches — so the caller cannot see it.
 *
 * Drives the REAL handler out of `v2API()` against in-memory Mongo (specs/016's
 * harness), the same way `resetShowErrorOwnerScope.ts` does. The fixture shape
 * (many connections, every asset tied across all of them) is the production
 * shape that exposed this; it is sized down so the walk stays fast.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import mongoose from 'mongoose'
import { ExchangeEnum } from '../../types'
import { balanceDb } from '../../src/db/dbInit'
import models from '../../src/db/model'
import { registerIndexes } from '../../src/db/schema'
import v2API from '../../src/server/v2/api'

const USER = 'v2-pagination-tiebreaker-user'
/**
 * 13 connections x 60 assets = 780 rows, every asset tied 13-deep. The page
 * size is fixed at `defaultPaginations.balances` (100), so tie groups straddle
 * every boundary. Before the fix this shape loses rows on every run.
 */
const CONNECTIONS = 13
const ASSETS = 60
const PAGE_SIZE = 100

type Page = { data: { _id?: string; id?: string }[]; meta: { count: number } }

/** Call the real handler with the shape its middlewares would have produced. */
const readPage = (handler: any, page: number, exchangeId?: string) =>
  new Promise<Page>((resolve, reject) => {
    const req = {
      query: { page: `${page}`, ...(exchangeId ? { exchangeId } : {}) },
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

/** Walk every page and report what the caller actually received. */
const walk = async (handler: any, exchangeId?: string) => {
  const seen = new Set<string>()
  let delivered = 0
  let total = 0
  for (let page = 1; ; page++) {
    const body = await readPage(handler, page, exchangeId)
    total = body.meta.count
    delivered += body.data.length
    for (const row of body.data) seen.add(`${row._id ?? row.id}`)
    if (page * PAGE_SIZE >= total) break
  }
  return { total, delivered, distinct: seen.size }
}

describe('v2 paginated listings deliver every row exactly once', () => {
  let handler: any

  before(async function () {
    this.timeout(120_000)
    registerIndexes()
    await balanceDb.syncIndexes()
    await models.balance.deleteMany({ userId: USER })

    const docs: Record<string, unknown>[] = []
    for (let c = 0; c < CONNECTIONS; c++) {
      for (let a = 0; a < ASSETS; a++) {
        docs.push({
          asset: `ASSET${`${a}`.padStart(4, '0')}`,
          exchange: ExchangeEnum.binance,
          exchangeUUID: `connection-${`${c}`.padStart(2, '0')}`,
          userId: USER,
          // Zero rows are not filtered out by the endpoint; keep some in so the
          // fixture matches what a real dust-heavy account returns.
          free: a % 5 === 0 ? 0 : a + 1,
          locked: 0,
        })
      }
    }
    await models.balance.insertMany(docs)

    const api = v2API(undefined as any, {} as any)
    const route = api.get.get('/api/v2/user/balances')
    expect(route, 'GET /api/v2/user/balances is registered').to.not.equal(
      undefined,
    )
    handler = route!.handler
  })

  after(async () => {
    await models.balance.deleteMany({ userId: USER })
    await mongoose.disconnect()
  })

  it('an account-wide walk loses no row to the page boundary', async function () {
    this.timeout(60_000)
    const { total, delivered, distinct } = await walk(handler)

    expect(total, 'every seeded row matches the filter').to.equal(
      CONNECTIONS * ASSETS,
    )
    // Pages are full either way — the duplicate is what hides the loss, so
    // asserting on `delivered` alone would pass against the defect.
    expect(delivered, 'every page came back full').to.equal(total)
    expect(distinct, 'no row was dropped or repeated').to.equal(total)
  })

  it('a connection-scoped walk stays lossless', async function () {
    this.timeout(60_000)
    const { total, delivered, distinct } = await walk(
      handler,
      'connection-00',
    )

    expect(total).to.equal(ASSETS)
    expect(delivered).to.equal(total)
    expect(distinct).to.equal(total)
  })
})
