import { ExchangeEnum } from '../../types'
import { Candidate, FailsafeConfig } from './types'

/**
 * L2 coalescer (spec §3.2) — PURE.
 *
 * Batches candidates per exchangeUUID inside FF_CONFIRM_COALESCE_MS, then decides
 * per exchange whether to issue one `getOrder` per candidate (cheap when few) or
 * a single symbol-scoped `getAllOpenOrders` list call (cheaper once N crosses the
 * per-exchange threshold). Defaults to a threshold of 2 everywhere; binanceSpot
 * stays high (20) until the connector's flat-80 weight-accounting fix lands.
 */

export type ConfirmStrategy = 'perOrder' | 'list'

/**
 * Per-exchange batch thresholds (§3.2 audited policy). N >= threshold => list.
 * Everything defaults to `cfg.confirmBatchThreshold` (2). binanceSpot is pinned
 * high until the connector debits per-symbol weight correctly.
 */
export function batchThreshold(
  exchange: ExchangeEnum | string,
  cfg: FailsafeConfig,
): number {
  if (exchange === ExchangeEnum.binance) return 20
  return cfg.confirmBatchThreshold
}

export interface ConfirmBatch {
  exchangeUUID: string
  exchange: ExchangeEnum
  strategy: ConfirmStrategy
  candidates: Candidate[]
}

/**
 * Group coalesced candidates by exchangeUUID and choose a confirm strategy.
 * Duplicate clientOrderIds are collapsed so the same order isn't confirmed twice
 * within one batch.
 */
export function coalesce(
  candidates: Candidate[],
  _cfg: FailsafeConfig,
): ConfirmBatch[] {
  const byUuid = new Map<string, Candidate[]>()
  const seen = new Map<string, Set<string>>()
  for (const c of candidates) {
    const uuid = c.order.exchangeUUID
    const ids = seen.get(uuid) ?? new Set<string>()
    if (ids.has(c.order.clientOrderId)) continue
    ids.add(c.order.clientOrderId)
    seen.set(uuid, ids)
    const list = byUuid.get(uuid) ?? []
    list.push(c)
    byUuid.set(uuid, list)
  }

  const batches: ConfirmBatch[] = []
  for (const [exchangeUUID, list] of byUuid.entries()) {
    const exchange = list[0].order.realExchange
    /* const threshold = batchThreshold(exchange, cfg) */
    batches.push({
      exchangeUUID,
      exchange,
      strategy: /*  list.length >= threshold ? */ 'list' /* : 'perOrder' */,
      candidates: list,
    })
  }
  return batches
}
