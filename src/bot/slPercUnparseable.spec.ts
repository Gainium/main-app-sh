process.env.NODE_ENV = 'testing'

/**
 * A stop-loss % that does not parse as a number.
 *
 * `getDealStopLossPrice` computes `parseFloat(slPerc)`. For a value like 'abc'
 * that is NaN, so the function fell through to `return 0`, and 0 went into
 * `dealsForStopLoss` as if it were a level. `checkDealsStopLoss` then tested
 * `last <= 0` on a long (never true: the stop was dead) and `last >= 0` on a
 * short (always true: the deal closed at market on the next tick).
 *
 * Covers both layers of the fix:
 * - the deal-edit guard every route runs (`checkDealEditProtectionNumbers`);
 * - the engine treating a level of 0 / NaN as "no level" and saying so once.
 *
 * Drives the REAL `getDealStopLossPrice` and `checkDealsStopLoss`.
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { CloseConditionEnum, StatusEnum } from '../../types'
import { checkDealEditProtectionNumbers } from './utils'

const DEAL_ID = '000000000000000000000d91'
const BOT_ID = '000000000000000000000b91'
const SYMBOL = 'BTCUSDT'
const PRICE = 100

let Helper: any

const buildBot = (long: boolean, dealSettings: Record<string, unknown>) => {
  class TestBot extends (Helper as any) {
    botId = BOT_ID
    botType = 'dca'
    data: any = {
      settings: {
        name: 'bot',
        pair: [SYMBOL],
        strategy: long ? 'LONG' : 'SHORT',
        type: 'regular',
        ordersCount: 1,
        activeOrdersCount: 1,
        useDca: true,
        useSl: true,
        slPerc: '-5',
        dealCloseConditionSL: CloseConditionEnum.tp,
      },
      status: 'open',
      exchange: 'binance',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>()
    async replaceBotSettings(s: any) {
      return s
    }
    async baseSlOn() {
      return 'avg'
    }
    async getUserFee() {
      return { taker: 0 }
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)()
  // The engine keeps `isLong` on the instance, which would shadow a getter.
  Object.defineProperty(bot, 'isLong', { value: long, configurable: true })
  const deal = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
    settings: {
      useSl: true,
      dealCloseConditionSL: CloseConditionEnum.tp,
      ...dealSettings,
    },
    avgPrice: PRICE,
    initialPrice: PRICE,
    levels: { all: 2, complete: 1 },
  }
  const errors: string[] = []
  bot.handleErrors = async (m: string) => {
    errors.push(m)
  }
  return { bot, deal, errors }
}

describe('a stop-loss % that is not a number', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  describe('deal-edit guard', () => {
    const ok = (current: object, patch: object) =>
      checkDealEditProtectionNumbers(current as any, patch as any).status

    it('refuses an unparseable slPerc while stop loss is on', () => {
      for (const bad of ['abc', '', '  ', null, '5abc']) {
        expect(ok({ useSl: true }, { slPerc: bad }), `${bad}`).to.equal(
          StatusEnum.notok,
        )
      }
    })

    it('refuses turning stop loss on over a stored unparseable slPerc', () => {
      expect(ok({ slPerc: 'abc' }, { useSl: true })).to.equal(StatusEnum.notok)
    })

    it('accepts numeric strings and numbers', () => {
      expect(ok({ useSl: true }, { slPerc: '-5' })).to.equal(StatusEnum.ok)
      expect(ok({ useSl: true }, { slPerc: -5 })).to.equal(StatusEnum.ok)
      expect(ok({ useSl: true }, { slPerc: '-2.5' })).to.equal(StatusEnum.ok)
    })

    it('ignores slPerc when stop loss is off or not by percent', () => {
      expect(ok({ useSl: false }, { slPerc: 'abc' })).to.equal(StatusEnum.ok)
      expect(
        ok(
          { useSl: true, dealCloseConditionSL: CloseConditionEnum.techInd },
          { slPerc: '' },
        ),
      ).to.equal(StatusEnum.ok)
    })

    it('accepts a valid fixed SL price in place of slPerc', () => {
      expect(
        ok(
          { useSl: true },
          { useFixedSLPrices: true, fixedSlPrice: '95', slPerc: '' },
        ),
      ).to.equal(StatusEnum.ok)
    })

    it('checks multi-SL targets instead of slPerc', () => {
      expect(
        ok(
          { useSl: true, slPerc: '' },
          { useMultiSl: true, multiSl: [{ target: '-3', amount: '100' }] },
        ),
      ).to.equal(StatusEnum.ok)
      expect(
        ok(
          { useSl: true },
          { useMultiSl: true, multiSl: [{ target: 'x', amount: '100' }] },
        ),
      ).to.equal(StatusEnum.notok)
    })

    it('applies the same rule to take profit', () => {
      expect(ok({ useTp: true }, { tpPerc: 'abc' })).to.equal(StatusEnum.notok)
      expect(ok({ useTp: true }, { tpPerc: '1.5' })).to.equal(StatusEnum.ok)
      expect(ok({ useTp: false }, { tpPerc: 'abc' })).to.equal(StatusEnum.ok)
      expect(
        ok(
          { useTp: true },
          { useFixedTPPrices: true, fixedTpPrice: '110', tpPerc: '' },
        ),
      ).to.equal(StatusEnum.ok)
    })

    it('lets an edit through when the deal already holds valid numbers', () => {
      // The dashboard drawer sends many unrelated keys, often as null.
      expect(
        ok(
          { useSl: true, slPerc: '-5', useTp: true, tpPerc: '1' },
          { orderSize: '10', leverage: null, futures: null, step: '1' },
        ),
      ).to.equal(StatusEnum.ok)
    })
  })

  describe('engine', () => {
    it('getDealStopLossPrice gives no level and reports it once', async () => {
      const { bot, deal, errors } = buildBot(true, { slPerc: 'abc' })
      const d = { deal }
      expect(await bot.getDealStopLossPrice(d)).to.equal(0)
      expect(await bot.getDealStopLossPrice(d)).to.equal(0)
      expect(errors).to.have.length(1)
      expect(errors[0]).to.contain('stop loss is on')
    })

    it('control: a valid slPerc gives a level and no report', async () => {
      const { bot, deal, errors } = buildBot(true, { slPerc: '-5' })
      expect(await bot.getDealStopLossPrice({ deal })).to.be.closeTo(95, 1e-9)
      expect(errors).to.have.length(0)
    })

    const runCheck = async (long: boolean, level: number, last: number) => {
      const { bot, deal } = buildBot(long, { slPerc: '-5' })
      const fired: string[] = []
      bot.allowedMethods = new Set(['checkDealsStopLoss'])
      bot.dealsForStopLoss = new Map([[DEAL_ID, level]])
      bot.getDeal = () => ({ deal })
      bot.getLastStreamData = () => ({ price: last })
      bot.isTrailingCloseInFlight = () => false
      bot.saveDeal = async () => undefined
      bot.triggerStopLoss = (id: string) => fired.push(id)
      bot.closeDealBySl = (id: string) => fired.push(id)
      await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
      return fired
    }

    it('a short deal with a level of 0 is not closed', async () => {
      expect(await runCheck(false, 0, PRICE)).to.deep.equal([])
    })

    it('a short deal with a NaN level is not closed', async () => {
      expect(await runCheck(false, NaN, PRICE)).to.deep.equal([])
    })

    it('control: a short deal past a real level is closed', async () => {
      expect(await runCheck(false, 105, 106)).to.not.deep.equal([])
    })

    it('control: a long deal past a real level is closed', async () => {
      expect(await runCheck(true, 95, 94)).to.not.deep.equal([])
    })
  })
})
