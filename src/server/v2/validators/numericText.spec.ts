import { expect } from 'chai'
import {
  readNumericText,
  validators,
  ValidatorsEnum,
} from './bots/config'

// Validation must read numeric text the way the bot engine does (`+value`).
// `parseFloat` read only a leading number, so "3,5" passed as 3 while the
// engine read NaN.
describe('v2 validators: numeric text is read whole', () => {
  const bad = ['3,5', '3abc', '1.5.2', '10%', 'abc', ' ']
  const good: [string, number][] = [
    ['3', 3],
    ['3.5', 3.5],
    [' 3 ', 3],
    ['-2', -2],
    ['5e-8', 5e-8],
  ]

  it('readNumericText matches the engine on good text', () => {
    for (const [t, n] of good) expect(readNumericText(t)).to.equal(n)
  })
  it('readNumericText gives NaN for partial or empty text', () => {
    for (const t of [...bad, '']) expect(readNumericText(t)).to.be.NaN
  })

  const numeric = [
    ValidatorsEnum.shouldBeNumber,
    ValidatorsEnum.shouldBePositive,
    ValidatorsEnum.shouldBeNonNegative,
    ValidatorsEnum.shouldBeInteger,
    ValidatorsEnum.shouldBeValidNumber,
  ] as const
  for (const v of numeric) {
    it(`${v} refuses partial numeric text`, () => {
      for (const t of bad.filter((b) => b.trim() !== '')) {
        expect((validators as any)[v](t, 'f'), `${v}("${t}")`).to.be.a('string')
      }
    })
  }
  it('accepts whole numeric text', () => {
    expect(validators[ValidatorsEnum.shouldBePositive]('3', 'f')).to.equal(null)
    expect(validators[ValidatorsEnum.shouldBeInteger]('3', 'f')).to.equal(null)
    expect(validators[ValidatorsEnum.shouldBeValidNumber]('3.5', 'f')).to.equal(null)
    expect(validators[ValidatorsEnum.shouldBeNegative]('-1', 'f')).to.equal(null)
  })
})
