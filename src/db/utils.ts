import type { GridSortModel, GridFilterItem } from '../../types'
import logger from '../utils/logger'
import { DEFAULT_DB_LIMIT } from '../../types'

const timeOperatorValues = [
  'is',
  'not',
  'after',
  'onOrAfter',
  'before',
  'onOrBefore',
  'isEmpty',
  'isNotEmpty',
]

const checkNumber = (value: string | number) =>
  !isNaN(+value) || isFinite(+value)

// SECURITY: escape every regex metacharacter before building a RegExp from a
// user-supplied filter value. `encodeURIComponent` above looks like it
// sanitises, but it leaves `.`, `*`, `(` and `)` intact -- so a
// `contains`/`startsWith`/`endsWith` value reaches `new RegExp` as a pattern,
// not a literal. Two consequences: a bare `(` throws a SyntaxError and fails
// the query, and a value like `.*` silently matches everything instead of the
// literal-substring match the operator names imply. Escaping restores those
// semantics and closes the regex injection.
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const mapDataGridOptionsToMongoOptions = (input?: {
  sortModel?: GridSortModel[]
  filterModel?: { items: GridFilterItem[]; linkOperator?: string }
  page?: number
  pageSize?: number
}) => {
  const filterModel = input?.filterModel ?? { items: [] }
  const sortModel = input?.sortModel ?? []
  const page = input?.page ?? 0
  const pageSize = input?.pageSize ?? DEFAULT_DB_LIMIT
  const filter: {
    [x: string]: object
  }[] = []
  if (filterModel?.items) {
    filterModel.items.map((item) => {
      item.value = encodeURIComponent(item.value ?? '')
      if (
        !item.value &&
        item.operator !== 'isEmpty' &&
        item.operator !== 'isNotEmpty'
      ) {
        return
      }
      let filterItem
      if (item.operator === 'contains') {
        filterItem = { $regex: new RegExp(escapeRegExp(item.value), 'i') }
      }
      if (item.operator === 'equals') {
        filterItem = { $eq: item.value }
      }
      if (item.operator === 'startsWith') {
        filterItem = { $regex: new RegExp(`^${escapeRegExp(item.value)}`, 'i') }
      }
      if (item.operator === 'endsWith') {
        filterItem = { $regex: new RegExp(`${escapeRegExp(item.value)}$`, 'i') }
      }
      if (item.operator === 'isEmpty') {
        filterItem = { $eq: '' }
      }
      if (
        item.operator === 'is' &&
        (item.value === 'false' || item.value === 'true' || item.value === '')
      ) {
        if (item.value !== '') {
          filterItem = { $eq: item.value === 'true' }
        }
      }
      if (item.operator === 'isNotEmpty') {
        filterItem = { $ne: '' }
      }
      if (item.operator === 'isAnyOf') {
        filterItem = {
          $in: item.value.split('%2C').map((v) => v.replace('%20', ' ')),
        }
      }
      if (checkNumber(item.value)) {
        if (item.operator === '=') {
          filterItem = { $eq: +item.value }
        }
        if (item.operator === '!=') {
          filterItem = { $ne: +item.value }
        }
        if (item.operator === '>') {
          filterItem = { $gt: +item.value }
        }
        if (item.operator === '>=') {
          filterItem = { $gte: +item.value }
        }
        if (item.operator === '<') {
          filterItem = { $lt: +item.value }
        }
        if (item.operator === '<=') {
          filterItem = { $lte: +item.value }
        }
      }
      if (
        item.operator &&
        timeOperatorValues.includes(item.operator) &&
        !(item.value === 'false' || item.value === 'true' || item.value === '')
      ) {
        try {
          const timestamp = new Date(decodeURIComponent(item.value))
          if (item.operator === 'is') {
            filterItem = { $eq: timestamp }
          }
          if (item.operator === 'not') {
            filterItem = { $ne: timestamp }
          }
          if (item.operator === 'after') {
            filterItem = { $gt: timestamp }
          }
          if (item.operator === 'onOrAfter') {
            filterItem = { $gte: timestamp }
          }
          if (item.operator === 'before') {
            filterItem = { $lt: timestamp }
          }
          if (item.operator === 'onOrBefore') {
            filterItem = { $lte: timestamp }
          }
          if (item.operator === 'isEmpty') {
            filterItem = { $eq: '' }
          }
          if (item.operator === 'isNotEmpty') {
            filterItem = { $ne: '' }
          }
        } catch (e) {
          logger.error(
            `Cannot create time from ${item.value}. Error: ${
              (e as Error).message
            }`,
          )
        }
      }
      if (filterItem) {
        filter.push({ [`${item.field}`]: filterItem })
      }
    })
  }
  let sorter: {
    [x: string]: number
  } = {
    created: -1,
  }
  if (sortModel?.length) {
    const dir = sortModel[0].sort === 'desc' ? 1 : -1
    if (sortModel[0].field !== 'id') {
      sorter = { [`${sortModel[0].field}`]: dir }
    } else {
      sorter = { _id: dir }
    }
  }
  const finalFilter: { $and?: typeof filter; $or?: typeof filter } = {}
  if (filter.length > 0) {
    finalFilter.$and = filter
  }
  if (filterModel?.linkOperator === 'or' && filter.length > 0) {
    delete finalFilter.$and
    finalFilter.$or = filter
  }
  return {
    filter: finalFilter,
    sort: sorter,
    skip: Math.max(0, page * pageSize),
    limit: pageSize,
  }
}

/**
 * Fields a backtest-list client already sorts on with the generic mapping's
 * reversed direction: a sort on `created` 'asc' is sent to mean newest first.
 * Kept as they are so that request keeps returning what it shows.
 */
export const BACKTEST_LIST_LEGACY_DIRECTION_FIELDS: readonly string[] = [
  'created',
]

/**
 * The backtest lists (DCA, Combo, Grid, Hedge) — `mapDataGridOptionsToMongoOptions`
 * with the requested sort direction honoured: 'desc' sorts descending (newest,
 * largest first), 'asc' ascending, a missing direction descending. The generic
 * mapping sorts 'desc' ascending; its other callers are unchanged.
 * Ties are broken by `_id` in the same direction, so pages neither repeat nor
 * skip rows that share a sort value. A sort on a field of
 * BACKTEST_LIST_LEGACY_DIRECTION_FIELDS keeps the generic direction.
 */
export const mapBacktestListOptions = (
  input?: Parameters<typeof mapDataGridOptionsToMongoOptions>[0],
) => {
  const mapped = mapDataGridOptionsToMongoOptions(input)
  const requested = input?.sortModel?.[0]
  if (
    !requested ||
    BACKTEST_LIST_LEGACY_DIRECTION_FIELDS.includes(`${requested.field}`)
  ) {
    return mapped
  }
  const key = Object.keys(mapped.sort)[0]
  const dir = requested.sort === 'asc' ? 1 : -1
  const sort: { [x: string]: number } = { [key]: dir }
  if (key !== '_id') {
    sort._id = dir
  }
  return { ...mapped, sort }
}
