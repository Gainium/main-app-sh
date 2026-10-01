process.env.NODE_ENV = 'testing'

/**
 * The signal-based take-profit close approval hook.
 *
 * `closeAllDeals` asks `approveDealClose(ctx)` per deal when a take-profit
 * close signal (close-deal indicator group, or webhook `close` with the TP
 * close condition set to webhook) is about to close it — after the
 * minimum-profit check. Stop loss, force closes and every other close never
 * ask. A refusal keeps the deal open and writes one `Deal` event; a failing
 * hook closes as usual; the default hook answers synchronously.
 *
 * Drives the REAL `dcaHelper.closeAllDeals` (and Combo's inherited one) over a
 * minimal base class: no stack, DB, Redis or venue. Fixture ids are synthetic
 * — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import {
  buildDealCloseSignal,
  dealCloseHeldDescription,
  resolveDealCloseTrigger,
  type DealCloseApprovalContext,
} from './dealCloseApproval'
import {
  CloseConditionEnum,
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  ExchangeEnum,
  IndicatorAction,
  IndicatorSection,
} from '../../types'

const BOT_ID = '0000000000000000000a0028'
const USER_ID = '0000000000000000000b0028'
const PAIR = 'ETH-USDC'

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  isLong = true
  isShort = false
  futures = false
  combo = false
  hedge = false
  scaleAr = false
  tpAr = false
  slAr = false
  exchange: any = {}
  orders = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.binance,
    paperContext: true,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

type Hook = boolean | 'throw' | 'reject' | Promise<boolean>

const loadModule = createRequire(__filename)
let DcaHelper: any
let ComboHelper: any

const TP_INDICATOR = {
  type: 'RSI',
  indicatorAction: IndicatorAction.closeDeal,
  section: IndicatorSection.tp,
  indicatorCondition: 'gt',
  indicatorValue: '70',
  indicatorInterval: '15m',
  indicatorLength: 14,
}

const buildBot = (
  Helper: any,
  hook: Hook | ((ctx: DealCloseApprovalContext) => Hook),
  settings: Record<string, unknown>,
  dealIds = ['d1'],
  opts: { minTpOk?: boolean; override?: boolean } = {},
) => {
  const seen = {
    asked: [] as DealCloseApprovalContext[],
    closed: [] as string[],
    events: [] as any[],
  }
  const deals = new Map(
    dealIds.map((id) => [
      id,
      { deal: { _id: id, symbol: { symbol: PAIR }, status: 'open' } },
    ]),
  )
  class TestBot extends Helper {
    seen = seen
    deals = deals
    botEventDb = {
      createData: async (d: any) => {
        seen.events.push(d)
        return { status: 'OK', data: d }
      },
    }
    getOpenDeals() {
      return [...deals.values()]
    }
    getDeal(id: string) {
      return deals.get(id)
    }
    async getAggregatedSettings() {
      return { ...settings }
    }
    async checkMinTp() {
      return opts.minTpOk ?? true
    }
    async closeDealById(_b: string, id: string) {
      seen.closed.push(id)
      deals.delete(id)
    }
    handleLog(m: string) {
      return m
    }
    handleWarn(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
  }
  if (opts.override !== false) {
    ;(TestBot.prototype as any).approveDealClose = function (
      ctx: DealCloseApprovalContext,
    ) {
      seen.asked.push({ ...ctx })
      const h = typeof hook === 'function' ? hook(ctx) : hook
      if (h === 'throw') {
        throw new Error('hook failure')
      }
      if (h === 'reject') {
        return Promise.reject(new Error('hook failure'))
      }
      if (h === false) {
        ctx.refusalReason = 'rule says hold'
        return Promise.resolve(false)
      }
      return h
    }
  }
  return new TestBot()
}

const INDICATOR_TP = {
  useTp: true,
  dealCloseCondition: CloseConditionEnum.techInd,
  indicators: [TP_INDICATOR],
}
const WEBHOOK_TP = { useTp: true, dealCloseCondition: CloseConditionEnum.webhook }

const indicatorClose = (bot: any) =>
  bot.closeAllDeals(
    CloseDCATypeEnum.closeByMarket,
    PAIR,
    true,
    true,
    undefined,
    undefined,
    undefined,
    DCACloseTriggerEnum.tp,
  )
const webhookClose = (bot: any, ignoreSettings = false, sl = false) =>
  bot.closeAllDeals(
    CloseDCATypeEnum.closeByMarket,
    PAIR,
    true,
    true,
    ignoreSettings,
    sl,
    undefined,
    DCACloseTriggerEnum.webhook,
  )

describe('signal take-profit close approval hook', () => {
  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
    ComboHelper = loadModule('./comboHelper').default(
      loadModule('./dcaHelper').default(FakeBase as any),
    )
  })

  describe('trigger classification', () => {
    const base = { useTp: true }
    it('indicator TP and webhook TP are signal closes', () => {
      expect(
        resolveDealCloseTrigger({
          ...base,
          closeTrigger: DCACloseTriggerEnum.tp,
          dealCloseCondition: CloseConditionEnum.techInd,
        }),
      ).to.equal('indicator')
      expect(
        resolveDealCloseTrigger({
          ...base,
          closeTrigger: DCACloseTriggerEnum.webhook,
          dealCloseCondition: CloseConditionEnum.webhook,
        }),
      ).to.equal('webhook')
    })
    it('stop loss, force, TP off and other close conditions are not', () => {
      const w = {
        closeTrigger: DCACloseTriggerEnum.webhook,
        dealCloseCondition: CloseConditionEnum.webhook,
      }
      expect(resolveDealCloseTrigger({ ...base, ...w, slSource: true })).to.equal(
        null,
      )
      expect(resolveDealCloseTrigger({ ...base, ...w, force: true })).to.equal(
        null,
      )
      expect(resolveDealCloseTrigger({ ...w, useTp: false })).to.equal(null)
      expect(
        resolveDealCloseTrigger({
          ...base,
          closeTrigger: DCACloseTriggerEnum.webhook,
          dealCloseCondition: CloseConditionEnum.tp,
        }),
      ).to.equal(null)
      for (const t of [
        DCACloseTriggerEnum.sl,
        DCACloseTriggerEnum.liquidation,
        DCACloseTriggerEnum.manual,
        DCACloseTriggerEnum.api,
        DCACloseTriggerEnum.auto,
        DCACloseTriggerEnum.trailing,
        undefined,
      ]) {
        expect(
          resolveDealCloseTrigger({
            ...base,
            closeTrigger: t,
            dealCloseCondition: CloseConditionEnum.techInd,
          }),
          `${t}`,
        ).to.equal(null)
      }
    })
    it('the signal names the TP close conditions and the shortest timeframe', () => {
      const s = buildDealCloseSignal([
        TP_INDICATOR as any,
        { ...TP_INDICATOR, indicatorInterval: '1h' } as any,
        { ...TP_INDICATOR, section: IndicatorSection.sl, indicatorInterval: '1m' } as any,
      ])
      expect(s?.timeframe).to.equal('15m')
      expect(s?.conditions).to.have.length(2)
      expect(buildDealCloseSignal([])).to.equal(undefined)
    })
    it('event text names the reason', () => {
      expect(dealCloseHeldDescription('x')).to.equal(
        'Close signal held by extension: x',
      )
      expect(dealCloseHeldDescription()).to.match(/no reason given/)
    })
  })

  for (const [name, helper] of [
    ['DCA', () => DcaHelper],
    ['Combo', () => ComboHelper],
  ] as const) {
    describe(`${name}: closeAllDeals`, () => {
      it('asks for an indicator TP close; a hold keeps the deal and writes one event', async () => {
        const bot = buildBot(helper(), false, INDICATOR_TP)
        await indicatorClose(bot)
        expect(bot.seen.asked).to.have.length(1)
        expect(bot.seen.asked[0]).to.include({
          botId: BOT_ID,
          dealId: 'd1',
          symbol: PAIR,
          trigger: 'indicator',
        })
        expect(bot.seen.asked[0].signal?.timeframe).to.equal('15m')
        expect(bot.seen.closed).to.deep.equal([])
        expect(bot.seen.events).to.have.length(1)
        expect(bot.seen.events[0]).to.include({
          event: 'Deal',
          deal: 'd1',
          symbol: PAIR,
          description: dealCloseHeldDescription('rule says hold'),
        })
      })

      it('asks for a webhook TP close; an approval closes', async () => {
        const bot = buildBot(helper(), Promise.resolve(true), WEBHOOK_TP)
        await webhookClose(bot)
        expect(bot.seen.asked.map((c: any) => c.trigger)).to.deep.equal([
          'webhook',
        ])
        expect(bot.seen.closed).to.deep.equal(['d1'])
        expect(bot.seen.events).to.have.length(0)
      })

      it('never asks for a webhook closeSl, an ignoreSettings force close, or liquidation', async () => {
        const settings = {
          ...WEBHOOK_TP,
          useSl: true,
          dealCloseConditionSL: CloseConditionEnum.webhook,
        }
        for (const run of [
          (b: any) => webhookClose(b, false, true),
          (b: any) => webhookClose(b, true, false),
          (b: any) =>
            b.closeAllDeals(
              undefined,
              PAIR,
              false,
              undefined,
              true,
              true,
              2500,
              DCACloseTriggerEnum.liquidation,
            ),
        ]) {
          const bot = buildBot(helper(), false, settings)
          await run(bot)
          expect(bot.seen.asked).to.have.length(0)
          expect(bot.seen.closed).to.deep.equal(['d1'])
        }
      })

      it('never asks for an SL indicator close', async () => {
        const bot = buildBot(helper(), false, {
          ...INDICATOR_TP,
          useSl: true,
          dealCloseConditionSL: CloseConditionEnum.techInd,
        })
        await bot.closeAllDeals(
          CloseDCATypeEnum.closeByMarket,
          PAIR,
          false,
          true,
          undefined,
          true,
          undefined,
          DCACloseTriggerEnum.sl,
        )
        expect(bot.seen.asked).to.have.length(0)
        expect(bot.seen.closed).to.deep.equal(['d1'])
      })

      it('never asks when the deal TP is not signal-based (percentage TP + SL webhook)', async () => {
        const bot = buildBot(helper(), false, {
          useTp: true,
          dealCloseCondition: CloseConditionEnum.tp,
          useSl: true,
          dealCloseConditionSL: CloseConditionEnum.webhook,
        })
        await webhookClose(bot)
        expect(bot.seen.asked).to.have.length(0)
        expect(bot.seen.closed).to.deep.equal(['d1'])
      })

      it('never asks when the minimum profit is not met (no close at all)', async () => {
        const bot = buildBot(helper(), false, INDICATOR_TP, ['d1'], {
          minTpOk: false,
        })
        await indicatorClose(bot)
        expect(bot.seen.asked).to.have.length(0)
        expect(bot.seen.closed).to.deep.equal([])
      })

      it('a throwing or rejecting hook closes as usual', async () => {
        for (const h of ['throw', 'reject'] as const) {
          const bot = buildBot(helper(), h, INDICATOR_TP)
          await indicatorClose(bot)
          expect(bot.seen.closed, h).to.deep.equal(['d1'])
          expect(bot.seen.events, h).to.have.length(0)
        }
      })

      it('the default hook approves synchronously', async () => {
        const bot = buildBot(helper(), false, INDICATOR_TP, ['d1'], {
          override: false,
        })
        expect(
          bot.approveDealClose({
            botId: BOT_ID,
            dealId: 'd1',
            symbol: PAIR,
            trigger: 'indicator',
            time: 0,
          }),
        ).to.equal(true)
        await indicatorClose(bot)
        expect(bot.seen.closed).to.deep.equal(['d1'])
      })

      it('asks several deals together and closes only the approved ones still open', async () => {
        let release: () => void = () => undefined
        const gate = new Promise<void>((r) => (release = r))
        const bot = buildBot(
          helper(),
          (ctx) => gate.then(() => ctx.dealId !== 'd2'),
          INDICATOR_TP,
          ['d1', 'd2', 'd3'],
        )
        const run = indicatorClose(bot)
        await new Promise((r) => setTimeout(r, 10))
        // all three asked before any answer arrived
        expect(bot.seen.asked.map((c: any) => c.dealId)).to.deep.equal([
          'd1',
          'd2',
          'd3',
        ])
        // d3 closes by other means while waiting
        bot.deals.delete('d3')
        release()
        await run
        expect(bot.seen.closed).to.deep.equal(['d1'])
        expect(bot.seen.events.map((e: any) => e.deal)).to.deep.equal(['d2'])
      })

      it('a hold leaves the deal closable: the next approved signal closes it', async () => {
        let answer = false
        const bot = buildBot(helper(), () => answer, INDICATOR_TP)
        await indicatorClose(bot)
        expect(bot.seen.closed).to.deep.equal([])
        // nothing marks the deal as closing while held
        expect(bot.getDeal('d1')).to.not.equal(undefined)
        answer = true
        await indicatorClose(bot)
        expect(bot.seen.asked).to.have.length(2)
        expect(bot.seen.closed).to.deep.equal(['d1'])
      })

      it('a synchronous approval closes without waiting for the others', async () => {
        const bot = buildBot(
          helper(),
          (ctx) => (ctx.dealId === 'd1' ? true : new Promise(() => undefined)),
          INDICATOR_TP,
          ['d1', 'd2'],
        )
        void indicatorClose(bot)
        await new Promise((r) => setTimeout(r, 10))
        expect(bot.seen.closed).to.deep.equal(['d1'])
      })
    })
  }
})
