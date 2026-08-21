import type { Request, Response, NextFunction } from 'express'
import DB from '../db'
import { Types } from 'mongoose'
import {
  DCADealStatusEnum,
  StatusEnum,
  BotStatusEnum,
  BotType,
  CloseDCATypeEnum,
  CloseGRIDTypeEnum,
  APIPermission,
  PairsToSetMode,
  AddFundsTypeEnum,
  DCABotSettings,
  DCACloseTriggerEnum,
  UserSchema,
} from '../../types'
import BotInstance from '../bot'
import crypto from 'crypto'
import { resolveApiSecret } from '../utils/credentials'
import logger from '../utils/logger'

import { DCADealsSettings, OrderSizeTypeEnum, ExchangeEnum } from '../../types'
import {
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  userDb as _userDb,
  balanceDb,
} from '../db/dbInit'
import {
  checkDCABotSettings,
  checkDCADealSettings,
  checkPairs,
} from '../bot/utils'
import { isCoinm, isFutures, isPaper } from '../utils'
import { priceBalancesUsd } from '../utils/user'

type ChangeBotPairsInputType = {
  botId?: string
  botName?: string
  pairsToChange?: {
    remove?: string[]
    add?: string[]
  }
  pairsToSet?: string[]
  pairsToSetMode?: PairsToSetMode
  paperContext?: boolean
}

type StartBotInputType = {
  botId?: string
  type?: BotType
  paperContext?: boolean
}

type RestoreBotInputType = {
  botId?: string
  type?: BotType
}

type UpdateDealInputType = {
  dealId?: string
  settings?: Partial<DCADealsSettings>
  botType?: BotType
}

type UpdateBotInputType = {
  botId?: string
  settings?: Partial<DCABotSettings>
  botType?: BotType
  paperContext?: boolean
}

type AddFundsInputType = {
  botId: string
  qty: string
  asset: OrderSizeTypeEnum
  symbol?: string
  type?: AddFundsTypeEnum
  dealId?: string
}

type StartDealInputType = {
  botId?: string
  symbol?: string
  botType?: BotType
}

type APIMap = Map<string, (req: Request, res: Response) => void>

/**
 * How far a request's `time` header may sit from server time and still be
 * accepted, in milliseconds. `time` is signed but was never checked for
 * freshness, so a captured request stayed replayable forever
 * (GHSA-whmj-5f67-9f3w). Five minutes is wide enough for ordinary client clock
 * skew — every first-party client (gainium-mcp, n8n-nodes-gainium, the Chrome
 * extension) stamps `Date.now()` per request.
 *
 * Set `API_SIGNATURE_WINDOW_MS=0` to disable the check. That restores the
 * replayable behaviour and exists only as an escape hatch for an integration
 * with a badly wrong clock — fix the clock instead.
 */
const SIGNATURE_WINDOW_MS = (() => {
  const raw = process.env.API_SIGNATURE_WINDOW_MS
  if (raw === undefined || raw === '') return 5 * 60 * 1000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 60 * 1000
})()

/**
 * Is the caller's signed `time` close enough to now?
 *
 * Accepts the millisecond epoch every client sends. Skew is allowed in both
 * directions: a client clock that runs fast is as ordinary as one that lags.
 */
export const isFreshTimestamp = (
  time: unknown,
  now: number = Date.now(),
  windowMs: number = SIGNATURE_WINDOW_MS,
): boolean => {
  if (windowMs === 0) return true
  const parsed =
    typeof time === 'number' ? time : Number(String(time ?? '').trim())
  if (!Number.isFinite(parsed)) return false
  return Math.abs(now - parsed) <= windowMs
}

/**
 * Constant-time string compare. A `===` on the signature leaks, through timing,
 * how many leading bytes a guess got right.
 */
const signaturesMatch = (expected: string, provided: string): boolean => {
  // Uint8Array rather than Buffer: timingSafeEqual's typings want an
  // ArrayBufferView over a plain ArrayBuffer, which Buffer no longer satisfies.
  const a = Uint8Array.from(Buffer.from(expected, 'utf8'))
  const b = Uint8Array.from(Buffer.from(provided, 'utf8'))
  // Lengths are fixed for base64 SHA-256, so an early return here reveals
  // nothing an attacker does not already know.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

const checkKey = (
  secret: string,
  body: Record<string, unknown>,
  method: string,
  endpoint: string,
  time: string,
  signature: string,
) => {
  const bodyResult = JSON.stringify(body)
  const bodiesToCheck = [bodyResult]
  if (bodyResult.length === 2) {
    bodiesToCheck.push('')
  }
  let matched = false
  for (const bodyToCheck of bodiesToCheck) {
    const signatureResult = crypto
      .createHmac('sha256', secret)
      .update(bodyToCheck + method + endpoint + time)
      .digest('base64')
    // No early break: both candidate bodies are always compared, so the reply
    // time does not reveal which one matched.
    if (signaturesMatch(signatureResult, signature)) {
      matched = true
    }
  }
  return matched
}

/** Why an API key failed to authenticate. */
enum ApiKeyRejection {
  /** The `token` header is not a key id at all. */
  malformed = 'malformed',
  /** No such key — never issued, or deleted since. */
  unknown = 'unknown',
  /** The key exists and is the caller's, but its 90-day term has run out. */
  expired = 'expired',
  /** Ours, not theirs: the key could not be read back from storage. */
  unreadable = 'unreadable',
}

/**
 * What the caller is told, in the same `{status, reason}` shape the read-only
 * permission rejection below already returns. A key dies of old age after 90
 * days with nothing else to announce it, so the 403 body is the only place an
 * integration can learn why it stopped working.
 */
const apiKeyRejectionReason: Record<ApiKeyRejection, string> = {
  [ApiKeyRejection.malformed]: 'This API key is not a valid key.',
  [ApiKeyRejection.unknown]:
    'This API key is not recognized. It may have been deleted.',
  [ApiKeyRejection.expired]:
    'This API key has expired. Renew it under Settings → API Keys to restore access.',
  [ApiKeyRejection.unreadable]: 'This API key could not be verified.',
}

const rejectKey = (rejection: ApiKeyRejection) => ({
  id: undefined,
  secret: undefined,
  permission: undefined,
  keyPaperContext: undefined,
  keyBotId: undefined,
  rejection,
})

const getUserByKey = async <R extends UserSchema = UserSchema>(
  key: string,
  userDb: DB<R> = _userDb as unknown as DB<R>,
) => {
  let keyId: Types.ObjectId
  try {
    keyId = new Types.ObjectId(key)
  } catch {
    return rejectKey(ApiKeyRejection.malformed)
  }
  try {
    // Expiry is asserted below rather than in the query. Folding it in made an
    // expired key indistinguishable from one that was never issued, so every
    // rejection reached the caller as the same anonymous 403.
    const user = await userDb.readData({
      apiKeys: {
        $elemMatch: {
          _id: keyId._id,
        },
      },
    })
    if (user.status === StatusEnum.notok) {
      return rejectKey(ApiKeyRejection.unreadable)
    }
    const api = user.data?.result?.apiKeys?.find(
      (a) => a._id?.toString() === key,
    )
    if (!api) {
      return rejectKey(ApiKeyRejection.unknown)
    }
    if (new Date(api.expired).getTime() <= Date.now()) {
      return rejectKey(ApiKeyRejection.expired)
    }
    return {
      id: user.data?.result?._id.toString(),
      secret: await resolveApiSecret(api),
      permission: api.permission,
      keyPaperContext: api.paperContext,
      keyBotId: api.botId,
      rejection: undefined,
    }
  } catch {
    return rejectKey(ApiKeyRejection.unreadable)
  }
}

declare global {
  // eslint-disable-next-line
  namespace Express {
    interface Request {
      userData: {
        id: string
        secret: string
        permission: APIPermission
        keyPaperContext?: boolean
        keyBotId?: string
      }
    }
  }
}

const prefix = '[API Service]'

const debug = (...message: unknown[]) => {
  logger.debug(prefix, ...message)
}

export const error = (...message: unknown[]) => {
  logger.error(prefix, ...message)
}

const warn = (...message: unknown[]) => {
  logger.warn(prefix, ...message)
}

export const middleware =
  <R extends UserSchema = UserSchema>(
    userDb: DB<R> = _userDb as unknown as DB<R>,
  ) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const { token, signature, time } = req.headers
    debug(`API request: ${req.method} ${req.url}`)
    if (!token || !signature || !time) {
      error(
        `API request: ${req.method} ${req.url} no token or signature or time`,
      )
      res.sendStatus(401)
      return
    }
    const user = await getUserByKey(token.toString(), userDb)
    if (!user.id || !user.secret || !user.permission) {
      const rejection = user.rejection ?? ApiKeyRejection.unknown
      // A rejected key is the caller's problem, not ours, so it is a warning —
      // an expired key retrying on a schedule used to fill the error log for as
      // long as the client kept polling. `unreadable` stays an error: that one
      // is a fault on our side of the credential store.
      const log = rejection === ApiKeyRejection.unreadable ? error : warn
      log(
        `API request: ${req.method} ${req.url} key rejected (${rejection})` +
          // Only echoed once it has parsed as a key id, so an arbitrary header
          // value never reaches the log verbatim.
          (rejection === ApiKeyRejection.malformed
            ? ''
            : `: ${token.toString()}`),
      )
      res.status(403).json({
        status: StatusEnum.notok,
        reason: apiKeyRejectionReason[rejection],
      })
      return
    }
    if (req.method !== 'GET' && user.permission !== APIPermission.write) {
      error(
        `API request: ${req.method} ${req.url} permission denied (read-only key)`,
      )
      res.status(403).json({
        status: StatusEnum.notok,
        reason:
          'This API key has read-only permission. Change the key permission to "write" to perform this action.',
      })
      return
    }
    // SECURITY (GHSA-whmj-5f67-9f3w): `time` is part of the signed material but
    // was never checked against the clock, so a captured request replayed
    // indefinitely. Reject a stale one before spending a HMAC on it.
    if (!isFreshTimestamp(time.toString())) {
      warn(
        `API request: ${req.method} ${req.url} timestamp outside the accepted window`,
      )
      res.sendStatus(401)
      return
    }
    if (
      !checkKey(
        user.secret,
        req.body,
        req.method,
        req.url,
        time.toString(),
        signature.toString(),
      )
    ) {
      // Deliberately does not log the body: it is caller-supplied and can carry
      // credentials on some routes.
      error(`API request: ${req.method} ${req.url} signature not valid`)
      res.sendStatus(401)
      return
    }
    req.userData = {
      id: user.id,
      secret: user.secret,
      permission: user.permission,
      keyPaperContext: user.keyPaperContext,
      keyBotId: user.keyBotId,
    }
    next()
  }

export const bodyMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  if (!req.body) {
    req.body = {}
  }
  next()
}

const allAPI = <R extends UserSchema = UserSchema>(
  userDb: DB<R> = _userDb as unknown as DB<R>,
  Bot: BotInstance = BotInstance.getInstance(),
) => {
  const get: APIMap = new Map()

  const getPublic: APIMap = new Map()

  const post: APIMap = new Map()

  const put: APIMap = new Map()

  const deleteMap: APIMap = new Map()
  getPublic.set('/api/exchanges', async (_req, res) => {
    res.send({
      status: StatusEnum.ok,
      reason: null,
      data: [
        { code: ExchangeEnum.binance, market: 'spot' },
        { code: ExchangeEnum.binanceCoinm, market: 'futures', type: 'inverse' },
        { code: ExchangeEnum.binanceUsdm, market: 'futures', type: 'linear' },
        { code: ExchangeEnum.binanceUS, market: 'spot' },
        { code: ExchangeEnum.bybit, market: 'spot' },
        { code: ExchangeEnum.bybitCoinm, market: 'futures', type: 'inverse' },
        { code: ExchangeEnum.bybitUsdm, market: 'futures', type: 'linear' },
        { code: ExchangeEnum.kucoin, market: 'spot' },
        {
          code: ExchangeEnum.kucoinInverse,
          market: 'futures',
          type: 'inverse',
        },
        { code: ExchangeEnum.kucoinLinear, market: 'futures', type: 'linear' },
        { code: ExchangeEnum.okx, market: 'spot' },
        { code: ExchangeEnum.okxInverse, market: 'futures', type: 'inverse' },
        { code: ExchangeEnum.okxLinear, market: 'futures', type: 'linear' },
        { code: ExchangeEnum.coinbase, market: 'spot' },
        { code: ExchangeEnum.bitget, market: 'spot' },
        { code: ExchangeEnum.bitgetCoinm, market: 'futures', type: 'inverse' },
        { code: ExchangeEnum.bitgetUsdm, market: 'futures', type: 'linear' },
        { code: ExchangeEnum.kraken, market: 'spot' },
        { code: ExchangeEnum.krakenUsdm, market: 'futures', type: 'linear' },
      ],
    })
  })

  get.set('/api/user/exchanges', async (req, res) => {
    debug('User exchanges request')
    const { paperContext: _paperContext }: { paperContext?: string } = req.query
    const paperContext =
      `${_paperContext}` === 'true'
        ? true
        : `${_paperContext}` === 'false'
          ? false
          : null
    const user = req.userData
    if (!user) {
      error(`User not found`)
      res.status(403).send({
        status: StatusEnum.notok,
        reason: 'User not found',
      })
      return
    }
    const exchanges = await userDb.readData(
      {
        _id: new Types.ObjectId(user.id),
      },
      { exchanges: 1 },
    )
    if (exchanges.status === StatusEnum.notok) {
      error(`User error: ${exchanges.reason}`)
      res.status(403).send({
        status: StatusEnum.notok,
        reason: 'Unknown error',
      })
      return
    }
    const result = (exchanges.data?.result?.exchanges ?? [])
      .filter((b) =>
        paperContext === null
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
    return
  })

  get.set('/api/user/balances', async (req, res) => {
    const {
      paperContext: _paperContext,
      page: _page,
      exchangeId: _exchangeId,
      assets: _assets,
      withUsd: _withUsd,
    }: {
      paperContext?: string
      page?: number
      exchangeId?: string
      assets?: string
      withUsd?: string
    } = req.query
    // Opt-in USD valuation. Off by default so the public response shape is
    // unchanged for existing consumers (dashboards, gainium-mcp, n8n, extension).
    const withUsd = _withUsd === 'true' || _withUsd === '1'
    const start = `User balances paperContext: ${_paperContext}, page: ${_page}, exchangeId: ${_exchangeId}, assets: ${_assets}, withUsd: ${withUsd}`
    debug(start)
    let assets: string[] = []
    if (typeof _assets !== 'undefined' && _assets) {
      if (typeof _assets === 'string') {
        assets = _assets.split(',').map((a) => `${a}`.trim())
      } else {
        error(`${start} assets error: ${_assets} is not a string`)
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Assets should be a string',
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
    const paperContext =
      _paperContext === 'true' ? true : _paperContext === 'false' ? false : null
    const user = req.userData
    if (!user) {
      error(`${start} user error: user not found`)
      res.status(403).send({
        status: StatusEnum.notok,
        reason: 'User not found',
      })
      return
    }
    const exchanges = await userDb.readData(
      {
        _id: new Types.ObjectId(user.id),
      },
      { exchanges: 1 },
    )
    if (exchanges.status === StatusEnum.notok) {
      error(`${start}: ${exchanges.reason}`)
      res.status(403).send({
        status: StatusEnum.notok,
        reason: 'Unknown error',
      })
      return
    }
    const limit = 500
    const filter: Record<string, unknown> = {
      userId: `${user.id}`,
    }
    if (exchangeId) {
      filter.exchangeUUID = exchangeId
    }
    if (paperContext !== null && !exchangeId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }
    if (assets.length > 0) {
      filter.asset = { $in: assets }
    }
    const balances = await balanceDb.readData(
      filter,
      { free: 1, locked: 1, asset: 1, exchangeUUID: 1, exchange: 1 },
      { sort: { asset: 1 }, skip: (page - 1) * limit, limit },
      true,
      true,
    )
    if (balances.status === StatusEnum.notok) {
      error(`${start} balance error: ${balances.reason}`)
      res.status(403).send({
        status: StatusEnum.notok,
        reason: 'Unknown error',
      })
      return
    }
    // Opt-in: value each balance in USD via the same authoritative path the
    // portfolio snapshot cron uses (crypto rate table + tokenized-stock fallback).
    // Best-effort — a valuation failure must not fail the balances response.
    let usdMap = new Map<string, { price: number; usdValue: number }>()
    if (withUsd) {
      try {
        usdMap = await priceBalancesUsd(balances.data?.result ?? [])
      } catch (e) {
        error(`${start} usd valuation error: ${e}`)
      }
    }
    const result = (balances.data?.result ?? []).map((b) => {
      const priced = withUsd
        ? usdMap.get(`${b.exchangeUUID ?? ''}:${b.asset}`)
        : undefined
      return {
        asset: b.asset,
        free: b.free,
        locked: b.locked,
        exchangeCode: b.exchange,
        exchangeMarket: isFutures(b.exchange) ? 'futures' : 'spot',
        exchangeType: isFutures(b.exchange)
          ? isCoinm(b.exchange)
            ? 'inverse'
            : 'linear'
          : undefined,
        exchangeId: b.exchangeUUID,
        ...(withUsd
          ? { price: priced?.price ?? 0, usdValue: priced?.usdValue ?? 0 }
          : {}),
      }
    })
    const meta = {
      page,
      total: Math.ceil(balances.data.count / limit),
    }
    res.send({
      status: StatusEnum.ok,
      reason: null,
      data: result,
      meta,
    })
    return
  })

  get.set('/api/deals', async (req, res) => {
    const {
      status,
      paperContext,
      page,
      botId,
      terminal,
      botType,
    }: {
      status?: DCADealStatusEnum
      paperContext?: string
      page?: string
      botId?: string
      terminal?: string
      botType?: BotType
    } = req.query
    const user = req.userData
    const statuses = [
      DCADealStatusEnum.closed,
      DCADealStatusEnum.error,
      DCADealStatusEnum.open,
      DCADealStatusEnum.start,
      DCADealStatusEnum.canceled,
    ]
    const botTypes = [BotType.dca, BotType.combo]
    if (
      (status && !statuses.includes(status)) ||
      (typeof paperContext !== 'undefined' &&
        paperContext !== 'false' &&
        paperContext !== 'true') ||
      (typeof terminal !== 'undefined' &&
        terminal !== 'false' &&
        terminal !== 'true') ||
      (typeof page !== 'undefined' && isNaN(+page)) ||
      (botType && !botTypes.includes(botType))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    if (botType === BotType.dca || !botType) {
      Bot.getDCADealList(
        user.id,
        status,
        paperContext === 'true',
        botId,
        terminal === 'true',
        +(page ?? '1'),
      ).then((result) => res.send(result))
      return
    }
    Bot.getComboDealList(
      user.id,
      status,
      paperContext === 'true',
      botId,
      +(page ?? '1'),
    ).then((result) => res.send(result))
  })

  get.set('/api/bots/grid', async (req, res) => {
    const {
      status,
      paperContext,
      page,
    }: {
      status?: BotStatusEnum
      paperContext?: string
      page?: string
    } = req.query
    const user = req.userData
    const statuses = [
      BotStatusEnum.closed,
      BotStatusEnum.error,
      BotStatusEnum.open,
      BotStatusEnum.archive,
      BotStatusEnum.range,
      BotStatusEnum.monitoring,
    ]
    if (
      (status && (typeof status !== 'string' || !statuses.includes(status))) ||
      (typeof paperContext !== 'undefined' &&
        paperContext !== 'false' &&
        paperContext !== 'true') ||
      (typeof page !== 'undefined' && isNaN(+page))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    Bot.getPublicBotList(
      BotType.grid,
      user.id,
      status,
      paperContext === 'true',
      +(page ?? '1'),
    ).then((result) => res.send(result))
  })

  get.set('/api/bots/combo', async (req, res) => {
    const {
      status,
      paperContext,
      page,
    }: {
      status?: BotStatusEnum
      paperContext?: string
      page?: string
    } = req.query
    const user = req.userData
    const statuses = [
      BotStatusEnum.closed,
      BotStatusEnum.error,
      BotStatusEnum.open,
      BotStatusEnum.archive,
      BotStatusEnum.range,
    ]
    if (
      (status && (typeof status !== 'string' || !statuses.includes(status))) ||
      (typeof paperContext !== 'undefined' &&
        paperContext !== 'false' &&
        paperContext !== 'true') ||
      (typeof page !== 'undefined' && isNaN(+page))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    Bot.getPublicBotList(
      BotType.combo,
      user.id,
      status,
      paperContext === 'true',
      +(page ?? '1'),
    ).then((result) => res.send(result))
  })

  get.set('/api/bots/dca', async (req, res) => {
    const {
      status,
      paperContext,
      page,
    }: {
      status?: BotStatusEnum
      paperContext?: string
      page?: string
    } = req.query
    const user = req.userData
    const statuses = [
      BotStatusEnum.closed,
      BotStatusEnum.error,
      BotStatusEnum.open,
      BotStatusEnum.archive,
      BotStatusEnum.range,
    ]
    if (
      (status && (typeof status !== 'string' || !statuses.includes(status))) ||
      (typeof paperContext !== 'undefined' &&
        paperContext !== 'false' &&
        paperContext !== 'true') ||
      (typeof page !== 'undefined' && isNaN(+page))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    Bot.getPublicBotList(
      BotType.dca,
      user.id,
      status,
      paperContext === 'true',
      +(page ?? '1'),
    ).then((result) => res.send(result))
  })

  post.set('/api/updateDCADeal', async (req, res) => {
    const settings: UpdateDealInputType['settings'] = req.body
    const { dealId }: UpdateDealInputType = req.query
    const user = req.userData
    debug(`Update deal settings ${dealId} DCA ${user.id}`)
    if (!dealId || !settings) {
      error(`Missed required params`)
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (typeof dealId !== 'string' || typeof settings !== 'object') {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }

    const deal = await dcaDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId: user.id,
    })
    if (deal.status === StatusEnum.notok) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: deal.reason,
      })
      return
    }
    if (!deal.data.result) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Deal not found',
      })
      return
    }
    const check = checkDCADealSettings(
      deal.data.result.settings,
      settings,
      false,
    )
    if (check.status === StatusEnum.notok) {
      res.status(400).send(check)
      return
    }
    Bot.updateDCADealSettings(user.id, '', dealId, settings).then((result) =>
      res.send(result),
    )
  })

  post.set('/api/updateComboDeal', async (req, res) => {
    const settings: UpdateDealInputType['settings'] = req.body
    const { dealId }: UpdateDealInputType = req.query
    const user = req.userData
    debug(`Update deal settings ${dealId} Combo ${user.id}`)
    if (!dealId || !settings) {
      error(`Missed required params`)
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (typeof dealId !== 'string' || typeof settings !== 'object') {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }

    const deal = await comboDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId: user.id,
    })
    if (deal.status === StatusEnum.notok) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: deal.reason,
      })
      return
    }
    if (!deal.data.result) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Deal not found',
      })
      return
    }
    const check = checkDCADealSettings(
      deal.data.result.settings,
      settings,
      true,
    )
    if (check.status === StatusEnum.notok) {
      res.status(400).send(check)
      return
    }
    Bot.updateComboDealSettings(user.id, '', dealId, settings).then((result) =>
      res.send(result),
    )
  })

  post.set('/api/updateDCABot', async (req, res) => {
    const settings: UpdateBotInputType['settings'] = req.body
    const { botId }: UpdateBotInputType = req.query
    const user = req.userData
    try {
      debug(
        `Update bot settings ${botId} DCA ${user.id} Body ${JSON.stringify(
          settings ?? {},
        )}`,
      )
    } catch (e) {
      warn(
        `Update bot settings ${botId} DCA ${user.id} Cannot stringify body ${
          (e as Error)?.message ?? e
        }`,
      )
    }
    if (!botId || !settings) {
      error(`Missed required params`)
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (typeof botId !== 'string' || typeof settings !== 'object') {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }

    const bot = await dcaBotDb.readData({
      _id: botId,
      userId: user.id,
    })
    if (bot.status === StatusEnum.notok) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: bot.reason,
      })
      return
    }
    if (!bot.data.result) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Bot not found',
      })
      return
    }
    const check = checkDCABotSettings(bot.data.result.settings, settings, false)
    if (check.status === StatusEnum.notok) {
      res.status(400).send(check)
      return
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
          res.status(400).send(updatePairs)
          return
        }
      } else {
        pairToUse = updatePairs.data.current
      }
    }
    Bot.changeDCABot(
      {
        ...rest,
        pair: pairToUse,
        id: botId,
        vars: bot.data.result.vars,
      },
      user.id,
      !!bot.data.result.paperContext,
    ).then((result) =>
      result && result.status === StatusEnum.notok
        ? res.send(result)
        : res.send({
            status: StatusEnum.ok,
            reason: null,
            data: 'Settings updated',
          }),
    )
  })

  post.set('/api/updateComboBot', async (req, res) => {
    const settings: UpdateBotInputType['settings'] = req.body
    const { botId }: UpdateBotInputType = req.query
    const user = req.userData
    try {
      debug(
        `Update bot settings ${botId} Combo ${user.id} Body ${JSON.stringify(
          settings ?? {},
        )}`,
      )
    } catch (e) {
      warn(
        `Update bot settings ${botId} Combo ${user.id} Cannot stringify body ${
          (e as Error)?.message ?? e
        }`,
      )
    }
    if (!botId || !settings) {
      error(`Missed required params`)
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (typeof botId !== 'string' || typeof settings !== 'object') {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    const bot = await comboBotDb.readData({
      _id: botId,
      userId: user.id,
    })
    if (bot.status === StatusEnum.notok) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: bot.reason,
      })
      return
    }
    if (!bot.data.result) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Bot not found',
      })
      return
    }
    const check = checkDCABotSettings(bot.data.result.settings, settings, true)
    if (check.status === StatusEnum.notok) {
      res.status(400).send(check)
      return
    }
    Bot.changeComboBot(
      { ...settings, id: botId, vars: bot.data.result.vars },
      user.id,
      !!bot.data.result.paperContext,
    ).then((result) =>
      result && result.status === StatusEnum.notok
        ? res.send(result)
        : res.send({
            status: StatusEnum.ok,
            reason: null,
            data: 'Settings updated',
          }),
    )
  })

  post.set('/api/changeBotPairs', async (req, res) => {
    const {
      botId: b_botId,
      botName: b_botName,
      pairsToChange: b_pairsToChange,
      pairsToSet: b_pairsToSet,
      pairsToSetMode: b_pairsToSetMode,
    }: ChangeBotPairsInputType = req.body
    const {
      botId: q_botId,
      botName: q_botName,
      pairsToChange: q_pairsToChange,
      pairsToSet: q_pairsToSet,
      pairsToSetMode: q_pairsToSetMode,
    }: ChangeBotPairsInputType = req.query
    const botId = b_botId || q_botId
    const botName = b_botName || q_botName
    const pairsToChange = b_pairsToChange || q_pairsToChange
    let pairsToSet = b_pairsToSet || q_pairsToSet
    const pairsToSetMode = b_pairsToSetMode || q_pairsToSetMode

    const user = req.userData
    if ((!botId && !botName) || (!pairsToChange && !pairsToSet)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (pairsToSet && typeof pairsToSet === 'string') {
      pairsToSet = [pairsToSet]
    }
    if (
      (botId && typeof botId !== 'string') ||
      (botName && typeof botName !== 'string') ||
      (pairsToChange && typeof pairsToChange !== 'object') ||
      (pairsToSet && typeof pairsToSet !== 'object') ||
      (pairsToSetMode &&
        (typeof pairsToSetMode !== 'string' ||
          !Object.values(PairsToSetMode)
            .filter((v) => isNaN(+v))
            .includes(pairsToSetMode)))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }
    if (pairsToSet && !pairsToSet.length) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Pairs cannot be empty',
      })
      return
    }
    if (
      pairsToChange &&
      ((!pairsToChange.add && !pairsToChange.remove) ||
        (!(pairsToChange.add ?? []).length &&
          !(pairsToChange.remove ?? []).length))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Pairs cannot be empty',
      })
      return
    }

    const result = await Bot.changeDCABotPairs(
      user.id,
      botId,
      botName,
      pairsToChange,
      pairsToSet,
      pairsToSetMode,
    )

    if (result.status === StatusEnum.notok) {
      res.status(400)
    }
    res.send(result)
  })

  post.set('/api/addFunds', async (req, res) => {
    const {
      botId: b_botId,
      qty: b_qty,
      symbol: b_symbol,
      asset: b_asset,
      type: b_type,
    }: AddFundsInputType = req.body
    const {
      dealId,
      botId: q_botId,
      qty: q_qty,
      symbol: q_symbol,
      asset: q_asset,
      type: q_type,
    }: AddFundsInputType = req.query as any
    const botId = b_botId || q_botId
    const qty = b_qty || q_qty
    const symbol = b_symbol || q_symbol
    const asset = b_asset || q_asset
    const type = b_type || q_type || AddFundsTypeEnum.fixed

    const user = req.userData
    if (!botId || !qty || (type === AddFundsTypeEnum.fixed && !asset)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (
      typeof botId !== 'string' ||
      typeof qty !== 'string' ||
      (asset &&
        (typeof asset !== 'string' ||
          ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
            asset,
          ))) ||
      (symbol && typeof symbol !== 'string') ||
      (type && ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }

    Bot.addDealFundsFromPublicApi(
      user.id,
      botId,
      qty,
      asset,
      symbol,
      type,
      dealId,
    ).then((result) => res.send(result))
  })

  post.set('/api/reduceFunds', async (req, res) => {
    const {
      botId: b_botId,
      qty: b_qty,
      symbol: b_symbol,
      asset: b_asset,
      type: b_type,
    }: AddFundsInputType = req.body
    const {
      dealId,
      botId: q_botId,
      qty: q_qty,
      symbol: q_symbol,
      asset: q_asset,
      type: q_type,
    }: AddFundsInputType = req.query as any
    const botId = b_botId || q_botId
    const qty = b_qty || q_qty
    const symbol = b_symbol || q_symbol
    const asset = b_asset || q_asset
    const type = b_type || q_type

    const user = req.userData
    if (!botId || !qty || (type === AddFundsTypeEnum.fixed && !asset)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
      })
      return
    }
    if (
      typeof botId !== 'string' ||
      typeof qty !== 'string' ||
      (asset &&
        (typeof asset !== 'string' ||
          ![OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
            asset,
          ))) ||
      (symbol && typeof symbol !== 'string') ||
      (type && ![AddFundsTypeEnum.fixed, AddFundsTypeEnum.perc].includes(type))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
      })
      return
    }

    Bot.reduceDealFundsFromPublicApi(
      user.id,
      botId,
      qty,
      asset,
      symbol,
      type,
      dealId,
    ).then((result) => res.send(result))
  })

  post.set(`/api/startDeal`, async (req, res) => {
    const {
      botId: b_botId,
      symbol: b_symbol,
      botType: b_botType,
    }: StartDealInputType = req.body
    const {
      botId: q_botId,
      symbol: q_symbol,
      botType: q_botType,
    }: StartDealInputType = req.query
    const botId = b_botId || q_botId
    let symbol = b_symbol || q_symbol
    const botType = b_botType || q_botType
    if (!botId) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    if (
      typeof botId !== 'string' ||
      (botType && ![BotType.combo, BotType.dca].includes(botType)) ||
      (typeof symbol !== 'undefined' && typeof symbol !== 'string')
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    const user = req.userData
    if (typeof symbol !== 'undefined') {
      const convertedPairs = await checkPairs(
        botId,
        user.id,
        botType ?? BotType.dca,
        symbol,
      )
      if (convertedPairs.status === StatusEnum.notok) {
        res.status(400).send(convertedPairs)
        return
      }
      symbol = convertedPairs.data
    }
    if (botType === BotType.combo) {
      res.send(await Bot.openComboDeal(user.id, botId, symbol))
    } else {
      res.send(await Bot.openDCADeal(user.id, botId, symbol))
    }
  })

  post.set(`/api/startBot`, async (req, res) => {
    const {
      botId: b_botId,
      type: b_type,
      paperContext: b_paperContext,
    }: StartBotInputType = req.body
    const {
      botId: q_botId,
      type: q_type,
      paperContext: q_paperContext,
    }: StartBotInputType = req.query

    const botId = b_botId || q_botId
    const type = b_type || q_type
    const paperContext = `${b_paperContext || q_paperContext}` === 'true'
    const user = req.userData
    const types = [BotType.dca, BotType.grid, BotType.combo]
    if (!botId || !type) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    if (typeof botId !== 'string' || !types.includes(type)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    const result = await Bot.changeStatus(
      user.id,
      { status: BotStatusEnum.open, id: botId, type },
      !!paperContext,
    )
    res.send(
      result && result.status === StatusEnum.notok
        ? result
        : {
            status: StatusEnum.ok,
            reason: null,
            data: 'Bot scheduled to start',
          },
    )
  })

  post.set(`/api/restoreBot`, async (req, res) => {
    const { botId: b_botId, type: b_type }: RestoreBotInputType = req.body
    const { botId: q_botId, type: q_type }: RestoreBotInputType = req.query
    const botId = b_botId || q_botId
    const type = b_type || q_type
    const types = [BotType.dca, BotType.grid, BotType.combo]
    if (!botId || !type) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    if (typeof botId !== 'string' || !types.includes(type)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    const user = req.userData
    const result = await Bot.setArchiveStatus(user.id, type, [botId], false)
    res.send(
      result.status === StatusEnum.notok
        ? result
        : { status: StatusEnum.ok, reason: null, data: 'Bot restored' },
    )
  })

  deleteMap.set(`/api/closeDeal/:dealId`, async (req, res) => {
    const { dealId }: { dealId?: string } = req.params
    const { type, botType }: { type?: CloseDCATypeEnum; botType?: BotType } =
      req.query
    const user = req.userData
    if (!dealId || !type || !botType) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })

      return
    }
    const types = [
      CloseDCATypeEnum.cancel,
      CloseDCATypeEnum.closeByLimit,
      CloseDCATypeEnum.closeByMarket,
      CloseDCATypeEnum.leave,
    ]
    if (
      !types.includes(type) ||
      (botType && ![BotType.dca, BotType.combo].includes(botType))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    if (botType === BotType.combo) {
      res.send(
        await Bot.closeComboDeal(
          user.id,
          '',
          dealId,
          type,
          undefined,
          undefined,
          DCACloseTriggerEnum.api,
        ),
      )
    } else {
      res.send(
        await Bot.closeDCADeal(
          user.id,
          '',
          dealId,
          type,
          undefined,
          undefined,
          DCACloseTriggerEnum.api,
        ),
      )
    }
  })

  deleteMap.set(`/api/cancelDeal/:dealId`, async (req, res) => {
    const { dealId }: { dealId?: string } = req.params
    const { botType }: { botType?: BotType } = req.query
    const user = req.userData
    if (!dealId) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    if (botType && ![BotType.dca, BotType.combo].includes(botType)) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    res.send(
      botType === BotType.combo
        ? await Bot.closeComboDeal(user.id, '', dealId, CloseDCATypeEnum.cancel)
        : await Bot.closeDCADeal(user.id, '', dealId, CloseDCATypeEnum.cancel),
    )
  })

  put.set('/api/cloneComboBot', async (req, res) => {
    try {
      const settings: UpdateBotInputType['settings'] = req.body
      const { botId, paperContext: _paperContext }: UpdateBotInputType =
        req.query
      const paperContext =
        `${_paperContext}` === 'true' || _paperContext === true
      const user = req.userData
      debug(`Clone bot settings ${botId} Combo ${user.id}`)
      if (!botId) {
        error(`Missed required params`)
        res.status(400).send({
          status: StatusEnum.notok,
          reason: `Missed required paramas`,
        })
        return
      }
      if (
        typeof botId !== 'string' ||
        (typeof settings !== 'undefined' && typeof settings !== 'object')
      ) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Wrong params',
        })
        return
      }
      const bot = await comboBotDb.readData({
        _id: botId,
        userId: user.id,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
      })
      if (bot.status === StatusEnum.notok) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: bot.reason,
        })
        return
      }
      if (!bot.data.result) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Bot not found',
        })
        return
      }
      const { pair: _pair, ...rest } = settings ?? {}
      let pair = _pair
      const check =
        Object.keys(rest ?? {}).length > 0
          ? checkDCABotSettings(bot.data.result.settings, rest ?? {}, true)
          : { status: StatusEnum.ok }
      if (check.status === StatusEnum.notok) {
        return res.status(400).send(check)
      }
      if (pair?.length) {
        pair =
          (await Bot.checkPairs(bot.data.result.exchange, pair))?.data?.map(
            (p) => p.pair,
          ) ?? []
      }
      const combinedSettings = {
        ...bot.data.result.settings,
        ...(settings ?? {}),
        pair: pair?.length ? pair : bot.data.result.settings.pair,
      }
      if (bot.data.result.settings.name && !settings?.name) {
        combinedSettings.name = `${bot.data.result.settings.name} (clone)`
      }

      const vars = bot.data.result.vars
      if (rest && vars) {
        vars.paths = vars.paths.filter((p) => !(p.path in rest))
        const v = vars.paths.map((p) => p.variable)
        vars.list = vars.list.filter((l) => v.includes(l))
      }
      Bot.createComboBot(
        `${user.id}`,
        {
          ...Bot.removeNullableValuesFromSettings(combinedSettings),
          exchange: bot.data.result.exchange,
          exchangeUUID: bot.data.result.exchangeUUID,
          vars,
        },
        paperContext,
      )
        .then((result) =>
          result && result.status === StatusEnum.notok
            ? (logger.error(`Cannot clone bot`, result.reason),
              res.send({
                status: StatusEnum.notok,
                reason: 'Cannot clone bot',
                data: null,
              }))
            : res.send({
                status: StatusEnum.ok,
                reason: null,
                data: result.data._id,
              }),
        )
        .catch((e) => {
          error(`Error while cloning DCA bot: ${e.message}`)
          res.status(500).send({
            status: StatusEnum.notok,
            reason: 'Internal server error',
          })
        })
    } catch (e) {
      error(`Error while cloning Combo bot: ${(e as Error)?.message ?? e}`)
      res.status(500).send({
        status: StatusEnum.notok,
        reason: 'Internal server error',
      })
    }
  })

  put.set('/api/cloneDCABot', async (req, res) => {
    try {
      const settings: UpdateBotInputType['settings'] = req.body
      const { botId, paperContext: _paperContext }: UpdateBotInputType =
        req.query
      const paperContext =
        `${_paperContext}` === 'true' || _paperContext === true
      const user = req.userData
      debug(`Clone bot settings ${botId} DCA ${user.id}`)
      if (!botId) {
        error(`Missed required params`)
        res.status(400).send({
          status: StatusEnum.notok,
          reason: `Missed required paramas`,
        })
        return
      }
      if (
        typeof botId !== 'string' ||
        (typeof settings !== 'undefined' && typeof settings !== 'object')
      ) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Wrong params',
        })
        return
      }

      const bot = await dcaBotDb.readData({
        _id: botId,
        userId: user.id,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
      })
      if (bot.status === StatusEnum.notok) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: bot.reason,
        })
        return
      }
      if (!bot.data.result) {
        res.status(400).send({
          status: StatusEnum.notok,
          reason: 'Bot not found',
        })
        return
      }
      const { pair: _pair, ...rest } = settings ?? {}
      let pair = _pair
      const check =
        Object.keys(rest ?? {}).length > 0
          ? checkDCABotSettings(bot.data.result.settings, rest ?? {}, false)
          : { status: StatusEnum.ok }

      if (check.status === StatusEnum.notok) {
        return res.status(400).send(check)
      }
      if (pair?.length) {
        pair =
          (await Bot.checkPairs(bot.data.result.exchange, pair))?.data?.map(
            (p) => p.pair,
          ) ?? []
      }
      const combinedSettings = {
        ...bot.data.result.settings,
        ...(rest ?? {}),
        pair: pair?.length ? pair : bot.data.result.settings.pair,
      }
      if (bot.data.result.settings.name && !rest?.name) {
        combinedSettings.name = `${bot.data.result.settings.name} (clone)`
      }
      const vars = bot.data.result.vars
      if (rest && vars) {
        vars.paths = vars.paths.filter((p) => !(p.path in rest))
        const v = vars.paths.map((p) => p.variable)
        vars.list = vars.list.filter((l) => v.includes(l))
      }
      Bot.createDCABot(
        `${user.id}`,
        {
          ...Bot.removeNullableValuesFromSettings(combinedSettings),
          exchange: bot.data.result.exchange,
          exchangeUUID: bot.data.result.exchangeUUID,
          vars,
        },
        paperContext,
      )
        .then((result) =>
          result && result.status === StatusEnum.notok
            ? (logger.error(`Cannot clone bot`, result.reason),
              res.send({
                status: StatusEnum.notok,
                reason: 'Cannot clone bot',
                data: null,
              }))
            : res.send({
                status: StatusEnum.ok,
                reason: null,
                data: result.data._id,
              }),
        )
        .catch((e) => {
          error(`Error while cloning DCA bot: ${e.message}`)
          res.status(500).send({
            status: StatusEnum.notok,
            reason: 'Internal server error',
          })
        })
    } catch (e) {
      debug(`Error while cloning DCA bot: ${(e as Error)?.message ?? e}`)
      res.status(500).send({
        status: StatusEnum.notok,
        reason: 'Internal server error',
      })
    }
  })

  deleteMap.set(`/api/stopBot`, async (req, res) => {
    const {
      botId,
      botType,
      cancelPartiallyFilled,
      closeType,
      paperContext,
      closeGridType,
    }: {
      botId?: string
      botType?: BotType
      cancelPartiallyFilled?: string
      closeType?: CloseDCATypeEnum
      paperContext?: string
      closeGridType?: CloseGRIDTypeEnum
    } = req.query
    const user = req.userData
    const types = [BotType.dca, BotType.grid, BotType.combo]
    if (!botId || !botType) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    const closeTypes = [
      CloseDCATypeEnum.cancel,
      CloseDCATypeEnum.closeByLimit,
      CloseDCATypeEnum.closeByMarket,
      CloseDCATypeEnum.leave,
    ]
    const closeGridTypes = [
      CloseGRIDTypeEnum.closeByLimit,
      CloseGRIDTypeEnum.closeByMarket,
      CloseGRIDTypeEnum.cancel,
    ]
    const booleans = ['true', 'false']
    if (
      typeof botId !== 'string' ||
      !types.includes(botType) ||
      (typeof cancelPartiallyFilled !== 'undefined' &&
        !booleans.includes(cancelPartiallyFilled)) ||
      (closeType && !closeTypes.includes(closeType)) ||
      (closeGridType && !closeGridTypes.includes(closeGridType)) ||
      (typeof paperContext !== 'undefined' && !booleans.includes(paperContext))
    ) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
      return
    }
    const result = await Bot.changeStatus(
      user.id,
      {
        status: BotStatusEnum.closed,
        id: botId,
        type: botType,
        cancelPartiallyFilled: cancelPartiallyFilled === 'true',
        closeType: closeType ?? CloseDCATypeEnum.leave,
        closeGridType,
      },
      paperContext === 'true',
    )
    res.send(
      result && result.status === StatusEnum.notok
        ? result
        : {
            status: StatusEnum.ok,
            reason: null,
            data: 'Bot scheduled to stop',
          },
    )
  })

  deleteMap.set(`/api/archiveBot`, async (req, res) => {
    const {
      botId,
      botType,
    }: {
      botId?: string
      botType?: BotType
    } = req.query
    const types = [BotType.dca, BotType.grid, BotType.combo]
    if (!botId || !botType) {
      res.status(400).send({
        status: StatusEnum.notok,
        reason: `Missed required paramas`,
        data: null,
      })
      return
    }
    if (typeof botId !== 'string' || !types.includes(botType)) {
      return res.status(400).send({
        status: StatusEnum.notok,
        reason: 'Wrong params',
        data: null,
      })
    }
    const user = req.userData
    const result = await Bot.setArchiveStatus(user.id, botType, [botId], true)
    res.send(
      result.status === StatusEnum.notok
        ? result
        : { status: StatusEnum.ok, reason: null, data: 'Bot archived' },
    )
  })

  return {
    get,
    post,
    delete: deleteMap,
    getPublic,
    put,
  }
}

export default allAPI
