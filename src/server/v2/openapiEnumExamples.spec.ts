/**
 * Spec 093 — no example in the published OpenAPI document may be a value its
 * own `enum` (and the request validator behind it) rejects.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * Asserted against the committed `openapi-v2.yaml`, the artefact served at
 * https://api.gainium.io/api/v2/openapi.yaml. The validator configs are the
 * same objects `validators/bots/schema.ts` hands to `shouldBeValidEnumValue`,
 * so they are the authority on what a request may carry.
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { findEnumExampleMismatches } from '../../utils/openapiEnumExamples'
import { dcaBotSchemaConfig, indicatorCoreConfig } from './validators/bots/config'
import { BotStatusEnum } from '../../../types'

describe('spec 093 — OpenAPI examples are members of their enum', () => {
  const doc: any = yaml.load(
    fs.readFileSync(path.join(__dirname, 'openapi-v2.yaml'), 'utf-8'),
  )
  const schemas = doc?.components?.schemas ?? {}
  const ownProps = (name: string): Record<string, any> =>
    (schemas[name]?.allOf ?? [schemas[name]]).reduce(
      (acc: Record<string, any>, part: any) => ({
        ...acc,
        ...(part?.properties ?? {}),
      }),
      {},
    )

  describe('§3 checker', () => {
    it('flags an example outside the enum, with its path', () => {
      expect(
        findEnumExampleMismatches({ a: { enum: ['1h'], example: 'oneH' } }),
      ).to.deep.equal(['a: example "oneH" is not one of ["1h"]'])
    })
    it('flags a null example on an enum without null', () => {
      expect(
        findEnumExampleMismatches({ a: { enum: ['open'], example: null } }),
      ).to.have.length(1)
    })
    it('accepts a member example and an enum with no example', () => {
      expect(
        findEnumExampleMismatches([
          { enum: ['1h'], example: '1h' },
          { enum: ['1h'] },
        ]),
      ).to.deep.equal([])
    })
  })

  describe('§1 published document', () => {
    it('has no example outside its enum anywhere in components.schemas', () => {
      expect(findEnumExampleMismatches(schemas, 'schemas')).to.deep.equal([])
    })

    const cases: [string, string, string[]][] = [
      ['SettingsIndicators', 'type', indicatorCoreConfig.type.enum as string[]],
      [
        'SettingsIndicators',
        'indicatorInterval',
        indicatorCoreConfig.indicatorInterval.enum as string[],
      ],
      [
        'DCABotSettings',
        'stopStatus',
        (dcaBotSchemaConfig as any).stopStatus.enum as string[],
      ],
      ['DCABotSettings', 'type', (dcaBotSchemaConfig as any).type.enum],
      ['DCABotExtended', 'previousStatus', Object.values(BotStatusEnum)],
    ]
    cases.forEach(([schema, field, accepted]) => {
      it(`${schema}.${field} example is a value the API accepts`, () => {
        const prop = ownProps(schema)[field]
        expect(prop, `${schema}.${field} documented`).to.be.an('object')
        expect(accepted).to.include(prop.example)
      })
    })
  })
})
