process.env.NODE_ENV = 'testing'

/**
 * Unit checks for the base-funding planner (main-app spec 044 §6.1, §6.5).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  planFunding,
  planHedgeLegFunding,
  planShortSpotDealFunding,
} from './baseFunding'
import {
  ActionsEnum,
  BaseFundingEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../types'

describe('planFunding (main-app spec 044)', () => {
  const base = {
    needAsset: 'base' as const,
    price: 100,
    basePrecision: 4,
  }

  it('covered when the held balance meets the requirement', () => {
    const p = planFunding({ ...base, required: 1, held: 1.5 })
    expect(p.status).to.equal('covered')
    expect(p.shortfall).to.equal(0)
    expect(p.surplus).to.equal(0.5)
    expect(p.diff).to.equal(null)
    expect(p.all?.baseQty).to.equal(1)
  })

  it('partial: the diff trade buys only the shortfall', () => {
    const p = planFunding({ ...base, required: 0.05, held: 0.032 })
    expect(p.status).to.equal('partial')
    expect(p.shortfall).to.be.closeTo(0.018, 1e-12)
    expect(p.diff?.side).to.equal(OrderSideEnum.buy)
    expect(p.diff?.baseQty).to.equal(0.018)
    expect(p.all?.baseQty).to.equal(0.05)
  })

  it('missing when nothing is held', () => {
    expect(planFunding({ ...base, required: 1, held: 0 }).status).to.equal(
      'missing',
    )
  })

  it('counts what is already locked in the bot’s own orders', () => {
    const p = planFunding({ ...base, required: 1, held: 0.4, inOrders: 0.5 })
    expect(p.shortfall).to.be.closeTo(0.1, 1e-12)
  })

  it('grosses up for a fee taken from the received asset and rounds up', () => {
    const p = planFunding({ ...base, required: 1, held: 0, feeRate: 0.001 })
    // 1 / 0.999 = 1.001001… → 1.0011 at 4 dp, rounded UP
    expect(p.all?.baseQty).to.equal(1.0011)
  })

  it('raises a trade below the exchange minimum with head-room', () => {
    const p = planFunding({
      ...base,
      required: 0.03,
      held: 0.029,
      minNotional: 5,
    })
    // 0.001 × 100 = 0.1 < 5 → 5 / 100 × 1.005 = 0.05025
    expect(p.diff?.raisedToMin).to.equal(true)
    expect(p.diff?.baseQty).to.equal(0.0503)
  })

  it('a quote need sells base worth it', () => {
    const p = planFunding({
      needAsset: 'quote',
      required: 500,
      held: 200,
      price: 100,
      basePrecision: 4,
      spendable: 2,
    })
    expect(p.diff?.side).to.equal(OrderSideEnum.sell)
    expect(p.diff?.baseQty).to.equal(3)
    expect(p.diff?.affordable).to.equal(false)
    expect(p.all?.baseQty).to.equal(5)
  })

  it('affordability is checked against the spent asset', () => {
    const p = planFunding({ ...base, required: 1, held: 0, spendable: 99 })
    expect(p.all?.affordable).to.equal(false)
    const q = planFunding({ ...base, required: 1, held: 0, spendable: 100 })
    expect(q.all?.affordable).to.equal(true)
    expect(planFunding({ ...base, required: 1, held: 0 }).all?.affordable).to.be
      .null
  })

  it('never plans a trade at a zero or non-finite price', () => {
    const p = planFunding({ ...base, price: 0, required: 1, held: 0 })
    expect(p.diff).to.equal(null)
    expect(p.all).to.equal(null)
    const q = planFunding({ ...base, required: NaN, held: 0 })
    expect(q.required).to.equal(0)
    expect(q.all).to.equal(null)
  })
})

describe('planHedgeLegFunding (main-app spec 044 §6.5)', () => {
  // Two safety orders and the TP row createInitialDealOrders returns for DCA.
  const orders = [
    { qty: 0.01, price: 110, type: TypeOrderEnum.dealRegular },
    { qty: 0.02, price: 120, type: TypeOrderEnum.dealRegular },
    { qty: 0.01, price: 95, type: TypeOrderEnum.dealTP },
  ]
  const common = { orders, price: 100, basePrecision: 4 }

  it('short buyDiff: buys the base shortfall even when quote is plentiful', () => {
    // The old copy compared against free QUOTE: 0.04 × 100 − 10000 < 0 → nothing.
    const r = planHedgeLegFunding({
      ...common,
      isLong: false,
      action: ActionsEnum.buyDiff,
      freeBase: 0.005,
      freeQuote: 10000,
    })
    expect(r?.trade?.side).to.equal(OrderSideEnum.buy)
    expect(r?.trade?.baseQty).to.equal(0.025)
    expect(r?.trade?.affordable).to.equal(true)
  })

  it('short buyForAll: the safety orders only — the TP row is excluded', () => {
    const r = planHedgeLegFunding({
      ...common,
      isLong: false,
      action: ActionsEnum.buyForAll,
      freeBase: 1,
      freeQuote: 10000,
    })
    expect(r?.plan.required).to.be.closeTo(0.03, 1e-12)
    expect(r?.trade?.baseQty).to.equal(0.03)
  })

  it('long sellDiff: sells base worth the quote shortfall', () => {
    // Safety quote = 0.01×110 + 0.02×120 = 3.5; free 1.5 → short 2 → 0.02 base
    const r = planHedgeLegFunding({
      ...common,
      isLong: true,
      action: ActionsEnum.sellDiff,
      freeBase: 1,
      freeQuote: 1.5,
    })
    expect(r?.trade?.side).to.equal(OrderSideEnum.sell)
    expect(r?.trade?.baseQty).to.equal(0.02)
  })

  it('long sellForAll: base worth the whole safety quote', () => {
    const r = planHedgeLegFunding({
      ...common,
      isLong: true,
      action: ActionsEnum.sellForAll,
      freeBase: 1,
      freeQuote: 1000,
    })
    expect(r?.trade?.baseQty).to.equal(0.035)
  })

  it('a diff with nothing short places no trade', () => {
    const r = planHedgeLegFunding({
      ...common,
      isLong: false,
      action: ActionsEnum.buyDiff,
      freeBase: 1,
      freeQuote: 0,
    })
    expect(r?.plan.status).to.equal('covered')
    expect(r?.trade).to.equal(null)
  })

  it('non-funding actions return null', () => {
    for (const action of [
      ActionsEnum.useBalance,
      ActionsEnum.useOppositeBalance,
      ActionsEnum.noAction,
    ]) {
      expect(
        planHedgeLegFunding({
          ...common,
          isLong: false,
          action,
          freeBase: 0,
          freeQuote: 0,
        }),
      ).to.equal(null)
    }
  })
})

describe('planShortSpotDealFunding (main-app spec 044 §2.1)', () => {
  // Base order 1, safety orders 2, at 100: the reserve is 100 quote.
  const deal = {
    baseOrderQty: 1,
    safetyQty: 2,
    price: 100,
    basePrecision: 3,
  }

  it('require (or missing) leaves the deal to the old balance check', () => {
    for (const mode of [BaseFundingEnum.require, undefined as any]) {
      expect(
        planShortSpotDealFunding({
          ...deal,
          mode,
          freeBase: 0,
          freeQuote: 1e6,
        }).kind,
      ).to.equal('held')
    }
  })

  it('auto with enough base for the whole deal sells it as before', () => {
    expect(
      planShortSpotDealFunding({
        ...deal,
        mode: BaseFundingEnum.auto,
        freeBase: 3,
        freeQuote: 0,
      }).kind,
    ).to.equal('held')
  })

  it('auto with no base: virtual base order, buys every safety order', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.auto,
      freeBase: 0,
      freeQuote: 1000,
    })
    expect(d.kind).to.equal('fund')
    if (d.kind !== 'fund') return
    expect(d.virtualEntryQty).to.equal(1)
    expect(d.quoteReserved).to.equal(100)
    expect(d.trade?.side).to.equal(OrderSideEnum.buy)
    expect(d.trade?.baseQty).to.equal(2)
    expect(d.quoteNeeded).to.equal(300)
    expect(d.sourcedByBot).to.equal(true)
  })

  it('auto with some base: it goes to the safety orders, the rest is bought', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.auto,
      freeBase: 1.5,
      freeQuote: 1000,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.heldUsed).to.equal(1.5)
    expect(d.trade?.baseQty).to.equal(0.5)
    expect(d.sourcedByBot).to.equal(false)
  })

  it('auto with base covering the safety orders only: no trade, virtual entry', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.auto,
      freeBase: 2,
      freeQuote: 100,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.trade).to.equal(null)
    expect(d.quoteNeeded).to.equal(100)
  })

  it('botOnly never counts the free base', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.botOnly,
      freeBase: 50,
      freeQuote: 1000,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.heldUsed).to.equal(0)
    expect(d.trade?.baseQty).to.equal(2)
    expect(d.sourcedByBot).to.equal(true)
  })

  it('refuses when the quote cannot cover the reserve plus the buy', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.auto,
      freeBase: 0,
      freeQuote: 299,
    })
    expect(d).to.deep.equal({ kind: 'refuse', required: 300, available: 299 })
  })

  it('quote other funded deals reserve is not available', () => {
    const d = planShortSpotDealFunding({
      ...deal,
      mode: BaseFundingEnum.auto,
      freeBase: 0,
      freeQuote: 1000,
      reservedQuote: 800,
    })
    expect(d).to.deep.equal({ kind: 'refuse', required: 300, available: 200 })
  })

  it('a zero price is not this planner’s call', () => {
    expect(
      planShortSpotDealFunding({
        ...deal,
        price: 0,
        mode: BaseFundingEnum.auto,
        freeBase: 0,
        freeQuote: 0,
      }).kind,
    ).to.equal('held')
  })
})
