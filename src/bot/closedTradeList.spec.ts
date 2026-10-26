process.env.NODE_ENV = 'testing'

/**
 * Spec 200 — the Trades page's closed trades as one server-paged list.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  closedTradeSort,
  mergeClosedTradeKeys,
  withStatuses,
  type ClosedTradeKey,
} from './closedTradeList'

const key = (
  kind: ClosedTradeKey['kind'],
  id: string,
  k: number | null,
): ClosedTradeKey => ({ kind, id, k })

describe('closedTradeList (spec 200)', () => {
  it('§1.3 a page holds the rows at its position in the merged order', () => {
    const keys = [
      key('dca', 'a', 100),
      key('dca', 'b', 70),
      key('combo', 'c', 90),
      key('grid', 'd', 80),
      key('terminal', 'e', 60),
    ]
    const ids = (skip: number) =>
      mergeClosedTradeKeys(keys, -1, skip, 2).map((r) => r.id)
    expect(ids(0)).to.deep.equal(['a', 'c'])
    expect(ids(2)).to.deep.equal(['d', 'b'])
    expect(ids(4)).to.deep.equal(['e'])
  })

  it('§1.4 rows without a sort key come last in both directions', () => {
    const keys = [
      key('grid', 'x', null),
      key('dca', 'a', 2),
      key('dca', 'b', 1),
    ]
    expect(mergeClosedTradeKeys(keys, -1, 0, 3).map((r) => r.id)).to.deep.equal(
      ['a', 'b', 'x'],
    )
    expect(mergeClosedTradeKeys(keys, 1, 0, 3).map((r) => r.id)).to.deep.equal([
      'b',
      'a',
      'x',
    ])
  })

  it('§1.4 equal keys break by id, so pages never repeat or drop a row', () => {
    const keys = ['d', 'b', 'a', 'c'].map((id) => key('dca', id, 5))
    const seen = [0, 2].flatMap((skip) =>
      mergeClosedTradeKeys(keys, -1, skip, 2).map((r) => r.id),
    )
    expect(seen).to.deep.equal(['d', 'c', 'b', 'a'])
  })

  it('§1.4 sorts by close or open time; anything else falls back to close time desc', () => {
    expect(closedTradeSort(undefined)).to.deep.equal({
      field: 'closeTime',
      dir: -1,
    })
    expect(closedTradeSort({ createTime: 1 })).to.deep.equal({
      field: 'createTime',
      dir: 1,
    })
    expect(closedTradeSort({ 'profit.total': 1 })).to.deep.equal({
      field: 'closeTime',
      dir: -1,
    })
  })

  it('§1.2 the closed statuses replace any status item the caller sent', () => {
    const input = withStatuses(
      {
        page: 1,
        filterModel: {
          items: [
            { field: 'status', operator: 'isAnyOf', value: 'open' },
            { field: 'pair', operator: 'contains', value: 'BTC' },
          ],
        },
      },
      ['closed', 'canceled'],
    )
    expect(input.page).to.equal(1)
    expect(input.filterModel?.items).to.deep.equal([
      { field: 'pair', operator: 'contains', value: 'BTC' },
      { field: 'status', operator: 'isAnyOf', value: 'closed,canceled' },
    ])
  })
})
