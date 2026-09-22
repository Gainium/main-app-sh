process.env.NODE_ENV = 'testing'

/**
 * Spec 078 — a webhook close must finish before the next action in the same
 * payload runs.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { CLOSE_SETTLE, awaitDealsClosed } from './closeSettle'

const noSleep = async () => undefined

describe('spec 078 — webhook close settle', () => {
  it('returns immediately when the bot already has no open deals', async () => {
    let calls = 0
    const settled = await awaitDealsClosed(
      async () => {
        calls += 1
        return 0
      },
      { attempts: 10, intervalMs: 1, sleep: noSleep },
    )
    expect(settled).to.equal(true)
    expect(calls).to.equal(1)
  })

  it('waits for the count to reach zero', async () => {
    const counts = [1, 1, 0]
    let i = 0
    const settled = await awaitDealsClosed(async () => counts[i++] ?? 0, {
      attempts: 10,
      intervalMs: 1,
      sleep: noSleep,
    })
    expect(settled).to.equal(true)
    expect(i).to.equal(3)
  })

  it('gives up after the bounded window with a deal still open', async () => {
    let calls = 0
    const settled = await awaitDealsClosed(
      async () => {
        calls += 1
        return 2
      },
      { attempts: 3, intervalMs: 1, sleep: noSleep },
    )
    expect(settled).to.equal(false)
    // 3 attempts + the final confirming read.
    expect(calls).to.equal(4)
  })

  it('does not read an unreadable count as a completed close', async () => {
    const answers: (number | undefined)[] = [undefined, undefined, 0]
    let i = 0
    const settled = await awaitDealsClosed(async () => answers[i++], {
      attempts: 5,
      intervalMs: 1,
      sleep: noSleep,
    })
    expect(settled).to.equal(true)
    expect(i).to.equal(3)
  })

  it('never throws when the count read throws', async () => {
    const settled = await awaitDealsClosed(
      async () => {
        throw new Error('db down')
      },
      { attempts: 2, intervalMs: 1, sleep: noSleep },
    )
    expect(settled).to.equal(false)
  })

  it('bounds the wait to roughly fifteen seconds', () => {
    const total = CLOSE_SETTLE.attempts * CLOSE_SETTLE.intervalMs
    expect(total).to.be.at.least(10_000)
    expect(total).to.be.at.most(20_000)
  })
})
