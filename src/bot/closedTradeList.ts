/**
 * The closed-trades list of the Trades page: closed DCA, terminal and combo
 * deals plus stopped grid bots, paged on the server as ONE list.
 *
 * Each source answers its first `skip + limit` sort keys and its count in one
 * `$facet`; the keys are merged here and only the page's documents are then
 * read in full. A grid bot is not a deal, so it is given the deal fields the
 * shared filter builder reads (`createTime`, `closeTime`, `botId`, `usage`)
 * before the filter runs — every column filter then means the same thing for
 * every row.
 */
import type { PipelineStage } from 'mongoose'
import type { DataGridFilterInput } from '../../types'

export type ClosedTradeKind = 'dca' | 'terminal' | 'combo' | 'grid'

export type ClosedTradeKey = {
  kind: ClosedTradeKind
  id: string
  k: number | null
}

export const CLOSED_DEAL_STATUSES = ['closed', 'canceled']
/** A stopped or errored grid bot (the open list shows the running ones). */
export const CLOSED_GRID_STATUSES = ['closed', 'error']

const SORT_FIELDS = new Set(['closeTime', 'createTime'])

/** The page's sort: close or open time only, newest closed first by default. */
export const closedTradeSort = (
  sort: Record<string, number> | undefined,
): { field: string; dir: 1 | -1 } => {
  const entry = Object.entries(sort ?? {}).find(([f]) => SORT_FIELDS.has(f))
  return entry
    ? { field: entry[0], dir: entry[1] === 1 ? 1 : -1 }
    : { field: 'closeTime', dir: -1 }
}

/** The DataGrid input with its status items replaced by `statuses`. */
export const withStatuses = (
  input: DataGridFilterInput | undefined,
  statuses: string[],
): DataGridFilterInput => {
  const items = (input?.filterModel?.items ?? []).filter(
    (i) =>
      (i?.field ?? (i as { columnField?: string })?.columnField) !== 'status',
  )
  return {
    ...(input ?? {}),
    filterModel: {
      ...(input?.filterModel ?? {}),
      items: [
        ...items,
        { field: 'status', operator: 'isAnyOf', value: statuses.join(',') },
      ],
    },
  }
}

/** Deal fields a grid bot lacks, derived so the deal filters apply to it. */
export const GRID_AS_DEAL_STAGE: PipelineStage = {
  $addFields: {
    botId: { $toString: '$_id' },
    createTime: { $toLong: '$created' },
    closeTime: {
      $ifNull: [{ $max: '$workingShift.end' }, { $toLong: '$updated' }],
    },
    usage: {
      current: { base: '$assets.used.base', quote: '$assets.used.quote' },
    },
  },
}

/** One source's first `n` sort keys and its total, in one round trip. */
export const keysFacet = (
  match: PipelineStage[],
  field: string,
  dir: 1 | -1,
  n: number,
): PipelineStage[] => [
  ...match,
  {
    $facet: {
      rows: [
        { $project: { k: `$${field}` } },
        { $sort: { k: dir, _id: dir } },
        { $limit: Math.max(1, n) },
      ],
      total: [{ $count: 'n' }],
    },
  },
]

/**
 * The page of the merged list. Rows without a sort key go last in either
 * direction; ties break by id so a page boundary never repeats or drops a row.
 */
export const mergeClosedTradeKeys = (
  keys: ClosedTradeKey[],
  dir: 1 | -1,
  skip: number,
  limit: number,
): ClosedTradeKey[] =>
  keys
    .slice()
    .sort((a, b) => {
      if (a.k === null || b.k === null) {
        if (a.k === b.k) return a.id < b.id ? -dir : a.id > b.id ? dir : 0
        return a.k === null ? 1 : -1
      }
      if (a.k !== b.k) return (a.k - b.k) * dir
      return a.id < b.id ? -dir : a.id > b.id ? dir : 0
    })
    .slice(skip, skip + limit)

/** A grid bot as the bot lists serve it: with its total running time. */
export const withWorkingTimeTotal = <
  B extends { workingShift?: { start: number; end?: number }[] },
>(
  bot: B,
): B & { workingTimeTotal: number } => ({
  ...bot,
  workingTimeTotal: (bot.workingShift ?? []).reduce(
    (acc, v) => acc + (v.end ? v.end : new Date().getTime()) - v.start,
    0,
  ),
})
