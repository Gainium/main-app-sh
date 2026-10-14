process.env.NODE_ENV = 'testing'

/**
 * Spec `163` — is a refused Hyperliquid close only part of the venue position?
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../../types'
import { isPartialCloseOfSharedPosition } from './sharedPositionClose'

const PAIR = 'HYPE-USDC'
const HL = ExchangeEnum.hyperliquidLinear

const positions = (positionAmt: string, symbol = PAIR) => ({
  kind: 'positions' as const,
  positions: [{ symbol, positionAmt, positionSide: 'BOTH' }],
})

const verdict = (
  probe: any,
  closeQty = 0.11,
  exchange: string = HL,
  side: 'LONG' | 'SHORT' = 'LONG',
) =>
  isPartialCloseOfSharedPosition(
    exchange,
    probe,
    PAIR,
    side,
    false,
    closeQty,
    0.01,
  )

describe('isPartialCloseOfSharedPosition (spec 163)', () => {
  it('§1.1 a close of 0.11 against a venue position of 0.22 is shared', () => {
    expect(verdict(positions('0.22'))).to.deep.equal({
      shared: true,
      venueQty: 0.22,
    })
  })

  it('§1.1 a short position reads by its size', () => {
    expect(verdict(positions('-0.22'), 0.11, HL, 'SHORT')).to.deep.equal({
      shared: true,
      venueQty: 0.22,
    })
  })

  it('§1.3 a close of the whole position is not shared', () => {
    expect(verdict(positions('0.11'))).to.deep.equal({ shared: false })
  })

  it('§1.3 a position larger by less than half a step is the same position', () => {
    expect(verdict(positions('0.114'))).to.deep.equal({ shared: false })
  })

  it('§1.3 a position smaller than the close is not shared', () => {
    expect(verdict(positions('0.05'))).to.deep.equal({ shared: false })
  })

  it('§1.3 no answer from the venue is not shared', () => {
    expect(verdict({ kind: 'unavailable' })).to.deep.equal({ shared: false })
  })

  it('§1.3 no position on the pair is not shared', () => {
    expect(verdict(positions('0.5', 'BTC-USDC'))).to.deep.equal({
      shared: false,
    })
    expect(verdict({ kind: 'positions', positions: [] })).to.deep.equal({
      shared: false,
    })
  })

  it('§1.3 an unusable close quantity is not shared', () => {
    expect(verdict(positions('0.22'), 0)).to.deep.equal({ shared: false })
    expect(verdict(positions('0.22'), NaN)).to.deep.equal({ shared: false })
  })

  it('§1.3 every other venue is never shared', () => {
    for (const e of Object.values(ExchangeEnum)) {
      if (e === HL) continue
      expect(verdict(positions('0.22'), 0.11, e), e).to.deep.equal({
        shared: false,
      })
    }
  })
})
