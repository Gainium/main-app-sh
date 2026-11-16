process.env.NODE_ENV = 'testing'

/**
 * Spec 244 — several indicator conditions per DCA level. The backtester runs
 * the same vectors against its copy (test/dca-indicator-levels.spec.ts);
 * keep the two tables identical.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { IndicatorAction, IndicatorsLogicEnum } from '../../../types'
import {
  dcaLevelTriggered,
  startDcaLevelAnchors,
  startDcaLevelGroups,
  startDcaLevels,
} from './indicatorLevels'

const { and, or } = IndicatorsLogicEnum
const dca = (uuid: string, groupId: string, dcaLevel?: string) => ({
  uuid,
  groupId,
  indicatorAction: IndicatorAction.startDca,
  ...(dcaLevel ? { dcaLevel } : {}),
})
const group = (
  id: string,
  dcaLevel: string | undefined,
  logic = and,
  join?: IndicatorsLogicEnum,
) => ({
  id,
  logic,
  action: IndicatorAction.startDca,
  ...(dcaLevel ? { dcaLevel } : {}),
  ...(join ? { join } : {}),
})
const active =
  (...uuids: string[]) =>
  (uuid: string) =>
    uuids.includes(uuid)

describe('spec 244 — DCA indicator levels', () => {
  it('§1.3 legacy: one level per startDca indicator, keyed by uuid', () => {
    const levels = startDcaLevels([
      dca('a', 'g'),
      { uuid: 'x', groupId: 'h', indicatorAction: IndicatorAction.startDeal },
      dca('b', 'g'),
    ])
    expect(levels.map((l) => l.key)).to.deep.equal(['a', 'b'])
    expect(levels.map((l) => l.anchor.uuid)).to.deep.equal(['a', 'b'])
  })

  it('§1.2 levels group by dcaLevel, ordered by first appearance', () => {
    const levels = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('L2', 'g3', 'L2'),
      dca('c', 'g2', 'L1'),
      dca('d', 'g3', 'L2'),
    ])
    expect(levels.map((l) => l.key)).to.deep.equal(['L1', 'L2'])
    expect(levels[0].indicators.map((i) => i.uuid)).to.deep.equal(['L1', 'c'])
  })

  it('§1.1 anchor is the indicator whose uuid is the key, else the first', () => {
    expect(
      startDcaLevelAnchors([dca('c', 'g', 'L1'), dca('L1', 'g', 'L1')]).map(
        (i) => i.uuid,
      ),
    ).to.deep.equal(['L1'])
    expect(
      startDcaLevelAnchors([dca('c', 'g', 'L1'), dca('d', 'g', 'L1')]).map(
        (i) => i.uuid,
      ),
    ).to.deep.equal(['c'])
  })

  it('§1.4 only startDca groups of the level are its conditions', () => {
    const groups = [
      group('g1', 'L1'),
      group('g2', 'L2'),
      group('legacy', undefined),
      {
        id: 's',
        logic: and,
        action: IndicatorAction.startDeal,
        dcaLevel: 'L1',
      },
    ]
    expect(startDcaLevelGroups(groups, 'L1').map((g) => g.id)).to.deep.equal([
      'g1',
    ])
  })

  it('§1.5 a level without groups fires when its indicator does', () => {
    const [level] = startDcaLevels([dca('a', 'shared')])
    expect(dcaLevelTriggered(level, [], active('a'))).to.equal(true)
    expect(dcaLevelTriggered(level, [], active())).to.equal(false)
  })

  describe('§1.4 group logic: RSI or (MFI and CCI)', () => {
    const [level] = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('mfi', 'g2', 'L1'),
      dca('cci', 'g2', 'L1'),
    ])
    const groups = [group('g1', 'L1'), group('g2', 'L1', and, or)]
    const cases: [string[], boolean][] = [
      [['L1'], true],
      [['mfi'], false],
      [['mfi', 'cci'], true],
      [[], false],
    ]
    for (const [on, expected] of cases) {
      it(`active ${JSON.stringify(on)} → ${expected}`, () => {
        expect(dcaLevelTriggered(level, groups, active(...on))).to.equal(
          expected,
        )
      })
    }
  })

  it('§1.4 a group without join joins with AND', () => {
    const [level] = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('b', 'g2', 'L1'),
    ])
    const groups = [group('g1', 'L1'), group('g2', 'L1')]
    expect(dcaLevelTriggered(level, groups, active('L1'))).to.equal(false)
    expect(dcaLevelTriggered(level, groups, active('L1', 'b'))).to.equal(true)
  })

  it('§1.4 an OR group passes on any leg', () => {
    const [level] = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('b', 'g1', 'L1'),
    ])
    const groups = [group('g1', 'L1', or)]
    expect(dcaLevelTriggered(level, groups, active('b'))).to.equal(true)
  })

  it('§1.6 an AND group with an unloaded leg cannot pass', () => {
    const [level] = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('b', 'g1', 'L1'),
    ])
    const groups = [group('g1', 'L1')]
    expect(
      dcaLevelTriggered(level, groups, active('L1', 'b'), (u) => u !== 'b'),
    ).to.equal(false)
  })

  it('§1.4 groups of other levels never count', () => {
    const levels = startDcaLevels([
      dca('L1', 'g1', 'L1'),
      dca('L2', 'g2', 'L2'),
    ])
    const groups = [group('g1', 'L1'), group('g2', 'L2', and, or)]
    expect(
      dcaLevelTriggered(
        levels[0],
        startDcaLevelGroups(groups, 'L1'),
        active('L2'),
      ),
    ).to.equal(false)
  })
})
