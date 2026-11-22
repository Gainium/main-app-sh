/**
 * Bot Events "Type" filter conditions (pure — no DB client).
 *
 * The dashboard's Events tab filters by Orders / Deals / Errors / Warnings.
 * One type at a time fits the generic DataGrid filter mapping, but a union of
 * types (e.g. Orders + Errors) does not: that mapping joins every item with a
 * single `$and` or `$or`, and the union must be AND-ed with the time, pair and
 * search filters. `botEventTypesCond` returns that union as one `$or` group.
 */

/** Exact `event` names the bot engines write for order activity. */
export const BOT_EVENT_ORDER_NAMES = [
  'Order',
  'Order error',
  'Take Profit',
  'Stop Loss',
]

// Conditions are built fresh per call: query casting may rewrite a filter
// object in place, so a shared module-level object must never be handed out.

/** Error and warning events. */
export const botEventAlertsCond = () => ({
  type: { $in: ['error', 'warning'] },
})

/** Deal-tied events that are not alerts. */
export const botEventDealsCond = () => ({
  $and: [
    { deal: { $exists: true, $nin: [null, ''] } },
    { $nor: [botEventAlertsCond()] },
  ],
})

const TYPE_CONDS: Record<string, () => object> = {
  orders: () => ({ event: { $in: [...BOT_EVENT_ORDER_NAMES] } }),
  deals: botEventDealsCond,
  errors: () => ({ type: 'error' }),
  warnings: () => ({ type: 'warning' }),
}

const TYPE_ORDER = Object.keys(TYPE_CONDS)

/**
 * `$or` of the selected types, or `null` when nothing valid is selected
 * (= all types). Unknown values are ignored, duplicates collapse.
 */
export const botEventTypesCond = (
  types?: readonly string[] | null,
): { $or: object[] } | null => {
  if (!Array.isArray(types)) return null
  const selected = TYPE_ORDER.filter((t) => types.includes(t))
  return selected.length ? { $or: selected.map((t) => TYPE_CONDS[t]()) } : null
}
