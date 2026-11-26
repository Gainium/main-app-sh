process.env.NODE_ENV = 'testing'

/**
 * Core spec 288. A futures DCA bot that opens several deals at once gates
 * each of them against what the account can still fund — not against one
 * balance read every deal of the burst shared.
 *
 * Two layers:
 *
 *  - `NewDealMarginClaims` alone: when a claim counts, and what retires it;
 *  - the REAL `openNewDeal` → `checkBalanceGate` → `checkBalance` path over a
 *    minimal base, with a venue whose balance read is a snapshot taken when
 *    the request starts and whose margin drops only once a base order lands.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import { MathHelper } from '../../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from '../conditionLatch'
import {
  BotStatusEnum,
  BotType,
  CloseConditionEnum,
  ExchangeEnum,
  StartConditionEnum,
} from '../../../types'
import {
  GATED_CLAIM_TTL_MS,
  NewDealMarginClaims,
} from './newDealMarginClaims'

const BOT_ID = '000000000000000000000d81'
const USER_ID = '000000000000000000000d82'
const PAIRS = ['AAA-USDT', 'BBB-USDT', 'CCC-USDT']

/** Each deal: base order 200 @ 0.5 = 100 USDT at leverage 1, no safety orders. */
const DEAL_MARGIN = 100

const exchangeInfo = (pair: string) => ({
  pair,
  priceAssetPrecision: 4,
  baseAsset: { name: pair.split('-')[0], minAmount: 0.1, step: 0.1 },
  quoteAsset: { name: 'USDT', minAmount: 1 },
  maxOrders: 200,
})

describe('new-deal margin claims (core spec 288)', () => {
  describe('NewDealMarginClaims', () => {
    it('counts a claim from the gate until a read started after placement', () => {
      const c = new NewDealMarginClaims()
      const id = c.claim('USDT', 40, 1_000)
      expect(c.claimed('USDT')).to.equal(40)
      expect(c.claimed('USDC')).to.equal(0)
      c.placing(id)
      c.settle(5_000)
      expect(c.claimed('USDT'), 'still placing: no read reflects it').to.equal(
        40,
      )
      c.placed(id, 6_000)
      c.settle(6_000)
      expect(c.claimed('USDT'), 'read started with the ack').to.equal(40)
      c.settle(6_001)
      expect(c.claimed('USDT')).to.equal(0)
      expect(c.size).to.equal(0)
    })

    it('sums claims per asset and releases one directly', () => {
      const c = new NewDealMarginClaims()
      const a = c.claim('USDT', 10)
      c.claim('USDT', 15)
      c.claim('USDC', 7)
      expect(c.claimed('USDT')).to.equal(25)
      c.release(a)
      expect(c.claimed('USDT')).to.equal(15)
      c.release(undefined)
      expect(c.size).to.equal(2)
    })

    it('drops a gated claim whose deal never reached its base order', () => {
      const c = new NewDealMarginClaims()
      c.claim('USDT', 10, 0)
      c.settle(GATED_CLAIM_TTL_MS)
      expect(c.claimed('USDT')).to.equal(10)
      c.settle(GATED_CLAIM_TTL_MS + 1)
      expect(c.size).to.equal(0)
    })

    it('never drops a placing claim on age', () => {
      const c = new NewDealMarginClaims()
      c.placing(c.claim('USDT', 10, 0))
      c.settle(GATED_CLAIM_TTL_MS * 10)
      expect(c.claimed('USDT')).to.equal(10)
    })
  })

  describe('openNewDeal on a burst', () => {
    let clock: sinon.SinonFakeTimers | undefined
    let createDca: (base: any) => any

    before(function () {
      this.timeout(240000)
      createDca = createRequire(__filename)('../dcaHelper').default
    })

    afterEach(() => {
      clock?.restore()
      clock = undefined
    })

    type Venue = {
      free: number
      placed: string[]
      errors: string[]
      reads: number
    }

    const build = (o: {
      free: number
      futures?: boolean
      /** pre-288: the gate takes no claim */
      noClaims?: boolean
      /** the venue refuses the base order of these pairs */
      refuse?: string[]
      cooldownStart?: string[]
    }) => {
      const venue: Venue = { free: o.free, placed: [], errors: [], reads: 0 }
      class FakeBase {
        math = new MathHelper()
        botId = BOT_ID
        userId = USER_ID
        botType = BotType.dca
        loadingComplete = true
        isLong = true
        isShort = false
        futures = o.futures ?? true
        coinm = false
        combo = false
        hedge = false
        exchange: any = {}
        orders = new Map()
        standingConditionLatch = new ConditionLatch(
          STANDING_CONDITION_REARM_MS,
        )
        ignoreErrors = false
        shouldProceed() {
          return true
        }
        async reportUserRefusal() {}
        constructor(..._a: any[]) {}
      }
      const Helper = createDca(FakeBase)
      class TestBot extends Helper {
        data: any = {
          settings: {
            type: 'regular',
            name: 'Burst bot',
            pair: PAIRS,
            startCondition: StartConditionEnum.asap,
            useTp: true,
            dealCloseCondition: CloseConditionEnum.tp,
          },
          status: BotStatusEnum.open,
          exchange: ExchangeEnum.binanceUsdm,
          exchangeUUID: 'uuid-d8',
          profit: { total: 0 },
          flags: [],
          paperContext: false,
          workingShift: [{ start: 1 }],
        }
        pairs = new Set(PAIRS)
        openNewDealTimer = new Map()
        botEventDb = { createData: async (d: any) => ({ status: 'OK', data: d }) }
        async checkBalanceGate(symbol: string, claimMargin = false) {
          return super.checkBalanceGate(symbol, o.noClaims ? false : claimMargin)
        }
        // A read is a snapshot of the account when the request starts, and
        // answers 10 ms later — reads in flight together see the same figure.
        async checkAssets(_r: boolean, direct: boolean) {
          if (direct) {
            venue.reads++
          }
          const free = venue.free
          await new Promise((r) => setTimeout(r, 10))
          return new Map([['USDT', { asset: 'USDT', free, locked: 0 }]])
        }
        async getAggregatedSettings() {
          return {
            ...this.data.settings,
            skipBalanceCheck: false,
            orderSizeType: 'quote',
            baseOrderSize: '100',
          }
        }
        async getExchangeInfo(symbol: string) {
          return exchangeInfo(symbol)
        }
        async getLeverageMultipler() {
          return 1
        }
        async getLatestPrice() {
          return 0.5
        }
        async getBaseOrder() {
          return { origQty: '200', price: '0.5' }
        }
        async createInitialDealOrders() {
          return []
        }
        async createCurrentDealOrders() {
          return []
        }
        async reservedFundingQuote() {
          return 0
        }
        async baseFundingAllowed() {
          return false
        }
        async pooledMarginOrKeep(_a: string, available: number) {
          return available
        }
        async reduceToAvailableRatio() {
          return { ratio: null }
        }
        async refuseNewDealNearDelivery() {
          return false
        }
        async refuseNewDealAfterRefusedEntries() {
          return false
        }
        async refuseNewDealAgainstOpposingPosition() {
          return false
        }
        async checkMaxDeals() {
          return true
        }
        async checkInRange() {
          return true
        }
        async refuseDealBelowExchangeMin() {
          return false
        }
        async checkCooldownStart(_b: string, symbol: string) {
          return {
            status: !(o.cooldownStart ?? []).includes(symbol),
            time: 0,
            last: 0,
            diff: 0,
            cooldown: 0,
          }
        }
        async checkCooldownStop() {
          return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
        }
        async checkNewDealApproval() {
          return {}
        }
        requestSignalBaseOrderSize() {}
        // the cooldown re-arm timer: out of scope here
        openDealAfterTimer() {}
        async applyNewDealSize(_s: string, _a: unknown, sizes: unknown) {
          return { sizes, outcome: undefined }
        }
        async reportNewDealSize() {}
        resetPending() {}
        updateDealLastTime() {}
        releaseReduceToAvailableClaim() {}
        // The venue acks after 30 ms; only then is the margin out of `free`.
        async placeBaseOrder(_b: string, symbol: string) {
          await new Promise((r) => setTimeout(r, 30))
          if ((o.refuse ?? []).includes(symbol)) {
            return
          }
          venue.free -= DEAL_MARGIN
          venue.placed.push(symbol)
        }
        getOpenDeals(..._a: any[]): any[] {
          return []
        }
        handleErrors(m: string) {
          venue.errors.push(m)
        }
        startMethod() {
          return '1'
        }
        endMethod() {}
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
      return { bot: new TestBot() as any, venue }
    }

    const burst = async (bot: any, pairs = PAIRS) => {
      const c = clock as sinon.SinonFakeTimers
      const runs = pairs.map((p) => bot.openNewDeal(BOT_ID, p))
      await c.tickAsync(6_000)
      await Promise.all(runs)
    }

    const fake = () => {
      clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'Date'],
        now: 1_700_000_000_000,
      })
    }

    const refusals = (v: Venue) =>
      v.errors.filter((e) => e.startsWith('Not enough balance to start new deal'))

    it('reproduces the defect without claims: every deal opens on one read', async () => {
      fake()
      const { bot, venue } = build({ free: 150, noClaims: true })
      await burst(bot)
      expect(venue.placed).to.have.length(3)
      expect(venue.free).to.be.lessThan(0)
    })

    it('free covers one: one opens, two get the quiet warning, no venue order for them', async () => {
      fake()
      const { bot, venue } = build({ free: 150 })
      await burst(bot)
      expect(venue.placed).to.deep.equal([PAIRS[0]])
      expect(refusals(venue)).to.have.length(2)
      expect(venue.free).to.equal(50)
      // one report per pair, quiet path (handleErrors), each naming the claim
      for (const m of refusals(venue)) {
        expect(m).to.match(/available: 50 USDT/)
      }
      // A read after the fill retires the claim: nothing leaks.
      const read = bot.checkBalance(PAIRS[0], 1, 'whole', 'live', true)
      await (clock as sinon.SinonFakeTimers).tickAsync(20)
      const r = await read
      expect(r.status, 'free 50 cannot fund a fourth').to.equal(false)
      expect(r.claimed ?? 0, 'the placed claim is settled').to.equal(0)
      expect(bot.newDealMarginClaims.size).to.equal(0)
    })

    it('free covers all three: all open at the same size, no refusal', async () => {
      fake()
      const { bot, venue } = build({ free: 300 })
      await burst(bot)
      expect(venue.placed).to.have.members(PAIRS)
      expect(venue.free).to.equal(0)
      expect(refusals(venue)).to.have.length(0)
    })

    it('free covers two: two open, one refused', async () => {
      fake()
      const { bot, venue } = build({ free: 250 })
      await burst(bot)
      expect(venue.placed).to.deep.equal(PAIRS.slice(0, 2))
      expect(refusals(venue)).to.have.length(1)
    })

    it('a deal that ends before its base order releases its claim', async () => {
      fake()
      const { bot, venue } = build({ free: 150, cooldownStart: [PAIRS[0]] })
      await burst(bot)
      // AAA passed the gate first and then stopped on its cooldown: its
      // margin goes back, so BBB opens and CCC is refused.
      expect(venue.placed).to.deep.equal([PAIRS[1]])
      expect(refusals(venue), venue.errors.join(' | ')).to.have.length(1)
      expect(bot.newDealMarginClaims.size).to.be.at.most(1)
    })

    it('a base order the venue refuses releases its claim at the next read', async () => {
      fake()
      const { bot, venue } = build({ free: 150, refuse: [PAIRS[0]] })
      await burst(bot)
      // The 5 s re-check reads after the refusal: the margin is still free.
      expect(venue.placed).to.have.length(1)
      expect(venue.placed[0]).to.not.equal(PAIRS[0])
      expect(venue.free).to.equal(50)
    })

    it('spot takes no claim and is unchanged', async () => {
      fake()
      const { bot, venue } = build({ free: 150, futures: false })
      await burst(bot)
      expect(venue.placed).to.have.length(3)
      expect(bot.newDealMarginClaims.size).to.equal(0)
    })
  })
})
