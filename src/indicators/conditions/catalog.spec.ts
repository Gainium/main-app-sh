process.env.NODE_ENV = 'testing'

/**
 * Every indicator type must be classified for condition use, and every type
 * classified as room-evaluable must be covered by the characterization table
 * — so adding an `IndicatorEnum` value fails here until someone decides how
 * it is evaluated (and pins it).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  MAEnum,
} from '../../../types'
import type { SettingsIndicators } from '../../../types'
import {
  INDICATOR_CONDITION_KINDS,
  ROOM_CONDITION_TYPES,
  conditionSettingsGaps,
  isRoomConditionType,
} from './catalog'
import { conditionCases, configCases } from './__fixtures__/conditionCases'

describe('indicators/conditions — catalog', () => {
  it('classifies every IndicatorEnum value', () => {
    for (const t of Object.values(IndicatorEnum))
      expect(INDICATOR_CONDITION_KINDS[t], t).to.be.an('object')
    expect(Object.keys(INDICATOR_CONDITION_KINDS).sort()).to.deep.equal(
      Object.values(IndicatorEnum).sort(),
    )
  })

  it('every room-evaluable type has characterization cases', () => {
    const decided = new Set(conditionCases().map((c) => c.settings.type))
    const configured = new Set(configCases().map((c) => c.settings.type))
    for (const t of ROOM_CONDITION_TYPES) {
      expect(decided.has(t), `${t} has no condition case`).to.equal(true)
      expect(configured.has(t), `${t} has no config case`).to.equal(true)
    }
  })

  it('bot-only and non-condition types are the expected ones', () => {
    const notRoom = Object.values(IndicatorEnum).filter(
      (t) => !isRoomConditionType(t),
    )
    expect(notRoom.sort()).to.deep.equal(
      [
        IndicatorEnum.bullBear,
        IndicatorEnum.ic,
        IndicatorEnum.unpnl,
        IndicatorEnum.session,
      ].sort(),
    )
  })

  const base = (o: Partial<SettingsIndicators>) =>
    ({
      type: IndicatorEnum.rsi,
      uuid: 'c',
      groupId: 'g',
      indicatorAction: IndicatorAction.startDeal,
      indicatorInterval: ExchangeIntervals.oneH,
      indicatorLength: 14,
      indicatorValue: '30',
      indicatorCondition: IndicatorStartConditionEnum.lt,
      ...o,
    }) as SettingsIndicators

  it('settings gaps follow the decision branches', () => {
    expect(conditionSettingsGaps(base({}))).to.deep.equal([])
    expect(
      conditionSettingsGaps(base({ indicatorLength: 0 })).map((g) => g.field),
    ).to.deep.equal(['indicatorLength'])
    expect(
      conditionSettingsGaps(
        base({ indicatorCondition: IndicatorStartConditionEnum.bw }),
      ).map((g) => g.field),
    ).to.deep.equal(['indicatorValue2'])
    expect(
      conditionSettingsGaps(base({ type: IndicatorEnum.tv })).map(
        (g) => g.field,
      ),
    ).to.deep.equal(['checkLevel', 'signal'])
    expect(
      conditionSettingsGaps(base({ type: IndicatorEnum.st })),
    ).to.deep.equal([])
    expect(
      conditionSettingsGaps(
        base({
          type: IndicatorEnum.ma,
          maCrossingValue: MAEnum.price,
          indicatorValue: undefined as unknown as string,
        }),
      ),
    ).to.deep.equal([])
    expect(
      conditionSettingsGaps(
        base({ type: IndicatorEnum.ma, maCrossingValue: MAEnum.sma }),
      ).map((g) => g.field),
    ).to.deep.equal(['maCrossingValue'])
    expect(
      conditionSettingsGaps(
        base({
          type: IndicatorEnum.ma,
          maCrossingValue: MAEnum.sma,
          maCrossingLength: 50,
          maCrossingInterval: ExchangeIntervals.oneH,
          maUUID: 'other',
        }),
      ),
    ).to.deep.equal([])
  })
})
