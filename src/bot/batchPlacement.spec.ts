process.env.NODE_ENV = 'testing'

/**
 * Which orders of a burst may share one venue call.
 *
 * Spec: `specs/082.kraken-spot-bulk-cancel-and-bulk-place.md` §7.2.
 * Run: `npm test` (mocha).
 *
 * This is the decision that makes concurrency safe in the two burst loops, so
 * it is made once, serially, before anything is sent — and it is the only part
 * of the placement path that has to be got right for "never place an order
 * twice" to survive the change. The dangerous case is the last test: two
 * orders of the same shape, which the loops' own duplicate checks collapse
 * when they run one after another and would NOT collapse if they ran together.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, OrderSideEnum, TypeOrderEnum } from '../../types'
import type { Grid } from '../../types'

const grid = (over: Partial<Grid> = {}): Grid =>
  ({
    number: 1,
    price: 100,
    qty: 1,
    side: OrderSideEnum.buy,
    type: TypeOrderEnum.dealRegular,
    newClientOrderId: 'D-RO-SYNTHETIC1',
    ...over,
  }) as Grid

function bot(exchange = ExchangeEnum.kraken, armed = true) {
  const b: any = Object.create((MainBot as any).prototype)
  b.data = { exchange }
  b.exchange = {}
  b.handleDebug = () => undefined
  // The flag only; see `cancelBatch.spec.ts` for why it is not set through the
  // environment. The venue half of the gate is the real one.
  b.isBatchPlaceArmed = () => armed
  return b
}

const levels = (count: number) =>
  [...Array(count).keys()].map((i) =>
    grid({ price: 100 + i, newClientOrderId: `D-RO-SYNTHETIC${i}` }),
  )

const ids = (picked: Grid[]) => picked.map((g) => g.newClientOrderId)

describe('batchablePlacements (spec 082 §7.2)', () => {
  it('takes the burst when the bot is armed on Kraken spot', () => {
    expect(ids(bot().batchablePlacements(levels(3)))).to.deep.equal([
      'D-RO-SYNTHETIC0',
      'D-RO-SYNTHETIC1',
      'D-RO-SYNTHETIC2',
    ])
  })

  it('takes nothing when the flag does not name the bot', () => {
    expect(
      bot(ExchangeEnum.kraken, false).batchablePlacements(levels(3)),
    ).to.deep.equal([])
  })

  it('takes nothing on any venue but Kraken spot', () => {
    for (const exchange of [
      ExchangeEnum.binance,
      ExchangeEnum.coinbase,
      ExchangeEnum.krakenUsdm,
      ExchangeEnum.paperKraken,
    ]) {
      expect(
        bot(exchange).batchablePlacements(levels(3)),
        exchange,
      ).to.deep.equal([])
    }
  })

  it('takes nothing when fewer than two orders survive — one order is not a batch', () => {
    expect(bot().batchablePlacements(levels(1))).to.deep.equal([])
    expect(
      bot().batchablePlacements(levels(3), (g: Grid) => g.price === 100),
    ).to.deep.equal([])
  })

  it('applies the caller’s own skip checks, all of them', () => {
    const picked = bot().batchablePlacements(
      levels(4),
      (g: Grid) => g.price !== 101,
      (g: Grid) => g.price !== 103,
    )
    expect(ids(picked)).to.deep.equal(['D-RO-SYNTHETIC0', 'D-RO-SYNTHETIC2'])
  })

  it('leaves market orders alone — the batch route places limit orders', () => {
    const orders = [
      ...levels(2),
      grid({ market: true, newClientOrderId: 'M1' }),
    ]
    expect(ids(bot().batchablePlacements(orders))).to.deep.equal([
      'D-RO-SYNTHETIC0',
      'D-RO-SYNTHETIC1',
    ])
  })

  it('batches minigrid orders, across minigrids — a combo counter-order burst is nothing else', () => {
    // Each body's removal from the shared `pendingOrdersList` is one
    // synchronous statement ahead of its first await, so concurrent bodies
    // cannot lose one. Refusing these left every combo burst per-order.
    const minigridLevel = (price: number, minigridId: string, id: string) =>
      grid({
        price,
        side: OrderSideEnum.sell,
        type: TypeOrderEnum.dealGrid,
        minigridId,
        newClientOrderId: id,
      })
    const orders = [
      minigridLevel(101, 'mg1', 'CMB-RO-1'),
      minigridLevel(102, 'mg1', 'CMB-RO-2'),
      minigridLevel(103, 'mg2', 'CMB-RO-3'),
    ]
    expect(ids(bot().batchablePlacements(orders))).to.deep.equal([
      'CMB-RO-1',
      'CMB-RO-2',
      'CMB-RO-3',
    ])
  })

  it('still sends the second of two same-shape minigrid levels on its own', () => {
    // Two minigrids of one deal can hold a level of identical shape. Run
    // sequentially, `isOrderExistInDeal` sees the first one's row and skips
    // the second; the shape guard keeps that decision where it was.
    const a = grid({
      type: TypeOrderEnum.dealGrid,
      minigridId: 'mg1',
      newClientOrderId: 'CMB-RO-A',
    })
    const b = grid({
      type: TypeOrderEnum.dealGrid,
      minigridId: 'mg2',
      newClientOrderId: 'CMB-RO-B',
    })
    const c = grid({
      price: 99,
      type: TypeOrderEnum.dealGrid,
      minigridId: 'mg2',
      newClientOrderId: 'CMB-RO-C',
    })
    expect(ids(bot().batchablePlacements([a, b, c]))).to.deep.equal([
      'CMB-RO-A',
      'CMB-RO-C',
    ])
  })

  it('never batches two orders of the same shape together', () => {
    // Sequentially, the second of these is skipped by `isOrderExist` /
    // `isOrderExistInDeal`, which match on (price, side, qty, type) and see
    // the first one's row. Concurrently neither would see the other, and both
    // would be placed — one live order too many. So the twin takes the
    // sequential path, where it meets that check exactly as it does today.
    const twin = grid({ price: 100, newClientOrderId: 'D-RO-TWIN' })
    const picked = bot().batchablePlacements([...levels(3), twin])
    expect(ids(picked)).to.deep.equal([
      'D-RO-SYNTHETIC0',
      'D-RO-SYNTHETIC1',
      'D-RO-SYNTHETIC2',
    ])
  })

  it('does batch two orders that differ in size at the same price', () => {
    const bigger = grid({
      price: 100,
      qty: 2,
      newClientOrderId: 'D-RO-BIGGER',
    })
    expect(
      ids(bot().batchablePlacements([...levels(1), bigger])),
    ).to.deep.equal(['D-RO-SYNTHETIC0', 'D-RO-BIGGER'])
  })
})
