process.env.NODE_ENV = 'testing'

/**
 * End-to-end regression for spec
 * `051.coin-m-take-profit-coverage-is-measured-in-two-units` (issue #788).
 *
 * Drives the REAL `dcaHelper.checkTpCoverage` — not a reimplementation — over
 * the production state of `6a8e19f4ec3af3dac20bc06b` (BTCUSD_260925,
 * `paperBinanceCoinm`), the one COIN-M deal in the 233 the detector reported
 * across 2 005 log lines. Two snapshots of the same deal are replayed, four
 * entries in and six entries in, because both were logged and both are exact:
 *
 *   2026-09-08  `over: take-profits offer 780  against … 1.00087508807`
 *   2026-09-16  `over: take-profits offer 1158 against … 1.50115221329`
 *
 * In both, the resting take-profit sells precisely the contracts the deal
 * holds (§2.2) — the order is right and only the comparison is wrong.
 *
 * Harness shape copied from `tpCoverageReconcile.harness.spec.ts`: the helper
 * is a mixin factory, so it is built on a minimal base class and every
 * venue-touching collaborator is recorded rather than performed. No stack, DB,
 * Redis or exchange connection, and nothing here places or cancels anything.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { ConditionLatch } from '../conditionLatch'
import { createRequire } from 'module'

const settings: any = {
  useMultiTp: false,
  useTp: true,
  trailingTp: false,
  dealCloseCondition: 'tp',
  multiTp: [],
  coinm: true,
  futures: true,
}

/**
 * `pairs/BTCUSD_260925` on `paperBinanceCoinm`, read from production.
 * `quoteAsset.minAmount` is the CONTRACT SIZE: $100 of notional per contract.
 */
const EXCHANGE_INFO: any = {
  pair: 'BTCUSD_260925',
  priceAssetPrecision: 1,
  baseAsset: { minAmount: 0, step: 0.0001, name: 'BTC' },
  quoteAsset: { minAmount: 100, name: 'USD' },
}

/**
 * `pairs/DOGE-USDT` on `okxLinear`. Here the contract is a FIXED multiple of
 * base — `getOKXDenominator` — with no price in it, so the comparison stays in
 * base and only the venue's `origQty` has to move.
 */
const OKX_EXCHANGE_INFO: any = {
  pair: 'DOGE-USDT',
  priceAssetPrecision: 5,
  baseAsset: { minAmount: 1, step: 0.001, multiplier: 1000, name: 'DOGE' },
  quoteAsset: { minAmount: 1, step: 0.0001, name: 'USDT' },
}

/**
 * `pairs/HYPE-USDT` on `okxLinear` — the mirror direction, one contract being
 * a FRACTION of base (0.1 HYPE). Its own entry because `baseAsset.minAmount`
 * decides whether `isActionable` lets the misread through: at DOGE's 1-unit
 * floor the 0.9 drift is swallowed as unactionable and the fixture proves
 * nothing on either side of the fix.
 */
const OKX_FRACTIONAL_EXCHANGE_INFO: any = {
  pair: 'HYPE-USDT',
  priceAssetPrecision: 3,
  baseAsset: { minAmount: 0.1, step: 0.1, name: 'HYPE' },
  quoteAsset: { minAmount: 1, step: 0.001, name: 'USDT' },
}

/** A spot pair, for the deal that must take an unchanged path. */
const SPOT_EXCHANGE_INFO: any = {
  pair: 'AIXBTUSDT',
  priceAssetPrecision: 6,
  baseAsset: { minAmount: 1, step: 0.1, name: 'AIXBT' },
  quoteAsset: { minAmount: 1, step: 0.01, name: 'USDT' },
}

/**
 * A take-profit as the reconcile pass hands it over: the venue's answer merged
 * onto our row. On COIN-M `origQty` is the venue's own figure and therefore
 * CONTRACTS, while `executedQty` has already been converted back to base by
 * `convertOrderExecutedQty` (`main.ts:6988`) — spec §2.3.
 */
const tp = (
  clientOrderId: string,
  status: string,
  origQtyContracts: string,
  executedQtyBase: string,
  price: string,
  dealId: string,
) => ({
  clientOrderId,
  status,
  origQty: origQtyContracts,
  executedQty: executedQtyBase,
  price,
  origPrice: price,
  dealId,
  typeOrder: 'dealTP',
  symbol: 'BTCUSD_260925',
})

const DEAL_ID = '6a8e19f4ec3af3dac20bc06b'
const TP_ID = 'D-TP-JCdJXSegPfMb2DZGnwy03cPiyYmSAe'

/**
 * The deal six entries in, 2026-09-16. `size` is the sum of the six filled
 * entries' `executedQty`; `avgPrice` is the contract-weighted average
 * `getAvgPrice` writes for a futures deal — `Σcᵢpᵢ / Σcᵢ = 77164.4…`.
 */
const COINM_SIX: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'BTCUSD_260925' },
  size: 1.5011522132931674,
  tpHistory: [],
  reduceFunds: [],
  lastPrice: 75162.5,
  avgPrice: 77164.5,
  initialPrice: 79118.5,
  // 1.3944 BTC @ 83041.7 on our row = 1158 contracts on the venue.
  tps: [tp(TP_ID, 'NEW', '1158', '0', '83041.7', DEAL_ID)],
}

/** The same deal four entries in, 2026-09-08: 780 contracts. */
const COINM_FOUR: any = {
  ...COINM_SIX,
  size: 1.00087508806845881,
  avgPrice: 77942.1,
  tps: [
    tp(
      'D-TP-7ZawVJ8R4jiBSBJlDI3XziXhHUD6B0',
      'NEW',
      '780',
      '0',
      '83041.7',
      DEAL_ID,
    ),
  ],
}

/**
 * The same deal with a take-profit that genuinely covers only half the
 * position. The check has to still find this one — a fix that simply stopped
 * looking at COIN-M would pass every other test in this file.
 */
const COINM_UNDER: any = {
  ...COINM_SIX,
  tps: [tp(TP_ID, 'NEW', '579', '0', '83041.7', DEAL_ID)],
}

/**
 * A partially filled COIN-M take-profit: `origQty` contracts, `executedQty`
 * base. 400 of the 1158 contracts have sold, which
 * `convertOrderExecutedQty` reports as `400 × 100 / 83041.7` BTC.
 */
const COINM_PARTIAL: any = {
  ...COINM_SIX,
  size: 1.5011522132931674,
  tpHistory: [{ id: TP_ID, qty: (400 * 100) / 83041.7, price: 83041.7 }],
  tps: [
    tp(
      TP_ID,
      'PARTIALLY_FILLED',
      '1158',
      `${(400 * 100) / 83041.7}`,
      '83041.7',
      DEAL_ID,
    ),
  ],
}

/**
 * AIXBTUSDT, spec `017` §2.1 (issue #702) — a spot deal resting one undersized
 * `NEW` take-profit. Present only to prove §4.5: a non-COIN-M deal must take a
 * numerically identical path.
 */
const SPOT_UNDER: any = {
  _id: '6a301c7ca999bdafb2ad8055',
  symbol: { symbol: 'AIXBTUSDT' },
  size: 510,
  tpHistory: [],
  reduceFunds: [],
  lastPrice: 0.023445,
  avgPrice: 0.0238,
  initialPrice: 0.02417,
  tps: [
    {
      clientOrderId: 'D-TP-3w5x48B7xtLpQUQMNepJpT1GKajf7j',
      status: 'NEW',
      origQty: '250',
      executedQty: '0',
      price: '0.0247',
      origPrice: '0.0247',
      dealId: '6a301c7ca999bdafb2ad8055',
      typeOrder: 'dealTP',
      symbol: 'AIXBTUSDT',
    },
  ],
}

/**
 * `6a9dac6b7a6e467322cc0044` (DOGE-USDT, `okxLinear`), read from production.
 * Our row rests `origQty: '450'` base; one OKX contract is 1 000 DOGE, so the
 * venue answers for the same order as `0.45`. The detector read that as 99.9%
 * of the position uncovered:
 *
 *   `under: 449.55 of 450 has no take-profit covering it (… resting 0.45)`
 */
const OKX_UNDER_FALSE: any = {
  _id: '6a9dac6b7a6e467322cc0044',
  symbol: { symbol: 'DOGE-USDT' },
  size: 450,
  tpHistory: [],
  reduceFunds: [],
  lastPrice: 0.08935,
  avgPrice: 0.09,
  initialPrice: 0.09,
  tps: [
    {
      clientOrderId: '4b1c2ba2186cBCDEDTPs8meNmtlkbZ2F',
      status: 'NEW',
      origQty: '0.45',
      executedQty: '0',
      price: '0.08403',
      origPrice: '0.08403',
      dealId: '6a9dac6b7a6e467322cc0044',
      typeOrder: 'dealTP',
      symbol: 'DOGE-USDT',
    },
  ],
}

/**
 * The same deal with a take-profit that genuinely covers only half the
 * position — 225 DOGE, which the venue states as `0.225`. Still has to be
 * found, and still counted in base.
 */
const OKX_UNDER_REAL: any = {
  ...OKX_UNDER_FALSE,
  tps: [{ ...OKX_UNDER_FALSE.tps[0], origQty: '0.225' }],
}

/**
 * `6a9d9746836419ea7f1db2c3` (HYPE-USDT, `okxLinear`), the mirror direction:
 * one contract is 0.1 HYPE, so a 0.1-base take-profit is `1` on the venue and
 * the deal read ten times over-covered —
 * `over: take-profits offer 1 against a tracked position of 0.1`.
 */
const OKX_OVER_FALSE: any = {
  _id: '6a9d9746836419ea7f1db2c3',
  symbol: { symbol: 'HYPE-USDT' },
  size: 0.1,
  tpHistory: [],
  reduceFunds: [],
  lastPrice: 86.311,
  avgPrice: 88.075,
  initialPrice: 88.075,
  tps: [
    {
      clientOrderId: '4b1c2ba2186cBCDEDTPtPqgnPjxuPEhk',
      status: 'NEW',
      origQty: '1',
      executedQty: '0',
      price: '83.768',
      origPrice: '83.768',
      dealId: '6a9d9746836419ea7f1db2c3',
      typeOrder: 'dealTP',
      symbol: 'HYPE-USDT',
    },
  ],
}

class FakeBase {
  math = new MathHelper()
  botId = '6a8e19f450f82e20424ea2de'
  userId = 'user'
  standingConditionLatch = new ConditionLatch(24 * 60 * 60 * 1000)
  data: any = {
    settings,
    exchange: ExchangeEnum.paperBinanceCoinm,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/**
 * `okx` is the second contract-sized family: `sizedInContracts` rather than
 * `coinm`, a fixed `getOKXDenominator` rather than a price. `1 / multiplier`
 * is what the real getter returns for `okxLinear` — 0.001 on a 1 000-DOGE
 * contract, 10 on a 0.1-HYPE one.
 */
const buildBot = (
  deals: readonly any[],
  venue: 'coinm' | 'spot' | 'okx' = 'coinm',
) => {
  const coinm = venue === 'coinm'
  class TestBot extends Helper {
    public cancelled: any[] = []
    public placed: any[] = []
    public warns: string[] = []
    public logs: string[] = []
    public rearmQty = 1158
    public userFee: any = { maker: 0.0005, taker: 0.0005 }

    get coinm() {
      return coinm
    }
    get isBitget() {
      return false
    }
    get sizedInContracts() {
      return venue === 'okx'
    }
    async getOKXDenominator(symbol: string) {
      // The real getter: `1 / baseAsset.multiplier` when the contract is more
      // than one unit of base, else the step's precision as a power of ten.
      return symbol === 'HYPE-USDT' ? 10 : 0.001
    }
    getDealsByStatusAndSymbol() {
      return deals.map((d) => ({
        deal: d,
        initialOrders: [],
        currentOrders: [],
      }))
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo(symbol: string) {
      return venue === 'coinm'
        ? EXCHANGE_INFO
        : venue === 'okx'
          ? symbol === 'HYPE-USDT'
            ? OKX_FRACTIONAL_EXCHANGE_INFO
            : OKX_EXCHANGE_INFO
          : SPOT_EXCHANGE_INFO
    }
    async getUserFee() {
      return this.userFee
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async cancelOrderOnExchange(o: any) {
      this.cancelled.push(o.clientOrderId)
      return undefined
    }
    async getTPOrder() {
      return [{ qty: this.rearmQty, price: 83041.7 }]
    }
    async placeOrders(_b: string, _s: string, dealId: string, orders: any) {
      this.placed.push({ dealId, orders })
    }
    handleWarn(m: string) {
      this.warns.push(m)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
  }
  return new TestBot()
}

const confirmedFrom = (deals: readonly any[]) => {
  const map = new Map<string, any[]>()
  for (const d of deals) map.set(d._id, [...d.tps])
  return map
}

const run = async (bot: any, deals: readonly any[]) =>
  await bot.checkTpCoverage(confirmedFrom(deals), new Set<string>())

const driftLines = (bot: any) =>
  bot.warns.filter((w: string) => w.startsWith('tp-coverage drift'))

describe('checkTpCoverage on COIN-M (spec 051, issue #788)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module. The correction is left
    // disarmed (BOT_TP_COVERAGE_REPAIR unset), which is production today.
    this.timeout(180000)
    delete process.env.BOT_TP_COVERAGE_REPAIR
    delete loadModule.cache[loadModule.resolve('../dcaHelper')]
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('§1.1 a correctly-sized COIN-M take-profit reads covered', () => {
    it('does not report the six-entry snapshot (the 2026-09-16 line)', async () => {
      const bot = buildBot([COINM_SIX])
      await run(bot, [COINM_SIX])
      expect(driftLines(bot).join('\n')).to.equal('')
    })

    it('does not report the four-entry snapshot (the 2026-09-08 line)', async () => {
      const bot = buildBot([COINM_FOUR])
      await run(bot, [COINM_FOUR])
      expect(driftLines(bot).join('\n')).to.equal('')
    })

    it('never reports the 772x contracts-against-base figure', async () => {
      // Both snapshots carry the same deal id, so they cannot share a bot:
      // the standing-condition latch would report only the first.
      const six = buildBot([COINM_SIX])
      await run(six, [COINM_SIX])
      const four = buildBot([COINM_FOUR])
      await run(four, [COINM_FOUR])
      // The exact production wording, both dates.
      expect(six.warns.join('\n')).to.not.contain(
        'offer 1158 against a tracked position of 1.50115221329',
      )
      expect(four.warns.join('\n')).to.not.contain(
        'offer 780 against a tracked position of 1.00087508807',
      )
    })

    it('leaves a partially filled COIN-M take-profit alone', async () => {
      // `origQty` contracts minus `executedQty` base is the mixed-unit
      // subtraction of §2.3; both legs have to reach the decision as contracts.
      const bot = buildBot([COINM_PARTIAL])
      await run(bot, [COINM_PARTIAL])
      expect(driftLines(bot).join('\n')).to.equal('')
    })

    it('values the 400 sold contracts at the price they sold at', async () => {
      // The trap this fixture exists for: netting in base first and converting
      // the remainder once values that close at the ENTRY average, turning 400
      // contracts into 372 and a covered deal into 29 contracts `under`.
      const bot = buildBot([COINM_PARTIAL])
      await run(bot, [COINM_PARTIAL])
      const w = bot.warns.join('\n')
      expect(w).to.not.contain('under')
      expect(w).to.not.contain('786')
    })
  })

  describe('§1.1 a genuinely uncovered COIN-M position is still found', () => {
    it('reports half the position as uncovered, in contracts', async () => {
      const bot = buildBot([COINM_UNDER])
      await run(bot, [COINM_UNDER])
      const w = driftLines(bot).join('\n')
      expect(w).to.contain('under')
      expect(w).to.contain(DEAL_ID)
      // 1158.36 tracked - 579 resting, not 1.5 - 579 and not 579 - 0.6996.
      expect(w).to.contain('579')
    })

    it('§4.3 says it is counting contracts, not base', async () => {
      const bot = buildBot([COINM_UNDER])
      await run(bot, [COINM_UNDER])
      const w = driftLines(bot).join('\n')
      expect(w).to.contain('contract')
      expect(w).to.not.contain('more base')
    })
  })

  describe('§4.6 OKX/KuCoin futures are contract-sized too', () => {
    it('does not report DOGE-USDT as 449.55 of 450 uncovered', async () => {
      const bot = buildBot([OKX_UNDER_FALSE], 'okx')
      await run(bot, [OKX_UNDER_FALSE])
      expect(driftLines(bot).join('\n')).to.equal('')
    })

    it('does not report HYPE-USDT as ten times over-covered', async () => {
      const bot = buildBot([OKX_OVER_FALSE], 'okx')
      await run(bot, [OKX_OVER_FALSE])
      expect(driftLines(bot).join('\n')).to.equal('')
    })

    it('never reproduces either production line', async () => {
      const under = buildBot([OKX_UNDER_FALSE], 'okx')
      await run(under, [OKX_UNDER_FALSE])
      expect(under.warns.join('\n')).to.not.contain('449.55 of 450')
      const over = buildBot([OKX_OVER_FALSE], 'okx')
      await run(over, [OKX_OVER_FALSE])
      expect(over.warns.join('\n')).to.not.contain(
        'offer 1 against a tracked position of 0.1',
      )
    })

    it('still finds a genuinely half-covered OKX position, in base', async () => {
      // A fix that merely skipped contract-sized venues would pass every
      // other case in this block.
      const bot = buildBot([OKX_UNDER_REAL], 'okx')
      await run(bot, [OKX_UNDER_REAL])
      const w = driftLines(bot).join('\n')
      expect(w).to.contain('under: 225 of 450 has no take-profit covering it')
      // Base is conserved on a linear contract, so the wording does not change.
      expect(w).to.not.contain('contract')
    })
  })

  describe('§4.5 a deal on neither contract family is unaffected', () => {
    it('still reports AIXBTUSDT as 260 of 510 uncovered, in base', async () => {
      const bot = buildBot([SPOT_UNDER], 'spot')
      await run(bot, [SPOT_UNDER])
      // The exact line spec 017 pinned, unchanged.
      expect(driftLines(bot).join('\n')).to.contain('under: 260 of 510')
    })
  })
})
