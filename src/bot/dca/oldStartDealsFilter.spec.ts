process.env.NODE_ENV = 'testing'

/**
 * The stuck-start sweep's DCA deal filter, run the way production runs it:
 * cast through the real `dcaDeal` model with `strictQuery` on (as
 * `MongooseConnect` sets it), then matched against deal documents with sift —
 * the Mongo query matcher mongoose itself ships. No database needed.
 *
 * Spec: `specs/121.old-start-sweep-cancels-terminal-limit-orders.md`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import mongoose from 'mongoose'
import sift from 'sift'
import { model } from '../../db'
import { DCADealStatusEnum, DCATypeEnum } from '../../../types'
import {
  OLD_START_DEAL_AGE_MS,
  oldStartDcaDealsFilter,
} from './oldStartDealsFilter'

const NOW = Date.UTC(2026, 8, 29, 11, 15)
const OLD = NOW - OLD_START_DEAL_AGE_MS - 10 * 60 * 1000
const FRESH = NOW - 60 * 60 * 1000

const deal = (
  type: DCATypeEnum,
  useLimitPrice: boolean | undefined,
  createTime = OLD,
  status = DCADealStatusEnum.start,
) => ({ status, type, createTime, settings: { useLimitPrice } })

/** The filter as mongoose will actually send it to Mongo. */
const castFilter = (filter: Record<string, unknown>) => {
  const q = model.dcaDeal.find(filter)
  q.cast()
  return q.getFilter()
}

const selects = (doc: ReturnType<typeof deal>) =>
  sift(castFilter(oldStartDcaDealsFilter(NOW)) as any)(doc)

describe('closeOldStartDeals DCA filter (spec 121)', () => {
  before(() => {
    mongoose.set('strictQuery', true)
  })

  it('§2 keeps the terminal-limit exclusion after the strictQuery cast', () => {
    const filter = castFilter(oldStartDcaDealsFilter(NOW)) as any
    expect(filter.$nor).to.deep.equal([
      { type: 'terminal', 'settings.useLimitPrice': true },
    ])
  })

  it('§1 does not select a day-old terminal limit order', () => {
    expect(selects(deal(DCATypeEnum.terminal, true))).to.equal(false)
  })

  it('§3 still selects a day-old terminal market deal stuck in start', () => {
    expect(selects(deal(DCATypeEnum.terminal, false))).to.equal(true)
    expect(selects(deal(DCATypeEnum.terminal, undefined))).to.equal(true)
  })

  it('§3 still selects a day-old regular DCA deal stuck in start', () => {
    expect(selects(deal(DCATypeEnum.regular, false))).to.equal(true)
    expect(selects(deal(DCATypeEnum.regular, true))).to.equal(true)
  })

  it('§3 leaves fresh and non-start deals alone, as before', () => {
    expect(selects(deal(DCATypeEnum.regular, false, FRESH))).to.equal(false)
    expect(
      selects(deal(DCATypeEnum.regular, false, OLD, DCADealStatusEnum.open)),
    ).to.equal(false)
  })
})
