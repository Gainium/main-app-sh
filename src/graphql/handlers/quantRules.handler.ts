import { StatusEnum } from '../../../types'
import { quantRulesEventDb } from '../../db/dbInit'

/**
 * Active Binance Futures Quantitative Rules (-4400) cooldowns for a user.
 *
 * Reads `quantrulesevents` where the cooldown has not yet expired (`until` in
 * the future), keeping only the newest row per (exchangeUUID, symbol||'account')
 * so an escalated window supersedes the one it replaced. Sorted by `until` desc
 * (soonest-to-expire last). Shapes the platform-standard {status, data} envelope
 * the dashboard consumes.
 */
export const getQuantRulesStatus = async (userId: string) => {
  const now = new Date()
  const result = await quantRulesEventDb.readData(
    { userId, until: { $gt: now } },
    undefined,
    { sort: { until: -1 } },
    true,
  )
  if (result.status === StatusEnum.notok) {
    return result
  }
  const rows = result.data.result ?? []
  // Newest-per-key: rows already sorted by `until` desc, so the first occurrence
  // of a key is the most future-reaching (latest) cooldown for it.
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const key = `${row.exchangeUUID}:${row.symbol ?? 'account'}`
    if (!byKey.has(key)) {
      byKey.set(key, row)
    }
  }
  const data = [...byKey.values()]
    .map((row) => ({
      exchangeUUID: row.exchangeUUID,
      exchange: row.exchange,
      symbol: row.symbol,
      scope: row.scope,
      level: row.level,
      until: row.until ? new Date(row.until).toISOString() : null,
      violationCount24h: row.violationCount24h,
    }))
    .sort((a, b) => (b.until ?? '').localeCompare(a.until ?? ''))
  return {
    status: StatusEnum.ok,
    data,
  }
}
