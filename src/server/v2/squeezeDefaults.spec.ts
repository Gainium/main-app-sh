process.env.NODE_ENV = 'testing'

/**
 * Squeeze Momentum's API default BB multiplier is 1.5 (the chart TradingView
 * displays), the same value the indicators package uses for a missing one,
 * so a bot built from the defaults and one saved without the field share a
 * room.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { resolveSqueezeSettings } from '@gainium/indicators'
import { IndicatorEnum } from '../../../types'
import { indicatorConfigDefaults } from './botDefaults'
import { indicatorDefinitions } from './definitions/generated'

describe('v2 Squeeze Momentum defaults', () => {
  it('botDefaults store sqzBBMult 1.5 = the package default', () => {
    expect(indicatorConfigDefaults[IndicatorEnum.sqz].sqzBBMult).to.equal(1.5)
    expect(resolveSqueezeSettings().bbMult).to.equal(1.5)
    expect(resolveSqueezeSettings(20, 2).bbMult).to.equal(2)
  })

  it('the generated definition example uses 1.5', () => {
    const sqz = indicatorDefinitions.find(
      (d) => d.type === 'SQZ',
    ) as unknown as {
      example: Record<string, unknown>
    }
    expect(sqz.example.sqzBBMult).to.equal(1.5)
  })
})
