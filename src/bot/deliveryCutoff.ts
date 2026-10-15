/**
 * Dated futures contracts (Bybit `BTCUSDT-25DEC26`, Binance `BTCUSDT_261225`,
 * KuCoin `XBTMZ26`, …) settle on their delivery time: the exchange closes every
 * open position at the settlement price. A deal still running then is closed
 * by the exchange, not by the bot, so the engine does not start one on a
 * contract that delivers soon.
 *
 * The delivery time is the exchange's own instrument field, carried by the
 * connector and stored on the `pairs` row as `deliveryTime` (ms epoch). It is
 * absent for perpetuals and spot — never inferred from the symbol's shape.
 */

/**
 * How close to delivery an automatic start is refused. Wide enough that an
 * ordinary DCA deal has room to run its course, narrow enough that a quarterly
 * contract stays tradable for nearly all of its life.
 */
export const DELIVERY_NEW_DEAL_CUTOFF_MS = 3 * 24 * 60 * 60 * 1000

/** A positive finite ms epoch, or `undefined` — never 0 for "perpetual". */
export const normalizeDeliveryTime = (raw: unknown): number | undefined => {
  if (raw === null || raw === undefined || raw === '') return undefined
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * The delivery time that refuses a new deal on this pair at `now`, or `null`
 * when the pair is not dated or delivers later than the cutoff. A contract
 * already past its delivery time is refused too (it stays listed briefly
 * before the pairs sync drops it).
 */
export const deliveryRefusingNewDeal = (
  info: { deliveryTime?: unknown } | undefined | null,
  now: number,
  cutoffMs = DELIVERY_NEW_DEAL_CUTOFF_MS,
): number | null => {
  const delivery = normalizeDeliveryTime(info?.deliveryTime)
  if (delivery === undefined) return null
  return delivery - now <= cutoffMs ? delivery : null
}

export const deliveryRefusalMessage = (pair: string, deliveryTime: number) =>
  `No new deal on ${pair}: the contract delivers on ${new Date(
    deliveryTime,
  ).toISOString()}, within ${Math.round(
    DELIVERY_NEW_DEAL_CUTOFF_MS / 86_400_000,
  )} days. A deal still open at delivery is settled by the exchange. Deals already open are not affected; a manual deal can still be opened.`
