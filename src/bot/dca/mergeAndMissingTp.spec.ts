process.env.NODE_ENV = 'testing'

/**
 * Merging DCA deals on an account the venue is refusing, and the take profit
 * that is missing afterwards.
 *
 * Replays a Hyperliquid spot bot whose API wallet had expired. Four merges ran:
 * each wrote its merged deal and cancelled its sources in the database while
 * every cancel and take profit behind it was refused ("User or API Wallet 0x…
 * does not exist"). The sources' take profits stayed live on the venue, holding
 * the coins, so once the wallet was renewed the merged deals' take profits
 * were refused for balance, and nothing placed them again. Meanwhile the
 * bot's error badge flickered (cleared before each placement, set again by its
 * refusal) and every source deal was reported as "position left open, no take
 * profit will be applied".
 *
 * Run: `npm test` (mocha) from core/.
 *
 * No network / DB needed: the real methods run on a DCA helper built over the
 * real MainBot, with the venue, the order book and reporting stubbed.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import AuthFailureGuard, { isHardAuthFailure } from '../authGuard'
import { isRetryableTrailingCloseRejection } from './trailingCloseRetry'
import { dealCloseEventDescription, type DealOutcome } from './dealOutcome'
import { DCADealStatusEnum, ExchangeEnum, TypeOrderEnum } from '../../../types'

const HL_WALLET =
  'user or api wallet 0x16f207739139d271de34d1d0e48ed26682a1861f does not exist.'
const SOL_A = 'aaaaaaaaaaaaaaaaaaaa0001'
const SOL_B = 'aaaaaaaaaaaaaaaaaaaa0002'
const MERGED = 'aaaaaaaaaaaaaaaaaaaa0003'

function tp(dealId: string, id: string, qty: string) {
  return {
    symbol: 'SOL-USDC',
    clientOrderId: id,
    dealId,
    typeOrder: TypeOrderEnum.dealTP,
    price: '122',
    origQty: qty,
    executedQty: '0',
    status: 'NEW',
    side: 'SELL',
  } as any
}

const originalCheck = AuthFailureGuard.check
function authDead(dead: boolean) {
  AuthFailureGuard.check = async () =>
    dead
      ? { failed: true, reason: HL_WALLET, until: Date.now() + 300_000 }
      : { failed: false, reason: null, until: null }
}

describe('merge on a refused account, and the missing take profit', () => {
  let DCA: any

  before(function () {
    // One ts-node compile of a large module.
    this.timeout(180000)
    DCA = createRequire(__filename)('../dcaHelper').default(MainBot)
  })

  afterEach(() => {
    AuthFailureGuard.check = originalCheck
  })

  /** A spot DCA helper whose order book is a plain array. */
  function dcaBot(orders: any[], openDeals: string[]) {
    const rec = {
      cancels: [] as string[],
      rearmed: [] as string[],
      placed: [] as { dealId: string; qty: number[] }[],
      errors: [] as string[],
      reported: [] as string[],
      restored: 0,
    }
    const b: any = Object.create(DCA.prototype)
    b.botId = 'bbbbbbbbbbbbbbbbbbbb0001'
    b.userId = 'cccccccccccccccccccc0001'
    b.data = {
      exchange: ExchangeEnum.hyperliquid,
      exchangeUUID: 'uuid-1',
      paperContext: false,
      status: 'error',
    }
    b.missingTpRearm = new Map()
    b.deals = new Map(
      openDeals.map((id) => [
        id,
        {
          deal: {
            _id: id,
            status: DCADealStatusEnum.open,
            symbol: { symbol: 'SOL-USDC' },
            lastPrice: 95,
            avgPrice: 103,
            initialPrice: 110,
          },
          initialOrders: [],
        },
      ]),
    )
    b.getDeal = (id: string) => b.deals.get(id)
    b.getOrdersByStatusAndDealId = ({
      dealId,
      status,
    }: {
      dealId: string
      status: string[]
    }) =>
      orders.filter(
        (o) => o.dealId === dealId && [status].flat().includes(o.status),
      )
    b.shouldProceed = () => true
    b.handleLog = () => undefined
    b.handleDebug = () => undefined
    b.handleWarn = () => undefined
    b.handleErrors = async (e: string) => {
      rec.errors.push(e)
    }
    b.processError = async (..._a: any[]) => {
      rec.reported.push(_a[5])
    }
    b.getTPOrder = async () => [{ qty: 6.5, type: TypeOrderEnum.dealTP }]
    b.placeOrders = async (_b: string, _s: string, dealId: string, o: any) => {
      rec.placed.push({ dealId, qty: o.new.map((n: any) => n.qty) })
    }
    b.restoreFromRangeOrError = () => {
      rec.restored++
    }
    return { b, rec }
  }

  describe('the expired Hyperliquid wallet is a dead key', () => {
    it('is a hard auth failure, so the account goes on the cooldown', () => {
      expect(isHardAuthFailure(HL_WALLET)).to.equal(true)
      expect(isHardAuthFailure(`User or API Wallet 0xabc does not exist`)).to.equal(true)
    })
    it('and a trailing close does not retry it', () => {
      expect(isRetryableTrailingCloseRejection(HL_WALLET)).to.equal(false)
    })
  })

  describe('the error badge', () => {
    it('stays while the account is refused', async () => {
      authDead(true)
      const { b, rec } = dcaBot([], [])
      expect(await b.restoreFromErrorUnlessAuthDead()).to.equal(false)
      expect(rec.restored).to.equal(0)
    })
    it('is restored as before otherwise', async () => {
      authDead(false)
      const { b, rec } = dcaBot([], [])
      expect(await b.restoreFromErrorUnlessAuthDead()).to.equal(true)
      expect(rec.restored).to.equal(1)
    })
    it('paper bots never ask', async () => {
      authDead(true)
      const { b, rec } = dcaBot([], [])
      b.data.paperContext = true
      expect(await b.restoreFromErrorUnlessAuthDead()).to.equal(true)
      expect(rec.restored).to.equal(1)
    })
  })

  describe('merge', () => {
    it('is refused up front while the account is refused, touching nothing', async () => {
      authDead(true)
      const { b, rec } = dcaBot([], [SOL_A, SOL_B])
      b.combo = false
      b.dealsDb = {
        readData: async () => {
          throw new Error('must not read deals')
        },
      }
      await b.mergeDealsBody([SOL_A, SOL_B])
      expect(rec.errors).to.have.length(1)
      expect(rec.errors[0]).to.contain('Deals were not merged')
      expect(rec.errors[0]).to.contain(HL_WALLET)
    })

    it('pulls every source take profit before the merged deal exists', async () => {
      const orders = [tp(SOL_A, 'A1', '5.775'), tp(SOL_B, 'B1', '0.199')]
      const { b, rec } = dcaBot(orders, [SOL_A, SOL_B])
      b.cancelOrderOnExchange = async (o: any) => {
        rec.cancels.push(o.clientOrderId)
        o.status = 'CANCELED'
        return o
      }
      b.rearmMissingTp = async (id: string) => rec.rearmed.push(id)
      const refused = await b.cancelMergeSourceTakeProfits([
        { _id: SOL_A },
        { _id: SOL_B },
      ])
      expect(refused).to.equal(undefined)
      expect(rec.cancels).to.deep.equal(['A1', 'B1'])
      expect(rec.rearmed).to.deep.equal([])
    })

    it('stops at a refused cancel and puts back what it pulled', async () => {
      const orders = [tp(SOL_A, 'A1', '5.775'), tp(SOL_B, 'B1', '0.199')]
      const { b, rec } = dcaBot(orders, [SOL_A, SOL_B])
      b.cancelOrderOnExchange = async (o: any) => {
        rec.cancels.push(o.clientOrderId)
        if (o.clientOrderId === 'B1') {
          return undefined // refused: the row stays NEW
        }
        o.status = 'CANCELED'
        return o
      }
      b.rearmMissingTp = async (id: string) => rec.rearmed.push(id)
      const refused = await b.cancelMergeSourceTakeProfits([
        { _id: SOL_A },
        { _id: SOL_B },
      ])
      expect(refused).to.contain(`take profit of deal ${SOL_B}`)
      expect(rec.rearmed).to.deep.equal([SOL_A])
    })

    it('leaves a source held by another process to its own close', async () => {
      const orders = [tp(SOL_A, 'A1', '5.775')]
      const { b, rec } = dcaBot(orders, [])
      b.cancelOrderOnExchange = async (o: any) => {
        rec.cancels.push(o.clientOrderId)
        return o
      }
      expect(await b.cancelMergeSourceTakeProfits([{ _id: SOL_A }])).to.equal(
        undefined,
      )
      expect(rec.cancels).to.deep.equal([])
    })
  })

  describe('a take profit missing after a placement pass', () => {
    it('is reported once and re-sent later', async () => {
      const { b, rec } = dcaBot([], [MERGED])
      await b.noteTpCoverageAfterPlacement(MERGED)
      const entry = b.missingTpRearm.get(MERGED)
      expect(entry.attempt).to.equal(0)
      expect(entry.timer).to.not.equal(undefined)
      expect(rec.reported).to.have.length(1)
      expect(rec.reported[0]).to.contain('no take profit on the exchange')

      // A second pass while the re-send is pending changes nothing.
      await b.noteTpCoverageAfterPlacement(MERGED)
      expect(b.missingTpRearm.get(MERGED).attempt).to.equal(0)

      // The re-send fired and was refused again: wait longer, say nothing new.
      clearTimeout(entry.timer)
      entry.timer = undefined
      await b.noteTpCoverageAfterPlacement(MERGED)
      expect(b.missingTpRearm.get(MERGED).attempt).to.equal(1)
      expect(rec.reported).to.have.length(1)
      b.clearMissingTpRearm(MERGED)
    })

    it('is dropped once a take profit rests', async () => {
      const orders: any[] = []
      const { b } = dcaBot(orders, [MERGED])
      await b.noteTpCoverageAfterPlacement(MERGED)
      orders.push(tp(MERGED, 'M1', '11.826'))
      await b.noteTpCoverageAfterPlacement(MERGED)
      expect(b.missingTpRearm.has(MERGED)).to.equal(false)
    })

    it('is not chased when the deal has no take profit to rest', async () => {
      const { b, rec } = dcaBot([], [MERGED])
      b.getTPOrder = async () => []
      await b.noteTpCoverageAfterPlacement(MERGED)
      expect(b.missingTpRearm.has(MERGED)).to.equal(false)
      expect(rec.reported).to.deep.equal([])
    })

    it('the re-send places the deal-sized take profit', async () => {
      const { b, rec } = dcaBot([], [MERGED])
      await b.rearmMissingTp(MERGED)
      expect(rec.placed).to.deep.equal([{ dealId: MERGED, qty: [6.5] }])
    })

    it('the re-send does nothing once the take profit is there', async () => {
      const { b, rec } = dcaBot([tp(MERGED, 'M1', '11.826')], [MERGED])
      await b.rearmMissingTp(MERGED)
      expect(rec.placed).to.deep.equal([])
    })
  })

  describe('a merged-away source deal', () => {
    const source: DealOutcome = {
      _id: SOL_A,
      status: DCADealStatusEnum.canceled,
      size: 5.779,
      profit: { totalUsd: 0 },
      symbol: { symbol: 'SOL-USDC', baseAsset: 'SOL' },
      child: true,
      parentId: MERGED,
    }
    it('names the deal it moved into, not an abandoned position', () => {
      const text = dealCloseEventDescription(source)
      expect(text).to.contain(`into deal ${MERGED}`)
      expect(text).to.not.contain('no take profit')
      expect(text).to.not.contain('left open')
    })
    it('a plain cancel still warns', () => {
      const text = dealCloseEventDescription({
        ...source,
        child: undefined,
        parentId: undefined,
      })
      expect(text).to.contain('position left open on the exchange')
    })
  })
})
