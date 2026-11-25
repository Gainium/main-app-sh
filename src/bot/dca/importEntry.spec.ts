/**
 * Spec `specs/262…` — the pure import-entry checks. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  entryQtyMovesPosition,
  importEntryRefusalMessage,
  importEntryUsable,
} from './importEntry'

describe('import entry checks (spec 262)', () => {
  it('§1.2.1 a size that rounds down to 0 is unusable', () => {
    expect(importEntryUsable(0, 77461.4)).to.equal(false)
  })
  it('§1.2.2 a NaN quantity or a price of 0 is unusable', () => {
    expect(importEntryUsable(NaN, 0)).to.equal(false)
    expect(importEntryUsable(1, 0)).to.equal(false)
    expect(importEntryUsable(Infinity, 1)).to.equal(false)
    expect(importEntryUsable(-0.001, 1)).to.equal(false)
  })
  it('§1.4 a real quantity at a real price is usable', () => {
    expect(importEntryUsable(0.001, 77461.4)).to.equal(true)
  })
  it('§1.3.3 only a finite quantity above zero moves a position', () => {
    expect(entryQtyMovesPosition(0)).to.equal(false)
    expect(entryQtyMovesPosition(NaN)).to.equal(false)
    expect(entryQtyMovesPosition(0.001)).to.equal(true)
  })
  it('§1.3.1 the message names the size, price and quantity', () => {
    const m = importEntryRefusalMessage({
      symbol: 'BTCUSDT',
      size: '10',
      sizeAsset: 'USDT',
      price: '77461.4',
      qty: 0,
    })
    expect(m).to.contain('BTCUSDT')
    expect(m).to.contain('10 USDT')
    expect(m).to.contain('77461.4')
    expect(
      importEntryRefusalMessage({
        symbol: 'X',
        size: 1,
        sizeAsset: 'USD',
        price: 0,
        qty: NaN,
      }),
    ).to.contain('quantity of none')
  })
})
