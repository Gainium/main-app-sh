/**
 * Server-side filtering and totals for the deal lists (`dcaDealList`,
 * `comboDealList`) — main-app spec 020.
 *
 * A large account pages its closed deals on the server, so every column
 * filter the table offers has to be answerable in Mongo, and the footer totals
 * have to be computed over the filtered set rather than over one page.
 *
 * `buildDealListFilter` turns a DataGrid filter model into one Mongo filter:
 * - logical columns the deal document does not store as such (`botName`,
 *   `cost`, `pair`) are translated;
 * - `createTime` / `closeTime` are epoch-ms numbers, so day and date-range
 *   filters are built in the account's timezone;
 * - every item keeps its own condition (several items on one field combine),
 *   and `or` really ORs them;
 * - any other field keeps the generic DataGrid mapping it always had.
 *
 * Bot names are resolved to bot ids through an injected lookup, so the module
 * itself does no I/O.
 */
import moment from 'moment-timezone'
import type { DataGridFilterInput, GridFilterItem } from '../../types'
import { mapDataGridOptionsToMongoOptions } from '../db/utils'

type Cond = Record<string, unknown>

export const DEFAULT_DEAL_STATUSES = ['open', 'error', 'start']

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const DATE_FIELDS = new Set(['createTime', 'closeTime', 'updateTime'])
const TEXT_ALIASES: Record<string, string> = { pair: 'symbol.symbol' }

/**
 * The table's Cost column in quote units (redesign `calculateDealCost`):
 * spot long and USD-M → `usage.current.quote`; spot short and COIN-M →
 * `usage.current.base × avgPrice`; never below 0.
 */
export const DEAL_COST_EXPR = {
  $max: [
    0,
    {
      $let: {
        vars: {
          q: { $ifNull: ['$usage.current.quote', 0] },
          bp: {
            $multiply: [
              { $ifNull: ['$usage.current.base', 0] },
              { $ifNull: ['$avgPrice', 0] },
            ],
          },
        },
        in: {
          $cond: [
            { $eq: ['$settings.futures', true] },
            { $cond: [{ $eq: ['$settings.coinm', true] }, '$$bp', '$$q'] },
            { $cond: [{ $eq: ['$strategy', 'SHORT'] }, '$$bp', '$$q'] },
          ],
        },
      },
    },
  ],
}

const valuesOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => `${v ?? ''}`)
  if (value === undefined || value === null) return []
  return `${value}`
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

const textCond = (operator: string, value: unknown): Cond | undefined => {
  if (operator === 'isAnyOf') {
    const list = valuesOf(value)
    return list.length ? { $in: list } : undefined
  }
  const v = Array.isArray(value) ? `${value[0] ?? ''}` : `${value ?? ''}`
  if (!v) return undefined
  const e = escapeRegExp(v)
  if (operator === 'contains') return { $regex: new RegExp(e, 'i') }
  if (operator === 'startsWith') return { $regex: new RegExp(`^${e}`, 'i') }
  if (operator === 'endsWith') return { $regex: new RegExp(`${e}$`, 'i') }
  if (operator === 'equals' || operator === 'is' || operator === '=')
    return { $regex: new RegExp(`^${e}$`, 'i') }
  return undefined
}

const numberOf = (v: string): number | undefined => {
  if (v === '' || v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Half a unit of the last decimal the user typed: "100" → 0.5, "1.25" → 0.005. */
const equalsTolerance = (raw: string) => {
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
  return 0.5 * Math.pow(10, -decimals)
}

/** Numeric bounds for an operator; `expr` is a Mongo aggregation expression. */
const numericExprCond = (
  expr: unknown,
  operator: string,
  value: unknown,
): Cond | undefined => {
  const parts: Cond[] = []
  if (operator === 'between') {
    const [lo, hi] = Array.isArray(value)
      ? [`${value[0] ?? ''}`, `${value[1] ?? ''}`]
      : `${value ?? ''}`.split(',').map((s) => s.trim())
    const a = numberOf(lo)
    const b = numberOf(hi)
    if (a !== undefined) parts.push({ $gte: [expr, a] })
    if (b !== undefined) parts.push({ $lte: [expr, b] })
  } else {
    const raw = Array.isArray(value) ? `${value[0] ?? ''}` : `${value ?? ''}`
    const n = numberOf(raw)
    if (n === undefined) return undefined
    const tol = equalsTolerance(raw)
    if (operator === '=' || operator === 'equals')
      parts.push({ $gte: [expr, n - tol] }, { $lte: [expr, n + tol] })
    else if (operator === '!=')
      return {
        $expr: {
          $or: [{ $lt: [expr, n - tol] }, { $gt: [expr, n + tol] }],
        },
      }
    else if (operator === '>') parts.push({ $gt: [expr, n] })
    else if (operator === '>=') parts.push({ $gte: [expr, n] })
    else if (operator === '<') parts.push({ $lt: [expr, n] })
    else if (operator === '<=') parts.push({ $lte: [expr, n] })
  }
  if (!parts.length) return undefined
  return { $expr: parts.length === 1 ? parts[0] : { $and: parts } }
}

/** A stored numeric field: plain range operators so an index can serve them. */
const numericFieldCond = (
  field: string,
  operator: string,
  value: unknown,
): Cond | undefined => {
  if (operator === 'between') {
    const [lo, hi] = Array.isArray(value)
      ? [`${value[0] ?? ''}`, `${value[1] ?? ''}`]
      : `${value ?? ''}`.split(',').map((s) => s.trim())
    const range: Cond = {}
    const a = numberOf(lo)
    const b = numberOf(hi)
    if (a !== undefined) range.$gte = a
    if (b !== undefined) range.$lte = b
    return Object.keys(range).length ? { [field]: range } : undefined
  }
  return undefined
}

type Instant = { start: number; end: number; day: boolean }

/**
 * `YYYY-MM-DD` → that calendar day in `timezone` ([start, end));
 * digits → epoch ms; anything else → `Date.parse` (ISO with offset).
 */
export const parseInstant = (
  raw: string,
  timezone: string,
): Instant | undefined => {
  const v = `${raw ?? ''}`.trim()
  if (!v) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const zone = moment.tz.zone(timezone) ? timezone : 'UTC'
    const start = moment.tz(v, 'YYYY-MM-DD', true, zone)
    if (!start.isValid()) return undefined
    return {
      start: start.valueOf(),
      end: start.clone().add(1, 'day').valueOf(),
      day: true,
    }
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    return { start: n, end: n, day: false }
  }
  const t = Date.parse(decodeURIComponent(v))
  if (!Number.isFinite(t)) return undefined
  return { start: t, end: t, day: false }
}

const dateCond = (
  field: string,
  operator: string,
  value: unknown,
  timezone: string,
): Cond | undefined => {
  if (operator === 'isEmpty')
    return { $or: [{ [field]: { $exists: false } }, { [field]: null }] }
  if (operator === 'isNotEmpty') return { [field]: { $gt: 0 } }
  if (operator === 'between') {
    const [lo, hi] = Array.isArray(value)
      ? [`${value[0] ?? ''}`, `${value[1] ?? ''}`]
      : `${value ?? ''}`.split(',').map((s) => s.trim())
    const a = parseInstant(lo, timezone)
    const b = parseInstant(hi, timezone)
    const range: Cond = {}
    if (a) range.$gte = a.start
    if (b) {
      if (b.day) range.$lt = b.end
      else range.$lte = b.start
    }
    return Object.keys(range).length ? { [field]: range } : undefined
  }
  const raw = Array.isArray(value) ? `${value[0] ?? ''}` : `${value ?? ''}`
  const t = parseInstant(raw, timezone)
  if (!t) return undefined
  switch (operator) {
    case 'is':
    case 'equals':
    case '=':
      return t.day
        ? { [field]: { $gte: t.start, $lt: t.end } }
        : { [field]: { $eq: t.start } }
    case 'not':
    case '!=':
      return t.day
        ? { $or: [{ [field]: { $lt: t.start } }, { [field]: { $gte: t.end } }] }
        : { [field]: { $ne: t.start } }
    case 'after':
    case '>':
      return { [field]: t.day ? { $gte: t.end } : { $gt: t.start } }
    case 'onOrAfter':
    case '>=':
      return { [field]: { $gte: t.start } }
    case 'before':
    case '<':
      return { [field]: { $lt: t.start } }
    case 'onOrBefore':
    case '<=':
      return { [field]: t.day ? { $lt: t.end } : { $lte: t.start } }
  }
  return undefined
}

/** The generic DataGrid mapping for one item (unchanged legacy semantics). */
const genericCond = (item: GridFilterItem): Cond | undefined => {
  const { filter } = mapDataGridOptionsToMongoOptions({
    filterModel: { items: [{ ...item }] },
  })
  const conds = (filter.$and ?? []) as Cond[]
  return conds[0]
}

export type BotIdsByName = (nameCond: Cond) => Promise<string[]>

export type DealListFilterOptions = {
  timezone?: string
  /** Resolves a `settings.name` condition to the user's bot ids. */
  botIdsByName: BotIdsByName
}

export type DealListFilterResult = {
  /** Conditions ANDed with the caller's base filter (userId, context, …). */
  filter: Cond
  sort: Record<string, number>
  skip: number
  limit: number
  /** true when an item targets `status`, replacing the default statuses. */
  statusFromItems: boolean
}

type LegacyItem = GridFilterItem & {
  columnField?: string
  operatorValue?: string
}

export const buildDealListFilter = async (
  input: DataGridFilterInput | undefined,
  opts: DealListFilterOptions,
): Promise<DealListFilterResult> => {
  const timezone = opts.timezone || 'UTC'
  const { sort, skip, limit } = mapDataGridOptionsToMongoOptions({
    ...(input ?? {}),
    filterModel: { items: [] },
  })
  const model = (input?.filterModel ?? { items: [] }) as {
    items?: LegacyItem[]
    linkOperator?: string
    logicOperator?: string
  }
  const or =
    `${model.linkOperator ?? model.logicOperator ?? ''}`.toLowerCase() === 'or'
  const conds: Cond[] = []
  // Status items always AND (they select the tab: open vs closed); only the
  // other columns take part in an OR.
  const statusConds: Cond[] = []
  let statusFromItems = false
  for (const raw of model.items ?? []) {
    if (!raw) continue
    const field = raw.field ?? raw.columnField
    const operator = raw.operator ?? raw.operatorValue
    if (!field || !operator) continue
    const value = raw.value as unknown
    let cond: Cond | undefined
    if (field === 'status') {
      const list =
        operator === 'isAnyOf' || operator === 'equals' || operator === 'is'
          ? valuesOf(value)
          : []
      const statusCond = list.length
        ? { status: { $in: list } }
        : genericCond({ ...raw, field, operator } as GridFilterItem)
      if (statusCond) {
        statusFromItems = true
        statusConds.push(statusCond)
      }
      continue
    } else if (field === 'botName') {
      const nameCond = textCond(operator, value)
      if (nameCond) {
        const ids = await opts.botIdsByName({ 'settings.name': nameCond })
        cond = { botId: { $in: ids } }
      }
    } else if (field === 'cost') {
      cond = numericExprCond(DEAL_COST_EXPR, operator, value)
    } else if (DATE_FIELDS.has(field)) {
      cond = dateCond(field, operator, value, timezone)
    } else if (TEXT_ALIASES[field]) {
      const c = textCond(operator, value)
      if (c) cond = { [TEXT_ALIASES[field]]: c }
    } else if (operator === 'between') {
      cond = numericFieldCond(field, operator, value)
    } else {
      cond = genericCond({ ...raw, field, operator } as GridFilterItem)
    }
    if (cond) conds.push(cond)
  }
  const filter: Cond = {}
  const all =
    or && conds.length > 1
      ? [...statusConds, { $or: conds }]
      : [...statusConds, ...conds]
  if (all.length) filter.$and = all
  return {
    filter,
    sort: sort as Record<string, number>,
    skip,
    limit,
    statusFromItems,
  }
}

/** One aggregation over the filtered set (spec 020 §3). */
export const dealListTotalsPipeline = (match: Cond) => [
  { $match: match },
  {
    $group: {
      _id: null,
      count: { $sum: 1 },
      cost: { $sum: DEAL_COST_EXPR },
      costUsd: {
        $sum: {
          $cond: [{ $isNumber: '$stats.usage' }, '$stats.usage', 0],
        },
      },
      costUsdDeals: {
        $sum: { $cond: [{ $isNumber: '$stats.usage' }, 1, 0] },
      },
      realizedProfitUsd: {
        $sum: {
          $cond: [{ $isNumber: '$profit.totalUsd' }, '$profit.totalUsd', 0],
        },
      },
      unrealizedProfitNet: {
        $sum: {
          $cond: [
            {
              $and: [
                { $in: ['$status', DEFAULT_DEAL_STATUSES] },
                { $isNumber: '$stats.unrealizedProfitNet' },
              ],
            },
            '$stats.unrealizedProfitNet',
            0,
          ],
        },
      },
      unrealizedProfitNetDeals: {
        $sum: {
          $cond: [
            {
              $and: [
                { $in: ['$status', DEFAULT_DEAL_STATUSES] },
                { $isNumber: '$stats.unrealizedProfitNet' },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  },
  { $project: { _id: 0 } },
]

export const EMPTY_DEAL_TOTALS = {
  count: 0,
  cost: 0,
  costUsd: 0,
  costUsdDeals: 0,
  realizedProfitUsd: 0,
  unrealizedProfitNet: 0,
  unrealizedProfitNetDeals: 0,
}

/** Key under which a deal-list result hands its filter to the `totals` resolver. */
export const DEAL_TOTALS_ARGS = '__dealTotalsArgs'
