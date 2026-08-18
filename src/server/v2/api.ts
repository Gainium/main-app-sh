/**
 * API v2.0 Endpoints
 *
 * New API version with field selection support.
 * All endpoints support field selection via query parameter.
 *
 * Examples:
 * - GET /api/v2/bots/dca?fields=minimal
 * - GET /api/v2/bots/dca?fields=id,name,status,settings.pair
 * - GET /api/v2/bots/dca?fields=full
 */

import type { Request, Response } from 'express'
import { Types, isValidObjectId } from 'mongoose'
import {
  StatusEnum,
  BotStatusEnum,
  DCADealStatusEnum,
  UserSchema,
  CreateDCABotInput,
  CreateComboBotInput,
  CreateGridBotInput,
  DCATypeEnum,
  CloseConditionEnum,
  DCAConditionEnum,
  ScaleDcaTypeEnum,
  StartConditionEnum,
  TerminalDealTypeEnum,
  GlobalVariablesTypeEnum,
  OrderSizeTypeEnum,
  AddFundsTypeEnum,
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  CloseGRIDTypeEnum,
  PairsToSetMode,
  BaseReturn,
  ComboBotSettings,
  BotSettings,
} from '../../../types'
import BotInstance from '../../bot'
import allAPI from '../api'
import {
  getBotsByGlobalVar,
  checkDCADealSettings,
  checkDCABotSettings,
  checkPairs,
  isXperpPair,
} from '../../bot/utils'
import {
  dcaBotDb,
  dcaDealsDb,
  comboBotDb,
  comboDealsDb,
  balanceDb,
  botDb,
  userDb as _userDb,
  globalVarsDb,
  feeDb,
  pairDb,
} from '../../db/dbInit'
import DB from '../../db'
import { buildProjection, type FieldSelection } from './fieldUtils'
import { fieldSelectionMiddlewares, paperContextMiddleware } from './middleware'
import { isFutures, isCoinm, isPaper, isServiceUnreachable } from '../../utils'
import { priceBalancesUsd } from '../../utils/user'
import {
  DCA_FORM_DEFAULTS,
  COMBO_FORM_DEFAULTS,
  GRID_FORM_DEFAULTS,
} from './botDefaults'
import type { ResponseMeta } from './types'
import { DCABotSettings } from '../../../types'
import {
  validateCreateDCABotInput,
  validateCreateComboBotInput,
  validateCreateTerminalDealInput,
  validateCreateGridBotInput,
} from './validators/bots'
import {
  validateBotCreationContext,
  findConflictingFuturesPosition,
  terminalDealGuard,
  terminalDealGuardKey,
  isTerminalDealGuardOpen,
  replaceVarsInInput,
  addAditionalFields,
  addIndicatorsDefaults,
  applyGridFuturesConstraints,
  sortFields,
} from './helpers'
import RedisClient from '../../db/redis'
import {
  ServerSideBacktestPayload,
  BacktestRequestStatus,
  BotType,
} from '../../../types'
import {
  dcaBacktestRequestDb,
  comboBacktestRequestDb,
  gridBacktestRequestDb,
  backtestDb as backtestResultDb,
  comboBacktestDb as comboBacktestResultDb,
  gridBacktestDb as gridBacktestResultDb,
} from '../../db/dbInit'
import {
  BACKTEST_SERVICE_TARGET,
  sendServerSideRequest,
} from '../../graphql/handlers/backtest'
import {
  botSchemaDefinitions,
  indicatorDefinitions,
  indicatorGroupFieldDefinitions,
} from './definitions/generated'

type APIMap = Map<
  string,
  {
    handler: (req: Request, res: Response) => void
    middlewares: any[]
    ignoreMiddlewares?: any[]
  }
>

const defaultPaginations = {
  bots: 10,
  deals: 20,
  balances: 100,
  globalVars: 100,
}

export type CreateDCABotInputRaw = Partial<DCABotSettings> & {
  exchangeUUID?: string
  vars?: { path: string; variable: string }[]
}

export type CreateGridBotInputRaw = Partial<CreateGridBotInput> & {
  exchangeUUID?: string
  vars?: { path: string; variable: string }[]
}

/**
 * Convert camelCase to kebab-case for URL paths
 */
const camelToKebab = (str: string): string => {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Transform v1 API route to v2 with kebab-case
 */
const transformV1RouteToV2 = (route: string): string => {
  // Replace /api/ with /api/v2/
  const v2Route = route.replace('/api/', '/api/v2/')

  // Split by / and convert each segment to kebab-case
  return v2Route
    .split('/')
    .map((segment) => camelToKebab(segment))
    .join('/')
}

/**
 * Validate global variable value matches its type
 */
const validateGlobalVariableValue = (
  value: string,
  type: GlobalVariablesTypeEnum,
): { valid: boolean; error?: string } => {
  if (type === GlobalVariablesTypeEnum.int) {
    const parsed = parseInt(value, 10)
    if (isNaN(parsed) || parsed.toString() !== value) {
      return {
        valid: false,
        error: 'Value must be a valid integer',
      }
    }
  } else if (type === GlobalVariablesTypeEnum.float) {
    const parsed = parseFloat(value)
    if (isNaN(parsed)) {
      return {
        valid: false,
        error: 'Value must be a valid float number',
      }
    }
  } else if (type === GlobalVariablesTypeEnum.text) {
    if (typeof value !== 'string') {
      return {
        valid: false,
        error: 'Value must be a string',
      }
    }
  }
  return { valid: true }
}

const v2API = <R extends UserSchema = UserSchema>(
  userDb: DB<R> = _userDb as unknown as DB<R>,
  Bot: BotInstance = BotInstance.getInstance(),
) => {
  const get: APIMap = new Map()
  const post: APIMap = new Map()
  const put: APIMap = new Map()
  const deleteMap: APIMap = new Map()

  /**
   * GET /api/v2/bots/dca
   *
   * List DCA bots with field selection
   *
   * Query params:
   * - fields: Field selection (minimal|standard|extended|full|custom list)
   * - status: Filter by status
   * - page: Page number (default: 1)
   *
   * Headers:
   * - paper-context: true|false (optional, defaults to false)
   *
   * Examples:
   * - ?fields=minimal (default)
   * - ?fields=standard
   * - ?fields=id,name,status,settings.pair,profit.total
   * - ?fields=full
   */
  get.set('/api/v2/bots/dca', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('bots.dca'),
    ],
    handler: async (req, res) => {
      const {
        status,
        page: _page,
      }: {
        status?: BotStatusEnum
        page?: string
      } = req.query

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      // Validate status
      const validStatuses = [
        BotStatusEnum.closed,
        BotStatusEnum.error,
        BotStatusEnum.open,
        BotStatusEnum.archive,
        BotStatusEnum.range,
        BotStatusEnum.monitoring,
      ]
      if (status && !validStatuses.includes(status)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid status parameter',
          data: null,
        })
        return
      }

      // Validate and parse page
      const page = _page && !isNaN(+_page) ? +_page : 1

      // Build MongoDB filter
      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
        parentBotId: { $exists: false },
      }

      if (status) {
        filter.status = status
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      // Build MongoDB projection from selected fields
      const projection = buildProjection(fields || null)

      // Query database with projection
      const limit = defaultPaginations.bots
      const skip = (page - 1) * limit

      try {
        const result = await dcaBotDb.readData(
          filter,
          projection,
          { sort: { created: -1 }, skip, limit },
          true, // returnArray
          true, // count
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(result.data.count / limit),
          count: result.data.count,
          onPage: result.data.result.length,
          // fields will be added by middleware
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/bots/combo
   *
   * List Combo bots with field selection
   */
  get.set('/api/v2/bots/combo', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('bots.combo'),
    ],
    handler: async (req, res) => {
      const {
        status,
        page: _page,
      }: {
        status?: BotStatusEnum
        page?: string
      } = req.query

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      const validStatuses = [
        BotStatusEnum.closed,
        BotStatusEnum.error,
        BotStatusEnum.open,
        BotStatusEnum.archive,
        BotStatusEnum.range,
        BotStatusEnum.monitoring,
      ]
      if (status && !validStatuses.includes(status)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid status parameter',
          data: null,
        })
        return
      }

      const page = _page && !isNaN(+_page) ? +_page : 1

      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
        parentBotId: { $exists: false },
      }

      if (status) {
        filter.status = status
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      const projection = buildProjection(fields || null)
      const limit = defaultPaginations.bots
      const skip = (page - 1) * limit

      try {
        const result = await comboBotDb.readData(
          filter,
          projection,
          { sort: { created: -1 }, skip, limit },
          true,
          true,
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(result.data.count / limit),
          count: result.data.count,
          onPage: result.data.result.length,
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/deals/:dealType
   *
   * List deals with field selection (DCA, Combo, or Terminal)
   *
   * URL params:
   * - dealType: Type of deals to retrieve (dca, combo, terminal)
   *
   * Query params:
   * - fields: Field selection
   * - status: Filter by status
   * - paperContext: Filter by paper context
   * - page: Page number
   * - botId: Filter by bot ID
   */
  get.set('/api/v2/deals/:dealType', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('deals.dca'),
    ],
    handler: async (req, res) => {
      const { dealType } = req.params
      const {
        status,
        page: _page,
        botId,
      }: {
        status?: DCADealStatusEnum
        page?: string
        botId?: string
      } = req.query

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      // Validate dealType
      if (!['dca', 'combo', 'terminal'].includes(dealType)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid deal type. Must be one of: dca, combo, terminal',
          data: null,
        })
        return
      }

      const validStatuses = [
        DCADealStatusEnum.closed,
        DCADealStatusEnum.error,
        DCADealStatusEnum.open,
        DCADealStatusEnum.start,
        DCADealStatusEnum.canceled,
      ]

      if (status && !validStatuses.includes(status)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid status parameter',
          data: null,
        })
        return
      }

      const page = _page && !isNaN(+_page) ? +_page : 1

      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
      }

      // Apply deal type specific filters
      if (dealType === 'dca') {
        filter.type = { $ne: 'terminal' }
      } else if (dealType === 'terminal') {
        filter.type = { $eq: 'terminal' }
      }
      // combo has no terminal filter

      if (status) {
        filter.status = status
      }

      if (botId) {
        filter.botId = botId
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      const projection = buildProjection(fields || null)
      const limit = defaultPaginations.deals
      const skip = (page - 1) * limit

      try {
        const isCombo = dealType === 'combo'

        // The exact total for a given filter changes slowly (a user's deal
        // count moves only as deals open/close), so cache it briefly instead of
        // running a full countDocuments on every page load. meta.count/total stay
        // exact within the short TTL. Best-effort: any cache error falls back to a
        // live count, so correctness never depends on Redis.
        const countKey = `dealsCount:${dealType}:${JSON.stringify(filter)}`
        let cachedCount: number | null = null
        try {
          const redis = await RedisClient.getInstance()
          const raw = await redis.get(countKey)
          if (raw != null && raw !== '') cachedCount = Number(raw)
        } catch {
          // ignore cache read failure
        }

        // Fetch the page WITHOUT the count (countNeed=false); the count comes
        // from the cache or a separate countData below.
        const result = isCombo
          ? await comboDealsDb.readData(
              filter,
              projection,
              { sort: { createTime: -1 }, skip, limit },
              true,
              false,
            )
          : await dcaDealsDb.readData(
              filter,
              projection,
              { sort: { createTime: -1 }, skip, limit },
              true,
              false,
            )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        let count = cachedCount
        if (count === null) {
          const countRes = isCombo
            ? await comboDealsDb.countData(filter)
            : await dcaDealsDb.countData(filter)
          count =
            countRes.status === StatusEnum.ok
              ? countRes.data.result
              : result.data.result.length
          try {
            const redis = await RedisClient.getInstance()
            await redis.set(countKey, String(count), 60)
          } catch {
            // ignore cache write failure
          }
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(count / limit),
          count,
          onPage: result.data.result.length,
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/deals/:dealType/details
   *
   * Fetch a single deal by its ID.
   * dealType: dca | combo | terminal
   *
   * Query params:
   * - dealId: MongoDB ObjectId or UUID (required)
   * - fields: Field selection (minimal|standard|extended|full|custom list)
   *
   * Headers:
   * - paper-context: true|false (optional, defaults to false)
   */
  get.set('/api/v2/deals/:dealType/details', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('deals.dca'),
    ],
    handler: async (req, res) => {
      const { dealType } = req.params
      const { dealId }: { dealId?: string } = req.query

      if (!['dca', 'combo', 'terminal'].includes(dealType)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid deal type. Must be one of: dca, combo, terminal',
          data: null,
        })
        return
      }

      if (!dealId) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'dealId query parameter is required',
          data: null,
        })
        return
      }

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
        $or: [
          { _id: isValidObjectId(dealId) ? new Types.ObjectId(dealId) : null },
          { uuid: dealId },
        ],
      }

      if (dealType === 'dca') {
        filter.type = { $ne: 'terminal' }
      } else if (dealType === 'terminal') {
        filter.type = { $eq: 'terminal' }
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      const projection = buildProjection(fields || null)

      try {
        const db = dealType === 'combo' ? comboDealsDb : dcaDealsDb

        const result = await (db as typeof comboDealsDb).readData(
          filter,
          projection,
          {},
          false,
          false,
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        if (!result.data?.result) {
          res.status(404).send({
            status: StatusEnum.notok,
            reason: 'Deal not found',
            data: null,
          })
          return
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/user/exchanges
   *
   * List user exchanges with field selection
   *
   * Query params:
   * - fields: Field selection
   *
   * Headers:
   * - paper-context: true|false (optional, defaults to false)
   */
  get.set('/api/v2/user/exchanges', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const paperContext = req.paperContext

      if (!user) {
        res.status(403).send({
          status: StatusEnum.notok,
          reason: 'User not found',
        })
        return
      }

      try {
        const exchanges = await userDb.readData(
          {
            _id: new Types.ObjectId(user.id),
          },
          { exchanges: 1 },
        )

        if (exchanges.status === StatusEnum.notok) {
          res.status(403).send({
            status: StatusEnum.notok,
            reason: 'Unknown error',
          })
          return
        }

        const result = (exchanges.data?.result?.exchanges ?? [])
          .filter((b) =>
            paperContext === null || paperContext === undefined
              ? true
              : paperContext
                ? isPaper(b.provider)
                : !isPaper(b.provider),
          )
          .map((exchange) => ({
            code: exchange.provider,
            market: isFutures(exchange.provider) ? 'futures' : 'spot',
            type: isFutures(exchange.provider)
              ? isCoinm(exchange.provider)
                ? 'inverse'
                : 'linear'
              : undefined,
            id: exchange.uuid,
            name: exchange.name,
          }))

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
        })
      }
    },
  })

  /**
   * GET /api/v2/user/balances
   *
   * List user balances with field selection
   *
   * Query params:
   * - fields: Field selection
   * - paperContext: Filter by paper context
   * - page: Page number
   * - exchangeId: Filter by exchange UUID
   * - assets: Comma-separated list of assets to filter
   */
  get.set('/api/v2/user/balances', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('balances'),
    ],
    handler: async (req, res) => {
      const {
        page: _page,
        exchangeId: _exchangeId,
        assets: _assets,
        withUsd: _withUsd,
      }: {
        page?: string
        exchangeId?: string
        assets?: string
        withUsd?: string
      } = req.query

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false
      // Opt-in USD valuation. Off by default so the response shape is unchanged
      // for existing consumers (dashboards, gainium-mcp, n8n, extension).
      const withUsd = _withUsd === 'true' || _withUsd === '1'

      // Parse assets filter
      let assets: string[] = []
      if (typeof _assets !== 'undefined' && _assets) {
        if (typeof _assets === 'string') {
          assets = _assets.split(',').map((a) => `${a}`.trim())
        } else {
          res.status(400).send({
            status: StatusEnum.notok,
            reason: 'Assets should be a comma-separated string',
            data: null,
          })
          return
        }
      }
      assets = [...new Set(assets)]

      const exchangeId = _exchangeId ? `${_exchangeId}`.trim() : ''
      let page = _page ? +_page : 1
      if (isNaN(page) || page <= 0 || !isFinite(page)) {
        page = 1
      }

      const limit = defaultPaginations.balances

      const filter: Record<string, unknown> = {
        userId: `${user.id}`,
      }

      if (exchangeId) {
        filter.exchangeUUID = exchangeId
      }

      if (!exchangeId) {
        filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
      }

      if (assets.length > 0) {
        filter.asset = { $in: assets }
      }

      const projection = buildProjection(fields || null)

      try {
        const balances = await balanceDb.readData(
          filter,
          projection,
          { sort: { asset: 1 }, skip: (page - 1) * limit, limit },
          true,
          true,
        )

        if (balances.status === StatusEnum.notok) {
          res.status(500).send(balances)
          return
        }

        // Opt-in: value each balance in USD via the same authoritative path the
        // portfolio snapshot cron uses (crypto rate table + tokenized-stock
        // fallback). Best-effort — a valuation failure must not fail the call.
        let usdMap = new Map<string, { price: number; usdValue: number }>()
        if (withUsd) {
          try {
            usdMap = await priceBalancesUsd(balances.data?.result ?? [])
          } catch (e) {
            console.error('v2 balances usd valuation error:', e)
          }
        }

        const result = (balances.data?.result ?? []).map((b: any) => {
          const priced = withUsd
            ? usdMap.get(`${b.exchangeUUID ?? ''}:${b.asset}`)
            : undefined
          return {
            ...b,
            exchangeMarket: isFutures(b.exchange) ? 'futures' : 'spot',
            exchangeType: isFutures(b.exchange)
              ? isCoinm(b.exchange)
                ? 'inverse'
                : 'linear'
              : undefined,
            ...(withUsd
              ? { price: priced?.price ?? 0, usdValue: priced?.usdValue ?? 0 }
              : {}),
          }
        })

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(balances.data.count / limit),
          count: balances.data.count,
          onPage: balances.data.result.length,
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/user/global-vars
   *
   * List global variables
   *
   * Query params:
   * - page: Page number (default: 1)
   */
  get.set('/api/v2/user/global-vars', {
    middlewares: [],
    handler: async (req, res) => {
      const { page: _page }: { page?: string } = req.query
      const user = req.userData

      const page = _page && !isNaN(+_page) ? +_page : 1

      const filter: Record<string, any> = {
        userId: user.id,
      }

      const limit = defaultPaginations.globalVars
      const skip = (page - 1) * limit

      try {
        const result = await globalVarsDb.readData(
          filter,
          {},
          { sort: { created: -1 }, skip, limit },
          true,
          true,
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(result.data.count / limit),
          count: result.data.count,
          onPage: result.data.result.length,
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/bots/grid
   *
   * List Grid bots with field selection
   *
   * Query params:
   * - fields: Field selection (minimal|standard|extended|full|custom list)
   * - status: Filter by status
   * - paperContext: Filter by paper context (true|false)
   * - page: Page number (default: 1)
   */
  get.set('/api/v2/bots/grid', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('bots.grid'),
    ],
    handler: async (req, res) => {
      const {
        status,
        page: _page,
      }: {
        status?: BotStatusEnum
        page?: string
      } = req.query

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      const validStatuses = [
        BotStatusEnum.closed,
        BotStatusEnum.error,
        BotStatusEnum.open,
        BotStatusEnum.archive,
        BotStatusEnum.range,
        BotStatusEnum.monitoring,
      ]
      if (status && !validStatuses.includes(status)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid status parameter',
          data: null,
        })
        return
      }

      const page = _page && !isNaN(+_page) ? +_page : 1

      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
      }

      if (status) {
        filter.status = status
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      const projection = buildProjection(fields || null)
      const limit = defaultPaginations.bots
      const skip = (page - 1) * limit

      try {
        const result = await botDb.readData(
          filter,
          projection,
          { sort: { created: -1 }, skip, limit },
          true,
          true,
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(result.data.count / limit),
          count: result.data.count,
          onPage: result.data.result.length,
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
          meta,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/bots/:botType/details
   *
   * Fetch a single bot by its ID.
   * botType: dca | combo | grid
   *
   * Query params:
   * - botId: MongoDB ObjectId or UUID (required)
   * - fields: Field selection (minimal|standard|extended|full|custom list)
   *
   * Headers:
   * - paper-context: true|false (optional, defaults to false)
   */
  get.set('/api/v2/bots/:botType/details', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('bots.dca'), // field presets are the same across all bot types
    ],
    handler: async (req, res) => {
      const { botType } = req.params
      const { botId }: { botId?: string } = req.query

      if (!['dca', 'combo', 'grid'].includes(botType)) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
          data: null,
        })
        return
      }

      if (!botId) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'botId query parameter is required',
          data: null,
        })
        return
      }

      const user = req.userData
      const fields = req.fieldSelection
      const paperContext = req.paperContext || false

      const filter: Record<string, any> = {
        userId: user.id,
        isDeleted: { $ne: true },
        $or: [
          { _id: isValidObjectId(botId) ? new Types.ObjectId(botId) : null },
          { uuid: botId },
        ],
      }

      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }

      const projection = buildProjection(fields || null)

      try {
        const db =
          botType === 'combo'
            ? comboBotDb
            : botType === 'grid'
              ? botDb
              : dcaBotDb

        const result = await (db as typeof comboBotDb).readData(
          filter,
          projection,
          {},
          false,
          false,
        )

        if (result.status === StatusEnum.notok) {
          res.status(500).send(result)
          return
        }

        if (!result.data?.result) {
          res.status(404).send({
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          })
          return
        }

        res.send({
          status: StatusEnum.ok,
          reason: null,
          data: result.data.result,
        })
      } catch (error) {
        res.status(500).send({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * GET /api/v2/backtest/:botType/requests
   *
   * List backtest requests for the current user with pagination.
   * Sorted from newest to oldest (10 per page by default).
   *
   * URL params:
   * - botType: dca | combo | grid
   *
   * Query params:
   * - page: page number (default 1)
   * - fields: comma-separated field list. Fields prefixed with "backtest."
   *   (e.g. backtest.financial, backtest.settings) are resolved from the
   *   corresponding backtest result collection and returned under the
   *   "backtest" key on each item.
   *
   * Response:
   * - 200: List of backtest requests with optional embedded backtest result
   * - 400: Invalid botType
   * - 500: Internal server error
   */
  get.set('/api/v2/backtest/:botType/requests', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('backtest.requests'),
    ],
    handler: async (req, res) => {
      const user = req.userData
      const { botType } = req.params
      const { page: _page }: { page?: string } = req.query
      const rawFields = req.fieldSelection

      if (!['dca', 'combo', 'grid'].includes(botType!)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be dca, combo, or grid.',
          data: null,
        })
      }

      const page = Math.max(1, parseInt(_page || '1', 10) || 1)
      const limit = 10
      const skip = (page - 1) * limit

      // Split fieldSelection: request fields vs backtest.* fields
      const includeBacktest =
        !rawFields || rawFields.some((f) => f.startsWith('backtest'))
      const backtestFieldsList: string[] | null = rawFields
        ? rawFields
            .filter((f) => f.startsWith('backtest.'))
            .map((f) => f.slice('backtest.'.length))
        : null // null → all backtest fields

      let requestFieldsList: string[] | null = rawFields
        ? rawFields.filter((f) => !f.startsWith('backtest'))
        : null // null → all request fields

      // Ensure backtestId is always fetched when we need to do the lookup
      if (
        includeBacktest &&
        requestFieldsList !== null &&
        !requestFieldsList.includes('backtestId')
      ) {
        requestFieldsList = [...requestFieldsList, 'backtestId']
      }

      const requestProjection = buildProjection(requestFieldsList)
      const backtestProjection = buildProjection(backtestFieldsList)
      if (
        backtestProjection &&
        Object.keys(backtestProjection).length > 0 &&
        !('shareId' in backtestProjection)
      ) {
        backtestProjection.shareId = 1
      }
      const requestDb =
        botType === BotType.dca
          ? dcaBacktestRequestDb
          : botType === BotType.combo
            ? comboBacktestRequestDb
            : gridBacktestRequestDb

      const resultDb =
        botType === BotType.dca
          ? backtestResultDb
          : botType === BotType.combo
            ? comboBacktestResultDb
            : gridBacktestResultDb

      try {
        const result = await requestDb.readData(
          { userId: user.id },
          requestProjection,
          { sort: { created: -1 }, skip, limit },
          true,
          true,
        )

        if (result.status === StatusEnum.notok) {
          return res.status(500).json(result)
        }

        let items: any[] = result.data.result

        // Resolve backtest results in a single batched query
        if (includeBacktest) {
          const backtestIds: string[] = items
            .filter((r: any) => r.backtestId)
            .map((r: any) => r.backtestId)
          const backtestMap: Record<string, any> = {}
          if (backtestIds.length > 0) {
            const backtestsResult = await (resultDb as any).readData(
              { shareId: { $in: backtestIds } },
              backtestProjection,
              {},
              true,
              false,
            )
            if (
              backtestsResult.status === StatusEnum.ok &&
              Array.isArray(backtestsResult.data?.result)
            ) {
              for (const bt of backtestsResult.data.result) {
                if (bt.shareId) {
                  backtestMap[bt.shareId] = bt
                }
              }
            }
          }

          items = items.map((r: any) => ({
            ...r,
            backtest: r.backtestId ? (backtestMap[r.backtestId] ?? null) : null,
          }))
        }

        const meta: ResponseMeta = {
          page,
          total: Math.ceil(result.data.count / limit),
          count: result.data.count,
          onPage: items.length,
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: items,
          meta,
        })
      } catch (error) {
        return res.status(500).json({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * Fetch a single backtest request item by ID, optionally embedding the linked
   * backtest result under the `backtest` key.
   *
   * Shared by the GET-by-id handler and the sync wait loop.
   */
  const fetchBacktestRequestItem = async (
    botType: string,
    requestId: string,
    userId: string,
    rawFields: FieldSelection,
  ): Promise<{ status: StatusEnum; data: any; reason: string | null }> => {
    const includeBacktest =
      !rawFields || rawFields.some((f) => f.startsWith('backtest.'))
    const backtestFieldsList: string[] | null = rawFields
      ? rawFields
          .filter((f) => f.startsWith('backtest.'))
          .map((f) => f.slice('backtest.'.length))
      : null

    let requestFieldsList: string[] | null = rawFields
      ? rawFields.filter((f) => !f.startsWith('backtest.'))
      : null

    if (
      includeBacktest &&
      requestFieldsList !== null &&
      !requestFieldsList.includes('backtestId')
    ) {
      requestFieldsList = [...requestFieldsList, 'backtestId']
    }

    const requestProjection = buildProjection(requestFieldsList)
    const backtestProjection = buildProjection(backtestFieldsList)

    const requestDb =
      botType === BotType.dca
        ? dcaBacktestRequestDb
        : botType === BotType.combo
          ? comboBacktestRequestDb
          : gridBacktestRequestDb

    const resultDb =
      botType === BotType.dca
        ? backtestResultDb
        : botType === BotType.combo
          ? comboBacktestResultDb
          : gridBacktestResultDb

    const result = await requestDb.readData(
      { _id: requestId, userId },
      requestProjection,
    )

    if (result.status === StatusEnum.notok) {
      return {
        status: StatusEnum.notok,
        data: null,
        reason: result.reason || 'Failed to read backtest request',
      }
    }

    if (!result.data?.result) {
      return {
        status: StatusEnum.notok,
        data: null,
        reason: 'Backtest request not found.',
      }
    }

    let item: any = result.data.result

    if (includeBacktest && item.backtestId) {
      const backtestResult = await (resultDb as any).readData(
        { shareId: item.backtestId },
        backtestProjection,
      )
      item = {
        ...item,
        backtest:
          backtestResult.status === StatusEnum.ok && backtestResult.data?.result
            ? backtestResult.data.result
            : null,
      }
    } else if (includeBacktest) {
      item = { ...item, backtest: null }
    }

    return { status: StatusEnum.ok, data: item, reason: null }
  }

  /**
   * Poll the DB every 10 s until the request reaches a terminal status
   * (success | failed) or the 1-hour timeout elapses.
   * On completion: returns the full request item (same as GET-by-id).
   * On timeout: returns { requestId, message } so the client can poll later.
   */
  const waitForBacktestCompletion = (
    botType: string,
    requestId: string,
    userId: string,
    rawFields: FieldSelection,
    timeoutMs = 3_600_000, // 1 hour
  ): Promise<{ status: StatusEnum; data: any; reason: string | null }> => {
    const terminal = new Set<BacktestRequestStatus>([
      BacktestRequestStatus.success,
      BacktestRequestStatus.failed,
    ])

    const requestDb =
      botType === BotType.dca
        ? dcaBacktestRequestDb
        : botType === BotType.combo
          ? comboBacktestRequestDb
          : gridBacktestRequestDb

    return new Promise((resolve) => {
      const startedAt = Date.now()
      const LOG_INTERVAL_POLLS = 60 // 60 × 10 s = 10 min
      let pollCount = 0

      const log = (msg: string) =>
        console.log(
          `[backtest:sync] botType=${botType} requestId=${requestId} userId=${userId} ${msg}`,
        )

      log('started — polling every 10 s, timeout 1 h')

      const deadlineHandle = setTimeout(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 60_000)
        log(`timed out after ${elapsed} min — returning requestId to client`)
        resolve({
          status: StatusEnum.ok,
          data: {
            requestId,
            message:
              'Backtest did not complete within 1 hour. Use GET /api/v2/backtest/{botType}/requests/{id} to check the result when ready.',
          },
          reason: null,
        })
      }, timeoutMs)

      const poll = () => {
        pollCount++
        requestDb
          .readData({ _id: requestId, userId }, { status: 1 } as any)
          .then((statusResult) => {
            if (
              statusResult.status === StatusEnum.ok &&
              statusResult.data?.result &&
              terminal.has(
                statusResult.data.result.status as BacktestRequestStatus,
              )
            ) {
              clearTimeout(deadlineHandle)
              const elapsed = Math.round((Date.now() - startedAt) / 1_000)
              const terminalStatus = statusResult.data.result.status
              log(`completed with status=${terminalStatus} after ${elapsed} s`)
              resolve(
                fetchBacktestRequestItem(botType, requestId, userId, rawFields),
              )
            } else {
              if (pollCount % LOG_INTERVAL_POLLS === 0) {
                const elapsed = Math.round((Date.now() - startedAt) / 60_000)
                const currentStatus =
                  statusResult.data?.result?.status ?? 'unknown'
                log(
                  `still waiting — elapsed ${elapsed} min, status=${currentStatus}`,
                )
              }
              setTimeout(poll, 10_000)
            }
          })
          .catch((err) => {
            if (pollCount % LOG_INTERVAL_POLLS === 0) {
              log(`poll error (suppressed): ${err?.message ?? err}`)
            }
            setTimeout(poll, 10_000)
          })
      }

      setTimeout(poll, 10_000)
    })
  }

  /**
   * GET /api/v2/discovery/bots
   *
   * Returns schema definitions for all bot types (dca, combo, grid).
   * Each definition contains sections, and each section lists all fields
   * with their type, validators, constraints and default value.
   */
  get.set('/api/v2/discovery/bots', {
    middlewares: [],
    handler: (_req, res) => {
      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data: botSchemaDefinitions,
      })
    },
  })

  /**
   * GET /api/v2/discovery/bots/:botType
   *
   * Returns the full schema definition for a single bot type.
   * Optional query param ?section=<id> returns only that one section.
   */
  get.set('/api/v2/discovery/bots/:botType', {
    middlewares: [],
    handler: (req, res) => {
      const { botType } = req.params
      const { section } = req.query as { section?: string }
      const schema = botSchemaDefinitions.find((s) => s.botType === botType)
      if (!schema) {
        return res.status(404).json({
          status: StatusEnum.notok,
          reason: `Unknown bot type "${botType}". Valid values: dca, combo, grid.`,
          data: null,
        })
      }
      if (section) {
        const found = schema.sections.find((s) => s.id === section)
        if (!found) {
          const available = schema.sections.map((s) => s.id).join(', ')
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: `Section "${section}" not found for ${botType}. Available: ${available}.`,
            data: null,
          })
        }
        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: found,
        })
      }
      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data: schema,
      })
    },
  })

  /**
   * GET /api/v2/discovery/bots/:botType/sections
   *
   * Returns a lightweight summary of all sections for a bot type:
   * id, name, description and field count — without full field definitions.
   */
  get.set('/api/v2/discovery/bots/:botType/sections', {
    middlewares: [],
    handler: (req, res) => {
      const { botType } = req.params
      const schema = botSchemaDefinitions.find((s) => s.botType === botType)
      if (!schema) {
        return res.status(404).json({
          status: StatusEnum.notok,
          reason: `Unknown bot type "${botType}". Valid values: dca, combo, grid.`,
          data: null,
        })
      }
      const data = schema.sections.map(({ id, name, description, fields }) => ({
        id,
        name,
        description,
        fieldCount: fields.length,
      }))
      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data,
      })
    },
  })

  // Supported candlestick intervals per exchange (values from ExchangeIntervals enum).
  // Used to filter the indicatorInterval enum when ?exchange= is provided.
  const ALL_INTERVALS = [
    '1m',
    '3m',
    '5m',
    '15m',
    '30m',
    '1h',
    '2h',
    '4h',
    '8h',
    '1d',
    '1w',
  ]
  const EXCHANGE_INTERVAL_MAP: Record<string, string[]> = (() => {
    const binance = [
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '8h',
      '1d',
      '1w',
    ]
    const bitget = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']
    const bybit = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']
    const kucoin = [
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '8h',
      '1d',
      '1w',
    ]
    const kucoinFutures = [
      '1m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '8h',
      '1d',
      '1w',
    ]
    const okx = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']
    const coinbase = ['1m', '5m', '15m', '30m', '1h', '2h', '1d']
    const mexc = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']
    const kraken = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']
    return {
      binance,
      binanceUS: binance,
      paperBinance: binance,
      binanceCoinm: binance,
      binanceUsdm: binance,
      paperBinanceCoinm: binance,
      paperBinanceUsdm: binance,
      bitget,
      paperBitget: bitget,
      bitgetUsdm: bitget,
      bitgetCoinm: bitget,
      paperBitgetUsdm: bitget,
      paperBitgetCoinm: bitget,
      bybit,
      paperBybit: bybit,
      bybitInverse: bybit,
      bybitLinear: bybit,
      paperBybitInverse: bybit,
      paperBybitLinear: bybit,
      kucoin,
      paperKucoin: kucoin,
      kucoinLinear: kucoinFutures,
      kucoinInverse: kucoinFutures,
      paperKucoinLinear: kucoinFutures,
      paperKucoinInverse: kucoinFutures,
      okx,
      paperOkx: okx,
      okxLinear: okx,
      okxInverse: okx,
      paperOkxLinear: okx,
      paperOkxInverse: okx,
      coinbase,
      paperCoinbase: coinbase,
      mexc,
      paperMexc: mexc,
      kraken,
      paperKraken: kraken,
      krakenUsdm: kraken,
      krakenCoinm: kraken,
      paperKrakenUsdm: kraken,
      paperKrakenCoinm: kraken,
    }
  })()

  // Group schema embedded in every full indicator detail response.
  // Teaches an AI agent how to create indicatorGroups entries and link indicators to them.
  const INDICATOR_GROUP_DEFINITION = {
    description:
      'Indicators must be placed in an indicator group. ' +
      "The bot settings object contains two parallel arrays: 'indicators' and 'indicatorGroups'. " +
      "Each indicator references its group via the 'groupId' field, which must equal the 'id' " +
      "of an existing entry in 'indicatorGroups'. " +
      "The group's 'action' must match the indicator's 'indicatorAction', and the group's 'section' " +
      "must match the indicator's 'section'. " +
      "The group's 'logic' ('and'/'or') controls how triggers are combined within that group. " +
      'Multiple groups that share the same action+section are always ANDed together.',
    rules: [
      'Every indicator must have a non-empty groupId that equals the id of an entry in settings.indicatorGroups.',
      'Never generate a groupId without first creating the corresponding group object.',
      "A group's action must exactly equal the indicator's indicatorAction.",
      "A group's section must exactly equal the indicator's section (or both must be absent/undefined).",
      'Never mix indicators with different indicatorAction or section values in the same group.',
      "Indicators within a group are combined using the group's logic field ('and' = all must trigger, 'or' = any must trigger).",
      'Multiple groups for the same action+section are ANDed: every group must trigger before the condition fires.',
    ],
    fields: indicatorGroupFieldDefinitions,
  }

  /**
   * GET /api/v2/discovery/indicators
   *
   * Returns a summary list of all supported indicator types.
   *
   * Query params:
   * - action: filter to indicators whose supportedActions includes this value (e.g. "startDca")
   * - exchange: when provided, adds a supportedIntervals field to each item
   *   with the intervals available on that exchange (e.g. "binance")
   */
  get.set('/api/v2/discovery/indicators', {
    middlewares: [],
    handler: (req, res) => {
      const { action, exchange } = req.query as Record<
        string,
        string | undefined
      >
      const intervals = exchange
        ? (EXCHANGE_INTERVAL_MAP[exchange] ?? ALL_INTERVALS)
        : null
      let list = indicatorDefinitions
      if (action) {
        list = list.filter((i) => i.supportedActions.includes(action))
      }
      const summaries = list.map(
        ({ type, name, description, supportedActions, supportedSections }) => ({
          type,
          name,
          description,
          supportedActions,
          supportedSections,
          ...(intervals ? { supportedIntervals: intervals } : {}),
        }),
      )
      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data: summaries,
      })
    },
  })

  /**
   * GET /api/v2/discovery/indicators/:type
   *
   * Returns the full field definition for a single indicator type.
   *
   * Query params:
   * - exchange: when provided, filters the indicatorInterval enum in coreFields
   *   to only include intervals supported by the given exchange (e.g. "binance")
   */
  get.set('/api/v2/discovery/indicators/:type', {
    middlewares: [],
    handler: (req, res) => {
      const { type } = req.params
      const { exchange } = req.query as Record<string, string | undefined>
      const indicator = indicatorDefinitions.find((i) => i.type === type)
      if (!indicator) {
        return res.status(404).json({
          status: StatusEnum.notok,
          reason: `Unknown indicator type "${type}".`,
          data: null,
        })
      }
      if (exchange) {
        const intervals = EXCHANGE_INTERVAL_MAP[exchange] ?? ALL_INTERVALS
        const filtered = {
          ...indicator,
          groupDefinition: INDICATOR_GROUP_DEFINITION,
          coreFields: indicator.coreFields.map((f) =>
            f.name === 'indicatorInterval' ? { ...f, enum: intervals } : f,
          ),
        }
        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: filtered,
        })
      }
      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data: { ...indicator, groupDefinition: INDICATOR_GROUP_DEFINITION },
      })
    },
  })

  /**
   * GET /api/v2/backtest/:botType/requests/:id
   *
   * Get a single backtest request by ID.
   *
   * URL params:
   * - botType: dca | combo | grid
   * - id: MongoDB ObjectId of the backtest request
   *
   * Query params:
   * - fields: comma-separated field list. Fields prefixed with "backtest."
   *   are resolved from the corresponding backtest result collection and
   *   returned under the "backtest" key on the response item.
   *
   * Response:
   * - 200: Backtest request object with optional embedded backtest result
   * - 400: Invalid botType or missing id
   * - 404: Not found
   * - 500: Internal server error
   */
  get.set('/api/v2/backtest/:botType/requests/:id', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('backtest.requests'),
    ],
    handler: async (req, res) => {
      const user = req.userData
      const { botType, id } = req.params
      const rawFields = req.fieldSelection ?? null

      if (!['dca', 'combo', 'grid'].includes(botType!)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be dca, combo, or grid.',
          data: null,
        })
      }

      if (!id) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Request ID is required.',
          data: null,
        })
      }

      try {
        const result = await fetchBacktestRequestItem(
          botType!,
          id,
          user.id,
          rawFields,
        )

        if (result.status === StatusEnum.notok) {
          if (result.reason === 'Backtest request not found.') {
            return res.status(404).json({ ...result, data: null })
          }
          return res.status(500).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: result.data,
        })
      } catch (error) {
        return res.status(500).json({
          status: StatusEnum.notok,
          reason: 'Internal server error',
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/user/global-vars
   *
   * Create a new global variable
   *
   * Body: { name: string, type: GlobalVariablesTypeEnum, value: string }
   *
   * Response:
   * - 200: Global variable created successfully
   * - 400: Validation error
   * - 500: Internal server error
   */
  post.set('/api/v2/user/global-vars', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { name, type, value } = req.body as {
        name?: string
        type?: GlobalVariablesTypeEnum
        value?: string
      }

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Name is required and must be a non-empty string',
        })
      }

      if (
        !type ||
        !Object.values(GlobalVariablesTypeEnum).includes(type as any)
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: `Type is required and must be one of: ${Object.values(GlobalVariablesTypeEnum).join(', ')}`,
        })
      }

      if (value === undefined || value === null) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Value is required',
        })
      }

      // Validate value matches type
      const valueValidation = validateGlobalVariableValue(value, type)
      if (!valueValidation.valid) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: valueValidation.error,
        })
      }

      try {
        const result = await globalVarsDb.createData({
          name: name.trim(),
          type,
          value,
          botAmount: 0,
          userId: user.id,
        })

        if (result.status === StatusEnum.notok) {
          return res.status(500).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            id: result.data._id?.toString(),
            name: result.data.name,
            type: result.data.type,
            value: result.data.value,
            botAmount: result.data.botAmount,
          },
        })
      } catch (error) {
        console.error('Error creating global variable:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to create global variable',
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/dca
   *
   * Create a new DCA bot
   *
   * Body: CreateDCABotInput (DCABotSettings + exchangeUUID + vars)
   * Query: ?paperContext=true|false (optional, defaults to false for real trading)
   *
   * Response:
   * - 200: Bot created successfully with botId and uuid
   * - 400: Validation error (missing exchangeUUID, exchange not found, etc.)
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/dca', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const input = req.body as CreateDCABotInputRaw

      // Validate context (exchange, paperContext, etc.)
      const contextValidation = await validateBotCreationContext(
        input,
        user.id,
        userDb,
        res,
        req.paperContext || false,
      )
      if (!contextValidation.valid) return

      const { userData, exchange, paperContext } = contextValidation

      // 5. Merge defaults with user input, then override exchange-specific fields
      let settings: CreateDCABotInput = {
        ...DCA_FORM_DEFAULTS,
        ...input,
        type: DCATypeEnum.regular,
        // Override futures/coinm based on exchange provider (not user input!)
        ...addAditionalFields(input, exchange),
      }

      settings = addIndicatorsDefaults(settings)

      settings = await replaceVarsInInput(settings, userData._id.toString())

      const validate = await validateCreateDCABotInput(
        settings,
        input,
        userData._id,
      )
      if (!validate.valid) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Validation error',
          errors: validate.errors,
        })
      }
      // 7. Call Bot.createDCABot
      try {
        const bot = await Bot.createDCABot(
          userData._id.toString(),
          validate.data,
          paperContext,
        )

        // Check if bot creation was successful
        if (bot.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: bot.reason || 'Failed to create DCA bot',
          })
        }

        // Extract bot data from response
        const botData = bot.data

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            botId: botData._id.toString(),
            uuid: botData.uuid,
            message: 'DCA bot created successfully',
            settings: sortFields(botData.settings),
          },
        })
      } catch (error: unknown) {
        console.error('Error creating DCA bot:', error)

        // Return error message directly in reason
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error ? error.message : 'Failed to create DCA bot',
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/combo
   *
   * Create a new Combo bot
   *
   * Body: CreateComboBotInput (ComboBotSettings + exchangeUUID + vars)
   * Query: ?paperContext=true|false (optional, defaults to false for real trading)
   *
   * Response:
   * - 200: Bot created successfully with botId and uuid
   * - 400: Validation error (missing exchangeUUID, exchange not found, etc.)
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/combo', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const input = req.body as CreateDCABotInputRaw

      // Validate context (exchange, paperContext, etc.)
      const contextValidation = await validateBotCreationContext(
        input,
        user.id,
        userDb,
        res,
        req.paperContext || false,
      )
      if (!contextValidation.valid) return

      const { userData, exchange, paperContext } = contextValidation

      // 5. Merge defaults with user input, then override exchange-specific fields
      let settings: CreateComboBotInput = {
        ...COMBO_FORM_DEFAULTS,
        ...input,
        dealCloseCondition: CloseConditionEnum.tp,
        dealCloseConditionSL: CloseConditionEnum.tp,
        dcaCondition: DCAConditionEnum.percentage,
        scaleDcaType: ScaleDcaTypeEnum.percentage,
        type: DCATypeEnum.regular,
        // Override futures/coinm based on exchange provider (not user input!)
        ...addAditionalFields(input, exchange),
      }

      settings = addIndicatorsDefaults(settings)

      settings = await replaceVarsInInput(settings, userData._id.toString())

      const validate = await validateCreateComboBotInput(
        settings,
        input,
        userData._id,
      )
      if (!validate.valid) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Validation error',
          errors: validate.errors,
        })
      }
      // 7. Call Bot.createComboBot
      try {
        const bot = await Bot.createComboBot(
          userData._id.toString(),
          validate.data as CreateComboBotInput,
          paperContext,
        )

        // Check if bot creation was successful
        if (bot.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: bot.reason || 'Failed to create Combo bot',
          })
        }

        // Extract bot data from response
        const botData = bot.data

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            botId: botData._id.toString(),
            uuid: botData.uuid,
            message: 'Combo bot created successfully',
            settings: sortFields(botData.settings),
          },
        })
      } catch (error: unknown) {
        console.error('Error creating Combo bot:', error)

        // Return error message directly in reason
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to create Combo bot',
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/terminal
   *
   * Create a new Terminal Deal (one-time trade)
   *
   * Body: CreateDCABotInput with type=terminal and terminalDealType
   * Query: ?paperContext=true|false (optional, defaults to false for real trading)
   *
   * Response:
   * - 200: Deal created successfully with botId and uuid
   * - 400: Validation error (missing exchangeUUID, exchange not found, etc.)
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/terminal', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const input = req.body as CreateDCABotInputRaw

      // Validate context (exchange, paperContext, etc.)
      const contextValidation = await validateBotCreationContext(
        input,
        user.id,
        userDb,
        res,
        req.paperContext || false,
      )
      if (!contextValidation.valid) return

      const { userData, exchange, paperContext } = contextValidation

      // 5. Merge defaults with user input, then override exchange-specific fields
      let settings: CreateDCABotInput = {
        ...DCA_FORM_DEFAULTS,
        ...input,
        pair: [input.pair ?? ''].flat(),
        dcaCondition: DCAConditionEnum.percentage,
        scaleDcaType: ScaleDcaTypeEnum.percentage,
        startCondition: StartConditionEnum.asap,
        terminalDealType: input.terminalDealType ?? TerminalDealTypeEnum.smart,
        type: DCATypeEnum.terminal,
        // Override futures/coinm based on exchange provider (not user input!)
        ...addAditionalFields(input, exchange, true),
      }

      settings = addIndicatorsDefaults(settings)

      const validate = await validateCreateTerminalDealInput(
        settings,
        input,
        userData._id,
      )
      if (!validate.valid) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Validation error',
          errors: validate.errors,
        })
      }
      // A terminal deal that the engine will refuse to start is rejected here
      // rather than created and dropped a few milliseconds later in the bot
      // worker — see `findConflictingFuturesPosition`.
      //
      // A caller that ignores that answer and re-sends is answered from Redis
      // instead, so the position read is not paid for again — see
      // `terminalDealGuard`. The breaker is consulted BEFORE the check it is
      // standing in for, which is the whole point of it.
      const guardKey = terminalDealGuardKey(
        `${userData._id}`,
        exchange.uuid,
        [validate.data.pair].flat()[0] ?? '',
        'position-conflict',
      )
      const cooldown = await terminalDealGuard.check(guardKey)
      if (isTerminalDealGuardOpen(cooldown)) {
        return res
          .status(429)
          .set(
            'Retry-After',
            `${Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000))}`,
          )
          .json({
            status: StatusEnum.notok,
            reason: cooldown.reason,
          })
      }

      const positionConflict = await findConflictingFuturesPosition(
        exchange,
        validate.data,
      )
      if (positionConflict) {
        await terminalDealGuard.record(guardKey, positionConflict)
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: positionConflict,
        })
      }

      // 7. Call Bot.createDCABot with terminal type
      try {
        const bot = await Bot.createDCABot(
          userData._id.toString(),
          validate.data,
          paperContext,
        )

        // Check if bot creation was successful
        if (bot.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: bot.reason || 'Failed to create Terminal deal',
          })
        }

        // Extract bot data from response
        const botData = bot.data

        // The constraint the breaker was counting is demonstrably gone.
        await terminalDealGuard.clear(guardKey)

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            botId: botData._id.toString(),
            uuid: botData.uuid,
            message:
              'Terminal deal created successfully and scheduled for execution',
          },
        })
      } catch (error: unknown) {
        console.error('Error creating Terminal deal:', error)

        // Return error message directly in reason
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to create Terminal deal',
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/grid
   *
   * Create a new Grid bot
   *
   * Body: CreateGridBotInput (BotSettings + exchangeUUID + vars)
   * Query: ?paperContext=true|false (optional, defaults to false for real trading)
   *
   * Response:
   * - 200: Bot created successfully with botId and uuid
   * - 400: Validation error (missing exchangeUUID, exchange not found, etc.)
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/grid', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const input = req.body as CreateGridBotInputRaw

      // Validate context (exchange, paperContext, etc.)
      const contextValidation = await validateBotCreationContext(
        input as any,
        user.id,
        userDb,
        res,
        req.paperContext || false,
      )
      if (!contextValidation.valid) return

      const { userData, exchange, paperContext } = contextValidation

      // Merge defaults with user input, then override exchange-specific fields
      const settings: CreateGridBotInput = applyGridFuturesConstraints({
        ...GRID_FORM_DEFAULTS,
        ...input,
        // Override futures/coinm based on exchange provider (not user input!)
        ...addAditionalFields(input, exchange),
      } as CreateGridBotInput)

      delete (settings as any).vars

      const validate = await validateCreateGridBotInput(
        settings as any,
        input as any,
      )
      if (!validate.valid) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Validation error',
          errors: validate.errors,
        })
      }

      // Call Bot.createBot (for grid bots)
      try {
        const bot = await Bot.createBot(
          userData._id.toString(),
          validate.data as any,
          paperContext,
        )

        // Check if bot creation was successful
        if (bot.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: bot.reason || 'Failed to create grid bot',
          })
        }

        // Extract bot data from response
        const botData = bot.data

        const botId = botData?.botId?.toString() || ''

        if (!botId) {
          return res.status(500).json({
            status: StatusEnum.notok,
            reason: 'Failed to retrieve created bot ID',
          })
        }

        const findBot = await botDb.readData({
          _id: botId,
          userId: userData._id.toString(),
        })

        if (findBot.status === StatusEnum.notok || !findBot.data) {
          return res.status(500).json({
            status: StatusEnum.notok,
            reason: 'Failed to retrieve created bot from database',
          })
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            botId,
            message: 'Grid bot created successfully',
            settings: sortFields(findBot.data.result.settings),
          },
        })
      } catch (error: unknown) {
        console.error('Error creating grid bot:', error)

        // Return error message directly in reason
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to create grid bot',
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/terminal/:dealId/add-funds
   *
   * Add funds to a terminal deal
   *
   * Body: { qty: string, asset?: OrderSizeTypeEnum, symbol?: string, type?: AddFundsTypeEnum }
   *
   * Response:
   * - 200: Funds added successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/terminal/:dealId/add-funds', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { dealId } = req.params
      const { qty, asset, symbol, type } = req.body as {
        qty?: string
        asset?: OrderSizeTypeEnum
        symbol?: string
        type?: AddFundsTypeEnum
      }

      if (!dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Deal ID is required',
        })
      }

      const fundsType = type || AddFundsTypeEnum.fixed

      if (!qty || (fundsType === AddFundsTypeEnum.fixed && !asset)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing required parameters',
        })
      }

      if (
        typeof qty !== 'string' ||
        (asset &&
          (typeof asset !== 'string' ||
            ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
              asset,
            ))) ||
        (symbol && typeof symbol !== 'string') ||
        (type &&
          ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      try {
        // Fetch the terminal deal to get botId
        const deal = await dcaDealsDb.readData({
          _id: dealId,
          userId: user.id,
          type: { $eq: DCATypeEnum.terminal },
          status: {
            $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
          },
        })

        if (deal.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: deal.reason,
          })
        }

        if (!deal.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: 'Terminal deal not found',
          })
        }

        const botId = deal.data.result.botId

        // Call the Bot method with botId
        const result = await Bot.addDealFundsFromPublicApi(
          user.id,
          botId,
          qty,
          asset!,
          symbol,
          fundsType,
          dealId,
        )

        return res.status(200).json(result)
      } catch (error) {
        console.error('Error adding funds to terminal deal:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to add funds to terminal deal',
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/terminal/:dealId/reduce-funds
   *
   * Reduce funds from a terminal deal
   *
   * Body: { qty: string, asset?: OrderSizeTypeEnum, symbol?: string, type?: AddFundsTypeEnum }
   *
   * Response:
   * - 200: Funds reduced successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/terminal/:dealId/reduce-funds', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { dealId } = req.params
      const { qty, asset, symbol, type } = req.body as {
        qty?: string
        asset?: OrderSizeTypeEnum
        symbol?: string
        type?: AddFundsTypeEnum
      }

      if (!dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Deal ID is required',
        })
      }

      const fundsType = type || AddFundsTypeEnum.fixed

      if (!qty || (fundsType === AddFundsTypeEnum.fixed && !asset)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing required parameters',
        })
      }

      if (
        typeof qty !== 'string' ||
        (asset &&
          (typeof asset !== 'string' ||
            ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
              asset,
            ))) ||
        (symbol && typeof symbol !== 'string') ||
        (type &&
          ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      try {
        // Fetch the terminal deal to get botId
        const deal = await dcaDealsDb.readData({
          _id: dealId,
          userId: user.id,
          type: { $eq: DCATypeEnum.terminal },
          status: {
            $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
          },
        })

        if (deal.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: deal.reason,
          })
        }

        if (!deal.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: 'Terminal deal not found',
          })
        }

        const botId = deal.data.result.botId

        // Call the Bot method with botId
        const result = await Bot.reduceDealFundsFromPublicApi(
          user.id,
          botId,
          qty,
          asset!,
          symbol,
          fundsType,
          dealId,
        )

        return res.status(200).json(result)
      } catch (error) {
        console.error('Error reducing funds from terminal deal:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to reduce funds from terminal deal',
        })
      }
    },
  })

  /**
   * PUT /api/v2/bots/:botType/:botId
   *
   * Update bot settings (DCA or Combo)
   *
   * URL params:
   * - botType: Type of bot (dca, combo)
   * - botId: ID of the bot to update
   *
   * Body: Partial bot settings to update
   *
   * Response:
   * - 200: Bot updated successfully
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  put.set('/api/v2/bots/:botType/:botId', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params
      const settings = req.body

      // Validate botType
      if (!['dca', 'combo'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo',
        })
      }

      if (!botId || !settings) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing required parameters',
        })
      }

      if (typeof botId !== 'string' || typeof settings !== 'object') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      try {
        //  Fetch bot based on type
        const bot =
          botType === 'combo'
            ? await comboBotDb.readData({ _id: botId, userId: user.id })
            : await dcaBotDb.readData({ _id: botId, userId: user.id })

        if (bot.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: bot.reason,
          })
        }

        if (!bot.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: 'Bot not found',
          })
        }

        const check = checkDCABotSettings(
          bot.data.result.settings,
          settings,
          botType === 'combo',
        )
        if (check.status === StatusEnum.notok) {
          return res.status(400).json(check)
        }

        const { pair, ...rest } = settings
        let pairToUse = pair

        if (pair?.length) {
          const updatePairs = await Bot.changeDCABotPairs(
            user.id,
            botId,
            '',
            undefined,
            pair,
            PairsToSetMode.replace,
            true,
          )
          if (updatePairs.status === StatusEnum.notok) {
            if (updatePairs.reason === 'Nothing changed') {
              pairToUse = undefined
            } else {
              return res.status(400).json(updatePairs)
            }
          } else {
            pairToUse = updatePairs.data.current
          }
        }

        const result =
          botType === 'combo'
            ? await Bot.changeComboBot(
                {
                  ...rest,
                  pair: pairToUse,
                  id: botId,
                  vars: bot.data.result.vars,
                },
                user.id,
                !!bot.data.result.paperContext,
              )
            : await Bot.changeDCABot(
                {
                  ...rest,
                  pair: pairToUse,
                  id: botId,
                  vars: bot.data.result.vars,
                },
                user.id,
                !!bot.data.result.paperContext,
              )

        if (result && result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: 'Settings updated',
        })
      } catch (error) {
        console.error(`Error updating ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to update ${botType} bot`,
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/:botType/:botId/start
   *
   * Start a bot (DCA, Combo, or Grid)
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot to start
   *
   * Query: ?paperContext=true|false (optional)
   *
   * Response:
   * - 200: Bot scheduled to start
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/:botType/:botId/start', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params
      const paperContext = req.paperContext || false

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
          data: null,
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
          data: null,
        })
      }

      if (typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot ID',
          data: null,
        })
      }

      try {
        const result = await Bot.changeStatus(
          user.id,
          {
            status: BotStatusEnum.open,
            id: botId,
            type: botType as any,
          },
          paperContext,
        )

        if (result && result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: 'Bot scheduled to start',
        })
      } catch (error) {
        console.error(`Error starting ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to start ${botType} bot`,
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/:botType/:botId/stop
   *
   * Stop a bot (DCA, Combo, or Grid)
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot to stop
   *
   * Query params:
   * - paperContext: true|false (optional)
   * - cancelPartiallyFilled: true|false (optional)
   * - closeType: cancel|closeByLimit|closeByMarket|leave (for DCA/Combo)
   * - closeGridType: cancel|closeByLimit|closeByMarket (for Grid)
   *
   * Response:
   * - 200: Bot scheduled to stop
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/:botType/:botId/stop', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params
      const paperContext = req.paperContext || false
      const { cancelPartiallyFilled, closeType, closeGridType } = req.query as {
        cancelPartiallyFilled?: string
        closeType?: CloseDCATypeEnum
        closeGridType?: CloseGRIDTypeEnum
      }

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
          data: null,
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
          data: null,
        })
      }

      if (typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot ID',
          data: null,
        })
      }

      try {
        const result = await Bot.changeStatus(
          user.id,
          {
            status: BotStatusEnum.closed,
            id: botId,
            type: botType as any,
            cancelPartiallyFilled: cancelPartiallyFilled === 'true',
            closeType: closeType ?? CloseDCATypeEnum.leave,
            closeGridType,
          },
          paperContext,
        )

        if (result && result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: 'Bot scheduled to stop',
        })
      } catch (error) {
        console.error(`Error stopping ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to stop ${botType} bot`,
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/:botType/:botId/restore
   *
   * Restore an archived bot
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot to restore
   *
   * Response:
   * - 200: Bot restored successfully
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/:botType/:botId/restore', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
          data: null,
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
          data: null,
        })
      }

      if (typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot ID',
          data: null,
        })
      }

      try {
        const result = await Bot.setArchiveStatus(
          user.id,
          botType as any,
          [botId],
          false,
        )

        if (result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: 'Bot restored',
        })
      } catch (error) {
        console.error(`Error restoring ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to restore ${botType} bot`,
          data: null,
        })
      }
    },
  })

  /**
   * DELETE /api/v2/bots/:botType/:botId
   *
   * Archive a bot
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot to archive
   *
   * Response:
   * - 200: Bot archived successfully
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  deleteMap.set('/api/v2/bots/:botType/:botId', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
          data: null,
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
          data: null,
        })
      }

      if (typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot ID',
          data: null,
        })
      }

      try {
        const result = await Bot.setArchiveStatus(
          user.id,
          botType as any,
          [botId],
          true,
        )

        if (result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: 'Bot archived',
        })
      } catch (error) {
        console.error(`Error archiving ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to archive ${botType} bot`,
          data: null,
        })
      }
    },
  })

  /**
   * PUT /api/v2/bots/:botType/:botId/pairs
   *
   * Change bot trading pairs
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot
   *
   * Body: { pairsToChange?: { add?: string[], remove?: string[] }, pairsToSet?: string[], pairsToSetMode?: PairsToSetMode }
   *
   * Response:
   * - 200: Pairs updated successfully
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  put.set('/api/v2/bots/:botType/:botId/pairs', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params
      const { pairsToChange, pairsToSet, pairsToSetMode } = req.body as {
        pairsToChange?: { add?: string[]; remove?: string[] }
        pairsToSet?: string[]
        pairsToSetMode?: PairsToSetMode
      }

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
        })
      }

      if (!pairsToChange && !pairsToSet) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Either pairsToChange or pairsToSet must be provided',
        })
      }

      if (
        typeof botId !== 'string' ||
        (pairsToChange && typeof pairsToChange !== 'object') ||
        (pairsToSet && typeof pairsToSet !== 'object') ||
        (pairsToSetMode &&
          (typeof pairsToSetMode !== 'string' ||
            !Object.values(PairsToSetMode)
              .filter((v) => isNaN(+v))
              .includes(pairsToSetMode)))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      if (pairsToSet && !pairsToSet.length) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Pairs cannot be empty',
        })
      }

      if (
        pairsToChange &&
        ((!pairsToChange.add && !pairsToChange.remove) ||
          (!(pairsToChange.add ?? []).length &&
            !(pairsToChange.remove ?? []).length))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Pairs cannot be empty',
        })
      }

      try {
        const result = await Bot.changeDCABotPairs(
          user.id,
          botId,
          '',
          pairsToChange,
          pairsToSet,
          pairsToSetMode,
        )

        if (result.status === StatusEnum.notok) {
          return res.status(400).json(result)
        }

        return res.status(200).json(result)
      } catch (error) {
        console.error(`Error changing ${botType} bot pairs:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to change ${botType} bot pairs`,
        })
      }
    },
  })

  /**
   * POST /api/v2/bots/:botType/:botId/clone
   *
   * Clone a bot with optional setting overrides
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   * - botId: ID of the bot to clone
   *
   * Query: ?paperContext=true|false (optional)
   * Body: Partial bot settings to override (all optional)
   *
   * Response:
   * - 200: Bot cloned successfully with botId
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  post.set('/api/v2/bots/:botType/:botId/clone', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const { botId, botType } = req.params
      const paperContext = req.paperContext || false
      const settingsOverrides = req.body

      // Validate botType
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be one of: dca, combo, grid',
        })
      }

      if (!botId || typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing or invalid botId parameter',
        })
      }

      try {
        // Fetch the existing bot based on bot type
        const existingBot =
          botType === 'grid'
            ? await botDb.readData({
                _id: botId,
                userId: user.id,
                paperContext: paperContext ? { $eq: true } : { $ne: true },
                isDeleted: { $ne: true },
                exchangeUnassigned: { $ne: true },
              })
            : botType === 'combo'
              ? await comboBotDb.readData({
                  _id: botId,
                  userId: user.id,
                  paperContext: paperContext ? { $eq: true } : { $ne: true },
                  isDeleted: { $ne: true },
                  exchangeUnassigned: { $ne: true },
                })
              : await dcaBotDb.readData({
                  _id: botId,
                  userId: user.id,
                  paperContext: paperContext ? { $eq: true } : { $ne: true },
                  isDeleted: { $ne: true },
                  exchangeUnassigned: { $ne: true },
                })

        if (
          existingBot.status === StatusEnum.notok ||
          !existingBot.data.result
        ) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: `${botType.toUpperCase()} bot not found`,
          })
        }

        const sourceBot = existingBot.data.result

        // Get user data for validation
        const userData = await userDb.readData({
          _id: new Types.ObjectId(user.id),
        })

        if (userData.status === StatusEnum.notok || !userData.data.result) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: 'User not found',
          })
        }

        // Find the exchange
        const exchange = userData.data.result.exchanges.find(
          (ex) => ex.uuid === sourceBot.exchangeUUID,
        )

        if (!exchange) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: 'Exchange not found',
          })
        }

        const { pair: _pair, ...rest } = settingsOverrides ?? {}
        let pair = _pair

        // Validate pair if provided (skip for grid bots as they have different settings type)
        const check =
          Object.keys(rest ?? {}).length > 0 && botType !== 'grid'
            ? checkDCABotSettings(
                sourceBot.settings as any,
                rest ?? {},
                botType === 'combo',
              )
            : { status: StatusEnum.ok }

        if (check.status === StatusEnum.notok) {
          return res.status(400).json(check)
        }

        if (pair?.length) {
          const pairsValidation = await Bot.checkPairs(sourceBot.exchange, pair)
          if (pairsValidation.status === StatusEnum.notok) {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: `Invalid pair: ${pair}`,
            })
          }
          pair =
            botType === 'grid'
              ? pair
              : (pairsValidation.data?.map((p) => p.pair) ?? [])
        }

        // Combine settings: source bot + overrides
        const symbol = sourceBot.symbol as any
        const combinedSettings = {
          ...sourceBot.settings,
          ...(settingsOverrides ?? {}),
          pair: pair?.length
            ? pair
            : botType === 'grid'
              ? `${symbol.baseAsset}_${symbol.quoteAsset}`
              : sourceBot.settings.pair,
        }

        // Auto-append (clone) to name if not overridden
        if (sourceBot.settings.name && !settingsOverrides?.name) {
          combinedSettings.name = `${sourceBot.settings.name} (clone)`
        }

        const vars = sourceBot.vars
        if (rest && vars) {
          vars.paths = vars.paths.filter((p: any) => !(p.path in rest))
          const v = vars.paths.map((p: any) => p.variable)
          vars.list = vars.list.filter((l: any) => v.includes(l))
        }

        // Create the cloned bot using appropriate method
        let result

        if (botType === 'grid') {
          delete (combinedSettings as any).vars
          delete combinedSettings.updatedBudget
          delete combinedSettings.newProfit
          delete combinedSettings.newBalance
          delete (combinedSettings as any)._id

          const finalSettings = {
            ...combinedSettings,
            ...addAditionalFields(combinedSettings, exchange),
          }

          result = await Bot.createBot(
            userData.data.result._id.toString(),
            finalSettings as any,
            paperContext,
          )
        } else {
          result =
            botType === 'combo'
              ? await Bot.createComboBot(
                  userData.data.result._id.toString(),
                  {
                    ...Bot.removeNullableValuesFromSettings(combinedSettings),
                    exchange: sourceBot.exchange,
                    exchangeUUID: sourceBot.exchangeUUID,
                    vars,
                  } as any,
                  paperContext,
                )
              : await Bot.createDCABot(
                  userData.data.result._id.toString(),
                  {
                    ...Bot.removeNullableValuesFromSettings(combinedSettings),
                    exchange: sourceBot.exchange,
                    exchangeUUID: sourceBot.exchangeUUID,
                    vars,
                  } as any,
                  paperContext,
                )
        }

        if (result.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: result.reason || `Failed to clone ${botType} bot`,
          })
        }

        if (!result.data) {
          return res.status(500).json({
            status: StatusEnum.notok,
            reason: 'Failed to retrieve cloned bot data',
          })
        }

        const clonedBotId =
          botType === 'grid'
            ? (result.data as any).botId?.toString()
            : (result.data as any)._id.toString()

        if (!clonedBotId) {
          return res.status(500).json({
            status: StatusEnum.notok,
            reason: 'Failed to retrieve cloned bot ID',
          })
        }

        // For grid bots, fetch the created bot details
        if (botType === 'grid') {
          const findBot = await botDb.readData({
            _id: clonedBotId,
            userId: userData.data.result._id.toString(),
          })

          if (findBot.status === StatusEnum.notok || !findBot.data) {
            return res.status(500).json({
              status: StatusEnum.notok,
              reason: 'Failed to retrieve cloned bot from database',
            })
          }
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            botId: clonedBotId,
            message: `${botType.toUpperCase()} bot cloned successfully`,
          },
        })
      } catch (error) {
        console.error(`Error cloning ${botType} bot:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to clone ${botType} bot`,
        })
      }
    },
  })

  /**
   * PUT /api/v2/deals/:dealType/:dealId
   *
   * Update deal settings (DCA or Combo)
   *
   * URL params:
   * - dealType: Type of deal (dca, combo, terminal)
   * - dealId: ID of the deal to update
   *
   * Body: Partial deal settings to update
   *
   * Response:
   * - 200: Deal updated successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  put.set('/api/v2/deals/:dealType/:dealId', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { dealId, dealType } = req.params
      const settings = req.body

      // Validate dealType
      if (!['dca', 'combo', 'terminal'].includes(dealType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid deal type. Must be one of: dca, combo, terminal',
        })
      }

      if (!dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Deal ID is required',
        })
      }

      if (!settings || typeof settings !== 'object') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Settings must be provided as an object',
        })
      }

      try {
        // Check if deal exists, belongs to user, and is not closed/canceled
        const deal =
          dealType === 'combo'
            ? await comboDealsDb.readData({
                _id: dealId,
                userId: user.id,
                status: {
                  $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
                },
              })
            : await dcaDealsDb.readData({
                _id: dealId,
                userId: user.id,
                ...(dealType === DCATypeEnum.terminal
                  ? { type: { $eq: DCATypeEnum.terminal } }
                  : {}),
                status: {
                  $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
                },
              })

        if (deal.status === StatusEnum.notok) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: deal.reason,
          })
        }

        if (!deal.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: `${dealType} deal not found`,
          })
        }

        // Validate settings
        const check = checkDCADealSettings(
          deal.data.result.settings,
          settings,
          dealType === 'combo',
        )

        if (check.status === StatusEnum.notok) {
          return res.status(400).json(check)
        }

        // Update deal settings
        const result =
          dealType === 'combo'
            ? await Bot.updateComboDealSettings(user.id, '', dealId, settings)
            : await Bot.updateDCADealSettings(user.id, '', dealId, settings)

        return res.status(200).json(result)
      } catch (error) {
        console.error(`Error updating ${dealType} deal settings:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to update ${dealType} deal settings`,
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/:dealType/:dealId/start
   *
   * Start a new deal (for DCA or Combo bots)
   *
   * URL params:
   * - dealType: Type of deal (dca, combo)
   * - dealId: Bot ID to start deal for
   *
   * Body: { symbol?: string }
   *
   * Response:
   * - 200: Deal started successfully
   * - 400: Validation error or bot not found
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/:dealType/:dealId/start', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { dealId: botId, dealType } = req.params
      const { symbol } = req.body as { symbol?: string }

      // Validate dealType
      if (!['dca', 'combo'].includes(dealType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid deal type. Must be one of: dca, combo',
          data: null,
        })
      }

      if (!botId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID is required',
          data: null,
        })
      }

      if (typeof botId !== 'string') {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot ID',
          data: null,
        })
      }

      try {
        let convertedSymbol = symbol

        if (typeof symbol !== 'undefined') {
          const convertedPairs = await checkPairs(
            botId,
            user.id,
            dealType as any,
            symbol,
          )
          if (convertedPairs.status === StatusEnum.notok) {
            return res.status(400).json(convertedPairs)
          }
          convertedSymbol = convertedPairs.data
        }

        const result =
          dealType === 'combo'
            ? await Bot.openComboDeal(user.id, botId, convertedSymbol)
            : await Bot.openDCADeal(user.id, botId, convertedSymbol)

        return res.status(200).json(result)
      } catch (error) {
        console.error(`Error starting ${dealType} deal:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to start ${dealType} deal`,
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/dca/add-funds
   *
   * Add funds to a deal (works for all deal types)
   *
   *
   * Body: { qty: string, asset?: OrderSizeTypeEnum, symbol?: string, type?: AddFundsTypeEnum, }
   *
   * Response:
   * - 200: Funds added successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/dca/add-funds', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { qty, asset, symbol, type } = req.body as {
        qty?: string
        asset?: OrderSizeTypeEnum
        symbol?: string
        type?: AddFundsTypeEnum
      }

      const { botId, dealId } = req.query as { botId?: string; dealId?: string }

      if (!botId && !dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID or Deal ID required',
        })
      }

      const fundsType = type || AddFundsTypeEnum.fixed

      if (!qty || (fundsType === AddFundsTypeEnum.fixed && !asset)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing required parameters',
        })
      }

      if (
        (typeof botId !== 'undefined' && typeof botId !== 'string') ||
        (typeof dealId !== 'undefined' && typeof dealId !== 'string') ||
        typeof qty !== 'string' ||
        (asset &&
          (typeof asset !== 'string' ||
            ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
              asset,
            ))) ||
        (symbol && typeof symbol !== 'string') ||
        (type &&
          ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      try {
        const result = await Bot.addDealFundsFromPublicApi(
          user.id,
          botId,
          qty,
          asset!,
          symbol,
          fundsType,
          dealId,
        )

        return res.status(200).json(result)
      } catch (error) {
        console.error('Error adding funds to deal:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to add funds to deal',
        })
      }
    },
  })

  /**
   * POST /api/v2/deals/dca/reduce-funds
   *
   * Reduce funds from a deal (works for all deal types)
   *
   * Body: { qty: string, asset?: OrderSizeTypeEnum, symbol?: string, type?: AddFundsTypeEnum }
   *
   * Response:
   * - 200: Funds reduced successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  post.set('/api/v2/deals/dca/reduce-funds', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { qty, asset, symbol, type } = req.body as {
        qty?: string
        asset?: OrderSizeTypeEnum
        symbol?: string
        type?: AddFundsTypeEnum
      }

      const { botId, dealId } = req.query as { botId?: string; dealId?: string }

      if (!botId && !dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Bot ID of deal ID required',
        })
      }

      const fundsType = type || AddFundsTypeEnum.fixed

      if (!qty || (fundsType === AddFundsTypeEnum.fixed && !asset)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Missing required parameters',
        })
      }

      if (
        (typeof botId !== 'undefined' && typeof botId !== 'string') ||
        (typeof dealId !== 'undefined' && typeof dealId !== 'string') ||
        typeof qty !== 'string' ||
        (asset &&
          (typeof asset !== 'string' ||
            ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
              asset,
            ))) ||
        (symbol && typeof symbol !== 'string') ||
        (type &&
          ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid parameters',
        })
      }

      try {
        const result = await Bot.reduceDealFundsFromPublicApi(
          user.id,
          botId,
          qty,
          asset!,
          symbol,
          fundsType,
          dealId,
        )

        return res.status(200).json(result)
      } catch (error) {
        console.error('Error reducing funds from deal:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to reduce funds from deal',
        })
      }
    },
  })

  // Middleware chain for legacy v1 routes: just use the modern header parser
  // Legacy v1 API methods will be updated to use req.paperContext instead of req.query.paperContext
  const legacyMiddlewares = [paperContextMiddleware]

  // Import v1 API for POST, PUT, DELETE operations
  // These operations don't use field selection, so we map them 1:1
  const v1API = allAPI(userDb, Bot)

  // DO NOT auto-map v1 endpoints that we've explicitly defined as REST above
  const excludedV1Routes = [
    '/api/updateDCABot',
    '/api/updateComboBot',
    '/api/startBot',
    '/api/stopBot',
    '/api/restoreBot',
    '/api/archiveBot',
    '/api/changeBotPairs',
    '/api/cloneDCABot',
    '/api/cloneComboBot',
    '/api/updateDCADeal',
    '/api/updateComboDeal',
    '/api/startDeal',
    '/api/addFunds',
    '/api/reduceFunds',
  ]

  /**
   * Core backtest request logic (extracted for reuse)
   */
  const submitBacktestRequest = async (
    userId: string,
    botType: string,
    payload: Omit<ServerSideBacktestPayload, 'type'>,
    sendServerSideRequest: (
      payload: ServerSideBacktestPayload,
      userId: string,
      cost: number,
      requestId: string,
    ) => Promise<void>,
    cost: number,
  ): Promise<{
    status: StatusEnum
    reason?: string
    data?: { message: string; requestId: string }
  }> => {
    // Validate bot type
    if (!['dca', 'combo', 'grid'].includes(botType)) {
      return {
        status: StatusEnum.notok,
        reason: 'Invalid bot type. Must be dca, combo, or grid',
      }
    }

    // Validate required fields
    if (!payload) {
      return {
        status: StatusEnum.notok,
        reason: 'Payload is required',
      }
    }

    // Validate pairs in settings
    if (
      !payload.data?.settings?.pair ||
      !Array.isArray(payload.data.settings.pair)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Payload must include settings with pair array',
      }
    }

    // Validate at least one pair
    if (payload.data.settings.pair.length === 0) {
      return {
        status: StatusEnum.notok,
        reason: 'At least one trading pair is required',
      }
    }

    // Validate payload.data structure
    if (!payload.data || !payload.data.exchange || !payload.data.exchangeUUID) {
      return {
        status: StatusEnum.notok,
        reason: 'Payload must include data with exchange and exchangeUUID',
      }
    }

    try {
      const pairs = await pairDb.readData<{
        pair: string
        baseAsset: { name: string }
        quoteAsset: { name: string }
      }>(
        { exchange: payload.data.exchange },
        {},
        { pair: 1, 'baseAsset.name': 1, 'quoteAsset.name': 1 },
        true,
      )
      if (pairs.status === StatusEnum.notok || !pairs.data.result) {
        return {
          status: StatusEnum.notok,
          reason: 'Failed to retrieve pairs for exchange',
        }
      }
      const foundPairs = [payload.data.settings.pair]
        .flat()
        .map((pp) => {
          // X-Perp pairs (e.g. `AAVE-USD_UM_XPERP`) are already the
          // canonical exchange-native pair string; splitting on `_` would
          // tear the `_UM_XPERP` contract-type suffix apart instead of
          // base/quote.
          if (isXperpPair(pp)) {
            return pairs.data.result?.find((p) => p.pair === pp)
          }
          const [base, quote] = pp.split('_')
          return pairs.data.result?.find(
            (p) => p.baseAsset.name === base && p.quoteAsset.name === quote,
          )
        })
        .filter((p): p is (typeof pairs.data.result)[0] => !!p)
      if (foundPairs.length !== payload.data.settings.pair.length) {
        return {
          status: StatusEnum.notok,
          reason: 'One or more pairs in payload are invalid for the exchange',
        }
      }
      payload.data.settings.pair = foundPairs.map((p) => p.pair)
      // Build symbols array from pairs and exchange
      const symbols = foundPairs.map((pair) => {
        return {
          pair: pair.pair,
          baseAsset: pair.baseAsset.name,
          quoteAsset: pair.quoteAsset.name,
        }
      })

      if (
        !payload.config ||
        !payload.config.userFee ||
        !payload.config.slippage
      ) {
        const userFree = await feeDb.readData({
          userId,
          exchangeUUID: payload.data.exchangeUUID,
          pair: payload.data.settings.pair[0],
        })
        const userFee =
          userFree.status === StatusEnum.ok && userFree.data.result
            ? `${userFree.data.result.maker}`
            : '0.001'
        payload.config = {
          ...(payload.config || {}),
          firstDataTime: payload.config?.firstDataTime ?? payload.data.from,
          lastDataTime: payload.config?.lastDataTime ?? payload.data.to,
          userFee: +(payload.config?.userFee ?? userFee) || 0.001,
          slippage: payload.config?.slippage ?? '0',
        } as ServerSideBacktestPayload['config']
      }
      payload.data.userFee = +payload.config.userFee || 0.001
      const result = await createServerSideBacktestRequest(
        userId,
        botType as BotType,
        payload as ServerSideBacktestPayload,
        symbols,
        sendServerSideRequest,
        cost,
      )

      if (result.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            message: `${botType.toUpperCase()} backtest request submitted successfully`,
            requestId: result.data!,
          },
        }
      } else {
        return {
          status: StatusEnum.notok,
          reason: result.reason || 'Failed to submit backtest request',
        }
      }
    } catch (error) {
      console.error(`Error submitting ${botType} backtest request:`, error)

      let errorMessage = 'Failed to submit backtest request'
      if (error instanceof Error) {
        if (isServiceUnreachable(error, error.message)) {
          errorMessage = `Backtest service at ${BACKTEST_SERVICE_TARGET} is not available. Please try again later`
        } else {
          errorMessage = error.message
        }
      }

      return {
        status: StatusEnum.notok,
        reason: errorMessage,
      }
    }
  }

  /**
   * Create Server Side Backtest request
   */
  const createServerSideBacktestRequest = async (
    userId: string,
    botType: BotType,
    payload: ServerSideBacktestPayload,
    symbols: { pair: string; baseAsset: string; quoteAsset: string }[],
    sendServerSideRequest: (
      payload: ServerSideBacktestPayload,
      userId: string,
      cost: number,
      requestId: string,
    ) => Promise<void>,
    cost: number,
  ): Promise<BaseReturn<string>> => {
    try {
      // Apply default settings based on bot type, same pattern as create endpoints
      let enhancedPayload = { ...payload }

      if (botType === BotType.dca) {
        let settings: CreateDCABotInput = {
          ...DCA_FORM_DEFAULTS,
          ...(payload.data.settings as DCABotSettings),
          type: DCATypeEnum.regular,
          exchange: payload.data.exchange,
          exchangeUUID: payload.data.exchangeUUID,
        }
        settings = addIndicatorsDefaults(settings)

        enhancedPayload = {
          ...payload,
          type: BotType.dca,
          data: {
            ...payload.data,
            settings: settings as DCABotSettings,
          },
        }
      } else if (botType === BotType.combo) {
        let settings: CreateComboBotInput = {
          ...COMBO_FORM_DEFAULTS,
          ...(payload.data.settings as ComboBotSettings),
          dealCloseCondition: CloseConditionEnum.tp,
          dealCloseConditionSL: CloseConditionEnum.tp,
          dcaCondition: DCAConditionEnum.percentage,
          scaleDcaType: ScaleDcaTypeEnum.percentage,
          type: DCATypeEnum.regular,
          exchange: payload.data.exchange,
          exchangeUUID: payload.data.exchangeUUID,
        }
        settings = addIndicatorsDefaults(settings)

        enhancedPayload = {
          ...payload,
          type: BotType.combo,
          data: {
            ...payload.data,
            settings: settings as ComboBotSettings,
          },
        }
      } else if (botType === BotType.grid) {
        const settings: CreateGridBotInput = {
          ...GRID_FORM_DEFAULTS,
          ...(payload.data.settings as BotSettings),
          exchange: payload.data.exchange,
          exchangeUUID: payload.data.exchangeUUID,
        }

        enhancedPayload = {
          ...payload,
          type: BotType.grid,
          data: {
            ...payload.data,
            settings: settings as BotSettings,
          },
        }
      }

      let requestId = ''
      const baseRequestData = {
        userId,
        status: BacktestRequestStatus.pending,
        exchange: enhancedPayload.data.exchange,
        exchangeUUID: enhancedPayload.data.exchangeUUID,
        symbols,
        statusHistory: [
          { status: BacktestRequestStatus.pending, time: +new Date() },
        ],
        cost,
      }

      if (botType === BotType.dca) {
        const dcaRequest = await dcaBacktestRequestDb.createData({
          ...baseRequestData,
          type: BotType.dca,
          payload: enhancedPayload as ServerSideBacktestPayload,
        })
        if (dcaRequest.status === StatusEnum.notok) {
          return dcaRequest
        }
        requestId = `${dcaRequest.data._id}`
      } else if (botType === BotType.combo) {
        const comboRequest = await comboBacktestRequestDb.createData({
          ...baseRequestData,
          type: BotType.combo,
          payload: enhancedPayload as ServerSideBacktestPayload,
        })
        if (comboRequest.status === StatusEnum.notok) {
          return comboRequest
        }
        requestId = `${comboRequest.data._id}`
      } else if (botType === BotType.grid) {
        const gridRequest = await gridBacktestRequestDb.createData({
          ...baseRequestData,
          type: BotType.grid,
          payload: enhancedPayload as ServerSideBacktestPayload,
        })
        if (gridRequest.status === StatusEnum.notok) {
          return gridRequest
        }
        requestId = `${gridRequest.data._id}`
      } else {
        return {
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be dca, combo, or grid.',
          data: null,
        }
      }

      try {
        await sendServerSideRequest(
          enhancedPayload as ServerSideBacktestPayload,
          userId,
          cost,
          requestId,
        )
      } catch (e) {
        if (botType === BotType.dca) {
          await dcaBacktestRequestDb.updateData(
            { _id: requestId },
            {
              status: BacktestRequestStatus.failed,
              $push: {
                statusHistory: {
                  status: BacktestRequestStatus.failed,
                  time: +new Date(),
                },
              },
            },
          )
        } else if (botType === BotType.combo) {
          await comboBacktestRequestDb.updateData(
            { _id: requestId },
            {
              status: BacktestRequestStatus.failed,
              $push: {
                statusHistory: {
                  status: BacktestRequestStatus.failed,
                  time: +new Date(),
                },
              },
            },
          )
        } else if (botType === BotType.grid) {
          await gridBacktestRequestDb.updateData(
            { _id: requestId },
            {
              status: BacktestRequestStatus.failed,
              $push: {
                statusHistory: {
                  status: BacktestRequestStatus.failed,
                  time: +new Date(),
                },
              },
            },
          )
        }
        throw e
      }
      return {
        status: StatusEnum.ok,
        data: requestId,
        reason: null,
      }
    } catch (e: any) {
      let message = `${(e as Error)?.message || e}`
      if (isServiceUnreachable(e, message)) {
        message = `Backtest service at ${BACKTEST_SERVICE_TARGET} is not available. Please try again later`
      }
      return {
        status: StatusEnum.notok,
        data: null,
        reason: `Request not sent: ${message}`,
      }
    }
  }

  /**
   * POST /api/v2/backtest/:botType/request
   *
   * Request Server Side Backtest for specific bot type
   *
   * URL params:
   * - botType: Type of bot (dca, combo, grid)
   *
   * Body: { payload: Omit<ServerSideBacktestPayload, 'type'>, symbols: BacktestSymbol[] }
   *
   * Headers:
   * - paper-context: true|false (optional, defaults to false)
   *
   * Response:
   * - 200: Backtest request submitted successfully
   * - 400: Validation error
   * - 401: Unauthorized
   * - 500: Internal server error
   */
  post.set('/api/v2/backtest/:botType/request/:sync', {
    middlewares: [
      paperContextMiddleware,
      ...fieldSelectionMiddlewares('backtest.requests'),
    ],
    handler: async (req, res) => {
      const user = req.userData
      const { botType, sync } = req.params
      const rawFields = req.fieldSelection ?? null
      const {
        payload,
      }: {
        payload: Omit<ServerSideBacktestPayload, 'type'>
      } = req.body

      const result = await submitBacktestRequest(
        user.id,
        botType!,
        payload,
        (payload, userId, _, requestId) =>
          sendServerSideRequest(payload, userId, requestId),
        0,
      )

      if (result.status === StatusEnum.notok) {
        return res
          .status(
            result.reason?.includes('Invalid bot type') ||
              result.reason?.includes('required')
              ? 400
              : 500,
          )
          .json({
            status: StatusEnum.notok,
            reason: result.reason,
            data: null,
          })
      }

      const requestId = result.data!.requestId

      // Sync mode: wait for terminal status and return the full request item
      if (sync === 'sync') {
        const itemResult = await waitForBacktestCompletion(
          botType!,
          requestId,
          user.id,
          rawFields,
        )
        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: itemResult.data,
        })
      }

      return res.status(200).json({
        status: StatusEnum.ok,
        reason: null,
        data: result.data,
      })
    },
  })
  post.set(
    '/api/v2/backtest/:botType/request',
    post.get('/api/v2/backtest/:botType/request/:sync')!,
  )

  /**
   * POST /api/v2/backtest/dca/estimate-cost
   *
   * Estimate DCA Server Side Backtest Cost
   *
   * Body: { payload: Omit<ServerSideBacktestPayload, 'type'> }
   *
   * Response:
   * - 200: Cost estimation completed successfully (always 0 for core docker)
   * - 400: Validation error
   * - 500: Internal server error
   */
  post.set('/api/v2/backtest/dca/estimate-cost', {
    middlewares: [],
    handler: async (req, res) => {
      const {
        payload,
      }: {
        payload: Omit<ServerSideBacktestPayload, 'type'>
      } = req.body

      // Validate required fields
      if (!payload) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload is required',
          data: null,
        })
      }

      // Validate pairs in settings
      if (
        !payload.data?.settings?.pair ||
        !Array.isArray(payload.data.settings.pair)
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload must include settings with pair array',
          data: null,
        })
      }

      // Validate at least one pair
      if (payload.data.settings.pair.length === 0) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'At least one trading pair is required',
          data: null,
        })
      }

      try {
        // For core docker installation, cost estimation is always 0
        const symbolCount = payload.data.settings.pair.length
        const estimatedCredits = 0

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            estimatedCredits,
            estimatedTimeMinutes: 1,
            symbolCount,
            botType: 'dca',
            factors: {
              baseCredits: 0,
              symbolMultiplier: 0,
              complexityMultiplier: 1,
              additionalCredits: 0,
            },
          },
        })
      } catch (error) {
        console.error('Error estimating DCA backtest cost:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to estimate DCA backtest cost',
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/backtest/combo/estimate-cost
   *
   * Estimate Combo Server Side Backtest Cost
   *
   * Body: { payload: Omit<ServerSideBacktestPayload, 'type'> }
   *
   * Response:
   * - 200: Cost estimation completed successfully (always 0 for core docker)
   * - 400: Validation error
   * - 500: Internal server error
   */
  post.set('/api/v2/backtest/combo/estimate-cost', {
    middlewares: [],
    handler: async (req, res) => {
      const {
        payload,
      }: {
        payload: Omit<ServerSideBacktestPayload, 'type'>
      } = req.body

      // Validate required fields
      if (!payload) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload is required',
          data: null,
        })
      }

      // Validate pairs in settings
      if (
        !payload.data?.settings?.pair ||
        !Array.isArray(payload.data.settings.pair)
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload must include settings with pair array',
          data: null,
        })
      }

      // Validate at least one pair
      if (payload.data.settings.pair.length === 0) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'At least one trading pair is required',
          data: null,
        })
      }

      try {
        // For core docker installation, cost estimation is always 0
        const symbolCount = payload.data.settings.pair.length
        const estimatedCredits = 0

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            estimatedCredits,
            estimatedTimeMinutes: 1,
            symbolCount,
            botType: 'combo',
            factors: {
              baseCredits: 0,
              symbolMultiplier: 0,
              complexityMultiplier: 1,
              additionalCredits: 0,
            },
          },
        })
      } catch (error) {
        console.error('Error estimating Combo backtest cost:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to estimate Combo backtest cost',
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/backtest/grid/estimate-cost
   *
   * Estimate Grid Server Side Backtest Cost
   *
   * Body: { payload: Omit<ServerSideBacktestPayload, 'type'> }
   *
   * Response:
   * - 200: Cost estimation completed successfully (always 0 for core docker)
   * - 400: Validation error
   * - 500: Internal server error
   */
  post.set('/api/v2/backtest/grid/estimate-cost', {
    middlewares: [],
    handler: async (req, res) => {
      const {
        payload,
      }: {
        payload: Omit<ServerSideBacktestPayload, 'type'>
      } = req.body

      // Validate required fields
      if (!payload) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload is required',
          data: null,
        })
      }

      // Validate pairs in settings
      if (
        !payload.data?.settings?.pair ||
        !Array.isArray(payload.data.settings.pair)
      ) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Payload must include settings with pair array',
          data: null,
        })
      }

      // Validate at least one pair
      if (payload.data.settings.pair.length === 0) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'At least one trading pair is required',
          data: null,
        })
      }

      try {
        // For core docker installation, cost estimation is always 0
        const symbolCount = payload.data.settings.pair.length
        const estimatedCredits = 0

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: {
            estimatedCredits,
            estimatedTimeMinutes: 1,
            symbolCount,
            botType: 'grid',
            factors: {
              baseCredits: 0,
              symbolMultiplier: 0,
              complexityMultiplier: 1,
              additionalCredits: 0,
            },
          },
        })
      } catch (error) {
        console.error('Error estimating Grid backtest cost:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to estimate Grid backtest cost',
          data: null,
        })
      }
    },
  })

  /**
   * POST /api/v2/backtest/:botType/validate
   *
   * Validate a bot settings payload using the exact same rules as the bot-creation
   * endpoints, but without creating any DB record or dispatching to the backtest queue.
   *
   * Accepts the same body shape as POST /api/v2/backtest/:botType/request:
   *   { payload: { data: { exchange, exchangeUUID, settings: { ... } } } }
   *
   * Runs, in order:
   *   1. Bot type check
   *   2. validateBotCreationContext  (exchange lookup, paper-context, user lookup)
   *   3. Merge defaults (same as create endpoint for that botType)
   *   4. validateCreateDCABotInput / validateCreateComboBotInput / validateCreateGridBotInput
   *
   * This gives AI agents a safe discover → build → validate → submit loop.
   *
   * URL params:
   * - botType: dca | combo | grid
   *
   * Body: { payload: Omit<ServerSideBacktestPayload, 'type'> }  (same as submit endpoint)
   *
   * Response:
   * - 200: Payload is valid — returns the normalised settings that would be submitted
   * - 400: Validation error — includes field-level errors array
   * - 401: Unauthorized
   * - 500: Internal server error
   */
  post.set('/api/v2/backtest/:botType/validate', {
    middlewares: [paperContextMiddleware],
    handler: async (req, res) => {
      const user = req.userData
      const { botType } = req.params

      // --- Step 1: bot type ---
      if (!['dca', 'combo', 'grid'].includes(botType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid bot type. Must be dca, combo, or grid',
          data: null,
        })
      }

      // Unpack the same payload wrapper used by the submit endpoint
      const { payload }: { payload: Omit<ServerSideBacktestPayload, 'type'> } =
        req.body

      if (!payload?.data) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'payload.data is required',
          data: null,
        })
      }

      // Flatten payload.data.settings + exchange / exchangeUUID into a single
      // input object — the same shape that bot-creation endpoints expect.
      const input = {
        ...(payload.data.settings as Record<string, unknown>),
        exchange: payload.data.exchange,
        exchangeUUID: payload.data.exchangeUUID,
      } as CreateDCABotInputRaw

      // --- Step 2: context validation (exchange, paperContext, user) ---
      const contextValidation = await validateBotCreationContext(
        input as any,
        user.id,
        userDb,
        res,
        req.paperContext || false,
      )
      if (!contextValidation.valid) return

      const { userData, exchange } = contextValidation

      try {
        // --- Step 3: merge defaults + Step 4: semantic validation ---
        if (botType === 'dca') {
          let settings: CreateDCABotInput = {
            ...DCA_FORM_DEFAULTS,
            ...input,
            type: DCATypeEnum.regular,
            ...addAditionalFields(input, exchange),
          }
          settings = addIndicatorsDefaults(settings)
          settings = await replaceVarsInInput(settings, userData._id.toString())

          const validate = await validateCreateDCABotInput(
            settings,
            input,
            userData._id,
          )
          if (!validate.valid) {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: 'Validation error',
              errors: validate.errors,
              data: null,
            })
          }
          return res.status(200).json({
            status: StatusEnum.ok,
            reason: null,
            data: { valid: true, botType, settings: sortFields(validate.data) },
          })
        }

        if (botType === 'combo') {
          let settings: CreateComboBotInput = {
            ...COMBO_FORM_DEFAULTS,
            ...input,
            dealCloseCondition: CloseConditionEnum.tp,
            dealCloseConditionSL: CloseConditionEnum.tp,
            dcaCondition: DCAConditionEnum.percentage,
            scaleDcaType: ScaleDcaTypeEnum.percentage,
            type: DCATypeEnum.regular,
            ...addAditionalFields(input, exchange),
          }
          settings = addIndicatorsDefaults(settings)
          settings = await replaceVarsInInput(settings, userData._id.toString())

          const validate = await validateCreateComboBotInput(
            settings,
            input,
            userData._id,
          )
          if (!validate.valid) {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: 'Validation error',
              errors: validate.errors,
              data: null,
            })
          }
          return res.status(200).json({
            status: StatusEnum.ok,
            reason: null,
            data: { valid: true, botType, settings: sortFields(validate.data) },
          })
        }

        // grid
        const gridInput = input as CreateGridBotInputRaw
        const settings: CreateGridBotInput = applyGridFuturesConstraints({
          ...GRID_FORM_DEFAULTS,
          ...gridInput,
          ...addAditionalFields(gridInput, exchange),
        } as CreateGridBotInput)
        delete (settings as any).vars

        const validate = await validateCreateGridBotInput(
          settings as any,
          gridInput as any,
        )
        if (!validate.valid) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: 'Validation error',
            errors: validate.errors,
            data: null,
          })
        }
        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
          data: { valid: true, botType, settings: sortFields(validate.data) },
        })
      } catch (error) {
        console.error(`Error validating ${botType} backtest payload:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason: error instanceof Error ? error.message : 'Validation failed',
          data: null,
        })
      }
    },
  })

  // Map v1 POST endpoints to v2 with /v2 prefix and kebab-case (excluding REST endpoints)
  v1API.post.forEach((handler, route) => {
    if (!excludedV1Routes.includes(route)) {
      const v2Route = transformV1RouteToV2(route)
      post.set(v2Route, { handler, middlewares: legacyMiddlewares })
    }
  })

  /**
   * PUT /api/v2/user/global-vars/:id
   *
   * Update an existing global variable
   *
   * Body: { name?: string, type?: GlobalVariablesTypeEnum, value?: string }
   *
   * Response:
   * - 200: Global variable updated successfully
   * - 400: Validation error
   * - 404: Global variable not found
   * - 500: Internal server error
   */
  put.set('/api/v2/user/global-vars/:id', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { id } = req.params
      const { name, type, value } = req.body as {
        name?: string
        type?: GlobalVariablesTypeEnum
        value?: string
      }

      if (!id) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Variable ID is required',
        })
      }

      try {
        // Check if variable exists and belongs to user
        const existing = await globalVarsDb.readData({
          _id: id,
          userId: user.id,
        })

        if (existing.status === StatusEnum.notok || !existing.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: 'Variable not found',
          })
        }

        const updateFields: any = {}

        // Validate name if provided
        if (name !== undefined) {
          if (typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: 'Name must be a non-empty string',
            })
          }
          updateFields.name = name.trim()
        }

        // Validate type if provided
        if (type !== undefined) {
          if (!Object.values(GlobalVariablesTypeEnum).includes(type as any)) {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: `Type must be one of: ${Object.values(GlobalVariablesTypeEnum).join(', ')}`,
            })
          }
          updateFields.type = type
        }

        // Validate value if provided
        if (value !== undefined) {
          const finalType = type || existing.data.result.type
          const valueValidation = validateGlobalVariableValue(value, finalType)
          if (!valueValidation.valid) {
            return res.status(400).json({
              status: StatusEnum.notok,
              reason: valueValidation.error,
            })
          }
          updateFields.value = value
        }

        if (Object.keys(updateFields).length === 0) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: 'At least one field (name, type, value) must be provided',
          })
        }

        const valueChanged =
          value !== undefined && existing.data.result.value !== value

        const result = await globalVarsDb.updateData(
          { _id: id, userId: user.id },
          { $set: updateFields },
        )

        if (result.status === StatusEnum.notok) {
          return res.status(500).json(result)
        }

        // Notify bots if value changed and bots are using this variable
        if (valueChanged && existing.data.result.botAmount > 0) {
          const redis = await RedisClient.getInstance()
          redis.publish('updateglobalVars', JSON.stringify({ _id: `${id}` }))
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
        })
      } catch (error) {
        console.error('Error updating global variable:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to update global variable',
        })
      }
    },
  })

  v1API.put.forEach((handler, route) => {
    if (!excludedV1Routes.includes(route)) {
      const v2Route = transformV1RouteToV2(route)
      put.set(v2Route, { handler, middlewares: legacyMiddlewares })
    }
  })

  /**
   * DELETE /api/v2/user/global-vars/:id
   *
   * Delete a global variable
   *
   * Response:
   * - 200: Global variable deleted successfully
   * - 400: Variable is used by bots (botAmount > 0)
   * - 404: Global variable not found
   * - 500: Internal server error
   */
  deleteMap.set('/api/v2/user/global-vars/:id', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { id } = req.params

      if (!id) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Variable ID is required',
        })
      }

      try {
        // Check if variable exists and belongs to user
        const existing = await globalVarsDb.readData({
          _id: id,
          userId: user.id,
        })

        if (existing.status === StatusEnum.notok || !existing.data.result) {
          return res.status(404).json({
            status: StatusEnum.notok,
            reason: 'Variable not found',
          })
        }

        // Check if variable is used by any bots
        const botCount = await getBotsByGlobalVar(id)
        if (botCount > 0) {
          return res.status(400).json({
            status: StatusEnum.notok,
            reason: `Variable is used in ${botCount} bot(s). Please remove it from all bots before deleting.`,
          })
        }

        const result = await globalVarsDb.deleteData({
          _id: id,
          userId: user.id,
        })

        if (result.status === StatusEnum.notok) {
          return res.status(500).json(result)
        }

        return res.status(200).json({
          status: StatusEnum.ok,
          reason: null,
        })
      } catch (error) {
        console.error('Error deleting global variable:', error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : 'Failed to delete global variable',
        })
      }
    },
  })

  /**
   * DELETE /api/v2/deals/:dealType/:dealId
   *
   * Close a deal (DCA, Combo, or Terminal)
   *
   * URL params:
   * - dealType: Type of deal (dca, combo, terminal)
   * - dealId: ID of the deal to close
   *
   * Query params:
   * - type: Close type (cancel, closeByLimit, closeByMarket, leave)
   *
   * Response:
   * - 200: Deal closed successfully
   * - 400: Validation error or deal not found
   * - 500: Internal server error
   */
  deleteMap.set('/api/v2/deals/:dealType/:dealId', {
    middlewares: [],
    handler: async (req, res) => {
      const user = req.userData
      const { dealId, dealType } = req.params
      const { type } = req.query as { type?: CloseDCATypeEnum }

      // Validate dealType
      if (!['dca', 'combo', 'terminal'].includes(dealType)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid deal type. Must be one of: dca, combo, terminal',
          data: null,
        })
      }

      if (!dealId) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Deal ID is required',
          data: null,
        })
      }

      if (!type) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Close type is required',
          data: null,
        })
      }

      const validTypes = [
        CloseDCATypeEnum.cancel,
        CloseDCATypeEnum.closeByLimit,
        CloseDCATypeEnum.closeByMarket,
        CloseDCATypeEnum.leave,
      ]

      if (!validTypes.includes(type)) {
        return res.status(400).json({
          status: StatusEnum.notok,
          reason: 'Invalid close type',
          data: null,
        })
      }

      try {
        // Select appropriate close method based on deal type
        const result =
          dealType === 'combo'
            ? await Bot.closeComboDeal(
                user.id,
                '',
                dealId,
                type,
                undefined,
                undefined,
                DCACloseTriggerEnum.api,
              )
            : await Bot.closeDCADeal(
                user.id,
                '',
                dealId,
                type,
                undefined,
                undefined,
                DCACloseTriggerEnum.api,
              )

        return res.status(200).json(result)
      } catch (error) {
        console.error(`Error closing ${dealType} deal:`, error)
        return res.status(500).json({
          status: StatusEnum.notok,
          reason:
            error instanceof Error
              ? error.message
              : `Failed to close ${dealType} deal`,
          data: null,
        })
      }
    },
  })

  v1API.delete.forEach((handler, route) => {
    const v2Route = transformV1RouteToV2(route)
    deleteMap.set(v2Route, { handler, middlewares: legacyMiddlewares })
  })

  const getPublic: APIMap = new Map()
  v1API.getPublic.forEach((handler, route) => {
    const v2Route = transformV1RouteToV2(route)
    getPublic.set(v2Route, { handler, middlewares: legacyMiddlewares })
  })

  // Legacy v1 API method for /api/user/balances is now properly handled by /api/v2/user/balances above

  return {
    get,
    post,
    put,
    delete: deleteMap,
    getPublic,
    submitBacktestRequest,
    waitForBacktestCompletion,
  }
}

export default v2API
