process.env.NODE_ENV = 'testing'

/**
 * Unit checks for the base-funding planner (main-app spec 044 §6.1, §6.5).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  comboFeeOrderQty,
  hedgeActionFundingMode,
  planFunding,
  planHedgeFundingInOrder,
  planHedgeFundingJointly,
  planHedgeLegDealFunding,
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

describe('reservations in the existing plans (main-app spec 044 §8)', () => {
  it('planShortSpotDealFunding: base another deal reserves is not held', () => {
    const d = planShortSpotDealFunding({
      mode: BaseFundingEnum.auto,
      baseOrderQty: 1,
      safetyQty: 2,
      price: 100,
      freeBase: 3,
      freeQuote: 1000,
      reservedBase: 1.5,
      basePrecision: 3,
    })
    // 3 free would cover the deal; 1.5 of it backs a long leg's entry.
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.heldUsed).to.equal(1.5)
    expect(d.trade?.baseQty).to.equal(0.5)
  })

  it('planHedgeLegFunding: short held base and spendable quote are net of reserves', () => {
    const r = planHedgeLegFunding({
      isLong: false,
      action: ActionsEnum.buyDiff,
      orders: [{ qty: 2, price: 101, type: TypeOrderEnum.dealRegular }],
      price: 100,
      freeBase: 2,
      freeQuote: 300,
      reservedBase: 1,
      reservedQuote: 150,
      basePrecision: 3,
    })
    expect(r?.plan.held).to.equal(1)
    expect(r?.trade?.baseQty).to.equal(1)
    expect(r?.trade?.affordable).to.equal(true)
  })

  it('planHedgeLegFunding: long held quote is net of reserved quote', () => {
    const r = planHedgeLegFunding({
      isLong: true,
      action: ActionsEnum.sellDiff,
      orders: [{ qty: 1, price: 100, type: TypeOrderEnum.dealRegular }],
      price: 100,
      freeBase: 5,
      freeQuote: 100,
      reservedQuote: 60,
      basePrecision: 3,
    })
    expect(r?.plan.held).to.equal(40)
    expect(r?.trade?.side).to.equal(OrderSideEnum.sell)
    expect(r?.trade?.baseQty).to.equal(0.6)
  })
})

describe('planHedgeLegDealFunding (main-app spec 044 §8)', () => {
  const leg = {
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    price: 100,
    basePrecision: 3,
  }

  it('maps the actions onto the funding modes', () => {
    expect(hedgeActionFundingMode(ActionsEnum.buyDiff)).to.equal('auto')
    expect(hedgeActionFundingMode(ActionsEnum.sellDiff)).to.equal('auto')
    expect(hedgeActionFundingMode(ActionsEnum.buyForAll)).to.equal('botOnly')
    expect(hedgeActionFundingMode(ActionsEnum.sellForAll)).to.equal('botOnly')
    expect(hedgeActionFundingMode(ActionsEnum.useOppositeBalance)).to.equal(
      null,
    )
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: false,
        action: ActionsEnum.noAction,
        freeBase: 0,
        freeQuote: 1000,
      }).kind,
    ).to.equal('none')
  })

  it('short buyDiff: held base first, buys the shortfall, reserves the entry quote', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: false,
      action: ActionsEnum.buyDiff,
      freeBase: 1.5,
      freeQuote: 1000,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.mode).to.equal(BaseFundingEnum.auto)
    expect(d.trade?.side).to.equal(OrderSideEnum.buy)
    expect(d.trade?.baseQty).to.equal(0.5)
    expect(d.quoteReserved).to.equal(100)
    expect(d.baseReserved).to.equal(0)
    expect(d.spendNeeded).to.equal(150)
    expect(d.sourcedByBot).to.equal(false)
  })

  it('short buyForAll: buys every safety order even with base held', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: false,
      action: ActionsEnum.buyForAll,
      freeBase: 50,
      freeQuote: 1000,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.trade?.baseQty).to.equal(2)
    expect(d.sourcedByBot).to.equal(true)
  })

  it('short: refused in quote when the reserve plus the buy do not fit', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: false,
      action: ActionsEnum.buyDiff,
      freeBase: 0,
      freeQuote: 400,
      reservedQuote: 150,
    })
    expect(d).to.deep.equal({
      kind: 'refuse',
      asset: 'quote',
      required: 300,
      available: 250,
      need: { asset: 'base', required: 2, held: 0 },
    })
  })

  it('long sellDiff: held quote first, sells base for the shortfall, reserves the entry base', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.sellDiff,
      freeBase: 5,
      freeQuote: 50,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.needAsset).to.equal('quote')
    expect(d.trade?.side).to.equal(OrderSideEnum.sell)
    expect(d.trade?.baseQty).to.equal(1.5)
    expect(d.baseReserved).to.equal(1)
    expect(d.quoteReserved).to.equal(0)
    expect(d.spendNeeded).to.equal(2.5)
    expect(d.sourcedByBot).to.equal(false)
  })

  it('long sellForAll: sells for the whole need', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.sellForAll,
      freeBase: 5,
      freeQuote: 1000,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.trade?.baseQty).to.equal(2)
  })

  it('long: refused in base when the entry is not backed by held base', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.sellDiff,
      freeBase: 0.5,
      freeQuote: 200,
    })
    expect(d).to.deep.include({
      kind: 'refuse',
      asset: 'base',
      required: 1,
      available: 0.5,
    })
  })

  it('long: base another deal reserves cannot back the entry', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.sellDiff,
      freeBase: 1.5,
      freeQuote: 200,
      reservedBase: 1,
    })
    expect(d.kind).to.equal('refuse')
  })

  it('a fee taken from the received asset grosses the trade up', () => {
    const d = planHedgeLegDealFunding({
      ...leg,
      isLong: false,
      action: ActionsEnum.buyForAll,
      freeBase: 0,
      freeQuote: 1000,
      feeRate: 0.001,
    })
    if (d.kind !== 'fund') throw new Error(d.kind)
    expect(d.trade?.baseQty).to.equal(2.003)
  })
})

describe('held path and non-funding legs (main-app spec 044 §8, decision 5)', () => {
  const leg = {
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    price: 100,
    basePrecision: 3,
  }

  it('short buyDiff fully covered by held base: no trade, real base order', () => {
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: false,
        action: ActionsEnum.buyDiff,
        freeBase: 3,
        freeQuote: 0,
      }),
    ).to.deep.equal({ kind: 'held', needAsset: 'base', required: 3, held: 3 })
  })

  it('long sellDiff fully covered by held quote: no trade, real base order', () => {
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: true,
        action: ActionsEnum.sellDiff,
        freeBase: 0,
        freeQuote: 300,
      }),
    ).to.deep.equal({
      kind: 'held',
      needAsset: 'quote',
      required: 300,
      held: 300,
    })
  })

  it('ForAll never falls back to held', () => {
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: false,
        action: ActionsEnum.buyForAll,
        freeBase: 50,
        freeQuote: 1000,
      }).kind,
    ).to.equal('fund')
  })

  it('reservations of other deals count against the held path', () => {
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: false,
        action: ActionsEnum.buyDiff,
        freeBase: 3,
        freeQuote: 1000,
        reservedBase: 0.5,
      }).kind,
    ).to.equal('fund')
  })

  it('useBalance consumes base order + safety orders, or is refused', () => {
    const ok = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.useBalance,
      freeBase: 0,
      freeQuote: 300,
    })
    expect(ok).to.deep.include({ kind: 'held', required: 300 })
    const no = planHedgeLegDealFunding({
      ...leg,
      isLong: true,
      action: ActionsEnum.useBalance,
      freeBase: 0,
      freeQuote: 299,
    })
    expect(no).to.deep.include({ kind: 'refuse', asset: 'quote' })
  })

  it('a funding action without DCA is a real base order on held funds', () => {
    expect(
      planHedgeLegDealFunding({
        ...leg,
        isLong: false,
        action: ActionsEnum.buyDiff,
        useDca: false,
        freeBase: 1,
        freeQuote: 0,
      }),
    ).to.deep.equal({ kind: 'held', needAsset: 'base', required: 1, held: 1 })
  })

  it('useOppositeBalance and noAction spend nothing of the account', () => {
    for (const action of [
      ActionsEnum.useOppositeBalance,
      ActionsEnum.noAction,
    ]) {
      expect(
        planHedgeLegDealFunding({
          ...leg,
          isLong: false,
          action,
          freeBase: 0,
          freeQuote: 0,
        }).kind,
      ).to.equal('none')
    }
  })
})

describe('comboFeeOrderQty (main-app spec 044 §8, D8)', () => {
  const base = { price: 100, minNotional: 5, minBase: 0.001, basePrecision: 3 }
  it('0 without a fee order or a maker fee', () => {
    expect(
      comboFeeOrderQty({
        ...base,
        feeOrder: false,
        makerFee: 0.001,
        maxLevelQty: 1,
      }),
    ).to.equal(0)
    expect(
      comboFeeOrderQty({
        ...base,
        feeOrder: true,
        makerFee: 0,
        maxLevelQty: 1,
      }),
    ).to.equal(0)
  })
  it('at least the exchange minimum with head-room, rounded up', () => {
    // 5 / 100 × 1.05 = 0.0525 → 0.053 > 1 × 0.001 × 10
    expect(
      comboFeeOrderQty({
        ...base,
        feeOrder: true,
        makerFee: 0.001,
        maxLevelQty: 1,
      }),
    ).to.equal(0.053)
  })
  it('scales with the largest level', () => {
    expect(
      comboFeeOrderQty({
        ...base,
        feeOrder: true,
        makerFee: 0.001,
        maxLevelQty: 20,
      }),
    ).to.equal(0.2)
  })
})

describe('planHedgeFundingInOrder / planHedgeFundingJointly (main-app spec 044 §8.5)', () => {
  const short = {
    isLong: false,
    action: ActionsEnum.buyDiff,
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    useDca: true,
  }
  const long = {
    isLong: true,
    action: ActionsEnum.sellDiff,
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    useDca: true,
  }
  const common = { price: 100, basePrecision: 3 }

  it('in order: the second leg sees what the first spent, committed and reserved', () => {
    const [s, l] = planHedgeFundingInOrder({
      ...common,
      legs: [short, long],
      freeBase: 1,
      freeQuote: 250,
    })
    // Short: 1 held + buys 1 (100), reserves 100; 150 → 50 quote left.
    if (s.decision.kind !== 'fund') throw new Error(s.decision.kind)
    expect(s.decision.trade?.baseQty).to.equal(1)
    // Long: no base left for its entry.
    expect(l.decision.kind).to.equal('refuse')
  })

  it('jointly: each leg gets its worse outcome over both start orders', () => {
    const at = { ...common, freeBase: 1, freeQuote: 400 }
    // Long first: its 400 quote cover it on held funds (300), and the short
    // is then short of quote. Short first: the short reserves 100 and buys
    // 1 SOL; the long is then on the fund path with no base for its entry.
    const longFirst = planHedgeFundingInOrder({ ...at, legs: [long, short] })
    const shortFirst = planHedgeFundingInOrder({ ...at, legs: [short, long] })
    expect(longFirst.map((p) => p.decision.kind)).to.deep.equal([
      'held',
      'refuse',
    ])
    expect(shortFirst.map((p) => p.decision.kind)).to.deep.equal([
      'fund',
      'refuse',
    ])
    const planned = planHedgeFundingJointly({ ...at, legs: [long, short] })
    expect(planned.map((p) => p.input.isLong)).to.deep.equal([false, true])
    expect(planned.map((p) => p.decision.kind)).to.deep.equal([
      'refuse',
      'refuse',
    ])
  })

  it('jointly OK ⇒ OK in either order', () => {
    const planned = planHedgeFundingJointly({
      ...common,
      legs: [short, long],
      freeBase: 4,
      freeQuote: 1000,
    })
    expect(planned.every((p) => p.decision.kind !== 'refuse')).to.equal(true)
    for (const legs of [
      [short, long],
      [long, short],
    ]) {
      expect(
        planHedgeFundingInOrder({
          ...common,
          legs,
          freeBase: 4,
          freeQuote: 1000,
        }).every((p) => p.decision.kind !== 'refuse'),
      ).to.equal(true)
    }
  })

  it('a non-funding leg consumes its real orders in the joint plan', () => {
    const [s, l] = planHedgeFundingJointly({
      ...common,
      legs: [{ ...long, action: ActionsEnum.useBalance }, short],
      freeBase: 0,
      freeQuote: 300,
    })
    expect(s.decision.kind).to.equal('refuse')
    expect(l.decision.kind).to.equal('refuse')
  })

  it('a leg without DCA consumes only its real base order', () => {
    const [s] = planHedgeFundingInOrder({
      ...common,
      legs: [{ ...short, useDca: false }],
      freeBase: 1,
      freeQuote: 0,
    })
    expect(s.decision).to.deep.include({ kind: 'held', required: 1 })
  })

  it('account reservations apply to both legs', () => {
    const [s] = planHedgeFundingJointly({
      ...common,
      legs: [long, short],
      freeBase: 0,
      freeQuote: 350,
      reservedQuote: 100,
    })
    expect(s.decision).to.deep.include({ kind: 'refuse', available: 250 })
  })
})

describe('buy headroom on quote-sized venues (main-app spec 044 §8, fix round 3)', () => {
  it('grosses up a funding buy, not a sell', () => {
    const buy = planFunding({
      needAsset: 'base',
      required: 2,
      held: 0,
      price: 100,
      basePrecision: 3,
      buyHeadroom: 0.005,
    })
    expect(buy.diff?.baseQty).to.equal(2.01)
    const sell = planFunding({
      needAsset: 'quote',
      required: 200,
      held: 0,
      price: 100,
      basePrecision: 3,
      buyHeadroom: 0.005,
    })
    expect(sell.diff?.baseQty).to.equal(2)
  })
})
