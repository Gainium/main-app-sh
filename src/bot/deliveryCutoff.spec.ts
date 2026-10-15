process.env.NODE_ENV = 'testing'

/**
 * Dated futures contracts must not get a fresh automatic deal shortly before
 * delivery: the exchange settles every open position at delivery, so a deal
 * opened the day before is closed by the exchange, not by the bot.
 *
 * The pure cutoff (`deliveryRefusingNewDeal`) and the engine gate that uses it
 * (`refuseNewDealNearDelivery`, shared by DCA, combo, hedge sides and terminal)
 * are both pinned here. Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  DELIVERY_NEW_DEAL_CUTOFF_MS,
  deliveryRefusingNewDeal,
  normalizeDeliveryTime,
} from './deliveryCutoff'
import { standingConditionKey, newDealNearDelivery } from './conditionLatch'
import createDCABotHelper from './dcaHelper'
import { DCATypeEnum, StartConditionEnum } from '../../types'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const HOUR = 60 * 60 * 1000

describe('deliveryCutoff', () => {
  it('normalises a delivery time to a positive ms epoch or undefined', () => {
    expect(normalizeDeliveryTime(1792137600000)).to.equal(1792137600000)
    expect(normalizeDeliveryTime('1792137600000')).to.equal(1792137600000)
    expect(normalizeDeliveryTime(0)).to.equal(undefined)
    expect(normalizeDeliveryTime(null)).to.equal(undefined)
    expect(normalizeDeliveryTime(undefined)).to.equal(undefined)
    expect(normalizeDeliveryTime('x')).to.equal(undefined)
  })

  it('never refuses a pair without a delivery time (perpetual / spot)', () => {
    expect(deliveryRefusingNewDeal({}, NOW)).to.equal(null)
    expect(deliveryRefusingNewDeal(undefined, NOW)).to.equal(null)
    expect(deliveryRefusingNewDeal({ deliveryTime: 0 }, NOW)).to.equal(null)
  })

  it('refuses a contract that delivers within the cutoff, or already has', () => {
    const tomorrow = NOW + 20 * HOUR
    expect(deliveryRefusingNewDeal({ deliveryTime: tomorrow }, NOW)).to.equal(
      tomorrow,
    )
    const atCutoff = NOW + DELIVERY_NEW_DEAL_CUTOFF_MS
    expect(deliveryRefusingNewDeal({ deliveryTime: atCutoff }, NOW)).to.equal(
      atCutoff,
    )
    const past = NOW - HOUR
    expect(deliveryRefusingNewDeal({ deliveryTime: past }, NOW)).to.equal(past)
  })

  it('lets a contract that delivers later than the cutoff trade', () => {
    expect(
      deliveryRefusingNewDeal(
        { deliveryTime: NOW + DELIVERY_NEW_DEAL_CUTOFF_MS + 1 },
        NOW,
      ),
    ).to.equal(null)
    expect(
      deliveryRefusingNewDeal({ deliveryTime: NOW + 60 * 24 * HOUR }, NOW),
    ).to.equal(null)
  })
})

describe('refuseNewDealNearDelivery (engine gate)', () => {
  const DCABot = createDCABotHelper()
  const gate = DCABot.prototype.refuseNewDealNearDelivery

  const makeBot = (settings: Record<string, unknown> = {}) => {
    const events: Record<string, unknown>[] = []
    const reported = new Set<string>()
    const cleared: string[] = []
    const bot = {
      botId: '000000000000000000000d01',
      userId: '000000000000000000000d02',
      botType: 'dca',
      data: { paperContext: false },
      getAggregatedSettings: async () => ({
        startCondition: StartConditionEnum.asap,
        ...settings,
      }),
      handleLog: () => undefined,
      botEventDb: {
        createData: (row: Record<string, unknown>) => events.push(row),
      },
      standingConditionLatch: {
        shouldReport: (key: string) => {
          if (reported.has(key)) return false
          reported.add(key)
          return true
        },
        clear: (key: string) => {
          cleared.push(key)
          reported.delete(key)
        },
      },
    }
    return { bot, events, cleared }
  }

  // Delivery two hours away — the shape of a weekly contract on its last day.
  const soon = () => ({
    pair: 'DOGEUSDT-09OCT26',
    deliveryTime: Date.now() + 2 * HOUR,
  })

  it('refuses an automatic start and reports it once per pair', async () => {
    const { bot, events } = makeBot()
    const ed = soon() as any
    expect(
      await gate.call(bot as any, ed.pair, ed, false, false, 'asap'),
    ).to.equal(true)
    expect(
      await gate.call(bot as any, ed.pair, ed, false, false, 'asap'),
    ).to.equal(true)
    expect(events).to.have.length(1)
    expect(events[0].symbol).to.equal(ed.pair)
    expect(String(events[0].description)).to.match(/delivers/)
  })

  it('refuses indicator and webhook starts too', async () => {
    const ed = soon() as any
    for (const trigger of ['indicator', 'webhook', 'timer'] as const) {
      const { bot } = makeBot()
      expect(
        await gate.call(bot as any, ed.pair, ed, false, false, trigger),
      ).to.equal(true)
    }
  })

  it('lets a manual open through', async () => {
    const { bot, events } = makeBot()
    const ed = soon() as any
    expect(
      await gate.call(bot as any, ed.pair, ed, true, false, 'manual'),
    ).to.equal(false)
    expect(events).to.have.length(0)
  })

  it('lets a terminal deal through', async () => {
    const { bot } = makeBot({ type: DCATypeEnum.terminal })
    const ed = soon() as any
    expect(
      await gate.call(bot as any, ed.pair, ed, false, false, 'asap'),
    ).to.equal(false)
  })

  it('never refuses a perpetual, and re-arms the report', async () => {
    const { bot, cleared } = makeBot()
    const perp = { pair: 'DOGEUSDT' } as any
    expect(
      await gate.call(bot as any, perp.pair, perp, false, false, 'asap'),
    ).to.equal(false)
    expect(cleared).to.deep.equal([
      standingConditionKey(newDealNearDelivery, perp.pair),
    ])
  })

  it('lets a dated contract far from delivery trade', async () => {
    const { bot } = makeBot()
    const ed = {
      pair: 'BTCUSDT-25DEC26',
      deliveryTime: Date.now() + DELIVERY_NEW_DEAL_CUTOFF_MS + 24 * HOUR,
    } as any
    expect(
      await gate.call(bot as any, ed.pair, ed, false, false, 'asap'),
    ).to.equal(false)
  })
})
