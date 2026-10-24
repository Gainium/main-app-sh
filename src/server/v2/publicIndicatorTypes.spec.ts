/**
 * The public API accepts, documents and advertises only indicator types a bot
 * can run as a condition (`CONDITION_INDICATOR_TYPES`). A type the condition
 * catalog marks `source: 'none'` (Ichimoku Cloud, Bull Bear Power) would be
 * stored as a condition that never signals, and API clients — AI assistants
 * among them — take the discovery list as what a bot can run.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * The discovery and OpenAPI checks read the committed artefacts
 * (`definitions/generated.ts`, `openapi-v2.yaml`), so a stale or hand-edited
 * file fails here too (`npm run generate:definitions`).
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import {
  indicatorCoreFieldDefinitions,
  indicatorDefinitions,
} from './definitions/generated'
import {
  indicatorCoreConfig,
  validateNestedObjects,
} from './validators/bots/config'
import { applyIndicatorSettingsUpdate } from './validators/indicatorUpdate'
import { DCA_FORM_DEFAULTS } from './botDefaults'
import {
  CONDITION_INDICATOR_TYPES,
  INDICATOR_CONDITION_KINDS,
} from '../../indicators/conditions/catalog'
import {
  DCABotSettings,
  IndicatorAction,
  IndicatorEnum,
  SettingsIndicators,
  StatusEnum,
} from '../../../types'

const NOT_RUNNABLE = [IndicatorEnum.ic, IndicatorEnum.bullBear]

const indicator = (type: IndicatorEnum) =>
  ({
    type,
    uuid: 'i1',
    groupId: 'g1',
    indicatorLength: 14,
    indicatorValue: '0',
    indicatorCondition: 'cd',
    indicatorInterval: '1h',
    indicatorAction: IndicatorAction.startDeal,
  }) as unknown as SettingsIndicators

describe('public API indicator types — only types the engine runs', () => {
  it('CONDITION_INDICATOR_TYPES holds every type with an engine condition', () => {
    expect(CONDITION_INDICATOR_TYPES).to.deep.equal(
      Object.values(IndicatorEnum).filter(
        (t) => INDICATOR_CONDITION_KINDS[t].source !== 'none',
      ),
    )
    NOT_RUNNABLE.forEach((t) =>
      expect(CONDITION_INDICATOR_TYPES).to.not.include(t),
    )
  })

  describe('validation (bot create and update)', () => {
    it('accepts exactly CONDITION_INDICATOR_TYPES', () => {
      expect(indicatorCoreConfig.type.enum).to.deep.equal(
        CONDITION_INDICATOR_TYPES,
      )
    })

    NOT_RUNNABLE.forEach((type) => {
      it(`rejects ${type} on create`, () => {
        const errors = validateNestedObjects(
          [indicator(type)],
          'indicators',
          indicatorCoreConfig,
        )
        expect(errors.map(([field]) => field)).to.include('indicators[0].type')
      })

      it(`rejects ${type} on update`, () => {
        const result = applyIndicatorSettingsUpdate(
          { ...DCA_FORM_DEFAULTS } as unknown as DCABotSettings,
          { indicators: [indicator(type)] },
        )
        expect(result.status).to.equal(StatusEnum.notok)
        expect(
          result.status === StatusEnum.notok &&
            result.errors.map(([field]) => field),
        ).to.include('indicators[0].type')
      })
    })

    it('still accepts a runnable type', () => {
      expect(
        validateNestedObjects(
          [indicator(IndicatorEnum.rsi)],
          'indicators',
          indicatorCoreConfig,
        ),
      ).to.deep.equal([])
    })
  })

  describe('discovery (/api/v2/discovery/indicators)', () => {
    const advertised = indicatorDefinitions.map((d) => d.type)

    it('lists exactly CONDITION_INDICATOR_TYPES', () => {
      expect(advertised).to.deep.equal(CONDITION_INDICATOR_TYPES)
    })

    it('offers the same types in the core `type` field enum', () => {
      const typeField = indicatorCoreFieldDefinitions.find(
        (f) => f.name === 'type',
      )
      expect(typeField?.enum).to.deep.equal(advertised)
    })
  })

  it('OpenAPI SettingsIndicators.type documents exactly CONDITION_INDICATOR_TYPES', () => {
    const doc: any = yaml.load(
      fs.readFileSync(path.join(__dirname, 'openapi-v2.yaml'), 'utf-8'),
    )
    expect(
      doc.components.schemas.SettingsIndicators.properties.type.enum,
    ).to.deep.equal(CONDITION_INDICATOR_TYPES)
  })
})
