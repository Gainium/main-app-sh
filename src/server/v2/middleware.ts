/**
 * Field Selection Middleware for API v2.0
 *
 * Express middleware that parses field selection from query parameters
 * and attaches field selection data to the request object.
 */

import type { Request, Response, NextFunction } from 'express'
import {
  parseFieldsParam,
  type FieldSelection,
  validateFields as validateFieldsFn,
  getSelectedFields,
} from './fieldUtils'
import type { EndpointType } from './fieldConfig'
import { getFieldConfig } from './fieldConfig'
import { StatusEnum, ExchangeEnum } from '../../../types'
import {
  botDb,
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
} from '../../db/dbInit'
import { isPaper } from '../../utils'

// Extend Express Request type to include field selection and paperContext
declare global {
  // eslint-disable-next-line
  namespace Express {
    interface Request {
      fieldSelection?: FieldSelection
      endpointType?: EndpointType
      paperContext?: boolean
    }
  }
}

/**
 * Paper Context Middleware
 *
 * Parses the `paper-context` header and adds it to req.paperContext
 * Defaults to false if header is not present or invalid
 */
export function paperContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const paperContextHeader = req.get('paper-context')
  req.paperContext = paperContextHeader === 'true'
  next()
}

/**
 * Create field selection middleware for a specific endpoint type
 *
 * @param endpointType - The type of endpoint (e.g., 'bots.dca', 'deals.combo')
 * @returns Express middleware function
 *
 * @example
 * app.get('/api/v2/bots/dca',
 *   fieldSelectionMiddleware('bots.dca'),
 *   (req, res) => {
 *     const fields = req.fieldSelection
 *     // Use fields to build projection
 *   }
 * )
 */
export function fieldSelectionMiddleware(endpointType: EndpointType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const fieldsParam = req.query.fields as string | undefined

    try {
      req.fieldSelection = parseFieldsParam(fieldsParam, endpointType)
      req.endpointType = endpointType
      next()
    } catch (error) {
      // If parsing fails, use minimal fields
      const config = getFieldConfig(endpointType, 'minimal')
      req.fieldSelection = config ? ([...config] as string[]) : []
      req.endpointType = endpointType
      next()
    }
  }
}

/**
 * Validate field selection middleware
 * Checks that requested fields are allowed for the endpoint
 *
 * @param allowedFields - Optional list of allowed field patterns
 * @returns Express middleware function
 */
export function validateFieldsMiddleware(allowedFields?: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip validation if no fields selected (all fields) or no restrictions
    if (!req.fieldSelection || !allowedFields) {
      next()
      return
    }

    const validation = validateFieldsFn(req.fieldSelection, allowedFields)

    if (!validation.isValid) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Invalid fields requested: ${validation.invalidFields.join(', ')}`,
        data: null,
      })
      return
    }

    next()
  }
}

/**
 * Add response metadata middleware
 * Adds field selection info to response metadata
 *
 * @returns Express middleware function
 */
export function responseMetadataMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Store original send function
    const originalSend = res.send.bind(res)

    // Override send function to add metadata
    res.send = function (this: Response, data: any) {
      // Only add metadata to successful JSON responses
      if (
        typeof data === 'object' &&
        data !== null &&
        data.status === StatusEnum.ok &&
        'data' in data
      ) {
        data.meta = data.meta || {}
        data.meta.fields = getSelectedFields(req.fieldSelection || null)
      }

      // Call original send
      return originalSend(data)
    } as any

    next()
  }
}

/**
 * Combined field selection middleware
 * Combines all field selection middlewares in one
 *
 * @param endpointType - The type of endpoint
 * @param allowedFields - Optional list of allowed field patterns
 * @returns Array of Express middleware functions
 *
 * @example
 * app.get('/api/v2/bots/dca',
 *   ...fieldSelectionMiddlewares('bots.dca'),
 *   (req, res) => { ... }
 * )
 */
export function fieldSelectionMiddlewares(
  endpointType: EndpointType,
  allowedFields?: string[],
) {
  return [
    fieldSelectionMiddleware(endpointType),
    validateFieldsMiddleware(allowedFields),
    responseMetadataMiddleware(),
  ]
}

/**
 * Routes that create a bot or a deal. A key restricted to one bot cannot use
 * them: whatever they create is outside that bot. Keyed `METHOD path` on the
 * Express route path; any route whose path contains `clone` counts as well.
 */
const BOT_OR_DEAL_CREATION_ROUTES = new Set([
  'POST /api/v2/bots/dca',
  'POST /api/v2/bots/combo',
  'POST /api/v2/bots/grid',
  'POST /api/v2/deals/terminal',
])

/** Bot collections a request's bot id may resolve to, in lookup order. */
const BOT_COLLECTIONS = [
  dcaBotDb,
  comboBotDb,
  botDb,
  hedgeDCABotDb,
  hedgeComboBotDb,
] as const

/** Deal collections a request's deal id may resolve to. */
const DEAL_COLLECTIONS = [dcaDealsDb, comboDealsDb] as const

type RestrictionTarget = {
  paperContext?: boolean | null
  exchange?: string | null
  parentBotId?: string | null
  botId?: string | null
}

const isPaperTarget = (target: RestrictionTarget) =>
  !!target.paperContext ||
  (!!target.exchange && isPaper(target.exchange as ExchangeEnum))

const findOwned = async (
  collections: readonly unknown[],
  userId: string,
  id: string,
): Promise<RestrictionTarget | null> => {
  for (const db of collections) {
    const found = await (db as typeof dcaBotDb).readData(
      { _id: id, userId } as any,
      { paperContext: 1, exchange: 1, parentBotId: 1, botId: 1 } as any,
    )
    if (found.status === StatusEnum.ok && found.data?.result) {
      return found.data.result as unknown as RestrictionTarget
    }
  }
  return null
}

/**
 * API Key Restrictions Middleware
 *
 * Enforces per-API-key access restrictions for paperContext and botId.
 * Must run AFTER the auth middleware (which sets req.userData with keyPaperContext / keyBotId).
 *
 * - paperContext restriction: the request's `paper-context` header and any
 *   `paperContext` parameter must match, and every bot or deal the request
 *   names must be in that context.
 * - botId restriction: every bot the request names must be that bot, every
 *   deal it names must belong to that bot (or to a child of it), and routes
 *   that create bots or deals are refused.
 *
 * Targets are resolved from the stored bot/deal, scoped to the key's user.
 * Skipped when the key has no restriction set (undefined = no restriction).
 */
export async function apiKeyRestrictionsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const { keyPaperContext, keyBotId, id: userId } = req.userData ?? {}
  const paperRestricted =
    keyPaperContext !== undefined && keyPaperContext !== null
  const botRestricted = keyBotId !== undefined && keyBotId !== null
  if (!paperRestricted && !botRestricted) {
    next()
    return
  }

  const deny = (reason: string, status = 403) => {
    res.status(status).json({ status: StatusEnum.notok, reason, data: null })
  }

  const params = (req.params ?? {}) as Record<string, unknown>
  const query = (req.query ?? {}) as Record<string, unknown>
  const body = (
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {}
  ) as Record<string, unknown>

  if (paperRestricted) {
    const requestedPaper = req.get('paper-context') === 'true'
    const declared = [query.paperContext, body.paperContext].filter(
      (v) => v !== undefined && v !== null && v !== '',
    )
    const mismatch =
      requestedPaper !== keyPaperContext ||
      declared.some((v) => (`${v}` === 'true') !== keyPaperContext)
    if (mismatch) {
      deny(
        `API key is restricted to ${keyPaperContext ? 'paper' : 'real'} trading only. ` +
          `Request uses ${keyPaperContext ? 'real' : 'paper'} context.`,
      )
      return
    }
  }

  if (query.botName !== undefined || body.botName !== undefined) {
    deny('API key is restricted. Target the bot by botId, not by name.')
    return
  }

  const routePath = typeof req.route?.path === 'string' ? req.route.path : ''
  // POST /api/v2/deals/:dealType/:dealId/start opens a deal on a bot: its
  // `dealId` segment is a bot id.
  const dealParamIsBot = routePath.endsWith('/:dealId/start')
  const rawBotIds = [
    params.botId,
    query.botId,
    body.botId,
    dealParamIsBot ? params.dealId : undefined,
  ]
  const rawDealIds = [
    dealParamIsBot ? undefined : params.dealId,
    query.dealId,
    body.dealId,
  ]
  const present = [...rawBotIds, ...rawDealIds].filter(
    (v) => v !== undefined && v !== null && v !== '',
  )
  if (present.some((v) => typeof v !== 'string')) {
    deny('Invalid botId or dealId', 400)
    return
  }
  const botIds = [
    ...new Set(
      rawBotIds.filter((v): v is string => typeof v === 'string' && !!v),
    ),
  ]
  const dealIds = [
    ...new Set(
      rawDealIds.filter((v): v is string => typeof v === 'string' && !!v),
    ),
  ]

  if (botRestricted) {
    if (
      req.method !== 'GET' &&
      (BOT_OR_DEAL_CREATION_ROUTES.has(`${req.method} ${routePath}`) ||
        /clone/i.test(routePath))
    ) {
      deny(
        `API key is restricted to bot ${keyBotId} only and cannot create bots or deals.`,
      )
      return
    }
    const other = botIds.find((b) => b !== keyBotId)
    if (other) {
      deny(
        `API key is restricted to bot ${keyBotId} only. ` +
          `Request targets bot ${other}.`,
      )
      return
    }
  }

  try {
    if (paperRestricted) {
      for (const botId of botIds) {
        const bot = await findOwned(BOT_COLLECTIONS, userId, botId)
        if (!bot) {
          deny('Bot not found', 404)
          return
        }
        if (isPaperTarget(bot) !== keyPaperContext) {
          deny(
            `API key is restricted to ${keyPaperContext ? 'paper' : 'real'} trading only. ` +
              `Bot ${botId} is not.`,
          )
          return
        }
      }
    }
    for (const dealId of dealIds) {
      const deal = await findOwned(DEAL_COLLECTIONS, userId, dealId)
      if (!deal) {
        deny('Deal not found', 404)
        return
      }
      if (botRestricted && `${deal.botId}` !== keyBotId) {
        const dealBot = deal.botId
          ? await findOwned(BOT_COLLECTIONS, userId, `${deal.botId}`)
          : null
        if (!dealBot || `${dealBot.parentBotId ?? ''}` !== keyBotId) {
          deny(
            `API key is restricted to bot ${keyBotId} only. ` +
              `Deal ${dealId} belongs to another bot.`,
          )
          return
        }
      }
      if (paperRestricted && isPaperTarget(deal) !== keyPaperContext) {
        deny(
          `API key is restricted to ${keyPaperContext ? 'paper' : 'real'} trading only. ` +
            `Deal ${dealId} is not.`,
        )
        return
      }
    }
  } catch {
    deny('Could not verify API key restrictions', 500)
    return
  }

  next()
}

/**
 * Refuses any API key that carries a paperContext or botId restriction. For
 * routes whose effect cannot be confined to one bot or one trading context.
 */
export function refuseRestrictedApiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const { keyPaperContext, keyBotId } = req.userData ?? {}
  if (
    (keyPaperContext !== undefined && keyPaperContext !== null) ||
    (keyBotId !== undefined && keyBotId !== null)
  ) {
    res.status(403).json({
      status: StatusEnum.notok,
      reason:
        'This endpoint is not available to API keys restricted to a bot or a trading context.',
      data: null,
    })
    return
  }
  next()
}
