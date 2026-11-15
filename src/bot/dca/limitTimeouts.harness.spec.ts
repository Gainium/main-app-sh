process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `100` — "Enter Market Timeout" must be opt-in.
 *
 * A LIMIT base order on a bot whose switch was off went to market 35 s after
 * the deal opened: the engine's `35000` default applied whenever the switch
 * was off. Two layers:
 *
 *  - the pure derivation (`resolveLimitTimeouts`), against the rule table;
 *  - the REAL `setClassProperties` over the mixin with a minimal base class,
 *    which is where both `start()`s pick the values up.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { resolveLimitTimeouts } from './limitTimeouts'

describe('Enter Market Timeout is opt-in (spec 100)', () => {
  describe('§4.1 switch off, or on with no usable seconds', () => {
    const cases: Array<
      [string, { useLimitTimeout?: boolean; limitTimeout?: string }]
    > = [
      ['off, 0', { useLimitTimeout: false, limitTimeout: '0' }],
      ['off, 20', { useLimitTimeout: false, limitTimeout: '20' }],
      ['off, unset', {}],
      ['on, 0', { useLimitTimeout: true, limitTimeout: '0' }],
      ['on, blank', { useLimitTimeout: true, limitTimeout: '' }],
      ['on, garbage', { useLimitTimeout: true, limitTimeout: 'abc' }],
    ]
    for (const [label, settings] of cases) {
      it(`${label}: no entry timer, repositioning every 10 s`, () => {
        const t = resolveLimitTimeouts(settings)
        expect(t.enterMarketTimeout).to.equal(0)
        expect(t.orderLimitRepositionTimeout).to.equal(10_000)
      })
    }
  })

  describe('§4.2 switch on with seconds', () => {
    it('honours the user value and keeps repositioning under it', () => {
      const t = resolveLimitTimeouts({
        useLimitTimeout: true,
        limitTimeout: '20',
      })
      expect(t.enterMarketTimeout).to.equal(20_000)
      expect(t.orderLimitRepositionTimeout).to.equal(10_000)
    })
    it('a timeout shorter than the reposition interval disables repositioning', () => {
      const t = resolveLimitTimeouts({
        useLimitTimeout: true,
        limitTimeout: '5',
      })
      expect(t.enterMarketTimeout).to.equal(5_000)
      expect(t.orderLimitRepositionTimeout).to.equal(0)
    })
  })

  describe('§4.3 close-by-limit and the top-up window keep the old value', () => {
    it('35 s whenever the switch did not override it', () => {
      for (const s of [
        { useLimitTimeout: false, limitTimeout: '0' },
        { useLimitTimeout: false, limitTimeout: '20' },
        { useLimitTimeout: true, limitTimeout: '' },
        {},
      ]) {
        expect(
          resolveLimitTimeouts(s).limitFallbackTimeout,
          JSON.stringify(s),
        ).to.equal(35_000)
      }
    })
    it('the user value when the switch is on', () => {
      expect(
        resolveLimitTimeouts({ useLimitTimeout: true, limitTimeout: '120' })
          .limitFallbackTimeout,
      ).to.equal(120_000)
      expect(
        resolveLimitTimeouts({ useLimitTimeout: true, limitTimeout: '0' })
          .limitFallbackTimeout,
      ).to.equal(0)
    })
  })

  describe('§4.4/§4.5 the real setClassProperties', () => {
    class FakeBase {
      botId = '000000000000000000000b64'
      data: any = { settings: {} }
      constructor(..._a: any[]) {}
    }
    let Helper: any
    before(() => {
      Helper = createRequire(__filename)('../dcaHelper').default(
        FakeBase as any,
      )
    })
    const run = async (bot: any, settings: Record<string, unknown>) => {
      bot.getAggregatedSettings = async () => ({ ...settings })
      await Helper.prototype.setClassProperties.call(bot)
    }
    const fresh = () => {
      const bot: any = Object.create(Helper.prototype)
      bot.data = { settings: {} }
      // What the constructor leaves before `start()` resolves the settings.
      bot.orderLimitRepositionTimeout = 10_000
      bot.enterMarketTimeout = 35_000
      return bot
    }

    it('§4.5 a LIMIT bot with the switch off arms no enter-market timer', async () => {
      const bot = fresh()
      await run(bot, {
        startOrderType: 'LIMIT',
        useLimitTimeout: false,
        limitTimeout: '0',
        notUseLimitReposition: false,
      })
      expect(bot.enterMarketTimeout).to.equal(0)
      expect(bot.orderLimitRepositionTimeout).to.equal(10_000)
      expect(bot.limitFallbackTimeout).to.equal(35_000)
    })

    it('§4.4 re-derives on every call — no sticky reposition interval', async () => {
      const bot = fresh()
      await run(bot, { useLimitTimeout: true, limitTimeout: '5' })
      expect(bot.orderLimitRepositionTimeout).to.equal(0)
      await run(bot, { useLimitTimeout: true, limitTimeout: '60' })
      expect(bot.enterMarketTimeout).to.equal(60_000)
      expect(bot.orderLimitRepositionTimeout).to.equal(10_000)
    })
  })
})

describe('spec 242 phase 2 — resolveLimitTimeouts reads entryExecution', () => {
  it('chase: reposition interval and market timeout come from the execution', () => {
    expect(
      resolveLimitTimeouts({
        entryExecution: { mode: 'chase', repriceSec: 20, timeoutSec: 60 },
      }),
    ).to.deep.equal({
      orderLimitRepositionTimeout: 20_000,
      enterMarketTimeout: 60_000,
      limitFallbackTimeout: 35_000,
    })
  })
  it('limit: no repositioning, market after the timeout', () => {
    expect(
      resolveLimitTimeouts({
        entryExecution: { mode: 'limit', timeoutSec: 45 },
      }),
    ).to.deep.include({
      orderLimitRepositionTimeout: 0,
      enterMarketTimeout: 45_000,
    })
  })
  it('chase with no timeout keeps repositioning forever (spec 100 opt-in)', () => {
    expect(
      resolveLimitTimeouts({
        entryExecution: { mode: 'chase', repriceSec: 15 },
      }),
    ).to.deep.include({
      orderLimitRepositionTimeout: 15_000,
      enterMarketTimeout: 0,
    })
  })
  it('the close fallback stays on the legacy switch', () => {
    expect(
      resolveLimitTimeouts({
        useLimitTimeout: true,
        limitTimeout: '50',
        entryExecution: { mode: 'chase', repriceSec: 10, timeoutSec: 20 },
      }).limitFallbackTimeout,
    ).to.equal(50_000)
  })
  it('market or no stored execution: unchanged legacy derivation', () => {
    expect(
      resolveLimitTimeouts({ useLimitTimeout: true, limitTimeout: '20' }),
    ).to.deep.equal(
      resolveLimitTimeouts({
        useLimitTimeout: true,
        limitTimeout: '20',
        entryExecution: { mode: 'market' },
      }),
    )
  })
})
