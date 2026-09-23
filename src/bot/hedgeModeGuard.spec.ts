process.env.NODE_ENV = 'testing'

/**
 * Spec `091` §4.2 / §4.5 / §4.6 — the three decisions the position-mode guard
 * makes, on their own.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import {
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  StrategyEnum,
} from '../../types'
import {
  HEDGE_FRESH_TTL_MS,
  hedgeLegForSettings,
  isPositionSideRefusal,
  readHedgeMode,
  resetHedgeModeCacheForTests,
} from './hedgeModeGuard'

const ok = (data: boolean) =>
  ({ status: StatusEnum.ok, data, reason: null }) as any
const bad = (reason: string) =>
  ({ status: StatusEnum.notok, data: null, reason }) as any

describe('spec 091 — position-mode guard', () => {
  beforeEach(() => resetHedgeModeCacheForTests())

  describe('§4.5 the refusal predicate', () => {
    it('claims the OKX wording production actually logged', () => {
      // Verbatim from the bot log: the connector passes OKX's own sMsg through.
      expect(isPositionSideRefusal('Parameter posSide error')).to.equal(true)
    })

    it('claims the Binance USD-M wording', () => {
      expect(
        isPositionSideRefusal(
          "Order's position side does not match user's setting.",
        ),
      ).to.equal(true)
    })

    it('does not claim a real position-state refusal', () => {
      // These are the account genuinely not holding what the order acts on —
      // a different failure with its own handling. Re-reading the mode for
      // them would re-send an order the venue was right to refuse.
      const notMode = [
        "Order failed because you don't have any positions in this direction for this contract to reduce or close.",
        "A reduce-only order can't be in the same trading direction as your existing positions.",
        'ReduceOnly Order is rejected',
        'Order quantity has too many decimals.',
      ]
      for (const reason of notMode) {
        expect(isPositionSideRefusal(reason), reason).to.equal(false)
      }
    })

    it('is empty-safe', () => {
      expect(isPositionSideRefusal(undefined)).to.equal(false)
      expect(isPositionSideRefusal(null)).to.equal(false)
      expect(isPositionSideRefusal('')).to.equal(false)
    })
  })

  describe('§4.6 the leg', () => {
    it('follows futuresStrategy when it names one', () => {
      expect(
        hedgeLegForSettings({ futuresStrategy: FuturesStrategyEnum.long }),
      ).to.equal(PositionSide.LONG)
      expect(
        hedgeLegForSettings({ futuresStrategy: FuturesStrategyEnum.short }),
      ).to.equal(PositionSide.SHORT)
    })

    it('falls back to the bot strategy — the DCA/combo case', () => {
      expect(hedgeLegForSettings({ strategy: StrategyEnum.long })).to.equal(
        PositionSide.LONG,
      )
      expect(hedgeLegForSettings({ strategy: StrategyEnum.short })).to.equal(
        PositionSide.SHORT,
      )
    })

    it('a NEUTRAL grid names no leg', () => {
      // The whole point of the null: a neutral grid trades both directions and
      // has no bot-level leg. Guessing one opens a position on the other side.
      expect(
        hedgeLegForSettings({
          futuresStrategy: FuturesStrategyEnum.neutral,
          strategy: StrategyEnum.long,
        }),
      ).to.equal(null)
    })

    it('settings that name nothing name no leg', () => {
      expect(hedgeLegForSettings({})).to.equal(null)
      expect(hedgeLegForSettings(undefined)).to.equal(null)
    })
  })

  describe('§4.2 one read per connection', () => {
    it('answers many bots on one connection with one venue call', async () => {
      let calls = 0
      const fetch = async () => {
        calls++
        // A real read is not instant; the coalescer has to hold the others.
        await new Promise((r) => setTimeout(r, 10))
        return ok(true)
      }
      const answers = await Promise.all(
        Array.from({ length: 12 }, () => readHedgeMode('uuid-a', fetch)),
      )
      expect(calls).to.equal(1)
      expect(answers.every((a) => a === true)).to.equal(true)
    })

    it('does not share an answer between connections', async () => {
      const answerA = await readHedgeMode('uuid-a', async () => ok(true))
      const answerB = await readHedgeMode('uuid-b', async () => ok(false))
      expect(answerA).to.equal(true)
      expect(answerB).to.equal(false)
    })

    it('serves a cached answer inside the window and re-reads outside it', async () => {
      let calls = 0
      const fetch = async () => {
        calls++
        return ok(true)
      }
      await readHedgeMode('uuid-a', fetch)
      await readHedgeMode('uuid-a', fetch)
      expect(calls).to.equal(1)
      // The refusal path's short window is what makes a re-read a real re-read.
      await readHedgeMode('uuid-a', fetch, 0)
      expect(calls).to.equal(2)
      expect(HEDGE_FRESH_TTL_MS).to.be.greaterThan(0)
    })

    it('never caches a venue error, and reads it as no answer', async () => {
      let calls = 0
      const failing = async () => {
        calls++
        return bad('Request failed with status code 502')
      }
      expect(await readHedgeMode('uuid-a', failing)).to.equal(null)
      expect(await readHedgeMode('uuid-a', failing)).to.equal(null)
      expect(calls).to.equal(2)
      // …and a later good answer is still cached normally.
      expect(await readHedgeMode('uuid-a', async () => ok(true))).to.equal(true)
      expect(await readHedgeMode('uuid-a', failing)).to.equal(true)
      expect(calls).to.equal(2)
    })

    it('reads a throw as no answer rather than rejecting', async () => {
      const answer = await readHedgeMode('uuid-a', async () => {
        throw new Error('socket hang up')
      })
      expect(answer).to.equal(null)
    })
  })
})
