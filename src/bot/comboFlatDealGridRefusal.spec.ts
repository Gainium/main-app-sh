process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `175.a-flat-combo-deal-keeps-resending-refused-grid-buy-backs`.
 *
 * Drives the REAL Combo `handleOrderErrors` override and, through it, the REAL
 * dcaHelper `reconcileDealPosition` (probe, cooldown, two-readings rule) over
 * a minimal base class. The venue position call, `closeDealById` and the bot
 * event DAO are recorded instead of run. `closeDealById(closeByMarket, base)`
 * is the combo base-minigrid close, covered on its own elsewhere.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import RedisClient from '../db/redis'
import {
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'

const BOT_ID = '000000000000000000000b75'
const DEAL_ID = '000000000000000000000d75'
const PAIR = 'AAAUSDT'

/** The production refusal, verbatim from the venue. */
const ZERO_POSITION = 'current position is zero, cannot fix reduce-only order qty'

const cooldownStore = new Map<string, string>()
let previousGetInstance: unknown
const useCooldownStore = () => {
  cooldownStore.clear()
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => cooldownStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      cooldownStore.set(k, v)
    },
    del: async (k: string) => {
      cooldownStore.delete(k)
    },
  })
}
const releaseCooldownStore = () => {
  if (previousGetInstance) {
    ;(RedisClient as any).getInstance = previousGetInstance
  }
}
/** The probe cooldown's window has passed: the next refusal may ask again. */
const expireProbeWindow = () => {
  for (const [k, v] of cooldownStore) {
    if (k.startsWith('dpp:')) {
      cooldownStore.set(k, JSON.stringify({ ...JSON.parse(v), until: 0 }))
    }
  }
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000475'
  loadingComplete = true
  futures = true
  coinm = false
  hedge = false
  orders = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.bybitUsdm,
    exchangeUUID: 'uuid-175',
    flags: [],
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  /** `main.ts`'s reporter — the part of the refusal path that exists today. */
  async handleOrderErrors(e: string) {
    ;(this as any).reported.push(e)
  }
  constructor(..._a: any[]) {}
}

let Combo: any

type Opts = { isLong?: boolean; positions?: any[] | 'unavailable' }

const buildBot = ({ isLong = false, positions = [] }: Opts = {}) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'AAA', quoteAsset: 'USDT' },
  }
  const full: any = {
    deal,
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
    closeBySl: false,
  }
  class TestBot extends Combo {
    reported: string[] = []
    probes = 0
    closes: any[][] = []
    events: any[] = []
    isLong = isLong
    exchange: any = {
      futures_getPositions: async () => {
        this.probes++
        await new Promise((r) => setTimeout(r, 5))
        return positions === 'unavailable'
          ? { status: StatusEnum.notok, data: null, reason: 'timeout' }
          : { status: StatusEnum.ok, data: positions, reason: null }
      },
    }
    botEventDb: any = {
      createData: async (d: any) => {
        this.events.push(d)
        return { status: StatusEnum.ok }
      },
    }
    getDeal(id: string) {
      return id === DEAL_ID ? full : undefined
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async closeDealById(...args: any[]) {
      this.closes.push(args)
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)(BOT_ID, ExchangeEnum.bybitUsdm, false)
  return { bot, full }
}

const gridOrder = (side: 'BUY' | 'SELL', typeOrder = TypeOrderEnum.dealGrid) =>
  ({
    clientOrderId: `CMB-GR-fixture${Math.random().toString(36).slice(2, 8)}`,
    dealId: DEAL_ID,
    symbol: PAIR,
    side,
    typeOrder,
    origQty: '254',
    price: '0.0269',
  }) as any

/** The override hands the settle off without awaiting it; let it finish. */
const settle = () => new Promise((r) => setTimeout(r, 40))

const refuse = async (bot: any, order: any, reason = ZERO_POSITION) => {
  await bot.handleOrderErrors(
    reason,
    order,
    'limitOrders()',
    `Send new order request ${order.clientOrderId}`,
  )
  await settle()
}

describe('a flat combo deal re-sending refused grid buy-backs (spec 175)', () => {
  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    const Dca = req('./dcaHelper').default(FakeBase)
    Combo = req('./comboHelper').default(Dca)
  })
  beforeEach(useCooldownStore)
  afterEach(releaseCooldownStore)

  it('§1.1.2 closes the deal on the base trigger after two flat readings', async () => {
    const { bot, full } = buildBot()
    await refuse(bot, gridOrder('BUY'))
    // The refusal is still reported exactly as before.
    expect(bot.reported).to.deep.equal([ZERO_POSITION])
    expect(bot.probes).to.equal(1)
    expect(bot.closes).to.have.length(0)
    // Inside the cooldown, a further refusal does not ask again.
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(1)
    expireProbeWindow()
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(1)
    const [botId, dealId, closeType] = bot.closes[0]
    expect([botId, dealId, closeType]).to.deep.equal([
      BOT_ID,
      DEAL_ID,
      CloseDCATypeEnum.closeByMarket,
    ])
    expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.base)
    expect(full.closeBySl).to.equal(true)
    expect(bot.events).to.have.length(1)
    expect(bot.events[0].deal).to.equal(DEAL_ID)
    // The deal is closing: later refusals change nothing.
    expireProbeWindow()
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(1)
  })

  it('§1.1.2 a long deal settles on a refused reduce-only SELL the same way', async () => {
    const { bot } = buildBot({ isLong: true })
    await refuse(bot, gridOrder('SELL'))
    expireProbeWindow()
    await refuse(bot, gridOrder('SELL'))
    expect(bot.closes).to.have.length(1)
    expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.base)
  })

  it('§1.1.3 leaves the deal open while the venue still holds its position', async () => {
    const { bot } = buildBot({
      positions: [{ symbol: PAIR, positionAmt: '-1133', positionSide: 'BOTH' }],
    })
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(1)
    // An answered probe that found the position clears the cooldown.
    expect([...cooldownStore.keys()].some((k) => k.startsWith('dpp:'))).to.equal(
      false,
    )
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(0)
    expect(bot.events).to.have.length(0)
  })

  it('§1.1.3 never settles on a venue that did not answer', async () => {
    const { bot } = buildBot({ positions: 'unavailable' })
    await refuse(bot, gridOrder('BUY'))
    expireProbeWindow()
    await refuse(bot, gridOrder('BUY'))
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(0)
  })

  it('§1.1.4 a burst of refusals asks the venue once', async () => {
    const { bot } = buildBot()
    const orders = [gridOrder('BUY'), gridOrder('BUY'), gridOrder('BUY')]
    await Promise.all(
      orders.map((o) =>
        bot.handleOrderErrors(ZERO_POSITION, o, 'limitOrders()', 'step'),
      ),
    )
    await settle()
    expect(bot.probes).to.equal(1)
    expect(bot.closes).to.have.length(0)
  })

  describe('§1.1.5 nothing is asked', () => {
    it('for an opening-side grid order', async () => {
      const { bot } = buildBot()
      await refuse(bot, gridOrder('SELL'))
      expect(bot.probes).to.equal(0)
    })
    it('for a safety order', async () => {
      const { bot } = buildBot()
      await refuse(bot, gridOrder('BUY', TypeOrderEnum.dealRegular))
      expect(bot.probes).to.equal(0)
    })
    it('for another refusal reason', async () => {
      const { bot } = buildBot()
      await refuse(bot, gridOrder('BUY'), 'orderQty will be truncated to zero.')
      expect(bot.probes).to.equal(0)
      expect(bot.reported).to.have.length(1)
    })
    it('on a spot bot', async () => {
      const { bot } = buildBot()
      bot.futures = false
      await refuse(bot, gridOrder('BUY'))
      expect(bot.probes).to.equal(0)
    })
    it('for a deal that is already closing', async () => {
      const { bot, full } = buildBot()
      full.closeBySl = true
      await refuse(bot, gridOrder('BUY'))
      expect(bot.probes).to.equal(0)
    })
    it('for a deal that is not open', async () => {
      const { bot, full } = buildBot()
      full.deal.status = DCADealStatusEnum.closed
      await refuse(bot, gridOrder('BUY'))
      expect(bot.probes).to.equal(0)
    })
  })
})
