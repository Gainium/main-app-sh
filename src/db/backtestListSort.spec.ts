process.env.NODE_ENV = 'testing'

/**
 * Backtest lists honour the requested sort direction.
 *
 * `mapDataGridOptionsToMongoOptions` maps 'desc' to an ascending Mongo sort.
 * A client asking for page 0 of its backtests, newest first, therefore got the
 * oldest page. `mapBacktestListOptions` (used by getBacktests,
 * getComboBacktests, getGridBacktests, getHedgeComboBacktests and
 * getHedgeDCABacktests) honours the direction, breaks ties by `_id`, and keeps
 * the generic direction for `created`, which a client sends as 'asc' meaning
 * newest first.
 */
import { expect } from 'chai'
import {
  mapBacktestListOptions,
  mapDataGridOptionsToMongoOptions,
} from './utils'

type Row = {
  _id: string
  time: number
  created: number
  financial?: { netProfitTotalPerc?: number }
  source?: { kind: string }
}

const get = (row: Row, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === 'object'
          ? (v as Record<string, unknown>)[k]
          : undefined,
      row,
    )

// Mongo's order for these values: a missing value before every number.
const cmpValue = (a: unknown, b: unknown) => {
  const ra = a === undefined || a === null ? -Infinity : (a as number | string)
  const rb = b === undefined || b === null ? -Infinity : (b as number | string)
  return ra < rb ? -1 : ra > rb ? 1 : 0
}

/** Applies a Mongo sort / skip / limit to rows in memory. */
const page = (
  rows: Row[],
  opts: { sort: Record<string, number>; skip: number; limit: number },
) =>
  [...rows]
    .sort((a, b) => {
      for (const [k, dir] of Object.entries(opts.sort)) {
        const c = cmpValue(get(a, k), get(b, k))
        if (c !== 0) return c * dir
      }
      return 0
    })
    .slice(opts.skip, opts.skip + opts.limit)

// 120 plain rows an hour apart, plus rows another runner created in between
// (one still running, without results yet).
const H = 3_600_000
const plain: Row[] = Array.from({ length: 120 }, (_, i) => ({
  _id: `p${String(i).padStart(3, '0')}`,
  time: i * H,
  created: i * H,
  financial: { netProfitTotalPerc: (i % 7) - 3 },
}))
const runner: Row[] = [
  {
    _id: 'r1',
    time: 59.5 * H,
    created: 59.5 * H,
    financial: { netProfitTotalPerc: 2.5 },
    source: { kind: 'runner' },
  },
  {
    _id: 'r2',
    time: 119.5 * H,
    created: 119.5 * H,
    source: { kind: 'runner' },
  },
]
const rows = [...plain, ...runner]

describe('backtest list sort — the requested direction is honoured', () => {
  it("'desc' sorts descending, 'asc' ascending, none descending", () => {
    expect(
      mapBacktestListOptions({ sortModel: [{ field: 'time', sort: 'desc' }] })
        .sort,
    ).to.deep.equal({ time: -1, _id: -1 })
    expect(
      mapBacktestListOptions({ sortModel: [{ field: 'time', sort: 'asc' }] })
        .sort,
    ).to.deep.equal({ time: 1, _id: 1 })
    expect(
      mapBacktestListOptions({ sortModel: [{ field: 'time' }] }).sort,
    ).to.deep.equal({ time: -1, _id: -1 })
    expect(
      mapBacktestListOptions({ sortModel: [{ field: 'id', sort: 'asc' }] })
        .sort,
    ).to.deep.equal({ _id: 1 })
  })

  it('no sort model keeps the default (newest created first)', () => {
    expect(mapBacktestListOptions({}).sort).to.deep.equal({ created: -1 })
    expect(mapBacktestListOptions().sort).to.deep.equal({ created: -1 })
  })

  it('a sort on created keeps the generic direction (asc = newest first)', () => {
    const input = { sortModel: [{ field: 'created', sort: 'asc' }] }
    expect(mapBacktestListOptions(input).sort).to.deep.equal(
      mapDataGridOptionsToMongoOptions(input).sort,
    )
    expect(mapBacktestListOptions(input).sort).to.deep.equal({ created: -1 })
  })

  it('filter, skip and limit are those of the generic mapping', () => {
    const input = {
      page: 3,
      pageSize: 25,
      sortModel: [{ field: 'time', sort: 'desc' }],
      filterModel: {
        items: [
          { field: 'financial.netProfitTotalPerc', operator: '>=', value: '1' },
        ],
      },
    }
    const generic = mapDataGridOptionsToMongoOptions(
      JSON.parse(JSON.stringify(input)),
    )
    const mapped = mapBacktestListOptions(JSON.parse(JSON.stringify(input)))
    expect(mapped.filter).to.deep.equal(generic.filter)
    expect(mapped.skip).to.equal(75)
    expect(mapped.limit).to.equal(25)
  })

  it('the generic mapping is unchanged for its other callers', () => {
    expect(
      mapDataGridOptionsToMongoOptions({
        sortModel: [{ field: 'time', sort: 'desc' }],
      }).sort,
    ).to.deep.equal({ time: 1 })
  })

  it('page 0 × 50, newest first, returns the newest 50 rows', () => {
    const got = page(
      rows,
      mapBacktestListOptions({
        page: 0,
        pageSize: 50,
        sortModel: [{ field: 'time', sort: 'desc' }],
      }),
    )
    const newest = [...rows].sort((a, b) => b.time - a.time).slice(0, 50)
    expect(got.map((r) => r._id)).to.deep.equal(newest.map((r) => r._id))
    expect(got[0]._id).to.equal('r2')
    expect(got[1]._id).to.equal('p119')
  })

  it('rows of another runner interleave by time with the others', () => {
    const got = page(
      rows,
      mapBacktestListOptions({
        page: 1,
        pageSize: 50,
        sortModel: [{ field: 'time', sort: 'desc' }],
      }),
    )
    const i = got.findIndex((r) => r._id === 'r1')
    expect(i).to.be.greaterThan(0)
    expect(got[i - 1]._id).to.equal('p060')
    expect(got[i + 1]._id).to.equal('p059')
  })

  it('by % net profit: desc puts the largest first and an empty value last', () => {
    const got = page(
      rows,
      mapBacktestListOptions({
        page: 0,
        pageSize: rows.length,
        sortModel: [{ field: 'financial.netProfitTotalPerc', sort: 'desc' }],
      }),
    )
    const values = got.map((r) => r.financial?.netProfitTotalPerc ?? null)
    expect(values[0]).to.equal(3)
    expect(values[values.length - 1]).to.equal(null)
    expect(values).to.include(2.5)
    const asc = page(
      rows,
      mapBacktestListOptions({
        page: 0,
        pageSize: rows.length,
        sortModel: [{ field: 'financial.netProfitTotalPerc', sort: 'asc' }],
      }),
    )
    expect(asc.map((r) => r._id)).to.deep.equal(got.map((r) => r._id).reverse())
  })

  it('pages over tied values cover every row exactly once', () => {
    const seen: string[] = []
    for (let p = 0; p * 7 < rows.length; p++) {
      seen.push(
        ...page(
          rows,
          mapBacktestListOptions({
            page: p,
            pageSize: 7,
            sortModel: [
              { field: 'financial.netProfitTotalPerc', sort: 'desc' },
            ],
          }),
        ).map((r) => r._id),
      )
    }
    expect(seen).to.have.length(rows.length)
    expect(new Set(seen).size).to.equal(rows.length)
  })
})
