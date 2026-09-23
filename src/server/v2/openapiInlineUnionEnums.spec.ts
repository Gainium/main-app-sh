/**
 * Spec 094 §4.4 — a settings property typed as an inline union of string
 * literals (`stopStatus?: 'closed' | 'monitoring'`) must be published with
 * EVERY member in its enum, not just the first one.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * Asserted against the committed `openapi-v2.yaml`, the artefact served at
 * https://api.gainium.io/api/v2/openapi.yaml.
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'

describe('spec 094 — inline string-literal union enums', () => {
  const specPath = path.join(__dirname, 'openapi-v2.yaml')
  const doc: any = yaml.load(fs.readFileSync(specPath, 'utf-8'))

  /** Every `stopStatus` property object anywhere in the document. */
  const stopStatuses: any[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.properties?.stopStatus) stopStatuses.push(node.properties.stopStatus)
    Object.values(node).forEach(walk)
  }
  walk(doc?.components?.schemas)

  it('publishes DCABotSettings.stopStatus with every member of its union', () => {
    const schema = doc?.components?.schemas?.DCABotSettings
    const parts = [schema, ...(schema?.allOf ?? [])]
    const property = parts.find((p: any) => p?.properties?.stopStatus)
      ?.properties.stopStatus
    expect(property, 'DCABotSettings.stopStatus').to.be.an('object')
    expect(property.type).to.equal('string')
    expect(property.enum).to.include.members(['closed', 'monitoring'])
  })

  it('keeps every published stopStatus example inside its enum', () => {
    expect(stopStatuses.length).to.be.greaterThan(0)
    stopStatuses.forEach((property) => {
      expect(property.enum).to.include.members(['closed', 'monitoring'])
      if (property.example !== undefined) {
        expect(property.enum).to.include(property.example)
      }
    })
  })
})
