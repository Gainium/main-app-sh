import { v4 } from 'uuid'
import DB from '../db'
import type { PipelineStage, ProjectionFields } from 'mongoose'
import { Types } from 'mongoose'
import {
  APIPermission,
  BotSettings,
  BotStatusEnum,
  BotType,
  BuyTypeEnum,
  CleanUserPeriod,
  CloseDCATypeEnum,
  CloseGRIDTypeEnum,
  DCABacktestingResult,
  DCABotSettings,
  ComboDealsSettings,
  DCADealStatusEnum,
  ExchangeEnum,
  ExchangeInUser,
  GRIDBacktestingResult,
  OrderStatusType,
  StatusEnum,
  DataGridFilterInput,
  DCATypeEnum,
  TradeTypeEnum,
  ComboBotSettings,
  ComboBacktestingResult,
  DCADealsSettings,
  BotMarginTypeEnum,
  CloseConditionEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  StrategyEnum,
  TerminalDealTypeEnum,
  Currency,
  PositionSide,
  OrderSchema,
  ExcludeDoc,
  IndicatorEnum,
  ServerSideBacktestPayload,
  BacktestRequestStatus,
  rabbitUsersStreamKey,
  OrderSideEnum,
  CreateComboBotInput,
  GlobalVariablesTypeEnum,
  BotVars,
  ActionsEnum,
  HedgeBotSettings,
  ResetAccountTypeEnum,
  DCACloseTriggerEnum,
  MainBot,
  InputRequest,
  UserSchema,
  HedgeComboBacktestingResult,
  HedgeDCABacktestingResult,
} from '../../types'
import BotInstance from '../bot'
import utils, { isFutures } from '../utils'
import { isExchangeEnabled } from '../utils/adminConfig'
import { describeUserAgent } from '../utils/userAgent'
import userUtils, { checkLicenseKey, updateUserSteps } from '../utils/user'
import { getBalances } from './handlers/balance.handler'
import { deleteBotMessage, getBotMessage } from './handlers/botMessage.handler'
import { getQuantRulesStatus } from './handlers/quantRules.handler'
import verify, { bybitAccountType } from '../exchange/verify'
import {
  needsRotation,
  recordOnly,
  shouldRejectNewConnection,
  withdrawalRejectionReason,
} from '../exchange/keyPermissionPolicy'
import { getExchangeTradeType } from '../exchange/helpers'
import {
  snapshotReadSeries,
  snapshotReadPerExchange,
} from '../archive/snapshotRead'
import {
  backtestDb,
  balanceDb,
  botDb,
  botEventDb,
  dcaBotDb,
  dcaDealsDb,
  favoritePairsDb,
  feeDb,
  gridBacktestDb,
  orderDb,
  pairDb,
  rateDb,
  snapshotDb,
  snapshotPerExchangeDb,
  transactionDb,
  userPeriodDb,
  comboBotDb,
  comboDealsDb,
  comboBacktestDb,
  favoriteIndicatorsDb,
  filesDb,
  dcaBacktestRequestDb,
  comboBacktestRequestDb,
  gridBacktestRequestDb,
  botProfitChartDb,
  userProfitByHourDb,
  hedgeComboBotDb,
  globalVarsDb,
  hedgeDCABotDb,
  userDb as _userDb,
  hedgeComboBacktestDb,
  hedgeDcaBacktestDb,
  brokerCodesDb,
} from '../db/dbInit'
import { errorAccess } from './errorResponse'
import {
  createPaperUser,
  isPaper,
  mapPaperToReal,
  paperExchanges,
  PaperExchangeType,
  topUpUserBalance,
} from '../exchange/paper/utils'
import { encrypt, isEncryptKeyConfigured } from '../utils/crypto'
import { findMatchingConnection, resolveConnection } from '../utils/credentials'
import logger from '../utils/logger'
import { verifyPassword } from './handlers/password'
// ⚠️ Note the two similarly-named helpers now in scope. `verifyPassword`
// directly above is the SYNCHRONOUS strength/format validator and takes ONE
// argument. `verifyPasswordHash` below is the ASYNCHRONOUS bcrypt comparison
// and takes TWO (plaintext, stored). It is imported under a distinct name so
// the two can never be swapped at a call site — doing so would be an
// authentication bypass, not a type error.
import {
  hashPassword,
  isBcryptHash,
  verifyPassword as verifyPasswordHash,
} from '../utils/password'
import { createOrUpdateUser, findUser as _findUser } from './handlers/user'
import { resetUser } from '../utils/user'
import { mapDataGridOptionsToMongoOptions } from '../db/utils'
import Exchange from '../exchange/exchange'
import ExchangeChooser from '../exchange/exchangeChooser'
import { updateOkxEuPairs } from '../utils/cron/exchange'
import { getLeverageBracketsCached } from '../utils/leverageBracketCache'
import { ExchangeKeyPermissions, OKXSource } from '../../types'
import {
  cancelOrderOnExchange,
  getAllOpenOrders,
  getAllOpenPositions,
  placeOrderOnExchange,
} from './handlers/orders.handler'
import { isCoinm, isServiceUnreachable } from '../utils'
import {
  BACKTEST_SERVICE_TARGET,
  sendServerSideRequest,
} from './handlers/backtest'
import { MathHelper } from '../utils/math'
import fs from 'fs'
import Rabbit from '../db/rabbit'
import RedisClient from '../db/redis'
import moment from 'moment-timezone'
import { getBotsByGlobalVar } from '../bot/utils'
import { JWT_SECRET } from '../config'
import { DataResponse, ErrorResponse } from '../db/crud'

const math = new MathHelper()

type PairsCacheEntry = {
  latestKey: string | null
  result: any[] | null
}

type PairsCacheKey = 'paper' | 'real'

const pairsRuntimeCache: Record<PairsCacheKey, PairsCacheEntry> = {
  paper: { latestKey: null, result: null },
  real: { latestKey: null, result: null },
}

const toUpdatedKey = (value: unknown) => {
  if (value && typeof (value as Date).getTime === 'function') {
    return `${(value as Date).getTime()}`
  }
  if (typeof value === 'string' || typeof value === 'number') {
    try {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        return `${date.getTime()}`
      }
    } catch (e) {
      // ignore
    }
  }
  return value == null ? '' : `${value}`
}

const buildPairsLatestKey = (
  doc: { _id?: unknown; updated?: unknown } | undefined,
) => {
  if (!doc) return null
  return `${doc._id ?? ''}:${toUpdatedKey(doc.updated)}`
}

const { getTimezoneOffset, id } = utils

if (!JWT_SECRET) {
  throw Error('missing jwt secret')
}

const rabbitClient = new Rabbit()

const resolvers = <
  R extends UserSchema = UserSchema,
  T extends ErrorResponse | DataResponse<ExcludeDoc<R>> =
    | ErrorResponse
    | DataResponse<ExcludeDoc<R>>,
>(
  findUser: (token: string) => Promise<T> = _findUser as unknown as (
    token: string,
  ) => Promise<T>,
  userDb: DB<R> = _userDb as unknown as DB<R>,
  Bot: BotInstance = BotInstance.getInstance(),
) => {
  const Query = {
    checkUserExist: async () => {
      const user = await userDb.countData({})

      return {
        ...user,
        data: !!user.data?.result,
      }
    },
    /**
     * Whether this deployment is configured the way we recommend. Only
     * booleans leave this resolver: the dashboard needs to know *that* a
     * setting is missing to suggest fixing it, and nothing more. Behind auth
     * so the answer is not readable by anyone who can reach the endpoint.
     */
    deploymentSecurity: async (
      _parent: any,
      _args: any,
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return {
        status: StatusEnum.ok,
        data: { encryptionKeyConfigured: isEncryptKeyConfigured() },
      }
    },
    compareBalances: async (
      _parent: any,
      { input }: { input: { botId: string; dealId: string } },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return Bot.compareBalances(user.data._id, input.botId, input.dealId)
    },
    getBotProfitChartData: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          type: BotType
          id: string
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await botProfitChartDb.readData(
        {
          userId: `${user.data._id}`,
          botId: input.id,
          type: input.type,
        },
        { value: 1, time: 1 },
        { sort: { time: -1 }, limit: 500 },
        true,
      )
      return {
        status: result.status,
        reason:
          result.status === StatusEnum.ok
            ? null
            : `Cannot get profit chart data`,
        data:
          result.status === StatusEnum.ok ? (result.data?.result ?? []) : null,
      }
    },
    getServerSideBacktestRequests: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          type: BotType
          page?: number
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { type, ...grid } = input
      const instance =
        input.type === BotType.dca
          ? dcaBacktestRequestDb
          : input.type === BotType.combo
            ? comboBacktestRequestDb
            : gridBacktestRequestDb
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(grid)
      const result = await instance.readData(
        { userId: user.data._id.toString(), ...filter },
        {
          symbols: 1,
          exchange: 1,
          exchangeUUID: 1,
          userId: 1,
          status: 1,
          backtestId: 1,
          type: 1,
          cost: 1,
          _id: 1,
          statusHistory: 1,
          created: 1,
          statusReason: 1,
        },
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getUserFiles: async (_parent: any, {}, { token }: InputRequest) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await filesDb.readData(
        {
          userId: `${user.data._id}`,
        },
        {},
        {},
        true,
      )
      if (result.status === StatusEnum.notok) {
        return result
      }
      return {
        status: result.status,
        reason: null,
        data: result.data.result.map((f) => ({
          meta: f.meta,
          size: f.size,
          id: `${f._id}`,
        })),
      }
    },
    getExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          uuid: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { uuid } = input
      // One connection is asked for by uuid, so find it and unwrap that one.
      // Mapping over the filtered list would unwrap every connection the
      // filter let through, which is the thing this path must not do.
      const found = user.data.exchanges.find(
        (e) =>
          e.uuid === uuid &&
          (paperContext
            ? paperExchanges.includes(e.provider)
            : !paperExchanges.includes(e.provider)),
      )
      if (!found) {
        return { status: StatusEnum.ok, data: null }
      }
      const resolved = await resolveConnection(found)
      return {
        status: StatusEnum.ok,
        data: {
          ...found,
          key: resolved.key,
          secret: resolved.secret,
          // Stored falsy value preserved — see the note in `user` above.
          passphrase: found.passphrase ? resolved.passphrase : found.passphrase,
          rotationRequired: needsRotation(found),
        },
      }
    },
    getUserPeriods: async (_parent: any, {}, { token, req }: InputRequest) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const periods = await userPeriodDb.readData(
        { userId: user.data._id.toString() },
        {},
        undefined,
        true,
      )
      if (periods.status === StatusEnum.notok) {
        return periods
      }
      return {
        status: StatusEnum.ok,
        data: periods.data.result,
        reason: null,
      }
    },
    // List the user's currently-valid login sessions (one per live tokens[]
    // row). Admin-impersonation and demo rows are filtered out so a support
    // agent checking the account never appears in the user's own session list.
    // Expired rows (dead JWTs awaiting the GC cron) are excluded too.
    activeSessions: async (_parent: any, {}, { token, req }: InputRequest) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const now = Date.now()
      // Per-IP location the user doc already caches (country/city), so we can
      // label a session's location without any extra lookup.
      const ipList = user.data.ips ?? []
      const locationForIp = (ip?: string): string | null => {
        if (!ip) return null
        const loc = ipList.find((i) => i.ip === ip)?.location
        if (!loc) return null
        const parts = [loc.city, loc.country].filter(Boolean)
        return parts.length ? parts.join(', ') : null
      }
      const sessions = (user.data.tokens || [])
        .filter((t) => t.source !== 'admin' && t.source !== 'demo')
        .filter((t) => !t.expiredAt || new Date(t.expiredAt).getTime() > now)
        .map((t) => ({
          id: t._id?.toString() ?? '',
          source: t.source ?? null,
          device: describeUserAgent(t.userAgent),
          ip: t.ip ?? null,
          location: locationForIp(t.ip),
          createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
          expiredAt: t.expiredAt ? new Date(t.expiredAt).toISOString() : null,
          current: t.token === token,
        }))
        .sort((a, b) => {
          // Current session first, then most-recently created.
          if (a.current !== b.current) return a.current ? -1 : 1
          return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
        })
      return {
        status: StatusEnum.ok,
        reason: null,
        data: sessions,
      }
    },
    user: async (
      _parent: any,
      {},
      { token, req, paperContext }: InputRequest,
      info: any,
    ) => {
      const exchangeRequest =
        info.fieldNodes[0].selectionSet.loc.source.body.indexOf('exchanges') !==
        -1
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)

      if (
        user.status === StatusEnum.ok &&
        exchangeRequest &&
        info.fieldNodes[0].selectionSet.loc.source.body.indexOf('key') !== -1
      ) {
        const exchanges: (ExchangeInUser & {
          balance?: number
          rotationRequired?: boolean
          updateTime?: number
        })[] = []
        const resultSnapshots = await snapshotDb.readData(
          {
            userId: user.data._id,
            paperContext: paperContext ? { $eq: true } : { $ne: true },
          },
          { updateTime: 1, exchangesTotal: 1, updated: 1 },
          { sort: { updateTime: -1 }, limit: 1 },
        )
        if (resultSnapshots.status === StatusEnum.notok) {
          return resultSnapshots
        }
        for (const e of user.data.exchanges) {
          if (
            paperContext
              ? paperExchanges.includes(e.provider)
              : !paperExchanges.includes(e.provider)
          ) {
            // `passphrase` keeps its stored falsy value rather than the
            // normalised '' — this shape is returned to the dashboard, and a
            // connection with no passphrase must not start reporting one.
            const resolved = await resolveConnection(e)
            const { key, secret } = resolved
            const passphrase = e.passphrase ? resolved.passphrase : e.passphrase

            const snapshot = resultSnapshots.data?.result?.exchangesTotal.find(
              (s) => (e.linkedTo ? s.uuid === e.linkedTo : s.uuid === e.uuid),
            )
            exchanges.push({
              ...e,
              key,
              secret,
              passphrase,
              status: e.status,
              hedge: e.hedge,
              balance: snapshot?.totalUsd ?? 0,
              updateTime: resultSnapshots.data?.result?.updated
                ? +new Date(resultSnapshots.data?.result?.updated)
                : undefined,
              rotationRequired: needsRotation(e),
            })
          }
        }
        return {
          ...user,
          data: {
            ...user.data,
            exchanges,
          },
        }
      }

      if (user.data) {
        let key = null
        let isPremium = false
        if (user.data.licenseKey) {
          const check = await checkLicenseKey()
          key = check.valid ? user.data.licenseKey : null
          isPremium = check.valid ? check.isPremium : false
        }
        return {
          ...user,
          data: {
            ...user.data,
            exchanges: user.data.exchanges.filter((e) =>
              paperContext
                ? paperExchanges.includes(e.provider)
                : !paperExchanges.includes(e.provider),
            ),
            hasExchanges: user.data.exchanges.length > 0,
            hasPaperExchanges: user.data.exchanges.some((e) =>
              paperExchanges.includes(e.provider),
            ),
            hasLiveExchanges: user.data.exchanges.some(
              (e) => !paperExchanges.includes(e.provider),
            ),
            licenseKey: {
              key,
              isPremium,
            },
          },
        }
      }
      return user
    },
    updateBalance: async (
      _parent: any,
      { input }: { input?: { skipSnapshot?: boolean; uuid?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      if (!input?.skipSnapshot) {
        await userUtils.userSnapshots(
          user.data._id.toString(),
          paperContext,
          true,
          undefined,
          undefined,
          input?.uuid,
        )
      }
      const result = await snapshotDb.readData(
        {
          userId: user.data._id,
          paperContext: paperContext ? { $eq: true } : { $ne: true },
        },
        { updateTime: 1, exchangesTotal: 1, updated: 1 },
        { sort: { updateTime: -1 }, limit: 1 },
        true,
      )
      return result
    },
    getSnapshotPerExchange: async (
      _parent: any,
      { input }: { input?: { uuid?: string; from?: number; to?: number } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { uuid, from, to } = input ?? {}
      const useFrom = typeof from === 'number' && isFinite(from) && !isNaN(from)
      const useTo = typeof to === 'number' && isFinite(to) && !isNaN(to)
      // Cloud: read the per-exchange series from the ClickHouse mirror; null when
      // the flag is off / CH is unreachable → Mongo fallback below.
      const ch = await snapshotReadPerExchange({
        userId: user.data._id.toString(),
        paperContext: !!paperContext,
        uuid,
        from: useFrom ? from : undefined,
        to: useTo ? to : undefined,
      })
      if (ch) return ch
      const result = await snapshotPerExchangeDb.readData(
        {
          userId: user.data._id,
          paperContext: paperContext ? { $eq: true } : { $ne: true },
          uuid,
          ...((useFrom || useTo) && {
            updateTime: {
              ...(useFrom && { $gt: from }),
              ...(useTo && { $lt: to }),
            },
          }),
        },
        {},
        {},
        true,
      )
      return result.data?.result
    },
    updateStatus: async (
      _parent: any,
      {},
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchanges: (ExchangeInUser & {
        balance?: number
        rotationRequired?: boolean
      })[] = []
      const resultSnapshots = await snapshotDb.readData(
        {
          userId: user.data._id,
          paperContext: paperContext ? { $eq: true } : { $ne: true },
        },
        { updateTime: 1, exchangesTotal: 1 },
        { sort: { updateTime: -1 }, limit: 1 },
      )
      await Promise.all(
        user.data.exchanges.map(async (e) => {
          if (
            paperContext
              ? paperExchanges.includes(e.provider)
              : !paperExchanges.includes(e.provider)
          ) {
            // `passphrase` keeps its stored falsy value rather than the
            // normalised '' — this shape is returned to the dashboard, and a
            // connection with no passphrase must not start reporting one.
            const resolved = await resolveConnection(e)
            const { key, secret } = resolved
            const passphrase = e.passphrase ? resolved.passphrase : e.passphrase
            const exchangeInstance = ExchangeChooser.chooseExchangeFactory(
              e.provider,
            )(
              e.key,
              e.secret,
              e.passphrase,
              undefined,
              e.keysType,
              e.okxSource,
              e.bybitHost,
            )
            // `verify` and `getHedge` used to be awaited one after the other,
            // so every futures connection cost two serial exchange round
            // trips — and the `Promise.all` below waits for the slowest
            // connection, so one wedged venue held the whole accounts page.
            // Worse, a 502ing connector made both answer "false", which this
            // resolver then PERSISTED: a Hyperliquid outage marked every
            // holder's connection broken and flipped their stored `hedge`.
            // probeConnectionState runs the pair concurrently under
            // PROBE_TIMEOUT_MS and falls back to the stored reading on any
            // non-answer.
            const probe = await verify.probeConnectionState(
              e,
              () =>
                verify.verifyExchange(
                  getExchangeTradeType(e.provider),
                  e.provider,
                  key,
                  secret,
                  passphrase || '',
                  e.keysType,
                  e.okxSource,
                  e.bybitHost,
                ),
              isFutures(e.provider)
                ? () => exchangeInstance.getHedge()
                : undefined,
            )
            e.status = probe.status
            e.hedge = probe.hedge
            e.lastUpdated = +new Date()
            // Existing connection: RECORD ONLY. A withdrawal-enabled key found
            // here must never flip `status` — these users connected before the
            // rule existed and their bots are live. Flag it for admin, warn the
            // user elsewhere, but do not break trading retroactively.
            e.keyPermissions =
              recordOnly(probe.permissions, e.keyPermissions) ??
              e.keyPermissions
            exchanges.push({
              ...e,
              key,
              secret,
              passphrase,
              status: e.status,
              hedge: e.hedge,
              keyPermissions: e.keyPermissions,
              rotationRequired: needsRotation(e),
              balance:
                resultSnapshots.data?.result?.exchangesTotal.find((s) =>
                  e.linkedTo ? s.uuid === e.linkedTo : s.uuid === e.uuid,
                )?.totalUsd ?? 0,
            })
          }
        }),
      )
      const update = await userDb.updateData(
        { _id: user.data._id },
        {
          $set: {
            exchanges: user.data.exchanges.map((e) => {
              const find = exchanges.find((ex) => ex.uuid === e.uuid)
              if (find) {
                e.status = find.status
                e.hedge = find.hedge
                e.lastUpdated = find.lastUpdated
                e.keyPermissions = find.keyPermissions
              }
              return e
            }),
          },
        },
      )

      return {
        status: update.status,
        reason:
          update.status === StatusEnum.notok
            ? 'Cannot update status. Please try again later '
            : null,
        data: exchanges,
      }
    },
    botList: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          status?: BotStatusEnum[]
          dataGridInput?: DataGridFilterInput
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBotList(
        BotType.grid,
        user.data._id,
        token,
        input?.status,
        paperContext,
        undefined,
        input?.dataGridInput,
      )
    },
    botDashboardStats: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          type: BotType
          terminal?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      if (!input) {
        return {
          status: StatusEnum.notok,
          reason: 'No input provided',
          data: null,
        }
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.botDashboardStats(
        `${user.data._id}`,
        input.type,
        !!paperContext,
        input.terminal,
      )
    },
    dealDashboardStats: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          type: BotType
          terminal?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      if (!input) {
        return {
          status: StatusEnum.notok,
          reason: 'No input provided',
          data: null,
        }
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.dealDashboardStats(
        `${user.data._id}`,
        input.type,
        !!paperContext,
        input.terminal,
      )
    },
    dcaBotList: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          all?: boolean
          status?: BotStatusEnum[]
          dataGridInput?: DataGridFilterInput
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await Bot.getBotList(
        BotType.dca,
        user.data._id,
        token,
        input?.status,
        paperContext,
        input?.all,
        input?.dataGridInput,
      )
      return result
    },
    comboBotList: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          all?: boolean
          status?: BotStatusEnum[]
          dataGridInput?: DataGridFilterInput
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await Bot.getBotList(
        BotType.combo,
        user.data._id,
        token,
        input?.status,
        paperContext,
        input?.all,
        input?.dataGridInput,
      )
      return result
    },
    hedgeComboBotList: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          all?: boolean
          status?: BotStatusEnum[]
          dataGridInput?: DataGridFilterInput
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await Bot.getBotList(
        BotType.hedgeCombo,
        user.data._id,
        token,
        input?.status,
        paperContext,
        input?.all,
        input?.dataGridInput,
      )
      return result
    },
    hedgeDCABotList: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          all?: boolean
          status?: BotStatusEnum[]
          dataGridInput?: DataGridFilterInput
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await Bot.getBotList(
        BotType.hedgeDca,
        user.data._id,
        token,
        input?.status,
        paperContext,
        input?.all,
        input?.dataGridInput,
      )
      return result
    },
    dcaDealList: async (
      _parent: any,
      {
        input: { dataGridInput, botId, exchange, terminal },
      }: {
        input: {
          dataGridInput: DataGridFilterInput

          botId?: string
          exchange?: string
          terminal?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getDCADealListGraphQl(
        user.data,
        paperContext,
        dataGridInput,
        botId,
        exchange,
        terminal,
      )
    },
    comboDealList: async (
      _parent: any,
      {
        input: { dataGridInput, botId, exchange },
      }: {
        input: {
          dataGridInput: DataGridFilterInput
          botId?: string
          exchange?: string
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboDealListGraphQl(
        user.data,
        paperContext,
        dataGridInput,
        botId,
        exchange,
      )
    },
    hedgeComboDealList: async (
      _parent: any,
      {
        input: { dataGridInput, botId, exchange },
      }: {
        input: {
          dataGridInput: DataGridFilterInput
          botId?: string
          exchange?: string
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboDealListGraphQl(
        user.data,
        paperContext,
        dataGridInput,
        botId,
        exchange,
      )
    },
    hedgeDcaDealList: async (
      _parent: any,
      {
        input: { dataGridInput, botId, exchange },
      }: {
        input: {
          dataGridInput: DataGridFilterInput
          botId?: string
          exchange?: string
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeDcaDealListGraphQl(
        user.data,
        paperContext,
        dataGridInput,
        botId,
        exchange,
      )
    },
    searchByBotName: async (
      _parent: any,
      {
        input: { search, type },
      }: {
        input: {
          search?: string
          type: BotType
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      if (type === BotType.grid) {
        return {
          status: StatusEnum.ok,
          reason: null,
          data: [],
        }
      }
      const s: Record<string, unknown> = {
        userId: `${user.data._id}`,
        isDeleted: { $ne: true },
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        'settings.name': { $exists: true, $ne: '' },
      }
      if (search) {
        s['settings.name'] = { $regex: search, $options: 'i' }
      }
      const f: ProjectionFields<MainBot> = {
        id: '$_id',
        name: '$settings.name',
      }
      const o = {
        limit: 100,
      }
      const list =
        type === BotType.combo
          ? await comboBotDb.readData(s, f, o, true)
          : await dcaBotDb.readData(s, f, o, true)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: list.data?.result ?? [],
      }
    },
    getBot: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBot(
        BotType.grid,
        user.data?._id.toString() ?? '',
        input.id,
        token === 'demo',
        paperContext,
        input.shareId,
      )
    },
    getBotEvents: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          page?: number
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
          hedge?: boolean
          combo?: boolean
          category?: 'recent' | 'deals' | 'alerts'
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId: _botId, hedge, combo, category, ...grid } = input
      let botId = [_botId]
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(grid)
      if (hedge) {
        const bot = combo
          ? await hedgeComboBotDb.readData({ _id: botId }, { bots: 1 })
          : await hedgeDCABotDb.readData({ _id: botId }, { bots: 1 })
        if (bot.status === StatusEnum.notok) {
          return bot
        }
        if (!bot.data.result) {
          return {
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          }
        }
        botId = bot.data.result.bots.map((b) => `${b}`)
      }
      // Server-side categorization. "recent" is the full activity feed (all
      // events, newest first — no filter); "deals" and "alerts" are filtered
      // subsets. Alerts = error/warning type; deals = deal-tied events that
      // aren't alerts.
      const alertCond = { type: { $in: ['error', 'warning'] } }
      const dealCond = { deal: { $exists: true, $nin: [null, ''] } }
      const categoryCond = (
        cat?: 'recent' | 'deals' | 'alerts',
      ): object | null => {
        if (cat === 'alerts') {
          return alertCond
        }
        if (cat === 'deals') {
          return { $and: [dealCond, { $nor: [alertCond] }] }
        }
        // 'recent' (and no category) → all events, unfiltered.
        return null
      }
      // Base conditions (botId + user search/filter), shared by the data
      // query and every per-category count. Combined via $and so a search
      // $or never collides with a category $nor/$or.
      const baseConds: object[] = [{ botId: { $in: botId } }]
      if ((filter as { $and?: object[] }).$and) {
        baseConds.push(...(filter as { $and: object[] }).$and)
      }
      if ((filter as { $or?: object[] }).$or) {
        baseConds.push({ $or: (filter as { $or: object[] }).$or })
      }
      const buildQuery = (cat?: 'recent' | 'deals' | 'alerts') => {
        const cond = categoryCond(cat)
        const conds = cond ? [...baseConds, cond] : baseConds
        return conds.length > 1 ? { $and: conds } : conds[0]
      }
      const result = await botEventDb.readData(
        buildQuery(category),
        {},
        rest,
        true,
        true,
      )
      if (result.status === StatusEnum.notok) {
        return result
      }
      // Per-bucket counts are only needed by the categorized drawer, which
      // always sends `category`. Legacy callers (no category) skip the 3
      // extra count queries entirely — keeps this change load-neutral for
      // them.
      let counts: { recent: number; deals: number; alerts: number } | undefined
      if (category) {
        const [recentCount, dealsCount, alertsCount] = await Promise.all([
          botEventDb.countData(buildQuery('recent')),
          botEventDb.countData(buildQuery('deals')),
          botEventDb.countData(buildQuery('alerts')),
        ])
        counts = {
          recent: recentCount.data?.result ?? 0,
          deals: dealsCount.data?.result ?? 0,
          alerts: alertsCount.data?.result ?? 0,
        }
      }
      return {
        ...result,
        data: result.data.result,
        total: result.data.count,
        ...(counts ? { counts } : {}),
      }
    },
    getDCABot: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBot(
        BotType.dca,
        user.data?._id.toString() ?? '',
        input.id,
        token === 'demo',
        paperContext,
        input.shareId,
      )
    },
    getComboBot: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok && !input.shareId) {
        return user
      }
      return await Bot.getBot(
        BotType.combo,
        user.data?._id.toString() ?? '',
        input.id,
        token === 'demo',
        paperContext,
        input.shareId,
      )
    },
    getHedgeComboBot: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok && !input.shareId) {
        return user
      }
      return await Bot.getBot(
        BotType.hedgeCombo,
        user.data?._id.toString() ?? '',
        input.id,
        token === 'demo',
        paperContext,
        input.shareId,
      )
    },
    getHedgeDCABot: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok && !input.shareId) {
        return user
      }
      return await Bot.getBot(
        BotType.hedgeDca,
        user.data?._id.toString() ?? '',
        input.id,
        token === 'demo',
        paperContext,
        input.shareId,
      )
    },
    getBotOrders: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          type: BotType
          status: OrderStatusType
          page?: number
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBotOrders(
        user.data._id.toString(),
        input.id,
        input.shareId,
        input.type,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
        input.pageSize,
        input.sortModel,
        input.filterModel,
      )
    },
    getDealOrders: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          type: BotType
          page: number
          dealId: string
          all?: boolean
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getDealOrders(
        user.data._id.toString(),
        input.id,
        input.dealId,
        input.shareId,
        token === 'demo',
        paperContext,
        input.all,
      )
    },
    getComboDealOrders: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          type: BotType
          page: number
          dealId: string
          all?: boolean
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboDealOrders(
        user.data._id.toString(),
        input.id,
        input.dealId,
        input.shareId,
        token === 'demo',
        paperContext,
        input.all,
      )
    },
    getHedgeComboDealOrders: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          type: BotType
          page: number
          dealId: string
          all?: boolean
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboDealOrders(
        user.data._id.toString(),
        input.id,
        input.dealId,
        input.shareId,
        token === 'demo',
        paperContext,
        input.all,
      )
    },
    getHedgeDCADealOrders: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          type: BotType
          page: number
          dealId: string
          all?: boolean
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeDcaDealOrders(
        user.data._id.toString(),
        input.id,
        input.dealId,
        input.shareId,
        token === 'demo',
        paperContext,
        input.all,
      )
    },
    getBotTransactions: async (
      _parent: any,
      { input }: { input: { id: string; shareId?: string; page: number } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBotTransactions(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.page,
      )
    },
    getBotDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: DCADealStatusEnum
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBotDeals(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
        input.pageSize,
        input.sortModel,
        input.filterModel,
      )
    },
    getComboBotDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: DCADealStatusEnum
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboBotDeals(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
        input.pageSize,
        input.sortModel,
        input.filterModel,
      )
    },
    getHedgeComboBotDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: DCADealStatusEnum
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboBotDeals(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
        input.pageSize,
        input.sortModel,
        input.filterModel,
      )
    },
    getHedgeDcaBotDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: DCADealStatusEnum
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeDcaBotDeals(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
        input.pageSize,
        input.sortModel,
        input.filterModel,
      )
    },
    getComboBotDealsById: async (
      _parent: any,
      {
        input,
      }: {
        input: { botId: string; id: string[] }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboBotDealsById(
        user.data._id.toString(),
        input.botId,
        input.id,
        paperContext,
      )
    },
    getBotDealsStats: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getBotDealsStats(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
      )
    },
    getComboBotDealsStats: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboBotDealsStats(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
      )
    },
    getHedgeComboBotDealsStats: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboBotDealsStats(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
      )
    },
    getHedgeDCABotDealsStats: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeDcaBotDealsStats(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
      )
    },
    getComboBotMinigrids: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: 'open' | 'closed'
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboBotMinigrids(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
      )
    },
    getHedgeComboBotMinigrids: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          shareId?: string
          page: number
          status: 'open' | 'closed'
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboBotMinigrids(
        user.data._id.toString(),
        input.id,
        input.shareId,
        token === 'demo',
        paperContext,
        input.status,
        input.page,
      )
    },
    getDCABotSettings: async (
      _parent: any,
      { input }: { input: { botId: string; shareId?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getDCABotSettings(
        user.data._id.toString(),
        input.botId,
        input.shareId,
      )
    },
    getComboBotSettings: async (
      _parent: any,
      { input }: { input: { botId: string; shareId?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getComboBotSettings(
        user.data._id.toString(),
        input.botId,
        input.shareId,
      )
    },
    getHedgeComboBotSettings: async (
      _parent: any,
      { input }: { input: { botId: string; shareId?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeComboBotSettings(
        user.data._id.toString(),
        input.botId,
        input.shareId,
      )
    },
    getHedgeDCABotSettings: async (
      _parent: any,
      { input }: { input: { botId: string; shareId?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getHedgeDcaBotSettings(
        user.data._id.toString(),
        input.botId,
        input.shareId,
      )
    },
    getGridBotSettings: async (
      _parent: any,
      { input }: { input: { botId: string; shareId: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getGridBotSettings(
        user.data._id.toString(),
        input.botId,
        input.shareId,
      )
    },
    getTradingTerminalBotsList: async (
      _parent: any,
      {},
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.getTradingTerminalBotsList(
        user.data._id.toString(),
        paperContext,
      )
    },
    userFee: async (
      _parent: any,
      { input }: { input: { symbol: string; uuid: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { symbol, uuid } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const fees = await feeDb.readData(
        {
          userId: user.data._id.toString(),
          exchangeUUID: uuid,
          pair: symbol,
        },
        undefined,
        {},
        true,
        true,
      )
      if (fees.status === StatusEnum.notok) {
        return fees
      }
      if (fees.data.count === 0) {
        return {
          status: StatusEnum.notok,
          reason: 'Fee not found',
          data: null,
        }
      }
      const data = fees.data.result[0]
      return {
        status: StatusEnum.ok,
        reason: null,
        data: {
          symbol,
          makerCommission: `${data.maker}`,
          takerCommission: `${data.taker}`,
        },
      }
    },
    multipleUserFees: async (
      _parent: any,
      { input }: { input: { symbol: string[]; uuid: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { symbol, uuid } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const fees = await feeDb.readData(
        {
          userId: user.data._id.toString(),
          exchangeUUID: uuid,
          pair: { $in: symbol },
        },
        undefined,
        {},
        true,
        true,
      )
      if (fees.status === StatusEnum.notok) {
        return fees
      }
      if (fees.data.count === 0) {
        return {
          status: StatusEnum.notok,
          reason: 'Fees not found',
          data: null,
        }
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: fees.data.result.map((r) => ({ ...r, symbol: r.pair })),
      }
    },
    getBalances: async (
      _parent: any,
      {
        input,
      }: {
        input: { assets?: string[]; uuid?: string; shouldSumBalance?: boolean }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const { assets, uuid, shouldSumBalance } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return getBalances(
        user.data,
        shouldSumBalance,
        assets,
        uuid,
        paperContext,
      )
    },
    getProfitByBot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          timezone?: string
          timeframe?: number
          botType?: BotType
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId: _botId } = input
      let botId = [_botId]
      let { botType } = input
      if (!botType) {
        botType = BotType.grid
      }
      if (botType === BotType.hedgeCombo) {
        const bot = await hedgeComboBotDb.readData({ _id: _botId }, { bots: 1 })
        if (bot.status === StatusEnum.notok) {
          return bot
        }
        if (!bot.data.result) {
          return {
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          }
        }
        botId = bot.data.result.bots.map((b) => `${b}`)
      }
      if (botType === BotType.hedgeDca) {
        const bot = await hedgeDCABotDb.readData({ _id: _botId }, { bots: 1 })
        if (bot.status === StatusEnum.notok) {
          return bot
        }
        if (!bot.data.result) {
          return {
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          }
        }
        botId = bot.data.result.bots.map((b) => `${b}`)
      }
      const timezone = input.timezone || user.data.timezone

      const timeframe = input.timeframe || 0
      if (timeframe === 3) {
        const match: {
          $match: {
            userId: string
            $expr: { $in: [string, string[]] }
            status?: string
          }
        } = {
          $match: {
            userId: user.data._id.toString(),
            $expr: { $in: ['$botId', botId] },
          },
        }
        if (botType !== BotType.grid) {
          match.$match['status'] = 'closed'
        }
        const agg: PipelineStage[] = [
          match,
          {
            $project: {
              profitUsdt:
                botType === BotType.grid ? '$profitUsdt' : '$profit.totalUsd',
              profitQuote:
                botType === BotType.grid ? '$profitQuote' : '$profit.total',
              profitBase:
                botType === BotType.grid ? '$profitBase' : '$profit.total',
              feeBase: botType === BotType.grid ? '$feeBase' : { $toInt: '0' },
              feeQuote:
                botType === BotType.grid ? '$feeQuote' : { $toInt: '0' },
              updateTime: '$updateTime',
            },
          },
          {
            $sort: {
              updateTime: 1,
            },
          },
          {
            $group: {
              _id: null,
              date: { $first: '$updateTime' },
              profitUsd: {
                $sum: '$profitUsdt',
              },
              profitQuote: {
                $sum: '$profitQuote',
              },
              profitBase: {
                $sum: '$profitBase',
              },
              feeQuote: {
                $sum: '$feeQuote',
              },
              feeBase: {
                $sum: '$feeBase',
              },
            },
          },
          {
            $project: {
              date: 1,
              profitUsd: 1,
              quote: {
                $subtract: ['$profitQuote', '$feeQuote'],
              },
              base: {
                $subtract: ['$profitBase', '$feeBase'],
              },
            },
          },
        ]
        const res =
          botType === BotType.grid
            ? await transactionDb.aggregate(agg)
            : botType === BotType.combo || botType === BotType.hedgeCombo
              ? await comboDealsDb.aggregate(agg)
              : await dcaDealsDb.aggregate(agg)
        return res
      } else {
        const today = new Date(
          new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime() -
            getTimezoneOffset(timezone),
        )
        let step = 30 // last 30 days daily value
        if (timeframe === 1) step = 24 * 7 // last 24 weeks
        let startTime = today.getTime() - 24 * 60 * 60 * 1000 * step
        if (timeframe === 2) {
          let startDate = new Date(today.getFullYear(), today.getMonth() + 1, 1)
          if (today.getMonth() == 11) {
            startDate = new Date(today.getFullYear() + 1, 0, 1)
          }
          startDate.setFullYear(startDate.getFullYear() - 1)
          startTime = startDate.getTime() // last 12 months
        }
        const match: {
          $match: {
            userId: string
            $expr: { $in: [string, string[]] }
            status?: string
            updateTime: { $gt: number }
          }
        } = {
          $match: {
            userId: user.data._id.toString(),
            $expr: { $in: ['$botId', botId] },
            updateTime: { $gt: startTime },
          },
        }
        if (botType !== BotType.grid) {
          match.$match['status'] = 'closed'
        }
        let isDst = false
        try {
          isDst = moment().tz(timezone).isDST()
        } catch (e) {
          logger.error(`Error in getProfitByUser: ${e}`)
        }
        const agg: PipelineStage[] = [
          match,
          {
            $project: {
              date: {
                $convert: {
                  input: '$updateTime',
                  to: 'date',
                  onError: '$$NOW',
                },
              },
              profitUsd:
                botType === BotType.grid ? '$profitUsdt' : '$profit.totalUsd',
              profitQuote:
                botType === BotType.grid ? '$profitQuote' : '$profit.total',
              profitBase:
                botType === BotType.grid ? '$profitBase' : '$profit.total',
              feeBase: botType === BotType.grid ? '$feeBase' : { $toInt: '0' },
              feeQuote:
                botType === BotType.grid ? '$feeQuote' : { $toInt: '0' },
            },
          },
          {
            $group: {
              _id:
                timeframe === 0
                  ? {
                      $toDate: {
                        $add: [
                          {
                            $toLong: {
                              $dateFromParts: {
                                day: {
                                  $dayOfMonth: {
                                    date: '$date',
                                    timezone,
                                  },
                                },
                                month: {
                                  $month: {
                                    date: '$date',
                                    timezone,
                                  },
                                },
                                year: {
                                  $year: {
                                    date: '$date',
                                    timezone,
                                  },
                                },
                                timezone,
                              },
                            },
                          },
                          isDst ? 3600000 : 0,
                        ],
                      },
                    }
                  : timeframe === 1
                    ? {
                        week: {
                          [user.data?.weekStart === 'm' ? '$isoWeek' : '$week']:
                            {
                              date: '$date',
                              timezone,
                            },
                        },
                        year: {
                          [user.data?.weekStart === 'm'
                            ? '$isoWeekYear'
                            : '$year']: {
                            date: '$date',
                            timezone,
                          },
                        },
                      }
                    : {
                        month: {
                          $month: {
                            date: '$date',
                            timezone,
                          },
                        },
                        year: {
                          $year: {
                            date: '$date',
                            timezone,
                          },
                        },
                      },
              profitUsd: { $sum: '$profitUsd' },
              profitQuote: {
                $sum: '$profitQuote',
              },
              profitBase: {
                $sum: '$profitBase',
              },
              feeQuote: {
                $sum: '$feeQuote',
              },
              feeBase: {
                $sum: '$feeBase',
              },
            },
          },
          {
            $project: {
              date: '$_id',
              week:
                timeframe === 0
                  ? '$_id.week'
                  : {
                      $convert: {
                        input: {
                          $add: [
                            '$_id.week',
                            user.data?.weekStart === 'm' ? 0 : 1,
                          ],
                        },
                        to: 'string',
                      },
                    },
              month:
                timeframe === 0
                  ? '$_id.month'
                  : {
                      $convert: { input: '$_id.month', to: 'string' },
                    },
              year:
                timeframe === 0
                  ? '$_id.year'
                  : {
                      $convert: { input: '$_id.year', to: 'string' },
                    },
              profitUsd: 1,
              quote: {
                $subtract: ['$profitQuote', '$feeQuote'],
              },
              base: {
                $subtract: ['$profitBase', '$feeBase'],
              },
              sort:
                timeframe === 0
                  ? '$_id'
                  : timeframe === 1
                    ? '$_id.week'
                    : '$_id.month',
            },
          },
          {
            $sort: {
              sort: 1,
            },
          },
          {
            $project: {
              _id: 0,
              date:
                timeframe === 0
                  ? { $toDate: { $toLong: '$date' } }
                  : timeframe === 1
                    ? {
                        $concat: ['$year', '-', '$week'],
                      }
                    : {
                        $concat: ['$year', '-', '$month'],
                      },
              profitUsd: 1,
              quote: 1,
              base: 1,
            },
          },
        ]
        const res =
          botType === BotType.grid
            ? await transactionDb.aggregate(agg)
            : botType === BotType.combo || botType === BotType.hedgeCombo
              ? await comboDealsDb.aggregate(agg)
              : await dcaDealsDb.aggregate(agg)
        return res
      }
    },
    getPortfolioByUser: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          timezone?: string
          from?: number
          to?: number
          includeAssets?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const timezone = input?.timezone || user.data.timezone
      const currentDay =
        new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime() -
        getTimezoneOffset(timezone)
      // Default window = the historical 30 days; `from`/`to` let the client ask
      // for a longer range (up to CH's 12-month retention on cloud).
      const from =
        typeof input?.from === 'number' && isFinite(input.from)
          ? input.from
          : currentDay - 3600 * 24 * 30 * 1000
      const to =
        typeof input?.to === 'number' && isFinite(input.to)
          ? input.to
          : undefined
      // `includeAssets` (default true) — the client omits per-day assets[] for
      // the all-coins/all-exchanges line, which lets the CH read return just
      // {updateTime,totalUsd} (no `raw` parse, tiny payload).
      const includeAssets = input?.includeAssets !== false
      // Cloud: read the series from the ClickHouse mirror (12mo retention).
      // Returns null when the flag is off / CH is unreachable → Mongo fallback.
      const ch = await snapshotReadSeries({
        userId: user.data._id.toString(),
        paperContext: !!paperContext,
        from,
        to,
        lean: !includeAssets,
      })
      if (ch) return ch
      const agg: PipelineStage[] = [
        {
          $match: {
            userId: user.data._id.toString(),
            updateTime: { $gte: from, ...(to != null && { $lte: to }) },
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
          },
        },
        {
          $sort: {
            updateTime: 1 as 1,
          },
        },
      ]
      const res = await snapshotDb.aggregate(agg)
      return res
    },
    getProfitByUser: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          timezone?: string
          timeframe?: number
          botType?: BotType
          terminal?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const timezone = input?.timezone || user.data.timezone

      const timeframe = input?.timeframe || 0
      const botType = input?.botType
      if (timeframe === 3) {
        if (botType === BotType.grid) {
          const transactionsAggr: PipelineStage[] = [
            {
              $match: {
                userId: `${user.data._id}`,
                // @ts-ignore
                paperContext: paperContext ? { $eq: true } : { $ne: true },
                botType: BotType.grid,
              },
            },
            {
              $project: {
                _id: 1,
                profitUsd: 1,
                updateTime: '$time',
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$updateTime',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          return userProfitByHourDb.aggregate(transactionsAggr)
        } else if (botType === BotType.dca) {
          const match = {
            userId: `${user.data._id}`,
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            botType: BotType.dca,
          }
          if (typeof input?.terminal !== 'undefined') {
            //@ts-ignore
            match.terminal = input?.terminal ? { $eq: true } : { $ne: true }
          }
          const dcaAggr: PipelineStage[] = [
            {
              //@ts-ignore
              $match: match,
            },
            {
              $project: {
                _id: 1,
                profitUsd: 1,
                updateTime: '$time',
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$updateTime',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          return userProfitByHourDb.aggregate(dcaAggr)
        } else if (botType === BotType.combo) {
          const comboAggr: PipelineStage[] = [
            {
              $match: {
                userId: user.data._id.toString(),
                // @ts-ignore
                paperContext: paperContext ? { $eq: true } : { $ne: true },
                botType: BotType.combo,
              },
            },
            {
              $project: {
                _id: 1,
                profitUsd: 1,
                updated: '$time',
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$updated',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          return userProfitByHourDb.aggregate(comboAggr)
        } else if (botType === BotType.hedgeCombo) {
          const comboAggr: PipelineStage[] = [
            {
              $match: {
                userId: user.data._id.toString(),
                // @ts-ignore
                paperContext: paperContext ? { $eq: true } : { $ne: true },
                botType: BotType.hedgeCombo,
              },
            },
            {
              $project: {
                _id: 1,
                profitUsd: 1,
                updated: '$time',
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$updated',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          return userProfitByHourDb.aggregate(comboAggr)
        } else if (botType === BotType.hedgeDca) {
          const comboAggr: PipelineStage[] = [
            {
              $match: {
                userId: user.data._id.toString(),
                // @ts-ignore
                paperContext: paperContext ? { $eq: true } : { $ne: true },
                botType: BotType.hedgeDca,
              },
            },
            {
              $project: {
                _id: 1,
                profitUsd: 1,
                updated: '$time',
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$updated',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          return userProfitByHourDb.aggregate(comboAggr)
        } else {
          const agg: PipelineStage[] = [
            {
              $match: {
                userId: `${user.data._id}`,
                // @ts-ignore
                paperContext: paperContext ? { $eq: true } : { $ne: true },
              },
            },
            {
              $group: {
                _id: null,
                date: {
                  $min: '$time',
                },
                quote: {
                  $sum: '$profitUsd',
                },
              },
            },
          ]
          const res = await userProfitByHourDb.aggregate(agg)

          return res
        }
      } else {
        const today = new Date(
          new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime() -
            getTimezoneOffset(timezone),
        )
        let step = 30 // last 30 days daily value
        if (timeframe === 1) step = 24 * 7 // last 24 weeks
        let startTime = today.getTime() - 24 * 60 * 60 * 1000 * step
        if (timeframe === 2) {
          let startDate = new Date(today.getFullYear(), today.getMonth() + 1, 1)
          if (today.getMonth() == 11) {
            startDate = new Date(today.getFullYear() + 1, 0, 1)
          }
          startDate.setFullYear(startDate.getFullYear() - 1)
          startTime = startDate.getTime() // last 12 months
        }
        let isDst = false
        try {
          isDst = moment().tz(timezone).isDST()
        } catch (e) {
          logger.error(`Error in getProfitByUser: ${e}`)
        }
        const resultConvertSteps: PipelineStage.Lookup['$lookup']['pipeline'] =
          [
            {
              $group: {
                _id:
                  timeframe === 0
                    ? {
                        $toDate: {
                          $add: [
                            {
                              $toLong: {
                                $dateFromParts: {
                                  day: {
                                    $dayOfMonth: {
                                      date: '$date',
                                      timezone,
                                    },
                                  },
                                  month: {
                                    $month: {
                                      date: '$date',
                                      timezone,
                                    },
                                  },
                                  year: {
                                    $year: {
                                      date: '$date',
                                      timezone,
                                    },
                                  },
                                  timezone,
                                },
                              },
                            },
                            isDst ? 3600000 : 0,
                          ],
                        },
                      }
                    : timeframe === 1
                      ? {
                          week: {
                            [user.data?.weekStart === 'm'
                              ? '$isoWeek'
                              : '$week']: {
                              date: '$date',
                              timezone,
                            },
                          },
                          year: {
                            [user.data?.weekStart === 'm'
                              ? '$isoWeekYear'
                              : '$year']: {
                              date: '$date',
                              timezone,
                            },
                          },
                        }
                      : {
                          month: {
                            $month: {
                              date: '$date',
                              timezone,
                            },
                          },
                          year: {
                            $year: {
                              date: '$date',
                              timezone,
                            },
                          },
                        },
                quote: {
                  $sum: '$profitUsdt',
                },
              },
            },
            {
              $project: {
                date: '$_id',
                week:
                  timeframe === 0
                    ? '$_id.week'
                    : {
                        $convert: {
                          input: {
                            $add: [
                              '$_id.week',
                              user.data?.weekStart === 'm' ? 0 : 1,
                            ],
                          },
                          to: 'string',
                        },
                      },
                month:
                  timeframe === 0
                    ? '$_id.month'
                    : {
                        $convert: { input: '$_id.month', to: 'string' },
                      },
                year:
                  timeframe === 0
                    ? '$_id.year'
                    : {
                        $convert: { input: '$_id.year', to: 'string' },
                      },
                quote: '$quote',
              },
            },
            {
              $project: {
                date:
                  timeframe === 0
                    ? { $toDate: { $toLong: '$date' } }
                    : timeframe === 1
                      ? {
                          $concat: ['$year', '-', '$week'],
                        }
                      : {
                          $concat: ['$year', '-', '$month'],
                        },
                quote: 1,
              },
            },
          ]
        const agg: PipelineStage[] = [
          {
            $match: {
              userId: `${user.data._id}`,
              // @ts-ignore
              paperContext: paperContext ? { $eq: true } : { $ne: true },
              time: { $gte: startTime },
            },
          },
          {
            $project: {
              _id: 1,
              profitUsdt: '$profitUsd',
              date: {
                $convert: {
                  input: '$time',
                  to: 'date',
                  onError: '$$NOW',
                },
              },
            },
          },
          ...resultConvertSteps,
          {
            $project: {
              _id: 0,
              quote: 1,
              date: 1,
            },
          },
        ]
        const res = await userProfitByHourDb.aggregate(agg)
        return res
      }
    },
    getLatestOrders: async (
      _parent: any,
      { input }: { input?: { page?: number } },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      if (token === 'demo') {
        const agg: PipelineStage[] = [
          {
            $match: {
              _id: user.data._id,
            },
          },
          {
            $facet: {
              grid: [
                {
                  $lookup: {
                    let: {
                      search: {
                        $toString: '$_id',
                      },
                    },
                    pipeline: [
                      {
                        $match: {
                          $expr: {
                            $and: [
                              {
                                $eq: ['$userId', '$$search'],
                              },
                              {
                                $eq: ['$public', true],
                              },
                              // @ts-ignore
                              {
                                [paperContext ? '$eq' : '$ne']: [
                                  '$paperContext',
                                  true,
                                ],
                              },
                            ],
                          },
                        },
                      },
                      {
                        $project: {
                          _id: 1,
                        },
                      },
                    ],
                    as: 'grid',
                    from: 'bots',
                  },
                },
                {
                  $unwind: '$grid',
                },
                {
                  $replaceRoot: {
                    newRoot: '$grid',
                  },
                },
              ],
              dca: [
                {
                  $lookup: {
                    let: {
                      search: {
                        $toString: '$_id',
                      },
                    },
                    pipeline: [
                      {
                        $match: {
                          $expr: {
                            $and: [
                              {
                                $eq: ['$userId', '$$search'],
                              },
                              {
                                $eq: ['$public', true],
                              },
                              // @ts-ignore
                              {
                                [paperContext ? '$eq' : '$ne']: [
                                  '$paperContext',
                                  true,
                                ],
                              },
                            ],
                          },
                        },
                      },
                      {
                        $project: {
                          _id: 1,
                        },
                      },
                    ],
                    as: 'dca',
                    from: 'dcabots',
                  },
                },
                {
                  $unwind: '$dca',
                },
                {
                  $replaceRoot: {
                    newRoot: '$dca',
                  },
                },
              ],
              combo: [
                {
                  $lookup: {
                    let: {
                      search: {
                        $toString: '$_id',
                      },
                    },
                    pipeline: [
                      {
                        $match: {
                          $expr: {
                            $and: [
                              {
                                $eq: ['$userId', '$$search'],
                              },
                              {
                                $eq: ['$public', true],
                              },
                              // @ts-ignore
                              {
                                [paperContext ? '$eq' : '$ne']: [
                                  '$paperContext',
                                  true,
                                ],
                              },
                            ],
                          },
                        },
                      },
                      {
                        $project: {
                          _id: 1,
                        },
                      },
                    ],
                    as: 'combo',
                    from: 'combobots',
                  },
                },
                {
                  $unwind: '$combo',
                },
                {
                  $replaceRoot: {
                    newRoot: '$combo',
                  },
                },
              ],
            },
          },
          {
            $project: {
              ids: {
                $setUnion: ['$grid', '$dca', '$combo'],
              },
            },
          },
          {
            $unwind: {
              path: '$ids',
              includeArrayIndex: 'ind',
              preserveNullAndEmptyArrays: false,
            },
          },
          {
            $lookup: {
              let: {
                search: {
                  $toString: '$ids._id',
                },
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        {
                          $eq: ['$botId', '$$search'],
                        },
                        {
                          $eq: ['$status', 'FILLED'],
                        },
                      ],
                    },
                  },
                },
                {
                  $sort: {
                    updated: -1,
                  },
                },
                {
                  $limit: 10,
                },
              ],
              as: 'orders',
              from: 'orders',
            },
          },
          {
            $unwind: {
              path: '$orders',
              includeArrayIndex: 'ind',
              preserveNullAndEmptyArrays: false,
            },
          },
          {
            $replaceRoot: {
              newRoot: '$orders',
            },
          },
        ]
        const res = await userDb.aggregate(agg)
        return res
      }
      // Hoisted out of the call so `readData` and `countData` share one filter.
      // Without a contextual type the literal widens `status` to `string`, which
      // no longer satisfies `QueryFilter<ExcludeDoc<OrderSchema>>` and breaks
      // `readData`'s isArray overload resolution — keep the enum type explicit.
      const ordersSearch = {
        userId: user.data._id,
        status: 'FILLED' as OrderStatusType,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
      }
      // `total` below is clamped to 100, so counting every FILLED order the user has
      // (millions for an active account) only to throw the number away cost seconds.
      // Bound the count to the ceiling we actually report and run it alongside the page.
      const [orders, ordersCount] = await Promise.all([
        orderDb.readData(
          ordersSearch,
          undefined,
          {
            limit: 10,
            sort: { updateTime: -1 },
            skip: (input?.page ?? 0) * 10,
          },
          true,
        ),
        orderDb.countData(ordersSearch, 100),
      ])
      const bots: Types.ObjectId[] = []
      ;(orders.data?.result ?? []).map((o: ExcludeDoc<OrderSchema>) => {
        bots.push(new Types.ObjectId(o.botId))
      })
      const grids = await botDb.readData(
        {
          _id: { $in: bots },
        },
        {
          'settings.name': 1,
          _id: 1,
        },
        {},
        true,
      )
      const dcas = await dcaBotDb.readData(
        {
          _id: { $in: bots },
        },
        {
          'settings.name': 1,
          'settings.type': 1,
          _id: 1,
        },
        {},
        true,
      )
      const combos = await comboBotDb.readData(
        {
          _id: { $in: bots },
        },
        {
          'settings.name': 1,
          _id: 1,
        },
        {},
        true,
      )
      return {
        status: orders.status,
        reason: orders.status === StatusEnum.notok ? orders.reason : null,
        data: {
          result:
            orders.status === StatusEnum.ok
              ? orders.data.result.map((o) => {
                  const findGrid = (grids.data?.result ?? []).find(
                    (g) => g._id.toString() === o.botId,
                  )
                  const findDca = (dcas.data?.result ?? []).find(
                    (g) => g._id.toString() === o.botId,
                  )
                  const findCombo = (combos.data?.result ?? []).find(
                    (g) => g._id.toString() === o.botId,
                  )
                  return {
                    ...o,
                    botName:
                      findGrid?.settings.name ??
                      findDca?.settings.name ??
                      findCombo?.settings.name ??
                      '',
                    botType: findGrid
                      ? BotType.grid
                      : findDca
                        ? BotType.dca
                        : findCombo
                          ? BotType.combo
                          : undefined,
                    terminal: findDca?.settings.type === DCATypeEnum.terminal,
                  }
                })
              : null,
        },
        total:
          orders.status === StatusEnum.notok ||
          ordersCount.status === StatusEnum.notok
            ? 0
            : Math.min(100, ordersCount.data.result),
      }
    },
    getAllOpenOrders: async (
      _parent: any,
      { input }: { input?: { exchangeUUID: string } },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.filter(
        (e) =>
          (input ? e.uuid === input.exchangeUUID : true) &&
          isPaper(e.provider) === paperContext,
      )
      if (!exchange.length) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      return getAllOpenOrders(exchange)
    },
    getAllOpenPositions: async (
      _parent: any,
      { input }: { input?: { exchangeUUID: string } },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.filter(
        (e) =>
          (input ? e.uuid === input.exchangeUUID : true) &&
          isPaper(e.provider) === paperContext,
      )
      if (!exchange.length) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      return getAllOpenPositions(exchange, user.data._id.toString())
    },
    getUsdRate: async (_parent: any, {}, {}: InputRequest) => {
      const rate = await rateDb.readData(
        {},
        undefined,
        {
          limit: 1,
          sort: { created: -1 },
        },
        false,
        false,
      )
      if (rate.status === StatusEnum.notok) {
        return rate
      } else {
        return { ...rate, data: rate.data.result?.usdRate ?? 1 }
      }
    },
    getPairInfo: async (
      _parent: any,
      { input }: { input: { pair: string; exchange: ExchangeEnum } },
    ) => {
      const pair = await pairDb.readData(
        { pair: input.pair, exchange: input.exchange },
        undefined,
        {},
        true,
        true,
      )
      if (pair.status === StatusEnum.notok) {
        return pair
      }
      if (pair.data.count === 0) {
        return {
          status: StatusEnum.notok,
          reason: `Data about ${input.pair} not found`,
          data: null,
        }
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: pair.data.result[0],
      }
    },
    getAllPairs: async (_parent: any, {}, { paperContext }: InputRequest) => {
      const isPaperContext = !!paperContext
      const cacheKey: PairsCacheKey = isPaperContext ? 'paper' : 'real'
      const cacheEntry = pairsRuntimeCache[cacheKey]
      const exchangeFilter = {
        exchange: { $regex: isPaperContext ? 'paper' : '^(?!paper)' },
      }

      const latest = await pairDb.readData(
        {},
        { updated: 1 },
        { sort: { updated: -1 } },
      )
      if (latest.status === StatusEnum.notok) {
        return latest
      }

      const latestDoc = latest.data.result
      const latestKey = buildPairsLatestKey(latestDoc)

      if (cacheEntry.result !== null && cacheEntry.latestKey === latestKey) {
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            result: cacheEntry.result,
          },
        }
      }

      if (!latestDoc) {
        cacheEntry.latestKey = null
        cacheEntry.result = []
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            result: [],
          },
        }
      }

      const pairs = await pairDb.readData(exchangeFilter, undefined, {}, true)
      if (pairs.status === StatusEnum.ok) {
        cacheEntry.latestKey = latestKey
        cacheEntry.result = pairs.data.result
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            result: pairs.data.result,
          },
        }
      }
      return pairs
    },
    getMessageBot: async (
      _parent: any,
      {
        input,
      }: {
        input?: {
          unreadOnly?: boolean
          page?: number
          pageSize?: number
          search?: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return getBotMessage(
        user.data._id,
        paperContext,
        input?.unreadOnly,
        input?.page,
        input?.pageSize,
        input?.search,
      )
    },
    getQuantRulesStatus: async (
      _parent: any,
      _args: any,
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return getQuantRulesStatus(user.data._id)
    },
    resetDealSettings: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.resetDealSettings(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        !!user.data.paperContext,
      )
    },
    resetComboDealSettings: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.resetComboDealSettings(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        !!user.data.paperContext,
      )
    },
    getDCADeals: async (
      _: any,
      {
        input,
      }: {
        input?: {
          terminal?: boolean
        }
      },
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await dcaDealsDb.aggregate([
        {
          $match: {
            userId: user.data._id.toString(),
            // @ts-ignore
            status: { $in: ['open', 'start', 'error'] },
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            type: input?.terminal
              ? { $eq: 'terminal' }
              : //@ts-ignore
                { $nin: ['terminal'] },
            //@ts-ignore
            parentBotId: { $exists: false },
          },
        },
        { $limit: 500 },
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcaBot',
            let: { searchBotId: { $toObjectId: '$botId' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$searchBotId'] } } },
              {
                $project: {
                  settings: 1,
                  symbol: 1,
                  _id: 1,
                  status: 1,
                  public: 1,
                  exchange: 1,
                },
              },
            ],
          },
        },
      ])
      return response
    },
    getComboDeals: async (
      _: any,
      {},
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await comboDealsDb.aggregate([
        {
          $match: {
            userId: user.data._id.toString(),
            // @ts-ignore
            status: { $in: ['open', 'start', 'error'] },
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            // @ts-ignore
            parentBotId: { $exists: false },
          },
        },
        { $limit: 500 },
        {
          $lookup: {
            from: 'combobots',
            as: 'dcaBot',
            let: { searchBotId: { $toObjectId: '$botId' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$searchBotId'] } } },
              {
                $project: {
                  settings: 1,
                  symbol: 1,
                  _id: 1,
                  status: 1,
                  public: 1,
                  exchange: 1,
                },
              },
            ],
          },
        },
      ])
      return response
    },
    getHedgeComboDeals: async (
      _: any,
      {},
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await comboDealsDb.aggregate([
        {
          $match: {
            userId: user.data._id.toString(),
            // @ts-ignore
            status: { $in: ['open', 'start', 'error'] },
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            // @ts-ignore
            parentBotId: { $exists: true },
          },
        },
        { $limit: 500 },
        {
          $lookup: {
            from: 'combobots',
            as: 'dcaBot',
            let: { searchBotId: { $toObjectId: '$botId' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$searchBotId'] } } },
              {
                $project: {
                  settings: 1,
                  symbol: 1,
                  _id: 1,
                  status: 1,
                  public: 1,
                  exchange: 1,
                },
              },
            ],
          },
        },
      ])
      return response
    },
    getHedgeDcaDeals: async (
      _: any,
      {},
      { token, paperContext }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await dcaDealsDb.aggregate([
        {
          $match: {
            userId: user.data._id.toString(),
            // @ts-ignore
            status: { $in: ['open', 'start', 'error'] },
            // @ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            // @ts-ignore
            parentBotId: { $exists: true },
          },
        },
        { $limit: 500 },
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcaBot',
            let: { searchBotId: { $toObjectId: '$botId' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$searchBotId'] } } },
              {
                $project: {
                  settings: 1,
                  symbol: 1,
                  _id: 1,
                  status: 1,
                  public: 1,
                  exchange: 1,
                },
              },
            ],
          },
        },
      ])
      return response
    },
    restartBot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          type: BotType
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.restartBot(
        user.data._id.toString(),
        input,
        !!user.data.paperContext,
      )
    },
    getBacktests: async (
      _parent: any,
      { input }: { input?: DataGridFilterInput },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const result = await backtestDb.readData(
        { userId: user.data._id.toString(), ...filter },
        undefined,
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getComboBacktests: async (
      _parent: any,
      { input }: { input?: DataGridFilterInput },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const result = await comboBacktestDb.readData(
        { userId: user.data._id.toString(), ...filter },
        undefined,
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getHedgeComboBacktests: async (
      _parent: any,
      { input }: { input?: DataGridFilterInput },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const result = await hedgeComboBacktestDb.readData(
        { userId: user.data._id.toString(), ...filter },
        undefined,
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getHedgeDCABacktests: async (
      _parent: any,
      { input }: { input?: DataGridFilterInput },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const result = await hedgeDcaBacktestDb.readData(
        { userId: user.data._id.toString(), ...filter },
        undefined,
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getLeverageBracketsByUUID: async (
      _parent: any,
      { input: { uuid } }: { input: { uuid: string } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const find = user.data.exchanges.find((e) => e.uuid === uuid)
      if (!find) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not exist on user',
          data: null,
        }
      }
      if (!isFutures(find.provider)) {
        return {
          status: StatusEnum.notok,
          reason: 'Action supported is only by futures exchange',
          data: null,
        }
      }
      // The table depends on the exchange universe, not on the account, so it
      // is cached/coalesced per (provider, okxSource) and bounded by a timeout
      // — an exchange-side queue backlog used to hang the bot form for tens of
      // seconds. See utils/leverageBracketCache.
      return await getLeverageBracketsCached(
        find.provider,
        find.okxSource,
        () =>
          new Exchange(
            find.provider,
            find.key,
            find.secret,
            find.passphrase,
            undefined,
            undefined,
            find.okxSource,
          ).futures_leverageBracket(),
      )
    },
    getBacktestByShareId: async (
      _parent: any,
      { input }: { input: { shareId: string } },
    ) => {
      const result = await backtestDb.readData({ shareId: input.shareId })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    getComboBacktestByShareId: async (
      _parent: any,
      { input }: { input: { shareId: string } },
    ) => {
      const result = await comboBacktestDb.readData({ shareId: input.shareId })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    getHedgeComboBacktestByShareId: async (
      _parent: any,
      { input }: { input: { shareId: string } },
    ) => {
      const result = await hedgeComboBacktestDb.readData({
        shareId: input.shareId,
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    getHedgeDCABacktestByShareId: async (
      _parent: any,
      { input }: { input: { shareId: string } },
    ) => {
      const result = await hedgeDcaBacktestDb.readData({
        shareId: input.shareId,
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    getGridBacktestByShareId: async (
      _parent: any,
      { input }: { input: { shareId: string } },
    ) => {
      const result = await gridBacktestDb.readData({ shareId: input.shareId })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    getGridBacktests: async (
      _parent: any,
      { input }: { input?: DataGridFilterInput },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const result = await gridBacktestDb.readData(
        { userId: user.data._id.toString(), ...filter },
        undefined,
        { ...rest },
        true,
        true,
      )
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? result.data.result : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
        total: result.status === StatusEnum.ok ? result.data.count : 0,
      }
    },
    getUserFavoritePairs: async (
      _parent: any,
      {},
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return favoritePairsDb
        .readData({ userId: user.data._id }, undefined, undefined, true)
        .then((res) => {
          if (res.status === StatusEnum.notok) {
            return res
          }
          return {
            ...res,
            data: res.data.result || [],
          }
        })
    },
    getUserFavoriteIndicators: async (
      _parent: any,
      {},
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return favoriteIndicatorsDb
        .readData({ userId: user.data._id })
        .then((res) => {
          if (res.status === StatusEnum.notok) {
            return res
          }
          return {
            ...res,
            data: { indicators: res?.data?.result?.indicators || [] },
          }
        })
    },
    getGlobalVariables: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          page?: number
          pageSize?: number
          sortModel?: []
          filterModel?: { items: [] }
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions(input)
      const response = await globalVarsDb.readData(
        { ...filter, userId: `${user.data._id}` },
        {},
        rest,
        true,
        true,
      )
      return {
        status: response.status,
        data:
          response.status === StatusEnum.ok
            ? response.data.result.map((i: any) => ({ id: i._id, ...i }))
            : null,
        reason: response.status === StatusEnum.ok ? null : response.reason,
        total: response.status === StatusEnum.ok ? response.data.count : 0,
      }
    },
    getGlobalVariableRelatedBots: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await globalVarsDb.readData({
        _id: `${input.id}`,
        userId: `${user.data._id}`,
      })
      if (response.status === StatusEnum.notok) {
        return response
      }
      if (!response.data.result) {
        return {
          status: StatusEnum.notok,
          reason: 'Variable not found',
          data: null,
        }
      }
      const bots = await getBotsByGlobalVar(`${input.id}`, true)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: bots,
      }
    },
    getGlobalVariablesByIds: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          ids: string[]
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await globalVarsDb.readData(
        {
          _id: { $in: input.ids.map((id) => new Types.ObjectId(id)) },
          userId: `${user.data._id}`,
        },
        {},
        {},
        true,
        true,
      )
      return {
        status: response.status,
        data:
          response.status === StatusEnum.ok
            ? response.data.result.map((i) => ({ id: `${i._id}`, ...i }))
            : null,
        reason: response.status === StatusEnum.ok ? null : response.reason,
      }
    },
  }
  const Mutation = {
    resetAccount: async (
      _parents: any,
      { input }: { input: { type: ResetAccountTypeEnum } },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      resetUser(user.data._id.toString(), input.type)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Reset account action sent. Please wait few minutes and refresh the page.',
      }
    },
    moveDealToTerminal: async (
      _parents: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          combo: boolean
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      const { botId, dealId, combo } = input
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      let bot
      let deal
      if (combo) {
        bot = await comboBotDb.readData({
          userId: user.data._id.toString(),
          _id: botId,
        })
        if (
          bot.status === StatusEnum.notok ||
          !bot.data ||
          !('result' in bot.data)
        ) {
          return {
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          }
        }
        deal = await comboDealsDb.readData({ _id: dealId, botId })
        if (
          deal.status === StatusEnum.notok ||
          !deal.data ||
          !('result' in deal.data)
        ) {
          return {
            status: StatusEnum.notok,
            reason: 'Deal not found',
            data: null,
          }
        }
      } else {
        bot = await dcaBotDb.readData({
          userId: user.data._id.toString(),
          _id: botId,
        })
        if (
          bot.status === StatusEnum.notok ||
          !bot.data ||
          !('result' in bot.data)
        ) {
          return {
            status: StatusEnum.notok,
            reason: 'Bot not found',
            data: null,
          }
        }
        deal = await dcaDealsDb.readData({ _id: dealId, botId })
        if (
          deal.status === StatusEnum.notok ||
          !deal.data ||
          !('result' in deal.data)
        ) {
          return {
            status: StatusEnum.notok,
            reason: 'Deal not found',
            data: null,
          }
        }
      }

      const dcaBot = bot.data.result
      const dcaDeal = deal.data.result
      const exchange = dcaBot.exchange
      const exchangeUUID = dcaBot.exchangeUUID
      const leverage = dcaBot.settings.futures
        ? dcaBot.settings.marginType !== BotMarginTypeEnum.inherit
          ? dcaBot.settings.leverage || 1
          : 1
        : 1

      const isLong = dcaBot.settings.strategy === 'LONG'
      const isSpot = !isFutures(exchange)
      const isCoinmFutures = isCoinm(exchange)
      const baseOrderSize = isSpot
        ? isLong
          ? dcaDeal.usage.current.quote
          : dcaDeal.usage.current.base
        : isCoinmFutures
          ? dcaDeal.usage.current.base / leverage
          : dcaDeal.usage.current.quote / leverage
      const orderSize = `${Math.abs(baseOrderSize)}`

      const ref = (
        isSpot ? (isLong ? 'quote' : 'base') : isCoinmFutures ? 'base' : 'quote'
      ) as Currency

      const newBotData = {
        pair: [dcaDeal.symbol.symbol],
        name: '',
        strategy: dcaBot.settings.strategy,
        profitCurrency: dcaDeal.settings.profitCurrency,
        baseOrderSize: orderSize,
        startOrderType: OrderTypeEnum.limit,
        startCondition: StartConditionEnum.asap,
        tpPerc: combo ? '1' : deal.data.result.settings.tpPerc,
        orderFixedIn: ref,
        orderSize,
        step: '1',
        ordersCount: 5,
        activeOrdersCount: 1,
        volumeScale: '1',
        stepScale: '1',
        useTp: combo ? false : deal.data.result.settings.useTp,
        useSl: combo ? false : deal.data.result.settings.useSl,
        slPerc: combo ? '-10' : deal.data.result.settings.slPerc,
        useSmartOrders: false,
        minOpenDeal: '',
        maxOpenDeal: '',
        useDca: false,
        hodlDay: '7',
        hodlAt: '15:00:00',
        hodlNextBuy: new Date().getTime(),
        maxNumberOfOpenDeals: '',
        indicators: [],
        indicatorGroups: [],
        baseOrderPrice: dcaDeal.avgPrice.toString(),
        orderSizeType:
          ref === 'quote' ? OrderSizeTypeEnum.quote : OrderSizeTypeEnum.base,
        limitTimeout: '20',
        useLimitTimeout: false,
        type: DCATypeEnum.terminal,
        moveSL: false,
        moveSLTrigger: '0.5',
        moveSLValue: '0.2',
        dealCloseCondition: combo
          ? CloseConditionEnum.tp
          : deal.data.result.settings.dealCloseCondition,
        dealCloseConditionSL: combo
          ? CloseConditionEnum.tp
          : deal.data.result.settings.dealCloseConditionSL,
        terminalDealType: TerminalDealTypeEnum.import,
        trailingTpPerc: '0.3',
        useMultiTp: false,
        multiTp: [],
        useMultiSl: false,
        multiSl: [],
        marginType: dcaBot.settings.marginType,
        leverage,
        futures: isFutures(exchange),
        coinm: isCoinmFutures,
        useLimitPrice: true,
        baseAsset: [dcaDeal.symbol.baseAsset],
        quoteAsset: [dcaDeal.symbol.quoteAsset],
        exchange,
        exchangeUUID,
        importFrom: dealId,
        skipBalanceCheck: true,
      }
      const newBot = await Bot.createDCABot(
        user.data._id.toString(),
        { ...newBotData, vars: { list: [], paths: [] } },
        paperContext,
        async () =>
          combo
            ? await Bot.closeComboDeal(
                `${user.data._id}`,
                `${dcaBot._id}`,
                dealId,
                CloseDCATypeEnum.cancel,
                true,
                paperContext,
                DCACloseTriggerEnum.auto,
              )
            : await Bot.closeDCADeal(
                `${user.data._id}`,
                `${dcaBot._id}`,
                dealId,
                CloseDCATypeEnum.cancel,
                true,
                paperContext,
                DCACloseTriggerEnum.auto,
              ),
      )
      if (newBot.status === StatusEnum.notok) {
        return newBot
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Successfully created deal with terminal type',
      }
    },
    restoreDeal: async (
      _parents: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      // Restore a canceled DCA or terminal deal IN PLACE — bring it back as a
      // bare active position inside its own bot (no DCA, take profit or stop
      // loss). Canceling only cancels the open orders and marks the deal
      // canceled; the filled base position survives, so restore just flips the
      // deal back to open (bare) and reloads the bot to re-adopt it. The deal
      // returns to the bot it lived in (a terminal deal's bot is a terminal
      // bot, so terminal deals restore in the terminal). See Bot.restoreDeal.
      const { botId, dealId } = input
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const deal = await dcaDealsDb.readData({ _id: dealId, botId })
      if (
        deal.status === StatusEnum.notok ||
        !deal.data ||
        !('result' in deal.data) ||
        !deal.data.result
      ) {
        return {
          status: StatusEnum.notok,
          reason: 'Deal not found',
          data: null,
        }
      }

      // Only canceled deals can be restored.
      if (deal.data.result.status !== DCADealStatusEnum.canceled) {
        return {
          status: StatusEnum.notok,
          reason: 'Only canceled deals can be restored',
          data: null,
        }
      }

      return Bot.restoreDeal(
        user.data._id.toString(),
        botId,
        dealId,
        !!user.data.paperContext,
      )
    },
    moveGridToTerminal: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          gridId: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await botDb.readData({
        userId: user.data._id.toString(),
        _id: input.gridId,
      })

      if (response.status === StatusEnum.notok) {
        return {
          status: StatusEnum.notok,
          reason: 'Grid not found',
          data: null,
        }
      }

      const gridBot = response.data?.result
      const exchange = gridBot.exchange
      const exchangeUUID = gridBot.exchangeUUID
      const leverage = gridBot.settings.leverage
      const strategy = gridBot.settings.strategy
      if (!leverage || !strategy) {
        return
      }
      const isLong = gridBot.settings.strategy !== 'SHORT'
      const isShort = gridBot.settings.strategy === 'SHORT'
      const isSpot = !gridBot.settings.futures
      const isCoinmFutures = gridBot.settings.coinm
      let orderSize = '0'
      let orderRef = 'base'

      if (isSpot) {
        if (isLong) {
          orderSize = gridBot.currentBalances.base.toString()
          orderRef = 'base'
        } else if (isShort) {
          orderSize = gridBot.currentBalances.quote.toString()
          orderRef = 'quote'
        }
      } else {
        const position = gridBot.position
        const positionAmount = position.qty

        if (positionAmount > 0) {
          orderSize = `${positionAmount * leverage}`
          orderRef = isCoinmFutures ? 'base' : 'quote'
        } else {
          return {
            status: StatusEnum.notok,
            reason: 'No position available',
            data: null,
          }
        }
      }

      if (+orderSize === 0) {
        return {
          status: StatusEnum.notok,
          reason: 'Bot is not possible to move to the terminal at the moment',
          data: null,
        }
      }

      const newBotData = {
        pair: [gridBot.settings.pair],
        name: '',
        strategy,
        profitCurrency: gridBot.settings.profitCurrency,
        baseOrderSize: orderSize,
        startOrderType: OrderTypeEnum.limit,
        startCondition: StartConditionEnum.asap,
        tpPerc: '1',
        orderFixedIn: orderRef as Currency,
        orderSize,
        step: '1',
        ordersCount: 5,
        activeOrdersCount: 1,
        volumeScale: '1',
        stepScale: '1',
        useTp: false,
        useSl: false,
        slPerc: '-10',
        useSmartOrders: false,
        minOpenDeal: '',
        maxOpenDeal: '',
        useDca: false,
        hodlDay: '7',
        hodlAt: '15:00:00',
        hodlNextBuy: new Date().getTime(),
        maxNumberOfOpenDeals: '',
        indicators: [],
        baseOrderPrice: gridBot.avgPrice?.toString(),
        orderSizeType:
          orderRef === 'base'
            ? OrderSizeTypeEnum.base
            : OrderSizeTypeEnum.quote,
        limitTimeout: '20',
        useLimitTimeout: false,
        type: DCATypeEnum.terminal,
        moveSL: false,
        moveSLTrigger: '0.5',
        moveSLValue: '0.2',
        dealCloseCondition: CloseConditionEnum.tp,
        dealCloseConditionSL: CloseConditionEnum.tp,
        terminalDealType: TerminalDealTypeEnum.import,
        trailingTpPerc: '0.3',
        useMultiTp: false,
        multiTp: [],
        useMultiSl: false,
        multiSl: [],
        marginType: gridBot.settings.marginType,
        leverage: +leverage,
        futures: isFutures(exchange),
        coinm: isCoinm(exchange),
        useLimitPrice: true,
        baseAsset: [gridBot.symbol.baseAsset],
        quoteAsset: [gridBot.symbol.quoteAsset],
        exchange,
        exchangeUUID,
        importFrom: gridBot._id,
        indicatorGroups: [],
      }
      const newBot = await Bot.createDCABot(
        user.data._id.toString(),
        { ...newBotData, vars: { list: [], paths: [] } },
        paperContext,
        async () =>
          await Bot.changeStatus(
            `${user.data._id}`,
            {
              status: BotStatusEnum.closed,
              id: `${gridBot._id}`,
              cancelPartiallyFilled: true,
              type: BotType.grid,
              closeGridType: CloseGRIDTypeEnum.cancel,
            },
            paperContext,
            false,
            true,
          ),
      )
      if (newBot.status === StatusEnum.notok) {
        return newBot
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Successfully created grid with terminal type',
      }
    },
    createGlobalVariable: async (
      _parent: any,
      {
        input,
      }: {
        input: { name: string; type: GlobalVariablesTypeEnum; value: string }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      const result = await globalVarsDb.createData({
        name: input.name,
        type: input.type,
        value: input.value,
        botAmount: 0,
        userId: `${user.data._id}`,
      })

      if (result.status === StatusEnum.notok) {
        return result
      }

      return {
        status: StatusEnum.ok,
        reason: null,
        data: {
          id: result.data._id,
          name: result.data.name,
          type: result.data.type,
          value: result.data.value,
          botAmount: result.data.botAmount,
        },
      }
    },
    updateGlobalVariable: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          name: string
          value: string
          type: GlobalVariablesTypeEnum
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const response = await globalVarsDb.readData({
        _id: input.id,
        userId: `${user.data._id}`,
      })
      if (response.status === StatusEnum.notok) {
        return response
      }
      if (!response.data.result) {
        return {
          status: StatusEnum.notok,
          reason: 'Variable not found',
        }
      }
      const valueChanged = response.data.result.value !== input.value
      const result = await globalVarsDb.updateData(
        { _id: input.id, userId: `${user.data._id}` },
        { $set: { name: input.name, type: input.type, value: input.value } },
      )

      if (result.status === StatusEnum.notok) {
        return {
          status: result.status,
          reason: result.reason,
        }
      }
      if (valueChanged && response.data.result.botAmount > 0) {
        const redis = await RedisClient.getInstance()
        redis.publish(
          'updateglobalVars',
          JSON.stringify({ _id: `${input.id}` }),
        )
      }

      return {
        status: StatusEnum.ok,
        reason: null,
      }
    },
    deleteGlobalVariable: async (
      _parent: any,
      { input }: { input: { id: string } },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const count = await getBotsByGlobalVar(input.id)
      if (count > 0) {
        return {
          status: StatusEnum.notok,
          reason: 'Variable is used in bot',
        }
      }
      const result = await globalVarsDb.deleteData({
        _id: input.id,
        userId: `${user.data._id}`,
      })
      return {
        status: result.status,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    manageBalanceDiff: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          qty: number
          side: OrderSideEnum
        }
      },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return Bot.manageBalanceDiff(
        user.data._id,
        input.botId,
        input.dealId,
        input.qty,
        input.side,
      )
    },
    removeUserFiles: async (
      _parent: any,
      { input }: { input: { files: string[] } },
      { token }: InputRequest,
    ) => {
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const ids: Types.ObjectId[] = []
      ;(input.files ?? []).map((f) => {
        ids.push(new Types.ObjectId(f))
      })
      const userId = `${user.data._id}`
      const result = await filesDb.readData(
        {
          userId,
          _id: { $in: ids },
        },
        {},
        {},
        true,
      )
      if (result.status === StatusEnum.notok) {
        return result
      }
      const deleted: Types.ObjectId[] = []
      const _backtestIds: string[] = []
      for (const f of result.data.result) {
        if (f.meta?.id) {
          _backtestIds.push(f.meta.id as string)
        }
        try {
          fs.unlinkSync(f.path)
        } catch {
          deleted.push(f._id)
          continue
        }
        deleted.push(f._id)
      }
      const deleteResult = await filesDb.deleteManyData({
        userId,
        _id: { $in: deleted },
      })
      if (deleteResult.status === StatusEnum.notok) {
        return deleteResult
      }
      const backtestIds: Types.ObjectId[] = []
      for (const b of _backtestIds.filter((b) => !!b)) {
        backtestIds.push(new Types.ObjectId(b))
      }
      if (backtestIds.length) {
        const search = { _id: { $in: backtestIds } }
        const update = { $set: { serverSide: false } }
        await backtestDb.updateManyData(search, update)
        await comboBacktestDb.updateManyData(search, update)
        await gridBacktestDb.updateManyData(search, update)
      }
      return {
        status: result.status,
        reason: null,
        data: deleted.map((d) => `${d}`),
      }
    },
    requestServerSideBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          payload: ServerSideBacktestPayload
          symbols: { pair: string; baseAsset: string; quoteAsset: string }[]
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      try {
        let requestId = ''
        if (input.payload.type === BotType.dca) {
          const dcaRequest = await dcaBacktestRequestDb.createData({
            userId: `${user.data._id}`,
            status: BacktestRequestStatus.pending,
            exchange: input.payload.data.exchange,
            exchangeUUID: input.payload.data.exchangeUUID,
            symbols: input.symbols,
            type: BotType.dca,
            payload: input.payload,
            statusHistory: [
              { status: BacktestRequestStatus.pending, time: +new Date() },
            ],
            cost: 0,
          })
          if (dcaRequest.status === StatusEnum.notok) {
            return dcaRequest
          }
          requestId = `${dcaRequest.data._id}`
        }
        if (input.payload.type === BotType.combo) {
          const dcaRequest = await comboBacktestRequestDb.createData({
            userId: `${user.data._id}`,
            status: BacktestRequestStatus.pending,
            exchange: input.payload.data.exchange,
            exchangeUUID: input.payload.data.exchangeUUID,
            symbols: input.symbols,
            type: BotType.combo,
            payload: input.payload,
            statusHistory: [
              { status: BacktestRequestStatus.pending, time: +new Date() },
            ],
            cost: 0,
          })
          if (dcaRequest.status === StatusEnum.notok) {
            return dcaRequest
          }
          requestId = `${dcaRequest.data._id}`
        }
        if (input.payload.type === BotType.grid) {
          const dcaRequest = await gridBacktestRequestDb.createData({
            userId: `${user.data._id}`,
            status: BacktestRequestStatus.pending,
            exchange: input.payload.data.exchange,
            exchangeUUID: input.payload.data.exchangeUUID,
            symbols: input.symbols,
            type: BotType.grid,
            payload: input.payload,
            statusHistory: [
              { status: BacktestRequestStatus.pending, time: +new Date() },
            ],
            cost: 0,
          })
          if (dcaRequest.status === StatusEnum.notok) {
            return dcaRequest
          }
          requestId = `${dcaRequest.data._id}`
        }
        await sendServerSideRequest(input.payload, user.data._id, requestId)
        return {
          status: StatusEnum.ok,
          data: 'Request sent',
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
    },
    addDealFunds: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          qty: string
          useLimitPrice: boolean
          limitPrice?: string
          asset: OrderSizeTypeEnum
          dealId: string
          botId: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId, dealId, ...rest } = input
      return await Bot.addDealFunds(
        botId,
        dealId,
        user.data._id.toString(),
        paperContext,
        rest,
      )
    },
    reduceDealFunds: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          qty: string
          useLimitPrice: boolean
          limitPrice?: string
          asset: OrderSizeTypeEnum
          dealId: string
          botId: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId, dealId, ...rest } = input
      return await Bot.reduceDealFunds(
        botId,
        dealId,
        user.data._id.toString(),
        paperContext,
        rest,
      )
    },
    cancelTerminalDealOrder: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          orderId: string
          dealId: string
          botId: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId, dealId, orderId } = input
      return await Bot.cancelTerminalDealOrder(
        botId,
        dealId,
        orderId,
        user.data._id.toString(),
        paperContext,
      )
    },
    cancelPendingAddFundsDealOrder: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          orderId: string
          dealId: string
          botId: string
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { botId, dealId, orderId } = input
      return await Bot.cancelPendingAddFundsDealOrder(
        botId,
        dealId,
        orderId,
        user.data._id.toString(),
        paperContext,
      )
    },
    resetShowError: async (
      _parent: any,
      { input: { data } }: { input: { data: { id: string; type: BotType }[] } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      for (const d of data) {
        const instance =
          d.type === BotType.dca
            ? dcaBotDb
            : d.type === BotType.combo
              ? comboBotDb
              : botDb
        //@ts-ignore
        instance.updateData(
          { _id: d.id },
          { $set: { showErrorWarning: 'none' } },
        )
      }

      return {
        status: StatusEnum.ok,
        reason: 'Reset errors accepted',
      }
    },
    setHedge: async (
      _parent: any,
      { input: { hedge, uuid } }: { input: { hedge: boolean; uuid: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find((e) => e.uuid === uuid)
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      const botStatuses = [
        BotStatusEnum.open,
        BotStatusEnum.error,
        BotStatusEnum.range,
      ]
      const bots = await botDb.readData(
        {
          userId: user.data._id.toString(),
          exchangeUUID: uuid,
          status: {
            $in: botStatuses,
          },
        },
        { _id: 1 },
        {},
        true,
        true,
      )
      const dcaBots = await dcaBotDb.readData(
        {
          userId: user.data._id.toString(),
          exchangeUUID: uuid,
          $or: [
            { status: { $in: botStatuses } },
            { 'deals.active': { $gt: 0 } },
          ],
        },
        { _id: 1 },
        {},
        true,
        true,
      )
      const comboBots = await comboBotDb.readData(
        {
          userId: user.data._id.toString(),
          exchangeUUID: uuid,
          $or: [
            { status: { $in: botStatuses } },
            { 'deals.active': { $gt: 0 } },
          ],
        },
        { _id: 1 },
        {},
        true,
        true,
      )
      if (
        (bots.data?.count ?? 0) > 0 ||
        (dcaBots.data?.count ?? 0) > 0 ||
        (comboBots.data?.count ?? 0) > 0
      ) {
        return {
          status: StatusEnum.notok,
          reason: 'Cannot change hedge mode with active bots',
          data: null,
        }
      }
      const exchangeInstance = ExchangeChooser.chooseExchangeFactory(
        exchange.provider,
      )(
        exchange.key,
        exchange.secret,
        exchange.passphrase,
        undefined,
        exchange.keysType,
        exchange.okxSource,
        exchange.bybitHost,
      )
      const result = await exchangeInstance.setHedge(hedge)
      if (result.status === StatusEnum.notok) {
        return result
      }
      await userDb.updateData(
        { _id: user.data._id },
        {
          $set: {
            exchanges: user.data.exchanges.map((e) => {
              if (e.uuid === uuid) {
                e.hedge = hedge
                e.status = true
                e.lastUpdated = +new Date()
              }
              return e
            }),
          },
        },
      )
      return result
    },
    setZeroFee: async (
      _parent: any,
      { input: { value, uuid } }: { input: { value: boolean; uuid: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find((e) => e.uuid === uuid)
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      const update = await userDb.updateData(
        { _id: user.data._id },
        {
          $set: {
            exchanges: user.data.exchanges.map((e) => {
              if (e.uuid === uuid) {
                e.zeroFee = value
              }
              return e
            }),
          },
        },
      )
      if (update.status === StatusEnum.notok) {
        return update
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: value,
      }
    },
    token: async (
      _parent: any,
      { input }: { input: { username: string; password: string } },
      { userAgent, ip }: InputRequest,
    ) => {
      const { username, password } = input

      const validRegex =
        /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/

      if (!username.match(validRegex)) {
        return {
          status: StatusEnum.notok,
          reason: 'Please input valid Email.',
          data: null,
        }
      }

      const findUser = await userDb.readData({
        username,
      })
      if (
        findUser.status === StatusEnum.ok &&
        findUser.data &&
        findUser.data.result
      ) {
        const stored = findUser.data.result.password
        if (await verifyPasswordHash(password, stored)) {
          // Transparent migration: if the stored value is still legacy AES
          // ciphertext, the password just matched via the decrypt fallback —
          // rehash it with bcrypt and persist, so the account upgrades on this
          // login and never decrypt-compares again.
          if (!isBcryptHash(stored)) {
            await userDb.updateData(
              { username },
              { $set: { password: await hashPassword(password) } },
            )
          }
          return await createOrUpdateUser(
            { email: username, password },
            userAgent,
            ip,
          )
        }
        return {
          status: StatusEnum.notok,
          reason: 'Password not correct',
          data: null,
        }
      }
      return {
        status: StatusEnum.notok,
        reason: 'Sign up Error',
        data: null,
      }
    },
    setLicenseKey: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          key: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return await userDb
        .updateData(
          { _id: user.data._id },
          {
            $set: {
              licenseKey: input.key,
            },
          },
        )
        .then((res) => {
          if (res.status === StatusEnum.notok) {
            return res
          }
          return {
            status: StatusEnum.ok,
            reason: 'License key updated',
            data: null,
          }
        })
    },
    deleteLicenseKey: async (
      _parent: any,
      {},
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return await userDb
        .updateData(
          { _id: user.data._id },
          {
            $unset: {
              licenseKey: '',
            },
          },
        )
        .then((res) => {
          if (res.status === StatusEnum.notok) {
            return res
          }
          return {
            status: StatusEnum.ok,
            reason: 'License key deleted',
            data: null,
          }
        })
    },
    registerAccount: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          email: string
          password: string
          picture?: string
          lastName?: string
          name?: string
          timezone: string
          weekStart?: string
          licenseKey: string
        }
      },
      { userAgent, ip }: InputRequest,
    ) => {
      const { email } = input

      const users = await userDb.countData({})

      if (users.status === StatusEnum.notok) {
        return {
          status: StatusEnum.notok,
          reason: 'Error while checking users count',
          data: null,
        }
      }

      if (!!users.data.result) {
        return {
          status: StatusEnum.notok,
          reason: 'Registration is closed',
          data: null,
        }
      }

      const validateLicense = await checkLicenseKey(input.licenseKey, true)

      if (!validateLicense.valid) {
        return {
          status: StatusEnum.notok,
          reason: 'Invalid license key',
          data: null,
        }
      }

      const validRegex =
        /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/

      if (!email.match(validRegex)) {
        return {
          status: StatusEnum.notok,
          reason: 'Please input valid Email.',
          data: null,
        }
      }

      return await createOrUpdateUser(input, userAgent, ip, true)
    },
    userSettings: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          timezone?: string
          theme?: string
          paperContext?: boolean
          shouldOnBoard?: boolean
          shouldOnBoardExchange?: boolean
          name?: string
          lastName?: string
          nickname?: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const {
        timezone,
        theme,
        paperContext,
        shouldOnBoardExchange,
        shouldOnBoard,
        name,
        lastName,
        nickname,
      } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const $set: {
        timezone?: string
        theme?: string
        paperContext?: boolean
        shouldOnBoard?: boolean
        shouldOnBoardExchange?: boolean
        displayName?: string
        name?: string
        lastName?: string
        nickname?: string
        'userDefined.name'?: string
      } = {}
      if (name) {
        $set.name = name
        $set['userDefined.name'] = name
      }
      if (lastName) {
        $set.lastName = lastName
      }
      if (timezone) {
        $set.timezone = timezone
      }
      if (theme) {
        $set.theme = theme
      }
      if (paperContext !== undefined) {
        $set.paperContext = paperContext
      }
      if (shouldOnBoard !== undefined) {
        $set.shouldOnBoard = shouldOnBoard
      }
      if (shouldOnBoardExchange !== undefined) {
        $set.shouldOnBoardExchange = shouldOnBoardExchange
      }
      if (nickname !== undefined) {
        $set.nickname = nickname
      }
      if (Object.keys($set).length > 0) {
        const saveDataRequest = await userDb.updateData(
          { _id: user.data._id },
          {
            $set,
          },
          true,
          true,
        )
        if (saveDataRequest.status === StatusEnum.notok) {
          return saveDataRequest
        }
        return {
          status: StatusEnum.ok,
          reason: 'User data saved',
        }
      }

      return {
        status: StatusEnum.ok,
        reason: 'Nothing changed',
      }
    },
    addExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: Omit<
          ExchangeInUser & {
            stablecoinBalance?: number
            coinToTopUp?: string
            topUps?: { provider: ExchangeEnum; asset: string; amount: number }[]
            tradeType?: TradeTypeEnum
            shouldCheckAffiliate?: boolean
          },
          'uuid'
        >
      },
      { token, req }: InputRequest,
    ) => {
      try {
        if (token === 'demo' || !req.user?.authorized) {
          return errorAccess()
        }
        const {
          provider,
          name,
          stablecoinBalance,
          coinToTopUp,
          topUps,
          tradeType: _tradeType,
          keysType,
          okxSource,
          bybitHost,
          subaccount,
        } = input
        const { shouldCheckAffiliate } = input
        const tradeType = _tradeType ?? TradeTypeEnum.spot
        const { passphrase } = input
        let { key, secret } = input
        if (!isExchangeEnabled(provider)) {
          return {
            status: StatusEnum.notok,
            reason: `Exchange ${provider} is disabled by host configuration`,
            data: null,
          }
        }
        const user = await findUser(token)
        if (user.status === StatusEnum.notok) {
          return user
        }
        const tradeTypesToUse =
          tradeType === TradeTypeEnum.all
            ? [TradeTypeEnum.spot, TradeTypeEnum.futures]
            : [tradeType]
        const uuids: string[] = []
        const returnExchanges: ExchangeInUser[] = []
        for (const tt of tradeTypesToUse) {
          // Captured from verification so every leg created for this trade type
          // is stored with the permissions we just observed — the periodic
          // re-check then has a baseline to compare against instead of having
          // to treat every pre-existing connection as never-checked.
          let observedPermissions: ExchangeKeyPermissions | undefined
          if (!paperExchanges.includes(provider)) {
            const verifyResult = await verify.verifyExchange(
              tt,
              provider,
              key,
              secret,
              passphrase || '',
              keysType,
              okxSource,
              bybitHost,
              subaccount,
            )
            observedPermissions = verifyResult.permissions
            // Fund-movement permission is refused outright on a NEW
            // connection. Safe to hard-fail here (unlike re-verification): the
            // user is at the form and has nothing running yet. Checked before
            // the `!verifyResult.status` branch so such a key gets the
            // actionable message rather than a generic "not valid".
            //
            // `permissions` must be passed through: without it the message
            // cannot name which capability was found and silently falls back
            // to the transfer wording (plus a Bybit-specific hint) even for a
            // genuine withdrawal key on another exchange.
            if (shouldRejectNewConnection(verifyResult.permissions)) {
              logger.warn(
                `Add exchange rejected: fund-movement permission enabled (withdraw=${verifyResult.permissions?.withdraw} transfer=${verifyResult.permissions?.transfer}), user ${user.data._id} (${user.data.username}), exchange: "${provider}", detail: ${verifyResult.permissions?.detail}`,
              )
              return {
                status: StatusEnum.notok,
                reason: withdrawalRejectionReason(
                  provider,
                  verifyResult.permissions,
                ),
                data: null,
              }
            }
            if (!verifyResult.status) {
              logger.error(
                `Add exchange verify response ${verifyResult.reason}, user ${user.data._id} (${user.data.username}), key: "${key}", exchange: "${provider}" `,
              )
              return {
                status: StatusEnum.notok,
                reason: `API keys not valid for ${tt}`,
                data: null,
              }
            }
            // Provider is checked first, so connections of another provider
            // are never unwrapped at all.
            const find = await findMatchingConnection(
              user.data.exchanges,
              { key, secret, passphrase },
              (e) => e.provider === provider,
            )
            if (find) {
              return {
                status: StatusEnum.notok,
                reason: `This API keys already exsits in ${
                  find.name ? `${find.name} (${find.provider})` : find.provider
                }`,
              }
            }
          }
          for (const e of tt === TradeTypeEnum.futures &&
          provider === ExchangeEnum.bybit
            ? [ExchangeEnum.bybitCoinm, ExchangeEnum.bybitUsdm]
            : tt === TradeTypeEnum.futures &&
                provider === ExchangeEnum.paperBybit
              ? [ExchangeEnum.paperBybitCoinm, ExchangeEnum.paperBybitUsdm]
              : tt === TradeTypeEnum.futures &&
                  provider === ExchangeEnum.paperKucoin
                ? [
                    ExchangeEnum.paperKucoinInverse,
                    ExchangeEnum.paperKucoinLinear,
                  ]
                : tt === TradeTypeEnum.futures &&
                    provider === ExchangeEnum.kucoin
                  ? [ExchangeEnum.kucoinInverse, ExchangeEnum.kucoinLinear]
                  : tt === TradeTypeEnum.futures &&
                      provider === ExchangeEnum.okx
                    ? // OKX Europe (my.okx.com) only offers linear X-Perps, no
                      // inverse/COIN-M product — splitting off an Inverse leg
                      // for it left users with an unrequested, untradeable
                      // sub-account defaulted to 0.5 BTC (see isAllCoinm below).
                      okxSource === OKXSource.my
                      ? [ExchangeEnum.okxLinear]
                      : [ExchangeEnum.okxInverse, ExchangeEnum.okxLinear]
                    : tt === TradeTypeEnum.futures &&
                        provider === ExchangeEnum.paperOkx
                      ? okxSource === OKXSource.my
                        ? [ExchangeEnum.paperOkxLinear]
                        : [
                            ExchangeEnum.paperOkxInverse,
                            ExchangeEnum.paperOkxLinear,
                          ]
                      : tt === TradeTypeEnum.futures &&
                          provider === ExchangeEnum.binance
                        ? [ExchangeEnum.binanceCoinm, ExchangeEnum.binanceUsdm]
                        : tt === TradeTypeEnum.futures &&
                            provider === ExchangeEnum.paperBinance
                          ? [
                              ExchangeEnum.paperBinanceCoinm,
                              ExchangeEnum.paperBinanceUsdm,
                            ]
                          : tt === TradeTypeEnum.futures &&
                              provider === ExchangeEnum.bitget
                            ? [
                                ExchangeEnum.bitgetCoinm,
                                ExchangeEnum.bitgetUsdm,
                              ]
                            : tt === TradeTypeEnum.futures &&
                                provider === ExchangeEnum.paperBitget
                              ? [
                                  ExchangeEnum.paperBitgetCoinm,
                                  ExchangeEnum.paperBitgetUsdm,
                                ]
                              : tt === TradeTypeEnum.futures &&
                                  provider === ExchangeEnum.paperHyperliquid
                                ? [ExchangeEnum.paperHyperliquidLinear]
                                : tt === TradeTypeEnum.futures &&
                                    provider === ExchangeEnum.hyperliquid
                                  ? [ExchangeEnum.hyperliquidLinear]
                                  : tt === TradeTypeEnum.futures &&
                                      (provider === ExchangeEnum.kraken ||
                                        provider === ExchangeEnum.krakenUsdm)
                                    ? [ExchangeEnum.krakenUsdm]
                                    : tt === TradeTypeEnum.futures &&
                                        (provider ===
                                          ExchangeEnum.paperKraken ||
                                          provider ===
                                            ExchangeEnum.paperKrakenUsdm)
                                      ? [ExchangeEnum.paperKrakenUsdm]
                                      : [provider]) {
            const paper = paperExchanges.includes(provider)
            if (paper) {
              key = v4()
              secret = v4()
              const exch = mapPaperToReal(e as PaperExchangeType)
              // Per-sub-account funding: prefer an explicit topUps entry for
              // this exact created provider (independent SPOT/USDⓈ-M/COIN-M
              // funding); otherwise fall back to the legacy single top-up,
              // keeping the COIN-M coin-margined default (0.5 BTC) for `all`.
              const topUpFor = Array.isArray(topUps)
                ? topUps.find((t) => t.provider === e)
                : undefined
              const isAllCoinm =
                tradeType === TradeTypeEnum.all &&
                (e === ExchangeEnum.paperBinanceCoinm ||
                  e === ExchangeEnum.paperBybitCoinm ||
                  e === ExchangeEnum.paperOkxInverse ||
                  e === ExchangeEnum.paperKucoinInverse ||
                  e === ExchangeEnum.paperBitgetCoinm ||
                  e === ExchangeEnum.paperKrakenCoinm)
              const paperUserCreationResult = await createPaperUser({
                key,
                secret,
                balance: [
                  {
                    exchange: exch,
                    amount: topUpFor
                      ? topUpFor.amount
                      : isAllCoinm
                        ? 0.5
                        : stablecoinBalance || 50,
                    asset: topUpFor
                      ? topUpFor.asset
                      : isAllCoinm
                        ? 'BTC'
                        : coinToTopUp || 'USDT',
                  },
                ],
                username: `${user.data.username}@${exch}`,
              })
              if (paperUserCreationResult.status === StatusEnum.notok) {
                return paperUserCreationResult
              }
              const verifyResult = await verify.verifyExchange(
                tt,
                provider,
                key,
                secret,
                passphrase || '',
              )
              if (!verifyResult) {
                return {
                  status: StatusEnum.notok,
                  reason: `API keys not valid for ${tt}`,
                  data: null,
                }
              }
            }
            const uuid = v4()
            uuids.push(uuid)
            const ex = ExchangeChooser.chooseExchangeFactory(e)(
              encrypt(key),
              encrypt(secret),
              passphrase ? encrypt(passphrase) : '',
              undefined,
              keysType,
              okxSource,
              bybitHost,
            )
            let affiliate = false
            if (
              !paper &&
              shouldCheckAffiliate &&
              [
                ExchangeEnum.hyperliquid,
                ExchangeEnum.hyperliquidLinear,
              ].includes(e)
            ) {
              const code = await brokerCodesDb.readData({
                exchange: ExchangeEnum.hyperliquid,
              })
              if (code.status === StatusEnum.ok && code.data.result) {
                affiliate = !!(await ex.getAffiliate(code.data.result.code))
                  ?.data
                logger.info(
                  `Add exchange affiliate check for user ${user.data._id} (${user.data.username}), exchange: "${e}", code: "${code.data.result.code}", affiliate: ${affiliate}`,
                )
                if (!affiliate) {
                  return {
                    status: StatusEnum.notok,
                    // The old text ("you need to follow the instructions")
                    // named neither the check that failed nor the instructions
                    // it meant, so a user who had just completed the wallet
                    // flow had nothing to act on and simply retried forever.
                    // Say which approval is missing and how to grant it.
                    reason:
                      `Hyperliquid builder fee not approved for this wallet. ` +
                      `On the free plan Gainium is paid through Hyperliquid ` +
                      `builder fees (0.07% spot / 0.045% perps) instead of ` +
                      `credits, so your main wallet has to approve Gainium as ` +
                      `a builder before the account can be connected. ` +
                      `Reconnect with "Free (approve builder fees)" and ` +
                      `confirm BOTH wallet prompts — the agent wallet and the ` +
                      `builder fee. If your wallet only prompted once, the ` +
                      `builder-fee approval did not go through. On a paid ` +
                      `plan you can connect with "Regular" instead.`,
                    data: null,
                  }
                }
              } else {
                logger.info(
                  `Add exchange affiliate check failed to get broker code for user ${user.data._id} (${user.data.username}), exchange: "${e}"`,
                )
              }
            }
            const saveDataRequest = await userDb.updateData(
              { _id: user.data._id },
              {
                $push: {
                  exchanges: [
                    {
                      provider: e,
                      name:
                        tradeType === TradeTypeEnum.all &&
                        [
                          ExchangeEnum.binance,
                          ExchangeEnum.paperBinance,
                        ].includes(provider)
                          ? `${name} (${
                              [
                                ExchangeEnum.binance,
                                ExchangeEnum.paperBinance,
                              ].includes(e)
                                ? 'SPOT'
                                : [
                                      ExchangeEnum.binanceCoinm,
                                      ExchangeEnum.paperBinanceCoinm,
                                    ].includes(e)
                                  ? 'COIN-M'
                                  : 'USDⓈ-M'
                            })`
                          : tradeType === TradeTypeEnum.all &&
                              [
                                ExchangeEnum.kucoin,
                                ExchangeEnum.paperKucoin,
                              ].includes(provider)
                            ? `${name} (${
                                [
                                  ExchangeEnum.kucoin,
                                  ExchangeEnum.paperKucoin,
                                ].includes(e)
                                  ? 'SPOT'
                                  : [
                                        ExchangeEnum.kucoinInverse,
                                        ExchangeEnum.paperKucoinInverse,
                                      ].includes(e)
                                    ? 'COIN-M'
                                    : 'USDⓈ-M'
                              })`
                            : tradeType === TradeTypeEnum.all &&
                                [
                                  ExchangeEnum.bitget,
                                  ExchangeEnum.paperBitget,
                                ].includes(provider)
                              ? `${name} (${
                                  [
                                    ExchangeEnum.bitget,
                                    ExchangeEnum.paperBitget,
                                  ].includes(e)
                                    ? 'SPOT'
                                    : [
                                          ExchangeEnum.bitgetCoinm,
                                          ExchangeEnum.paperBitgetCoinm,
                                        ].includes(e)
                                      ? 'Inverse'
                                      : 'Linear'
                                })`
                              : tradeType === TradeTypeEnum.all &&
                                  [
                                    ExchangeEnum.bybit,
                                    ExchangeEnum.paperBybit,
                                  ].includes(provider)
                                ? `${name} (${
                                    [
                                      ExchangeEnum.bybit,
                                      ExchangeEnum.paperBybit,
                                    ].includes(e)
                                      ? 'SPOT'
                                      : [
                                            ExchangeEnum.bybitCoinm,
                                            ExchangeEnum.paperBybitCoinm,
                                          ].includes(e)
                                        ? 'Inverse'
                                        : 'Linear'
                                  })`
                                : tradeType === TradeTypeEnum.all &&
                                    [
                                      ExchangeEnum.okx,
                                      ExchangeEnum.paperOkx,
                                    ].includes(provider)
                                  ? `${name} (${
                                      [
                                        ExchangeEnum.okx,
                                        ExchangeEnum.paperOkx,
                                      ].includes(e)
                                        ? 'SPOT'
                                        : [
                                              ExchangeEnum.okxInverse,
                                              ExchangeEnum.paperOkxInverse,
                                            ].includes(e)
                                          ? 'Inverse'
                                          : 'Linear'
                                    })`
                                  : tradeType === TradeTypeEnum.all &&
                                      [
                                        ExchangeEnum.hyperliquid,
                                        ExchangeEnum.paperHyperliquid,
                                      ].includes(provider)
                                    ? `${name} (${
                                        [
                                          ExchangeEnum.hyperliquid,
                                          ExchangeEnum.paperHyperliquid,
                                        ].includes(e)
                                          ? 'SPOT'
                                          : [
                                                ExchangeEnum.hyperliquidLinear,
                                                ExchangeEnum.paperHyperliquidLinear,
                                              ].includes(e)
                                            ? 'Linear'
                                            : 'Inverse'
                                      })`
                                    : tradeType === TradeTypeEnum.all &&
                                        [
                                          ExchangeEnum.kraken,
                                          ExchangeEnum.paperKraken,
                                        ].includes(provider)
                                      ? `${name} (${
                                          [
                                            ExchangeEnum.krakenUsdm,
                                            ExchangeEnum.paperKrakenUsdm,
                                          ].includes(e)
                                            ? 'Linear'
                                            : 'Spot'
                                        })`
                                      : name,
                      key: encrypt(key),
                      secret: encrypt(secret),
                      uuid,
                      keysType,
                      okxSource,
                      bybitHost,
                      affiliate,
                      passphrase: passphrase ? encrypt(passphrase) : undefined,
                      status: true,
                      lastUpdated: +new Date(),
                      hedge: isFutures(e)
                        ? await (async () => {
                            const exchangeInstance = ex
                            return !!(await exchangeInstance.getHedge()).data
                          })()
                        : false,
                      keyPermissions: observedPermissions,
                      subaccount,
                    },
                  ],
                },
              },
              true,
              true,
            )
            if (saveDataRequest.status === StatusEnum.notok) {
              logger.error(
                `Resolver Exchange | Save ${saveDataRequest.reason}, user ${user.data._id} (${user.data.username}), uuid ${uuid}`,
              )
              return {
                status: StatusEnum.notok,
                data: null,
                reason: `Error while saving exchange ${e}`,
              }
            } else {
              logger.debug(
                `Resolver Exchange | Save ${saveDataRequest.reason}, user ${user.data._id} (${user.data.username}), uuid ${uuid}`,
              )
            }
            if (
              e.toLowerCase().indexOf('bybit') !== -1 &&
              !paperExchanges.includes(e)
            ) {
              // No passphrase in the candidate: these leg-linking checks
              // match on key+secret and let the provider rules decide the
              // rest, exactly as before.
              const findTheSameKeys = await findMatchingConnection(
                saveDataRequest.data.exchanges,
                { key, secret },
                (u) =>
                  (u.provider === ExchangeEnum.bybit &&
                    [ExchangeEnum.bybitCoinm, ExchangeEnum.bybitUsdm].includes(
                      e,
                    )) ||
                  (u.provider === ExchangeEnum.bybitUsdm &&
                    [ExchangeEnum.bybit, ExchangeEnum.bybitCoinm].includes(
                      e,
                    )) ||
                  (u.provider === ExchangeEnum.bybitCoinm &&
                    [ExchangeEnum.bybit, ExchangeEnum.bybitUsdm].includes(e)),
              )
              if (findTheSameKeys) {
                const accountType = await bybitAccountType(
                  ExchangeEnum.bybit,
                  key,
                  secret,
                )
                if (accountType.type !== 1) {
                  if (
                    accountType.type >= 5 ||
                    (accountType.type < 5 &&
                      findTheSameKeys.provider !== ExchangeEnum.bybitCoinm &&
                      e !== ExchangeEnum.bybitCoinm)
                  )
                    await userDb.updateData(
                      { 'exchanges.uuid': uuid },
                      {
                        $set: { 'exchanges.$.linkedTo': findTheSameKeys.uuid },
                      },
                    )
                }
              }
            }
            if (
              e.toLowerCase().indexOf('okx') !== -1 &&
              !paperExchanges.includes(e)
            ) {
              const findTheSameKeys = await findMatchingConnection(
                saveDataRequest.data.exchanges,
                { key, secret },
                (u) =>
                  (u.provider === ExchangeEnum.okx &&
                    [ExchangeEnum.okxInverse, ExchangeEnum.okxLinear].includes(
                      e,
                    )) ||
                  (u.provider === ExchangeEnum.okxLinear &&
                    [ExchangeEnum.okxInverse, ExchangeEnum.okx].includes(e)) ||
                  (u.provider === ExchangeEnum.okxInverse &&
                    [ExchangeEnum.okx, ExchangeEnum.okxLinear].includes(e)),
              )
              if (findTheSameKeys) {
                await userDb.updateData(
                  { 'exchanges.uuid': uuid },
                  { $set: { 'exchanges.$.linkedTo': findTheSameKeys.uuid } },
                )
              }
            }
            const returnExchange = saveDataRequest.data.exchanges.find(
              (e) => e.uuid === uuid,
            )
            if (returnExchange) {
              returnExchanges.push({ ...returnExchange, status: true })
            }
          }
        }

        if (user.data.shouldOnBoard || user.data.shouldOnBoardExchange) {
          userDb.updateData(
            { _id: user.data._id },
            { $set: { shouldOnBoard: false, shouldOnBoardExchange: false } },
          )
        }
        if (!user.data.onboardingSteps.liveExchange && !isPaper(provider)) {
          updateUserSteps(user.data._id, 'liveExchange')
        }
        logger.debug(
          `Add Exchange for user ${user.data._id} ${uuids.join(', ')}`,
        )
        for (const uuid of uuids) {
          logger.debug(`Add Exchange for user ${user.data._id} ${uuid}`)
          userUtils.updateUserFee(user.data._id.toString(), uuid)
          userUtils
            .connectUserBalance(user.data._id.toString(), uuid)
            .then(() =>
              userUtils.userSnapshots(
                user.data._id.toString(),
                paperExchanges.includes(provider),
                true,
              ),
            )
        }
        // OKX Europe (my.okx.com) accounts: refresh the account-scoped SPOT
        // universe (USDC/EUR — the public feed advertises USDT the account can't
        // trade) so this EU account and every paper OKX-EU user see the real
        // pairs. X-Perps come from the keyless global cron. Fire-and-forget; keys
        // are the plaintext input (real accounts only — paper keys are random).
        if (
          okxSource === OKXSource.my &&
          provider.toLowerCase().includes('okx') &&
          !paperExchanges.includes(provider) &&
          key &&
          secret
        ) {
          void updateOkxEuPairs({ key, secret, passphrase }).catch((e) =>
            logger.error(
              `OKX-EU pairs | spot refresh on addExchange failed: ${e}`,
            ),
          )
        }
        return {
          status: StatusEnum.ok,
          data: returnExchanges,
        }
      } catch (e) {
        logger.error(`Resolver Exchange | Add Exchange ${e}`)
        return {
          status: StatusEnum.notok,
          reason: 'Cannot add exchange. Please try again later',
          data: null,
        }
      }
    },
    updateExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: Partial<
          Omit<
            ExchangeInUser & {
              stablecoinBalance?: number
              coinToTopUp?: string
            },
            'uuid' | 'provider'
          >
        > & {
          uuid: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { stablecoinBalance, coinToTopUp } = input
      let { key, secret, passphrase } = input
      const { uuid, name, keysType, okxSource, bybitHost, subaccount } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const find = user.data.exchanges.find((e) => e.uuid === uuid)
      if (find) {
        const {
          key: oldKey,
          secret: oldSecret,
          passphrase: oldPassphrase,
        } = await resolveConnection(find)
        const oldKeysType = find.keysType
        const oldOkxSource = find.okxSource
        const oldBybitHost = find.bybitHost
        const oldSubaccount = find.subaccount
        if (!paperExchanges.includes(find.provider)) {
          if (
            oldKey !== key ||
            oldSecret !== secret ||
            oldPassphrase !== passphrase ||
            (find.lastUpdated
              ? Math.abs(find.lastUpdated - +new Date()) > 24 * 60 * 60 * 1000
              : true) ||
            keysType !== oldKeysType ||
            oldOkxSource !== okxSource ||
            oldBybitHost !== bybitHost ||
            oldSubaccount !== subaccount
          ) {
            const keyToUse = key || oldKey
            const secretToUse = secret || oldSecret
            const passphraseToUse = passphrase || oldPassphrase
            // Unlike the cloud resolver, the condition above ALSO fires for
            // metadata-only edits and merely stale connections (`lastUpdated`
            // older than 24h). So "we are re-verifying" does not imply "the
            // user supplied a new key" here, and the withdrawal rejection must
            // be gated on an actual credential change — otherwise renaming a
            // connection could hard-fail a user whose key already works.
            const credentialsChanged =
              (!!key && key !== oldKey) ||
              (!!secret && secret !== oldSecret) ||
              (!!passphrase && passphrase !== oldPassphrase)
            const status = await verify.verifyExchange(
              getExchangeTradeType(find.provider),
              find.provider,
              keyToUse,
              secretToUse,
              passphraseToUse,
              keysType,
              okxSource,
              bybitHost,
              subaccount,
            )
            if (
              credentialsChanged &&
              shouldRejectNewConnection(status.permissions)
            ) {
              logger.warn(
                `Edit exchange rejected: fund-movement permission enabled (withdraw=${status.permissions?.withdraw} transfer=${status.permissions?.transfer}), user ${user.data._id} (${user.data.username}), exchange: "${find.provider}", uuid ${find.uuid}, detail: ${status.permissions?.detail}`,
              )
              return {
                status: StatusEnum.notok,
                reason: withdrawalRejectionReason(
                  find.provider,
                  status.permissions,
                ),
                data: null,
              }
            }
            if (!status) {
              return {
                status: StatusEnum.notok,
                reason: 'API keys not valid',
                data: null,
              }
            }
            const exchangeInstance = ExchangeChooser.chooseExchangeFactory(
              find.provider,
            )(
              encrypt(keyToUse),
              encrypt(secretToUse),
              passphraseToUse ? encrypt(passphraseToUse) : '',
              undefined,
              keysType,
              okxSource,
              bybitHost,
              subaccount,
            )
            const hedge = isFutures(find.provider)
              ? !!(await exchangeInstance.getHedge()).data
              : false
            find.status = status.status
            find.hedge = hedge
            find.lastUpdated = +new Date()
            find.keyPermissions =
              recordOnly(status.permissions, find.keyPermissions) ??
              find.keyPermissions
            // Cloud-only in practice (self-hosted never sets `rotationFlag`),
            // but the clear lives here too because this resolver is the one
            // self-hosted actually runs, and the same code path serves cloud
            // builds of core. Gated on `credentialsChanged`, NOT on "we
            // re-verified": this resolver re-verifies on metadata edits and on
            // anything older than 24h, neither of which is a rotation.
            if (
              credentialsChanged &&
              find.rotationFlag?.flaggedAt &&
              !find.rotationFlag.clearedAt
            ) {
              find.rotationFlag = {
                ...find.rotationFlag,
                clearedAt: +new Date(),
              }
              logger.info(
                `Rotation nudge cleared: user ${user.data._id} (${user.data.username}) replaced ${find.provider} credential ${find.uuid}`,
              )
            }
          }
          // Held on to before re-encryption. The change detection and the
          // open-stream payload below used to recover these by decrypting what
          // this block had just encrypted — a round-trip that can only ever
          // return what is already in hand, and one more stored-credential
          // read to keep working forever.
          const plainKey = key
          const plainSecret = secret
          const plainPassphrase = passphrase
          key = key ? encrypt(key) : key
          secret = secret ? encrypt(secret) : secret
          passphrase = passphrase ? encrypt(passphrase) : undefined
          const saveDataRequest = await userDb.updateData(
            { _id: user.data._id },
            {
              $set: {
                exchanges: user.data.exchanges.map((ue) => {
                  if (ue.uuid === uuid) {
                    ue.key = key || find.key
                    ue.secret = secret || find.secret
                    ue.name = name || find.name
                    ue.passphrase = passphrase || find.passphrase
                    ue.status = find.status
                    ue.hedge = find.hedge
                    ue.lastUpdated = find.lastUpdated
                    ue.keysType = keysType || find.keysType
                    ue.okxSource = okxSource || find.okxSource
                    ue.bybitHost = bybitHost || find.bybitHost
                    ue.keyPermissions = find.keyPermissions
                    ue.rotationFlag = find.rotationFlag
                  }
                  return ue
                }),
              },
            },
            true,
            true,
          )
          if (saveDataRequest.status === StatusEnum.notok) {
            logger.error(`Resolver Exchange | Update ${saveDataRequest.reason}`)
            return {
              status: StatusEnum.notok,
              data: null,
              reason: `Error while updating exchange ${find.provider} ${find.uuid}`,
            }
          }
          logger.debug(`Update Exchange for user ${user.data._id} ${uuid}`)
          userUtils
            .connectUserBalance(user.data._id.toString(), uuid)
            .then(() =>
              userUtils.userSnapshots(user.data._id.toString(), false, true),
            )
          userUtils.updateUserFee(user.data._id.toString(), uuid)
          if (
            key &&
            secret &&
            !paperExchanges.includes(find.provider) &&
            (oldKey !== plainKey ||
              oldSecret !== plainSecret ||
              oldPassphrase !== (plainPassphrase || '') ||
              keysType !== oldKeysType ||
              okxSource !== oldOkxSource ||
              bybitHost !== oldBybitHost ||
              oldSubaccount !== subaccount)
          ) {
            rabbitClient?.send(rabbitUsersStreamKey, {
              event: 'close stream',
              uuid,
            })
            rabbitClient?.send(rabbitUsersStreamKey, {
              event: 'open stream',
              data: {
                key: plainKey || '',
                secret: plainSecret || '',
                passphrase: plainPassphrase || '',
                provider: find.provider,
                keysType,
                okxSource,
                bybitHost,
                subaccount,
              },
              uuid,
            })

            const get = saveDataRequest.data.exchanges.find(
              (e) => e.uuid === uuid,
            )
            if (get) {
              const redis = await RedisClient.getInstance()
              redis.publish(
                'updateuserStore',
                JSON.stringify({ userId: `${user.data._id}`, uuid }),
              )
            }
          }
          const returnExchange = saveDataRequest.data.exchanges.find(
            (e) => e.uuid === uuid,
          )
          return {
            status: StatusEnum.ok,
            data: returnExchange,
          }
        } else {
          const saveDataRequest = await userDb.updateData(
            { _id: user.data._id },
            {
              $set: {
                exchanges: user.data.exchanges.map((e) => {
                  if (e.uuid === uuid) {
                    e.name = name || find.name
                  }
                  return e
                }),
              },
            },
            true,
            true,
          )
          if (saveDataRequest.status === StatusEnum.notok) {
            return saveDataRequest
          }
          if (stablecoinBalance && stablecoinBalance > 0) {
            const paperCreds = await resolveConnection(find)
            const save = await topUpUserBalance({
              key: paperCreds.key,
              secret: paperCreds.secret,
              stablecoinBalance,
              exchange: mapPaperToReal(find.provider as PaperExchangeType),
              coinToTopUp: coinToTopUp || 'USDT',
            })
            if (save.status === StatusEnum.notok) {
              return {
                status: StatusEnum.notok,
                reason: `Failed to update balance`,
              }
            }
            userUtils
              .connectUserBalance(user.data._id.toString(), uuid)
              .then(() =>
                userUtils.userSnapshots(user.data._id.toString(), true, true),
              )
          }
          return {
            status: StatusEnum.ok,
            data: { ...find, status: true },
          }
        }
      }

      return {
        status: StatusEnum.notok,
        reason: `This exchange doesn't exist on user`,
      }
    },
    deleteExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          uuid: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { uuid } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const find = user.data.exchanges.find((e) => e.uuid === uuid)
      if (find) {
        if (find.notAllowedToDelete) {
          return {
            status: StatusEnum.notok,
            reason: 'Exchange is locked and not permitted to delete',
            data: null,
          }
        }
        const saveDataRequest = await userDb.updateData(
          { _id: user.data._id },
          {
            $pull: {
              exchanges: { uuid },
            },
          },
          true,
          true,
        )
        if (saveDataRequest.status === StatusEnum.notok) {
          logger.error(`Resolver Exchange | Delete ${saveDataRequest.reason}`)
          return {
            status: StatusEnum.notok,
            data: null,
            reason: `Error while deleting exchange ${find.provider} ${find.uuid}`,
          }
        }
        const userId = `${user.data._id}`
        // Clearing the now-dangling `linkedTo` pointers needs nothing from the
        // bot teardown below, and nothing below needs it — but the user waited
        // for it before any of that even started. Start it here and collect it
        // at the end.
        const unlinkRequest = userDb
          .updateManyData(
            { 'exchanges.linkedTo': uuid },
            { $set: { 'exchanges.$.linkedTo': null } },
          )
          .then((res) =>
            logger.debug(
              `Resolver Exchange | Delete ${uuid} Update linkedTo ${res.reason}`,
            ),
          )
        // These two stay ordered on purpose: the live bots have to be told to
        // close before their docs are stamped closed/unassigned, or the
        // workers' own write can overtake the stamp.
        //
        // The stop leg is best-effort though. It fans out to the bot services
        // over RabbitMQ and `sendWithCallback` REJECTS when one of them misses
        // its 5-minute budget — which threw straight out of this resolver, so a
        // wedged bot service left the user with the connection already pulled
        // off their account but its fees, balances and per-exchange snapshots
        // still there — and no way to retry, the uuid is gone from the user
        // doc. Log it and finish the cascade.
        try {
          await Bot.stopBotByExchange(uuid, userId)
        } catch (e) {
          logger.error(
            `Resolver Exchange | Delete ${uuid} stop bots failed: ${
              (e as Error)?.message ?? e
            }`,
          )
        }
        const unassign = await Bot.unassignBotByExchange(uuid, userId)
        if (unassign) {
          await unlinkRequest
          return unassign
        }
        // Fees, balances and per-exchange snapshots live in three separate
        // collections keyed on this one connection, so no leg needs another
        // leg's answer — yet each was awaited before the next was even issued.
        // Drain them together, the same shape resetAccount already uses for its
        // own cleanup (core/src/utils/user.ts).
        //
        // The fee and balance filters now also carry `userId`. Those
        // collections are indexed {userId, exchangeUUID} and
        // {userId, exchangeUUID, asset}, so a filter on `exchangeUUID` alone
        // could not use either index and every disconnect COLLSCANned the whole
        // of `fees` and the whole of `balances` — a cost that grows with the
        // size of the platform, not with the account being deleted. `uuid` is a
        // v4 minted per connection, so the rows matched are the same ones.
        const [deleteFees, deleteBalances, deleteSnapshotsByExchange] =
          await Promise.all([
            feeDb.deleteManyData({ userId, exchangeUUID: uuid }).then((res) => {
              logger.debug(
                `Delete exchange for ${user.data._id} ${uuid}: fee ${res.reason}`,
              )
              return res
            }),
            balanceDb
              .deleteManyData({ userId, exchangeUUID: uuid })
              .then((res) => {
                logger.debug(
                  `Delete Exchange for ${user.data._id} ${uuid}: balances ${res.reason}`,
                )
                return res
              }),
            snapshotPerExchangeDb
              .deleteManyData({ userId, uuid })
              .then((res) => {
                logger.debug(
                  `Delete Exchange for ${user.data._id} ${uuid}: snaphost ${res.reason}`,
                )
                return res
              }),
          ])
        await unlinkRequest
        if (deleteFees.status !== StatusEnum.ok) {
          return deleteFees
        }
        if (deleteBalances.status !== StatusEnum.ok) {
          return deleteBalances
        }
        if (deleteSnapshotsByExchange.status !== StatusEnum.ok) {
          return deleteSnapshotsByExchange
        }
        userUtils.disconnectUserBalance(uuid)
        userUtils.userSnapshots(
          user.data._id.toString(),
          paperExchanges.includes(find?.provider),
          true,
        )
        return {
          status: StatusEnum.ok,
          data: 'Data deleted',
        }
      }
      return {
        status: StatusEnum.notok,
        reason: `This exchange doesn't exist on user`,
      }
    },
    setTimezone: async (
      _parent: any,
      { input }: { input: { timezone: string; weekStart: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { timezone, weekStart } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id },
        {
          timezone,
          weekStart,
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: 'Timezone saved',
      }
    },
    deleteToken: async (_parent: any, {}, { token, req }: InputRequest) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id },
        {
          $pull: { tokens: { token } },
        },
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: 'Token deleted',
      }
    },
    // Revoke ONE other session (a single tokens[] row) by its sub-document _id.
    // Admin-impersonation / demo rows are never revocable here — they're hidden
    // from the session list to begin with, and this guards against a client
    // passing an id it shouldn't have.
    revokeSession: async (
      _parent: any,
      { input }: { input: { id: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const target = (user.data.tokens || []).find(
        (t) => t._id?.toString() === input.id,
      )
      if (!target || target.source === 'admin' || target.source === 'demo') {
        return { status: StatusEnum.notok, reason: 'Session not found' }
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id },
        {
          $pull: { tokens: { _id: target._id } },
        },
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: 'Session revoked',
      }
    },
    // "Log out all other sessions" — drop every tokens[] row except the current
    // one. Admin-impersonation rows are preserved so an active admin session
    // checking the account isn't kicked, and so the user can't use this to hide
    // that they were being monitored.
    logoutOtherSessions: async (
      _parent: any,
      {},
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id },
        {
          $pull: {
            tokens: { token: { $ne: token }, source: { $ne: 'admin' } },
          },
        },
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: 'Other sessions logged out',
      }
    },
    createBot: async (
      _parent: any,
      {
        input,
      }: {
        input: BotSettings & {
          baseAsset?: string
          quoteAsset?: string
          exchange: ExchangeEnum
          exchangeUUID: string
          vars: BotVars
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const userData = user.data

      return await Bot.createBot(userData._id.toString(), input, paperContext)
    },
    createDCABot: async (
      _parent: any,
      {
        input,
      }: {
        input: DCABotSettings & {
          baseAsset?: string[]
          quoteAsset?: string[]
          exchange: ExchangeEnum
          exchangeUUID: string
          uuid?: string
          vars: BotVars
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      return await Bot.createDCABot(
        user.data._id.toString(),
        input,
        paperContext,
      )
    },
    createComboBot: async (
      _parent: any,
      {
        input,
      }: {
        input: CreateComboBotInput
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.createComboBot(
        user.data._id.toString(),
        input,
        paperContext,
      )
    },
    createHedgeComboBot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          long: CreateComboBotInput
          short: CreateComboBotInput
          sharedSettings?: HedgeBotSettings
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.createHedgeComboBot(
        user.data._id.toString(),
        input,
        paperContext,
      )
    },
    createHedgeDCABot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          long: CreateComboBotInput
          short: CreateComboBotInput
          sharedSettings?: HedgeBotSettings
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.createHedgeDcaBot(
        user.data._id.toString(),
        input,
        paperContext,
      )
    },
    importExchangeOrder: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          exchangeUUID: string
          orderId: string
          symbol: string
          newBotSettings: {
            symbol: string
            baseAsset: string
            quoteAsset: string
            price: string
            quantity: string
            side: 'BUY' | 'SELL'
          }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find(
        (e) => e.uuid === input.exchangeUUID,
      )
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      const pairInfo = await pairDb.readData({
        pair: input.symbol,
      })
      if (pairInfo.status === StatusEnum.notok) {
        return pairInfo
      }
      const cancelResult = await cancelOrderOnExchange(
        exchange,
        input.orderId,
        input.symbol,
      )
      if (cancelResult.status === StatusEnum.notok) {
        return cancelResult
      }
      if (cancelResult.data.status.toUpperCase() !== 'CANCELED') {
        return {
          status: StatusEnum.notok,
          reason: 'Order was not canceled on exchange',
          data: null,
        }
      }
      const date = new Date()
      date.setHours(24, 0, 0)
      const orderSize = isCoinm(exchange.provider)
        ? input.newBotSettings.quantity
        : `${+input.newBotSettings.quantity * +input.newBotSettings.price}`
      const activePosition = (
        (await getAllOpenPositions([exchange], user.data._id.toString()))
          .data ?? []
      ).find(
        (p) =>
          p.symbol === input.symbol &&
          p.side === (input.newBotSettings.side === 'BUY' ? 'LONG' : 'SHORT'),
      )
      const newBotSettings = {
        pair: [input.symbol],
        name: `Imported ${input.orderId}`,
        strategy:
          input.newBotSettings.side === 'BUY'
            ? StrategyEnum.long
            : StrategyEnum.short,
        profitCurrency: 'quote' as Currency,
        baseOrderSize: orderSize,
        startOrderType: OrderTypeEnum.limit,
        startCondition: StartConditionEnum.asap,
        tpPerc: '1',
        orderFixedIn: 'quote' as Currency,
        orderSize: orderSize,
        step: '1',
        ordersCount: 5,
        activeOrdersCount: 1,
        volumeScale: '1',
        stepScale: '1',
        useTp: false,
        useSl: false,
        slPerc: '-10',
        useSmartOrders: false,
        minOpenDeal: '',
        maxOpenDeal: '',
        useDca: false,
        hodlDay: '7',
        hodlAt: '15:00:00',
        hodlNextBuy: date.getTime(),
        maxNumberOfOpenDeals: '',
        indicators: [],
        baseOrderPrice: input.newBotSettings.price,
        orderSizeType: OrderSizeTypeEnum.quote,
        limitTimeout: '20',
        useLimitTimeout: false,
        type: DCATypeEnum.terminal,
        moveSL: false,
        moveSLTrigger: '0.5',
        moveSLValue: '0.2',
        dealCloseCondition: CloseConditionEnum.tp,
        dealCloseConditionSL: CloseConditionEnum.tp,
        terminalDealType: TerminalDealTypeEnum.smart,
        trailingTpPerc: '0.3',
        useMultiTp: false,
        multiTp: [],
        useMultiSl: false,
        multiSl: [],
        marginType:
          isFutures(exchange.provider) && activePosition
            ? activePosition.marginType
            : BotMarginTypeEnum.isolated,
        leverage:
          isFutures(exchange.provider) && activePosition
            ? +activePosition.leverage
            : 1,
        futures: isFutures(exchange.provider),
        coinm: isCoinm(exchange.provider),
        useLimitPrice: true,
        baseAsset: [pairInfo.data.result.baseAsset.name],
        quoteAsset: [pairInfo.data.result.quoteAsset.name],
        exchange: exchange.provider,
        exchangeUUID: input.exchangeUUID,
        indicatorGroups: [],
      }
      return Bot.createDCABot(
        user.data._id.toString(),
        { ...newBotSettings, vars: { list: [], paths: [] } },
        paperContext,
      )
    },
    changeBot: async (
      _parent: any,
      {
        input,
      }: {
        input: BotSettings & {
          id: string
          initialPrice?: number
          buyType?: BuyTypeEnum
          buyCount?: string
          buyAmount?: number
          vars: BotVars
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeBot(input, user.data._id.toString(), paperContext)
    },
    changeDCABot: async (
      _parent: any,
      { input }: { input: DCABotSettings & { id: string; vars: BotVars } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeDCABot(
        input,
        user.data._id.toString(),
        paperContext,
      )
    },
    changeHedgeComboBot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          long: ComboBotSettings & { id: string; vars: BotVars }
          short: ComboBotSettings & { id: string; vars: BotVars }
          id: string
          sharedSettings?: HedgeBotSettings
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeHedgeComboBot(
        input,
        user.data._id.toString(),
        paperContext,
      )
    },
    changeHedgeDCABot: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          long: ComboBotSettings & { id: string; vars: BotVars }
          short: ComboBotSettings & { id: string; vars: BotVars }
          id: string
          sharedSettings?: HedgeBotSettings
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeHedgeDcaBot(
        input,
        user.data._id.toString(),
        paperContext,
      )
    },
    changeComboBot: async (
      _parent: any,
      { input }: { input: ComboBotSettings & { id: string; vars: BotVars } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeComboBot(
        input,
        user.data._id.toString(),
        paperContext,
      )
    },
    changeBotShare: async (
      _parent: any,
      { input }: { input: { botId: string; share: boolean; type: BotType } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.changeBotShare(
        {
          ...input,
          userId: user.data._id.toString(),
        },
        !!user.data.paperContext,
      )
    },
    changeStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          status: BotStatusEnum
          id: string
          all?: boolean
          cancelPartiallyFilled?: boolean
          type?: BotType
          closeType?: CloseDCATypeEnum
          buyType?: BuyTypeEnum
          buyCount?: string
          buyAmount?: number
          closeGridType?: CloseGRIDTypeEnum
          hedgeConfig?: { [x in StrategyEnum]: ActionsEnum }
        }
      },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await Bot.changeStatus(
        user.data._id.toString(),
        input,
        paperContext,
      )
      if (result && result.status === StatusEnum.ok) {
        const { status } = input
        let { type } = input
        if (!type) {
          type = BotType.grid
        }
        const inc = status === BotStatusEnum.open ? 1 : -1
        userDb.updateData(
          { _id: user.data._id.toString() },
          {
            //TODO: should be in bot service
            $inc: {
              'bot_stats.total_bots': type.startsWith('hedge') ? inc * 2 : inc,
              'bot_stats.total_real_bots': paperContext
                ? 0
                : type.startsWith('hedge')
                  ? inc * 2
                  : inc,
              'bot_stats.total_real_tradingbots': paperContext
                ? 0
                : type === BotType.hedgeDca
                  ? inc * 2
                  : type === BotType.dca
                    ? inc
                    : 0,
              'bot_stats.total_real_grids': paperContext
                ? 0
                : type === BotType.grid
                  ? inc
                  : 0,
              'bot_stats.total_real_combos': paperContext
                ? 0
                : type === BotType.hedgeCombo
                  ? inc * 2
                  : type === BotType.combo
                    ? inc
                    : 0,
              'bot_stats.total_paper_bots': paperContext
                ? type.startsWith('hedge')
                  ? inc * 2
                  : inc
                : 0,
              'bot_stats.total_paper_tradingbots': paperContext
                ? type === BotType.hedgeDca
                  ? inc * 2
                  : type === BotType.dca
                    ? inc
                    : 0
                : 0,
              'bot_stats.total_paper_grids': paperContext
                ? type === BotType.grid
                  ? inc
                  : 0
                : 0,
              'bot_stats.total_paper_combos': paperContext
                ? type === BotType.hedgeCombo
                  ? inc * 2
                  : type === BotType.combo
                    ? inc
                    : 0
                : 0,
            },
          },
        )
      }
      return result
    },
    deleteBot: async (
      _parent: any,
      { input }: { input: { id: string; type?: BotType } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { type, id } = input
      return await Bot.deleteBot(
        user.data._id.toString(),
        id,
        type || BotType.grid,
        undefined,
        !!user.data.paperContext,
      )
    },
    deleteBotMessage: async (
      _parent: any,
      { input }: { input: { id?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return deleteBotMessage(user.data._id, input.id)
    },
    updateProfilePicture: async (
      _parent: any,
      { input }: { input: { picture: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { picture } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString() },
        {
          $set: {
            picture,
          },
        },
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: 'Picture Updated',
        data: null,
      }
    },
    openDCADeal: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          symbol?: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.openDCADeal(
        user.data._id.toString(),
        input.botId,
        input.symbol,
        !!user.data.paperContext,
      )
    },
    openComboDeal: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          symbol?: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.openComboDeal(
        user.data._id.toString(),
        input.botId,
        input.symbol,
        !!user.data.paperContext,
      )
    },
    closeDCADeal: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          type?: CloseDCATypeEnum
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return Bot.closeDCADeal(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        input.type,
        undefined,
        !!user.data.paperContext,
      )
    },
    closeComboDeal: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          type?: CloseDCATypeEnum
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return Bot.closeComboDeal(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        input.type,
        undefined,
        !!user.data.paperContext,
      )
    },
    closeOrderOnExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          orderId: string
          symbol: string
          exchangeUUID: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find(
        (e) => e.uuid === input.exchangeUUID,
      )
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Exchange not found',
          data: null,
        }
      }
      const result = await cancelOrderOnExchange(
        exchange,
        input.orderId,
        input.symbol,
      )
      if (result.status == StatusEnum.notok) {
        return result
      }
      return {
        ...result,
        data: result.data.orderId,
      }
    },
    closePositionOnExchange: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          positionId: string
          exchangeUUID: string
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find(
        (e) => e.uuid === input.exchangeUUID,
      )
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: null,
          data: `Exchange not found`,
        }
      }
      const activePosition = (
        (await getAllOpenPositions([exchange], user.data._id.toString()))
          .data ?? []
      ).find((p) => p.positionId === input.positionId)
      if (!activePosition) {
        return {
          status: StatusEnum.notok,
          reason: null,
          data: `Position not found`,
        }
      }
      const orderData = {
        symbol: activePosition.symbol,
        side:
          activePosition.side === 'LONG'
            ? ('SELL' as const)
            : activePosition.side === 'SHORT'
              ? ('BUY' as const)
              : +activePosition.quantity > 0
                ? ('SELL' as const)
                : ('BUY' as const),
        quantity: Math.abs(+activePosition.quantity),
        price: 0,
        newClientOrderId: `gclose${id(20)}`,
        type: 'MARKET' as const,
        reduceOnly: true,
        positionSide:
          activePosition.side === 'BOTH'
            ? undefined
            : activePosition.side === 'LONG'
              ? PositionSide.LONG
              : PositionSide.SHORT,
        leverage:
          !isNaN(+activePosition.leverage) && isFinite(+activePosition.leverage)
            ? +activePosition.leverage
            : 1,
      }

      if (activePosition.exchange === ExchangeEnum.okxLinear) {
        const pairsInfo = await pairDb.readData({
          pair: activePosition.symbol,
          exchange: ExchangeEnum.okxLinear,
        })
        const pair = pairsInfo?.data?.result
        if (pair) {
          const denominator =
            pair.baseAsset.step > 1
              ? 1 / pair.baseAsset.step
              : +`1${'0'.repeat(
                  math.getPricePrecision(`${pair.baseAsset.step ?? 1}`),
                )}`
          orderData.quantity = orderData.quantity / denominator
        }
      }
      const result = await placeOrderOnExchange(exchange, orderData)
      if (result.status === StatusEnum.notok) {
        return result
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: `Closing order was sent`,
      }
    },
    changeDCADealSettings: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          settings: Partial<DCADealsSettings>
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.updateDCADealSettings(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        input.settings,
      )
    },
    changeComboDealSettings: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealId: string
          settings: Partial<ComboDealsSettings>
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.updateComboDealSettings(
        user.data._id.toString(),
        input.botId,
        input.dealId,
        input.settings,
      )
    },
    setVideoUpdate: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          id: string
          watch80?: boolean
          closed?: boolean
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const fv = (user.data.videos ?? []).find((v) => v.id === input.id)
      const updateUserResultPull = await userDb.updateData(
        { _id: user.data._id },
        {
          $pull: { videos: { id: input.id } },
        },
      )
      if (updateUserResultPull.status === StatusEnum.notok) {
        return updateUserResultPull
      }
      const updateUserResultPush = await userDb.updateData(
        { _id: user.data._id },
        {
          $push: {
            videos: {
              id: input.id,
              watch80: input.watch80 || !!fv?.watch80,
              closed: input.closed || !!fv?.closed,
            },
          },
        },
      )
      if (updateUserResultPush.status === StatusEnum.notok) {
        return updateUserResultPush
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: `Data updated`,
      }
    },
    mergeDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealIds: string[]
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return Bot.mergeDeals(
        user.data._id.toString(),
        input.botId,
        input.dealIds,
        !!user.data.paperContext,
      )
    },
    mergeComboDeals: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          botId: string
          dealIds: string[]
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return Bot.mergeComboDeals(
        user.data._id.toString(),
        input.botId,
        input.dealIds,
        !!user.data.paperContext,
      )
    },
    saveBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: DCABacktestingResult
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await backtestDb.createData({
        ...input,
        savePermanent: !!input.savePermanent,
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? result.data._id.toString() : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    saveComboBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: ComboBacktestingResult
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await comboBacktestDb.createData({
        ...input,
        savePermanent: !!input.savePermanent,
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? result.data._id.toString() : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    saveHedgeComboBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: HedgeComboBacktestingResult
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await hedgeComboBacktestDb.createData({
        ...input,
        savePermanent: !!input.savePermanent,
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? result.data._id.toString() : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    saveHedgeDCABacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: HedgeDCABacktestingResult
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await hedgeDcaBacktestDb.createData({
        ...input,
        savePermanent: !!input.savePermanent,
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? result.data._id.toString() : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    saveGridBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: GRIDBacktestingResult
      },
      { token, req }: InputRequest,
    ) => {
      if (token !== 'demo' && !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await gridBacktestDb.createData({
        ...input,
        savePermanent: !!input.savePermanent,
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? result.data._id.toString() : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    deleteBacktests: async (
      _parent: any,
      {
        input,
      }: {
        input: { ids: string[] }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await backtestDb.deleteManyData({
        _id: { $in: input.ids },
        userId: user.data._id.toString(),
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? 'Backtest result deleted' : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    deleteComboBacktests: async (
      _parent: any,
      {
        input,
      }: {
        input: { ids: string[] }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await comboBacktestDb.deleteManyData({
        _id: { $in: input.ids },
        userId: user.data._id.toString(),
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? 'Backtest result deleted' : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    deleteHedgeComboBacktests: async (
      _parent: any,
      {
        input,
      }: {
        input: { ids: string[] }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await hedgeComboBacktestDb.deleteManyData({
        _id: { $in: input.ids },
        userId: user.data._id.toString(),
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? 'Backtest result deleted' : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    deleteHedgeDCABacktests: async (
      _parent: any,
      {
        input,
      }: {
        input: { ids: string[] }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await hedgeDcaBacktestDb.deleteManyData({
        _id: { $in: input.ids },
        userId: user.data._id.toString(),
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? 'Backtest result deleted' : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    deleteGridBacktests: async (
      _parent: any,
      {
        input,
      }: {
        input: { ids: string[] }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await gridBacktestDb.deleteManyData({
        _id: { $in: input.ids },
        userId: user.data._id.toString(),
      })
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok ? 'Backtest result deleted' : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setBacktestPermanentStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; savePermanent: boolean }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, savePermanent } = input
      const result = await backtestDb.updateData(
        {
          _id: id,
        },
        { $set: { savePermanent: !!savePermanent } },
      )
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok
            ? savePermanent
              ? 'Backtest saved permanently'
              : `Backtest will be scheduled for deletion`
            : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setComboBacktestPermanentStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; savePermanent: boolean }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, savePermanent } = input
      const result = await comboBacktestDb.updateData(
        {
          _id: id,
        },
        { $set: { savePermanent: !!savePermanent } },
      )
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok
            ? savePermanent
              ? 'Backtest saved permanently'
              : `Backtest will be scheduled for deletion`
            : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setHedgeComboBacktestPermanentStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; savePermanent: boolean }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, savePermanent } = input
      const result = await hedgeComboBacktestDb.updateData(
        {
          _id: id,
        },
        { $set: { savePermanent: !!savePermanent } },
      )
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok
            ? savePermanent
              ? 'Backtest saved permanently'
              : `Backtest will be scheduled for deletion`
            : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setHedgeDCABacktestPermanentStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; savePermanent: boolean }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, savePermanent } = input
      const result = await hedgeDcaBacktestDb.updateData(
        {
          _id: id,
        },
        { $set: { savePermanent: !!savePermanent } },
      )
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok
            ? savePermanent
              ? 'Backtest saved permanently'
              : `Backtest will be scheduled for deletion`
            : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setBacktestTextFields: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; type: BotType; name?: string; note?: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, type, name, note } = input
      if (typeof name === 'undefined' && typeof note === 'undefined') {
        return {
          status: StatusEnum.notok,
          data: null,
          reason: `Need to specify at least one field`,
        }
      }
      const db =
        type === BotType.dca
          ? backtestDb
          : type === BotType.combo
            ? comboBacktestDb
            : type === BotType.hedgeCombo
              ? hedgeComboBacktestDb
              : type === BotType.hedgeDca
                ? hedgeDcaBacktestDb
                : gridBacktestDb
      const $set: { [x: string]: string | undefined } = {}
      if (typeof name !== 'undefined') {
        if (type === BotType.hedgeDca || type === BotType.hedgeCombo) {
          $set['long.settings.name'] = name
        } else {
          $set['settings.name'] = name
        }
      }
      if (typeof note !== 'undefined') {
        $set.note = note
      }
      //@ts-ignore
      const result = await db.updateData({ _id: id }, { $set })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? `Backtest updated` : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setDealNote: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; type: BotType; note?: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, type, note } = input
      const db = type === BotType.dca ? dcaDealsDb : comboDealsDb
      const $set = { note: note ?? null }
      //@ts-ignore
      const result = await db.updateData({ _id: id }, { $set })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? `Deal updated` : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setGridBacktestPermanentStatus: async (
      _parent: any,
      {
        input,
      }: {
        input: { id: string; savePermanent: boolean }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const { id, savePermanent } = input
      const result = await gridBacktestDb.updateData(
        {
          _id: id,
        },
        { $set: { savePermanent: !!savePermanent } },
      )
      return {
        status: result.status,
        data:
          result.status === StatusEnum.ok
            ? savePermanent
              ? 'Backtest saved permanently'
              : `Backtest will be scheduled for deletion`
            : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    setArchive: async (
      _parent: any,
      {
        input,
      }: {
        input: {
          archive: boolean
          botIds: string[]
          type: BotType
        }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      return await Bot.setArchiveStatus(
        user.data._id.toString(),
        input.type,
        input.botIds,
        input.archive,
        !!user.data.paperContext,
      )
    },
    createAPIKeys: async (
      _parent: unknown,
      _input: unknown,
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }

      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      // Kept alongside the ciphertext rather than recovered from it below. The
      // round-trip only ever returned what this line already had, and reading
      // a stored credential back is what the envelope layer makes expensive.
      const plaintextSecret = v4()
      const secret = encrypt(plaintextSecret)
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id },
        {
          $push: {
            apiKeys: {
              name: 'New API Key',
              secret: secret,
              created: new Date().getTime(),
              expired: new Date().getTime() + 90 * 24 * 60 * 60 * 1000,
              permission: APIPermission.read,
            },
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      const find = saveDataRequest.data.apiKeys?.find(
        (k) => k.secret === secret,
      )
      if (!find) {
        return {
          status: StatusEnum.ok,
          reason: null,
          data: 'Keys cannot save',
        }
      }

      return {
        status: StatusEnum.ok,
        reason: null,
        data: { ...find, secret: plaintextSecret },
      }
    },
    renewAPIKeys: async (
      _parent: unknown,
      { input }: { input: { key: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString(), 'apiKeys._id': input.key },
        {
          $set: {
            'apiKeys.$.expired':
              new Date().getTime() + 90 * 24 * 60 * 60 * 1000,
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    changeAPIKeysPermission: async (
      _parent: unknown,
      { input }: { input: { key: string; permission: APIPermission } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString(), 'apiKeys._id': input.key },
        {
          $set: {
            'apiKeys.$.permission': input.permission,
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    changeAPIKeysName: async (
      _parent: unknown,
      { input }: { input: { key: string; name: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString(), 'apiKeys._id': input.key },
        {
          $set: {
            'apiKeys.$.name': input.name,
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    changeAPIKeysPaperContext: async (
      _parent: unknown,
      { input }: { input: { key: string; paperContext?: boolean } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString(), 'apiKeys._id': input.key },
        {
          $set: {
            'apiKeys.$.paperContext': input.paperContext ?? null,
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    changeAPIKeysBotId: async (
      _parent: unknown,
      { input }: { input: { key: string; botId?: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString(), 'apiKeys._id': input.key },
        {
          $set: {
            'apiKeys.$.botId': input.botId ?? null,
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    deleteAPIKeys: async (
      _parent: unknown,
      { input }: { input: { key: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const saveDataRequest = await userDb.updateData(
        { _id: user.data._id.toString() },
        {
          $pull: {
            apiKeys: {
              _id: input.key,
            },
          },
        },
        true,
        true,
      )
      if (saveDataRequest.status === StatusEnum.notok) {
        return saveDataRequest
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: saveDataRequest.data.apiKeys,
      }
    },
    shareBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: { _id: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const filter = { _id: input._id, userId: user.data._id.toString() }
      const get = await backtestDb.readData(filter)
      if (get.status === StatusEnum.notok) {
        return get
      }
      if (get.data.result.shareId) {
        return {
          status: StatusEnum.ok,
          data: get.data.result.shareId,
          reason: null,
        }
      }
      const shareId = v4()
      const result = await backtestDb.updateData(filter, {
        $set: { shareId },
      })

      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? shareId : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    shareComboBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: { _id: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const filter = { _id: input._id, userId: user.data._id.toString() }
      const get = await comboBacktestDb.readData(filter)
      if (get.status === StatusEnum.notok) {
        return get
      }
      if (get.data.result.shareId) {
        return {
          status: StatusEnum.ok,
          data: get.data.result.shareId,
          reason: null,
        }
      }
      const shareId = v4()
      const result = await comboBacktestDb.updateData(filter, {
        $set: { shareId },
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? shareId : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    shareHedgeComboBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: { _id: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const filter = { _id: input._id, userId: user.data._id.toString() }
      const get = await hedgeComboBacktestDb.readData(filter)
      if (get.status === StatusEnum.notok) {
        return get
      }
      if (get.data.result.shareId) {
        return {
          status: StatusEnum.ok,
          data: get.data.result.shareId,
          reason: null,
        }
      }
      const shareId = v4()
      const result = await hedgeComboBacktestDb.updateData(filter, {
        $set: { shareId },
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? shareId : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    shareHedgeDCABacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: { _id: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const filter = { _id: input._id, userId: user.data._id.toString() }
      const get = await hedgeDcaBacktestDb.readData(filter)
      if (get.status === StatusEnum.notok) {
        return get
      }
      if (get.data.result.shareId) {
        return {
          status: StatusEnum.ok,
          data: get.data.result.shareId,
          reason: null,
        }
      }
      const shareId = v4()
      const result = await hedgeDcaBacktestDb.updateData(filter, {
        $set: { shareId },
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? shareId : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    shareGridBacktest: async (
      _parent: any,
      {
        input,
      }: {
        input: { _id: string }
      },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const filter = { _id: input._id, userId: user.data._id.toString() }
      const get = await gridBacktestDb.readData(filter)
      if (get.status === StatusEnum.notok) {
        return get
      }
      if (get.data.result.shareId) {
        return {
          status: StatusEnum.ok,
          data: get.data.result.shareId,
          reason: null,
        }
      }
      const shareId = v4()
      const result = await gridBacktestDb.updateData(filter, {
        $set: { shareId },
      })
      return {
        status: result.status,
        data: result.status === StatusEnum.ok ? shareId : null,
        reason: result.status === StatusEnum.ok ? null : result.reason,
      }
    },
    changePassword: async (
      _parent: any,
      {
        input,
      }: {
        input: { password: string }
      },
      { token, req }: InputRequest,
    ) => {
      const { password } = input
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      // Async bcrypt comparison (two arguments). It dual-reads, so the guard
      // works whether the stored value is a bcrypt hash or still legacy AES.
      if (await verifyPasswordHash(password, user.data.password)) {
        return {
          status: StatusEnum.notok,
          reason: 'Current password is the same as new',
          data: null,
        }
      }
      // Synchronous strength/format check (one argument) — a different helper.
      if (!verifyPassword(password)) {
        return {
          status: StatusEnum.notok,
          reason: 'Password not valid',
          data: null,
        }
      }
      const result = await userDb.updateData(
        { _id: user.data._id.toString() },
        { $set: { password: await hashPassword(password) } },
      )
      if (result.status === StatusEnum.notok) {
        return result
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Password updated',
      }
    },
    saveUserPeriod: async (
      _parent: any,
      { input }: { input: Omit<CleanUserPeriod, '_id' | 'userId'> },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const periods = await userPeriodDb.createData({
        userId: user.data._id.toString(),
        ...input,
      })
      if (periods.status === StatusEnum.notok) {
        return periods
      }
      return Query.getUserPeriods(_parent, {}, { token, req, paperContext })
    },
    updateUserPeriod: async (
      _parent: any,
      { input }: { input: Omit<CleanUserPeriod, '_id'> },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const periods = await userPeriodDb.updateData(
        { userId: user.data._id.toString(), uuid: input.uuid },
        {
          ...input,
        },
      )
      if (periods.status === StatusEnum.notok) {
        return periods
      }
      return Query.getUserPeriods(_parent, {}, { token, req, paperContext })
    },
    deleteUserPeriod: async (
      _parent: any,
      { input }: { input: { uuid: string } },
      { token, req, paperContext }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const periods = await userPeriodDb.deleteData({
        userId: user.data._id.toString(),
        uuid: input.uuid,
      })
      if (periods.status === StatusEnum.notok) {
        return periods
      }
      return Query.getUserPeriods(_parent, {}, { token, req, paperContext })
    },
    addUserFavoritePair: async (
      _parent: any,
      { input }: { input: { provider: ExchangeEnum; pair: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { pair, provider } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find(
        (e) =>
          (paperExchanges.includes(e.provider)
            ? mapPaperToReal(e.provider as PaperExchangeType)
            : e.provider) ===
          (paperExchanges.includes(provider)
            ? mapPaperToReal(provider as PaperExchangeType)
            : provider),
      )
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Cannot find exchange with such uuid',
          data: null,
        }
      }
      const pairs = await favoritePairsDb.readData({
        userId: user.data._id,
        provider: paperExchanges.includes(provider)
          ? mapPaperToReal(provider as PaperExchangeType)
          : provider,
      })
      if (pairs.status === StatusEnum.notok) {
        return pairs
      }
      if (!pairs.data.result) {
        const savedResult = await favoritePairsDb.createData({
          userId: user.data._id,
          provider: paperExchanges.includes(provider)
            ? mapPaperToReal(provider as PaperExchangeType)
            : provider,
          pairs: [pair],
        })
        if (
          savedResult.status === StatusEnum.ok ||
          !savedResult.reason.includes('E11000')
        ) {
          return savedResult
        }
      }
      const updateResult = await favoritePairsDb.updateData(
        {
          userId: user.data._id,
          provider: paperExchanges.includes(provider)
            ? mapPaperToReal(provider as PaperExchangeType)
            : provider,
        },
        { $addToSet: { pairs: pair } },
        true,
      )
      return updateResult
    },
    removeUserFavoritePair: async (
      _parent: any,
      { input }: { input: { provider: ExchangeEnum; pair: string } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { pair, provider } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const exchange = user.data.exchanges.find(
        (e) =>
          (paperExchanges.includes(e.provider)
            ? mapPaperToReal(e.provider as PaperExchangeType)
            : e.provider) ===
          (paperExchanges.includes(provider)
            ? mapPaperToReal(provider as PaperExchangeType)
            : provider),
      )
      if (!exchange) {
        return {
          status: StatusEnum.notok,
          reason: 'Cannot find exchange with such uuid',
          data: null,
        }
      }
      const updateResult = await favoritePairsDb.updateData(
        {
          userId: user.data._id,
          provider: paperExchanges.includes(provider)
            ? mapPaperToReal(provider as PaperExchangeType)
            : provider,
        },
        { $pull: { pairs: pair } },
        true,
      )
      return updateResult
    },
    addUserFavoriteIndicator: async (
      _parent: any,
      { input }: { input: { indicator: IndicatorEnum } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { indicator } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }
      const result = await favoriteIndicatorsDb.updateData(
        { userId: user.data._id.toString() },
        {
          $set: { userId: user.data._id.toString() },
          $addToSet: { indicators: indicator },
        },
        true,
        true,
        true,
      )
      if (result.status === StatusEnum.notok) {
        return result
      }
      return {
        status: StatusEnum.ok,
        data: { indicators: result.data.indicators },
        reason: null,
      }
    },
    removeUserFavoriteIndicator: async (
      _parent: any,
      { input }: { input: { indicator: IndicatorEnum } },
      { token, req }: InputRequest,
    ) => {
      if (token === 'demo' || !req.user?.authorized) {
        return errorAccess()
      }
      const { indicator } = input
      const user = await findUser(token)
      if (user.status === StatusEnum.notok) {
        return user
      }

      const updateResult = await favoriteIndicatorsDb.updateData(
        {
          userId: user.data._id,
        },
        { $pull: { indicators: indicator } },
        true,
      )
      if (updateResult.status === StatusEnum.notok) {
        return updateResult
      }
      return {
        status: StatusEnum.ok,
        data: { indicators: updateResult.data.indicators },
        reason: null,
      }
    },
  }

  return {
    Query,
    Mutation,
  }
}

export default resolvers
