import {
  Candidate,
  FailsafeConfig,
  FilterState,
  OrderDebounce,
  RestingOrder,
  Tick,
  symKey,
} from './types'

/**
 * L1 candidate filter (spec §3.1) — PURE, no I/O.
 *
 * A resting order is "crossed" when the last trade price strictly trades
 * *through* it (SELL: lastPrice > order.price; BUY: lastPrice < order.price).
 * Strict inequality is mandatory (§3.1): with a zero-spread last-price feed a
 * touch is fully explained by a maker resting at that level.
 *
 * Debounce: a crossed order becomes a candidate only after it has stayed crossed
 * for >= FF_DEBOUNCE_MS AND >= FF_MIN_TICKS consecutive crossed ticks. Any
 * un-cross resets the debounce. Candidates carry a TTL (FF_CANDIDATE_TTL_MS)
 * after which they re-debounce from scratch. A per-order false-positive cooldown
 * (FF_FP_COOLDOWN_MS) suppresses re-candidacy after a confirm found no fill.
 */

const fresh = (): OrderDebounce => ({
  crossedSince: null,
  crossedTicks: 0,
  candidateAt: null,
  fpUntil: 0,
})

/** SELL crossed when price strictly above; BUY crossed when strictly below. */
export function isCrossed(order: RestingOrder, tick: Tick): boolean {
  return order.side === 'SELL'
    ? tick.maxPrice > order.price
    : tick.minPrice < order.price
}

/**
 * Rebuild the per-(symbol,exchange) O(1) rejection thresholds from the current
 * registry. Call on every registry add/remove. `minSell` = lowest resting SELL
 * price; `maxBuy` = highest resting BUY price. A tick can only cross something on
 * a side when it passes the relevant extreme.
 */
export function buildThresholds(
  orders: RestingOrder[],
): Map<string, { minSell: number; maxBuy: number }> {
  const thresholds = new Map<string, { minSell: number; maxBuy: number }>()
  for (const o of orders) {
    // `priceSymbol`, not `symbol`: ticks arrive keyed by the channel's
    // canonical pair, so the threshold map must be keyed the same way or the
    // O(1) rejection below looks up a bucket that is never populated.
    const k = symKey(o.priceSymbol, o.realExchange)
    const cur = thresholds.get(k) ?? {
      minSell: Number.POSITIVE_INFINITY,
      maxBuy: Number.NEGATIVE_INFINITY,
    }
    if (o.side === 'SELL') cur.minSell = Math.min(cur.minSell, o.price)
    else cur.maxBuy = Math.max(cur.maxBuy, o.price)
    thresholds.set(k, cur)
  }
  return thresholds
}

/** Drop debounce entries for orders no longer in the registry (memory hygiene). */
export function pruneDebounce(
  state: FilterState,
  orders: RestingOrder[],
): void {
  const live = new Set(orders.map((o) => o.clientOrderId))
  for (const id of state.debounce.keys()) {
    if (!live.has(id)) state.debounce.delete(id)
  }
}

/**
 * Process one tick against the registry. Returns any orders that graduated to
 * candidates on THIS tick (i.e. crossed the debounce boundary now). Mutates
 * `state.debounce` in place.
 *
 * `restingOrders` is the full current registry; the O(1) threshold check short-
 * circuits when nothing on the tick's (symbol,exchange) can possibly be crossed.
 */
export function candidateFilter(
  restingOrders: RestingOrder[],
  tick: Tick,
  state: FilterState,
  cfg: FailsafeConfig,
  now: number = Date.now(),
): { candidates: Candidate[] } {
  const candidates: Candidate[] = []
  const th = state.thresholds.get(symKey(tick.symbol, tick.exchange))
  // O(1) rejection: if the tick can't pass either extreme, nothing crosses.
  if (th && !(tick.maxPrice > th.minSell) && !(tick.minPrice < th.maxBuy)) {
    return { candidates }
  }

  for (const order of restingOrders) {
    if (
      order.priceSymbol !== tick.symbol ||
      order.realExchange !== tick.exchange
    ) {
      continue
    }
    let d = state.debounce.get(order.clientOrderId)
    if (!d) {
      d = fresh()
      state.debounce.set(order.clientOrderId, d)
    }

    // False-positive cooldown: hold off entirely until it expires.
    if (d.fpUntil > now) continue

    // Candidate TTL: an un-confirmed candidate re-debounces from scratch.
    if (d.candidateAt !== null && now - d.candidateAt >= cfg.candidateTtlMs) {
      d.crossedSince = null
      d.crossedTicks = 0
      d.candidateAt = null
    }

    if (!isCrossed(order, tick)) {
      // Un-cross resets the debounce (kills wicks / stale ticks).
      d.crossedSince = null
      d.crossedTicks = 0
      d.candidateAt = null
      continue
    }

    // Crossed.
    if (d.crossedSince === null) d.crossedSince = now
    d.crossedTicks += 1

    if (d.candidateAt !== null) continue // already an active candidate

    const heldLongEnough = now - d.crossedSince >= cfg.debounceMs
    const enoughTicks = d.crossedTicks >= cfg.minTicks
    if (heldLongEnough && enoughTicks) {
      d.candidateAt = now
      candidates.push({ order, since: now })
    }
  }

  return { candidates }
}

/**
 * Mark a confirmed false positive: start the per-order FP cooldown and clear the
 * debounce so it must re-cross and re-debounce afterwards. Returns the number of
 * ticks it debounced (0 kept — this is a state mutation).
 */
export function markFalsePositive(
  state: FilterState,
  clientOrderId: string,
  cfg: FailsafeConfig,
  now: number = Date.now(),
): void {
  const d = state.debounce.get(clientOrderId) ?? fresh()
  d.crossedSince = null
  d.crossedTicks = 0
  d.candidateAt = null
  d.fpUntil = now + cfg.fpCooldownMs
  state.debounce.set(clientOrderId, d)
}

/** Clear a candidate's active flag after a confirm (divergence or skip retry). */
export function clearCandidate(
  state: FilterState,
  clientOrderId: string,
): void {
  const d = state.debounce.get(clientOrderId)
  if (d) d.candidateAt = null
}

/**
 * Mark a confirmed divergence: full debounce reset + cooldown, like
 * markFalsePositive but for the divergent outcome. Without this the order stays
 * "crossed" and re-candidates on the next tick — in shadow mode (where nothing
 * resolves the divergence) that re-confirms the same order every coalesce cycle
 * and burns the rate-cap budget; in active mode it re-confirms before the sweep
 * has had a chance to book the fill. Cooldown starts at max(sweepCooldownMs,
 * fpCooldownMs) and TRIPLES per repeat divergence (cap dormantMs) so
 * unresolvable rows go quiet instead of churning forever.
 */
export function markConfirmedDivergence(
  state: FilterState,
  clientOrderId: string,
  cfg: FailsafeConfig,
  now: number = Date.now(),
  overrideMs?: number,
): void {
  const d = state.debounce.get(clientOrderId) ?? fresh()
  d.crossedSince = null
  d.crossedTicks = 0
  d.candidateAt = null
  // Exponential backoff: a divergence the sweep resolves leaves the registry
  // before the cooldown matters; one it CANNOT resolve (dead account, zombie
  // row) re-confirms — so each repeat divergence triples the cooldown up to
  // dormantMs. overrideMs (e.g. 0-subscriber dormancy) wins outright.
  const count = d.divergedCount ?? 0
  const base = Math.max(cfg.sweepCooldownMs, cfg.fpCooldownMs)
  const backoff = Math.min(
    base * Math.pow(3, Math.min(count, 8)),
    cfg.dormantMs,
  )
  d.fpUntil = now + (overrideMs ?? backoff)
  d.divergedCount = count + 1
  state.debounce.set(clientOrderId, d)
}

export const freshDebounce = fresh
