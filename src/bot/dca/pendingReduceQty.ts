/**
 * The base / quote a deal's pending reduce-funds entries still withdraw —
 * what the take profit and the deal's balances leave out while they rest.
 *
 * An entry stores the user's REQUEST (`qty`, `asset`, `type`), not the order
 * it became. Reading `qty` as an amount is wrong for a percentage request: a
 * 40 % reduce of 0.006 BTC is an order of 0.002 BTC, but `40 / price` counted
 * 0.0005, so a take profit regenerated next to the resting reduce (a deal
 * edit, a safety order fill) came back at nearly the full position and the
 * two together sold more than the deal held.
 *
 * The resting order IS the withdrawal: when an order carrying the entry's id
 * is live, its quantity is used (the whole order, as a fixed entry always
 * counted: a part it has filled is not booked until the order fills). Without one, a fixed request keeps
 * its stated amount; a percentage request counts nothing (nothing rests, the
 * position is still held — the reload re-sends it, sized then).
 */
export type PendingReduceEntry = {
  id: string
  qty: string | number
  asset?: string
  type?: string
  useLimitPrice?: boolean
  limitPrice?: string | number
}

export type PendingReduceOrderRow = {
  status: string
  reduceFundsId?: string
  origQty: string
  price: string
}

const LIVE = ['NEW', 'PARTIALLY_FILLED']

export function pendingReduceQty(
  entries: PendingReduceEntry[],
  orders: PendingReduceOrderRow[],
): { base: number; quote: number } {
  let base = 0
  let quote = 0
  for (const e of entries) {
    if (!e.useLimitPrice) {
      continue
    }
    const live = orders.filter(
      (o) => o.reduceFundsId === e.id && LIVE.includes(o.status),
    )
    if (live.length) {
      for (const o of live) {
        const qty = +o.origQty || 0
        base += qty
        quote += qty * +o.price
      }
      continue
    }
    if (e.type === 'perc') {
      continue
    }
    const price = +(e.limitPrice ?? 0)
    if (e.asset === 'base') {
      base += +e.qty
      quote += +e.qty * price
    } else {
      base += price ? +e.qty / price : 0
      quote += +e.qty
    }
  }
  return { base, quote }
}
