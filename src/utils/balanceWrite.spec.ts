process.env.NODE_ENV = 'testing'

/**
 * Core spec 003 §4.2 — an absent `locked` on a streamed balance item must not
 * overwrite the stored hold. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  hasLocked,
  lockedInsertValue,
  lockedUpdateFields,
  normalizeLocked,
  streamedFree,
} from './balanceWrite'

describe('balanceWrite (spec 003 §4.2)', () => {
  it('sets locked on update only when the event carries it', () => {
    expect(lockedUpdateFields({ locked: '2.5' })).to.deep.equal({ locked: 2.5 })
    expect(lockedUpdateFields({ locked: '0' })).to.deep.equal({ locked: 0 })
    expect(lockedUpdateFields({})).to.deep.equal({})
    expect(lockedUpdateFields({ locked: undefined })).to.deep.equal({})
    expect(lockedUpdateFields({ locked: null })).to.deep.equal({})
    expect(lockedUpdateFields({ locked: '' })).to.deep.equal({})
  })

  it('defaults locked to 0 on insert when absent', () => {
    expect(lockedInsertValue({})).to.equal(0)
    expect(lockedInsertValue({ locked: '1.25' })).to.equal(1.25)
  })

  it('normalises negative and non-finite holds to 0', () => {
    expect(normalizeLocked(-1)).to.equal(0)
    expect(normalizeLocked(NaN)).to.equal(0)
    expect(normalizeLocked(3)).to.equal(3)
    expect(lockedUpdateFields({ locked: 'abc' })).to.deep.equal({ locked: 0 })
  })

  it('hasLocked treats empty string as absent', () => {
    expect(hasLocked({ locked: '' })).to.equal(false)
    expect(hasLocked({ locked: '0' })).to.equal(true)
  })
})

describe('streamedFree (spec 069 §4)', () => {
  it('§4.1 takes the stored hold out of a total-only item', () => {
    expect(streamedFree({ free: '15000' }, 10372)).to.equal(4628)
    expect(streamedFree({ free: '0.3' }, 0.1)).to.equal(0.2)
  })

  it('§4.2 leaves an item that carries its own locked alone', () => {
    expect(streamedFree({ free: '4628', locked: '10372' }, 999)).to.equal(4628)
    expect(streamedFree({ free: '5', locked: '0' }, 3)).to.equal(5)
  })

  it('§4.3 treats an unknown or invalid stored hold as none', () => {
    expect(streamedFree({ free: '7' }, undefined)).to.equal(7)
    expect(streamedFree({ free: '7' }, null)).to.equal(7)
    expect(streamedFree({ free: '7' }, -2)).to.equal(7)
    expect(streamedFree({ free: '7' }, NaN)).to.equal(7)
  })

  it('§4.4 never goes negative when the hold outlived the funds', () => {
    expect(streamedFree({ free: '1.5' }, 260.83)).to.equal(0)
  })
})
