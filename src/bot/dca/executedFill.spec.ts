process.env.NODE_ENV = 'testing'

/**
 * Unit checks for spec `029` §4.1–§4.3, pinned to the real production row
 * shapes on combo deal `6aa0060c…` (VVV-USDC, coinbase).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { executedFillQty } from './executedFill'

describe('executedFillQty (spec 029)', () => {
  it('§4.1 a cancelled order that never reached a venue executed nothing', () => {
    // CMB-RO-8RZdaHdgpdw8Aj8fBgcwD51skZdx, persisted when the deal opened.
    expect(
      executedFillQty({
        status: 'CANCELED',
        orderId: '-1',
        executedQty: '8.045',
        origQty: '8.045',
        typeOrder: 'dealRegular',
      }),
    ).to.equal(0)
  })

  it('§4.3 a cancelled order that DID partially fill still counts', () => {
    expect(
      executedFillQty({
        status: 'CANCELED',
        orderId: '651883b2-e716-43c2-a2e7-178656a8f301',
        executedQty: '0.281',
        origQty: '1.639',
        typeOrder: 'dealGrid',
      }),
    ).to.equal(0.281)
  })

  it('§4.2 a row reporting zero executed contributes zero, not its plan', () => {
    // CMB-GR-4JvOZeddCIUSEh0PbqTf2fV7YzKA: FILLED, executedQty '0', price '0'.
    expect(
      executedFillQty({
        status: 'FILLED',
        orderId: 'a5a28e5e-eb1a-4637-86cd-2d207c86bae4',
        executedQty: '0',
        origQty: '1.639',
        typeOrder: 'dealGrid',
      }),
    ).to.equal(0)
  })

  it('§4.2 an unreadable executedQty falls back to the planned size', () => {
    for (const executedQty of [undefined, null, '', 'NaN']) {
      expect(
        executedFillQty({
          status: 'FILLED',
          orderId: 'venue-id',
          executedQty: executedQty as any,
          origQty: '2.5',
          typeOrder: 'dealGrid',
        }),
      ).to.equal(2.5)
    }
  })

  it('§4.2 the base order is never guessed at from its planned size', () => {
    expect(
      executedFillQty({
        status: 'FILLED',
        orderId: 'venue-id',
        executedQty: 'NaN',
        origQty: '7.828',
        typeOrder: 'dealStart',
      }),
    ).to.equal(0)
  })

  it('§4.2/§4.3 an ordinary fill is returned untouched', () => {
    expect(
      executedFillQty({
        status: 'FILLED',
        orderId: 'venue-id',
        executedQty: '7.81',
        origQty: '7.828',
        typeOrder: 'dealStart',
      }),
    ).to.equal(7.81)
  })

  it('never answers NaN', () => {
    expect(
      executedFillQty({
        status: 'FILLED',
        orderId: 'venue-id',
        executedQty: 'NaN',
        origQty: 'NaN',
        typeOrder: 'dealTP',
      }),
    ).to.equal(0)
  })
})
