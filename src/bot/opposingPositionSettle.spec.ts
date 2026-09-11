process.env.NODE_ENV = 'testing'

/**
 * Spec 041 — a bot started while the opposite bot's position is still closing
 * must wait for that close instead of refusing on the first position read.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum } from '../../types'
import {
  OPPOSING_POSITION_SETTLE,
  awaitPositionFlat,
  isFlatOn,
} from './opposingPositionSettle'

const SYMBOL = 'HYPE-USDC'

const read = (
  rows: { symbol: string; positionAmt: string; positionSide?: string }[],
  status = StatusEnum.ok,
) => ({ status, data: rows, reason: null })

const short = read([
  { symbol: SYMBOL, positionAmt: '-0.19', positionSide: 'BOTH' },
])
const long = read([
  { symbol: SYMBOL, positionAmt: '0.19', positionSide: 'BOTH' },
])
const flat = read([])

/** Replays `reads` in order, recording every sleep and fetch. */
const venue = (reads: (unknown | Error)[]) => {
  const slept: number[] = []
  let fetched = 0
  return {
    slept,
    get fetched() {
      return fetched
    },
    fetch: async () => {
      const r = reads[Math.min(fetched, reads.length - 1)]
      fetched++
      if (r instanceof Error) throw r
      return r as ReturnType<typeof read> | undefined
    },
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
}

describe('opposing position settle (spec 041)', () => {
  describe('§4.2 what counts as flat', () => {
    it('no rows is flat', () => {
      expect(isFlatOn([], SYMBOL)).to.equal(true)
      expect(isFlatOn(undefined, SYMBOL)).to.equal(true)
    })

    it('a zero-amount row for the symbol is flat', () => {
      expect(isFlatOn([{ symbol: SYMBOL, positionAmt: '0' }], SYMBOL)).to.equal(
        true,
      )
      expect(
        isFlatOn([{ symbol: SYMBOL, positionAmt: '-0.0' }], SYMBOL),
      ).to.equal(true)
    })

    it('a position on another symbol does not block this one', () => {
      expect(
        isFlatOn([{ symbol: 'BTC-USD', positionAmt: '-1' }], SYMBOL),
      ).to.equal(true)
    })

    it('a non-zero position on the symbol, either side, is not flat', () => {
      expect(isFlatOn(short.data, SYMBOL)).to.equal(false)
      expect(isFlatOn(long.data, SYMBOL)).to.equal(false)
    })
  })

  describe('§4.1 the reported flip', () => {
    it('continues with the read that shows the closed position gone', async () => {
      // The refusing read saw the short; the close fills before the second re-read.
      const v = venue([short, flat])
      const res = await awaitPositionFlat(v.fetch, SYMBOL, {
        ...OPPOSING_POSITION_SETTLE,
        sleep: v.sleep,
      })
      expect(res).to.equal(flat)
      expect(v.fetched).to.equal(2)
    })

    it('refuses (undefined) when the opposite position never closes', async () => {
      const v = venue([short])
      const res = await awaitPositionFlat(v.fetch, SYMBOL, {
        ...OPPOSING_POSITION_SETTLE,
        sleep: v.sleep,
      })
      expect(res).to.equal(undefined)
      expect(v.fetched).to.equal(OPPOSING_POSITION_SETTLE.attempts)
    })

    it('a flip to the bot’s own side during the wait is not cleared', async () => {
      const v = venue([long])
      const res = await awaitPositionFlat(v.fetch, SYMBOL, {
        ...OPPOSING_POSITION_SETTLE,
        sleep: v.sleep,
      })
      expect(res).to.equal(undefined)
    })
  })

  describe('§4.3 an unreadable re-read is not flat', () => {
    it('non-ok, missing and thrown reads each use an attempt and never throw', async () => {
      const v = venue([
        read([], StatusEnum.notok),
        undefined,
        new Error('connector down'),
        flat,
      ])
      const res = await awaitPositionFlat(v.fetch, SYMBOL, {
        ...OPPOSING_POSITION_SETTLE,
        sleep: v.sleep,
      })
      expect(res).to.equal(flat)
      expect(v.fetched).to.equal(4)
    })

    it('all unreadable → undefined, within budget', async () => {
      const v = venue([new Error('connector down')])
      const res = await awaitPositionFlat(v.fetch, SYMBOL, {
        ...OPPOSING_POSITION_SETTLE,
        sleep: v.sleep,
      })
      expect(res).to.equal(undefined)
      expect(v.fetched).to.equal(OPPOSING_POSITION_SETTLE.attempts)
    })
  })

  describe('§4.4 / §4.7 pacing and budget', () => {
    it('sleeps one interval before every re-read, including the first', async () => {
      const v = venue([short])
      await awaitPositionFlat(v.fetch, SYMBOL, {
        attempts: 3,
        intervalMs: 2_000,
        sleep: v.sleep,
      })
      expect(v.slept).to.deep.equal([2_000, 2_000, 2_000])
    })

    it('the default budget adds at most 10 s', () => {
      expect(
        OPPOSING_POSITION_SETTLE.attempts * OPPOSING_POSITION_SETTLE.intervalMs,
      ).to.equal(10_000)
    })
  })
})
