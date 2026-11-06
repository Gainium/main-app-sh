import { ExchangeEnum, OrderStatusType } from '../../types'

/**
 * Missed-Fill Failsafe — shared types + tunables.
 *
 * Standalone single-instance detector (spec §3, §7). Reads resting LIMIT orders
 * from Mongo, watches the `trade@` Redis feed for strict last-price crosses, and
 * — only after debounce + exchange-confirm — publishes the EXISTING
 * `RECONCILE VIA SWEEP` signal. In shadow mode it logs instead of publishing.
 *
 * Nothing here writes trading state. See spec §7.2a (safety envelope).
 */

export const LOG_PREFIX = '[fillFailsafe]'

/** A resting order as loaded by the registry (spec §3.1). */
export interface RestingOrder {
  clientOrderId: string
  /**
   * Symbol as the ORDER row holds it — the string the venue answers to. Used
   * for exchange calls (`getOrder`, `getAllOpenOrders`) and nothing else.
   */
  symbol: string
  /**
   * Canonical pair for the `trade@` price feed, resolved by `SymbolResolver`.
   * Usually identical to `symbol`; differs where the venue echoes an alternate
   * name back on the order (Kraken `ETHEUR` → `ETH-EUR`). Subscribing on the
   * wrong one is silent — the channel simply never ticks — so the two are kept
   * separate rather than reconciled into one field.
   */
  priceSymbol: string
  /** Normalised asset codes off the order row; the resolver's last bridge. */
  baseAsset?: string
  quoteAsset?: string
  exchange: ExchangeEnum
  /** Real (non-paper) exchange used for the `trade@` channel + confirm routing. */
  realExchange: ExchangeEnum
  exchangeUUID: string
  botId: string
  userId: string
  side: 'BUY' | 'SELL'
  /** Numeric price (schema stores it as string). */
  price: number
  /** Numeric executedQty at load time (schema stores it as string). */
  executedQty: number
  paperContext: boolean
  status: OrderStatusType
}

/** A parsed price tick (subset of core `PriceMessage`). */
export interface Tick {
  symbol: string
  exchange: ExchangeEnum
  minPrice: number
  maxPrice: number
  time: number
}

/**
 * Per-order debounce state. `crossedSince` is the wall-clock ms when the order
 * first started crossing (reset to null when it un-crosses). `crossedTicks`
 * counts consecutive crossed ticks. `candidateAt` marks when it graduated to a
 * candidate (for TTL). `fpUntil` is a per-order false-positive cooldown deadline.
 */
export interface OrderDebounce {
  crossedSince: number | null
  crossedTicks: number
  candidateAt: number | null
  fpUntil: number
  /**
   * How many times this order has confirmed divergent without resolving.
   * Drives the exponential sweep backoff (5m → 15m → 45m → … cap dormantMs):
   * a divergence a sweep cannot fix (dead account, zombie row) must not
   * re-confirm + re-sweep every cooldown forever.
   */
  divergedCount?: number
}

/** Mutable state threaded through the pure `candidateFilter` (spec §3.1). */
export interface FilterState {
  /** clientOrderId -> debounce record. */
  debounce: Map<string, OrderDebounce>
  /**
   * Per-(symbol,exchange) O(1) rejection thresholds. `minSell` = lowest resting
   * SELL price; a tick <= minSell can cross nothing on the sell side. `maxBuy` =
   * highest resting BUY price; a tick >= maxBuy can cross nothing on the buy side.
   */
  thresholds: Map<string, { minSell: number; maxBuy: number }>
}

/** A confirmed candidate ready for L2 confirm. */
export interface Candidate {
  order: RestingOrder
  /** ms timestamp when it became a candidate. */
  since: number
}

/** Environment-tunable knobs (spec §3, §7). Defaults are OFF / shadow. */
export interface FailsafeConfig {
  enabled: boolean
  shadow: boolean
  ordersRefreshMs: number
  snapshotMs: number
  debounceMs: number
  minTicks: number
  candidateTtlMs: number
  fpCooldownMs: number
  confirmCoalesceMs: number
  confirmBatchThreshold: number
  maxConfirmsPerMin: number
  cbThreshold: number
  cbRequireSignal: boolean
  usageBackoff: number
  usageCooldownMs: number
  sweepCooldownMs: number
  /** Cap for the divergence backoff + the 0-subscriber account dormancy (6h default). */
  dormantMs: number
  /**
   * Venues excluded from the registry entirely (FF_EXCHANGES_SKIP csv) — e.g.
   * feeds with wrong-scale/phantom prices that produce 100% false positives.
   */
  exchangesSkip: Set<string>
  /** `PING` probe period on every registry account's channel (0 = off). */
  pingMs: number
  /** How long a sweep/probe may go unacknowledged before it counts as unheard. */
  ackGraceMs: number
  /** Consecutive missed probes that make a bot "deaf". */
  deafMisses: number
  /** Minimum spacing between two on-call alerts of the same kind/account. */
  alertCooldownMs: number
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) ? n : d
}
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined ? d : v === 'true'

/** Read the `FF_*` block from `process.env`, applying spec defaults. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): FailsafeConfig {
  return {
    enabled: bool(env.FF_ENABLED, false),
    shadow: bool(env.FF_SHADOW, true),
    ordersRefreshMs: num(env.FF_ORDERS_REFRESH_MS, 30_000),
    snapshotMs: num(env.FF_SNAPSHOT_MS, 60_000),
    debounceMs: num(env.FF_DEBOUNCE_MS, 30_000),
    minTicks: num(env.FF_MIN_TICKS, 3),
    candidateTtlMs: num(env.FF_CANDIDATE_TTL_MS, 900_000),
    fpCooldownMs: num(env.FF_FP_COOLDOWN_MS, 300_000),
    confirmCoalesceMs: num(env.FF_CONFIRM_COALESCE_MS, 30_000),
    confirmBatchThreshold: num(env.FF_CONFIRM_BATCH_THRESHOLD, 2),
    maxConfirmsPerMin: num(env.FF_MAX_CONFIRMS_PER_MIN, 20),
    cbThreshold: num(env.FF_CB_THRESHOLD, 0.6),
    cbRequireSignal: bool(env.FF_CB_REQUIRE_SIGNAL, false),
    usageBackoff: num(env.FF_USAGE_BACKOFF, 0.5),
    usageCooldownMs: num(env.FF_USAGE_COOLDOWN_MS, 60_000),
    sweepCooldownMs: num(env.FF_SWEEP_COOLDOWN_MS, 300_000),
    dormantMs: num(env.FF_DORMANT_MS, 21_600_000),
    pingMs: num(env.FF_PING_MS, 120_000),
    ackGraceMs: num(env.FF_ACK_GRACE_MS, 60_000),
    deafMisses: num(env.FF_DEAF_MISSES, 2),
    alertCooldownMs: num(env.FF_ALERT_COOLDOWN_MS, 3_600_000),
    exchangesSkip: new Set(
      (env.FF_EXCHANGES_SKIP ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  }
}

/** Stable per-(symbol,exchange) key for the threshold map + subscriptions. */
export const symKey = (
  symbol: string,
  exchange: ExchangeEnum | string,
): string => `${symbol}@${exchange}`
