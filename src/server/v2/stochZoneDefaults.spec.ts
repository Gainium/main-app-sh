/**
 * Indicator defaults the public API fills in for a bot's conditions: a
 * Stochastic band defaults for the zone the bot reads it in, and Momentum's
 * level is the zero line.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 */
import { expect } from 'chai'
import { addIndicatorsDefaults } from './helpers'
import {
  IndicatorAction,
  IndicatorEnum,
  SettingsIndicators,
  StochRangeEnum,
} from '../../../types'

const withDefaults = (indicator: Partial<SettingsIndicators>) =>
  addIndicatorsDefaults({
    indicators: [
      {
        uuid: 'i',
        indicatorAction: IndicatorAction.startDeal,
        ...indicator,
      } as SettingsIndicators,
    ],
  }).indicators![0]

describe('v2 indicator defaults', () => {
  for (const type of [IndicatorEnum.stoch, IndicatorEnum.stochRSI]) {
    it(`${type}: Lower reads its band of 20 from stochUpper`, () => {
      expect(withDefaults({ type }).stochUpper).to.equal('20')
      expect(
        withDefaults({ type, stochRange: StochRangeEnum.lower }).stochUpper,
      ).to.equal('20')
    })

    it(`${type}: Upper reads its band of 80 from stochLower`, () => {
      expect(
        withDefaults({ type, stochRange: StochRangeEnum.upper }).stochLower,
      ).to.equal('80')
    })

    it(`${type}: both bands keep 20 and 80`, () => {
      const i = withDefaults({ type, stochRange: StochRangeEnum.both })
      expect([i.stochLower, i.stochUpper]).to.deep.equal(['20', '80'])
    })

    it(`${type}: a band the caller sent is kept`, () => {
      expect(withDefaults({ type, stochUpper: '15' }).stochUpper).to.equal('15')
      expect(
        withDefaults({
          type,
          stochRange: StochRangeEnum.upper,
          stochLower: '90',
        }).stochLower,
      ).to.equal('90')
    })
  }

  it('Momentum defaults to the zero line', () => {
    expect(withDefaults({ type: IndicatorEnum.mom }).indicatorValue).to.equal(
      '0',
    )
  })

  it('Keltner Channel range length defaults to 20, as the engine reads it', () => {
    expect(withDefaults({ type: IndicatorEnum.kc }).kcRangeLength).to.equal(20)
  })
})
