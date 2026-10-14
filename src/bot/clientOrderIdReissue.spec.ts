/**
 * Enforces specs/161 §4.1. Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  resolveLevelClientOrderId,
  siblingClientOrderIds,
} from './clientOrderIdReissue'

const statuses =
  (rows: Record<string, string>) =>
  (id: string): string | undefined =>
    rows[id]

describe('resolveLevelClientOrderId (spec 161 §4.1)', () => {
  it('keeps an id the bot has never sent', () => {
    expect(
      resolveLevelClientOrderId('A', new Map(), statuses({})),
    ).to.deep.equal({ action: 'keep' })
  })

  it('keeps an id whose order is live or filled — the usual checks skip it', () => {
    for (const status of ['NEW', 'PARTIALLY_FILLED', 'FILLED']) {
      expect(
        resolveLevelClientOrderId('A', new Map(), statuses({ A: status })),
      ).to.deep.equal({ action: 'keep' })
    }
  })

  it('mints for an id the venue cancelled or expired', () => {
    for (const status of ['CANCELED', 'EXPIRED']) {
      expect(
        resolveLevelClientOrderId('A', new Map(), statuses({ A: status })),
      ).to.deep.equal({ action: 'mint', spent: 'A' })
    }
  })

  it('adopts a live or filled replacement, following the chain', () => {
    const reissued = new Map([
      ['A', 'B'],
      ['B', 'C'],
    ])
    for (const status of ['NEW', 'FILLED']) {
      expect(
        resolveLevelClientOrderId(
          'A',
          reissued,
          statuses({ A: 'CANCELED', B: 'CANCELED', C: status }),
        ),
      ).to.deep.equal({ action: 'adopt', id: 'C' })
    }
  })

  it('mints when the end of the chain is spent or no longer held', () => {
    const reissued = new Map([['A', 'B']])
    expect(
      resolveLevelClientOrderId('A', reissued, statuses({ B: 'CANCELED' })),
    ).to.deep.equal({ action: 'mint', spent: 'B' })
    expect(
      resolveLevelClientOrderId('A', reissued, statuses({})),
    ).to.deep.equal({ action: 'mint', spent: 'B' })
  })

  it('stops on a cycle instead of looping', () => {
    const reissued = new Map([
      ['A', 'B'],
      ['B', 'A'],
    ])
    expect(
      resolveLevelClientOrderId('A', reissued, statuses({ B: 'NEW' })),
    ).to.deep.equal({ action: 'adopt', id: 'B' })
  })
})

describe('siblingClientOrderIds (spec 161 §4.5, spec 145)', () => {
  it('prefers …2, and never the id itself', () => {
    expect(siblingClientOrderIds('abcS')[0]).to.equal('abc2')
    expect(siblingClientOrderIds('abc2')[0]).to.equal('abc3')
    expect(siblingClientOrderIds('abc2')).to.not.include('abc2')
  })
})
