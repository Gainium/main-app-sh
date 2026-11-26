/**
 * Spec `279` — the pure rules of booking a venue's partial liquidation.
 * Run: `npm test` (mocha). Identifiers are synthetic (this file is public).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  bookedLiquidationChunkIds,
  liquidationChunksFromFills,
  partialLiquidationRowId,
  planPartialLiquidation,
} from './partialLiquidation'

const SYMBOL = 'ONDO-USD'

const fill = (over: Record<string, unknown>) =>
  ({
    fillId: `f-${Math.random()}`,
    orderId: 'o-1',
    clientOrderId: '',
    symbol: SYMBOL,
    side: 'SELL',
    price: '0.33',
    quantity: '12',
    timestamp: 2_000,
    fillType: 'partialLiquidation',
    ...over,
  }) as any

describe('partial liquidation rules (spec 279)', () => {
  it('§2.1 groups forced-close fills by venue order, volume-weighted, oldest first', () => {
    const chunks = liquidationChunksFromFills(
      [
        fill({ orderId: 'b', quantity: '5', price: '0.3251', timestamp: 3_000 }),
        fill({ orderId: 'b', quantity: '7', price: '0.3254', timestamp: 3_000 }),
        fill({ orderId: 'a', quantity: '12', price: '0.3262', timestamp: 2_000 }),
        // not a liquidation: our own grid sell
        fill({ orderId: 'c', clientOrderId: 'CMB-GR-x', fillType: 'maker' }),
        // wrong side, wrong symbol, before the deal opened
        fill({ orderId: 'd', side: 'BUY' }),
        fill({ orderId: 'e', symbol: 'BTC-USD' }),
        fill({ orderId: 'f', timestamp: 500 }),
      ],
      { symbol: SYMBOL, closeSide: 'SELL', sinceMs: 1_000 },
    )
    expect(chunks.map((c) => c.orderId)).to.deep.equal(['a', 'b'])
    expect(chunks[1].qty).to.equal(12)
    expect(chunks[1].price).to.be.closeTo((5 * 0.3251 + 7 * 0.3254) / 12, 1e-12)
  })

  it('§2.2 books the chunks, newest deal first, and never takes the books below the venue', () => {
    const plan = planPartialLiquidation({
      chunks: [
        { orderId: 'a', qty: 60, price: 0.33, time: 5_000 },
        { orderId: 'b', qty: 60, price: 0.32, time: 5_100 },
      ],
      deals: [
        { dealId: 'old', createTime: 1_000, position: 200 },
        { dealId: 'new', createTime: 2_000, position: 100 },
      ],
      held: 180,
      step: 1,
    })
    expect(plan.kind).to.equal('book')
    if (plan.kind !== 'book') return
    expect(plan.qty).to.equal(120)
    expect(plan.price).to.be.closeTo(0.325, 1e-12)
    expect(plan.allocations).to.deep.equal([
      { dealId: 'new', qty: 100, closes: true },
      { dealId: 'old', qty: 20, closes: false },
    ])
  })

  it('§2.3 capped at books − held: drift from elsewhere is not booked as a liquidation', () => {
    const plan = planPartialLiquidation({
      chunks: [{ orderId: 'a', qty: 120, price: 0.33, time: 5_000 }],
      deals: [{ dealId: 'd', createTime: 1_000, position: 238 }],
      held: 150,
      step: 1,
    })
    expect(plan.kind === 'book' && plan.qty).to.equal(88)
  })

  it('§2.4 nothing is booked when the books already hold no more than the venue (a second bot shares the position, or it was booked)', () => {
    const plan = planPartialLiquidation({
      chunks: [{ orderId: 'a', qty: 50, price: 0.33, time: 5_000 }],
      deals: [{ dealId: 'd', createTime: 1_000, position: 100 }],
      held: 150,
      step: 1,
    })
    expect(plan.kind).to.equal('skip')
  })

  it('§2.5 a deal opened after the last chunk had nothing liquidated', () => {
    const plan = planPartialLiquidation({
      chunks: [{ orderId: 'a', qty: 10, price: 0.33, time: 5_000 }],
      deals: [
        { dealId: 'before', createTime: 1_000, position: 50 },
        { dealId: 'after', createTime: 6_000, position: 50 },
      ],
      held: 40,
      step: 1,
    })
    expect(plan.kind === 'book' && plan.allocations).to.deep.equal([
      { dealId: 'before', qty: 10, closes: false },
    ])
  })

  it('§2.6 row ids are deterministic per deal and chunk set; booked chunks are read back from the rows', () => {
    const a = partialLiquidationRowId('6af49ef29a7c358f667c9030', ['x-2', 'x-1'])
    const b = partialLiquidationRowId('6af49ef29a7c358f667c9030', ['x-1', 'x-2'])
    expect(a).to.equal(b)
    expect(a.startsWith('LIQ-')).to.equal(true)
    expect(
      [
        ...bookedLiquidationChunkIds([
          { clientOrderId: a, orderId: 'x-1,x-2' },
          { clientOrderId: 'CMB-GR-1', orderId: 'x-3' },
        ]),
      ].sort(),
    ).to.deep.equal(['x-1', 'x-2'])
  })
})
