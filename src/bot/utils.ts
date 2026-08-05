import { botDb, comboBotDb, dcaBotDb, globalVarsDb, pairDb } from '../db/dbInit'
import { matchErrorRuleSubType } from './errorRulesCache'
import {
  BotType,
  BotVars,
  DCADealsSettings,
  type ClearComboBotSchema,
  type ClearDCABotSchema,
  type CleanHedgeBotSchema,
  StatusEnum,
  DCAConditionEnum,
  CloseConditionEnum,
  BaseSlOnEnum,
  ComboTpBase,
  CooldownUnits,
  DCABotSettings,
  OrderSizeTypeEnum,
  StartConditionEnum,
  DynamicPriceFilterDirectionEnum,
  DynamicPriceFilterPriceTypeEnum,
  OrderTypeEnum,
  ExchangeEnum,
  MainBot,
  BotStatusEnum,
} from '../../types'
import utils from '../utils'
import { detailedDiff } from 'deep-object-diff'
import { ProjectionFields } from 'mongoose'
const { mapToArray, mapToObject } = utils

export const convertDCABot = (input: ClearDCABotSchema): ClearDCABotSchema => {
  const data = input
  return {
    ...data,
    currentBalances: {
      base: new Map(Object.entries(data.currentBalances.base)),
      quote: new Map(Object.entries(data.currentBalances.quote)),
    },
    initialBalances: {
      base: new Map(Object.entries(data.initialBalances.base)),
      quote: new Map(Object.entries(data.initialBalances.quote)),
    },
    assets: {
      used: {
        base: new Map(Object.entries(data.assets.used.base)),
        quote: new Map(Object.entries(data.assets.used.quote)),
      },
      required: {
        base: new Map(Object.entries(data.assets.required.base)),
        quote: new Map(Object.entries(data.assets.required.quote)),
      },
    },
    lastPrice: new Map(Object.entries(data.lastPrice)),
    lastUsdRate: new Map(Object.entries(data.lastUsdRate)),
    symbol: new Map(Object.entries(data.symbol)),
  }
}

export const convertComboBot = (input: ClearComboBotSchema) => {
  const data = input
  return {
    ...data,
    currentBalances: {
      base: new Map(Object.entries(data.currentBalances.base)),
      quote: new Map(Object.entries(data.currentBalances.quote)),
    },
    initialBalances: {
      base: new Map(Object.entries(data.initialBalances.base)),
      quote: new Map(Object.entries(data.initialBalances.quote)),
    },
    assets: {
      used: {
        base: new Map(Object.entries(data.assets.used.base)),
        quote: new Map(Object.entries(data.assets.used.quote)),
      },
      required: {
        base: new Map(Object.entries(data.assets.required.base)),
        quote: new Map(Object.entries(data.assets.required.quote)),
      },
    },
    symbol: new Map(Object.entries(data.symbol)),
  }
}

export const convertHedgeComboBot = (input: CleanHedgeBotSchema) => {
  const data = input
  return {
    ...data,
    currentBalances: {
      long: {
        base: new Map(Object.entries(data.currentBalances.long.base)),
        quote: new Map(Object.entries(data.currentBalances.long.quote)),
      },
      short: {
        base: new Map(Object.entries(data.currentBalances.short.base)),
        quote: new Map(Object.entries(data.currentBalances.short.quote)),
      },
    },
    initialBalances: {
      long: {
        base: new Map(Object.entries(data.initialBalances.long.base)),
        quote: new Map(Object.entries(data.initialBalances.long.quote)),
      },
      short: {
        base: new Map(Object.entries(data.initialBalances.short.base)),
        quote: new Map(Object.entries(data.initialBalances.short.quote)),
      },
    },
    assets: {
      long: {
        used: {
          base: new Map(Object.entries(data.assets.long.used.base)),
          quote: new Map(Object.entries(data.assets.long.used.quote)),
        },
        required: {
          base: new Map(Object.entries(data.assets.long.required.base)),
          quote: new Map(Object.entries(data.assets.long.required.quote)),
        },
      },
      short: {
        used: {
          base: new Map(Object.entries(data.assets.short.used.base)),
          quote: new Map(Object.entries(data.assets.short.used.quote)),
        },
        required: {
          base: new Map(Object.entries(data.assets.short.required.base)),
          quote: new Map(Object.entries(data.assets.short.required.quote)),
        },
      },
    },
    symbol: new Map(Object.entries(data.symbol)),
  }
}

export const convertDCABotToArray = (
  input: ClearDCABotSchema,
  skip = false,
) => {
  const data = skip ? input : convertDCABot(input)
  return {
    ...data,
    currentBalances: {
      base: mapToArray(data.currentBalances.base),
      quote: mapToArray(data.currentBalances.quote),
    },
    initialBalances: {
      base: mapToArray(data.initialBalances.base),
      quote: mapToArray(data.initialBalances.quote),
    },
    assets: {
      used: {
        base: mapToArray(data.assets.used.base),
        quote: mapToArray(data.assets.used.quote),
      },
      required: {
        base: mapToArray(data.assets.required.base),
        quote: mapToArray(data.assets.required.quote),
      },
    },
    symbol: mapToArray(data.symbol),
  }
}

export const convertDCABotToObject = (input: ClearDCABotSchema) => {
  const data = input
  return {
    ...data,
    currentBalances: {
      base: mapToObject(data.currentBalances.base),
      quote: mapToObject(data.currentBalances.quote),
    },
    initialBalances: {
      base: mapToObject(data.initialBalances.base),
      quote: mapToObject(data.initialBalances.quote),
    },
    assets: {
      used: {
        base: mapToObject(data.assets.used.base),
        quote: mapToObject(data.assets.used.quote),
      },
      required: {
        base: mapToObject(data.assets.required.base),
        quote: mapToObject(data.assets.required.quote),
      },
    },
    symbol: mapToObject(data.symbol),
  }
}

export const convertComboBotToArray = (
  input: ClearComboBotSchema,
  skip = false,
) => {
  const data = skip ? input : convertComboBot(input)
  return {
    ...data,
    currentBalances: {
      base: mapToArray(data.currentBalances.base),
      quote: mapToArray(data.currentBalances.quote),
    },
    initialBalances: {
      base: mapToArray(data.initialBalances.base),
      quote: mapToArray(data.initialBalances.quote),
    },
    assets: {
      used: {
        base: mapToArray(data.assets.used.base),
        quote: mapToArray(data.assets.used.quote),
      },
      required: {
        base: mapToArray(data.assets.required.base),
        quote: mapToArray(data.assets.required.quote),
      },
    },
    symbol: mapToArray(data.symbol),
  }
}

export const convertHedgeComboBotToArray = (
  input: CleanHedgeBotSchema,
  skip = false,
) => {
  const data = skip ? input : convertHedgeComboBot(input)
  return {
    ...data,
    currentBalances: {
      long: {
        base: mapToArray(data.currentBalances.long.base),
        quote: mapToArray(data.currentBalances.long.quote),
      },
      short: {
        base: mapToArray(data.currentBalances.short.base),
        quote: mapToArray(data.currentBalances.short.quote),
      },
    },
    initialBalances: {
      long: {
        base: mapToArray(data.initialBalances.long.base),
        quote: mapToArray(data.initialBalances.long.quote),
      },
      short: {
        base: mapToArray(data.initialBalances.short.base),
        quote: mapToArray(data.initialBalances.short.quote),
      },
    },
    assets: {
      long: {
        used: {
          base: mapToArray(data.assets.long.used.base),
          quote: mapToArray(data.assets.long.used.quote),
        },
        required: {
          base: mapToArray(data.assets.long.required.base),
          quote: mapToArray(data.assets.long.required.quote),
        },
      },
      short: {
        used: {
          base: mapToArray(data.assets.short.used.base),
          quote: mapToArray(data.assets.short.used.quote),
        },
        required: {
          base: mapToArray(data.assets.short.required.base),
          quote: mapToArray(data.assets.short.required.quote),
        },
      },
    },
    symbol: mapToArray(data.symbol),
  }
}

export const convertComboBotToObject = (input: ClearComboBotSchema) => {
  const data = input
  return {
    ...data,
    currentBalances: {
      base: mapToObject(data.currentBalances.base),
      quote: mapToObject(data.currentBalances.quote),
    },
    initialBalances: {
      base: mapToObject(data.initialBalances.base),
      quote: mapToObject(data.initialBalances.quote),
    },
    assets: {
      used: {
        base: mapToObject(data.assets.used.base),
        quote: mapToObject(data.assets.used.quote),
      },
      required: {
        base: mapToObject(data.assets.required.base),
        quote: mapToObject(data.assets.required.quote),
      },
    },
    symbol: mapToObject(data.symbol),
  }
}
const botSettingsKeyToPropertyName = (
  key: keyof ClearDCABotSchema['settings'],
) => {
  switch (key) {
    case 'activeOrdersCount':
      return 'Smart orders'
    case 'baseOrderPrice':
      return 'Base order price'
    case 'baseOrderSize':
      return 'Base order size'
    case 'botStart':
      return 'Bot start'
    case 'closeAfterX':
      return 'Close after X close value'
    case 'closeAfterXopen':
      return 'Close after X opened value'
    case 'closeDealType':
      return 'Use close deal type'
    case 'cooldownAfterDealStart':
      return 'Use cooldown after deal start'
    case 'cooldownAfterDealStartInterval':
      return 'Cooldown after deal start interval'
    case 'cooldownAfterDealStartUnits':
      return 'Cooldown after deal start units'
    case 'cooldownAfterDealStop':
      return 'Use cooldown after deal stop'
    case 'cooldownAfterDealStopInterval':
      return 'Cooldown after deal stop interval'
    case 'cooldownAfterDealStopUnits':
      return 'Cooldown after deal stop units'
    case 'dealCloseCondition':
      return 'Take profit condition'
    case 'dealCloseConditionSL':
      return 'Stop loss condition'
    case 'hodlAt':
      return 'Time trigger at'
    case 'hodlDay':
      return 'Time trigger days'
    case 'hodlNextBuy':
      return 'Time trigger next buy'
    case 'limitTimeout':
      return 'Limit timeout'
    case 'leverage':
      return 'Leverage'
    case 'marginType':
      return 'Margin type'
    case 'maxDealsPerPair':
      return 'Max deals per pair'
    case 'maxNumberOfOpenDeals':
      return 'Max number of open deals'
    case 'maxOpenDeal':
      return 'Max price to open deal'
    case 'minOpenDeal':
      return 'Min price to open deal'
    case 'minTp':
      return 'Min TP'
    case 'moveSL':
      return 'Use move SL'
    case 'moveSLTrigger':
      return 'Move SL trigger'
    case 'moveSLValue':
      return 'Move SL value'
    case 'name':
      return 'Name'
    case 'orderFixedIn':
      return 'Order fixed in'
    case 'orderSize':
      return 'DCA order size'
    case 'orderSizeType':
      return 'Order size type'
    case 'ordersCount':
      return 'DCA orders count'
    case 'profitCurrency':
      return 'Profit currency'
    case 'slPerc':
      return 'SL percent'
    case 'startCondition':
      return 'Start condition'
    case 'startOrderType':
      return 'Base order type'
    case 'step':
      return 'DCA orders step'
    case 'stepScale':
      return 'DCA orders step scale'
    case 'stopType':
      return 'Bot stop type'
    case 'strategy':
      return 'Strategy'
    case 'tpPerc':
      return 'TP percent'
    case 'trailingSl':
      return 'Use trailing SL'
    case 'trailingTp':
      return 'Use trailing TP'
    case 'trailingTpPerc':
      return 'Trailing TP percent'
    case 'useBotController':
      return 'Use bot controller'
    case 'useCloseAfterX':
      return 'Use close after X closed'
    case 'useCloseAfterXopen':
      return 'Use close after X opened'
    case 'useDca':
      return 'Use DCA'
    case 'useLimitPrice':
      return 'Use limit price'
    case 'useLimitTimeout':
      return 'Use limit timeout'
    case 'useMinTP':
      return 'Use min TP'
    case 'useMultiSl':
      return 'Use multi SL'
    case 'useMultiTp':
      return 'Use multi TP'
    case 'useSl':
      return 'Use SL'
    case 'useSmartOrders':
      return 'Use smart orders'
    case 'volumeScale':
      return 'Volume scale'
    case 'useTp':
      return 'Use TP'
    default:
      return key
  }
}

export const getObjectsDiff = (
  oldObject: Record<string, unknown>,
  newObject: Record<string, unknown>,
) => {
  return detailedDiff(oldObject, newObject)
}

export const getSettingsChangeDescription = (
  settings: Record<string, unknown>,
  oldSettings: Record<string, unknown>,
) => {
  const result: string[] = []
  Object.keys(settings).forEach((key: string) => {
    if (
      settings[key] !== oldSettings[key] &&
      typeof oldSettings[key] !== 'undefined'
    ) {
      if (!Array.isArray(oldSettings[key])) {
        result.push(
          `${botSettingsKeyToPropertyName(
            key as keyof ClearDCABotSchema['settings'],
          )}: ${oldSettings[key]} -> ${settings[key]}`,
        )
      }
    }
  })
  return result.join(', ')
}

export const futuresPosition = 'Futures position'

export const futuresLiquidation = 'Futures liquidation'

export const exchangeProblems = 'Exchange connection'

export const orderPrice = 'Order price'

export const exchangeOrdersLimits = 'Exchange orders limits'

export const apiError = 'API keys error'

export const exchangeRules = 'Exchange rules'

export const exchangeRateLimit = 'Exchange rate limit'

const orderParams = 'Order params'

export const indicatorsError = 'Indicators error'

export const orderProcessing = 'Order processing'

/**
 * Permanent jurisdiction / account-eligibility block (e.g. Kraken's
 * `EAccount:Invalid permissions:USDT trading restricted for DE.`). No retry can
 * ever succeed — see `complianceGuard.ts`, which gates the re-send loop.
 */
export const complianceRestriction = 'Compliance restriction'

export const errorDict = {
  'Leverage cannot exceed': futuresPosition,
  unknownOid: orderProcessing,
  'Indicators error: ': indicatorsError,
  'Exceeded the maximum allowable position at current leverage':
    'Futures position restriction',
  'API key is invalid': apiError,
  'Invalid API-key, IP, or permissions for action': apiError,
  "API key doesn't exist": apiError,
  'KC-API-KEY not exists': apiError,
  'Api key info invalid': apiError,
  'Permission denied, please check your API key permissions.': apiError,
  'Futures Trading Quantitative Rules violated, only reduceOnly order is allowed, please try again later.':
    exchangeRules,
  'Deal cannot start due to max amout of orders on this symbol':
    exchangeOrdersLimits,
  'Reach max open order limit': exchangeOrdersLimits,
  'exceeding the maximum number of orders for total trading pairs':
    exchangeOrdersLimits,
  'Exchange connector | ': exchangeProblems,
  MAX_NUM_ORDERS: exchangeOrdersLimits,
  'Cannot exceed maximum of 500 conditional, TP/SL and active orders':
    exchangeOrdersLimits,
  'Not enough quote to place swap order': 'Grid base order',
  E11000: 'Duplicate key',
  'Duplicated externalId + symbol': 'Duplicate key',
  'Way too much request weight used': 'Binance ban',
  'Not enough balance to start new deal required': 'Cannot start deal',
  'Too Many Requests | 429': 'Kucoin ban',
  'User fee not found': 'User fee error',
  400350: orderPrice,
  400330: orderPrice,
  400360: orderPrice,
  'This bot cannot run, due to max amout of orders on this symbol':
    exchangeOrdersLimits,
  200003: exchangeOrdersLimits,
  'Cannot read balances from db': 'Read balance from db',
  'Order price has too many decimals.': orderParams,
  'Filter failure': orderParams,
  400600: orderParams,
  300000: orderParams,
  400760: orderParams,
  'the order price exceeds the minimum price': orderPrice,
  'Illegal characters found in parameter': orderParams,
  'to 127.0.0.1:27017 closed': 'Db connection error',
  findAndModify: 'Db error',
  'interrupted at shutdown': 'Db error',
  'cursor id': 'Db error',
  'fetch failed': 'Failed to fetch',
  '127.0.0.1:7506': 'Connection to paper trading error',
  'Cannot get prices read ECONNRESET': 'Connection to paper trading error',
  '127.0.0.1:7507': 'Connection to exchange service error',
  '::1:7507': 'Connection to exchange service error',
  'ECONNREFUSED 127.0.0.1:27017': 'Connection to DB refused',
  'Duplicate order sent': 'Duplicate order ID',
  'Duplicate client order ID': 'Duplicate order ID',
  'Cannot get prices undefined': 'Unknown error',
  'Service Unavailable': 'Service Unavailable',
  'Cast to': 'Object validation error',
  'would modify the immutable fiel': 'Object validation error',
  'Order already queued for cancellation': 'Order processing',
  'Do not send more than 2 orders per 200ms': 'Order processing',
  'Order cannot be canceled.': 'Order processing',
  'The purchase amount of each order exceeds the estimated maximum':
    'Order processing',
  'The sell quantity per order exceeds the estimated maximum sell quantity.':
    'Order processing',
  'Order has been canceled.': 'Order processing',
  'Order has been filled.': 'Order processing',
  'Invalid API-key, IP,': apiError,
  'API keys and passphrase must be set': apiError,
  400003: apiError,
  'Symbol not whitelisted for API key': apiError,
  400006: apiError,
  'not found in user balances': 'Asset not found in user balances',
  200004: 'Balance insufficient',
  'Account has insufficient balance for requested action.':
    'Balance insufficient',
  'Request failed with status code 408': 'Request timeout',
  'Latest price = 0': 'Wrong data',
  noelem: 'Wrong data',
  '403 Forbidden': 'Exchange refused connection',
  'socket hang up': 'Connection hang up',
  'Cannot find all deals': 'No results in Db',
  'Exchange info not found': 'Cannot find exchange for bot',
  'Amount is lower than min allowed on exchange':
    'Amount of close order too low',
  'Unexpected end of JSON input': 'Wrong response format',
  'set margin': 'Futures Margin',
  'set leverage': 'Futures Leverage',
  'Bot exchange unassigned. Bot will stop': 'Bot exchange unassigned',
  'outside of the recvWindow': 'Exchange failure',
  'cannot run in hedge mode': 'Hedge mode',
  'Cannot start when existing position not met bot settings':
    'Existing position',
  'highest price limit for the buy leg': orderPrice,
  'highest price limit for the sell leg': orderPrice,
  'lowest price limit for the buy leg': orderPrice,
  'lowest price limit for the sell leg': orderPrice,
  'order price exceeds the maximum price limit': orderPrice,
  'order price cannot be lower': orderPrice,
  'order price cannot be higher': orderPrice,
  'cannot be greater than': orderPrice,
  'cannot be lower than': orderPrice,
  "Limit price can't be higher": orderPrice,
  "Limit price can't be lower": orderPrice,
  'Order price is out of permissible range': orderPrice,
  'Order price is not within the price limit': orderPrice,
  'lowest price limit for sell': orderPrice,
  'highest price limit for buy': orderPrice,
  'Cannot start the bot because of hard limits': 'User limit',
  'Reduce order is rejected': futuresPosition,
  'reduce only order would increase position': futuresPosition,
  'ReduceOnly Order': futuresPosition,
  'current position is zero, cannot fix reduce-only order qty': futuresPosition,
  'Reduce-only rule not satisfied': futuresPosition,
  'The position is being liquidated, unable to place/cancel the order. Please try again later.':
    futuresPosition,
  'orderQty will be truncated to zero.': futuresPosition,
  'No open positions to close.': futuresPosition,
  "You don't have any positions in this contract that can be closed":
    futuresPosition,
  'Bot stopped due to position liquidation': futuresLiquidation,
  'closed due to position liquidation': futuresLiquidation,
  'The order price cannot be': orderPrice,
  'Order qty is not a number': orderParams,
  'The quantity increment is invalid': orderParams,
  'Quantity parameter cannot be empty': orderParams,
  'The order amount must': orderParams,
  'The price increment': orderParams,
  'Failed to get latest price from exchange': exchangeProblems,
  'The price is invalid': orderParams,
  'Price less than min price.': orderPrice,
  'no position to close': futuresPosition,
  'Apikey does not exist': apiError,
  Unauthorized: apiError,
  'cannot be less than': orderPrice,
  'Your api key has expired.': apiError,
  'user or api wallet': apiError,
  'EAPI:Rate limit exceeded': 'Kraken ban',
  // Kraken Futures rate-limit (HTTP 429). Distinct string from spot's EAPI above.
  // The connector now backs off + retries it; if it still bubbles up, treat it as
  // a transient warning (see handleErrors) rather than an uncategorized hard error.
  apiLimitExceeded: exchangeRateLimit,
  'EService:Timeout': exchangeProblems,
  'EService:Unavailable': exchangeProblems,
  'EService:Busy': exchangeProblems,
  'EGeneral:Temporary lockout': 'Kraken ban',
  'EAPI:Invalid key': apiError,
  'EAPI:Invalid signature': apiError,
  'EAPI:Invalid nonce': apiError,
  'EGeneral:Permission denied': apiError,
  'EGeneral:Invalid arguments': orderParams,
  'EOrder:Insufficient funds': 'Balance insufficient',
  'EOrder:Order minimum not met': orderParams,
  'EOrder:Orders limit exceeded': exchangeOrdersLimits,
  'EOrder:Rate limit exceeded': exchangeOrdersLimits,
  'EOrder:Positions limit exceeded': exchangeOrdersLimits,
  'EOrder:Unknown order': 'Order processing',
  'EOrder:Order not found': 'Order processing',
  'EOrder:Cannot cancel order': 'Order processing',
  'EOrder:Order already canceled': 'Order processing',
  'EOrder:Order already closed': 'Order processing',
  'ETrade:Invalid price': orderPrice,
  'ETrade:Invalid volume': orderParams,
  'EFunding:Unknown withdraw key': 'Withdrawal error',
  'EFunding:Invalid amount': orderParams,
  wouldNotReducePosition: futuresPosition,
  // Permanent compliance/jurisdiction blocks. Mirrors the admin-owned
  // `boterrorrules` patterns of the same name so a cold rules cache (and any
  // self-hosted install with no seeded rules) classifies them identically —
  // getErrorSubType consults the DB rules first, so prod behaviour is unchanged.
  'trading restricted for': complianceRestriction,
  'compliance restrictions': complianceRestriction,
  'less than the minimum amount': orderParams,
}

export const getErrorSubType = (string: string): string => {
  // DB-backed rules (boterrorrules, seeded by admin-app; extendable by admins /
  // the Claus reclassifier with no deploy) take precedence over the static
  // dict, so a mislabel can be corrected without shipping code. Falls through
  // to errorDict until the cache first loads. See errorRulesCache.
  const fromRules = matchErrorRuleSubType(string)
  if (fromRules) {
    return fromRules
  }
  for (const [key, value] of Object.entries(errorDict)) {
    if (string.toLowerCase().indexOf(key.toLowerCase()) !== -1) {
      return value
    }
  }
  return 'Uncategorized'
}

export const combineMaps = <T>(
  map1: Map<string, T>,
  map2: Map<string, T>,
): Map<string, T> => {
  const result = new Map()
  map1.forEach((value, key) => {
    result.set(key, value)
  })
  map2.forEach((value, key) => {
    result.set(key, value)
  })
  return result
}

type ReturnBotsByGlobalVars = {
  type: BotType
  total: number
  bots: { _id: string; name: string }[]
}

export type getBotsByGlobalVarOverload = {
  (v: string): Promise<number>
  (v: string, bots: true): Promise<ReturnBotsByGlobalVars[]>
}

type ResponseBot = {
  _id: string
  settings: { name: string }
  vars?: BotVars | null
  status: BotStatusEnum
  paperContext?: boolean
}

const prepareBots = async (bots: ResponseBot[]) => {
  return await Promise.all(
    bots.map(async (b) => {
      let name = b.settings.name ?? ''
      if (b.vars) {
        const findName = b.vars.paths.find((v) => v.path === 'name')
        if (findName) {
          const _var = await globalVarsDb.readData({ _id: findName.variable })
          name = `${_var.data?.result?.value ?? ''}`
        }
      }
      return {
        _id: `${b._id}`,
        name,
        status: b.status,
        paperContext: b.paperContext ?? false,
      }
    }),
  )
}

export const getBotsByGlobalVar: getBotsByGlobalVarOverload = (async (
  v: string,
  bots?: boolean,
) => {
  const filter = {
    isDeleted: { $ne: true },
    'vars.list': v,
  }

  if (bots === true) {
    const fields: ProjectionFields<MainBot> = {
      _id: 1,
      'settings.name': 1,
      vars: 1,
      status: 1,
      paperContext: 1,
    }
    const options = { limit: 500 }
    const findDca = await dcaBotDb.readData<ResponseBot>(
      filter,
      fields,
      options,
      true,
      true,
    )
    const findCombo = await comboBotDb.readData<ResponseBot>(
      filter,
      fields,
      options,
      true,
      true,
    )
    const findGrid = await botDb.readData<ResponseBot>(
      filter,
      fields,
      options,
      true,
      true,
    )
    return [
      {
        type: BotType.dca,
        total: findDca.data?.count ?? 0,
        bots: await prepareBots(findDca.data?.result ?? []),
      },
      {
        type: BotType.combo,
        total: findCombo.data?.count ?? 0,
        bots: await prepareBots(findCombo.data?.result ?? []),
      },
      {
        type: BotType.grid,
        total: findGrid.data?.count ?? 0,
        bots: await prepareBots(findGrid.data?.result ?? []),
      },
    ] as ReturnBotsByGlobalVars[]
  }

  const findDca = await dcaBotDb.countData(filter)
  const findCombo = await comboBotDb.countData(filter)
  const findGrid = await botDb.countData(filter)
  return ((findDca.data?.result ?? 0) +
    (findCombo.data?.result ?? 0) +
    (findGrid.data?.result ?? 0)) as number
}) as getBotsByGlobalVarOverload

export const updateRelatedBotsInVar = async (vars: string[]) => {
  for (const v of vars) {
    const bots = await getBotsByGlobalVar(v)
    await globalVarsDb.updateData({ _id: v }, { $set: { botAmount: bots } })
  }
}

const checkNumber = (num: unknown, notZero = false) =>
  typeof num === 'undefined' ||
  (typeof num === 'number' && !isNaN(num) && (notZero ? num !== 0 : true))

const checkStringAsNumber = (num: unknown, notZero = false) =>
  typeof num === 'undefined' ||
  (typeof num === 'string' && num !== '' && checkNumber(+num, notZero))

const checkString = (str: unknown) =>
  typeof str === 'undefined' || typeof str === 'string'

const checkStringAsEnum = (str: unknown, enumValues: string[]) =>
  typeof str === 'undefined' ||
  (typeof str === 'string' && str !== '' && enumValues.includes(str))

const checkBoolean = (bool: unknown) =>
  typeof bool === 'undefined' ||
  (typeof bool === 'boolean' && !isNaN(bool as unknown as number))

const checkArray = (arr: unknown) =>
  typeof arr === 'undefined' || (Array.isArray(arr) && arr.length > 0)

const allowedSettingsKeys = [
  'ordersCount',
  'tpPerc',
  'slPerc',
  'profitCurrency',
  'avgPrice',
  'orderSize',
  'useTp',
  'useSl',
  'useDca',
  'useSmartOrders',
  'activeOrdersCount',
  'volumeScale',
  'stepScale',
  'dealCloseConditionSL',
  'useMultiSl',
  'multiSl',
  'baseSlOn',
  'comboTpBase',
  'trailingSl',
  'moveSL',
  'moveSLTrigger',
  'moveSLValue',
  'moveSLForAll',
  'dealCloseCondition',
  'closeByTimer',
  'closeByTimerValue',
  'closeByTimerUnits',
  'useMultiTp',
  'multiTp',
  'trailingTp',
  'trailingTpPerc',
  'dcaCondition',
  'dcaCustom',
  'pair',
  'step',
]
const onlyDcaSettingsKeys = [
  'orderSize',
  'dealCloseConditionSL',
  'useMultiSl',
  'multiSl',
  'trailingSl',
  'moveSL',
  'moveSLTrigger',
  'moveSLValue',
  'moveSLForAll',
  'dealCloseCondition',
  'closeByTimer',
  'closeByTimerValue',
  'closeByTimerUnits',
  'useMultiTp',
  'multiTp',
  'trailingTp',
  'trailingTpPerc',
  'dcaCondition',
  'dcaCustom',
  'pair',
]
const onlyComboSettingsKeys = ['comboTpBase']
export const checkDCADealSettings = (
  parentSettings: DCABotSettings | DCADealsSettings,
  settings: Partial<DCADealsSettings>,
  combo: boolean,
  allowedKeys = allowedSettingsKeys,
  onlyDcaKeys = onlyDcaSettingsKeys,
  onlyComboKeys = onlyComboSettingsKeys,
): { status: StatusEnum.ok } | { status: StatusEnum.notok; reason: string } => {
  const keys = Object.keys(settings)
  if (keys.length === 0) {
    return { status: StatusEnum.notok, reason: 'No settings' }
  }

  const multiTpKeys = ['target', 'amount', 'uuid']
  const dcaCustomKeys = ['step', 'size', 'uuid']

  if (!keys.every((k) => allowedKeys.includes(k))) {
    return { status: StatusEnum.notok, reason: 'Unknown settings' }
  }
  if (!combo && keys.some((k) => onlyComboKeys.includes(k))) {
    return {
      status: StatusEnum.notok,
      reason: 'Some settings not supported in DCA deals',
    }
  }
  if (combo && keys.some((k) => onlyDcaKeys.includes(k))) {
    return {
      status: StatusEnum.notok,
      reason: 'Some settings not supported in combo deals',
    }
  }

  const checkTypes =
    checkStringAsNumber(settings.step, true) &&
    checkNumber(settings.ordersCount, true) &&
    checkStringAsNumber(settings.tpPerc, true) &&
    checkStringAsEnum(settings.profitCurrency, ['quote', 'base']) &&
    checkStringAsNumber(settings.baseOrderSize, true) &&
    checkStringAsNumber(settings.orderSize, true) &&
    checkBoolean(settings.useTp) &&
    checkBoolean(settings.useSmartOrders) &&
    checkNumber(settings.activeOrdersCount, true) &&
    checkBoolean(settings.useSl) &&
    checkBoolean(settings.useDca) &&
    checkStringAsNumber(settings.slPerc, true) &&
    checkStringAsNumber(settings.avgPrice, true) &&
    checkStringAsNumber(settings.volumeScale, true) &&
    checkStringAsNumber(settings.stepScale, true) &&
    checkStringAsEnum(settings.dealCloseConditionSL, [CloseConditionEnum.tp]) &&
    checkBoolean(settings.useMultiSl) &&
    checkArray(settings.multiSl) &&
    checkStringAsEnum(settings.baseSlOn, [
      BaseSlOnEnum.start,
      BaseSlOnEnum.avg,
    ]) &&
    checkStringAsEnum(settings.comboTpBase, [
      ComboTpBase.filled,
      ComboTpBase.full,
    ]) &&
    checkBoolean(settings.trailingSl) &&
    checkBoolean(settings.moveSL) &&
    checkStringAsNumber(settings.moveSLTrigger, true) &&
    checkStringAsNumber(settings.moveSLValue, true) &&
    checkStringAsEnum(settings.dealCloseCondition, [CloseConditionEnum.tp]) &&
    checkBoolean(settings.closeByTimer) &&
    checkNumber(settings.closeByTimerValue, true) &&
    checkStringAsEnum(settings.closeByTimerUnits, [
      CooldownUnits.days,
      CooldownUnits.hours,
      CooldownUnits.minutes,
      CooldownUnits.seconds,
    ]) &&
    checkBoolean(settings.useMultiTp) &&
    checkArray(settings.multiTp) &&
    checkBoolean(settings.trailingTp) &&
    checkStringAsNumber(settings.trailingTpPerc, true) &&
    checkStringAsEnum(settings.dcaCondition, [
      DCAConditionEnum.percentage,
      DCAConditionEnum.custom,
    ]) &&
    checkArray(settings.dcaCustom)
  if (!checkTypes) {
    return { status: StatusEnum.notok, reason: 'Wrong settings' }
  }
  if (settings.useMultiSl) {
    if (
      settings.trailingSl ||
      (typeof settings.trailingSl === 'undefined' && parentSettings.trailingSl)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable multi SL with trailing SL',
      }
    }
    if (
      settings.moveSL ||
      (typeof settings.moveSL === 'undefined' && parentSettings.moveSL)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable multi SL with move SL',
      }
    }
    const msl = settings?.multiSl ?? parentSettings?.multiSl
    if (!msl?.length) {
      return { status: StatusEnum.notok, reason: 'No multi sl' }
    }
    const check = msl.every(
      (s) =>
        s.amount &&
        checkStringAsNumber(s.amount, true) &&
        s.target &&
        checkStringAsNumber(s.target, true) &&
        s.uuid,
    )
    if (!check) {
      return { status: StatusEnum.notok, reason: 'Wrong multi sl' }
    }
    const mslKeys = msl.map((s) => s.uuid)
    const mslKeysSet = new Set(mslKeys)
    if (mslKeys.length !== mslKeysSet.size) {
      return { status: StatusEnum.notok, reason: 'Duplicate multi sl uuid' }
    }
    // Validate each item's KEYS are within the allowed set (target/amount/uuid).
    // NB: must check Object.keys(s), not the uuid values — comparing uuid values
    // against the key-name list rejects every real uuid (only the REST API path runs
    // this validator; the GraphQL/UI path does not, which is why the UI was unaffected).
    if (
      !msl.every((s) => Object.keys(s).every((k) => multiTpKeys.includes(k)))
    ) {
      return { status: StatusEnum.notok, reason: 'Unknown multi sl settings' }
    }
  }
  if (settings.trailingSl) {
    if (
      settings.moveSL ||
      (typeof settings.moveSL === 'undefined' && parentSettings.moveSL)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable trailing sl with move SL',
      }
    }
    if (
      settings.useMultiSl ||
      (typeof settings.useMultiSl === 'undefined' && parentSettings.useMultiSl)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable trailing sl with multi SL',
      }
    }
  }
  if (settings.moveSL) {
    if (
      settings.trailingSl ||
      (typeof settings.trailingSl === 'undefined' && parentSettings.trailingSl)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable move SL with trailing SL',
      }
    }
    if (
      settings.useMultiSl ||
      (typeof settings.useMultiSl === 'undefined' && parentSettings.useMultiSl)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable move SL with multi SL',
      }
    }
  }

  if (settings.closeByTimer) {
    if (!settings.closeByTimerUnits) {
      return { status: StatusEnum.notok, reason: 'No close by timer units' }
    }
    if (!settings.closeByTimerValue) {
      return { status: StatusEnum.notok, reason: 'No close by timer value' }
    }
  }

  if (settings.useMultiTp) {
    if (
      settings.trailingTp ||
      (typeof settings.trailingTp === 'undefined' && parentSettings.trailingTp)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable multi TP with trailing TP',
      }
    }
    const mtp = settings?.multiTp ?? parentSettings?.multiTp
    if (!mtp?.length) {
      return { status: StatusEnum.notok, reason: 'No multi tp' }
    }
    const check = mtp.every(
      (s) =>
        s.amount &&
        checkStringAsNumber(s.amount, true) &&
        s.target &&
        checkStringAsNumber(s.target, true) &&
        s.uuid,
    )
    if (!check) {
      return { status: StatusEnum.notok, reason: 'Wrong multi tp' }
    }
    const mtpKeys = mtp.map((s) => s.uuid)
    const mtpKeysSet = new Set(mtpKeys)
    if (mtpKeys.length !== mtpKeysSet.size) {
      return { status: StatusEnum.notok, reason: 'Duplicate multi tp uuid' }
    }
    // Validate each item's KEYS are within the allowed set (target/amount/uuid).
    // NB: must check Object.keys(s), not the uuid values — comparing uuid values
    // against the key-name list rejects every real uuid (only the REST API path runs
    // this validator; the GraphQL/UI path does not, which is why the UI was unaffected).
    if (
      !mtp.every((s) => Object.keys(s).every((k) => multiTpKeys.includes(k)))
    ) {
      return { status: StatusEnum.notok, reason: 'Unknown multi tp settings' }
    }
  }
  if (settings.trailingTp) {
    if (
      settings.useMultiTp ||
      (typeof settings.useMultiTp === 'undefined' && parentSettings.useMultiTp)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot enable trailing TP with multi TP',
      }
    }
    if (!settings.trailingTpPerc) {
      return { status: StatusEnum.notok, reason: 'No trailing tp percent' }
    }
  }

  if (settings.dcaCondition === DCAConditionEnum.custom) {
    const custom = settings?.dcaCustom ?? parentSettings?.dcaCustom
    if (!custom?.length) {
      return { status: StatusEnum.notok, reason: 'No custom dca' }
    }
    const check = custom.every(
      (s) =>
        s.size &&
        checkStringAsNumber(s.size, true) &&
        s.step &&
        checkStringAsNumber(s.step, true) &&
        s.uuid,
    )
    if (!check) {
      return { status: StatusEnum.notok, reason: 'Wrong custom dca' }
    }
    const customKeys = custom.map((s) => s.uuid)
    const customKeysSet = new Set(customKeys)
    if (customKeys.length !== customKeysSet.size) {
      return { status: StatusEnum.notok, reason: 'Duplicate custom dca uuid' }
    }
    if (!customKeys.every((k) => dcaCustomKeys.includes(k))) {
      return { status: StatusEnum.notok, reason: 'Unknown dca custom settings' }
    }
  }

  return { status: StatusEnum.ok }
}

export const checkDCABotSettings = (
  botSettings: DCABotSettings,
  settings: Partial<DCABotSettings>,
  combo: boolean,
): { status: StatusEnum.ok } | { status: StatusEnum.notok; reason: string } => {
  const allowedKeys = [
    ...allowedSettingsKeys,
    'name',
    'baseOrderSize',
    'baseStep',
    'baseGridLevels',
    'gridLevel',
    'orderSizeType',
    'startOrderType',
    'useRiskReduction',
    'riskReductionValue',
    'useReinvest',
    'reinvestValue',
    'skipBalanceCheck',
    'startCondition',
    'maxNumberOfOpenDeals',
    'useStaticPriceFilter',
    'minOpenDeal',
    'maxOpenDeal',
    'useDynamicPriceFilter',
    'dynamicPriceFilterDirection',
    'dynamicPriceFilterOverValue',
    'dynamicPriceFilterUnderValue',
    'dynamicPriceFilterPriceType',
    'useNoOverlapDeals',
    'useCooldown',
    'cooldownAfterDealStart',
    'cooldownAfterDealStartInterval',
    'cooldownAfterDealStartUnits',
    'cooldownAfterDealStop',
    'cooldownAfterDealStopInterval',
    'cooldownAfterDealStopUnits',
    'useActiveMinigrids',
    'comboActiveMinigrids',
    'comboUseSmartGrids',
    'comboSmartGridsCount',
  ]
  const onlyDcaKeys = [...onlyDcaSettingsKeys].filter((v) => v !== 'orderSize')

  const onlyComboKeys = [
    ...onlyComboSettingsKeys,
    'baseStep',
    'baseGridLevels',
    'gridLevel',
    'useActiveMinigrids',
    'comboActiveMinigrids',
    'comboUseSmartGrids',
    'comboSmartGridsCount',
  ]

  const basic = checkDCADealSettings(
    botSettings,
    settings,
    combo,
    allowedKeys,
    onlyDcaKeys,
    onlyComboKeys,
  )
  if (basic.status === StatusEnum.notok) {
    return basic
  }

  const checkTypes =
    checkStringAsNumber(settings.step, true) &&
    checkString(settings.name) &&
    checkStringAsNumber(settings.baseOrderSize, true) &&
    checkStringAsNumber(settings.baseStep, true) &&
    checkStringAsNumber(settings.baseGridLevels, true) &&
    checkStringAsNumber(settings.gridLevel, true) &&
    checkStringAsEnum(settings.orderSizeType, [
      OrderSizeTypeEnum.base,
      OrderSizeTypeEnum.percFree,
      OrderSizeTypeEnum.percTotal,
      OrderSizeTypeEnum.quote,
      OrderSizeTypeEnum.usd,
    ]) &&
    checkStringAsEnum(settings.startOrderType, [
      OrderTypeEnum.limit,
      OrderTypeEnum.market,
    ]) &&
    checkBoolean(settings.useRiskReduction) &&
    checkStringAsNumber(settings.riskReductionValue, true) &&
    checkBoolean(settings.useReinvest) &&
    checkStringAsNumber(settings.reinvestValue, true) &&
    checkBoolean(settings.skipBalanceCheck) &&
    checkStringAsEnum(settings.startCondition, [
      StartConditionEnum.asap,
      StartConditionEnum.manual,
    ]) &&
    checkStringAsNumber(settings.maxNumberOfOpenDeals, true) &&
    checkBoolean(settings.useStaticPriceFilter) &&
    checkStringAsNumber(settings.minOpenDeal, true) &&
    checkStringAsNumber(settings.maxOpenDeal, true) &&
    checkBoolean(settings.useDynamicPriceFilter) &&
    checkStringAsEnum(settings.dynamicPriceFilterDirection, [
      DynamicPriceFilterDirectionEnum.over,
      DynamicPriceFilterDirectionEnum.under,
      DynamicPriceFilterDirectionEnum.overAndUnder,
    ]) &&
    checkStringAsNumber(settings.dynamicPriceFilterOverValue, true) &&
    checkStringAsNumber(settings.dynamicPriceFilterUnderValue, true) &&
    checkStringAsEnum(settings.dynamicPriceFilterPriceType, [
      DynamicPriceFilterPriceTypeEnum.avg,
      DynamicPriceFilterPriceTypeEnum.entry,
    ]) &&
    checkBoolean(settings.useNoOverlapDeals) &&
    checkBoolean(settings.useCooldown) &&
    checkStringAsNumber(settings.cooldownAfterDealStart, true) &&
    checkStringAsEnum(settings.cooldownAfterDealStartUnits, [
      CooldownUnits.days,
      CooldownUnits.hours,
      CooldownUnits.minutes,
      CooldownUnits.seconds,
    ]) &&
    checkNumber(settings.cooldownAfterDealStartInterval, true) &&
    checkStringAsNumber(settings.cooldownAfterDealStop, true) &&
    checkStringAsEnum(settings.cooldownAfterDealStopUnits, [
      CooldownUnits.days,
      CooldownUnits.hours,
      CooldownUnits.minutes,
      CooldownUnits.seconds,
    ]) &&
    checkNumber(settings.cooldownAfterDealStopInterval, true) &&
    checkBoolean(settings.useActiveMinigrids) &&
    checkBoolean(settings.comboUseSmartGrids) &&
    checkStringAsNumber(settings.comboActiveMinigrids, true) &&
    checkNumber(settings.comboSmartGridsCount, true)
  if (!checkTypes) {
    return { status: StatusEnum.notok, reason: 'Wrong settings' }
  }

  if (settings.pair?.length && !botSettings.useMulti) {
    return {
      status: StatusEnum.notok,
      reason: 'Pair update is not supported in single coin bots',
    }
  }

  if (settings.useReinvest) {
    if (!settings.reinvestValue && !botSettings.useReinvest) {
      return {
        status: StatusEnum.notok,
        reason: 'Reinvest value is required',
      }
    }
  }
  if (settings.useRiskReduction) {
    if (!settings.riskReductionValue && !botSettings.useRiskReduction) {
      return {
        status: StatusEnum.notok,
        reason: 'Risk reduction value is required',
      }
    }
  }
  if (
    settings.useStaticPriceFilter &&
    !settings.minOpenDeal &&
    !botSettings.minOpenDeal &&
    !settings.maxOpenDeal &&
    !botSettings.maxOpenDeal
  ) {
    return {
      status: StatusEnum.notok,
      reason: 'Min or max price to open deal is required',
    }
  }
  if (settings.useDynamicPriceFilter) {
    const dir =
      settings.dynamicPriceFilterDirection ??
      botSettings.dynamicPriceFilterDirection
    const priceType =
      settings.dynamicPriceFilterPriceType ??
      botSettings.dynamicPriceFilterPriceType
    if (!priceType) {
      return {
        status: StatusEnum.notok,
        reason: 'Dynamic price filter type is required',
      }
    }
    if (!dir) {
      return {
        status: StatusEnum.notok,
        reason: 'Dynamic price filter direction is required',
      }
    }
    const over =
      settings.dynamicPriceFilterOverValue ??
      botSettings.dynamicPriceFilterOverValue
    const under =
      settings.dynamicPriceFilterUnderValue ??
      botSettings.dynamicPriceFilterUnderValue

    if (dir === DynamicPriceFilterDirectionEnum.over && !over) {
      return {
        status: StatusEnum.notok,
        reason: 'Dynamic price filter over value is required',
      }
    }
    if (dir === DynamicPriceFilterDirectionEnum.under && !under) {
      return {
        status: StatusEnum.notok,
        reason: 'Dynamic price filter under value is required',
      }
    }
    if (
      dir === DynamicPriceFilterDirectionEnum.overAndUnder &&
      (!over || !under)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Dynamic price filter over and under value is required',
      }
    }
  }

  if (settings.cooldownAfterDealStart) {
    const interval =
      settings.cooldownAfterDealStartInterval ??
      botSettings.cooldownAfterDealStartInterval
    const units =
      settings.cooldownAfterDealStartUnits ??
      botSettings.cooldownAfterDealStartUnits
    if (!interval) {
      return {
        status: StatusEnum.notok,
        reason: 'Cooldown after deal start interval is required',
      }
    }
    if (!units) {
      return {
        status: StatusEnum.notok,
        reason: 'Cooldown after deal start units is required',
      }
    }
  }
  if (settings.cooldownAfterDealStop) {
    const interval =
      settings.cooldownAfterDealStopInterval ??
      botSettings.cooldownAfterDealStopInterval
    const units =
      settings.cooldownAfterDealStopUnits ??
      botSettings.cooldownAfterDealStopUnits
    if (!interval) {
      return {
        status: StatusEnum.notok,
        reason: 'Cooldown after deal stop interval is required',
      }
    }
    if (!units) {
      return {
        status: StatusEnum.notok,
        reason: 'Cooldown after deal stop units is required',
      }
    }
  }

  if (combo) {
    if (settings.useActiveMinigrids) {
      if (!settings.comboActiveMinigrids && !botSettings.comboActiveMinigrids) {
        return {
          status: StatusEnum.notok,
          reason: 'Combo active minigrids is required',
        }
      }
    }
    if (settings.comboUseSmartGrids) {
      if (!settings.comboSmartGridsCount && !botSettings.comboSmartGridsCount) {
        return {
          status: StatusEnum.notok,
          reason: 'Combo smart grids count is required',
        }
      }
    }
  }

  return { status: StatusEnum.ok }
}

// OKX Europe X-Perp pairs (e.g. `AAVE-USD_UM_XPERP`) already use the
// canonical dash-separated `base-quote` pair format with a `_UM_XPERP`
// contract-type suffix appended - the `_` in that suffix is not a
// legacy `base_quote` delimiter and must not be split on below.
export const isXperpPair = (pair: string) => /_UM_XPERP$/i.test(pair)

export const convertPairs = async (pairs: string[], exchange: ExchangeEnum) => {
  if (!pairs.length) {
    return []
  }
  const baseAssets: string[] = []
  const quoteAssets: string[] = []
  const pairsOldFormat = pairs.filter((p) => !p.includes('_') || isXperpPair(p))
  pairs.forEach((pair) => {
    if (isXperpPair(pair)) return
    try {
      const [base, quote] = pair.split('_')
      if (base && quote) {
        baseAssets.push(base)
        quoteAssets.push(quote)
      }
    } catch {}
  })
  const pairsFromExchange = await pairDb.readData(
    {
      exchange,
      'baseAsset.name': { $in: baseAssets },
      'quoteAsset.name': { $in: quoteAssets },
    },
    {},
    {},
    true,
  )
  if (pairsFromExchange.status !== StatusEnum.ok) {
    return []
  }
  const exchangePairs: string[] = []
  pairs.forEach((pair) => {
    if (isXperpPair(pair)) return
    try {
      const [base, quote] = pair.split('_')
      if (base && quote) {
        const pairFromExchange = pairsFromExchange.data?.result.find(
          (p) =>
            p.baseAsset.name === base &&
            p.quoteAsset.name === quote &&
            p.exchange === exchange,
        )
        if (pairFromExchange) {
          exchangePairs.push(pairFromExchange.pair)
        }
      }
    } catch {}
  })
  return [...exchangePairs, ...pairsOldFormat]
}

export const checkPairs = async (
  botId: string,
  userId: string,
  botType: BotType,
  symbol: string,
) => {
  const bot =
    botType === BotType.combo
      ? await comboBotDb.readData({ _id: botId, userId })
      : await dcaBotDb.readData({ _id: botId, userId })
  if (bot.status === StatusEnum.notok) {
    return {
      status: StatusEnum.notok as const,
      reason: bot.reason,
      data: null,
    }
  }
  if (!bot.data.result) {
    return {
      status: StatusEnum.notok as const,
      reason: 'Bot not found',
      data: null,
    }
  }
  const convertedPairs = await convertPairs([symbol], bot.data.result.exchange)
  if (!convertedPairs.length) {
    return {
      status: StatusEnum.notok as const,
      reason: 'Symbol not found',
      data: null,
    }
  }
  return {
    status: StatusEnum.ok as const,
    reason: null,
    data: convertedPairs[0],
  }
}
