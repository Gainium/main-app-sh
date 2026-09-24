process.env.NODE_ENV = 'testing'

/**
 * Rate policy for the `updateUserBalance` NOTOK line. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { BalanceFailureLog } from './balanceFailureLog'

const HOUR = 60 * 60e3

describe('BalanceFailureLog', () => {
  it('logs a connection once per window, then reports its repeats', () => {
    const l = new BalanceFailureLog(HOUR, 5)
    expect(l.note('bitget', 'permission denied', 'a', 0)).to.deep.equal({
      log: true,
      summaries: [],
    })
    // The snapshot cron re-runs every couple of minutes.
    for (let t = 2 * 60e3; t < HOUR; t += 2 * 60e3) {
      expect(l.note('bitget', 'permission denied', 'a', t).log).to.equal(false)
    }
    const next = l.note('bitget', 'permission denied', 'a', HOUR)
    expect(next.log).to.equal(true)
    expect(next.summaries).to.deep.equal([
      {
        provider: 'bitget',
        reason: 'permission denied',
        failures: 29,
        connections: 1,
        windowMinutes: 60,
      },
    ])
  })

  it('gives each refused connection its own line', () => {
    const l = new BalanceFailureLog(HOUR, 5)
    expect(l.note('bitget', 'permission denied', 'a', 0).log).to.equal(true)
    expect(l.note('bitget', 'permission denied', 'b', 1).log).to.equal(true)
    expect(l.note('bitget', 'permission denied', 'c', 2).log).to.equal(true)
  })

  it('folds a venue outage into one summary past the per-group cap', () => {
    const l = new BalanceFailureLog(HOUR, 5)
    let lines = 0
    for (let run = 0; run < 30; run++) {
      for (let c = 0; c < 1000; c++) {
        if (l.note('binance', 'ECONNREFUSED', `c${c}`, run * 2 * 60e3).log) {
          lines++
        }
      }
    }
    expect(lines).to.equal(5)
    const next = l.note('binance', 'ECONNREFUSED', 'c0', HOUR)
    expect(next.summaries).to.have.length(1)
    expect(next.summaries[0].connections).to.equal(1000)
    expect(next.summaries[0].failures).to.equal(30 * 1000 - 5)
  })

  it('keeps different providers and reasons apart', () => {
    const l = new BalanceFailureLog(HOUR, 1)
    expect(l.note('bitget', 'x', 'a', 0).log).to.equal(true)
    expect(l.note('bitget', 'y', 'a', 1).log).to.equal(true)
    expect(l.note('okx', 'x', 'a', 2).log).to.equal(true)
    expect(l.note('bitget', 'x', 'b', 3).log).to.equal(false)
  })

  it('reports and drops closed groups when any later failure arrives', () => {
    const l = new BalanceFailureLog(HOUR, 1)
    l.note('kraken', 'timeout 1', 'a', 0)
    l.note('kraken', 'timeout 1', 'a', 1)
    const later = l.note('bybit', 'other', 'z', HOUR + 1)
    expect(later.summaries.map((s) => s.reason)).to.deep.equal(['timeout 1'])
    // The swept group starts fresh rather than reporting twice.
    const again = l.note('kraken', 'timeout 1', 'a', HOUR + 2)
    expect(again).to.deep.equal({ log: true, summaries: [] })
  })

  it('reports nothing for a window with no suppressed repeats', () => {
    const l = new BalanceFailureLog(HOUR, 5)
    l.note('bitget', 'x', 'a', 0)
    expect(l.note('bitget', 'x', 'a', HOUR).summaries).to.deep.equal([])
  })
})
