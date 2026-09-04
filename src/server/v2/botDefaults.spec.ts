process.env.NODE_ENV = 'testing'

/**
 * Spec: specs/006.mcginley-dynamic-indicator.md §2
 *
 * indicatorConfigDefaults is a `{ [x in IndicatorEnum]: ... }` mapped type —
 * missing an entry for a new IndicatorEnum member is a compile error, not a
 * runtime one, so there's nothing to assert about *presence*. What's worth
 * pinning down at runtime is the *shape* of McGinley Dynamic's entry: it
 * must not carry any of LongWick's bespoke fields (this repo has no bespoke
 * fields for McGinley — it reuses the generic indicatorLength/indicatorValue/
 * indicatorCondition machinery, per spec §2), and it must set sane defaults.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { indicatorConfigDefaults } from './botDefaults'
import { IndicatorEnum } from '../../../types'

describe('indicatorConfigDefaults[IndicatorEnum.mg]', () => {
  it('sets generic indicatorLength/indicatorValue defaults, no bespoke fields', () => {
    const defaults = indicatorConfigDefaults[IndicatorEnum.mg]
    expect(defaults.indicatorLength).to.be.a('number')
    expect(defaults.indicatorValue).to.be.a('string')
    expect(defaults).to.not.have.property('lwThreshold')
    expect(defaults).to.not.have.property('mgLength')
  })
})
