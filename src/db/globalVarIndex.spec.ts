process.env.NODE_ENV = 'testing'

/**
 * Regression test — the bot collections declare no index for
 * "which bots use global variable V?".
 *
 * `getBotsByGlobalVar` (`core/src/bot/utils.ts:757`) asks every bot collection
 * `{isDeleted: {$ne: true}, 'vars.list': V}`, and `countData` turns that into
 * Mongoose `countDocuments`, i.e. an aggregate `[$match, $group]`. With no
 * index on `vars.list` that shape has no candidate plan at all and reads the
 * whole collection: measured live on production, GROUP <- COLLSCAN with
 * 51,755 documents examined (the entire `dcabots` collection) to answer one
 * count, at 12,043 executions in the slow-query window.
 *
 * `isDeleted: {$ne: true}` cannot bound a scan, so `vars.list` is the only
 * indexable predicate the filter has — the same reasoning already recorded for
 * `parentBotId_1` in schema.ts.
 *
 * Enforces specs/044 §4.1–§4.2.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { Schema } from 'mongoose'
import schema, { registerIndexes } from './schema'

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>?]

const declaredOn = (s: Schema<any>): DeclaredIndex[] =>
  s.indexes() as unknown as DeclaredIndex[]

const varsListIndexes = (s: Schema<any>) =>
  declaredOn(s).filter((i) =>
    Object.prototype.hasOwnProperty.call(i[0] ?? {}, 'vars.list'),
  )

describe('specs/044 — global-variable bot counts must be index-backed', () => {
  before(() => {
    // Idempotent: model.ts already calls this at import time in a real
    // process, and Schema.index() de-duplicates identical declarations.
    registerIndexes()
  })

  const collections: { name: string; schema: Schema<any> }[] = [
    { name: 'dcaBot', schema: schema.dcaBot as unknown as Schema<any> },
    { name: 'comboBot', schema: schema.comboBot as unknown as Schema<any> },
    { name: 'bot', schema: schema.bot as unknown as Schema<any> },
  ]

  for (const { name, schema: s } of collections) {
    // §4.1
    it(`${name} declares an index on vars.list`, () => {
      expect(
        varsListIndexes(s).length,
        `${name} has no index whose key includes 'vars.list' — ` +
          `getBotsByGlobalVar COLLSCANs this collection`,
      ).to.be.greaterThan(0)
    })

    // §4.2 — single-field. Compounding with `isDeleted` would be pointless
    // (a $ne cannot bound a scan) and would move the entry on every soft
    // delete.
    it(`${name}'s vars.list index is single-field and ascending`, () => {
      const [key] = varsListIndexes(s)[0] ?? []
      expect(key, `${name} has no vars.list index to inspect`).to.not.equal(
        undefined,
      )
      expect(Object.keys(key as Record<string, unknown>)).to.deep.equal([
        'vars.list',
      ])
      expect((key as Record<string, unknown>)['vars.list']).to.equal(1)
    })
  }
})
