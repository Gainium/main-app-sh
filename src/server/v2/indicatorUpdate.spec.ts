/**
 * Spec 126 — REST bot update and clone can replace a bot's indicators.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 */
import { expect } from 'chai'
import { applyIndicatorSettingsUpdate } from './validators/indicatorUpdate'
import { checkDCABotSettings, checkDCADealSettings } from '../../bot/utils'
import { DCA_FORM_DEFAULTS } from './botDefaults'
import {
  DCABotSettings,
  DCAConditionEnum,
  IndicatorAction,
  IndicatorEnum,
  IndicatorSection,
  IndicatorsLogicEnum,
  KDJCompareToEnum,
  KDJLineEnum,
  SettingsIndicators,
  StartConditionEnum,
  StatusEnum,
  VWAPAnchorEnum,
  VWAPLineEnum,
} from '../../../types'
import {
  KDJLineEnum as IndicatorsKDJLineEnum,
  VWAPAnchorEnum as IndicatorsVWAPAnchorEnum,
  VWAPLineEnum as IndicatorsVWAPLineEnum,
} from '@gainium/indicators'

const rsi = (uuid: string, groupId = 'g1') =>
  ({
    type: IndicatorEnum.rsi,
    uuid,
    groupId,
    indicatorAction: IndicatorAction.startDeal,
  }) as unknown as SettingsIndicators

const group = (id = 'g1') => ({
  id,
  logic: IndicatorsLogicEnum.and,
  action: IndicatorAction.startDeal,
})

const tiBot = (): DCABotSettings =>
  ({
    ...DCA_FORM_DEFAULTS,
    startCondition: StartConditionEnum.ti,
    indicators: [
      { ...rsi('keep'), indicatorLength: 7, indicatorValue: '70' },
      { ...rsi('drop'), indicatorLength: 7, indicatorValue: '30' },
    ],
    indicatorGroups: [group()],
  }) as unknown as DCABotSettings

const errorsOf = (r: ReturnType<typeof applyIndicatorSettingsUpdate>) =>
  r.status === StatusEnum.notok ? r.errors : []

describe('spec 126 — REST bot update replaces indicators', () => {
  describe('§2.1 accepted by the settings allowlist', () => {
    for (const combo of [false, true]) {
      it(`${combo ? 'combo' : 'dca'}: indicators + indicatorGroups are not "Unknown settings"`, () => {
        const check = checkDCABotSettings(
          tiBot(),
          { indicators: [rsi('a')], indicatorGroups: [group()] },
          combo,
        )
        expect(check).to.deep.equal({ status: StatusEnum.ok })
      })
    }
  })

  describe('§2.2 full-array replacement', () => {
    it('the result holds exactly the sent indicators, no merge by uuid', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [rsi('new')],
      })
      expect(r.status).to.equal(StatusEnum.ok)
      if (r.status !== StatusEnum.ok) return
      expect(r.settings.indicators?.map((i) => i.uuid)).to.deep.equal(['new'])
    })
    it('indicators: [] is accepted when nothing needs one', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        startCondition: StartConditionEnum.asap,
        indicators: [],
        indicatorGroups: [],
      })
      expect(errorsOf(r)).to.deep.equal([])
    })
  })

  describe('§2.3 same item rules as creation', () => {
    it('fills per-type defaults into a minimal indicator', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [rsi('a')],
      })
      expect(r.status).to.equal(StatusEnum.ok)
      if (r.status !== StatusEnum.ok) return
      const [i] = r.settings.indicators ?? []
      expect(i.indicatorLength).to.equal(7)
      expect(i.indicatorValue).to.equal('70')
      expect(i.indicatorInterval).to.be.a('string')
    })
    it('rejects a non-array', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: {} as unknown as SettingsIndicators[],
      })
      expect(errorsOf(r)).to.deep.equal([
        ['indicators', 'Field indicators must be an array'],
      ])
    })
    it('rejects an item the creation schema rejects', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [
          {
            ...rsi('a'),
            indicatorAction: 'nope',
          } as unknown as SettingsIndicators,
        ],
      })
      expect(r.status).to.equal(StatusEnum.notok)
      expect(errorsOf(r).some(([f]) => f.startsWith('indicators[0]'))).to.equal(
        true,
      )
    })
    it('accepts lwCondition, which per-type defaults add', () => {
      const r = applyIndicatorSettingsUpdate(
        { ...tiBot(), startCondition: StartConditionEnum.ti },
        {
          indicators: [
            {
              ...rsi('lw'),
              type: IndicatorEnum.lw,
            } as unknown as SettingsIndicators,
          ],
        },
      )
      expect(
        errorsOf(r).filter(([, m]) => m.includes('lwCondition')),
      ).to.deep.equal([])
    })
    it('accepts the OTE Levels fields and rejects an unknown leg', () => {
      const update = (oteLeg: string) =>
        applyIndicatorSettingsUpdate(
          { ...tiBot(), startCondition: StartConditionEnum.ti },
          {
            indicators: [
              {
                ...rsi('ote'),
                type: IndicatorEnum.ote,
                oteLeftBars: '10',
                oteMinLegSize: '1.5',
                oteLevel: '0.705',
                oteLeg,
              } as unknown as SettingsIndicators,
            ],
          },
        )
      const oteErrors = (r: ReturnType<typeof update>) =>
        errorsOf(r).filter(([f]) => f.includes('ote'))
      expect(oteErrors(update('bullish'))).to.deep.equal([])
      expect(oteErrors(update('sideways')).length).to.equal(1)
    })
    it('accepts the KDJ, VWAP, ADX DMI and MA trend filter fields and rejects unknown values', () => {
      const update = (type: IndicatorEnum, fields: Record<string, unknown>) =>
        applyIndicatorSettingsUpdate(
          { ...tiBot(), startCondition: StartConditionEnum.ti },
          {
            indicators: [
              {
                ...rsi('new'),
                type,
                indicatorCondition: 'cu',
                ...fields,
              } as unknown as SettingsIndicators,
            ],
          },
        )
      const fieldErrors = (
        r: ReturnType<typeof update>,
        re: RegExp,
      ): [string, string][] => errorsOf(r).filter(([f]) => re.test(f))
      const kdj = /kdj/
      expect(
        fieldErrors(
          update(IndicatorEnum.kdj, {
            kdjLength: 9,
            kdjKSmooth: '3',
            kdjDSmooth: 3,
            kdjLine: 'j',
            kdjCompareTo: 'custom',
          }),
          kdj,
        ),
      ).to.deep.equal([])
      expect(
        fieldErrors(update(IndicatorEnum.kdj, { kdjLine: 'x' }), kdj).length,
      ).to.equal(1)
      expect(
        fieldErrors(update(IndicatorEnum.kdj, { kdjCompareTo: 'level' }), kdj)
          .length,
      ).to.equal(1)
      expect(
        fieldErrors(update(IndicatorEnum.kdj, { kdjLength: 0 }), kdj).length,
      ).to.be.greaterThan(0)
      const vwap = /vwap/
      expect(
        fieldErrors(
          update(IndicatorEnum.vwap, {
            vwapAnchor: 'week',
            vwapLine: 'lower',
            vwapBandMultiplier: 2,
          }),
          vwap,
        ),
      ).to.deep.equal([])
      expect(
        fieldErrors(update(IndicatorEnum.vwap, { vwapAnchor: 'year' }), vwap)
          .length,
      ).to.equal(1)
      expect(
        fieldErrors(update(IndicatorEnum.vwap, { vwapLine: 'middle' }), vwap)
          .length,
      ).to.equal(1)
      expect(
        fieldErrors(update(IndicatorEnum.adx, { adxMode: 'dmi' }), /adxMode/),
      ).to.deep.equal([])
      expect(
        fieldErrors(update(IndicatorEnum.adx, { adxMode: 'di' }), /adxMode/)
          .length,
      ).to.equal(1)
      // DMI compares two lines: no between
      const bw = (adxMode: string) =>
        errorsOf(
          update(IndicatorEnum.adx, {
            adxMode,
            indicatorCondition: 'bw',
            indicatorValue: '20',
            indicatorValue2: '40',
          }),
        ).filter(([, m]) => m.includes('between'))
      expect(bw('adx')).to.deep.equal([])
      expect(bw('dmi').length).to.equal(1)
      expect(
        fieldErrors(
          update(IndicatorEnum.ma, {
            maType: 'mcginley',
            maCrossingValue: 'price',
            trendFilter: true,
            trendFilterLookback: 10,
            trendFilterType: 'higher',
            trendFilterValue: 1,
          }),
          /trendFilter/,
        ),
      ).to.deep.equal([])
      expect(
        fieldErrors(
          update(IndicatorEnum.ma, {
            trendFilter: true,
            trendFilterType: 'up',
          }),
          /trendFilter/,
        ).length,
      ).to.equal(1)
    })
    it('accepts the Candle colour, Order Blocks, Squeeze, DIV pivot and Session active fields and rejects out-of-range ones', () => {
      const update = (type: IndicatorEnum, fields: Record<string, unknown>) =>
        applyIndicatorSettingsUpdate(
          { ...tiBot(), startCondition: StartConditionEnum.ti },
          {
            indicators: [
              {
                ...rsi('new'),
                type,
                indicatorCondition: 'cd',
                ...fields,
              } as unknown as SettingsIndicators,
            ],
          },
        )
      const fieldErrors = (
        r: ReturnType<typeof update>,
        re: RegExp,
      ): [string, string][] => errorsOf(r).filter(([f]) => re.test(f))
      const count = (
        type: IndicatorEnum,
        fields: Record<string, unknown>,
        re: RegExp,
      ) => fieldErrors(update(type, fields), re).length
      // Candle colour
      const candle = /candle/
      expect(
        count(
          IndicatorEnum.candle,
          {
            candleSource: 'regular',
            candleColor: 'red',
            candleCount: 50,
            candleTrigger: 'start',
          },
          candle,
        ),
      ).to.equal(0)
      expect(
        count(IndicatorEnum.candle, { candleSource: 'renko' }, candle),
      ).to.equal(1)
      expect(
        count(IndicatorEnum.candle, { candleColor: 'blue' }, candle),
      ).to.equal(1)
      expect(
        count(IndicatorEnum.candle, { candleTrigger: 'end' }, candle),
      ).to.equal(1)
      expect(count(IndicatorEnum.candle, { candleCount: 51 }, candle)).to.equal(
        1,
      )
      expect(
        count(IndicatorEnum.candle, { candleCount: 0 }, candle),
      ).to.be.greaterThan(0)
      expect(
        count(IndicatorEnum.candle, { candleCount: 1.5 }, candle),
      ).to.equal(1)
      // Order Blocks
      const ob = /obSwingLength|obSide|obLevel/
      expect(
        count(
          IndicatorEnum.ob,
          { obSwingLength: 2, obSide: 'bearish', obLevel: 'middle' },
          ob,
        ),
      ).to.equal(0)
      expect(count(IndicatorEnum.ob, { obSwingLength: 1 }, ob)).to.equal(1)
      expect(count(IndicatorEnum.ob, { obSwingLength: 51 }, ob)).to.equal(1)
      expect(count(IndicatorEnum.ob, { obSide: 'any' }, ob)).to.equal(1)
      expect(count(IndicatorEnum.ob, { obLevel: 'mid' }, ob)).to.equal(1)
      // Squeeze Momentum: decimal multipliers pass
      const sqz = /sqz/
      expect(
        count(
          IndicatorEnum.sqz,
          {
            sqzLength: 20,
            sqzBBMult: 1.5,
            sqzKCLength: '14',
            sqzKCMult: '2.25',
            sqzSignal: 'fired',
            sqzMomentum: 'crossUp',
          },
          sqz,
        ),
      ).to.equal(0)
      expect(count(IndicatorEnum.sqz, { sqzLength: 1 }, sqz)).to.equal(1)
      expect(count(IndicatorEnum.sqz, { sqzKCLength: 501 }, sqz)).to.equal(1)
      expect(count(IndicatorEnum.sqz, { sqzLength: 20.5 }, sqz)).to.equal(1)
      expect(count(IndicatorEnum.sqz, { sqzBBMult: 0.05 }, sqz)).to.equal(1)
      expect(count(IndicatorEnum.sqz, { sqzKCMult: 11 }, sqz)).to.equal(1)
      expect(count(IndicatorEnum.sqz, { sqzSignal: 'release' }, sqz)).to.equal(
        1,
      )
      expect(count(IndicatorEnum.sqz, { sqzMomentum: 'up' }, sqz)).to.equal(1)
      // Decimal standard deviations / SuperTrend factor
      expect(count(IndicatorEnum.bb, { bbwMult: 2.5 }, /bbwMult/)).to.equal(0)
      expect(count(IndicatorEnum.bbw, { bbwMult: '0.1' }, /bbwMult/)).to.equal(
        0,
      )
      expect(count(IndicatorEnum.bbpb, { bbwMult: 1.7 }, /bbwMult/)).to.equal(0)
      expect(count(IndicatorEnum.st, { factor: 2.5 }, /factor/)).to.equal(0)
      // Divergence pivots / range
      const div = /divPivot|divRange/
      expect(
        count(
          IndicatorEnum.div,
          {
            divPivotLeft: 5,
            divPivotRight: '2',
            divRangeLower: 5,
            divRangeUpper: 500,
          },
          div,
        ),
      ).to.equal(0)
      expect(
        count(IndicatorEnum.div, { divPivotLeft: 0 }, div),
      ).to.be.greaterThan(0)
      expect(count(IndicatorEnum.div, { divPivotRight: 51 }, div)).to.equal(1)
      expect(count(IndicatorEnum.div, { divRangeUpper: 1 }, div)).to.equal(1)
      expect(count(IndicatorEnum.div, { divRangeLower: 2.5 }, div)).to.equal(1)
      const rangeErrors = (fields: Record<string, unknown>) =>
        errorsOf(update(IndicatorEnum.div, fields)).filter(([, m]) =>
          m.includes('divRangeLower must be below divRangeUpper'),
        )
      expect(
        rangeErrors({ divRangeLower: 5, divRangeUpper: 30 }),
      ).to.deep.equal([])
      expect(rangeErrors({})).to.deep.equal([])
      expect(
        rangeErrors({ divRangeLower: 30, divRangeUpper: 30 }).length,
      ).to.equal(1)
      expect(rangeErrors({ divRangeLower: 61 }).length).to.equal(1)
      // Session Price levels: where it is evaluated
      const active = /sessionLevelsActive/
      for (const v of ['session', 'outside', 'always'])
        expect(
          count(
            IndicatorEnum.session,
            { sessionRule: 'levels', sessionLevelsActive: v },
            active,
          ),
        ).to.equal(0)
      expect(
        count(
          IndicatorEnum.session,
          { sessionRule: 'levels', sessionLevelsActive: 'weekend' },
          active,
        ),
      ).to.equal(1)
      // Price Change range
      const pc = /pcCompare|pcValue2/
      for (const pcCompare of ['gt', 'lt'])
        expect(
          count(IndicatorEnum.pc, { pcValue: '-2', pcCompare }, pc),
        ).to.equal(0)
      expect(
        count(
          IndicatorEnum.pc,
          { pcValue: '2', pcValue2: '5', pcCompare: 'bw' },
          pc,
        ),
      ).to.equal(0)
      expect(count(IndicatorEnum.pc, { pcCompare: 'between' }, pc)).to.equal(1)
      expect(
        count(IndicatorEnum.pc, { pcCompare: 'bw', pcValue2: 'x' }, pc),
      ).to.be.greaterThan(0)
      const pcRange = (fields: Record<string, unknown>) =>
        errorsOf(update(IndicatorEnum.pc, fields)).filter(([, m]) =>
          m.startsWith('Price Change:'),
        )
      expect(pcRange({})).to.deep.equal([])
      expect(pcRange({ pcValue: '2', pcCompare: 'lt' })).to.deep.equal([])
      // a stray pcValue2 outside bw is ignored
      expect(pcRange({ pcValue: '2', pcValue2: '-5' })).to.deep.equal([])
      expect(
        pcRange({ pcValue: '2', pcValue2: '5', pcCompare: 'bw' }),
      ).to.deep.equal([])
      expect(
        pcRange({ pcValue: '-5', pcValue2: '-2', pcCompare: 'bw' }),
      ).to.deep.equal([])
      // pcValue missing = 5
      expect(pcRange({ pcValue2: '2', pcCompare: 'bw' })).to.deep.equal([])
      expect(pcRange({ pcValue: '2', pcCompare: 'bw' }).length).to.equal(1)
      expect(
        pcRange({ pcValue: '2', pcValue2: '-5', pcCompare: 'bw' }).length,
      ).to.equal(1)
      expect(
        pcRange({ pcValue: '0', pcValue2: '5', pcCompare: 'bw' }).length,
      ).to.equal(1)
      expect(
        pcRange({ pcValue: '-3', pcValue2: '-3', pcCompare: 'bw' }).length,
      ).to.equal(1)
    })
    it('KDJ and VWAP enums are the indicators package’s', () => {
      expect(Object.values(KDJLineEnum)).to.deep.equal(
        Object.values(IndicatorsKDJLineEnum),
      )
      expect(Object.values(VWAPAnchorEnum)).to.deep.equal(
        Object.values(IndicatorsVWAPAnchorEnum),
      )
      expect(Object.values(VWAPLineEnum)).to.deep.equal(
        Object.values(IndicatorsVWAPLineEnum),
      )
      expect(Object.values(KDJCompareToEnum)).to.deep.equal([
        ...Object.values(IndicatorsKDJLineEnum),
        'custom',
      ])
    })
    it('accepts McGinley as an MA type and rejects it as a Bollinger average', () => {
      const update = (fields: Record<string, string>) =>
        applyIndicatorSettingsUpdate(
          { ...tiBot(), startCondition: StartConditionEnum.ti },
          {
            indicators: [
              {
                ...rsi('mg'),
                type: IndicatorEnum.ma,
                ...fields,
              } as unknown as SettingsIndicators,
            ],
          },
        )
      const maErrors = (r: ReturnType<typeof update>) =>
        errorsOf(r).filter(([f]) => /ma|Ma/.test(f))
      expect(
        maErrors(update({ maType: 'mcginley', maCrossingValue: 'price' })),
      ).to.deep.equal([])
      expect(maErrors(update({ mar1type: 'mcginley' }))).to.deep.equal([])
      expect(maErrors(update({ bbwMa: 'mcginley' })).length).to.equal(1)
      expect(maErrors(update({ kcMa: 'mcginley' })).length).to.equal(1)
    })
    it('accepts the Session Price levels rule and rejects an unknown level', () => {
      const update = (sessionLevelA: string, sessionRule = 'levels') =>
        applyIndicatorSettingsUpdate(
          { ...tiBot(), startCondition: StartConditionEnum.ti },
          {
            indicators: [
              {
                ...rsi('levels'),
                type: IndicatorEnum.session,
                sessionDays: [1, 2, 3, 4, 5],
                sessionRule,
                sessionStart: '09:30',
                sessionEnd: '16:00',
                sessionTimezone: 'America/New_York',
                sessionLevelA,
                sessionLevelB: 'prevHigh',
                indicatorCondition: 'cu',
                indicatorInterval: '15m',
              } as unknown as SettingsIndicators,
            ],
          },
        )
      const sessionErrors = (r: ReturnType<typeof update>) =>
        errorsOf(r).filter(([f]) => f.includes('session'))
      expect(sessionErrors(update('price'))).to.deep.equal([])
      expect(sessionErrors(update('curOpen'))).to.deep.equal([])
      expect(sessionErrors(update('curMid'))).to.deep.equal([])
      expect(sessionErrors(update('lastHigh')).length).to.equal(1)
      expect(sessionErrors(update('price', 'between')).length).to.equal(1)
    })
  })

  describe('§2.4 round trip', () => {
    it('ignores a stored per-item _id', () => {
      const stored = tiBot()
      const r = applyIndicatorSettingsUpdate(stored, {
        indicators: stored.indicators.map((i) => ({
          ...i,
          _id: '6abd17dd9321580f2cc7166c',
        })),
        indicatorGroups: stored.indicatorGroups.map((g) => ({
          ...g,
          _id: '6abd17dd9321580f2cc7166d',
        })),
      })
      expect(errorsOf(r)).to.deep.equal([])
      if (r.status !== StatusEnum.ok) return
      expect(r.settings.indicators?.[0]).to.not.have.property('_id')
      expect(r.settings.indicatorGroups?.[0]).to.not.have.property('_id')
    })
  })

  describe('§2.5 consistency judged on the resulting bot', () => {
    it('rejects removing the only startDeal indicator while the stored start is ti', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [],
        indicatorGroups: [],
      })
      expect(r.status).to.equal(StatusEnum.notok)
      if (r.status !== StatusEnum.notok) return
      expect(r.reason).to.equal('Validation error')
      expect(r.errors.map(([, m]) => m)).to.include(
        'At least one indicator with action "startDeal" is required when startCondition is "ti"',
      )
    })
    it('rejects an indicator whose group the stored groups do not have', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [rsi('a', 'missing')],
      })
      expect(errorsOf(r).map(([f]) => f)).to.include('indicators')
    })
    it('rejects duplicate uuids', () => {
      const r = applyIndicatorSettingsUpdate(tiBot(), {
        indicators: [rsi('a'), rsi('a')],
      })
      expect(errorsOf(r).map(([, m]) => m)).to.include(
        'Duplicate indicator IDs found: a',
      )
    })
  })

  describe('§2.6 variable links', () => {
    it('unlinks variables pointing into a removed uuid, keeps the rest', () => {
      const r = applyIndicatorSettingsUpdate(
        tiBot(),
        { indicators: [tiBot().indicators[0]] },
        {
          list: ['v1', 'v2', 'v3'],
          paths: [
            { path: 'indicators.keep.indicatorValue', variable: 'v1' },
            { path: 'indicators.drop.indicatorValue', variable: 'v2' },
            { path: 'orderSize', variable: 'v3' },
          ],
        },
      )
      expect(r.status).to.equal(StatusEnum.ok)
      if (r.status !== StatusEnum.ok) return
      expect(r.vars).to.deep.equal({
        list: ['v1', 'v3'],
        paths: [
          { path: 'indicators.keep.indicatorValue', variable: 'v1' },
          { path: 'orderSize', variable: 'v3' },
        ],
      })
    })
  })

  describe('§2.8 safety-order indicators', () => {
    const soIndicator = (uuid: string, minPercFromLast = '1.5') =>
      ({
        type: IndicatorEnum.rsi,
        uuid,
        groupId: 'so',
        indicatorAction: IndicatorAction.startDca,
        section: IndicatorSection.dca,
        minPercFromLast,
      }) as unknown as SettingsIndicators
    const soGroup = {
      id: 'so',
      logic: IndicatorsLogicEnum.and,
      action: IndicatorAction.startDca,
      section: IndicatorSection.dca,
    }
    const soBot = (): DCABotSettings =>
      ({
        ...DCA_FORM_DEFAULTS,
        dcaCondition: DCAConditionEnum.indicators,
        indicators: [soIndicator('old')],
        indicatorGroups: [soGroup],
      }) as unknown as DCABotSettings

    it('replaces the safety-order indicators of a bot already on them, keeping minPercFromLast', () => {
      const r = applyIndicatorSettingsUpdate(soBot(), {
        indicators: [soIndicator('new', '2.5')],
      })
      expect(errorsOf(r)).to.deep.equal([])
      if (r.status !== StatusEnum.ok) return
      expect(r.settings.indicators?.[0].minPercFromLast).to.equal('2.5')
    })
    it('rejects an invalid per-indicator minPercFromLast', () => {
      const r = applyIndicatorSettingsUpdate(soBot(), {
        indicators: [soIndicator('new', 'abc')],
      })
      expect(
        errorsOf(r).some(([f]) => f === 'indicators[0].minPercFromLast'),
      ).to.equal(true)
    })
    it('rejects removing the last startDca indicator while dcaCondition stays indicators', () => {
      const r = applyIndicatorSettingsUpdate(soBot(), {
        indicators: [],
        indicatorGroups: [],
      })
      expect(errorsOf(r).map(([, m]) => m)).to.include(
        'At least one indicator with action "startDca" and section "dca" is required when dcaCondition is "indicators"',
      )
    })
    it('a bot update may switch dcaCondition to indicators; a deal update may not', () => {
      expect(
        checkDCABotSettings(
          DCA_FORM_DEFAULTS,
          { dcaCondition: DCAConditionEnum.indicators },
          false,
        ),
      ).to.deep.equal({ status: StatusEnum.ok })
      expect(
        checkDCADealSettings(
          DCA_FORM_DEFAULTS,
          { dcaCondition: DCAConditionEnum.indicators },
          false,
        ).status,
      ).to.equal(StatusEnum.notok)
    })
    it('switching dcaCondition to indicators together with the indicators is accepted', () => {
      const r = applyIndicatorSettingsUpdate(DCA_FORM_DEFAULTS, {
        dcaCondition: DCAConditionEnum.indicators,
        indicators: [soIndicator('a')],
        indicatorGroups: [soGroup],
      })
      expect(errorsOf(r)).to.deep.equal([])
    })
    it('switching dcaCondition to indicators with none on the bot is rejected', () => {
      const r = applyIndicatorSettingsUpdate(DCA_FORM_DEFAULTS, {
        dcaCondition: DCAConditionEnum.indicators,
      })
      expect(errorsOf(r).map(([, m]) => m)).to.include(
        'At least one indicator with action "startDca" and section "dca" is required when dcaCondition is "indicators"',
      )
    })
    it('a bot update may switch startCondition to ti', () => {
      expect(
        checkDCABotSettings(
          DCA_FORM_DEFAULTS,
          { startCondition: StartConditionEnum.ti },
          false,
        ),
      ).to.deep.equal({ status: StatusEnum.ok })
    })
    it('switching startCondition to ti with no startDeal indicator is rejected', () => {
      const r = applyIndicatorSettingsUpdate(DCA_FORM_DEFAULTS, {
        startCondition: StartConditionEnum.ti,
      })
      expect(r.status).to.equal(StatusEnum.notok)
    })
  })

  describe('§2.7 nothing else changes', () => {
    it('returns an update without indicator keys untouched', () => {
      const update = { tpPerc: '2' }
      const vars = { list: ['v'], paths: [{ path: 'tpPerc', variable: 'v' }] }
      const r = applyIndicatorSettingsUpdate(tiBot(), update, vars)
      expect(r).to.deep.equal({ status: StatusEnum.ok, settings: update, vars })
      if (r.status !== StatusEnum.ok) return
      expect(r.settings).to.equal(update)
      expect(r.vars).to.equal(vars)
    })
  })
})
