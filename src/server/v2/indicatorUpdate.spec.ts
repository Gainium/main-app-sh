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
  SettingsIndicators,
  StartConditionEnum,
  StatusEnum,
} from '../../../types'

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
