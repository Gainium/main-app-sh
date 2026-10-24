/**
 * `/api/v2/discovery/indicators` (and `/:type`) serve `indicatorDefinitions`
 * verbatim, and API clients — AI assistants among them — take that list as
 * what a bot can run. It must hold only types the engine evaluates as a
 * condition: a type the condition catalog marks `source: 'none'` is never
 * advertised.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * Asserted against the committed `definitions/generated.ts`, so a stale or
 * hand-edited file fails here too (`npm run generate:definitions`).
 */
import { expect } from 'chai'
import {
  indicatorCoreFieldDefinitions,
  indicatorDefinitions,
} from './definitions/generated'
import { indicatorCoreConfig } from './validators/bots/config'
import { INDICATOR_CONDITION_KINDS } from '../../indicators/conditions/catalog'
import { IndicatorEnum } from '../../../types'

describe('discovery indicators — only types the engine runs', () => {
  const advertised = indicatorDefinitions.map((d) => d.type)

  it('lists no type without an engine condition', () => {
    const notRunnable = advertised.filter((t) => {
      const source = INDICATOR_CONDITION_KINDS[t as IndicatorEnum]?.source
      return !source || source === 'none'
    })
    expect(notRunnable).to.deep.equal([])
  })

  it('does not list Ichimoku Cloud or Bull Bear Power', () => {
    expect(advertised).to.not.include(IndicatorEnum.ic)
    expect(advertised).to.not.include(IndicatorEnum.bullBear)
  })

  it('still lists every type the engine runs', () => {
    const runnable = (indicatorCoreConfig.type.enum as string[]).filter(
      (t) => INDICATOR_CONDITION_KINDS[t as IndicatorEnum].source !== 'none',
    )
    expect(advertised).to.deep.equal(runnable)
  })

  it('offers the same types in the core `type` field enum', () => {
    const typeField = indicatorCoreFieldDefinitions.find(
      (f) => f.name === 'type',
    )
    expect(typeField?.enum).to.deep.equal(advertised)
  })
})
