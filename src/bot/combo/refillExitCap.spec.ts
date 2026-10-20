/**
 * Main-app spec 048 — `capRefillExitLines`, the arithmetic that holds a
 * minigrid's regenerated exit lines to what it holds after a fill.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { capRefillExitLines } from './comboDealFunds'

const S = 'SELL'
const B = 'BUY'
const line = (side: string, price: number, qty: number) => ({
  side,
  price,
  qty,
})

describe('capRefillExitLines (main-app spec 048)', () => {
  it('a refilled buy of 0.027 hands back a sell of 0.027, not its level 0.028', () => {
    const r = capRefillExitLines({
      prev: [line(B, 99, 0.027), line(S, 101, 0.028), line(S, 102, 0.027)],
      next: [line(S, 100, 0.028), line(S, 101, 0.028), line(S, 102, 0.027)],
      exit: S,
      filled: line(B, 99, 0.027),
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([0.027, 0.028, 0.027])
    expect(r.cap).to.equal(0.082)
  })

  it('leaves a ladder within the holding as it is', () => {
    const r = capRefillExitLines({
      prev: [line(B, 99, 0.028), line(S, 101, 0.027)],
      next: [line(S, 100, 0.027), line(S, 101, 0.027)],
      exit: S,
      filled: line(B, 99, 0.028),
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([0.027, 0.027])
    expect(r.excess).to.equal(0)
  })

  it('an exit fill takes its executed quantity off the holding', () => {
    const r = capRefillExitLines({
      prev: [line(S, 100, 0.3), line(S, 101, 0.3)],
      next: [line(B, 99, 0.3), line(S, 101, 0.31)],
      exit: S,
      filled: line(S, 100, 0.3),
      step: 0.01,
    })
    expect(r.qty).to.deep.equal([0.3])
  })

  it('a catch-up rebuild counts every entry line it dropped as filled', () => {
    // Price fell through three buys; only the lowest is reported, the
    // rebuild counts the two above it as filled too.
    const r = capRefillExitLines({
      prev: [line(B, 97, 1), line(B, 98, 1), line(B, 99, 1), line(S, 101, 1)],
      next: [line(S, 98, 1), line(S, 99, 1), line(S, 100, 1), line(S, 101, 1)],
      exit: S,
      filled: line(B, 97, 1),
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([1, 1, 1, 1])
  })

  it('the deal position caps the minigrid together with the others', () => {
    const r = capRefillExitLines({
      prev: [line(B, 99, 0.028), line(S, 101, 0.028)],
      next: [line(S, 100, 0.028), line(S, 101, 0.028)],
      exit: S,
      filled: line(B, 99, 0.028),
      others: 0.2,
      position: 0.254,
      step: 0.001,
    })
    // Room 0.054: the new line gives the two lots, the resting one is kept.
    expect(r.qty).to.deep.equal([0.026, 0.028])
  })

  it('trims a resting line only when the new ones cannot give enough', () => {
    const r = capRefillExitLines({
      prev: [line(B, 99, 0.002), line(S, 101, 0.05)],
      next: [line(S, 100, 0.002), line(S, 101, 0.05)],
      exit: S,
      filled: line(B, 99, 0.002),
      floors: [0.002, 0.001],
      position: 0.049,
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([0.002, 0.047])
  })

  it('never trims a line below its venue minimum, and reports what is left over', () => {
    const r = capRefillExitLines({
      prev: [line(B, 99, 0.005)],
      next: [line(S, 100, 0.006), line(S, 101, 0.006)],
      exit: S,
      filled: line(B, 99, 0.005),
      floors: [0.005, 0.005],
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([0.005, 0.005])
    expect(r.excess).to.equal(0.005)
  })

  it('a short: the buy-backs a refilled sell hands back', () => {
    const r = capRefillExitLines({
      prev: [line(S, 101, 0.027), line(B, 99, 0.028)],
      next: [line(B, 100, 0.028), line(B, 99, 0.028)],
      exit: B,
      filled: line(S, 101, 0.027),
      step: 0.001,
    })
    expect(r.qty).to.deep.equal([0.027, 0.028])
  })

  it('a new minigrid rests no more than its level filled', () => {
    const r = capRefillExitLines({
      prev: [],
      next: [
        line(B, 1, 431),
        line(B, 2, 432),
        line(B, 3, 431),
        line(B, 4, 432),
      ],
      exit: B,
      filled: line(S, 5, 1720),
      step: 1,
    })
    expect(r.qty.reduce((a, q) => a + q, 0)).to.equal(1720)
  })

  it('lot counts in the tens of millions keep their last lot', () => {
    const r = capRefillExitLines({
      prev: [line(S, 0.08252, 506.53547), line(S, 0.08273, 506.53547)],
      next: [line(S, 0.08273, 506.53547)],
      exit: S,
      filled: line(S, 0.08252, 506.53547),
      position: 506.53547,
      step: 0.00001,
    })
    expect(r.qty).to.deep.equal([506.53547])
  })

  it('without a usable step the lines pass through', () => {
    const next = [line(S, 100, 0.03)]
    const r = capRefillExitLines({
      prev: [],
      next,
      exit: S,
      filled: line(B, 99, 0.01),
      step: 0,
    })
    expect(r.qty).to.deep.equal([0.03])
  })
})
