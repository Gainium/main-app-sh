process.env.NODE_ENV = 'testing'

/**
 * Per-group AND/OR joins between indicator groups. The backtester runs the
 * same vectors against its copy (src/dca/strategy/ti/groupLogic.spec.ts);
 * keep the two tables identical.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { IndicatorsLogicEnum } from '../../types'
import {
  combineIndicatorGroups,
  groupStandsAlone,
  groupsJoinedByAnd,
} from './indicatorGroupLogic'

const { and, or } = IndicatorsLogicEnum
const g = (...joins: (IndicatorsLogicEnum | undefined)[]) =>
  joins.map((join, i) => ({ id: `g${i}`, ...(join ? { join } : {}) }))

describe('combineIndicatorGroups', () => {
  it('is false for no groups', () => {
    expect(combineIndicatorGroups([], [], and)).to.equal(false)
  })

  it('without joins behaves like the bot-level every/some', () => {
    expect(combineIndicatorGroups(g(), [true], undefined)).to.equal(true)
    expect(
      combineIndicatorGroups(g(undefined, undefined), [true, false], and),
    ).to.equal(false)
    expect(
      combineIndicatorGroups(g(undefined, undefined), [true, false], undefined),
    ).to.equal(false)
    expect(
      combineIndicatorGroups(g(undefined, undefined), [false, true], or),
    ).to.equal(true)
  })

  it('applies AND before OR: (A and B) or C', () => {
    const groups = g(undefined, and, or)
    expect(combineIndicatorGroups(groups, [true, true, false], and)).to.equal(
      true,
    )
    expect(combineIndicatorGroups(groups, [true, false, false], and)).to.equal(
      false,
    )
    expect(combineIndicatorGroups(groups, [false, false, true], and)).to.equal(
      true,
    )
  })

  it('A or B and C reads as A or (B and C)', () => {
    const groups = g(undefined, or, and)
    expect(combineIndicatorGroups(groups, [true, false, false], and)).to.equal(
      true,
    )
    expect(combineIndicatorGroups(groups, [false, true, false], and)).to.equal(
      false,
    )
    expect(combineIndicatorGroups(groups, [false, true, true], and)).to.equal(
      true,
    )
  })

  it('a group without join falls back to the bot-level logic', () => {
    // A or B, then C with no join and bot logic AND: A or (B and C)
    const groups = g(undefined, or, undefined)
    expect(combineIndicatorGroups(groups, [false, true, false], and)).to.equal(
      false,
    )
    expect(combineIndicatorGroups(groups, [false, true, false], or)).to.equal(
      true,
    )
  })

  it('ignores a join on the first group', () => {
    expect(combineIndicatorGroups(g(or, and), [true, false], and)).to.equal(
      false,
    )
  })
})

describe('groupsJoinedByAnd', () => {
  it('without joins follows the bot-level logic', () => {
    expect(groupsJoinedByAnd(g(undefined, undefined), undefined)).to.equal(true)
    expect(groupsJoinedByAnd(g(undefined, undefined), or)).to.equal(false)
  })
  it('with joins is true when any join is AND', () => {
    expect(groupsJoinedByAnd(g(undefined, or, or), and)).to.equal(false)
    expect(groupsJoinedByAnd(g(undefined, or, and), or)).to.equal(true)
  })
})

describe('groupStandsAlone', () => {
  it('without joins is the bot-level OR', () => {
    expect(groupStandsAlone(g(undefined, undefined), 'g1', or)).to.equal(true)
    expect(groupStandsAlone(g(undefined, undefined), 'g1', and)).to.equal(false)
  })
  it('needs OR on both sides', () => {
    const groups = g(undefined, and, or) // (g0 and g1) or g2
    expect(groupStandsAlone(groups, 'g0', and)).to.equal(false)
    expect(groupStandsAlone(groups, 'g1', and)).to.equal(false)
    expect(groupStandsAlone(groups, 'g2', and)).to.equal(true)
  })
  it('falls back to the bot-level logic for an unknown group', () => {
    expect(groupStandsAlone(g(undefined, or), 'nope', and)).to.equal(false)
  })
})
