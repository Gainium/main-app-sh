process.env.NODE_ENV = 'testing'

/**
 * Only an adaptive-close resend (sized from a direct venue balance read) skips
 * the not-enough-balance cooldown. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isFreshlySizedResend } from './main'

describe('isFreshlySizedResend', () => {
  it('is true for an adaptive-close resend', () => {
    expect(isFreshlySizedResend({ acAfter: 0.00047018 })).to.equal(true)
  })
  it('is false for every ordinary order', () => {
    expect(isFreshlySizedResend({})).to.equal(false)
    expect(isFreshlySizedResend({ acAfter: 0 })).to.equal(false)
    expect(isFreshlySizedResend({ acAfter: undefined })).to.equal(false)
  })
})
