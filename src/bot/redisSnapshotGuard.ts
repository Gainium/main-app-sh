/**
 * The Redis `botData` snapshot is written with `JSON.stringify`, and
 * `JSON.stringify(NaN)` is `null`. Mongo refuses a NaN on the same write, so
 * when a bot's running profit goes non-finite the database keeps its last good
 * figure while the snapshot silently records `null`.
 *
 * A cold restart prefers that snapshot. Restoring it seeds `profit: null`, and
 * the next deal close computes `null + dealProfit === dealProfit` — the bot
 * aggregate restarts from zero and every earlier realized profit is gone, then
 * written back over the good database copy.
 *
 * The profit total is never legitimately non-finite (Mongo cannot hold one),
 * so a snapshot carrying one is poisoned and must not be restored.
 *
 * @returns the dotted path of the first non-finite profit figure, or `null`
 * when the snapshot is safe to restore.
 */
export const poisonedSnapshotProfitField = (
  snapshot: { profit?: Record<string, unknown> | null } | null | undefined,
): string | null => {
  const profit = snapshot?.profit
  if (!profit) {
    return null
  }
  for (const key of ['total', 'totalUsd'] as const) {
    if (key in profit && !Number.isFinite(profit[key])) {
      return `profit.${key}`
    }
  }
  return null
}
