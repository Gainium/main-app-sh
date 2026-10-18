/**
 * Adversarial review of spec 044 phase 3 — pure planner and lock (2026-10-18).
 * A FAILING case demonstrates a defect (see phase3-review.md).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  HedgeLegFundingDecision,
  planHedgeFundingJointly,
  planHedgeLegDealFunding,
} from './baseFunding'
import { FundingLock, MemoryFundingLockStore } from './fundingLock'
import { ActionsEnum } from '../../types'

const limits = { price: 100, minNotional: 5, minBase: 0.001, basePrecision: 3 }
const SHORT = {
  isLong: false,
  action: ActionsEnum.buyDiff,
  baseOrderQty: 1,
  safetyQty: 2,
  safetyQuote: 0,
  useDca: true,
}
const LONG = {
  isLong: true,
  action: ActionsEnum.sellDiff,
  baseOrderQty: 1,
  safetyQty: 0,
  safetyQuote: 197,
  useDca: true,
}

/** What the engine does when the LONG leg wins the funding lock. */
const engineLongFirst = (freeBase: number, freeQuote: number) => {
  const long = planHedgeLegDealFunding({ ...LONG, ...limits, freeBase, freeQuote })
  const pend = long.kind === 'fund' ? long : null
  const short = planHedgeLegDealFunding({
    ...SHORT,
    ...limits,
    freeBase,
    freeQuote,
    reservedBase: pend?.baseReserved ?? 0,
    reservedQuote: pend ? pend.required : 0,
  })
  return { long, short }
}

describe('Spec 044 phase 3 — adversarial review (planner)', () => {
  // Fix round 1: was "[BUG] … refuses a leg the engine funds". Expectations
  // changed per coordinator decision 5 (a *Diff leg its held funds cover runs
  // on them: `held`, not `fund`) and 3+4 (the preview reports each leg's worse
  // outcome over both start orders): the property under test is unchanged —
  // the preview must not refuse a leg the engine opens in either order.
  it('previewHedgeFunding does not refuse a leg the engine opens in either order', () => {
    const preview = planHedgeFundingJointly({
      legs: [LONG, SHORT],
      freeBase: 1,
      freeQuote: 1000,
      ...limits,
    })
    const engine = engineLongFirst(1, 1000)
    expect(engine.long.kind).to.not.equal('refuse')
    expect(engine.short.kind).to.not.equal('refuse')
    const previewLong = preview.find((p) => p.input.isLong)!.decision
    expect(previewLong.kind).to.not.equal('refuse')
  })

  it('joint preview counts what a useBalance leg (the dialog default when quote covers it) spends', () => {
    // 300 USDT, no SOL. Dialog defaults: long = useBalance (300 ≥ 100 + 197),
    // short = buyDiff (no SOL). The long's real orders spend 297, the short
    // needs 100 reserve + 200 buy: 597 of 300.
    const preview = planHedgeFundingJointly({
      legs: [
        { ...LONG, action: ActionsEnum.useBalance },
        { ...SHORT, action: ActionsEnum.buyDiff },
      ],
      freeBase: 0,
      freeQuote: 300,
      ...limits,
    })
    const short = preview.find((p) => !p.input.isLong)!.decision
    expect(short.kind).to.not.equal('fund')
  })

  it('short buyDiff with the deal fully covered by held base but no quote runs on held base', () => {
    const d: HedgeLegFundingDecision = planHedgeLegDealFunding({
      ...SHORT,
      ...limits,
      freeBase: 10,
      freeQuote: 0,
    })
    expect(d.kind).to.not.equal('refuse')
  })

  it('long sellDiff with ample quote but no base runs on held quote', () => {
    const d = planHedgeLegDealFunding({
      ...LONG,
      ...limits,
      freeBase: 0,
      freeQuote: 100000,
    })
    expect(d.kind).to.not.equal('refuse')
  })

  it('stress: joint plan never commits more than the account holds (random grid)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 2000; i++) {
      const freeBase = +(rnd() * 5).toFixed(3)
      const freeQuote = +(rnd() * 800).toFixed(2)
      const actS = rnd() < 0.5 ? ActionsEnum.buyDiff : ActionsEnum.buyForAll
      const actL = rnd() < 0.5 ? ActionsEnum.sellDiff : ActionsEnum.sellForAll
      const planned = planHedgeFundingJointly({
        legs: [
          { ...LONG, action: actL, baseOrderQty: +(rnd() * 2).toFixed(3) },
          { ...SHORT, action: actS, safetyQty: +(rnd() * 3).toFixed(3) },
        ],
        freeBase,
        freeQuote,
        ...limits,
      })
      let base = freeBase
      let quote = freeQuote
      let resBase = 0
      let resQuote = 0
      for (const { decision: d } of planned) {
        if (d.kind !== 'fund') continue
        if (d.trade?.side === 'BUY') {
          quote -= d.trade.quoteValue
          base += d.trade.baseQty
        } else if (d.trade) {
          base -= d.trade.baseQty
          quote += d.trade.quoteValue
        }
        if (d.needAsset === 'base') resBase += d.required
        else resQuote += d.required
        resBase += d.baseReserved
        resQuote += d.quoteReserved
      }
      expect(base + 1e-6, `case ${i}`).to.be.gte(resBase)
      expect(quote + 1e-6, `case ${i}`).to.be.gte(resQuote)
    }
  })
})

describe('Spec 044 phase 3 — adversarial review (lock)', () => {
  it('a section that outlives the TTL stays exclusive (renewed while it runs)', async () => {
    const lock = new FundingLock()
    lock.setStore(new MemoryFundingLockStore())
    lock.ttlMs = 30
    lock.waitMs = 2000
    let inside = 0
    let maxInside = 0
    const section = async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      // A market funding order acknowledged slowly (paper ≈ 40 s vs 60 s TTL).
      await new Promise((r) => setTimeout(r, 120))
      inside--
    }
    await Promise.all([lock.run('acc', section), lock.run('acc', section)])
    expect(maxInside).to.equal(1)
  })
})

describe('Spec 044 phase 3 — adversarial review pass 2 (lock)', () => {
  it('a holder whose section never returns keeps the lock forever (heartbeat with no max hold)', async () => {
    const lock = new FundingLock()
    const store = new MemoryFundingLockStore()
    lock.setStore(store)
    lock.ttlMs = 30
    lock.waitMs = 300
    let release: () => void = () => undefined
    const hung = lock.run(
      'acc-hang',
      () => new Promise<void>((r) => (release = r)),
    )
    await new Promise((r) => setTimeout(r, 20))
    try {
      // A dead process would have let it expire after 30 ms; a hung awaited
      // venue call renews it every 10 ms, indefinitely.
      const next = await lock.run('acc-hang', async () => 'ran')
      expect(next.acquired).to.equal(true)
    } finally {
      release()
      await hung
    }
  })

  it('heartbeat: a store that stops answering makes owned() false (fail-closed) and the timer stops at release', async () => {
    const lock = new FundingLock()
    const mem = new MemoryFundingLockStore()
    let down = false
    lock.setStore({
      setNxPx: (k, v, t) => mem.setNxPx(k, v, t),
      delIfValue: (k, v) => mem.delIfValue(k, v),
      pexpireIfValue: async (k, v, t) =>
        down ? undefined : mem.pexpireIfValue(k, v, t),
    })
    lock.ttlMs = 60
    const r = await lock.run('acc-blip', async (lease) => {
      const before = await lease.owned()
      down = true
      const during = await lease.owned()
      down = false
      const after = await lease.owned()
      return [before, during, after]
    })
    expect(r).to.deep.equal({ acquired: true, value: [true, false, true] })
    expect(mem.held(lock.key('acc-blip'))).to.equal(false)
  })
})

describe('Spec 044 phase 3 — adversarial review pass 3 (max hold)', () => {
  it('a hung holder past the max hold frees the account, and its late release never deletes the next holder', async () => {
    const lock = new FundingLock()
    const store = new MemoryFundingLockStore()
    lock.setStore(store)
    lock.ttlMs = 30
    lock.waitMs = 2000
    let release: () => void = () => undefined
    const hung = lock.run('acc-max', () => new Promise<void>((r) => (release = r)), 'hung')
    await new Promise((r) => setTimeout(r, 5))
    const t0 = Date.now()
    let inside = 0
    let max = 0
    const section = async () => {
      inside++
      max = Math.max(max, inside)
      if (inside === 1) {
        // While the next holder runs, the hung one finally returns.
        release()
        await hung
      }
      await new Promise((r) => setTimeout(r, 120))
      inside--
    }
    const [a, b] = await Promise.all([
      lock.run('acc-max', section, 'next'),
      (async () => {
        await new Promise((r) => setTimeout(r, 220))
        return lock.run('acc-max', section, 'third')
      })(),
    ])
    expect(a.acquired && b.acquired).to.equal(true)
    // Freed within max hold (4 × 30) + one TTL + polling slack.
    expect(Date.now() - t0).to.be.lessThan(1500)
    expect(max).to.equal(1)
    expect(store.held(lock.key('acc-max'))).to.equal(false)
  })
})
