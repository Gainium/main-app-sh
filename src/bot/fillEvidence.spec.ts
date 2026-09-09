process.env.NODE_ENV = 'testing'

/**
 * Unit tests for spec `028.venue-filled-with-no-fill-evidence` §4.1 (issue
 * #719).
 *
 * Pure module, no bot, no venue, no DB.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isFillEvidenceFree, statesQuantity } from './fillEvidence'

/**
 * The payload production actually received on 2026-09-08 for
 * `D-TP-137EO6y5r2vznkgosxjmnnvoYkEeSR` (ZRX-USDC, coinbase), as it reached
 * main-app: the connector's `+new Date(undefined)` NaNs arrive as `null` over
 * JSON, and the absent `filled_size`/`filled_value` arrive not at all.
 */
const EVIDENCE_FREE: any = {
  clientOrderId: 'D-TP-137EO6y5r2vznkgosxjmnnvoYkEeSR',
  status: 'FILLED',
  type: 'MARKET',
  side: 'BUY',
  price: '0',
  transactTime: null,
  updateTime: null,
  fills: [],
}

describe('fill evidence (spec 028, issue #719)', () => {
  describe('§4.1 isFillEvidenceFree', () => {
    it('is true for the payload that stranded the four deals', () => {
      expect(isFillEvidenceFree(EVIDENCE_FREE)).to.equal(true)
    })

    it('is true when the quantities are explicit zeroes and nothing else is stated', () => {
      expect(
        isFillEvidenceFree({
          ...EVIDENCE_FREE,
          executedQty: '0',
          cummulativeQuoteQty: '0',
        }),
      ).to.equal(true)
    })

    it('is true for the string "NaN", which is what a poisoned row persists', () => {
      expect(
        isFillEvidenceFree({
          ...EVIDENCE_FREE,
          executedQty: 'NaN',
          cummulativeQuoteQty: 'NaN',
        }),
      ).to.equal(true)
    })

    it('is FALSE as soon as any one of the four states something', () => {
      expect(
        isFillEvidenceFree({ ...EVIDENCE_FREE, executedQty: '237.37538' }),
        'executed quantity',
      ).to.equal(false)
      expect(
        isFillEvidenceFree({ ...EVIDENCE_FREE, cummulativeQuoteQty: '24.94' }),
        'executed value',
      ).to.equal(false)
      expect(
        isFillEvidenceFree({ ...EVIDENCE_FREE, updateTime: 1788873357668 }),
        'fill timestamp',
      ).to.equal(false)
      expect(
        isFillEvidenceFree({
          ...EVIDENCE_FREE,
          fills: [{ price: '0.105', qty: '237.3' }],
        }),
        'fills',
      ).to.equal(false)
    })

    it('is false for an ordinary fully filled Coinbase answer', () => {
      expect(
        isFillEvidenceFree({
          status: 'FILLED',
          executedQty: '237.37538',
          cummulativeQuoteQty: '24.9436',
          updateTime: 1788873357668,
          fills: [],
        }),
      ).to.equal(false)
    })
  })

  describe('§4.3 statesQuantity', () => {
    it('accepts a stated zero — a resting order really has executed nothing', () => {
      expect(statesQuantity('0')).to.equal(true)
      expect(statesQuantity(0)).to.equal(true)
    })

    it('rejects what the venue simply did not say', () => {
      expect(statesQuantity(undefined)).to.equal(false)
      expect(statesQuantity(null)).to.equal(false)
      expect(statesQuantity('')).to.equal(false)
      expect(statesQuantity('NaN')).to.equal(false)
      expect(statesQuantity(NaN)).to.equal(false)
      expect(statesQuantity(Infinity)).to.equal(false)
    })
  })
})
