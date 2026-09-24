#!/usr/bin/env ts-node
/**
 * OpenAPI Schema Generator from TypeScript Types
 *
 * This script parses TypeScript type definitions and generates OpenAPI 3.1 schemas.
 * It ensures the OpenAPI documentation stays in sync with the actual TypeScript types.
 *
 * Usage:
 *   npm run generate:schemas
 *   or
 *   ts-node src/utils/generate-openapi-schemas.ts
 */

import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { findEnumExampleMismatches } from './openapiEnumExamples'

interface EnumInfo {
  name: string
  values: string[]
}

interface PropertyInfo {
  name: string
  type: string
  required: boolean
  nullable: boolean
  description?: string
  enum?: string[]
  items?: any
  properties?: Record<string, any>
}

interface TypeInfo {
  name: string
  extends?: string
  properties: PropertyInfo[]
  description?: string
}

// Type to OpenAPI type mapping
const typeMapping: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
}

// Field metadata: descriptions and examples
const fieldMetadata: Record<string, { description: string; example?: any }> = {
  // Bot identification
  pair: { description: 'Trading pair symbol', example: 'BTC/USDT' },

  // Strategy settings
  strategy: {
    description: 'Trading strategy direction (long or short)',
    example: 'LONG',
  },
  futuresStrategy: { description: 'Futures trading strategy', example: 'LONG' },

  // Order settings
  startOrderType: {
    description: 'Order type for opening position',
    example: 'MARKET',
  },
  closeOrderType: {
    description: 'Order type for closing position',
    example: 'LIMIT',
  },
  orderSize: { description: 'Size of each order', example: '100' },
  orderSizeType: {
    description: 'Order reference',
    example: 'quote',
  },
  baseOrderSize: {
    description: 'Size of the initial base order',
    example: '100',
  },
  baseOrderPrice: { description: 'Price for the base order', example: '50000' },

  // Take Profit / Stop Loss
  tpPerc: { description: 'Take profit percentage', example: '2.5' },
  slPerc: { description: 'Stop loss percentage', example: '1.5' },
  useTp: { description: 'Enable take profit', example: true },
  useSl: { description: 'Enable stop loss', example: true },
  useMinTP: { description: 'Use minimum take profit', example: false },
  minTp: { description: 'Minimum take profit value', example: '1.0' },

  // Multi TP/SL
  useMultiTp: {
    description: 'Enable multiple take profit levels',
    example: false,
  },
  multiTp: { description: 'Array of take profit targets', example: [] },
  useMultiSl: {
    description: 'Enable multiple stop loss levels',
    example: false,
  },
  multiSl: { description: 'Array of stop loss targets', example: [] },

  // DCA settings
  useDca: { description: 'Enable Dollar Cost Averaging', example: true },
  dcaCondition: {
    description: 'Condition for DCA orders',
    example: 'percentage',
  },
  step: { description: 'Price deviation % for next DCA order', example: '1.5' },
  ordersCount: { description: 'Maximum number of DCA orders', example: 5 },
  activeOrdersCount: {
    description: 'Number of active orders to maintain',
    example: 3,
  },
  volumeScale: {
    description: 'Volume multiplier for each DCA order',
    example: '1.5',
  },
  stepScale: {
    description: 'Step multiplier for each DCA order',
    example: '1.2',
  },
  minimumDeviation: {
    description: 'Minimum price deviation to trigger DCA',
    example: '0.5',
  },
  dcaCustom: { description: 'Custom DCA configuration array', example: [] },
  baseSlOn: {
    description: 'Stop loss based on start or average price',
    example: 'avg',
  },
  dcaVolumeBaseOn: {
    description: 'How DCA volume is calculated',
    example: 'scale',
  },
  dcaVolumeRequiredChange: {
    description: 'Required change for volume adjustment',
    example: '10',
  },
  dcaVolumeMaxValue: { description: 'Maximum volume value', example: '1000' },
  dcaVolumeRequiredChangeRef: {
    description: 'Reference for volume change (TP or average)',
    example: 'tp',
  },
  dcaByMarket: {
    description: 'Execute DCA orders at market price',
    example: false,
  },
  allowRaiseToExchangeMin: {
    description:
      'Raise base/safety orders to the exchange minimum when the configured size is below it. When false (default), a deal whose orders would be raised is not opened on that pair and a notification is sent',
    example: false,
  },
  reduceToAvailableBalance: {
    description:
      'When the free balance cannot fund the whole deal (base order plus all safety orders), open it scaled down to the available balance instead of skipping it. Base and safety orders shrink by the same ratio. Fixed order sizes (base, quote, usd) only',
    example: false,
  },
  reduceToAvailableMinSize: {
    description:
      'Smallest base order a reduced deal may open with, in the base order size unit. Below it the deal is skipped. Empty or 0: no floor beyond the exchange minimum',
    example: '20',
  },

  // Start conditions
  startCondition: {
    description: 'Condition to start a new deal',
    example: 'ASAP',
  },
  botStart: { description: 'How the bot is started', example: 'manual' },
  botActualStart: {
    description: 'Actual trigger for bot start',
    example: 'indicators',
  },
  type: { description: 'Bot or indicator type', example: 'regular' },

  // Deal management
  maxNumberOfOpenDeals: {
    description: 'Maximum concurrent open deals',
    example: '3',
  },
  maxOpenDeal: { description: 'Maximum price to open deals', example: '5' },
  minOpenDeal: { description: 'Minimum price to open deals', example: '1' },
  useMulti: { description: 'Enable multiple pairs trading', example: false },
  maxDealsPerPair: { description: 'Max deals per trading pair', example: '2' },
  ignoreStartDeals: {
    description: 'Ignore deals in start condition check',
    example: false,
  },
  useNoOverlapDeals: {
    description: 'Prevent overlapping deals',
    example: false,
  },

  // Grid settings
  topPrice: { description: 'Top price of grid range', example: 55000 },
  lowPrice: { description: 'Bottom price of grid range', example: 45000 },
  levels: { description: 'Number of grid levels', example: 10 },
  gridStep: { description: 'Step between grid levels', example: 1000 },
  gridLevel: { description: 'Current grid level', example: '5' },
  baseStep: { description: 'Base step for grid', example: '1.0' },
  baseGridLevels: { description: 'Base number of grid levels', example: '10' },

  // Combo bot settings
  comboTpBase: {
    description: 'Base for combo TP calculation',
    example: 'full',
  },
  useActiveMinigrids: {
    description: 'Enable active minigrids',
    example: false,
  },
  comboActiveMinigrids: {
    description: 'Number of active minigrids',
    example: '3',
  },
  comboSlLimit: {
    description: 'Use limit orders for combo SL',
    example: false,
  },
  comboTpLimit: {
    description: 'Use limit orders for combo TP',
    example: false,
  },
  comboUseSmartGrids: {
    description: 'Enable smart grids for combo bot',
    example: false,
  },
  comboSmartGridsCount: { description: 'Number of smart grids', example: '5' },

  // Budget and size
  budget: { description: 'Total budget allocated to bot', example: 10000 },
  updatedBudget: { description: 'Budget has been updated', example: false },

  // Cooldown settings
  cooldownAfterDealStart: {
    description: 'Enable cooldown after deal starts',
    example: false,
  },
  cooldownAfterDealStartInterval: {
    description: 'Cooldown interval value',
    example: 60,
  },
  cooldownAfterDealStartUnits: {
    description: 'Time units for cooldown',
    example: 'minutes',
  },
  cooldownAfterDealStartOption: {
    description: 'Apply cooldown per symbol or bot',
    example: 'symbol',
  },
  cooldownAfterDealStop: {
    description: 'Enable cooldown after deal stops',
    example: false,
  },
  cooldownAfterDealStopInterval: {
    description: 'Stop cooldown interval',
    example: 30,
  },
  cooldownAfterDealStopUnits: {
    description: 'Time units for stop cooldown',
    example: 'minutes',
  },
  cooldownAfterDealStopOption: {
    description: 'Apply stop cooldown per symbol or bot',
    example: 'bot',
  },
  useCooldown: { description: 'Enable cooldown feature', example: false },

  // Trailing
  trailingSl: { description: 'Enable trailing stop loss', example: false },
  trailingTp: { description: 'Enable trailing take profit', example: false },
  trailingTpPerc: {
    description: 'Trailing take profit percentage',
    example: '1.5',
  },

  // Moving stop loss
  moveSL: { description: 'Enable moving stop loss', example: false },
  moveSLTrigger: { description: 'Trigger value for moving SL', example: '2.0' },
  moveSLValue: { description: 'New SL value when triggered', example: '0.5' },
  moveSLForAll: {
    description: 'Apply moving SL to all orders',
    example: false,
  },

  // Close after X conditions
  useCloseAfterX: {
    description: 'Enable close after X feature',
    example: false,
  },
  closeAfterX: { description: 'Close after X value', example: '10' },
  useCloseAfterXwin: { description: 'Close after X wins', example: false },
  closeAfterXwin: {
    description: 'Number of wins before closing',
    example: '5',
  },
  useCloseAfterXloss: { description: 'Close after X losses', example: false },
  closeAfterXloss: {
    description: 'Number of losses before closing',
    example: '3',
  },
  useCloseAfterXprofit: {
    description: 'Close after reaching profit',
    example: false,
  },
  closeAfterXprofitValue: {
    description: 'Profit value to trigger close',
    example: '1000',
  },
  closeAfterXprofitCond: {
    description: 'Condition for profit close',
    example: 'gt',
  },
  useCloseAfterXopen: {
    description: 'Close after X open deals',
    example: false,
  },
  closeAfterXopen: {
    description: 'Number of open deals before closing',
    example: '10',
  },

  // Timer
  closeByTimer: { description: 'Enable close by timer', example: false },
  closeByTimerValue: { description: 'Time value before closing', example: 24 },
  closeByTimerUnits: { description: 'Time units for timer', example: 'hours' },
  hodlDay: { description: 'Days between opening new deal', example: '7' },
  hodlAt: { description: 'Time to open new deal', example: '23:59' },
  hodlHourly: { description: 'Hold on hourly basis', example: false },
  hodlNextBuy: { description: 'Next buy time in hours', example: 24 },

  // Indicators
  indicators: { description: 'Array of technical indicators', example: [] },
  indicatorGroups: {
    description: 'Groups of indicator conditions',
    example: [],
  },
  useSmartOrders: {
    description: 'Enable smart order execution',
    example: false,
  },
  useBotController: { description: 'Enable bot controller', example: false },

  // Filters
  useVolumeFilter: { description: 'Filter pairs by volume', example: false },
  volumeTop: { description: 'Top volume threshold', example: '100' },
  volumeValue: { description: 'Volume filter value', example: 'top100' },
  useRelativeVolumeFilter: {
    description: 'Filter by relative volume',
    example: false,
  },
  relativeVolumeTop: {
    description: 'Relative volume threshold',
    example: '50',
  },
  relativeVolumeValue: {
    description: 'Relative volume filter value',
    example: 'top100',
  },
  useVolumeFilterAll: {
    description: 'Apply volume filter to all pairs',
    example: false,
  },
  useStaticPriceFilter: {
    description: 'Enable static price filter',
    example: false,
  },
  useDynamicPriceFilter: {
    description: 'Enable dynamic price filter',
    example: false,
  },
  dynamicPriceFilterDeviation: {
    description: 'Deviation for dynamic price filter',
    example: '5.0',
  },
  dynamicPriceFilterOverValue: {
    description: 'Over value for price filter',
    example: '10',
  },
  dynamicPriceFilterUnderValue: {
    description: 'Under value for price filter',
    example: '10',
  },
  dynamicPriceFilterPriceType: {
    description: 'Price type for filter (avg/entry)',
    example: 'avg',
  },
  dynamicPriceFilterDirection: {
    description: 'Filter direction',
    example: 'overAndUnder',
  },

  // Risk management
  useRiskReward: { description: 'Enable risk/reward ratio', example: false },
  rrSlType: { description: 'Type of risk/reward stop loss', example: 'fixed' },
  rrSlFixedValue: {
    description: 'Fixed SL value for risk/reward',
    example: '2.0',
  },
  riskSlType: { description: 'Risk stop loss type', example: 'perc' },
  riskSlAmountPerc: {
    description: 'Risk amount as percentage',
    example: '2.0',
  },
  riskSlAmountValue: { description: 'Risk amount value', example: '100' },
  riskUseTpRatio: {
    description: 'Use TP ratio in risk management',
    example: false,
  },
  riskTpRatio: { description: 'Take profit ratio', example: '2.0' },
  riskMinPositionSize: { description: 'Minimum position size', example: '50' },
  riskMaxPositionSize: {
    description: 'Maximum position size',
    example: '5000',
  },
  riskMaxSl: { description: 'Maximum stop loss', example: '5.0' },
  riskMinSl: { description: 'Minimum stop loss', example: '0.5' },
  useRiskReduction: { description: 'Enable risk reduction', example: false },
  riskReductionValue: {
    description: 'Risk reduction percentage',
    example: '10',
  },

  // Reinvest
  useReinvest: { description: 'Enable profit reinvestment', example: false },
  reinvestValue: {
    description: 'Percentage of profit to reinvest',
    example: '50',
  },

  // Price conditions
  startBotPriceCondition: {
    description: 'Price condition to start bot',
    example: 'gt',
  },
  startBotPriceValue: {
    description: 'Price value for bot start',
    example: '50000',
  },
  stopBotPriceCondition: {
    description: 'Price condition to stop bot',
    example: 'lt',
  },
  stopBotPriceValue: {
    description: 'Price value for bot stop',
    example: '45000',
  },
  useStartPrice: { description: 'Use custom start price', example: false },
  startPrice: { description: 'Custom start price', example: '50000' },

  // Logic operators
  startDealLogic: {
    description: 'Logic for start deal conditions (AND/OR)',
    example: 'and',
  },
  stopDealLogic: {
    description: 'Logic for stop deal conditions',
    example: 'or',
  },
  stopDealSlLogic: {
    description: 'Logic for stop loss conditions',
    example: 'and',
  },
  stopBotLogic: { description: 'Logic for stop bot conditions', example: 'or' },
  startBotLogic: {
    description: 'Logic for start bot conditions',
    example: 'and',
  },

  // Status and control
  stopType: { description: 'How to stop the bot', example: 'cancel' },
  stopStatus: {
    description: 'Bot status for stopping',
    example: 'closed',
  },
  dealCloseCondition: {
    description: 'Condition for closing deal',
    example: 'tp',
  },
  dealCloseConditionSL: {
    description: 'Condition for SL close',
    example: 'tp',
  },
  closeDealType: {
    description: 'Type of deal close action',
    example: 'closeByLimit',
  },
  terminalDealType: {
    description: 'Terminal deal handling type',
    example: 'smart',
  },

  // Prioritization
  pairPrioritization: {
    description: 'How pairs are prioritized',
    example: 'alphabetical',
  },
  prioritize: { description: 'Prioritization settings', example: 'gridStep' },

  // Futures specific
  futures: { description: 'Enable futures trading', example: false },
  marginType: { description: 'Margin type for futures', example: 'cross' },
  leverage: { description: 'Leverage multiplier', example: 10 },
  coinm: { description: 'Coin-margined futures', example: false },

  // Advanced features
  scaleDcaType: { description: 'Type of DCA scaling', example: 'percentage' },
  dynamicArLockValue: { description: 'Lock dynamic AR value', example: false },
  useFixedTPPrices: { description: 'Use fixed TP prices', example: false },
  fixedTpPrice: { description: 'Fixed take profit price', example: '55000' },
  useFixedSLPrices: { description: 'Use fixed SL prices', example: false },
  fixedSlPrice: { description: 'Fixed stop loss price', example: '48000' },
  maxDealsPerHigherTimeframe: {
    description: 'Max deals per timeframe',
    example: '5',
  },
  useMaxDealsPerHigherTimeframe: {
    description: 'Enable max deals per timeframe',
    example: false,
  },
  remainderFullAmount: {
    description: 'Use full amount for remainder',
    example: false,
  },
  autoRebalancing: {
    description: 'Enable automatic rebalancing',
    example: false,
  },
  adaptiveClose: { description: 'Use adaptive close strategy', example: false },

  // Deal over/under separation
  useSeparateMaxDealsOverAndUnder: {
    description: 'Separate limits for over/under deals',
    example: false,
  },
  maxDealsOver: { description: 'Max deals above entry', example: '3' },
  maxDealsUnder: { description: 'Max deals below entry', example: '5' },
  useSeparateMaxDealsOverAndUnderPerSymbol: {
    description: 'Per-symbol over/under limits',
    example: false,
  },
  maxDealsOverPerSymbol: {
    description: 'Max over deals per symbol',
    example: '2',
  },
  maxDealsUnderPerSymbol: {
    description: 'Max under deals per symbol',
    example: '3',
  },

  // Limit orders
  useLimitPrice: { description: 'Use limit price for orders', example: false },
  limitTimeout: {
    description: 'Timeout for limit orders (seconds)',
    example: '300',
  },
  useLimitTimeout: {
    description: 'Enable limit order timeout',
    example: false,
  },
  notUseLimitReposition: {
    description: 'Disable limit order repositioning',
    example: false,
  },
  slLimit: { description: 'Use limit orders for stop loss', example: false },
  tpSlLimit: { description: 'Use limit orders for TP/SL', example: false },

  // Fees and balance
  feeOrder: { description: 'Include fees in order calculation', example: true },
  skipBalanceCheck: {
    description: 'Skip balance verification',
    example: false,
  },
  newBalance: { description: 'New balance mode', example: false },
  newProfit: { description: 'New profit calculation', example: false },

  // Import and other
  importFrom: {
    description: 'Import settings from bot ID',
    example: 'bot-123',
  },

  // Grid specific
  sellDisplacement: {
    description: 'Displacement for sell orders',
    example: 0.5,
  },
  gridType: { description: 'Type of grid', example: 'arithmetic' },
  ordersInAdvance: { description: 'Orders to place in advance', example: 5 },
  useOrderInAdvance: {
    description: 'Enable advance order placement',
    example: true,
  },
  tpSl: { description: 'Combined TP/SL for grid', example: false },
  tpSlCondition: {
    description: 'Condition for TP/SL trigger',
    example: 'priceReached',
  },
  tpSlAction: { description: 'Action for TP/SL', example: 'stop' },
  sl: { description: 'Enable stop loss for grid', example: false },
  slCondition: {
    description: 'Stop loss trigger condition',
    example: 'priceReached',
  },
  slAction: { description: 'Stop loss action', example: 'stop' },
  tpTopPrice: { description: 'Take profit top price', example: 60000 },
  slLowPrice: { description: 'Stop loss bottom price', example: 40000 },
  lastPriceRangeAlert: {
    description: 'Alert when price near range',
    example: 5,
  },

  // Indicator specific fields
  indicatorLength: { description: 'Indicator period length', example: 14 },
  indicatorValue: { description: 'Indicator value threshold', example: '70' },
  indicatorCondition: { description: 'Comparison condition', example: 'gt' },
  indicatorInterval: { description: 'Chart timeframe', example: '1h' },
  groupId: { description: 'Indicator group ID', example: 'group-1' },
  uuid: {
    description: 'Unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  },
  signal: { description: 'Trading signal type', example: 'strongBuy' },
  condition: { description: 'Check condition timing', example: 'entry' },
  checkLevel: { description: 'Level to check indicator', example: 1 },
  indicatorAction: {
    description: 'Action triggered by indicator',
    example: 'startDeal',
  },
  section: {
    description: 'Settings section (tp/sl/dca/controller)',
    example: 'sl',
  },

  // MA specific
  maType: { description: 'Moving average type', example: 'ema' },
  maCrossingValue: { description: 'MA crossing reference', example: 'sma' },
  maCrossingLength: { description: 'Crossing MA length', example: 50 },
  maCrossingInterval: { description: 'Crossing MA timeframe', example: '4h' },
  maUUID: { description: 'MA indicator UUID reference', example: '123e4567' },

  // BB specific
  bbCrossingValue: {
    description: 'Bollinger Band line to cross',
    example: 'upper',
  },
  bbwMult: { description: 'Bollinger Band width multiplier', example: 2 },
  bbwMa: { description: 'BB moving average type', example: 'sma' },
  bbwMaLength: { description: 'BB MA length', example: 20 },

  // Stochastic
  stochSmoothK: { description: 'Stochastic K smoothing', example: 3 },
  stochSmoothD: { description: 'Stochastic D smoothing', example: 3 },
  stochUpper: { description: 'Stochastic overbought level', example: '80' },
  stochLower: { description: 'Stochastic oversold level', example: '20' },
  stochRSI: { description: 'Stochastic RSI period', example: 14 },
  stochRange: { description: 'Stochastic range to check', example: 'upper' },
  rsiValue: { description: 'RSI value (K or D line)', example: 'k' },
  rsiValue2: { description: 'Second RSI value', example: 'd' },

  // Support/Resistance
  valueInsteadof: {
    description: 'Custom value instead of price',
    example: 50000,
  },
  leftBars: { description: 'Bars to check on left', example: 5 },
  rightBars: { description: 'Bars to check on right', example: 5 },
  srCrossingValue: {
    description: 'Support or resistance line',
    example: 'resistance',
  },

  // Volume/Oscillators
  basePeriods: { description: 'Base period for calculation', example: 20 },
  pumpPeriods: { description: 'Pump detection periods', example: 5 },
  pump: { description: 'Pump threshold value', example: 10 },
  interval: { description: 'Calculation interval', example: 14 },
  baseCrack: { description: 'Base crack threshold', example: 5 },
  voShort: { description: 'Volume oscillator short period', example: 5 },
  voLong: { description: 'Volume oscillator long period', example: 10 },

  // Other indicators
  psarStart: { description: 'Parabolic SAR start value', example: 0.02 },
  psarInc: { description: 'Parabolic SAR increment', example: 0.02 },
  psarMax: { description: 'Parabolic SAR maximum', example: 0.2 },
  minPercFromLast: {
    description: 'Minimum % from last signal',
    example: '1.0',
  },
  keepConditionBars: { description: 'Bars to keep condition', example: '3' },
  uoFast: { description: 'Ultimate Oscillator fast period', example: 7 },
  uoMiddle: { description: 'Ultimate Oscillator middle period', example: 14 },
  uoSlow: { description: 'Ultimate Oscillator slow period', example: 28 },
  momSource: { description: 'Momentum source price', example: 'close' },
  bbwpLookback: { description: 'BBWP lookback period', example: 252 },
  ecdTrigger: { description: 'ECD trigger type', example: 'bullish' },

  // Backtest specific fields
  from: {
    description: 'Backtest start timestamp (milliseconds)',
    example: 1640995200000,
  },
  to: {
    description: 'Backtest end timestamp (milliseconds)',
    example: 1672531199000,
  },
  backtestInterval: { description: 'Backtest chart interval', example: '1h' },
  fromBacktest: {
    description: 'Import from previous backtest',
    example: false,
  },
  trades: { description: 'Include trade details in results', example: true },
  symbols: {
    description: 'Array of trading symbols for backtest',
    example: [],
  },
  payload: {
    description: 'Complete backtest configuration and settings',
    example: {},
  },
  cost: { description: 'Estimated cost in credits for backtest', example: 10 },
  requestId: {
    description: 'Unique identifier for backtest request',
    example: '507f1f77bcf86cd799439011',
  },
  status: {
    description: 'Current status of backtest request',
    example: 'pending',
  },
  statusHistory: { description: 'History of status changes', example: [] },
  userId: {
    description: 'User ID who requested the backtest',
    example: '507f1f77bcf86cd799439011',
  },
  data: { description: 'Backtest input data and settings', example: {} },
  results: { description: 'Backtest execution results', example: {} },

  // Backtest symbol fields
  baseAsset: {
    description: 'Base asset symbol (e.g., BTC in BTC/USDT)',
    example: 'BTC',
  },
  quoteAsset: {
    description: 'Quote asset symbol (e.g., USDT in BTC/USDT)',
    example: 'USDT',
  },

  // Backtest result fields
  totalProfit: { description: 'Total profit from backtest', example: 250.75 },
  totalProfitPerc: { description: 'Total profit percentage', example: 12.5 },
  maxDrawdown: { description: 'Maximum drawdown percentage', example: -8.2 },
  winRate: { description: 'Win rate percentage', example: 68.5 },
  totalDeals: { description: 'Total number of deals executed', example: 156 },
  profitableDeals: { description: 'Number of profitable deals', example: 107 },
  avgDealProfit: { description: 'Average profit per deal', example: 1.61 },

  // Exchange and connection
  exchange: { description: 'Exchange identifier', example: 'binance' },
  exchangeUUID: {
    description: 'Unique exchange connection identifier',
    example: '550e8400-e29b-41d4-a716-446655440000',
  },

  // Cross oscillator
  xOscillator2length: { description: 'Second oscillator length', example: 14 },
  xOscillator2Interval: {
    description: 'Second oscillator timeframe',
    example: '1h',
  },
  xOscillator2voLong: {
    description: 'Second oscillator long period',
    example: 10,
  },
  xOscillator2voShort: {
    description: 'Second oscillator short period',
    example: 5,
  },
  xoUUID: { description: 'Cross oscillator UUID', example: '123e4567' },

  // MA ratio
  mar1length: { description: 'First MA length for ratio', example: 20 },
  mar1type: { description: 'First MA type', example: 'ema' },
  mar2length: { description: 'Second MA length for ratio', example: 50 },
  mar2type: { description: 'Second MA type', example: 'sma' },

  // MACD
  macdFast: { description: 'MACD fast period', example: 12 },
  macdSlow: { description: 'MACD slow period', example: 26 },
  macdMaSource: { description: 'MACD MA source type', example: 'ema' },
  macdMaSignal: { description: 'MACD signal line type', example: 'ema' },

  // Divergence
  divOscillators: { description: 'Oscillators for divergence', example: [] },
  divType: { description: 'Divergence type', example: 'Bullish' },
  divMinCount: { description: 'Minimum divergence count', example: 2 },

  // Supertrend
  factor: { description: 'Supertrend multiplier factor', example: 3 },
  atrLength: { description: 'ATR period length', example: 10 },
  stCondition: { description: 'Supertrend condition', example: 'up' },

  // Price change
  pcUp: { description: 'Price change up threshold', example: '5' },
  pcDown: { description: 'Price change down threshold', example: '5' },
  pcCondition: { description: 'Price change direction', example: 'UP' },
  pcValue: { description: 'Price change value', example: '10' },

  // Pivot points
  ppHighLeft: { description: 'Pivot high left bars', example: 10 },
  ppHighRight: { description: 'Pivot high right bars', example: 10 },
  ppLowLeft: { description: 'Pivot low left bars', example: 10 },
  ppLowRight: { description: 'Pivot low right bars', example: 10 },
  ppMult: { description: 'Pivot point multiplier', example: 1 },
  ppValue: { description: 'Pivot point value type', example: 'HH' },
  ppType: { description: 'Pivot point type', example: 'Price Based' },

  // Risk ATR
  riskAtrMult: { description: 'ATR multiplier for risk', example: '2.0' },
  dynamicArFactor: { description: 'Dynamic AR factor', example: '1.5' },

  // ATH
  athLookback: { description: 'All-time high lookback period', example: 365 },

  // Keltner Channel
  kcMa: { description: 'Keltner Channel MA type', example: 'ema' },
  kcRange: { description: 'Keltner Channel range type', example: 'ATR' },
  kcRangeLength: { description: 'Keltner Channel range length', example: 20 },

  // Unrealized PnL
  unpnlValue: { description: 'Unrealized PnL threshold', example: 100 },
  unpnlCondition: { description: 'Unrealized PnL condition', example: 'gt' },

  // Donchian Channel
  dcValue: { description: 'Donchian Channel line', example: 'upper' },

  // Order Block FVG
  obfvgValue: { description: 'Order block/FVG type', example: 'bullish' },
  obfvgRef: { description: 'Order block/FVG reference', example: 'high' },

  // Indicator group
  id: { description: 'Group or item identifier', example: 'group-1' },
  logic: { description: 'Logic operator (AND/OR)', example: 'and' },
  action: { description: 'Action to trigger', example: 'startDeal' },

  // Multi TP/SL targets
  target: { description: 'Target profit/loss percentage', example: '2.5' },
  amount: { description: 'Amount to close at target', example: '50' },
  fixed: { description: 'Fixed price target', example: '55000' },

  // DCA Custom
  size: { description: 'Custom order size', example: '150' },
}

// Per-schema overrides of fieldMetadata, for a field name that means different
// things on different schemas (the flat map above is keyed by field name only).
const schemaFieldMetadata: Record<
  string,
  Record<string, Partial<{ description: string; example: any }>>
> = {
  SettingsIndicators: {
    type: { example: 'RSI' },
  },
}

class SchemaGenerator {
  private sourceFile: ts.SourceFile
  private enums: Map<string, EnumInfo> = new Map()
  // Type aliases that are a union of string literals — documented as a string
  // enum, exactly like a TS enum. Kept apart from `enums` because they are not
  // enum declarations and must not be reported as generated enum schemas.
  private stringLiteralUnions: Map<string, string[]> = new Map()
  private types: Map<string, TypeInfo> = new Map()
  // Schema types that can be referenced via $ref
  private referenceableSchemas = new Set([
    'DCACustom',
    'SettingsIndicators',
    'SettingsIndicatorGroup',
    'MultiTP',
    'ServerSideBacktestPayload',
    'DCABacktestingResult',
    'ComboBacktestingResult',
    'GRIDBacktestingResult',
    'BacktestRequest',
    'BacktestSettings',
  ])

  constructor(typesFilePath: string) {
    const program = ts.createProgram([typesFilePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    })
    this.sourceFile = program.getSourceFile(typesFilePath)!
  }

  parse() {
    // First pass: collect all enums and string-literal union aliases
    ts.forEachChild(this.sourceFile, (node) => {
      if (ts.isEnumDeclaration(node)) {
        this.parseEnum(node)
      } else if (ts.isTypeAliasDeclaration(node)) {
        this.parseStringLiteralUnion(node)
      }
    })

    console.log(
      `\nParsed ${this.enums.size} enums and ${this.stringLiteralUnions.size} string unions\n`,
    )

    // Second pass: parse interfaces and type aliases (now all enums are available)
    ts.forEachChild(this.sourceFile, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        this.parseInterface(node)
      } else if (ts.isTypeAliasDeclaration(node)) {
        this.parseTypeAlias(node)
      }
    })
  }

  private parseEnum(node: ts.EnumDeclaration) {
    const name = node.name.text
    const values: string[] = []

    node.members.forEach((member) => {
      if (member.initializer && ts.isStringLiteral(member.initializer)) {
        values.push(member.initializer.text)
      } else if (ts.isIdentifier(member.name)) {
        values.push(member.name.text)
      } else if (member.name) {
        values.push(member.name.getText())
      }
    })

    if (values.length > 0) {
      this.enums.set(name, { name, values })
    }
  }

  private literalText(type: ts.TypeNode): string | null {
    return ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
      ? type.literal.text
      : null
  }

  /**
   * `export type TpSlAction = 'stop' | 'stopAndSell'` carries a closed set of
   * values just like an enum, but it is a type alias, so `parseEnum` never sees
   * it and `parseTypeNode` used to fall through to `{ type: 'object' }` — the
   * published field then had no `enum` at all.
   */
  private parseStringLiteralUnion(node: ts.TypeAliasDeclaration) {
    const members = ts.isUnionTypeNode(node.type)
      ? node.type.types
      : [node.type]

    const values: string[] = []
    for (const member of members) {
      const text = this.literalText(member)
      // Any non-string-literal member means this is not a closed string set.
      if (text === null) return
      values.push(text)
    }

    if (values.length > 0) {
      this.stringLiteralUnions.set(node.name.text, values)
    }
  }

  private parseInterface(node: ts.InterfaceDeclaration) {
    const name = node.name.text

    // Only process bot-related, settings, indicator, and backtest interfaces
    if (
      !name.includes('Bot') &&
      !name.includes('Settings') &&
      !name.includes('Indicator') &&
      !name.includes('Backtest') &&
      !name.includes('Request') &&
      !name.includes('Result') &&
      !name.includes('Payload') &&
      !name.includes('Input') &&
      !name.includes('Response')
    ) {
      return
    }

    const properties: PropertyInfo[] = []
    const extendsClause = node.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )

    // Safely get extends type
    let extendsType: string | undefined
    try {
      if (extendsClause?.types?.[0]) {
        const typeNode = extendsClause.types[0]
        if (ts.isIdentifier(typeNode.expression)) {
          extendsType = typeNode.expression.text
        } else if (typeNode.expression) {
          extendsType = typeNode.expression.getText()
        }
      }
    } catch (error) {
      // Skip extends if we can't parse it
    }

    node.members.forEach((member) => {
      // Only handle property signatures, skip index signatures and others
      if (ts.isPropertySignature(member)) {
        try {
          const prop = this.parseProperty(member)
          if (prop) properties.push(prop)
        } catch (error) {
          // Skip individual properties that fail to parse
        }
      }
    })

    this.types.set(name, {
      name,
      extends: extendsType,
      properties,
      description: this.getJsDocComment(node),
    })

    if (properties.length > 0) {
      console.log(`Parsed interface ${name}: ${properties.length} properties`)
    }
  }

  private parseTypeAlias(node: ts.TypeAliasDeclaration) {
    const name = node.name.text

    // Only process specific type aliases we care about
    if (
      ![
        'MultiTP',
        'DCACustom',
        'SettingsIndicators',
        'SettingsIndicatorGroup',
        'ServerSideBacktestPayload',
        'DCABacktestingResult',
        'ComboBacktestingResult',
        'GRIDBacktestingResult',
        'BacktestRequest',
        'BacktestSettings',
      ].includes(name) &&
      !name.includes('Backtest') &&
      !name.includes('Request') &&
      !name.includes('Result') &&
      !name.includes('Payload')
    ) {
      return
    }

    const properties: PropertyInfo[] = []

    // Handle intersection types (Type1 & Type2 & Type3)
    if (ts.isIntersectionTypeNode(node.type)) {
      node.type.types.forEach((intersectionType) => {
        if (ts.isTypeLiteralNode(intersectionType)) {
          intersectionType.members.forEach((member) => {
            if (ts.isPropertySignature(member)) {
              try {
                const prop = this.parseProperty(member)
                if (prop) properties.push(prop)
              } catch (error) {
                // Skip individual properties that fail to parse
              }
            }
          })
        }
      })
    }
    // Handle simple type literals
    else if (ts.isTypeLiteralNode(node.type)) {
      node.type.members.forEach((member) => {
        // Only handle property signatures
        if (ts.isPropertySignature(member)) {
          try {
            const prop = this.parseProperty(member)
            if (prop) properties.push(prop)
          } catch (error) {
            // Skip individual properties that fail to parse
          }
        }
      })
    }

    if (properties.length > 0) {
      this.types.set(name, {
        name,
        properties,
        description: this.getJsDocComment(node),
      })

      console.log(`Parsed type alias ${name}: ${properties.length} properties`)
    }
  }

  private parseProperty(member: ts.PropertySignature): PropertyInfo | null {
    // Handle property names safely
    if (!member.name) return null

    let name: string
    try {
      if (ts.isIdentifier(member.name)) {
        name = member.name.text
      } else if (ts.isStringLiteral(member.name)) {
        name = member.name.text
      } else {
        // Skip computed or complex property names
        return null
      }
    } catch (error) {
      // Skip properties we can't parse
      return null
    }

    const required = !member.questionToken
    const type = member.type
    let nullable = false
    let propType = 'string'
    let enumValues: string[] | undefined
    let items: any
    let properties: Record<string, any> | undefined

    if (!type) return null

    if (ts.isUnionTypeNode(type)) {
      // Check if union includes undefined or null
      const types = type.types
      nullable = types.some(
        (t) =>
          t.kind === ts.SyntaxKind.UndefinedKeyword ||
          t.kind === ts.SyntaxKind.NullKeyword,
      )

      // Get the actual types (non-null/undefined)
      const actualTypes = types.filter(
        (t) =>
          t.kind !== ts.SyntaxKind.UndefinedKeyword &&
          t.kind !== ts.SyntaxKind.NullKeyword,
      )
      const actualType = actualTypes[0]
      const literals = actualTypes.map((t) => this.literalText(t))

      // An inline closed string set (`'closed' | 'monitoring'`) keeps every
      // member — parsing only the first one published a one-value enum.
      if (literals.length > 0 && literals.every((t) => t !== null)) {
        propType = 'string'
        enumValues = literals as string[]
      } else if (actualType) {
        const parsed = this.parseTypeNode(actualType)
        propType = parsed.type
        enumValues = parsed.enum
        items = parsed.items
      }
    } else {
      const parsed = this.parseTypeNode(type)
      propType = parsed.type
      enumValues = parsed.enum
      items = parsed.items
      properties = parsed.properties
    }

    return {
      name,
      type: propType,
      required,
      nullable,
      enum: enumValues,
      items,
      properties,
      description: this.getJsDocComment(member),
    }
  }

  private parseTypeNode(type: ts.TypeNode): {
    type: string
    enum?: string[]
    items?: any
    properties?: Record<string, any>
    $ref?: string
  } {
    if (ts.isTypeReferenceNode(type)) {
      // Get type name safely
      let typeName: string
      if (ts.isIdentifier(type.typeName)) {
        typeName = type.typeName.text
      } else {
        typeName = type.typeName.getText()
      }

      // Check if it's an enum
      if (this.enums.has(typeName)) {
        const enumValues = this.enums.get(typeName)!.values
        return {
          type: 'string',
          enum: enumValues,
        }
      }

      // Closed string sets declared as a union type alias
      if (this.stringLiteralUnions.has(typeName)) {
        return {
          type: 'string',
          enum: this.stringLiteralUnions.get(typeName)!,
        }
      }

      // Built-in types
      if (typeMapping[typeName]) {
        return { type: typeMapping[typeName] }
      }

      // Array types
      if (typeName === 'Array' && type.typeArguments?.[0]) {
        const itemType = this.parseTypeNode(type.typeArguments[0])
        return {
          type: 'array',
          items: itemType.$ref
            ? { $ref: itemType.$ref }
            : itemType.enum
              ? { type: itemType.type, enum: itemType.enum }
              : { type: itemType.type },
        }
      }

      // Check if it's a referenceable schema
      if (this.referenceableSchemas.has(typeName)) {
        return {
          type: 'object',
          $ref: `#/components/schemas/${typeName}`,
        }
      }

      // Complex types - return as object
      return { type: 'object' }
    }

    if (ts.isArrayTypeNode(type)) {
      const elementType = this.parseTypeNode(type.elementType)
      return {
        type: 'array',
        items: elementType.$ref
          ? { $ref: elementType.$ref }
          : elementType.enum
            ? { type: elementType.type, enum: elementType.enum }
            : { type: elementType.type },
      }
    }

    if (ts.isLiteralTypeNode(type)) {
      if (ts.isStringLiteral(type.literal)) {
        return { type: 'string', enum: [type.literal.text] }
      }
      if (ts.isNumericLiteral(type.literal)) {
        return { type: 'number' }
      }
    }

    if (type.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' }
    if (type.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' }
    if (type.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' }

    return { type: 'object' }
  }

  private getJsDocComment(node: ts.Node): string | undefined {
    const jsDocTags = ts.getJSDocTags(node)
    if (jsDocTags.length > 0) {
      return jsDocTags[0].comment?.toString()
    }
    return undefined
  }

  generateOpenAPISchema(typeName: string): any {
    const typeInfo = this.types.get(typeName)
    if (!typeInfo) {
      console.warn(`Type ${typeName} not found`)
      return null
    }

    // Handle inheritance
    if (typeInfo.extends) {
      const baseSchema = this.generateOpenAPISchema(typeInfo.extends)
      if (baseSchema) {
        const schema: any = {
          description: typeInfo.description || `${typeName} configuration`,
          allOf: [
            { $ref: `#/components/schemas/${typeInfo.extends}` },
            {
              type: 'object',
              properties: {},
            },
          ],
        }
        // Add properties to the second object in allOf
        typeInfo.properties.forEach((prop) => {
          const propSchema = this.propertyToOpenAPI(prop, typeName)
          schema.allOf[1].properties[prop.name] = propSchema
        })
        return schema
      }
    }

    // Non-inherited schema
    const schema: any = {
      type: 'object',
      properties: {},
    }

    // Only add description for non-base schemas
    // BaseSettings is used only as a base and shouldn't have its own description
    if (typeName !== 'BaseSettings') {
      schema.description = typeInfo.description || `${typeName} configuration`
    }

    typeInfo.properties.forEach((prop) => {
      schema.properties[prop.name] = this.propertyToOpenAPI(prop, typeName)
    })

    return schema
  }

  private propertyToOpenAPI(prop: PropertyInfo, typeName: string): any {
    const schema: any = {
      type: prop.type,
    }

    // Add description from metadata or property info
    const metadata = fieldMetadata[prop.name] && {
      ...fieldMetadata[prop.name],
      ...schemaFieldMetadata[typeName]?.[prop.name],
    }
    if (metadata?.description) {
      schema.description = metadata.description
    } else if (prop.description) {
      schema.description = prop.description
    }

    if (prop.nullable) {
      schema.nullable = true
    }

    if (prop.enum) {
      schema.enum = prop.enum
    }

    if (prop.items) {
      schema.items = prop.items
    }

    if (prop.properties) {
      schema.properties = prop.properties
    }

    // Add example values from metadata or defaults based on type
    if (metadata?.example !== undefined) {
      schema.example = metadata.example
    } else if (prop.type === 'string' && !prop.enum) {
      schema.example = null
    } else if (prop.type === 'number') {
      schema.example = null
    } else if (prop.type === 'boolean') {
      schema.example = false
    } else if (prop.type === 'array') {
      schema.example = null
    }

    return schema
  }

  generateAllSchemas(): Record<string, any> {
    const schemas: Record<string, any> = {}

    // Generate enum schemas first
    this.enums.forEach((enumInfo) => {
      // Skip internal enums
      if (!enumInfo.name.includes('Enum')) return

      console.log(`Generated enum: ${enumInfo.name}`)
    })

    // Generate type schemas
    const targetTypes = [
      'BaseSettings',
      'BotSettings',
      'DCABotSettings',
      'ComboBotSettings',
      'SettingsIndicators',
      'SettingsIndicatorGroup',
      'MultiTP',
      'DCACustom',
    ]

    targetTypes.forEach((typeName) => {
      const schema = this.generateOpenAPISchema(typeName)
      if (schema) {
        schemas[typeName] = schema
        console.log(`Generated schema: ${typeName}`)
      }
    })

    return schemas
  }
}

// Main execution
async function main() {
  const typesPath = path.join(__dirname, '../../types.ts')
  const openApiPath = path.join(__dirname, '../server/v2/openapi-v2.yaml')
  const backupPath = path.join(__dirname, '../server/v2/openapi-v2.yaml.backup')

  console.log('Parsing TypeScript types from:', typesPath)

  const generator = new SchemaGenerator(typesPath)
  generator.parse()

  console.log('\nGenerating OpenAPI schemas...\n')
  const generatedSchemas = generator.generateAllSchemas()

  // Read existing OpenAPI spec
  console.log('Reading existing OpenAPI spec:', openApiPath)
  const existingYaml = fs.readFileSync(openApiPath, 'utf-8')
  const openApiSpec: any = yaml.load(existingYaml)

  // Create backup
  fs.writeFileSync(backupPath, existingYaml, 'utf-8')
  console.log('✓ Created backup:', backupPath)

  // Ensure components.schemas exists
  if (!openApiSpec.components) {
    openApiSpec.components = {}
  }
  if (!openApiSpec.components.schemas) {
    openApiSpec.components.schemas = {}
  }

  // Update/merge generated schemas into OpenAPI spec
  const schemasToUpdate = [
    'BaseSettings',
    'BotSettings',
    'DCABotSettings',
    'ComboBotSettings',
    'SettingsIndicators',
    'SettingsIndicatorGroup',
    'MultiTP',
    'DCACustom',
    'ServerSideBacktestPayload',
    'DCABacktestingResult',
    'ComboBacktestingResult',
    'GRIDBacktestingResult',
    'BacktestRequest',
    'BacktestSettings',
    'CreateServerSideBacktestInput',
    'EstimateBacktestCostInput',
    'BacktestSymbol',
    'BacktestRequestStatus',
  ]

  schemasToUpdate.forEach((schemaName) => {
    if (generatedSchemas[schemaName]) {
      openApiSpec.components.schemas[schemaName] = generatedSchemas[schemaName]
      console.log(`✓ Updated schema: ${schemaName}`)
    }
  })

  // An example outside its enum is a value the API rejects — refuse to publish it
  const mismatches = findEnumExampleMismatches(
    openApiSpec.components.schemas,
    'components.schemas',
  )
  if (mismatches.length) {
    throw new Error(
      `OpenAPI examples not in their enum:\n  ${mismatches.join('\n  ')}`,
    )
  }

  // Write back to openapi-v2.yaml
  const yamlOutput = yaml.dump(openApiSpec, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  })

  fs.writeFileSync(openApiPath, yamlOutput, 'utf-8')
  console.log(`\n✅ Schemas updated successfully in OpenAPI spec!`)
  console.log(`📝 Updated: ${openApiPath}`)
  console.log(`💾 Backup: ${backupPath}`)
  console.log('\n🎯 Generated schemas are now inlined in openapi-v2.yaml')
  console.log('   No external references needed!')
}

main().catch((error) => {
  console.error('Error generating schemas:', error)
  process.exit(1)
})
