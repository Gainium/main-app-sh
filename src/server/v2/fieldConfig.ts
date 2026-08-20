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
  'createdAt',
  'updatedAt',
] as const

/**
 * Extended fields for DCA bots - additional useful data
 */
export const DCA_BOT_EXTENDED_FIELDS = [
  ...DCA_BOT_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.stopLoss',
  'settings.trailingDeviation',
  'settings.maxSafetyTradesCount',
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
  'createdAt',
  'updatedAt',
] as const

/**
 * Extended fields for Combo bots
 */
export const COMBO_BOT_EXTENDED_FIELDS = [
  ...COMBO_BOT_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.stopLoss',
  'settings.trailingDeviation',
  'settings.maxSafetyTradesCount',
  'cost',
  'workingTimeNumber',
  'profitToday',
  'statusReason',
  'dealsStatsForBot',
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
  'settings.symbol',
  'profit.total',
  'profit.totalUsd',
  'levels.active',
  'levels.all',
  'createdAt',
  'updatedAt',
] as const

/**
 * Extended fields for Grid bots
 */
export const GRID_BOT_EXTENDED_FIELDS = [
  ...GRID_BOT_STANDARD_FIELDS,
  'settings.gridLevels',
  'settings.lowerPrice',
  'settings.upperPrice',
  'settings.gridType',
  'cost',
  'initialPrice',
  'avgPrice',
  'workingTimeNumber',
  'profitToday',
  'statusReason',
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
] as const

/**
 * Extended fields for DCA deals
 */
export const DCA_DEAL_EXTENDED_FIELDS = [
  ...DCA_DEAL_STANDARD_FIELDS,
  'settings.baseOrderSize',
  'settings.safetyOrderSize',
  'settings.maxSafetyTradesCount',
  'initialBalances',
  'currentBalances',
  'feePaid',
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
