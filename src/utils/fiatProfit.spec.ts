import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  dailyUnitsPerUsd,
  fiatPartFromUsd,
  profitByHourInc,
  reportingProfitExpr,
  utcDay,
} from './fiatProfit'
import { carryForwardDays } from './fxHistory'

const DAY = 24 * 60 * 60 * 1000
const D0 = Date.UTC(2026, 9, 1) // 2026-10-01

/**
 * Evaluates the subset of aggregation operators `reportingProfitExpr` emits,
 * so the expression is checked by value, not by shape.
 */
const evalExpr = (e: any, doc: Record<string, any>): any => {
  if (typeof e === 'number') return e
  if (Array.isArray(e)) return e.map((x) => evalExpr(x, doc))
  if (typeof e === 'string' && e.startsWith('$')) {
    return e
      .slice(1)
      .split('.')
      .reduce((o: any, k) => (o == null ? undefined : o[k]), doc)
  }
  const [op] = Object.keys(e)
  const a = e[op]
  const v = (x: any) => evalExpr(x, doc)
  switch (op) {
    case '$add':
      return a.map(v).reduce((x: number, y: number) => x + y, 0)
    case '$subtract':
      return v(a[0]) - v(a[1])
    case '$multiply':
      return a.map(v).reduce((x: number, y: number) => x * y, 1)
    case '$divide':
      return v(a[0]) / v(a[1])
    case '$ifNull':
      return v(a[0]) ?? v(a[1])
    case '$min':
      return Math.min(...a.map(v))
    case '$max':
      return Math.max(...a.map(v))
    case '$floor':
      return Math.floor(v(a))
    case '$toInt':
      return Math.trunc(v(a))
    case '$arrayElemAt':
      return a[0][v(a[1])]
    default:
      throw new Error(`unsupported ${op}`)
  }
}

describe('profitByHourInc', () => {
  it('books USD only for a stablecoin or crypto quote', () => {
    expect(profitByHourInc(12, { asset: 'USDT', amount: 12 })).to.deep.equal({
      profitUsd: 12,
    })
    expect(profitByHourInc(12, { asset: 'BTC', amount: 0.0002 })).to.deep.equal(
      { profitUsd: 12 },
    )
    expect(profitByHourInc(12)).to.deep.equal({ profitUsd: 12 })
  })
  it('never books USD as a fiat part — it already is profitUsd', () => {
    expect(profitByHourInc(5, { asset: 'USD', amount: 5 })).to.deep.equal({
      profitUsd: 5,
    })
  })
  it('keeps a EUR profit at face value beside its USD value', () => {
    expect(profitByHourInc(2200, { asset: 'eur', amount: 2000 })).to.deep.equal(
      {
        profitUsd: 2200,
        'profitFiat.EUR': 2000,
        'profitFiatUsd.EUR': 2200,
      },
    )
  })
  it('drops a non-finite fiat amount rather than poisoning the row', () => {
    expect(profitByHourInc(1, { asset: 'EUR', amount: NaN })).to.deep.equal({
      profitUsd: 1,
    })
  })
})

describe('fiatPartFromUsd', () => {
  it('undoes the rate the USD value was computed with', () => {
    expect(fiatPartFromUsd('EUR', 2200, 1.1)?.amount).to.be.closeTo(2000, 1e-9)
  })
  it('gives nothing for an unusable rate', () => {
    expect(fiatPartFromUsd('EUR', 2200, 0)).to.equal(undefined)
    expect(fiatPartFromUsd(undefined, 2200, 1.1)).to.equal(undefined)
  })
})

describe('dailyUnitsPerUsd', () => {
  const days = [
    { day: D0, usdRate: 1.25 }, // 0.8 EUR per USD
    { day: D0 + 3 * DAY, usdRate: 1 / 0.9 },
  ]
  it('carries the last known day across gaps', () => {
    const r = dailyUnitsPerUsd(days, D0, D0 + 4 * DAY, 0.95)
    expect(r.map((x) => +x.toFixed(4))).to.deep.equal([0.8, 0.8, 0.8, 0.9, 0.9])
  })
  it('uses the first stored day before history starts', () => {
    const r = dailyUnitsPerUsd(days, D0 - 2 * DAY, D0, 0.95)
    expect(r.map((x) => +x.toFixed(4))).to.deep.equal([0.8, 0.8, 0.8])
  })
  it('falls back to today’s rate when nothing is stored', () => {
    expect(dailyUnitsPerUsd([], D0, D0 + DAY, 0.95)).to.deep.equal([0.95, 0.95])
  })
})

describe('reportingProfitExpr', () => {
  // EUR per USD: 0.80 on day 0, 0.90 from day 2.
  const rates = [0.8, 0.8, 0.9, 0.9]
  const expr = reportingProfitExpr('EUR', rates, D0)

  it('shows a EUR deal at face value whatever the rates did since', () => {
    const row = {
      time: D0 + 5 * 3600_000,
      profitUsd: 2500,
      profitFiat: { EUR: 2000 },
      profitFiatUsd: { EUR: 2500 },
    }
    expect(evalExpr(expr, row)).to.be.closeTo(2000, 1e-9)
  })
  it('values a USDT deal at the rate of the day it closed, not today', () => {
    expect(
      evalExpr(expr, { time: D0 + 3600_000, profitUsd: 100 }),
    ).to.be.closeTo(80, 1e-9)
    expect(
      evalExpr(expr, { time: D0 + 2 * DAY + 1, profitUsd: 100 }),
    ).to.be.closeTo(90, 1e-9)
  })
  it('splits a mixed hour: EUR part at face, the rest at the day rate', () => {
    const row = {
      time: D0 + 2 * DAY,
      profitUsd: 1250 + 100,
      profitFiat: { EUR: 1000 },
      profitFiatUsd: { EUR: 1250 },
    }
    expect(evalExpr(expr, row)).to.be.closeTo(1000 + 90, 1e-9)
  })
  it('clamps rows outside the series to its ends', () => {
    expect(
      evalExpr(expr, { time: D0 - 30 * DAY, profitUsd: 10 }),
    ).to.be.closeTo(8, 1e-9)
    expect(
      evalExpr(expr, { time: D0 + 99 * DAY, profitUsd: 10 }),
    ).to.be.closeTo(9, 1e-9)
  })
  it('ignores another currency’s face part', () => {
    const row = {
      time: D0,
      profitUsd: 130,
      profitFiat: { GBP: 100 },
      profitFiatUsd: { GBP: 130 },
    }
    expect(evalExpr(expr, row)).to.be.closeTo(130 * 0.8, 1e-9)
  })
})

describe('carryForwardDays', () => {
  it('fills weekends with the previous business day', () => {
    const fri = utcDay(Date.UTC(2026, 10, 13))
    const mon = fri + 3 * DAY
    const series = new Map([
      [fri, { EUR: 1.1 }],
      [mon, { EUR: 1.2 }],
    ])
    const out = carryForwardDays(series, fri, mon)
    expect(out.map((d) => d.rates.EUR)).to.deep.equal([1.1, 1.1, 1.1, 1.2])
    expect(out[1].day).to.equal(fri + DAY)
  })
})
