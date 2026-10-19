process.env.NODE_ENV = 'testing'

/**
 * Combo add / reduce funds — the arithmetic (`comboDealFunds.ts`).
 *
 * Fixture used throughout: a long spot Combo deal started at 100 with a
 * 100 USDT base order and three DCA levels of 100 / 200 / 400 USDT at
 * 98 / 96 / 94 (step 2 %, step scale 1, volume scale 2).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { AddFundsTypeEnum, OrderSizeTypeEnum } from '../../../types'
import {
  comboFillScale,
  comboFundsMinimumRefusalMessage,
  comboFundsMinimumVerdict,
  comboFundsScale,
  comboMinimumScale,
  comboContractSize,
  comboPositionBase,
  heldOffsetTotals,
  minigridMissingScale,
  scaledDcaOffsets,
  splitScaledOffsets,
} from './comboDealFunds'

const round4 = (n: number) => Math.round(n * 1e4) / 1e4

const BO = { qty: 1, price: 100 }
const SO1 = { qty: round4(100 / 98), price: 98 }
const SO2 = { qty: round4(200 / 96), price: 96 }
const SO3 = { qty: round4(400 / 94), price: 94 }
const ALL_FILLED = BO.qty + SO1.qty + SO2.qty + SO3.qty

describe('combo add / reduce funds: arithmetic', () => {
  it('position base: what a long holds, what a short has sold', () => {
    expect(
      comboPositionBase({
        isLong: true,
        initialBalances: { base: 0, quote: 800 },
        currentBalances: { base: 8.359, quote: 0 },
      }),
    ).to.equal(8.359)
    expect(
      comboPositionBase({
        isLong: false,
        initialBalances: { base: 10, quote: 0 },
        currentBalances: { base: 6, quote: 400 },
      }),
    ).to.equal(4)
  })

  it('all levels filled, +50 % at 90: buys 4.1795 base (≈376.16 USDT)', () => {
    const scale = comboFundsScale({
      direction: 'add',
      type: AddFundsTypeEnum.perc,
      asset: OrderSizeTypeEnum.quote,
      qty: 50,
      price: 90,
      positionBase: ALL_FILLED,
      unfilled: [],
    })
    expect(scale).to.deep.equal({ kind: 'scale', k: 1.5 })
    const k = (scale as { k: number }).k
    const buy = round4((k - 1) * ALL_FILLED)
    expect(buy).to.equal(4.1795)
    expect(buy * 90).to.be.closeTo(376.16, 0.01)
    // Average over the deal's buys: 95.70 → 93.80.
    const quote = 100 + SO1.qty * 98 + SO2.qty * 96 + SO3.qty * 94
    expect(+(quote / ALL_FILLED).toFixed(2)).to.equal(95.7)
    expect(+((quote + buy * 90) / (ALL_FILLED + buy)).toFixed(2)).to.equal(93.8)
  })

  it('a fixed quote amount is the TOTAL commitment across position and unfilled levels', () => {
    // BO + SO1 filled at 97: position 2.0204 base; SO2 + SO3 unfilled.
    const position = BO.qty + SO1.qty
    const unfilled = [SO2, SO3]
    const total = position * 97 + SO2.qty * 96 + SO3.qty * 94
    const scale = comboFundsScale({
      direction: 'add',
      asset: OrderSizeTypeEnum.quote,
      qty: total / 2,
      price: 97,
      positionBase: position,
      unfilled,
    })
    expect(scale.kind).to.equal('scale')
    expect((scale as { k: number }).k).to.be.closeTo(1.5, 1e-12)
  })

  it('a fixed base amount is the total base across position and unfilled levels', () => {
    const scale = comboFundsScale({
      direction: 'reduce',
      asset: OrderSizeTypeEnum.base,
      qty: ALL_FILLED / 4,
      price: 90,
      positionBase: ALL_FILLED,
      unfilled: [],
    })
    expect((scale as { k: number }).k).to.be.closeTo(0.75, 1e-12)
  })

  it('reduce 25 % at 90 sells 2.0898 base', () => {
    const scale = comboFundsScale({
      direction: 'reduce',
      type: AddFundsTypeEnum.perc,
      asset: OrderSizeTypeEnum.quote,
      qty: 25,
      price: 90,
      positionBase: ALL_FILLED,
      unfilled: [],
    })
    expect(scale).to.deep.equal({ kind: 'scale', k: 0.75 })
    expect(round4(0.25 * ALL_FILLED)).to.equal(2.0898)
  })

  it('a reduce that takes everything closes the deal', () => {
    for (const qty of [100, 150]) {
      expect(
        comboFundsScale({
          direction: 'reduce',
          type: AddFundsTypeEnum.perc,
          asset: OrderSizeTypeEnum.quote,
          qty,
          price: 90,
          positionBase: ALL_FILLED,
          unfilled: [],
        }),
      ).to.deep.equal({ kind: 'close' })
    }
    expect(
      comboFundsScale({
        direction: 'reduce',
        asset: OrderSizeTypeEnum.quote,
        qty: 10_000,
        price: 90,
        positionBase: ALL_FILLED,
        unfilled: [],
      }),
    ).to.deep.equal({ kind: 'close' })
  })

  it('refuses nonsense', () => {
    for (const qty of [0, -5, NaN]) {
      expect(
        comboFundsScale({
          direction: 'add',
          type: AddFundsTypeEnum.perc,
          asset: OrderSizeTypeEnum.quote,
          qty,
          price: 90,
          positionBase: ALL_FILLED,
          unfilled: [],
        }).kind,
      ).to.equal('invalid')
    }
    expect(
      comboFundsScale({
        direction: 'add',
        type: AddFundsTypeEnum.perc,
        asset: OrderSizeTypeEnum.quote,
        qty: 10,
        price: 90,
        positionBase: 0,
        unfilled: [],
      }).kind,
    ).to.equal('invalid')
  })

  it('the fill scales by what executed', () => {
    expect(comboFillScale('add', 4.1795, ALL_FILLED)).to.be.closeTo(1.5, 1e-4)
    expect(comboFillScale('reduce', 2.0898, ALL_FILLED)).to.be.closeTo(
      0.75,
      1e-4,
    )
    expect(comboFillScale('add', 0, ALL_FILLED)).to.equal(1)
  })

  it('a reduce below the exchange minimum is refused with the largest % that passes', () => {
    // Grid lines of 0.25 base at 100; minimum notional 20 USDT → k ≥ 0.8.
    const lines = [
      { qty: 0.25, price: 100 },
      { qty: 0.5, price: 96 },
    ]
    expect(
      comboMinimumScale({ lines, minBase: 0, minQuote: 20 }),
    ).to.be.closeTo(0.8, 1e-12)
    expect(
      comboFundsMinimumVerdict({ k: 0.85, lines, minBase: 0, minQuote: 20 }),
    ).to.deep.equal({ refuse: false })
    const v = comboFundsMinimumVerdict({
      k: 0.5,
      lines,
      minBase: 0,
      minQuote: 20,
    })
    expect(v).to.deep.equal({ refuse: true, maxReducePerc: 20 })
    expect(comboFundsMinimumRefusalMessage(50, 20)).to.contain(
      'The largest reduction possible now is 20%',
    )
    // An add never makes a line smaller.
    expect(
      comboFundsMinimumVerdict({ k: 1.5, lines, minBase: 1, minQuote: 1e6 }),
    ).to.deep.equal({ refuse: false })
  })

  it('unfilled levels: the offset grows by (k − 1) × the level qty', () => {
    // Partial case: SO2 and SO3 unfilled, +50 %.
    const out = scaledDcaOffsets(
      undefined,
      [
        { number: 2, qty: SO2.qty },
        { number: 3, qty: SO3.qty },
      ],
      1.5,
    )
    expect(out[0]).to.equal(0)
    expect(round4(SO2.qty + out[1])).to.equal(3.125)
    expect(round4(SO3.qty + out[2])).to.equal(6.383)
    // Existing offsets are kept and added to.
    expect(scaledDcaOffsets([0.5], [{ number: 1, qty: 1 }], 0.5)).to.deep.equal(
      [0],
    )
  })

  it('filled levels get a held offset, unfilled ones a counted one', () => {
    // BO + SO1 filled, +50 %.
    const out = splitScaledOffsets(
      {},
      [
        { number: 1, qty: SO1.qty, filled: true },
        { number: 2, qty: SO2.qty, filled: false },
        { number: 3, qty: SO3.qty, filled: false },
      ],
      1.5,
    )
    expect(out.fundsDcaHeld[0]).to.be.closeTo(SO1.qty / 2, 1e-12)
    expect(out.fundsDca[0]).to.equal(0)
    expect(out.fundsDca[1]).to.be.closeTo(SO2.qty / 2, 1e-12)
    // Only the held part is left out of the commitment.
    const held = heldOffsetTotals(
      [
        { number: 1, price: 98 },
        { number: 2, price: 96 },
      ],
      out.fundsDcaHeld,
    )
    expect(held.base).to.be.closeTo(SO1.qty / 2, 1e-12)
    expect(held.quote).to.be.closeTo((SO1.qty / 2) * 98, 1e-9)
    expect(
      heldOffsetTotals([{ number: 1, price: 98 }], undefined),
    ).to.deep.equal({ base: 0, quote: 0 })
  })

  it('coin-M: whole contracts, a reduce rounds down, under one is zero', () => {
    // 100 USD contracts at 50,000: 0.0025 BTC is 1.25 contracts.
    const add = comboContractSize({
      qty: 0.0025,
      price: 50_000,
      contractValue: 100,
      direction: 'add',
    })
    expect(add.contracts).to.equal(1)
    expect(add.qty).to.be.closeTo(0.002, 1e-12)
    const reduce = comboContractSize({
      qty: 0.0059,
      price: 50_000,
      contractValue: 100,
      direction: 'reduce',
    })
    expect(reduce.contracts).to.equal(2)
    expect(reduce.qty).to.be.closeTo(0.004, 1e-12)
    expect(
      comboContractSize({
        qty: 0.0015,
        price: 50_000,
        contractValue: 100,
        direction: 'reduce',
      }).contracts,
    ).to.equal(0)
  })

  it('a minigrid is missing only the changes booked after it opened that it has not applied', () => {
    const scales = [
      { id: 'a', k: 1.5, time: 100 },
      { id: 'b', k: 0.8, time: 200 },
    ]
    expect(minigridMissingScale(scales, { createTime: 50 })).to.deep.equal({
      k: 1.5 * 0.8,
      ids: ['a', 'b'],
    })
    expect(
      minigridMissingScale(scales, {
        createTime: 50,
        appliedFundsScale: ['a'],
      }),
    ).to.deep.equal({ k: 0.8, ids: ['b'] })
    // Opened after `a`: sized from the scaled level already.
    expect(minigridMissingScale(scales, { createTime: 150 })).to.deep.equal({
      k: 0.8,
      ids: ['b'],
    })
    expect(
      minigridMissingScale(undefined, { createTime: 0 }).ids,
    ).to.deep.equal([])
  })
})
