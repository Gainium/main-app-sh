process.env.NODE_ENV = 'testing'

/**
 * Which exchange rejections count as a dead credential. The list drives the
 * bot engine's per-account auth cooldown and the hourly fee cron's key-disable,
 * so a wording that is not always a dead key must stay out of it.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isHardAuthFailure } from './authGuard'

describe('authGuard — isHardAuthFailure', () => {
  it('Bitget: a deleted key or a wrong passphrase is a dead credential', () => {
    for (const r of [
      'apikey does not exist',
      'Apikey does not exist',
      'apikey/password is incorrect',
    ]) {
      expect(isHardAuthFailure(r), r).to.be.true
    }
  })

  it('Bitget: refusals that are not always the key stay transient', () => {
    for (const r of [
      // one egress IP of the fleet, not the key
      'invalid ip,current request ip 1.2.3.4',
      'sign signature error',
      'user status is abnormal',
      // per-symbol, however close its wording
      'parameter hypeusd does not exist',
      'the symbol has been removed',
    ]) {
      expect(isHardAuthFailure(r), r).to.be.false
    }
  })
})
