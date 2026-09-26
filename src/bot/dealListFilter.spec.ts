process.env.NODE_ENV = 'testing'

/**
 * Deal-list filters (main-app spec 020 §2): the Mongo filter built for each
 * logical column. The same filters are run against a 140k-deal fixture in
 * main-app `tests/dealListFilters020.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { buildDealListFilter, parseInstant } from './dealListFilter'

const noBots = async () => [] as string[]
const build = (items: unknown[], extra: Record<string, unknown> = {}) =>
  buildDealListFilter(
    { filterModel: { items: items as never, ...extra } },
    { timezone: 'Asia/Jakarta', botIdsByName: noBots },
  )

describe('deal-list filter builder (spec 020 §2)', () => {
  it('a YYYY-MM-DD day is that calendar day in the account timezone', () => {
    const d = parseInstant('2026-09-20', 'Asia/Jakarta')!
    expect(d.day).to.equal(true)
    expect(d.start).to.equal(Date.UTC(2026, 8, 19, 17, 0, 0)) // 00:00 WIB
    expect(d.end - d.start).to.equal(24 * 3600 * 1000)
    expect(parseInstant('1790000000000', 'UTC')).to.deep.equal({
      start: 1790000000000,
      end: 1790000000000,
      day: false,
    })
    // an unknown timezone falls back to UTC rather than throwing
    expect(parseInstant('2026-09-20', 'Not/AZone')!.start).to.equal(
      Date.UTC(2026, 8, 20),
    )
  })

  it('closeTime is / range on epoch-ms numbers, two items on one field combine', async () => {
    const r = await build([
      { field: 'closeTime', operator: 'onOrAfter', value: '2026-09-01' },
      { field: 'closeTime', operator: 'before', value: '2026-09-10' },
    ])
    const d1 = parseInstant('2026-09-01', 'Asia/Jakarta')!
    const d2 = parseInstant('2026-09-10', 'Asia/Jakarta')!
    expect(r.filter).to.deep.equal({
      $and: [
        { closeTime: { $gte: d1.start } },
        { closeTime: { $lt: d2.start } },
      ],
    })
    const is = await build([
      { field: 'createTime', operator: 'is', value: '2026-09-01' },
    ])
    expect(is.filter).to.deep.equal({
      $and: [{ createTime: { $gte: d1.start, $lt: d1.end } }],
    })
    const between = await build([
      {
        field: 'closeTime',
        operator: 'between',
        value: ['2026-09-01', '2026-09-10'],
      },
    ])
    expect(between.filter).to.deep.equal({
      $and: [{ closeTime: { $gte: d1.start, $lt: d2.end } }],
    })
  })

  it('botName resolves to the user’s bot ids with an escaped, case-insensitive match', async () => {
    let asked: any
    const r = await buildDealListFilter(
      {
        filterModel: {
          items: [{ field: 'botName', operator: 'contains', value: 'a.b' }],
        },
      },
      {
        botIdsByName: async (c) => {
          asked = c
          return ['b1', 'b2']
        },
      },
    )
    expect(asked['settings.name'].$regex.source).to.equal('a\\.b')
    expect(asked['settings.name'].$regex.flags).to.equal('i')
    expect(r.filter).to.deep.equal({ $and: [{ botId: { $in: ['b1', 'b2'] } }] })
  })

  it('cost filters the computed Cost column; equals honours the typed precision', async () => {
    const r = await build([{ field: 'cost', operator: '=', value: '150' }])
    const expr = (r.filter.$and as any[])[0].$expr.$and
    expect(expr[0].$gte[1]).to.equal(149.5)
    expect(expr[1].$lte[1]).to.equal(150.5)
    const b = await build([
      { field: 'cost', operator: 'between', value: ['100', ''] },
    ])
    expect((b.filter.$and as any[])[0].$expr.$gte[1]).to.equal(100)
  })

  it('status items replace the default and stay ANDed under OR; pair aliases symbol', async () => {
    const r = await build(
      [
        { field: 'status', operator: 'isAnyOf', value: ['closed'] },
        { field: 'pair', operator: 'equals', value: 'ETHUSDT' },
        { field: 'botName', operator: 'equals', value: 'Alpha' },
      ],
      { linkOperator: 'or' },
    )
    expect(r.statusFromItems).to.equal(true)
    const and = r.filter.$and as any[]
    expect(and[0]).to.deep.equal({ status: { $in: ['closed'] } })
    expect(and[1].$or).to.have.length(2)
    expect(and[1].$or[0]['symbol.symbol'].$regex.source).to.equal('^ETHUSDT$')
  })

  it('unknown fields keep the legacy DataGrid mapping', async () => {
    const r = await build([
      { field: 'exchange', operator: 'equals', value: 'binance' },
    ])
    expect(r.filter).to.deep.equal({ $and: [{ exchange: { $eq: 'binance' } }] })
    expect(r.statusFromItems).to.equal(false)
  })

  it('does not mutate the caller’s items', async () => {
    const item = { field: 'exchange', operator: 'equals', value: 'a b' }
    await build([item])
    expect(item.value).to.equal('a b')
  })
})
