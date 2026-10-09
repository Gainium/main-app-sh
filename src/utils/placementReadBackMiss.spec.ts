process.env.NODE_ENV = 'testing'

/**
 * A placement that comes back "order does not exist" is a read-back miss on an
 * order the venue may hold, so the bot asks before writing it off. Real venue
 * refusals keep their meaning. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isAmbiguousOrderFailure, isPlacementReadBackMiss } from './exchange'

describe('isPlacementReadBackMiss', () => {
  it('matches the read-back misses venues return out of a placement', () => {
    for (const reason of [
      'Order does not exist', // OKX 51603, seen on a TP OKX had accepted
      'Order not found after execution', // Bybit
      'Coinbase order not found after execution.',
      'Order not found',
    ]) {
      expect(isPlacementReadBackMiss(reason), reason).to.equal(true)
    }
  })

  it('leaves real refusals definitive', () => {
    for (const reason of [
      'Insufficient balance',
      'Order price is out of the permissible range',
      'Symbol not found',
      'Client order ID already exists.',
      '',
      undefined,
    ]) {
      expect(isPlacementReadBackMiss(reason as any), `${reason}`).to.equal(
        false,
      )
    }
  })

  it('was not already covered by isAmbiguousOrderFailure', () => {
    expect(isAmbiguousOrderFailure('Order does not exist')).to.equal(false)
  })
})
