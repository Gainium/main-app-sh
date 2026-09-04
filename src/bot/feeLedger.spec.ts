process.env.NODE_ENV = 'testing'

/**
 * Spec: specs/006.fee-ledger-and-usd-pnl.md §2.1/§2.2.
 *
 * Run: `npm test` (mocha).
 *
 * `feeLedger.ts` does not exist yet — these fail on the import, which is
 * the correct red: the module this spec describes has not been built.
 *
 * `observedFeeLegs` is deliberately a superset of `orderFee.ts`'s
 * `observedFeeSplit`: where `observedFeeSplit` returns `null` the moment any
 * leg can't be matched to the pair (so a caller never books a partial cost
 * as a complete one), `observedFeeLegs` reports every leg, on-pair or not,
 * because the fee ledger's job is the opposite one — a complete record of
 * every asset a fee was ever paid in, including the ones `observedFeeSplit`
 * has to discard.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { accrueFeeLedger, observedFeeLegs } from './feeLedger'

const order = (over: Record<string, unknown>) =>
  ({ baseAsset: 'BTC', quoteAsset: 'USDT', ...over }) as any

describe('feeLedger', () => {
  describe('observedFeeLegs — on-pair, same cases orderFee.spec.ts books', () => {
    it('feeSide quote → one leg on the quote asset', () => {
      expect(observedFeeLegs(order({ feePaid: '0.6', feeSide: 'quote' }))).to.deep.equal([
        { asset: 'USDT', amount: 0.6 },
      ])
    })
    it('feeAsset matching base → one leg on the base asset', () => {
      expect(observedFeeLegs(order({ feePaid: '0.001', feeAsset: 'BTC' }))).to.deep.equal([
        { asset: 'BTC', amount: 0.001 },
      ])
    })
  })

  describe('observedFeeLegs — off-pair, the case observedFeeSplit has to discard', () => {
    it('a BNB fee is its own leg, not discarded', () => {
      expect(observedFeeLegs(order({ feePaid: '0.0007', feeAsset: 'BNB' }))).to.deep.equal([
        { asset: 'BNB', amount: 0.0007 },
      ])
    })
    it('a KCS fee is its own leg', () => {
      expect(observedFeeLegs(order({ feePaid: '0.004', feeAsset: 'KCS' }))).to.deep.equal([
        { asset: 'KCS', amount: 0.004 },
      ])
    })
  })

  describe('observedFeeLegs — a mixed breakdown reports every leg, not just the on-pair ones', () => {
    it('one off-pair leg alongside one on-pair leg → both reported', () => {
      expect(
        observedFeeLegs(
          order({
            feeBreakdown: [
              { asset: 'BNB', amount: '0.0003' },
              { asset: 'USDT', amount: '0.05' },
            ],
          }),
        ),
      ).to.deep.equal([
        { asset: 'BNB', amount: 0.0003 },
        { asset: 'USDT', amount: 0.05 },
      ])
    })
    it('a breakdown wholly on the pair → both legs reported (superset of observedFeeSplit)', () => {
      expect(
        observedFeeLegs(
          order({
            feeBreakdown: [
              { asset: 'USDT', amount: '0.05' },
              { asset: 'BTC', amount: '0.0001' },
            ],
          }),
        ),
      ).to.deep.equal([
        { asset: 'USDT', amount: 0.05 },
        { asset: 'BTC', amount: 0.0001 },
      ])
    })
  })

  describe('observedFeeLegs — nothing observed → no legs', () => {
    const cases: [string, any][] = [
      ['no fee fields', {}],
      ['zero fee', { feePaid: '0', feeAsset: 'USDT' }],
      ['fee with no currency', { feePaid: '1' }],
    ]
    for (const [label, over] of cases) {
      it(`${label} → []`, () => {
        expect(observedFeeLegs(order(over))).to.deep.equal([])
      })
    }
    it('a null order → []', () => {
      expect(observedFeeLegs(null as any)).to.deep.equal([])
    })
  })

  describe('accrueFeeLedger — one entry per asset, profitByAssets shape', () => {
    it('the first contribution for an asset starts its entry', () => {
      expect(accrueFeeLedger(undefined, 'BNB', 0.001, 250)).to.deep.equal([
        { asset: 'BNB', total: 0.001, totalUsd: 0.25 },
      ])
    })
    it('a second contribution for the same asset adds to it', () => {
      const ledger = accrueFeeLedger(undefined, 'BNB', 0.001, 250)
      expect(accrueFeeLedger(ledger, 'BNB', 0.002, 260)).to.deep.equal([
        { asset: 'BNB', total: 0.003, totalUsd: 0.25 + 0.002 * 260 },
      ])
    })
    it('a contribution for a different asset is a separate entry, existing ones untouched', () => {
      const ledger = accrueFeeLedger(undefined, 'BNB', 0.001, 250)
      expect(accrueFeeLedger(ledger, 'USDT', 0.05, 1)).to.deep.equal([
        { asset: 'BNB', total: 0.001, totalUsd: 0.25 },
        { asset: 'USDT', total: 0.05, totalUsd: 0.05 },
      ])
    })
  })
})
