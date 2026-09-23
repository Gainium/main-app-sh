/**
 * Spec 092 §4.4 — the published OpenAPI document must describe every closed-set
 * grid bot setting as `type: string` with the exact enum `POST /api/v2/bots/grid`
 * accepts, and must not advertise an example the validator rejects.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * The assertion is made against the committed `openapi-v2.yaml` rather than
 * against the generator's `fieldMetadata` map, because the YAML is the artefact
 * that is served at https://api.gainium.io/api/v2/openapi.yaml and that client
 * generators consume. `gridBotSchemaConfig` is the same object
 * `validators/bots/schema.ts:97` hands to `shouldBeValidEnumValue` at request
 * time, so it is the authority on what is actually accepted — the doc is
 * compared to it, never the other way round.
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { gridBotSchemaConfig } from './validators/bots/config'

/** Fields whose absence would silently make this test vacuous. */
const MUST_BE_DOCUMENTED = [
  'prioritize',
  'gridType',
  'tpSlCondition',
  'tpSlAction',
  'slCondition',
  'slAction',
  'profitCurrency',
  'orderFixedIn',
]

describe('spec 092 — published grid settings enums', () => {
  const specPath = path.join(__dirname, 'openapi-v2.yaml')
  const doc: any = yaml.load(fs.readFileSync(specPath, 'utf-8'))
  const schemas = doc?.components?.schemas ?? {}

  /**
   * `BotSettings` is `allOf: [$ref BaseSettings, { type: object, properties }]`,
   * so a grid setting may be declared on either half. Flatten both.
   */
  const documented: Record<string, any> = {
    ...(schemas.BaseSettings?.properties ?? {}),
    ...(schemas.BotSettings?.allOf ?? []).reduce(
      (acc: Record<string, any>, part: any) => ({
        ...acc,
        ...(part?.properties ?? {}),
      }),
      {},
    ),
  }

  const validatorConfig = gridBotSchemaConfig as Record<string, any>

  const enumFields = Object.entries<any>(validatorConfig).filter(
    ([, config]) => Array.isArray(config?.enum) && config.enum.length > 0,
  )

  it('documents the grid settings that have a closed value set', () => {
    expect(enumFields.length).to.be.greaterThan(0)
    MUST_BE_DOCUMENTED.forEach((field) => {
      expect(validatorConfig[field]?.enum, `${field} validator enum`).to.be.an(
        'array',
      )
      expect(documented[field], `${field} in openapi-v2.yaml`).to.be.an('object')
    })
  })

  enumFields.forEach(([field, config]) => {
    const property = documented[field]
    if (!property) return

    it(`publishes ${field} as a string enum matching the validator`, () => {
      expect(property.type, `${field} type`).to.equal('string')
      // Set equality, not sequence: the documented order follows the union
      // members in `types.ts` while the validator's follows `config.ts`, and
      // OpenAPI attaches no meaning to `enum` ordering. What must not drift is
      // which values are in it — both directions.
      expect(property.enum, `${field} enum`).to.be.an('array')
      expect(
        [...(property.enum ?? [])].sort(),
        `${field} enum`,
      ).to.deep.equal([...config.enum].sort())
    })

    it(`publishes an accepted example for ${field}`, () => {
      if (property.example === undefined) return
      expect(
        config.enum,
        `${field} example "${property.example}" is rejected by the validator`,
      ).to.include(property.example)
    })
  })
})
