process.env.NODE_ENV = 'testing'

/**
 * Regression test — the hourly stuck-start sweep (`closeOldStartDeals`) reads
 * DCA deals with `oldStartDcaDealsFilter`: {status:'start', createTime:{$lt},
 * $nor:[…]}. It has no `userId`, and every other `dcadeals` index leads with
 * `userId`, so the read was a COLLSCAN of the whole collection.
 *
 * Enforces specs/247 §4.1.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { Schema } from 'mongoose'
import schema, { registerIndexes } from './schema'

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>?]

describe('specs/247 — the stuck-start sweep must be index-backed', () => {
  before(() => {
    // model.ts and other specs also call this in the same mocha process, so
    // a declaration can appear more than once: assert presence, not a count.
    registerIndexes()
  })

  it('dcaDeal declares {createTime:1} partial on status:start', () => {
    const declared = (
      schema.dcaDeal as unknown as Schema<any>
    ).indexes() as unknown as DeclaredIndex[]
    const match = declared.filter(
      ([key, opts]) =>
        JSON.stringify(key) === JSON.stringify({ createTime: 1 }) &&
        JSON.stringify(opts?.partialFilterExpression) ===
          JSON.stringify({ status: 'start' }),
    )
    expect(
      match.length,
      'no {createTime:1} index partial on {status:"start"} — the sweep COLLSCANs dcadeals',
    ).to.be.greaterThan(0)
  })
})
