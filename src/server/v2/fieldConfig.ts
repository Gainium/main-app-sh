/**
 * Field Selection Configuration for API v2.0
 *
 * Defines essential, standard, and all available fields for each endpoint type.
 * Used to reduce API payload size by returning only requested fields.
 */

/**
 * Essential fields for DCA bots - minimal data for list views
 */
export const DCA_BOT_ESSENTIAL_FIELDS = [
  '_id',
  'uuid',
  'settings.name',
  'status',
  'exchange',
  'exchangeUUID',
  'paperContext',
] as const

/**
 * Standard fields for DCA bots - commonly requested data
 */
export const DCA_BOT_STANDARD_FIELDS = [
  ...DCA_BOT_ESSENTIAL_FIELDS,
  'settings.pair',
  'profit.total',
  'profit.totalUsd',
  'deals.all',
  'deals.active',
  // A bot's timestamps are `created`/`updated` — not `createdAt`/`updatedAt`.
  'created',
  'updated',
] as const

/**
 * Extended fields for DCA bots - additional useful data
 *
 * Carries the stop loss, the trailing exits and the safety-order ladder, so
 * that reading a bot, adjusting a few values and creating the adjusted copy is
 * lossless. Each value travels with the boolean that arms it: anything omitted
 * here is silently replaced by `DCA_FORM_DEFAULTS` on the way back in (see
 * `botDefaults.ts`, and spec 062), which disarms the stop loss and the
 * trailing take profit rather than merely dropping a number.
 */
export const DCA_BOT_EXTENDED_FIELDS = [
  ...DCA_BOT_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.useSl',
  'settings.slPerc',
  'settings.trailingTp',
  'settings.trailingTpPerc',
  'settings.trailingSl',
  'settings.ordersCount',
  'settings.activeOrdersCount',
  'cost',
  'workingTimeNumber',
  'profitToday',
  'statusReason',
] as const

/**
 * Essential fields for Combo bots
 */
export const COMBO_BOT_ESSENTIAL_FIELDS = DCA_BOT_ESSENTIAL_FIELDS

/**
 * Standard fields for Combo bots
 */
export const COMBO_BOT_STANDARD_FIELDS = [
  ...COMBO_BOT_ESSENTIAL_FIELDS,
  'settings.pair',
  'profit.total',
  'profit.totalUsd',
  'deals.all',
  'deals.active',
  'created',
  'updated',
] as const

/**
 * Extended fields for Combo bots
 *
 * A combo bot stores `DCABotSettings`, so the same value+toggle pairs as
 * `DCA_BOT_EXTENDED_FIELDS` — see the note there.
 */
export const COMBO_BOT_EXTENDED_FIELDS = [
  ...COMBO_BOT_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.useSl',
  'settings.slPerc',
  'settings.trailingTp',
  'settings.trailingTpPerc',
  'settings.trailingSl',
  'settings.ordersCount',
  'settings.activeOrdersCount',
  'cost',
  'workingTimeNumber',
  'profitToday',
  'statusReason',
  'dealsStatsForBot',
] as const

/**
 * Essential fields for hedge bots (hedgeCombo / hedgeDca) - minimal list data.
 *
 * A hedge bot is a WRAPPER over two child bots, so its field set looks nothing
 * like the other three: there is no top-level `settings`, no `exchange`, and
 * its stored `profit` is a permanent zero (the engine only ever writes `status`
 * back to the wrapper). `name`, `profit`, `dealsInBot` and friends below are
 * therefore aggregated from the legs at read time — see
 * `core/src/bot/hedgeAggregate.ts`.
 */
export const HEDGE_BOT_ESSENTIAL_FIELDS = [
  '_id',
  'uuid',
  'name',
  'status',
  'paperContext',
] as const

/**
 * Standard fields for hedge bots
 */
export const HEDGE_BOT_STANDARD_FIELDS = [
  ...HEDGE_BOT_ESSENTIAL_FIELDS,
  'profit.total',
  'profit.totalUsd',
  'profitByAssets',
  'profitBasis',
  'dealsInBot.all',
  'dealsInBot.active',
  'created',
  'updated',
] as const

/**
 * Extended fields for hedge bots
 */
export const HEDGE_BOT_EXTENDED_FIELDS = [
  ...HEDGE_BOT_STANDARD_FIELDS,
  'sharedSettings',
  'unrealizedProfit',
  'profitToday',
  'workingTimeNumber',
  'cost',
  'statusReason',
  'flags',
  'symbol',
  'bots',
] as const

/**
 * Essential fields for Grid bots
 */
export const GRID_BOT_ESSENTIAL_FIELDS = [
  '_id',
  'uuid',
  'settings.name',
  'status',
  'exchange',
  'exchangeUUID',
  'paperContext',
] as const

/**
 * Standard fields for Grid bots
 */
export const GRID_BOT_STANDARD_FIELDS = [
  ...GRID_BOT_ESSENTIAL_FIELDS,
  // The pair as `POST /api/v2/bots/grid` takes it back, plus the stored
  // base/quote breakdown. A grid bot has no `settings.symbol`, and its
  // timestamps are `created`/`updated` — not `createdAt`/`updatedAt`.
  'settings.pair',
  'symbol',
  'profit.total',
  'profit.totalUsd',
  'levels.active',
  'levels.all',
  'created',
  'updated',
] as const

/**
 * Extended fields for Grid bots
 *
 * Carries the whole grid definition — range, level count and the take
 * profit / stop loss configuration — so that reading a bot, adjusting a few
 * values and creating the adjusted copy is lossless. Anything omitted here is
 * silently replaced by `GRID_FORM_DEFAULTS` on the way back in (see
 * `botDefaults.ts`, and spec 061).
 */
export const GRID_BOT_EXTENDED_FIELDS = [
  ...GRID_BOT_STANDARD_FIELDS,
  'settings.levels',
  'settings.lowPrice',
  'settings.topPrice',
  'settings.gridType',
  'settings.tpSl',
  'settings.tpSlCondition',
  'settings.tpSlAction',
  'settings.sl',
  'settings.slCondition',
  'settings.slAction',
  // The one path the `bots.dca` preset resolved on a grid bot, and so the one
  // a grid caller receives today: reading grid bots with their own preset
  // (spec 063) must not take it away.
  'settings.slPerc',
  'cost',
  'initialPrice',
  'avgPrice',
  'workingTimeNumber',
  'profitToday',
  'statusReason',
  'flags',
  'feePaid',
  'feeByAsset',
] as const

/**
 * Essential fields for DCA deals
 */
export const DCA_DEAL_ESSENTIAL_FIELDS = [
  '_id',
  'botId',
  'status',
  'symbol.symbol',
  'profit.total',
  'profit.totalUsd',
  'createTime',
] as const

/**
 * Standard fields for DCA deals
 */
export const DCA_DEAL_STANDARD_FIELDS = [
  ...DCA_DEAL_ESSENTIAL_FIELDS,
  'exchange',
  'exchangeUUID',
  'paperContext',
  'avgPrice',
  'lastPrice',
  'levels.all',
  'levels.complete',
  'cost',
  'value',
  'updateTime',
  'closeTime',
  // Why a deal that exists has never opened (venue refused its opening order).
  // Standard rather than essential: additive for API consumers on the default
  // preset, and the people who most need it are the ones polling a deal after
  // an automation opened it.
  'startBlocked',
  // A trailing take-profit close the exchange refused, and the retry or pause
  // that followed (spec 050). Standard for the same reason as `startBlocked`:
  // a caller polling a deal needs to know a profitable exit was attempted and
  // could not be executed, because while it is `paused` nothing will try
  // again until price returns to the take profit.
  'trailingClose',
] as const

/**
 * Extended fields for DCA deals
 *
 * A deal's `settings` is the snapshot of the bot settings taken when it
 * opened, so it uses the bot's own names — the safety order size is
 * `orderSize` and the safety trade count is `ordersCount` (spec 062).
 */
export const DCA_DEAL_EXTENDED_FIELDS = [
  ...DCA_DEAL_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.orderSize',
  'settings.ordersCount',
  'initialBalances',
  'currentBalances',
  'feePaid',
  'feeByAsset',
  'usage',
  'stats',
  'strategy',
] as const

/**
 * Essential fields for Combo deals
 */
export const COMBO_DEAL_ESSENTIAL_FIELDS = DCA_DEAL_ESSENTIAL_FIELDS

/**
 * Standard fields for Combo deals
 */
export const COMBO_DEAL_STANDARD_FIELDS = DCA_DEAL_STANDARD_FIELDS

/**
 * Extended fields for Combo deals
 */
export const COMBO_DEAL_EXTENDED_FIELDS = DCA_DEAL_EXTENDED_FIELDS

/**
 * Essential fields for balances
 */
export const BALANCE_ESSENTIAL_FIELDS = [
  'asset',
  'free',
  'locked',
  'exchangeUUID',
] as const

/**
 * Standard fields for balances
 */
export const BALANCE_STANDARD_FIELDS = [
  ...BALANCE_ESSENTIAL_FIELDS,
  'exchange',
  'paperContext',
] as const

/**
 * Essential fields for exchanges
 */
export const EXCHANGE_ESSENTIAL_FIELDS = [
  'code',
  'market',
  'id',
  'name',
] as const

/**
 * Standard fields for exchanges
 */
export const EXCHANGE_STANDARD_FIELDS = [
  ...EXCHANGE_ESSENTIAL_FIELDS,
  'type',
] as const

/**
 * Essential fields for screener
 */
export const SCREENER_ESSENTIAL_FIELDS = [
  'symbol',
  'name',
  'currentPrice',
  'priceChangePercentage24h',
  'totalVolume',
  'marketCap',
  'marketCapRank',
] as const

/**
 * Standard fields for screener
 */
export const SCREENER_STANDARD_FIELDS = [
  ...SCREENER_ESSENTIAL_FIELDS,
  'priceChangePercentage1h',
  'priceChangePercentage7d',
  'volumeChange24h',
  'marketCapChangePercentage24h',
  'volatility1d',
  'liquidityScore',
  'category',
] as const

/**
 * Extended fields for screener
 */
export const SCREENER_EXTENDED_FIELDS = [
  ...SCREENER_STANDARD_FIELDS,
  'priceChangePercentage30d',
  'priceChangePercentage1y',
  'atlChangePercentage',
  'athChangePercentage',
  'volatility3d',
  'volatility7d',
  'exchanges',
  'sparkline',
] as const

/**
 * Essential fields for backtest requests
 */
export const BACKTEST_REQUEST_ESSENTIAL_FIELDS = [
  '_id',
  'status',
  'type',
  'exchange',
  'symbols',
  'created',
] as const

/**
 * Standard fields for backtest requests
 */
export const BACKTEST_REQUEST_STANDARD_FIELDS = [
  ...BACKTEST_REQUEST_ESSENTIAL_FIELDS,
  'exchangeUUID',
  'cost',
  'backtestId',
  'statusReason',
  'updated',
] as const

/**
 * Extended fields for backtest requests (includes full payload and history)
 */
export const BACKTEST_REQUEST_EXTENDED_FIELDS = [
  ...BACKTEST_REQUEST_STANDARD_FIELDS,
  'statusHistory',
  'payload',
] as const

/**
 * Field presets for easy selection
 */
export const FIELD_PRESETS = {
  minimal: 'minimal',
  standard: 'standard',
  extended: 'extended',
  full: 'full',
} as const

export type FieldPreset = (typeof FIELD_PRESETS)[keyof typeof FIELD_PRESETS]

/**
 * Map of endpoint types to their field configurations
 */
export const ENDPOINT_FIELD_CONFIG = {
  'bots.dca': {
    minimal: DCA_BOT_ESSENTIAL_FIELDS,
    standard: DCA_BOT_STANDARD_FIELDS,
    extended: DCA_BOT_EXTENDED_FIELDS,
  },
  'bots.combo': {
    minimal: COMBO_BOT_ESSENTIAL_FIELDS,
    standard: COMBO_BOT_STANDARD_FIELDS,
    extended: COMBO_BOT_EXTENDED_FIELDS,
  },
  'bots.grid': {
    minimal: GRID_BOT_ESSENTIAL_FIELDS,
    standard: GRID_BOT_STANDARD_FIELDS,
    extended: GRID_BOT_EXTENDED_FIELDS,
  },
  // Both hedge bot types share one config: the wrapper document is identical
  // for hedgeCombo and hedgeDca, only its legs differ (combo vs dca bots).
  'bots.hedgeCombo': {
    minimal: HEDGE_BOT_ESSENTIAL_FIELDS,
    standard: HEDGE_BOT_STANDARD_FIELDS,
    extended: HEDGE_BOT_EXTENDED_FIELDS,
  },
  'bots.hedgeDca': {
    minimal: HEDGE_BOT_ESSENTIAL_FIELDS,
    standard: HEDGE_BOT_STANDARD_FIELDS,
    extended: HEDGE_BOT_EXTENDED_FIELDS,
  },
  'deals.dca': {
    minimal: DCA_DEAL_ESSENTIAL_FIELDS,
    standard: DCA_DEAL_STANDARD_FIELDS,
    extended: DCA_DEAL_EXTENDED_FIELDS,
  },
  'deals.combo': {
    minimal: COMBO_DEAL_ESSENTIAL_FIELDS,
    standard: COMBO_DEAL_STANDARD_FIELDS,
    extended: COMBO_DEAL_EXTENDED_FIELDS,
  },
  balances: {
    minimal: BALANCE_ESSENTIAL_FIELDS,
    standard: BALANCE_STANDARD_FIELDS,
  },
  exchanges: {
    minimal: EXCHANGE_ESSENTIAL_FIELDS,
    standard: EXCHANGE_STANDARD_FIELDS,
  },
  screener: {
    minimal: SCREENER_ESSENTIAL_FIELDS,
    standard: SCREENER_STANDARD_FIELDS,
    extended: SCREENER_EXTENDED_FIELDS,
  },
  'backtest.requests': {
    minimal: BACKTEST_REQUEST_ESSENTIAL_FIELDS,
    standard: BACKTEST_REQUEST_STANDARD_FIELDS,
    extended: BACKTEST_REQUEST_EXTENDED_FIELDS,
  },
} as const

export type EndpointType = keyof typeof ENDPOINT_FIELD_CONFIG

/**
 * The bot field config a `:botType` path segment selects.
 *
 * The bot routes that take the type as a path parameter cannot bind a preset
 * when they register — the type is only known per request — so they resolve it
 * here instead. Each type has its own config and they are not
 * interchangeable: `bots.grid` and `bots.dca` differ by 28 paths at
 * `extended`, and a bot read with another type's preset simply loses every
 * path that preset does not name (spec 063).
 */
export const BOT_TYPE_ENDPOINT = {
  dca: 'bots.dca',
  combo: 'bots.combo',
  grid: 'bots.grid',
  hedgeCombo: 'bots.hedgeCombo',
  hedgeDca: 'bots.hedgeDca',
} as const satisfies Record<string, EndpointType>

/**
 * Field config for a bot type, by its `:botType` path segment.
 *
 * Total: an unrecognised segment resolves to `bots.dca`, which is what every
 * bot type resolved to before spec 063. The bot routes reject anything outside
 * `ALL_BOT_TYPES` with a 400 before asking, so the fallback never widens a
 * response — it only keeps the helper safe to call.
 */
export function endpointForBotType(botType: string): EndpointType {
  return (
    BOT_TYPE_ENDPOINT[botType as keyof typeof BOT_TYPE_ENDPOINT] ?? 'bots.dca'
  )
}

/**
 * Get field configuration for an endpoint
 */
export function getFieldConfig(
  endpoint: EndpointType,
  preset: FieldPreset = 'minimal',
) {
  if (preset === 'full') {
    return null // return all fields
  }

  const config = ENDPOINT_FIELD_CONFIG[endpoint]
  return config[preset as keyof typeof config] || config.minimal
}
