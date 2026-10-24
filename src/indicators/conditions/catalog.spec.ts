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
  SessionLevelEnum,
  SessionRuleEnum,
} from '../../../types'
import type { SettingsIndicators } from '../../../types'
import {
  INDICATOR_CONDITION_KINDS,
  ROOM_CONDITION_TYPES,
  conditionKindOf,
  conditionSettingsGaps,
  isClockCondition,
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

  describe('Session: the rule picks the kind', () => {
    const session = (o: Partial<SettingsIndicators>) =>
      base({ type: IndicatorEnum.session, indicatorValue: undefined, ...o })
    it('in / out (and missing) are clock rules, Price levels a room condition', () => {
      for (const sessionRule of [
        undefined,
        SessionRuleEnum.in,
        SessionRuleEnum.out,
      ]) {
        expect(isClockCondition(session({ sessionRule })), `${sessionRule}`).to
          .be.true
        expect(conditionKindOf(session({ sessionRule }))?.source).to.equal(
          'clock',
        )
      }
      const levels = session({ sessionRule: SessionRuleEnum.levels })
      expect(isClockCondition(levels)).to.be.false
      expect(conditionKindOf(levels)?.source).to.equal('room')
      // the per-type kind stays clock: automations refuse a Session, any rule
      expect(isRoomConditionType(IndicatorEnum.session)).to.be.false
      expect(conditionKindOf(base({}))).to.equal(
        INDICATOR_CONDITION_KINDS[IndicatorEnum.rsi],
      )
    })
    it('Price levels gaps: unknown level, A equal to B, no between', () => {
      const gaps = (o: Partial<SettingsIndicators>) =>
        conditionSettingsGaps(
          session({ sessionRule: SessionRuleEnum.levels, ...o }),
        ).map((g) => g.field)
      expect(gaps({})).to.deep.equal([])
      expect(gaps({ indicatorCondition: undefined })).to.deep.equal([])
      expect(
        gaps({
          sessionLevelA: SessionLevelEnum.curOpen,
          sessionLevelB: SessionLevelEnum.prevMid,
          indicatorCondition: IndicatorStartConditionEnum.cu,
        }),
      ).to.deep.equal([])
      expect(
        gaps({
          sessionLevelA: SessionLevelEnum.prevHigh,
          sessionLevelB: SessionLevelEnum.prevHigh,
        }),
      ).to.deep.equal(['sessionLevelB'])
      expect(
        gaps({ sessionLevelA: 'lastHigh' as SessionLevelEnum }),
      ).to.deep.equal(['sessionLevelA'])
      expect(
        gaps({ indicatorCondition: IndicatorStartConditionEnum.bw }),
      ).to.deep.equal(['indicatorCondition'])
    })
  })
})
