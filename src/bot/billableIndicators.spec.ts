import { describe, it } from 'mocha'
import { expect } from 'chai'
import { billableIndicators } from './billableIndicators'
import { indicatorConsistencyErrors } from '../server/v2/validators/logic'
import { DCAConditionEnum, IndicatorAction, indicatorsLimit } from '../../types'

const ind = (indicatorAction: IndicatorAction) => ({ indicatorAction })
const ladder = (n: number) =>
  Array.from({ length: n }, () => ind(IndicatorAction.startDca))

describe('billableIndicators: the DCA-by-indicators ladder counts as one', () => {
  it('a 16-level ladder is one indicator', () => {
    expect(
      billableIndicators({
        dcaCondition: DCAConditionEnum.indicators,
        indicators: ladder(16),
      }),
    ).to.equal(1)
  })

  it('every other indicator still counts once', () => {
    expect(
      billableIndicators({
        dcaCondition: DCAConditionEnum.indicators,
        indicators: [
          ...ladder(5),
          ind(IndicatorAction.startDeal),
          ind(IndicatorAction.closeDeal),
        ],
      }),
    ).to.equal(3)
  })

  it('unchanged when DCA is not by indicators', () => {
    expect(
      billableIndicators({
        dcaCondition: DCAConditionEnum.percentage,
        indicators: [...ladder(2), ind(IndicatorAction.startDeal)],
      }),
    ).to.equal(3)
    expect(billableIndicators(undefined)).to.equal(0)
  })

  describe('v2 cap (indicatorConsistencyErrors)', () => {
    const capErrors = (settings: object) =>
      indicatorConsistencyErrors(settings as never).filter(([, m]) =>
        m.startsWith('A maximum of'),
      )

    it(`16 DCA levels + ${indicatorsLimit - 1} others fits the cap`, () => {
      expect(
        capErrors({
          useDca: true,
          dcaCondition: DCAConditionEnum.indicators,
          indicators: [
            ...ladder(16),
            ...Array.from({ length: indicatorsLimit - 1 }, () =>
              ind(IndicatorAction.startDeal),
            ),
          ],
        }),
      ).to.deep.equal([])
    })

    it(`${indicatorsLimit + 1} counted indicators is refused`, () => {
      const errors = capErrors({
        useDca: true,
        dcaCondition: DCAConditionEnum.indicators,
        indicators: [
          ...ladder(3),
          ...Array.from({ length: indicatorsLimit }, () =>
            ind(IndicatorAction.startDeal),
          ),
        ],
      })
      expect(errors).to.have.length(1)
      expect(errors[0][1]).to.contain(
        `Currently counted: ${indicatorsLimit + 1}`,
      )
    })
  })
})
