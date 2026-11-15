process.env.NODE_ENV = 'testing'

/**
 * Spec `242` — the public v2 API and order execution fields.
 *
 * GET returns a bot's stored settings, which now include `entryExecution`,
 * `dcaExecution`, `tpExecution`, `slExecution` for bots saved from the
 * dashboard. Sending those settings back (create, backtest validate, import)
 * must not fail with "Unexpected field"; malformed values must still be
 * rejected. Grid bots have no such fields.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  validateCreateDCABotInputSchema,
  validateCreateGridBotInputSchema,
} from './validators/schema'
import { DCA_FORM_DEFAULTS, GRID_FORM_DEFAULTS } from './botDefaults'

const dcaInput = (extra: Record<string, unknown>) => {
  const input = {
    ...DCA_FORM_DEFAULTS,
    exchangeUUID: 'uuid-1',
    pair: ['BTC_USDT'],
    ...extra,
  }
  return validateCreateDCABotInputSchema(
    input as never,
    { exchangeUUID: 'uuid-1', pair: ['BTC_USDT'], ...extra } as never,
  )
}

const fieldErrors = (r: { errors: [string, string][] }, field: string) =>
  r.errors.filter(([k]) => k === field)

describe('spec 242 — v2 accepts order execution fields', () => {
  it('a valid execution round-trips without "Unexpected field"', () => {
    const r = dcaInput({
      tpExecution: {
        mode: 'split',
        slices: 5,
        pace: 'iceberg',
        sliceMode: 'limit',
      },
      slExecution: {
        mode: 'chase',
        repriceSec: 10,
        maxChasePerc: 1,
        timeoutSec: 35,
      },
      entryExecution: null,
      dcaExecution: { mode: 'limit', timeoutSec: 0 },
    })
    for (const k of [
      'tpExecution',
      'slExecution',
      'entryExecution',
      'dcaExecution',
    ]) {
      expect(fieldErrors(r, k), k).to.deep.equal([])
    }
  })
  it('a malformed execution is rejected with a field error', () => {
    const r = dcaInput({ tpExecution: { mode: 'chase', repriceSec: 1 } })
    expect(fieldErrors(r, 'tpExecution')).to.have.length(1)
    expect(fieldErrors(r, 'tpExecution')[0][1]).to.match(/repriceSec/)
  })
  it('a grid bot still treats them as unexpected', () => {
    const input = {
      ...GRID_FORM_DEFAULTS,
      exchangeUUID: 'uuid-1',
      tpExecution: { mode: 'market' },
    }
    const r = validateCreateGridBotInputSchema(input as never, input as never)
    expect(fieldErrors(r, 'tpExecution')[0]?.[1]).to.match(/Unexpected field/)
  })
})
