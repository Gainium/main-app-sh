import { balanceDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'
import { priceBalancesUsd } from '../../utils/user'
import logger from '../../utils/logger'

import type { ClearUserSchema } from '../../../types'

export const getBalances = async (
  user: ClearUserSchema,
  shouldSumBalance = true,
  assets?: string[],
  uuid?: string,
  paperContext?: boolean,
  includeUsdValues = false,
) => {
  const userId = user._id.toString()
  const search: {
    userId: string
    exchangeUUID?: string
    asset?: { $in: string[] }
    $or: Array<Record<string, { $gt: number }>>
  } = {
    userId,
    $or: [{ free: { $gt: 0 } }, { locked: { $gt: 0 } }],
  }
  // A futures leg that shares its API key with a spot leg (OKX / Bybit
  // unified accounts) is `linkedTo` that spot leg: the balance refresher
  // skips linked legs and stores the shared pool ONLY under the source uuid,
  // and the bot engine resolves the link when it checks funds. Do the same
  // here — read the source uuid's rows, but tag them with the uuid the caller
  // asked for — or the bot form shows "BAL 0" for every linked futures leg
  // (the legacy dashboard resolved `linkedTo` client-side; the redesign
  // doesn't, and first surfaced on OKX Europe where the only futures leg is
  // linked). No-uuid / summed reads are unchanged.
  const linkedSourceUuid = uuid
    ? user.exchanges.find((e) => e.uuid === uuid)?.linkedTo
    : undefined
  if (uuid) {
    search.exchangeUUID = linkedSourceUuid || uuid
  }
  if (assets && assets.length > 0) {
    search.asset = { $in: assets }
  }
  const balance = await balanceDb.readData(
    { ...search, paperContext: paperContext ? { $eq: true } : { $ne: true } },
    undefined,
    {},
    true,
    true,
  )
  if (balance.status === StatusEnum.notok) {
    return balance
  }
  if (balance.data.count === 0) {
    return {
      status: StatusEnum.ok,
      reason: null,
      data: [],
    }
  }
  let final: typeof balance.data.result = []
  const userExchanges = user.exchanges.map((e) => e.uuid)
  const rows = balance.data.result.filter((b) =>
    userExchanges.includes(b.exchangeUUID),
  )
  // Opt-in: value each balance in USD server-side, via the same authoritative
  // per-venue path the portfolio snapshot cron and the public REST API already
  // use. The dashboard otherwise has to guess a price by matching the exchange
  // ticker against the screener's coin symbols, which silently yields $0.00 for
  // any holding the screener can't match (renamed coins — Toncoin is listed as
  // `gram` — and long-tail listings). Best-effort: a valuation failure must
  // leave the balances themselves intact.
  const usdMap = new Map<string, { price: number; usdValue: number }>()
  if (includeUsdValues && rows.length) {
    try {
      for (const [key, value] of await priceBalancesUsd(rows)) {
        usdMap.set(key, value)
      }
    } catch (e) {
      logger.error(`getBalances | usd valuation error: ${e}`)
    }
  }
  // `priceBalancesUsd` scores an asset it cannot price as 0 rather than
  // omitting it; keep only the rows it actually resolved a rate for, so a
  // delisted holding reports "no price" instead of a confident $0.00.
  const usdFor = (exchangeUUID: string | undefined, asset: string) => {
    const priced = usdMap.get(`${exchangeUUID ?? ''}:${asset}`)
    return priced && priced.price > 0 ? priced.usdValue : undefined
  }
  // Summed rows lose their exchangeUUID, so fold the per-venue USD values into
  // a per-asset total before the aggregation drops the key they're stored under.
  const usdByAsset = new Map<string, number>()
  for (const b of rows) {
    const value = usdFor(b.exchangeUUID, b.asset)
    if (value !== undefined) {
      usdByAsset.set(b.asset, (usdByAsset.get(b.asset) ?? 0) + value)
    }
  }
  if (shouldSumBalance) {
    rows.forEach((b) => {
      const find = final.find((f) => f.asset === b.asset)
      if (!find) {
        final.push(b)
      }
      if (find) {
        find.free += b.free
        find.locked += b.locked
        if (b.updated && (!find.updated || b.updated < find.updated)) {
          find.updated = b.updated
        }
        final = [...final.filter((f) => f.asset !== b.asset), find]
      }
    })
  } else {
    final = rows
  }
  return {
    status: StatusEnum.ok,
    reason: null,
    data: final.map((d) => {
      // Re-tag rows read through a `linkedTo` hop with the requested leg.
      const remap = !!uuid && !!linkedSourceUuid
      const outUuid = remap ? uuid : d.exchangeUUID
      const outExchange = remap
        ? (user.exchanges.find((e) => e.uuid === uuid)?.provider ??
          d.exchange)
        : d.exchange
      const total = d.free + d.locked
      const usdValue = shouldSumBalance
        ? usdByAsset.get(d.asset)
        : usdFor(d.exchangeUUID, d.asset)
      return {
        asset: d.asset,
        free: `${d.free}`,
        locked: `${d.locked}`,
        // When the row was last written by a stream event or a REST refresh.
        // For a summed asset this is the OLDEST of its rows, so the dashboard
        // staleness marker reflects the least fresh venue behind the figure.
        updated: d.updated ? new Date(d.updated).toISOString() : null,
        exchange: shouldSumBalance ? '' : outExchange,
        exchangeUUID: shouldSumBalance ? '' : outUuid,
        exchangeName: shouldSumBalance
          ? ''
          : user.exchanges.find((e) => e.uuid === outUuid)?.name ||
            outExchange,
        // Only present when the caller asked for them. `null` (not 0) when the
        // venue genuinely has no rate for the asset, so a consumer can tell
        // "worth nothing" apart from "we could not price this".
        ...(includeUsdValues
          ? {
              usdValue: usdValue === undefined ? null : `${usdValue}`,
              price:
                usdValue === undefined || total === 0
                  ? null
                  : `${usdValue / total}`,
            }
          : {}),
      }
    }),
  }
}
