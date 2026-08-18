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
