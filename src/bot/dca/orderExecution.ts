/**
 * Spec `242` — order execution modes. Pure decision logic: which execution a
 * stage uses, when a bot-driven limit close is re-priced or sent to market,
 * and the max-chase cap. No I/O.
 */
import {
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  OrderTypeEnum,
  type OrderExecution,
  type OrderExecutionMode,
} from '../../../types'

export type ExecutionStage = 'entry' | 'dca' | 'tp' | 'sl' | 'close'

/**
 * `level`: a price known in advance (percentage/ATR take profit, DCA levels).
 * Everything else is a signal with no known price. Spec §2.
 */
export type ExecutionTrigger =
  | 'level'
  | 'indicator'
  | 'webhook'
  | 'start'
  | 'manual'

/** The bot settings the derivation reads. */
export type ExecutionSettings = {
  entryExecution?: OrderExecution | null
  dcaExecution?: OrderExecution | null
  tpExecution?: OrderExecution | null
  slExecution?: OrderExecution | null
  startOrderType?: OrderTypeEnum | string | null
  notUseLimitReposition?: boolean | null
  useLimitTimeout?: boolean | null
  limitTimeout?: string | null
  dcaByMarket?: boolean | null
  closeOrderType?: OrderTypeEnum | string | null
  closeDealType?: CloseDCATypeEnum | string | null
  comboTpLimit?: boolean | null
  comboSlLimit?: boolean | null
}

const MODES: OrderExecutionMode[] = ['market', 'limit', 'chase', 'split']

/** Re-price interval the engine has always used. */
export const DEFAULT_REPRICE_SEC = 10
/** Market fallback for a bot-driven limit close (spec 100's `limitFallbackTimeout`). */
export const DEFAULT_CLOSE_TIMEOUT_SEC = 35

const MARKET: OrderExecution = { mode: 'market' }

const userTimeoutSec = (s: ExecutionSettings): number | null => {
  if (!s.useLimitTimeout || !s.limitTimeout) {
    return null
  }
  const n = parseFloat(s.limitTimeout)
  return Number.isFinite(n) && n > 0 ? n : null
}

const closeChase = (s: ExecutionSettings): OrderExecution => ({
  mode: 'chase',
  repriceSec: DEFAULT_REPRICE_SEC,
  maxChasePerc: 0,
  timeoutSec: userTimeoutSec(s) ?? DEFAULT_CLOSE_TIMEOUT_SEC,
})

const isMarketType = (v: unknown) => `${v ?? ''}`.toUpperCase() === 'MARKET'

/** What the legacy fields make the engine do. Spec §3. */
const legacyExecution = (
  stage: ExecutionStage,
  s: ExecutionSettings,
  trigger: ExecutionTrigger,
  isCombo: boolean,
  closeType?: CloseDCATypeEnum,
): OrderExecution => {
  switch (stage) {
    case 'entry': {
      const marketDefault = isCombo ? 'MARKET' : 'LIMIT'
      if (isMarketType(s.startOrderType ?? marketDefault)) {
        return MARKET
      }
      const timeoutSec = userTimeoutSec(s) ?? 0
      return s.notUseLimitReposition
        ? { mode: 'limit', timeoutSec }
        : {
            mode: 'chase',
            repriceSec: DEFAULT_REPRICE_SEC,
            maxChasePerc: 0,
            timeoutSec,
          }
    }
    case 'dca':
      if (trigger !== 'level' || s.dcaByMarket) {
        return MARKET
      }
      return { mode: 'limit', timeoutSec: 0 }
    case 'tp':
      if (isCombo) {
        return s.comboTpLimit ? closeChase(s) : MARKET
      }
      if (trigger === 'indicator' || trigger === 'webhook') {
        return s.closeDealType === CloseDCATypeEnum.closeByLimit
          ? closeChase(s)
          : MARKET
      }
      return isMarketType(s.closeOrderType ?? 'LIMIT')
        ? MARKET
        : { mode: 'limit', timeoutSec: 0 }
    case 'sl':
      if (isCombo) {
        return s.comboSlLimit ? closeChase(s) : MARKET
      }
      return trigger === 'indicator' &&
        s.closeDealType === CloseDCATypeEnum.closeByLimit
        ? closeChase(s)
        : MARKET
    case 'close':
    default:
      return closeType === CloseDCATypeEnum.closeByLimit
        ? closeChase(s)
        : MARKET
  }
}

const STORED: Record<ExecutionStage, keyof ExecutionSettings | null> = {
  entry: 'entryExecution',
  dca: 'dcaExecution',
  tp: 'tpExecution',
  sl: 'slExecution',
  close: null,
}

/** Modes offered for a stage and trigger. Spec §2. */
export const availableModes = (
  stage: ExecutionStage,
  trigger: ExecutionTrigger,
): OrderExecutionMode[] => {
  // Only what the engine executes (spec §6.3.1): no split for the base order
  // or DCA orders; indicator DCA orders always go at market.
  if (stage === 'dca') {
    return trigger === 'level' ? ['market', 'limit'] : ['market']
  }
  if (stage === 'entry') {
    return ['market', 'limit', 'chase', 'split']
  }
  if (stage === 'sl') {
    return ['market', 'chase', 'split']
  }
  return trigger === 'level'
    ? ['market', 'limit', 'split']
    : ['market', 'limit', 'chase', 'split']
}

/** Nearest offered mode when the stored one is not offered. Spec §2.4. */
const fitToModes = (
  e: OrderExecution,
  modes: OrderExecutionMode[],
): OrderExecution => {
  if (modes.includes(e.mode)) {
    return e
  }
  if (e.mode === 'chase' && modes.includes('limit')) {
    return { mode: 'limit', timeoutSec: e.timeoutSec ?? 0 }
  }
  if (e.mode === 'limit' && modes.includes('chase')) {
    return {
      mode: 'chase',
      repriceSec: DEFAULT_REPRICE_SEC,
      maxChasePerc: 0,
      timeoutSec: e.timeoutSec ?? 0,
    }
  }
  return MARKET
}

const isValidStored = (v: unknown): v is OrderExecution =>
  !!v && typeof v === 'object' && MODES.includes((v as OrderExecution).mode)

/**
 * A stop-loss split never waits (§4.4, §4.5, §5.3): its slices chase rather
 * than rest at the stop price (a limit there sits above a falling market),
 * each unfilled slice goes to market after the stop-loss timeout, and a
 * breached floor executes the rest instead of pausing. Applied to stored
 * settings too, so values saved before validation refused them stay safe.
 */
export const fitStopLossSplit = (e: OrderExecution): OrderExecution => {
  if (e.mode !== 'split') {
    return e
  }
  return {
    ...e,
    sliceMode: e.sliceMode === 'market' ? 'market' : 'chase',
    timeoutSec:
      (e.timeoutSec ?? 0) > 0 ? e.timeoutSec : DEFAULT_CLOSE_TIMEOUT_SEC,
    ...((e.floorPerc ?? 0) > 0 ? { onFloor: 'market' as const } : {}),
  }
}

/**
 * The execution a stage uses: the stored field when valid (fitted to the
 * trigger), else what the legacy fields describe. A chasing stop loss always
 * ends at market (§4.4).
 */
export const resolveExecution = (
  stage: ExecutionStage,
  settings: ExecutionSettings,
  trigger: ExecutionTrigger,
  opts: { isCombo?: boolean; closeType?: CloseDCATypeEnum } = {},
): OrderExecution => {
  const key = STORED[stage]
  const stored = key ? settings[key] : null
  const base = isValidStored(stored)
    ? fitToModes(stored, availableModes(stage, trigger))
    : legacyExecution(stage, settings, trigger, !!opts.isCombo, opts.closeType)
  if (stage === 'sl' && base.mode === 'chase' && !(base.timeoutSec ?? 0)) {
    return { ...base, timeoutSec: DEFAULT_CLOSE_TIMEOUT_SEC }
  }
  if (stage === 'sl' && base.mode === 'split') {
    return fitStopLossSplit(base)
  }
  return base
}

/** Which stage's settings govern a close, from what triggered it. */
export const stageForClose = (
  trigger: DCACloseTriggerEnum | undefined,
  slSource: boolean,
): 'tp' | 'sl' | 'close' => {
  if (slSource || trigger === DCACloseTriggerEnum.sl) {
    return 'sl'
  }
  switch (trigger) {
    case DCACloseTriggerEnum.tp:
    case DCACloseTriggerEnum.trailing:
    case DCACloseTriggerEnum.indicator:
    case DCACloseTriggerEnum.combined:
    case DCACloseTriggerEnum.webhook:
      return 'tp'
    default:
      return 'close'
  }
}

export type CloseTimerPlan =
  | { action: 'reprice'; delayMs: number }
  | { action: 'market'; delayMs: number }
  | { action: 'none'; delayMs: 0 }

/**
 * Next timer for an unfilled bot-driven limit close. `elapsedMs` is the time
 * since the close's FIRST placement; re-placements do not reset it. Spec §4.3.
 */
export const closeTimerPlan = (p: {
  elapsedMs: number
  repriceSec: number
  timeoutSec: number
  /** true for chase; false for a limit that stays at its price. */
  reprice: boolean
}): CloseTimerPlan => {
  const repriceMs = Math.max(0, p.repriceSec) * 1000
  const timeoutMs = Math.max(0, p.timeoutSec) * 1000
  if (timeoutMs > 0) {
    const remaining = timeoutMs - p.elapsedMs
    if (remaining <= 0) {
      return { action: 'market', delayMs: 0 }
    }
    if (!p.reprice || repriceMs <= 0 || remaining <= repriceMs) {
      return { action: 'market', delayMs: remaining }
    }
  }
  if (p.reprice && repriceMs > 0) {
    return { action: 'reprice', delayMs: repriceMs }
  }
  return { action: 'none', delayMs: 0 }
}

/**
 * Never chase a close further than `maxChasePerc` from its trigger price.
 * A SELL close (long) is floored, a BUY close (short) is capped. Spec §4.3.
 */
export const clampChasePrice = (p: {
  price: number
  triggerPrice: number
  maxChasePerc: number
  side: 'BUY' | 'SELL'
}): number => {
  if (!(p.maxChasePerc > 0) || !(p.triggerPrice > 0)) {
    return p.price
  }
  const ratio = p.maxChasePerc / 100
  if (p.side === 'SELL') {
    return Math.max(p.price, p.triggerPrice * (1 - ratio))
  }
  return Math.min(p.price, p.triggerPrice * (1 + ratio))
}

/**
 * A chasing limit's price from the top of the book: a buy at the best bid, a
 * sell at the best ask, so it waits for a fill instead of crossing the spread.
 * Without a usable book (unsupported venue, failed call, crossed or empty
 * book) it falls back to the last trade, as before. Spec §4.3.1.
 */
export const bookChasePrice = (p: {
  side: 'BUY' | 'SELL'
  last: number
  book?: { bid: number; ask: number } | null
}): number => {
  const b = p.book
  if (
    !b ||
    !Number.isFinite(b.bid) ||
    !Number.isFinite(b.ask) ||
    !(b.bid > 0) ||
    !(b.ask > 0) ||
    b.bid > b.ask
  ) {
    return p.last
  }
  return p.side === 'BUY' ? b.bid : b.ask
}

/**
 * Whether a stage chases because the stored execution setting says so. A
 * legacy limit (§3) resolves to `chase` too but keeps its old pricing.
 */
export const storedChase = (
  stage: ExecutionStage,
  settings: ExecutionSettings,
  trigger: ExecutionTrigger,
): boolean => {
  const key = STORED[stage]
  const stored = key ? settings[key] : null
  return (
    isValidStored(stored) &&
    fitToModes(stored, availableModes(stage, trigger)).mode === 'chase'
  )
}

/** The trigger a take-profit / stop-loss type stands for. Spec §2. */
export const triggerFromCloseCondition = (
  condition: string | null | undefined,
): ExecutionTrigger => {
  switch (condition) {
    case 'techInd':
      return 'indicator'
    case 'webhook':
      return 'webhook'
    default:
      return 'level'
  }
}

/**
 * The close type a signal-driven close of this stage uses: by limit for
 * `limit` / `chase` (timing then follows the stage's execution), market
 * otherwise — including a stored `split` until phase 3.
 */
export const closeTypeForStage = (
  stage: 'tp' | 'sl',
  settings: ExecutionSettings,
  trigger: ExecutionTrigger,
  isCombo = false,
): CloseDCATypeEnum => {
  const e = resolveExecution(stage, settings, trigger, { isCombo })
  return e.mode === 'limit' || e.mode === 'chase'
    ? CloseDCATypeEnum.closeByLimit
    : CloseDCATypeEnum.closeByMarket
}

/** The settings keys that hold an `OrderExecution`. */
export const EXECUTION_SETTING_KEYS = [
  'entryExecution',
  'dcaExecution',
  'tpExecution',
  'slExecution',
] as const

const NUMERIC_BOUNDS: Record<string, [number, number]> = {
  repriceSec: [5, 600],
  maxChasePerc: [0, 20],
  timeoutSec: [0, 86_400],
  slices: [2, 50],
  sliceIntervalSec: [5, 3_600],
  floorPerc: [0, 50],
}
const ENUMS: Record<string, readonly string[]> = {
  mode: MODES,
  pace: ['iceberg', 'twap'],
  sliceMode: ['market', 'chase', 'limit'],
  onFloor: ['pause', 'market'],
}

/**
 * Validate an `OrderExecution` from an untyped source (public API). Returns an
 * error message, or null when valid. `null`/`undefined` is valid (derive from
 * the legacy fields).
 */
export const validateOrderExecution = (
  value: unknown,
  stage?: ExecutionStage,
): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object or null'
  }
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) {
    if (!(key in NUMERIC_BOUNDS) && !(key in ENUMS)) {
      return `unknown field ${key}`
    }
  }
  if (!MODES.includes(v['mode'] as OrderExecutionMode)) {
    return `mode must be one of ${MODES.join(', ')}`
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (v[key] !== undefined && !allowed.includes(v[key] as string)) {
      return `${key} must be one of ${allowed.join(', ')}`
    }
  }
  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const n = v[key]
    if (n === undefined) {
      continue
    }
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      return `${key} must be a number between ${min} and ${max}`
    }
    if (key === 'slices' && !Number.isInteger(n)) {
      return 'slices must be an integer'
    }
  }
  if (stage === 'sl' && v['mode'] === 'split' && v['sliceMode'] === 'limit') {
    return 'sliceMode limit is not available for a stop loss; use chase or market'
  }
  return null
}

/**
 * The base order's order type: from a stored `entryExecution` (market →
 * MARKET, limit/chase → LIMIT), else the legacy `startOrderType`. A stored
 * `split` uses the legacy field until phase 3. Spec §6.2.
 */
export const entryOrderType = (
  settings: ExecutionSettings,
): OrderTypeEnum | undefined => {
  const e = settings.entryExecution
  if (isValidStored(e)) {
    if (e.mode === 'market') {
      return OrderTypeEnum.market
    }
    if (e.mode === 'limit' || e.mode === 'chase') {
      return OrderTypeEnum.limit
    }
    if (e.mode === 'split') {
      // The base order is the split's first slice.
      return e.sliceMode === 'market'
        ? OrderTypeEnum.market
        : OrderTypeEnum.limit
    }
  }
  const legacy = settings.startOrderType
  return legacy ? (legacy as OrderTypeEnum) : undefined
}

/** Max-chase cap for a re-placed base order; 0 = none. Spec §4.3. */
export const entryChaseCapPerc = (settings: ExecutionSettings): number => {
  const e = settings.entryExecution
  return isValidStored(e) && e.mode === 'chase' ? (e.maxChasePerc ?? 0) : 0
}

/**
 * Milliseconds a resting single-target take profit may stay part-filled
 * before the rest is executed at market; 0 = no timeout. Only a stored
 * `limit` on a price-level take profit has one. Spec §4.2, §6.2.
 */
export const restingTpTimeoutMs = (
  settings: ExecutionSettings & {
    dealCloseCondition?: string | null
    useMultiTp?: boolean | null
  },
  isCombo: boolean,
): number => {
  if (isCombo || settings.useMultiTp) {
    return 0
  }
  if (triggerFromCloseCondition(settings.dealCloseCondition) !== 'level') {
    return 0
  }
  const e = settings.tpExecution
  if (!isValidStored(e) || e.mode !== 'limit') {
    return 0
  }
  const s = e.timeoutSec ?? 0
  return s > 0 ? s * 1000 : 0
}

const roundDownToStep = (v: number, step: number) => {
  if (!(step > 0)) {
    return v
  }
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return +(Math.floor(v / step + 1e-9) * step).toFixed(decimals)
}

/**
 * Slice sizes for a split order. Equal slices rounded down to the exchange
 * step; the last slice takes the rest, so the sizes always sum to the total.
 * A slice below the exchange minimum (quantity or notional) is merged into
 * the previous one — fewer, valid slices rather than a rejected order.
 * Spec §4.5.
 */
export const planSplitSizes = (p: {
  totalQty: number
  slices: number
  step: number
  minQty: number
  minNotional?: number
  price?: number
}): number[] => {
  const total = p.totalQty
  if (!(total > 0)) {
    return []
  }
  const minByNotional =
    p.minNotional && p.price && p.price > 0 ? p.minNotional / p.price : 0
  const minSlice = Math.max(p.minQty || 0, minByNotional)
  const count = Math.max(1, Math.floor(p.slices || 1))
  const each = roundDownToStep(total / count, p.step)
  if (!(each > 0) || each < minSlice || count === 1) {
    return [total]
  }
  const sizes: number[] = []
  let left = total
  for (let i = 0; i < count - 1; i++) {
    sizes.push(each)
    left -= each
  }
  const decimals =
    p.step > 0 ? Math.max(0, -Math.floor(Math.log10(p.step))) + 2 : 12
  sizes.push(+left.toFixed(decimals))
  // Merge any slice below the minimum into its predecessor, from the end.
  for (let i = sizes.length - 1; i > 0; i--) {
    if (sizes[i] < minSlice) {
      sizes[i - 1] = +(sizes[i - 1] + sizes[i]).toFixed(decimals)
      sizes.splice(i, 1)
    }
  }
  return sizes.length && sizes[0] >= minSlice ? sizes : [total]
}

/** True when price has moved more than `floorPerc` against the trigger. §4.5. */
export const splitFloorBreached = (p: {
  side: 'BUY' | 'SELL'
  triggerPrice: number
  lastPrice: number
  floorPerc: number
}): boolean => {
  if (!(p.floorPerc > 0) || !(p.triggerPrice > 0) || !(p.lastPrice > 0)) {
    return false
  }
  const ratio = p.floorPerc / 100
  return p.side === 'SELL'
    ? p.lastPrice < p.triggerPrice * (1 - ratio)
    : p.lastPrice > p.triggerPrice * (1 + ratio)
}

/**
 * Whether a deal's base order can be split (spec §6.5): a plain DCA bot entry
 * only. Excluded where the base size is owned by another mechanism — combo,
 * terminal deals, risk/reward sizing, compound reduce, a fixed size carried by
 * the deal, short spot base funding, single-position mode.
 */
export const entrySplitEligible = (
  settings: ExecutionSettings,
  ctx: {
    isCombo: boolean
    terminal: boolean
    riskReward: boolean
    compoundReduce: boolean
    fixSize: number
    spotShort: boolean
    singlePosition: boolean
  },
): boolean => {
  const e = settings.entryExecution
  if (!isValidStored(e) || e.mode !== 'split') {
    return false
  }
  return !(
    ctx.isCombo ||
    ctx.terminal ||
    ctx.riskReward ||
    ctx.compoundReduce ||
    ctx.fixSize > 0 ||
    ctx.spotShort ||
    ctx.singlePosition
  )
}
