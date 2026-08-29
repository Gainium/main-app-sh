import DB from '../db'
import { v4 } from 'uuid'
import { Worker, isMainThread, threadId } from 'worker_threads'
import logger from '../utils/logger'
import {
  missingWebhookFields,
  missingWebhookFieldsReason,
} from '../server/tradeSignalContract'
import { isPaper } from '../utils'
import { ProjectionFields, Types, type PipelineStage } from 'mongoose'
import ExchangeChooser from '../exchange/exchangeChooser'
import {
  Symbols,
  MultiAssets,
  BOT_CHANGE_EVENT,
  BOT_STATUS_EVENT,
  PositionSide,
  ExcludeDoc,
  StrategyEnum,
  ComboBotSchema,
  ComboBotSettings,
  ComboDealsSettings,
  ComboMinigridStatusEnum,
  AddFundsSettings,
  OrderSizeTypeEnum,
  BotParentEventsDto,
  CreateBotDto,
  UpdateBotExchangeDto,
  UpdateBotExchangeInfoDto,
  CoinbaseKeysType,
  ClearPairsSchema,
  CleanBotEventSchema,
  MessageTypeEnum,
  BotFlags,
  PairsToSetMode,
  TypeOrderEnum,
  DataGridFilterInput,
  AddFundsTypeEnum,
  CompareBalancesResponse,
  OrderSideEnum,
  BotServiceQueues,
  OKXSource,
  GridSortModel,
  GridFilterItem,
  CreateComboBotInput,
  BotVars,
  ActionsEnum,
  HedgeBotSettings,
  DCACloseTriggerEnum,
  SettingsIndicators,
  DCACustom,
  MultiTP,
  MainBot,
  BybitHost,
  LogLevel,
  CreateDCABotInput,
} from '../../types'
import {
  BaseReturn,
  BotSchema,
  BotSettings,
  BotStatusEnum,
  BotType,
  BuyTypeEnum,
  CloseDCATypeEnum,
  CloseGRIDTypeEnum,
  DCABotSchema,
  DCABotSettings,
  DCADealsSchema,
  DCADealsSettings,
  DCADealStatusEnum,
  DCATypeEnum,
  ExchangeEnum,
  InitialPriceFromEnum,
  OrderStatusType,
  StatusEnum,
  UserSchema,
  WebhookActionEnum,
} from '../../types'
import {
  convertComboBot,
  convertComboBotToArray,
  convertDCABot,
  convertDCABotToArray,
  getSettingsChangeDescription,
  getObjectsDiff,
  combineMaps,
  convertHedgeComboBotToArray,
  isXperpPair,
  updateRelatedBotsInVar,
} from './utils'
import { IdMute, IdMutex } from '../utils/mutex'
import { mapDataGridOptionsToMongoOptions } from '../db/utils'
import RabbitClient from '../db/rabbit'
import {
  botDb,
  botEventDb,
  botMessageDb,
  comboBotDb,
  comboDealsDb,
  comboProfitDb,
  comboTransactionsDb,
  dcaBotDb,
  dcaDealsDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
  minigridDb,
  orderDb,
  pairDb,
  transactionDb,
  userDb as _userDb,
} from '../db/dbInit'
import ColdStoreArchiver, {
  type ColdBotType,
} from '../archive/coldStoreArchiver'
import ColdStoreRehydrator from '../archive/coldStoreRehydrator'
import ColdClient, { isColdStoreEnabled } from '../archive/coldClient'
import { coldReadOrders, coldReadTransactions } from '../archive/coldRead'
import {
  BOT_RESTART_ARM_CAP_MS,
  BOT_RESTART_ARM_FALLBACK,
  BOT_RESTART_ARM_STALL_MS,
  BOT_RESTART_STRAGGLER_DELAY_MS,
  BOT_SERVICE_RPC_TIMEOUT_MS,
  BOTS_PER_WORKER,
  BotServiceType,
  COMBO_PER_WORKER,
  DCA_PER_WORKER,
  FULL_GRID_RESTAT,
  FULL_RESTART,
  GRID_PER_WORKER,
  HEDGE_COMBO_PER_WORKER,
  HEDGE_DCA_PER_WORKER,
  HEDGE_PER_WORKER,
} from '../config'
import { applyGridFuturesConstraints } from '../server/v2/helpers'
import { ensureDynamicArIndicator } from '../utils/dynamicArIndicator'

const PER_PAGE = 20

const mutex = new IdMutex()

export type WebhookData = {
  action?: WebhookActionEnum
  uuid?: string
  symbol?: string
  qty?: string
  asset?: string
  pairsToSet?: string[]
  pairsToSetMode?: PairsToSetMode
  closeType?: 'limit' | 'market' | 'leave' | 'cancel'
  type?: AddFundsTypeEnum
}

const defaultBotsPerWorker = 100

/**
 * Why the bot service started consuming its command queue.
 *
 * `parity` is the healthy path: every bot the boot query found has been
 * re-hydrated. `no-bots` is the trivially-empty service. The other two are
 * fallbacks and are always a warning — they mean re-hydration did not finish,
 * and some bots are live-but-unrestarted while the service takes commands.
 */
export type RestartArmReason = 'parity' | 'no-bots' | 'stalled' | 'cap'

const botServiceRpcTimeoutMs = Number(BOT_SERVICE_RPC_TIMEOUT_MS) || 5 * 60_000

const armFallbackEnabled = `${BOT_RESTART_ARM_FALLBACK}` !== 'false'
const armStallMs = Number(BOT_RESTART_ARM_STALL_MS) || 120_000
const armCapMs = Number(BOT_RESTART_ARM_CAP_MS) || 30 * 60_000
const armWatchdogTickMs = 15_000
const stragglerDelayMs = Number(BOT_RESTART_STRAGGLER_DELAY_MS) || 10 * 60_000

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

const notAvailable = 'Bots service is unavailable, please try again later'

const webhookQueue = 'webhookQueue'

/**
 * The actions `singleWebhookProcess` actually dispatches. Kept as an explicit
 * list rather than `Object.values(WebhookActionEnum)` because the enum having a
 * member is exactly what does NOT make an action work — four position-control
 * values sat in the enum with no handler and answered 200 for months.
 * Used only to word the rejection; the rejection itself keys off whether
 * anything was dispatched, so forgetting to add a new action here degrades the
 * message, never the behaviour.
 */
const implementedWebhookActions: WebhookActionEnum[] = [
  WebhookActionEnum.start,
  WebhookActionEnum.close,
  WebhookActionEnum.closeSl,
  WebhookActionEnum.startBot,
  WebhookActionEnum.stopBot,
  WebhookActionEnum.addFunds,
  WebhookActionEnum.reduceFunds,
  WebhookActionEnum.changePairs,
]

/**
 * First stage of every orphan sweep in `premanenetlyDeleteBots`.
 *
 * `botId` is a plain string on these collections and not every value is a bot
 * id: platform-level notices are written against the `'system'` sentinel so the
 * dashboard renders them without a bot link. The `$toObjectId: '$botId'` in the
 * `$lookup`s below throws on any value that isn't 24 hex chars, which fails the
 * whole aggregation — and each step of `premanenetlyDeleteBots` returns on its
 * first error, so a single such document silently aborts every remaining
 * cleanup step after it (orphan messages, deals, orders, transactions).
 *
 * Restricting the pipeline to convertible ids fixes both halves of that: the
 * aggregation no longer throws, and the sentinel rows stay out of the orphan
 * set — they have no bot by design, so an unguarded sweep would delete them.
 */
const botIdIsObjectId: PipelineStage = {
  $match: {
    $expr: {
      $ne: [
        { $convert: { input: '$botId', to: 'objectId', onError: null } },
        null,
      ],
    },
  },
}

type BotServicePayload = {
  method: string
  params: unknown[]
}

const bosServiceType = BotServiceType

/**
 * Total time `stopBotByExchange` will spend waiting for workers to acknowledge
 * the closes it posted, across ALL the bots on the connection. It is a budget
 * for the whole sweep, not per bot, so a user with many bots cannot stretch the
 * disconnect without bound. Well under the 5-minute bot-service RPC timeout in
 * `callExternalBotService`, which is what the user's `deleteExchange` request
 * used to sit on when a reply never came.
 */
const stopByExchangeReplyBudget = 60 * 1000

class Bot<T extends UserSchema = UserSchema> {
  protected ec = ExchangeChooser
  protected personalLimits = new Map<string, number>()
  protected workers: {
    type: BotType
    worker: Worker
    bots: number
    botsByType: {
      dca: number
      grid: number
      combo: number
      hedgeCombo: number
      hedgeDca: number
    }
    id: number
    created: number
    updated: number
    check: {
      status: boolean
      time: number
    }
    userId?: string
    limit: number
    heap?: {
      used: number
      limit: number
      code: number
    }
    heapHistory?: {
      used: number
      time: number
    }[]
    // Event-loop delay (ms) reported by the worker on each health ping — the
    // leading signal of a wedging worker (blocked loop) before the ping times out.
    lag?: {
      mean: number
      max: number
    }
    lagHistory?: {
      mean: number
      max: number
      time: number
    }[]
    // Consecutive health-ping failures; reset to 0 on any successful pong. Used to
    // distinguish a sustained wedge from transient deploy/restart ping noise.
    consecutiveFails?: number
    // Whether we've already escalated a WEDGED alert for the current fail episode,
    // so we escalate once per episode rather than every 5-minute ping.
    wedgedNotified?: boolean
    botIds: Map<string, string>
    logLevel?: LogLevel
  }[] = []

  protected static instance: Bot

  public bots: {
    id: string
    worker: number
    userId: string
    uuid: string
    type: BotType.grid
    paperContext: boolean
  }[]

  public dcaBots: {
    id: string
    worker: number
    userId: string
    uuid: string
    type: BotType.dca
    paperContext: boolean
    dcaType?: DCATypeEnum
  }[]

  public comboBots: {
    id: string
    worker: number
    userId: string
    uuid: string
    type: BotType.combo
    paperContext: boolean
  }[]

  public hedgeComboBots: {
    id: string
    worker: number
    userId: string
    uuid: string
    type: BotType.hedgeCombo
    paperContext: boolean
  }[]

  public hedgeDcaBots: {
    id: string
    worker: number
    userId: string
    uuid: string
    type: BotType.hedgeDca
    paperContext: boolean
  }[]

  protected botDb = botDb

  protected dcaBotDb = dcaBotDb

  protected comboBotDb = comboBotDb

  private orderDb = orderDb

  protected botEventDb = botEventDb

  private botMessageDb = botMessageDb

  private transactionDb = transactionDb

  private dcaDealsDb = dcaDealsDb

  private comboDealsDb = comboDealsDb

  private comboMinigridDb = minigridDb

  private comboProfitDb = comboProfitDb

  private comboTransactionDb = comboTransactionsDb

  protected pairsDb = pairDb

  private runAfterBotCreated: Map<string, (() => Promise<void> | void)[]> =
    new Map()

  private runAfterReponse: Map<
    string,
    ((response?: unknown) => Promise<void> | void)[]
  > = new Map()

  protected rabbit = new RabbitClient()

  protected estimatedRestart = 0
  private restarted = 0
  // Command-listener arming state — see `beginRestartWindow` / `armCommandListener`.
  private commandListenerArmed = false
  private restartWindowStartedAt = 0
  private lastRestartProgressAt = 0
  private armWatchdog: ReturnType<typeof setInterval> | undefined
  // Straggler accounting. Both sets live in the PARENT: the restart-stats writer
  // runs in the worker thread, so anything tracked there is invisible here.
  private restartExpectedIds = new Set<string>()
  private restartFinishedIds = new Set<string>()
  private stragglerTimer: ReturnType<typeof setTimeout> | undefined

  public constructor(
    protected useBots?: boolean,
    protected userDb: DB<T> = _userDb as unknown as DB<T>,
  ) {
    this.bots = []
    this.dcaBots = []
    this.comboBots = []
    this.hedgeComboBots = []
    this.hedgeDcaBots = []
    this.closeDCADeal = this.closeDCADeal.bind(this)
    this.restoreDeal = this.restoreDeal.bind(this)
    this.processWorkerMessage = this.processWorkerMessage.bind(this)
    this.handleWorkerTerminate = this.handleWorkerTerminate.bind(this)
    this.processBotClosedMessage = this.processBotClosedMessage.bind(this)
    this.updateRestart = this.updateRestart.bind(this)
    this.setServiceListener = this.setServiceListener.bind(this)
  }

  public get botPerWorker() {
    let botsPerWorker = +`${BOTS_PER_WORKER ?? defaultBotsPerWorker}`
    let comboPerWorker = +`${COMBO_PER_WORKER ?? botsPerWorker}`
    let dcaPerWorker = +`${DCA_PER_WORKER ?? botsPerWorker}`
    let gridPerWorker = +`${GRID_PER_WORKER ?? botsPerWorker}`
    let hedgeComboPerWorker = +`${
      HEDGE_COMBO_PER_WORKER ?? HEDGE_PER_WORKER ?? botsPerWorker
    }`
    let hedgeDcaPerWorker = +`${
      HEDGE_DCA_PER_WORKER ?? HEDGE_PER_WORKER ?? botsPerWorker
    }`
    if (isNaN(botsPerWorker)) {
      botsPerWorker = defaultBotsPerWorker
    }
    if (isNaN(comboPerWorker)) {
      comboPerWorker = defaultBotsPerWorker
    }
    if (isNaN(dcaPerWorker)) {
      dcaPerWorker = defaultBotsPerWorker
    }
    if (isNaN(gridPerWorker)) {
      gridPerWorker = defaultBotsPerWorker
    }
    if (isNaN(hedgeComboPerWorker)) {
      hedgeComboPerWorker = defaultBotsPerWorker
    }
    if (isNaN(hedgeDcaPerWorker)) {
      hedgeDcaPerWorker = defaultBotsPerWorker
    }
    return {
      grid: botsPerWorker,
      dca: dcaPerWorker,
      combo: comboPerWorker,
      hedgeCombo: hedgeComboPerWorker,
      hedgeDca: hedgeDcaPerWorker,
    }
  }

  public async updateExchangeCredentials(
    userId: string,
    exchangeUUID: string,
    key: string,
    secret: string,
    passphrase?: string,
    keysType?: CoinbaseKeysType,
    okxSource?: OKXSource,
    bybitHost?: BybitHost,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService(
        'all',
        'updateExchangeCredentials',
        false,
        userId,
        exchangeUUID,
        key,
        secret,
        passphrase,
        keysType,
        okxSource,
        bybitHost,
      )
    }
    for (const w of this.workers) {
      w.worker.postMessage({
        do: 'update',
        userId,
        exchangeUUID,
        key,
        secret,
        passphrase,
        keysType,
        okxSource,
        bybitHost,
      } as UpdateBotExchangeDto)
    }
  }

  public async updateExchangeInfo(
    exchange: ExchangeEnum,
    info: ClearPairsSchema[],
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService(
        'all',
        'updateExchangeInfo',
        true,
        exchange,
        info,
        'ignore',
      )
    }
    for (const w of this.workers) {
      w.worker.postMessage({
        do: 'exchangeInfo',
        info,
        exchange,
      } as UpdateBotExchangeInfoDto)
    }
  }

  @IdMute(mutex, () => 'updateRunAfterCreatedQueue')
  private async updateRunAfterCreatedQueue(
    botId: string,
    callback: () => Promise<void> | void,
  ) {
    this.runAfterBotCreated.set(
      botId,
      (this.runAfterBotCreated.get(botId) ?? []).concat(callback),
    )
  }

  @IdMute(mutex, () => 'updateResponseQueue')
  protected async updateResponseQueue(
    responseId: string,
    callback: (response?: unknown) => Promise<void> | void,
  ) {
    this.runAfterReponse.set(
      responseId,
      (this.runAfterReponse.get(responseId) ?? []).concat(callback),
    )
  }

  @IdMute(mutex, (botId: string) => `processCreateBotMessage${botId}`)
  private async processCreateBotMessage(botId: string) {
    const run = this.runAfterBotCreated.get(botId)
    if (run && run.length) {
      for (const r of run) {
        if (typeof r === 'function') {
          await r()
        }
      }
    }
    this.runAfterBotCreated.delete(botId)
  }

  @IdMute(
    mutex,
    (responseId: string) => `processReponseBotMessage${responseId}`,
  )
  private async processReponseBotMessage(
    responseId: string,
    response: unknown,
  ) {
    const run = this.runAfterReponse.get(responseId)
    if (run && run.length) {
      for (const r of run) {
        if (typeof r === 'function') {
          await r(response)
        }
      }
    }
    this.runAfterReponse.delete(responseId)
  }

  private async processBotClosedMessage(id: string, type: BotType) {
    this.handleLog(`Process bot closed event for ${id} ${type}`)
    let worker: Worker | undefined
    if (type === BotType.grid) {
      let find: (typeof this.bots)[0] | undefined
      this.bots = this.bots.filter((b) => {
        if (b.id === id) {
          find = b
          return false
        }
        return true
      })
      if (!find) {
        return
      }
      worker = this.getWorkerById(find.worker)
    }
    if (type === BotType.dca) {
      let find: (typeof this.dcaBots)[0] | undefined
      this.dcaBots = this.dcaBots.filter((b) => {
        if (b.id === id) {
          find = b
          return false
        }
        return true
      })
      if (!find) {
        return
      }
      worker = this.getWorkerById(find.worker)
    }
    if (type === BotType.combo) {
      let find: (typeof this.comboBots)[0] | undefined
      this.comboBots = this.comboBots.filter((b) => {
        if (b.id === id) {
          find = b
          return false
        }
        return true
      })
      if (!find) {
        return
      }
      worker = this.getWorkerById(find.worker)
    }
    if (type === BotType.hedgeCombo) {
      let find: (typeof this.hedgeComboBots)[0] | undefined
      this.hedgeComboBots = this.hedgeComboBots.filter((b) => {
        if (b.id === id) {
          find = b
          return false
        }
        return true
      })
      if (!find) {
        return
      }
      worker = this.getWorkerById(find.worker)
    }
    if (type === BotType.hedgeDca) {
      let find: (typeof this.hedgeDcaBots)[0] | undefined
      this.hedgeDcaBots = this.hedgeDcaBots.filter((b) => {
        if (b.id === id) {
          find = b
          return false
        }
        return true
      })
      if (!find) {
        return
      }
      worker = this.getWorkerById(find.worker)
    }

    if (worker) {
      worker?.postMessage({
        do: 'delete',
        botType: type,
        botId: id,
      })
      await this.changeWorkerBots(type, id, worker.threadId, -1)
    }
  }

  @IdMute(mutex, (data: BotParentEventsDto) => `workerMessage${data.botId}`)
  protected async processWorkerMessage(data: BotParentEventsDto) {
    if (data.event === 'createBot' && data.create) {
      this.processCreateBotMessage(data.botId)
    }
    if (data.event === 'botClosed' && data.botId && data.botType) {
      this.processBotClosedMessage(data.botId, data.botType)
    }
    if (data.event === 'response' && data.responseId) {
      this.processReponseBotMessage(data.responseId, data.response)
    }
    if (data.event === 'restartFinished' && data.botId) {
      this.restartFinishedIds.add(`${data.botId}`)
    }
  }

  @IdMute(mutex, (id: number) => `handleWorkerTerminate${id}`)
  protected async handleWorkerTerminate(id: number) {
    this.handleWarn(`${loggerPrefix} Worker terminated: ${id}`)
    const worker = this.workers.find((w) => w.id === id)
    this.workers = this.workers.filter((w) => w.id !== id)
    if (worker && worker.bots > 0) {
      const gridBots = this.bots.filter((b) => b.worker === id)
      const dcaBots = this.dcaBots.filter((b) => b.worker === id)
      const comboBots = this.comboBots.filter((b) => b.worker === id)
      const hedgeComboBots = this.hedgeComboBots.filter((b) => b.worker === id)
      const hedgeDcaBots = this.hedgeDcaBots.filter((b) => b.worker === id)
      this.bots = this.bots.filter((b) => b.worker !== id)
      this.dcaBots = this.dcaBots.filter((b) => b.worker !== id)
      this.comboBots = this.comboBots.filter((b) => b.worker !== id)
      this.hedgeComboBots = this.hedgeComboBots.filter((b) => b.worker !== id)
      this.hedgeDcaBots = this.hedgeDcaBots.filter((b) => b.worker !== id)
      if (gridBots.length) {
        const findBots = await this.botDb.readData(
          {
            _id: {
              $in: gridBots.map((b) => new Types.ObjectId(b.id)),
            },
            status: {
              $in: [
                BotStatusEnum.open,
                BotStatusEnum.range,
                BotStatusEnum.error,
                BotStatusEnum.monitoring,
              ],
            },
            isDeleted: { $ne: true },
          },
          {},
          {},
          true,
          true,
        )
        if ((findBots.data?.count ?? 0) > 0) {
          this.handleLog(
            `${loggerPrefix} Worker terminated: ${id} | ${
              findBots.data?.count ?? 0
            } Grid bots will be restarted`,
          )
          for (const b of findBots.data?.result ?? []) {
            const botId = b._id.toString()
            this.handleLog(
              `${loggerPrefix} Worker terminated: ${id} | Grid Bot ${botId} restarted`,
            )
            await this.handleBotRestartFromServiceStart(
              botId,
              BotType.grid,
              b.userId,
              b.uuid,
              b.exchange,
              !!b.paperContext,
              [],
              undefined,
              undefined,
              true,
            )
          }
        }
      }
      if (dcaBots.length) {
        const findBots = await this.dcaBotDb.readData(
          {
            _id: { $in: dcaBots.map((b) => new Types.ObjectId(b.id)) },
            $and: [
              {
                $or: [
                  { 'deals.active': { $gt: 0 } },
                  {
                    status: {
                      $in: [
                        BotStatusEnum.open,
                        BotStatusEnum.range,
                        BotStatusEnum.error,
                        BotStatusEnum.monitoring,
                      ],
                    },
                  },
                ],
              },
              { isDeleted: { $ne: true } },
            ],
          },
          {},
          {},
          true,
          true,
        )
        if ((findBots.data?.count ?? 0) > 0) {
          this.handleLog(
            `${loggerPrefix} Worker terminated: ${id} | ${
              findBots.data?.count ?? 0
            } DCA bots will be restarted`,
          )
          for (const b of findBots.data?.result ?? []) {
            if (b.status === BotStatusEnum.error && b.deals.active === 0) {
              this.dcaBotDb.updateData(
                { _id: b._id.toString() },
                { $set: { status: BotStatusEnum.closed } },
              )
              continue
            }
            const botId = b._id.toString()
            this.handleLog(
              `${loggerPrefix} Worker terminated: ${id} | DCA Bot ${botId} restarted`,
            )
            await this.handleBotRestartFromServiceStart(
              botId,
              BotType.dca,
              b.userId,
              b.uuid,
              b.exchange,
              !!b.paperContext,
              [],
              b.settings.type ?? DCATypeEnum.regular,
              b.status,
              true,
            )
          }
        }
      }
      if (comboBots.length) {
        const findBots = await this.comboBotDb.readData(
          {
            _id: { $in: comboBots.map((b) => new Types.ObjectId(b.id)) },
            $and: [
              {
                $or: [
                  { 'deals.active': { $gt: 0 } },
                  {
                    status: {
                      $in: [
                        BotStatusEnum.open,
                        BotStatusEnum.range,
                        BotStatusEnum.error,
                        BotStatusEnum.monitoring,
                      ],
                    },
                  },
                ],
              },
              { isDeleted: { $ne: true } },
            ],
          },
          {},
          {},
          true,
          true,
        )
        if ((findBots.data?.count ?? 0) > 0) {
          this.handleLog(
            `${loggerPrefix} Worker terminated: ${id} | ${
              findBots.data?.count ?? 0
            } Combo bots will be restarted`,
          )
          for (const b of findBots.data?.result ?? []) {
            if (b.status === BotStatusEnum.error && b.deals.active === 0) {
              this.comboBotDb.updateData(
                { _id: b._id.toString() },
                { $set: { status: BotStatusEnum.closed } },
              )
              continue
            }
            const botId = b._id.toString()
            this.handleLog(
              `${loggerPrefix} Worker terminated: ${id} | Combo Bot ${botId} restarted`,
            )
            await this.handleBotRestartFromServiceStart(
              botId,
              BotType.combo,
              b.userId,
              b.uuid,
              b.exchange,
              !!b.paperContext,
              [],
              undefined,
              b.status,
              true,
            )
          }
        }
      }
      if (hedgeComboBots.length) {
        const findBots = await hedgeComboBotDb.readData(
          {
            _id: {
              $in: hedgeComboBots.map((b) => new Types.ObjectId(b.id)),
            },
            $and: [{ isDeleted: { $ne: true } }],
          },
          {},
          { populate: { path: 'bots', select: 'deals exchange' } },
          true,
          true,
        )
        if ((findBots.data?.count ?? 0) > 0) {
          this.handleLog(
            `${loggerPrefix} Worker terminated: ${id} | ${
              findBots.data?.count ?? 0
            } Hedge Combo bots will be restarted`,
          )
          for (const b of findBots.data?.result ?? []) {
            if (
              b.status === BotStatusEnum.error &&
              b.bots.every((_b) => _b.deals.active === 0)
            ) {
              hedgeComboBotDb.updateData(
                { _id: b._id.toString() },
                { $set: { status: BotStatusEnum.closed } },
              )
              continue
            }
            const botId = b._id.toString()
            this.handleLog(
              `${loggerPrefix} Worker terminated: ${id} | Hedge Combo Bot ${botId} restarted`,
            )
            await this.handleBotRestartFromServiceStart(
              botId,
              BotType.hedgeCombo,
              b.userId,
              b.uuid,
              b.bots[0].exchange,
              !!b.paperContext,
              b.bots.map((_b) => ({ id: `${_b._id}`, type: BotType.combo })),
              undefined,
              b.status,
              true,
            )
          }
        }
      }
      if (hedgeDcaBots.length) {
        const findBots = await hedgeDCABotDb.readData(
          {
            _id: {
              $in: hedgeDcaBots.map((b) => new Types.ObjectId(b.id)),
            },
            $and: [{ isDeleted: { $ne: true } }],
          },
          {},
          { populate: { path: 'bots', select: 'deals exchange' } },
          true,
          true,
        )
        if ((findBots.data?.count ?? 0) > 0) {
          this.handleLog(
            `${loggerPrefix} Worker terminated: ${id} | ${
              findBots.data?.count ?? 0
            } Hedge DCA bots will be restarted`,
          )
          for (const b of findBots.data?.result ?? []) {
            if (
              b.status === BotStatusEnum.error &&
              b.bots.every((_b) => _b.deals.active === 0)
            ) {
              hedgeDCABotDb.updateData(
                { _id: b._id.toString() },
                { $set: { status: BotStatusEnum.closed } },
              )
              continue
            }
            const botId = b._id.toString()
            this.handleLog(
              `${loggerPrefix} Worker terminated: ${id} | Hedge DCA Bot ${botId} restarted`,
            )
            await this.handleBotRestartFromServiceStart(
              botId,
              BotType.hedgeDca,
              b.userId,
              b.uuid,
              b.bots[0].exchange,
              !!b.paperContext,
              b.bots.map((_b) => ({ id: `${_b._id}`, type: BotType.dca })),
              undefined,
              b.status,
              true,
            )
          }
        }
      }
    }
  }

  public getWorkerById(workerId: number) {
    return this.workers.find((w) => `${w.id}` === `${workerId}`)?.worker
  }

  public async getWorkerIdByBot(
    botId: string,
    botType: BotType,
  ): Promise<number | null> {
    if (!this.useBots || botType !== BotServiceType) {
      return await this.callExternalBotService<number | null>(
        botType,
        'getWorkerIdByBot',
        false,
        botId,
        botType,
      )
    }
    const find =
      botType === BotType.hedgeDca
        ? this.hedgeDcaBots.find((b) => b.id === botId)
        : botType === BotType.hedgeCombo
          ? this.hedgeComboBots.find((b) => b.id === botId)
          : botType === BotType.combo
            ? this.comboBots.find((b) => b.id === botId)
            : botType === BotType.dca
              ? this.dcaBots.find((b) => b.id === botId)
              : this.bots.find((b) => b.id === botId)
    return find?.worker ?? null
  }

  public async callFunctionFromMeta<T>(
    method: string,
    botType: BotType,
    ...args: unknown[]
  ): Promise<T | null> {
    if (!this.useBots || botType !== BotServiceType) {
      return await this.callExternalBotService<T>(
        botType,
        'callFunctionFromMeta',
        false,
        method,
        botType,
        ...args,
      )
    }

    const fn = this[method as keyof typeof this]
    if (typeof fn === 'function') {
      return (await fn.bind(this)(...args)) as T
    }
    this.handleError(
      `callFunctionFromMeta | Method ${method} not found in Bot class`,
    )
    return null
  }

  public async callBotFunctionFromMeta<T>(
    botId: string,
    botType: BotType,
    method: string,
    ...args: unknown[]
  ): Promise<T | null> {
    if (!this.useBots || botType !== BotServiceType) {
      return await this.callExternalBotService<T>(
        botType,
        'callBotFunctionFromMeta',
        false,
        botId,
        botType,
        method,
        args,
      )
    }
    const workerId = await this.getWorkerIdByBot(botId, botType)
    if (workerId && workerId > 0) {
      const worker = this.getWorkerById(workerId)
      if (worker) {
        const responseId = v4()
        return await new Promise<T>(async (res) => {
          await this.updateResponseQueue(responseId, async (r) => res(r as T))
          worker.postMessage({
            do: 'method',
            botType,
            botId,
            method,
            args,
            responseId,
          })
        })
      } else {
        this.handleError(
          `callBotFunctionFromMeta | Worker not found ${workerId} method ${method} bot id ${botId} bot type ${botType}`,
        )
      }
    } else {
      this.handleError(
        `callBotFunctionFromMeta | Worker id not found ${workerId} method ${method} bot id ${botId} bot type ${botType}`,
      )
    }
    return null
  }

  protected async createNewBot(
    botId: string,
    botType: BotType,
    userId: string,
    exchange: ExchangeEnum,
    uuid: string,
    args: unknown[],
    callback: (worker: Worker) => void,
    paperContext: boolean,
    dcaType?: DCATypeEnum,
  ) {
    if (botType !== BotServiceType) {
      return
    }
    const worker = await this.getWorkerForNewBot(
      botType,
      this.personalLimits.has(userId) ? userId : undefined,
    )
    await this.changeWorkerBots(botType, botId, worker.threadId, 1)
    await this.updateRunAfterCreatedQueue(botId, () => callback(worker))
    worker.postMessage({
      do: 'create',
      botType,
      botId,
      args,
      userId,
      exchange,
    } as CreateBotDto)
    if (botType === BotType.dca) {
      this.dcaBots = this.dcaBots.filter((b) => b.id !== botId)
      this.dcaBots.push({
        id: botId,
        worker: worker.threadId,
        userId,
        uuid,
        type: botType,
        paperContext,
        dcaType,
      })
    }
    if (botType === BotType.grid) {
      this.bots = this.bots.filter((b) => b.id !== botId)
      this.bots.push({
        id: botId,
        worker: worker.threadId,
        userId,
        uuid,
        type: botType,
        paperContext,
      })
    }
    if (botType === BotType.combo) {
      this.comboBots = this.comboBots.filter((b) => b.id !== botId)
      this.comboBots.push({
        id: botId,
        worker: worker.threadId,
        userId,
        uuid,
        type: botType,
        paperContext,
      })
    }
    if (botType === BotType.hedgeCombo) {
      this.hedgeComboBots = this.hedgeComboBots.filter((b) => b.id !== botId)
      this.hedgeComboBots.push({
        id: botId,
        worker: worker.threadId,
        userId,
        uuid,
        type: botType,
        paperContext,
      })
    }
    if (botType === BotType.hedgeDca) {
      this.hedgeDcaBots = this.hedgeDcaBots.filter((b) => b.id !== botId)
      this.hedgeDcaBots.push({
        id: botId,
        worker: worker.threadId,
        userId,
        uuid,
        type: botType,
        paperContext,
      })
    }
  }

  @IdMute(mutex, () => 'workerUpdate')
  protected async getWorkerForNewBot(type: BotType, userId?: string) {
    const hedge = type === BotType.hedgeDca || type === BotType.hedgeCombo
    const limitPerWorker =
      type === BotType.combo
        ? this.botPerWorker.combo
        : type === BotType.dca
          ? this.botPerWorker.dca
          : type === BotType.hedgeCombo
            ? this.botPerWorker.hedgeCombo
            : type === BotType.hedgeDca
              ? this.botPerWorker.hedgeDca
              : this.botPerWorker.grid
    const limit =
      userId && !hedge
        ? (this.personalLimits.get(userId) ?? limitPerWorker)
        : limitPerWorker
    const lowestWorker = [
      ...this.workers.filter(
        (w) =>
          w.bots < limit &&
          w.type === type &&
          (!hedge ? w.userId === userId : true),
      ),
    ].sort((a, b) => b.bots - a.bots)?.[0]
    if (lowestWorker && lowestWorker.bots < limit) {
      lowestWorker.updated = +new Date()
      this.workers = this.workers.map((w) => {
        if (`${w.id}` === `${lowestWorker.id}`) {
          return lowestWorker
        }
        return w
      })
      return lowestWorker.worker
    } else {
      const worker = new Worker(`${__dirname}/worker/botService.js`)
      const threadId = +`${worker.threadId}`
      worker.on('message', (msg) => this.processWorkerMessage(msg))
      worker.on('error', (e) => {
        logger.error(
          `${loggerPrefix} Worker ${threadId} error: ${
            (e as Error)?.message || e
          } `,
        )
        logger.error(e)
        if (`${(e as Error)?.message || e}`.includes('terminated')) {
          this.handleWorkerTerminate(threadId)
        }
      })
      worker.on('exit', () => {
        logger.error(`${loggerPrefix} Worker ${threadId} exited`)
        this.handleWorkerTerminate(threadId)
      })
      const time = +new Date()
      this.workers.push({
        type,
        worker,
        bots: 0,
        id: threadId,
        created: time,
        updated: time,
        check: {
          status: true,
          time,
        },
        userId: !hedge ? userId : undefined,
        limit,
        botsByType: {
          dca: 0,
          grid: 0,
          combo: 0,
          hedgeCombo: 0,
          hedgeDca: 0,
        },
        botIds: new Map(),
      })
      return worker
    }
  }

  @IdMute(mutex, () => 'workerUpdate')
  private async changeWorkerBots(
    botType: BotType,
    botId: string,
    workerId: number,
    count: number,
  ) {
    const worker = this.workers.find((w) => `${w.id}` === `${workerId}`)
    if (
      worker &&
      ((count > 0 && !worker.botIds.has(botId)) ||
        (count < 0 && worker.botIds.has(botId)))
    ) {
      worker.bots += count
      if (botType === BotType.combo) {
        worker.botsByType.combo += count
      }
      if (botType === BotType.dca) {
        worker.botsByType.dca += count
      }
      if (botType === BotType.grid) {
        worker.botsByType.grid += count
      }
      if (botType === BotType.hedgeCombo) {
        worker.botsByType.hedgeCombo += count
      }
      if (botType === BotType.hedgeDca) {
        worker.botsByType.hedgeDca += count
      }
      if (count > 0) {
        worker.botIds.set(botId, botType)
      } else {
        worker.botIds.delete(botId)
      }
      this.workers = this.workers.filter((w) => `${w.id}` !== `${workerId}`)
      if (worker.bots > 0) {
        this.workers = this.workers.concat(worker)
      } else {
        this.handleLog(
          `${loggerPrefix} Worker ${workerId} has no bots (bots - ${
            worker.bots
          }, bots by type - ${
            botType === BotType.dca
              ? worker.botsByType.dca
              : botType === BotType.combo
                ? worker.botsByType.combo
                : botType === BotType.hedgeCombo
                  ? worker.botsByType.hedgeCombo
                  : botType === BotType.hedgeDca
                    ? worker.botsByType.hedgeDca
                    : worker.botsByType.grid
          }, bot ids - ${worker.botIds.size}). Will be terminated`,
        )
        worker.worker.terminate()
      }
    }
  }
  protected entityNotFound(entity?: string) {
    return {
      status: StatusEnum.notok as const,
      reason: `${entity ?? 'Entity'} not found`,
      data: null,
    }
  }

  public static getInstance(useBots?: boolean): Bot {
    if (!Bot.instance) {
      Bot.instance = new Bot(useBots)
    }
    return Bot.instance
  }

  public async getBot(
    type = BotType.grid,
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    if (type === BotType.grid) {
      return await this.getBotFromDb(
        userId,
        id,
        publicBot,
        paperContext,
        shareId,
      )
    }
    if (type === BotType.combo) {
      return await this.getComboBotFromDb(
        userId,
        id,
        publicBot,
        paperContext,
        shareId,
      )
    }
    if (type === BotType.hedgeCombo) {
      return await this.getHedgeComboBotFromDb(
        userId,
        id,
        publicBot,
        paperContext,
        shareId,
      )
    }
    if (type === BotType.hedgeDca) {
      return await this.getHedgeDcaBotFromDb(
        userId,
        id,
        publicBot,
        paperContext,
        shareId,
      )
    }
    return await this.getDCABotFromDb(
      userId,
      id,
      publicBot,
      paperContext,
      shareId,
    )
  }

  public async getDCADealList(
    userId: string,
    status?: DCADealStatusEnum,
    paperContext?: boolean,
    botId?: string,
    terminal?: boolean,
    page = 1,
  ) {
    const filter: {
      userId: string
      status?: DCADealStatusEnum
      botId?: string
    } = {
      userId,
    }
    if (status) {
      filter.status = status
    }
    if (botId) {
      filter.botId = botId
    }
    const request = await this.dcaDealsDb.readData(
      {
        ...filter,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        type: terminal
          ? { $eq: DCATypeEnum.terminal }
          : { $nin: [DCATypeEnum.terminal] },
        parentBotId: { $exists: false },
      },
      undefined,
      { skip: (page - 1) * PER_PAGE, limit: PER_PAGE },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const bots = new Set(request.data.result.map((d) => d.botId))
    const botNamesRequest = await this.dcaBotDb.readData(
      {
        _id: { $in: Array.from(bots).map((b) => new Types.ObjectId(b)) },
      },
      { 'settings.name': 1, _id: 1, vars: 1 },
      undefined,
      true,
    )
    const result = request.data.result.map((d) => {
      delete d.__v
      const res = { ...d } as DCADealsSchema & { botName?: string }
      const bot = botNamesRequest.data?.result.find(
        (b) => `${b._id}` === d.botId,
      )
      if (bot) {
        res.botName = bot.settings.name
      }
      return res
    })
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        page,
        totalPages: Math.ceil(request.data.count / PER_PAGE),
        totalResults: request.data.count,
        result,
      },
    }
  }

  public async getComboDealList(
    userId: string,
    status?: DCADealStatusEnum,
    paperContext?: boolean,
    botId?: string,
    page = 1,
  ) {
    const filter: {
      userId: string
      status?: DCADealStatusEnum
      botId?: string
    } = {
      userId,
    }
    if (status) {
      filter.status = status
    }
    if (botId) {
      filter.botId = botId
    }
    const request = await this.comboDealsDb.readData(
      {
        ...filter,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        parentBotId: { $exists: false },
      },
      undefined,
      { skip: (page - 1) * PER_PAGE, limit: PER_PAGE },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const bots = new Set(request.data.result.map((d) => d.botId))
    const botNamesRequest = await this.comboBotDb.readData(
      {
        _id: { $in: Array.from(bots).map((b) => new Types.ObjectId(b)) },
      },
      { 'settings.name': 1, _id: 1, vars: 1 },
      undefined,
      true,
    )
    const result = request.data.result.map((d) => {
      delete d.__v
      const res = { ...d } as DCADealsSchema & { botName?: string }
      const bot = botNamesRequest.data?.result.find(
        (b) => `${b._id}` === d.botId,
      )
      if (bot) {
        res.botName = bot.settings.name
      }
      return res
    })
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        page,
        totalPages: Math.ceil(request.data.count / PER_PAGE),
        totalResults: request.data.count,
        result,
      },
    }
  }

  public async getDCADealListGraphQl(
    user: ExcludeDoc<UserSchema>,
    paperContext?: boolean,
    dataGridFilter?: DataGridFilterInput,
    botId?: string,
    exchange?: string,
    terminal?: boolean,
  ) {
    const userId = user._id.toString()

    const { filter, sort, skip, limit } =
      mapDataGridOptionsToMongoOptions(dataGridFilter)
    let s: Record<string, unknown> = {
      status: {
        $in: [
          DCADealStatusEnum.open,
          DCADealStatusEnum.error,
          DCADealStatusEnum.start,
        ],
      },
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      type: terminal
        ? { $eq: DCATypeEnum.terminal }
        : { $nin: [DCATypeEnum.terminal] },
    }

    if (filter.$and?.length || filter.$or?.length) {
      const f = filter.$and?.length
        ? filter.$and.reduce((acc, v) => ({ ...acc, ...v }), {})
        : filter.$or?.reduce((acc, v) => ({ ...acc, ...v }), {})
      s = { ...s, ...f }
    } else {
      s = { ...s, ...filter }
    }
    if (botId) {
      s.botId = botId
    }
    if (exchange) {
      s.exchangeUUID = exchange
    }
    const request = await this.dcaDealsDb.readData(
      { ...s, parentBotId: { $exists: false } },
      {},
      { sort, skip, limit: Math.min(500, limit ?? 500) },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const botNamesRequest = await this.dcaBotDb.readData(
      {
        _id: { $in: request.data.result.map((deal) => deal.botId) },
      },
      { 'settings.name': 1, _id: 1 },
      undefined,
      true,
    )
    const botNames = botNamesRequest.data?.result || []
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: request.data.result.map((d) => {
          delete d.__v
          return {
            ...d,
            paperContext: !!paperContext,
            botName:
              botNames.find((name) => d.botId === name._id.toString())?.settings
                .name || '',
          }
        }),
      },
      total: request.data.count,
    }
  }

  public async getComboDealListGraphQl(
    user: ExcludeDoc<UserSchema>,
    paperContext?: boolean,
    dataGridFilter?: DataGridFilterInput,
    botId?: string,
    exchange?: string,
  ) {
    const userId = user._id.toString()

    const { filter, sort, skip, limit } =
      mapDataGridOptionsToMongoOptions(dataGridFilter)

    let s: Record<string, unknown> = {
      status: {
        $in: [
          DCADealStatusEnum.open,
          DCADealStatusEnum.error,
          DCADealStatusEnum.start,
        ],
      },
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      type: { $ne: DCATypeEnum.terminal },
      ...filter,
    }
    if (filter.$and?.length || filter.$or?.length) {
      const f = filter.$and?.length
        ? filter.$and.reduce((acc, v) => ({ ...acc, ...v }), {})
        : filter.$or?.reduce((acc, v) => ({ ...acc, ...v }), {})
      s = { ...s, ...f }
    } else {
      s = { ...s, ...filter }
    }
    if (botId) {
      s.botId = botId
    }
    if (exchange) {
      s.exchangeUUID = exchange
    }

    const request = await this.comboDealsDb.readData(
      { ...s, parentBotId: { $exists: false } },
      {},
      { sort, skip, limit: Math.min(500, limit ?? 500) },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const botNamesRequest = await this.comboBotDb.readData(
      {
        _id: { $in: request.data.result.map((deal) => deal.botId) },
      },
      { 'settings.name': 1, _id: 1 },
      undefined,
      true,
    )
    const botNames = botNamesRequest.data?.result || []
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: request.data.result.map((d) => {
          delete d.__v
          return {
            ...d,
            paperContext: !!paperContext,
            botName:
              botNames.find((name) => d.botId === name._id.toString())?.settings
                .name || '',
          }
        }),
      },
      total: request.data.count,
    }
  }

  public async getHedgeComboDealListGraphQl(
    user: ExcludeDoc<UserSchema>,
    paperContext?: boolean,
    dataGridFilter?: DataGridFilterInput,
    botId?: string,
    exchange?: string,
  ) {
    const userId = user._id.toString()

    const { filter, sort, skip, limit } =
      mapDataGridOptionsToMongoOptions(dataGridFilter)

    let s: Record<string, unknown> = {
      status: {
        $in: [
          DCADealStatusEnum.open,
          DCADealStatusEnum.error,
          DCADealStatusEnum.start,
        ],
      },
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      type: { $ne: DCATypeEnum.terminal },
      ...filter,
    }
    if (filter.$and?.length || filter.$or?.length) {
      const f = filter.$and?.length
        ? filter.$and.reduce((acc, v) => ({ ...acc, ...v }), {})
        : filter.$or?.reduce((acc, v) => ({ ...acc, ...v }), {})
      s = { ...s, ...f }
    } else {
      s = { ...s, ...filter }
    }
    if (botId) {
      s.botId = botId
    }
    if (exchange) {
      s.exchangeUUID = exchange
    }

    const request = await this.comboDealsDb.readData(
      { ...s, parentBotId: { $exists: true } },
      {},
      { sort, skip, limit: Math.min(500, limit ?? 500) },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const botNamesRequest = await this.comboBotDb.readData(
      {
        _id: { $in: request.data.result.map((deal) => deal.botId) },
      },
      { 'settings.name': 1, _id: 1 },
      undefined,
      true,
    )
    const botNames = botNamesRequest.data?.result || []
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: request.data.result.map((d) => {
          delete d.__v
          return {
            ...d,
            paperContext: !!paperContext,
            botName:
              botNames.find((name) => d.botId === name._id.toString())?.settings
                .name || '',
          }
        }),
      },
      total: request.data.count,
    }
  }

  public async getHedgeDcaDealListGraphQl(
    user: ExcludeDoc<UserSchema>,
    paperContext?: boolean,
    dataGridFilter?: DataGridFilterInput,
    botId?: string,
    exchange?: string,
  ) {
    const userId = user._id.toString()

    const { filter, sort, skip, limit } =
      mapDataGridOptionsToMongoOptions(dataGridFilter)

    let s: Record<string, unknown> = {
      status: {
        $in: [
          DCADealStatusEnum.open,
          DCADealStatusEnum.error,
          DCADealStatusEnum.start,
        ],
      },
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      type: { $ne: DCATypeEnum.terminal },
      ...filter,
    }
    if (filter.$and?.length || filter.$or?.length) {
      const f = filter.$and?.length
        ? filter.$and.reduce((acc, v) => ({ ...acc, ...v }), {})
        : filter.$or?.reduce((acc, v) => ({ ...acc, ...v }), {})
      s = { ...s, ...f }
    } else {
      s = { ...s, ...filter }
    }
    if (botId) {
      s.botId = botId
    }
    if (exchange) {
      s.exchangeUUID = exchange
    }

    const request = await this.dcaDealsDb.readData(
      { ...s, parentBotId: { $exists: true } },
      {},
      { sort, skip, limit: Math.min(500, limit ?? 500) },
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    const botNamesRequest = await this.dcaBotDb.readData(
      {
        _id: { $in: request.data.result.map((deal) => deal.botId) },
      },
      { 'settings.name': 1, _id: 1 },
      undefined,
      true,
    )
    const botNames = botNamesRequest.data?.result || []
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: request.data.result.map((d) => {
          delete d.__v
          return {
            ...d,
            paperContext: !!paperContext,
            botName:
              botNames.find((name) => d.botId === name._id.toString())?.settings
                .name || '',
          }
        }),
      },
      total: request.data.count,
    }
  }

  public async getTradingTerminalBotsList(
    userId: string,
    paperContext: boolean,
  ) {
    const agg: PipelineStage[] = [
      {
        $match: {
          userId,
          'settings.type': {
            $eq: 'terminal',
          },
          paperContext: paperContext
            ? {
                $eq: true,
              }
            : {
                $eq: false,
              },
        },
      },
      /*{
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
                      $eq: ['$botId', '$$search'],
                    },
                    {
                      $in: ['$status', ['FILLED', 'NEW', 'PARTIALLY_FILLED']],
                    },
                  ],
                },
              },
            },
          ],
          as: 'orders',
          from: 'orders',
        },
      },*/
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
                  $eq: ['$botId', '$$search'],
                },
              },
            },
          ],
          as: 'dcadeals',
          from: 'dcadeals',
        },
      },
    ]
    const result = await this.dcaBotDb.aggregate(agg)
    if (result.status === StatusEnum.ok) {
      return {
        status: StatusEnum.ok,
        data: result.data.result.map((d) => ({
          ...d,
          ...convertDCABotToArray(d),
          dealsInBot: d.deals,
          deals: d.dcadeals,
        })),
        reason: null,
      }
    }
    return result
  }

  public async getActiveRealBotList(type = BotType.grid, userId: string) {
    if (type === BotType.grid) {
      return await this.botDb.readData(
        {
          userId,
          status: {
            $in: [
              BotStatusEnum.error,
              BotStatusEnum.open,
              BotStatusEnum.range,
              BotStatusEnum.monitoring,
            ],
          },
          isDeleted: { $ne: true },
          paperContext: { $ne: true },
        },
        {},
        {},
        true,
        true,
      )
    }
    if (type === BotType.combo) {
      return await this.comboBotDb.readData(
        {
          userId,
          $or: [
            {
              status: {
                $in: [
                  BotStatusEnum.error,
                  BotStatusEnum.open,
                  BotStatusEnum.range,
                  BotStatusEnum.monitoring,
                ],
              },
            },
            { 'deals.active': { $gt: 0 } },
          ],
          'settings.type': { $ne: DCATypeEnum.terminal },
          isDeleted: { $ne: true },
          paperContext: { $ne: true },
        },
        {},
        {},
        true,
        true,
      )
    }
    return await this.dcaBotDb.readData(
      {
        userId,
        $or: [
          {
            status: {
              $in: [
                BotStatusEnum.error,
                BotStatusEnum.open,
                BotStatusEnum.range,
                BotStatusEnum.monitoring,
              ],
            },
          },
          { 'deals.active': { $gt: 0 } },
        ],
        'settings.type': { $ne: DCATypeEnum.terminal },
        isDeleted: { $ne: true },
        paperContext: { $ne: true },
      },
      {},
      {},
      true,
      true,
    )
  }

  public async botDashboardStats(
    userId: string,
    type: BotType,
    paperContext: boolean,
    terminal?: boolean,
  ) {
    if (type === BotType.grid) {
      return await this.botDb.aggregate<{
        status: BotStatusEnum
        count: number
      }>([
        {
          $match: {
            userId,
            //@ts-ignore
            isDeleted: { $ne: true },
            //@ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            status: {
              //@ts-ignore
              $in: [
                BotStatusEnum.open,
                BotStatusEnum.range,
                BotStatusEnum.error,
                BotStatusEnum.monitoring,
              ],
            },
          },
        },
        {
          $project: {
            status: 1,
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
          },
        },
      ])
    }
    if (type === BotType.combo) {
      return await this.comboBotDb.aggregate<{
        status: BotStatusEnum
        count: number
      }>([
        {
          $match: {
            userId,
            //@ts-ignore
            isDeleted: { $ne: true },
            //@ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            //@ts-ignore
            $or: [
              {
                status: {
                  //@ts-ignore
                  $in: [
                    BotStatusEnum.open,
                    BotStatusEnum.range,
                    BotStatusEnum.error,
                    BotStatusEnum.monitoring,
                  ],
                },
              },
              { 'deals.active': { $gt: 0 } },
            ],
            //@ts-ignore
            parentBotId: { $exists: false },
          },
        },
        {
          $project: {
            status: 1,
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
          },
        },
      ])
    }
    if (type === BotType.hedgeCombo) {
      return await hedgeComboBotDb.aggregate<{
        status: BotStatusEnum
        count: number
      }>([
        {
          $match: {
            userId,
            //@ts-ignore
            isDeleted: { $ne: true },
            //@ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            //@ts-ignore
            status: {
              //@ts-ignore
              $in: [
                BotStatusEnum.open,
                BotStatusEnum.range,
                BotStatusEnum.error,
                BotStatusEnum.monitoring,
              ],
            },
          },
        },
        {
          $project: {
            status: 1,
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
          },
        },
      ])
    }
    if (type === BotType.hedgeDca) {
      return await hedgeDCABotDb.aggregate<{
        status: BotStatusEnum
        count: number
      }>([
        {
          $match: {
            userId,
            //@ts-ignore
            isDeleted: { $ne: true },
            //@ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            //@ts-ignore
            status: {
              //@ts-ignore
              $in: [
                BotStatusEnum.open,
                BotStatusEnum.range,
                BotStatusEnum.error,
                BotStatusEnum.monitoring,
              ],
            },
          },
        },
        {
          $project: {
            status: 1,
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
          },
        },
      ])
    }
    return await this.dcaBotDb.aggregate<{
      status: BotStatusEnum
      count: number
    }>([
      {
        $match: {
          userId,
          //@ts-ignore
          isDeleted: { $ne: true },
          //@ts-ignore
          paperContext: paperContext ? { $eq: true } : { $ne: true },
          //@ts-ignore
          $or: [
            {
              status: {
                //@ts-ignore
                $in: [
                  BotStatusEnum.open,
                  BotStatusEnum.range,
                  BotStatusEnum.error,
                  BotStatusEnum.monitoring,
                ],
              },
            },
            { 'deals.active': { $gt: 0 } },
          ],
          //@ts-ignore
          parentBotId: { $exists: false },
          'settings.type': terminal
            ? { $eq: DCATypeEnum.terminal }
            : {
                //@ts-ignore
                $nin: [DCATypeEnum.terminal],
              },
        },
      },
      {
        $project: {
          status: 1,
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          status: '$_id',
          count: 1,
        },
      },
    ])
  }
  public async dealDashboardStats(
    userId: string,
    type: BotType,
    paperContext: boolean,
    terminal?: boolean,
  ) {
    if (type === BotType.combo || type === BotType.hedgeCombo) {
      return await this.comboDealsDb.aggregate<{
        normal: number
        inProfit: number
        eighty: number
        max: number
      }>([
        {
          $match: {
            userId,
            //@ts-ignore
            isDeleted: { $ne: true },
            //@ts-ignore
            paperContext: paperContext ? { $eq: true } : { $ne: true },
            status: DCADealStatusEnum.open,
            //@ts-ignore
            $or: [
              ...(type === BotType.hedgeCombo
                ? [{ parentBotId: { $ne: null } }]
                : [
                    { parentBotId: { $exists: false } },
                    { parentBotId: { $eq: null } },
                  ]),
            ],
          },
        },
        {
          $project: {
            levelsRatio: {
              $divide: ['$levels.complete', '$levels.all'],
            },
            all: '$levels.all',
            'stats.currentCount': 1,
            'stats.unrealizedProfit': {
              $ifNull: ['$stats.unrealizedProfit', 0],
            },
          },
        },
        {
          $group: {
            _id: 'null',
            normal: {
              $sum: 1,
            },
            inProfit: {
              $sum: {
                $cond: [{ $gt: ['$stats.unrealizedProfit', 0] }, 1, 0],
              },
            },
            eighty: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $gte: ['$levelsRatio', 0.8],
                      },
                      {
                        $lt: ['$levelsRatio', 1],
                      },
                      {
                        $gt: ['$all', 1],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            max: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $eq: ['$levelsRatio', 1],
                      },
                      {
                        $gt: ['$all', 1],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            unrealizedProfit: {
              $sum: '$stats.unrealizedProfit',
            },
          },
        },
        {
          $project: {
            _id: 0,
            normal: 1,
            inProfit: 1,
            eighty: 1,
            max: 1,
            unrealizedProfit: 1,
          },
        },
      ])
    }
    return await this.dcaDealsDb.aggregate<{
      normal: number
      inProfit: number
      eighty: number
      max: number
    }>([
      {
        $match: {
          userId,
          //@ts-ignore
          isDeleted: { $ne: true },
          //@ts-ignore
          paperContext: paperContext ? { $eq: true } : { $ne: true },
          status: DCADealStatusEnum.open,
          type: terminal
            ? { $eq: DCATypeEnum.terminal }
            : {
                //@ts-ignore
                $nin: [DCATypeEnum.terminal],
              },
          //@ts-ignore
          $or: [
            ...(type === BotType.hedgeDca
              ? [{ parentBotId: { $ne: null } }]
              : [
                  { parentBotId: { $exists: false } },
                  { parentBotId: { $eq: null } },
                ]),
          ],
        },
      },
      {
        $project: {
          levelsRatio: {
            $divide: ['$levels.complete', '$levels.all'],
          },
          'stats.currentCount': 1,
          'stats.unrealizedProfit': { $ifNull: ['$stats.unrealizedProfit', 0] },
          all: '$levels.all',
        },
      },
      {
        $group: {
          _id: 'null',
          normal: {
            $sum: 1,
          },
          inProfit: {
            $sum: {
              $cond: [{ $eq: ['$stats.currentCount', 'profit'] }, 1, 0],
            },
          },
          eighty: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $gte: ['$levelsRatio', 0.8],
                    },
                    {
                      $lt: ['$levelsRatio', 1],
                    },
                    {
                      $gt: ['$all', 1],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          max: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $eq: ['$levelsRatio', 1],
                    },
                    {
                      $gt: ['$all', 1],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          unrealizedProfit: {
            $sum: '$stats.unrealizedProfit',
          },
        },
      },
      {
        $project: {
          _id: 0,
          normal: 1,
          inProfit: 1,
          eighty: 1,
          max: 1,
          unrealizedProfit: 1,
        },
      },
    ])
  }
  public async getBotList(
    type = BotType.grid,
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    all?: boolean,
    dataGridInput: DataGridFilterInput = {},
  ) {
    if (type === BotType.grid) {
      return await this.getGridBotList(
        userId,
        token,
        status,
        paperContext,
        dataGridInput,
      )
    }
    if (type === BotType.combo) {
      return await this.getComboBotList(
        userId,
        token,
        status,
        paperContext,
        all,
        dataGridInput,
      )
    }
    if (type === BotType.hedgeCombo) {
      return await this.getHedgeComboBotList(
        userId,
        token,
        status,
        paperContext,
        all,
        dataGridInput,
      )
    }
    if (type === BotType.hedgeDca) {
      return await this.getHedgeDcaBotList(
        userId,
        token,
        status,
        paperContext,
        all,
        dataGridInput,
      )
    }
    return await this.getDCABotList(
      userId,
      token,
      status,
      paperContext,
      all,
      dataGridInput,
    )
  }

  public async getDCABotSettings(
    userId: string,
    botId: string,
    shareId?: string,
  ) {
    const bot = await this.dcaBotDb.readData({
      $and: [
        {
          $or: [
            { userId },
            { public: true },
            { shareId, share: { $eq: true } },
          ],
        },
        { _id: botId as any, 'settings.type': { $ne: DCATypeEnum.terminal } },
        { isDeleted: { $ne: true } },
      ],
    })
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const data = convertDCABot(bot.data.result)
    return {
      status: StatusEnum.ok,
      data: {
        settings: data.settings,
        exchange: data.exchange,
        exchangeUUID: data.exchangeUUID,
        baseAsset: Array.from(data.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(data.symbol.values()).map((a) => a.quoteAsset),
        created: data.created,
        updated:
          data.status === BotStatusEnum.archive ||
          data.status === BotStatusEnum.closed
            ? data.updated
            : new Date(),
        vars:
          shareId && `${data.userId}` !== `${userId}`
            ? { list: [], paths: [] }
            : (data.vars ?? { list: [], paths: [] }),
      },
      reason: null,
    }
  }

  public async getComboBotSettings(
    userId: string,
    botId: string,
    shareId?: string,
  ) {
    const bot = await this.comboBotDb.readData({
      $and: [
        {
          $or: [
            { userId },
            { public: true },
            { shareId, share: { $eq: true } },
          ],
        },
        { _id: botId as any },
        { isDeleted: { $ne: true } },
      ],
    })
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const data = convertComboBot(bot.data.result)
    return {
      status: StatusEnum.ok,
      data: {
        settings: data.settings,
        exchange: data.exchange,
        exchangeUUID: data.exchangeUUID,
        baseAsset: Array.from(data.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(data.symbol.values()).map((a) => a.quoteAsset),
        created: data.created,
        updated:
          data.status === BotStatusEnum.archive ||
          data.status === BotStatusEnum.closed
            ? data.updated
            : new Date(),
        vars:
          shareId && `${data.userId}` !== `${userId}`
            ? { list: [], paths: [] }
            : (data.vars ?? { list: [], paths: [] }),
      },
      reason: null,
    }
  }

  public async getHedgeComboBotSettings(
    userId: string,
    botId: string,
    shareId?: string,
  ) {
    const bot = await hedgeComboBotDb.readData(
      {
        $and: [
          {
            $or: [
              { userId },
              { public: true },
              { shareId, share: { $eq: true } },
            ],
          },
          { _id: botId as any },
          { isDeleted: { $ne: true } },
        ],
      },
      {},
      { populate: 'bots' },
    )

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const _longBot = bot.data.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.long,
    )
    const _shortBot = bot.data.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.short,
    )
    const longBot = _longBot && convertComboBot(_longBot)
    if (!longBot) {
      return this.entityNotFound('Bot')
    }
    const shortBot = _shortBot && convertComboBot(_shortBot)
    if (!shortBot) {
      return this.entityNotFound('Bot')
    }
    const data = {
      long: {
        settings: longBot.settings,
        exchange: longBot.exchange,
        exchangeUUID: longBot.exchangeUUID,
        baseAsset: Array.from(longBot.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(longBot.symbol.values()).map(
          (a) => a.quoteAsset,
        ),
        created: longBot.created,
        updated:
          longBot.status === BotStatusEnum.archive ||
          longBot.status === BotStatusEnum.closed
            ? longBot.updated
            : new Date(),
        vars: userId !== bot.data.result.userId ? null : longBot.vars,
      },
      short: {
        settings: shortBot.settings,
        exchange: shortBot.exchange,
        exchangeUUID: shortBot.exchangeUUID,
        baseAsset: Array.from(shortBot.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(shortBot.symbol.values()).map(
          (a) => a.quoteAsset,
        ),
        created: shortBot.created,
        updated:
          shortBot.status === BotStatusEnum.archive ||
          shortBot.status === BotStatusEnum.closed
            ? shortBot.updated
            : new Date(),
        vars: userId !== bot.data.result.userId ? null : shortBot.vars,
      },
      sharedSettings: bot.data.result.sharedSettings,
      created: bot.data.result.created,
      updated: bot.data.result.updated,
    }
    return {
      status: StatusEnum.ok,
      data,
      reason: null,
    }
  }

  public async getHedgeDcaBotSettings(
    userId: string,
    botId: string,
    shareId?: string,
  ) {
    const bot = await hedgeDCABotDb.readData(
      {
        $and: [
          {
            $or: [
              { userId },
              { public: true },
              { shareId, share: { $eq: true } },
            ],
          },
          { _id: botId as any },
          { isDeleted: { $ne: true } },
        ],
      },
      {},
      { populate: 'bots' },
    )

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const _longBot = bot.data.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.long,
    )
    const _shortBot = bot.data.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.short,
    )
    const longBot = _longBot && convertComboBot(_longBot)
    if (!longBot) {
      return this.entityNotFound('Bot')
    }
    const shortBot = _shortBot && convertComboBot(_shortBot)
    if (!shortBot) {
      return this.entityNotFound('Bot')
    }
    const data = {
      long: {
        settings: longBot.settings,
        exchange: longBot.exchange,
        exchangeUUID: longBot.exchangeUUID,
        baseAsset: Array.from(longBot.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(longBot.symbol.values()).map(
          (a) => a.quoteAsset,
        ),
        created: longBot.created,
        updated:
          longBot.status === BotStatusEnum.archive ||
          longBot.status === BotStatusEnum.closed
            ? longBot.updated
            : new Date(),
        vars: userId !== bot.data.result.userId ? null : longBot.vars,
      },
      short: {
        settings: shortBot.settings,
        exchange: shortBot.exchange,
        exchangeUUID: shortBot.exchangeUUID,
        baseAsset: Array.from(shortBot.symbol.values()).map((a) => a.baseAsset),
        quoteAsset: Array.from(shortBot.symbol.values()).map(
          (a) => a.quoteAsset,
        ),
        created: shortBot.created,
        updated:
          shortBot.status === BotStatusEnum.archive ||
          shortBot.status === BotStatusEnum.closed
            ? shortBot.updated
            : new Date(),
        vars: userId !== bot.data.result.userId ? null : shortBot.vars,
      },
      sharedSettings: bot.data.result.sharedSettings,
    }
    return {
      status: StatusEnum.ok,
      data,
      reason: null,
    }
  }

  public async getGridBotSettings(
    userId: string,
    botId: string,
    shareId?: string,
  ) {
    const bot = await this.botDb.readData({
      $and: [
        {
          $or: [
            { userId },
            { public: true },
            { shareId, share: { $eq: true } },
          ],
        },
        { _id: botId as any },
        { isDeleted: { $ne: true } },
      ],
    })
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data.result) {
      return this.entityNotFound('Bot')
    }
    return {
      status: StatusEnum.ok,
      data: {
        settings: bot.data.result?.settings,
        exchange: bot.data.result?.exchange,
        exchangeUUID: bot.data.result?.exchangeUUID,
        baseAsset: bot.data.result?.symbol.baseAsset,
        quoteAsset: bot.data.result?.symbol.quoteAsset,
        created: bot.data.result?.created,
        updated:
          bot.data.result?.status === BotStatusEnum.archive ||
          bot.data.result.status === BotStatusEnum.closed
            ? bot.data.result?.updated
            : new Date(),
        vars:
          shareId && `${bot.data.result?.userId}` !== `${userId}`
            ? { list: [], paths: [] }
            : (bot.data.result?.vars ?? { list: [], paths: [] }),
      },
      reason: null,
    }
  }

  public async getPublicBotList(
    type: BotType,
    userId: string,
    status?: BotStatusEnum,
    paperContext?: boolean,
    page = 1,
  ) {
    const filter = {
      userId,
      status: status ? { $eq: status } : { $ne: status },
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      isDeleted: { $ne: true },
    }
    const options = { skip: (page - 1) * PER_PAGE, limit: PER_PAGE }
    if (type === BotType.grid) {
      const request = await this.botDb.readData(
        filter,
        undefined,
        options,
        true,
        true,
      )
      if (request.status === StatusEnum.notok) {
        return request
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: {
          page,
          totalPages: Math.ceil(request.data.count / PER_PAGE),
          totalResults: request.data.count,
          result: request.data.result.map((d) => {
            delete d.notEnoughBalance
            delete d.__v
            return d
          }),
        },
      }
    }
    if (type === BotType.combo) {
      const request = await this.comboBotDb.readData(
        filter,
        undefined,
        options,
        true,
        true,
      )
      if (request.status === StatusEnum.notok) {
        return request
      }
      return {
        status: StatusEnum.ok,
        reason: null,
        data: {
          page,
          totalPages: Math.ceil(request.data.count / PER_PAGE),
          totalResults: request.data.count,
          result: request.data.result.map((d) => {
            delete d.notEnoughBalance
            delete d.__v
            return convertComboBotToArray(d)
          }),
        },
      }
    }
    const request = await this.dcaBotDb.readData(
      filter,
      undefined,
      options,
      true,
      true,
    )
    if (request.status === StatusEnum.notok) {
      return request
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        page,
        totalPages: Math.ceil(request.data.count / PER_PAGE),
        totalResults: request.data.count,
        result: request.data.result.map((d) => {
          delete d.notEnoughBalance
          delete d.__v
          return convertDCABotToArray(d)
        }),
      },
    }
  }

  protected async checkBotPairsBySettings(
    exchange: ExchangeEnum,
    settings: DCABotSettings,
    pairs: ClearPairsSchema[],
  ): Promise<{ filtered: ClearPairsSchema[]; removed: ClearPairsSchema[] }> {
    const result: {
      filtered: ClearPairsSchema[]
      removed: ClearPairsSchema[]
    } = { filtered: pairs, removed: [] }
    if (
      settings.orderSizeType === OrderSizeTypeEnum.percFree ||
      settings.orderSizeType === OrderSizeTypeEnum.percTotal
    ) {
      return result
    }
    const exchangeInstance = this.ec.chooseExchangeFactory(exchange)
    if (exchangeInstance) {
      const prices = await exchangeInstance('', '').getAllPrices(true)
      if (prices && prices.status === StatusEnum.ok) {
        if (
          settings.strategy === StrategyEnum.long ||
          (settings.futures && !settings.coinm)
        ) {
          for (const p of pairs) {
            const price = prices.data.find((_p) => _p.pair === p.pair)
            if (price) {
              const minQuote = p.baseAsset.minAmount * price.price
              if (
                minQuote > +settings.baseOrderSize ||
                (settings.useDca && minQuote > +settings.orderSize) ||
                +settings.baseOrderSize < p.quoteAsset.minAmount ||
                (settings.useDca &&
                  +settings.orderSize < p.quoteAsset.minAmount)
              ) {
                result.removed.push(p)
                result.filtered = result.filtered.filter(
                  (f) => f.pair !== p.pair,
                )
              }
            }
          }
        }
        if (
          (settings.strategy === StrategyEnum.short && !settings.futures) ||
          settings.coinm
        ) {
          for (const p of pairs) {
            const price = prices.data.find((_p) => _p.pair === p.pair)
            if (price) {
              const minBase = p.quoteAsset.minAmount / price.price
              if (
                minBase > +settings.baseOrderSize ||
                (settings.useDca && minBase > +settings.orderSize) ||
                +settings.baseOrderSize < p.baseAsset.minAmount ||
                (settings.useDca && +settings.orderSize < p.baseAsset.minAmount)
              ) {
                result.removed.push(p)
                result.filtered = result.filtered.filter(
                  (f) => f.pair !== p.pair,
                )
              }
            }
          }
        }
      }
    }
    return result
  }

  public async checkPairs(
    exchange: ExchangeEnum,
    pairs: string[],
    pairsFromDb?: BaseReturn<{ result: ClearPairsSchema[] }>,
  ) {
    pairsFromDb =
      pairsFromDb ||
      (await this.pairsDb.readData(
        { exchange },
        {
          pair: 1,
          'baseAsset.name': 1,
          'baseAsset.minAmount': 1,
          'quoteAsset.name': 1,
          'quoteAsset.minAmount': 1,
        },
        {},
        true,
      ))
    if (!pairsFromDb.data?.result) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Internal error. Please try again later',
        data: null,
      }
    }
    return {
      status: StatusEnum.ok as const,
      reason: null,
      data: pairs
        .map((p) => {
          // X-Perp pairs (e.g. `AAVE-USD_UM_XPERP`) are already the
          // canonical exchange-native pair string - splitting them on `_`
          // would tear the `_UM_XPERP` contract-type suffix apart instead
          // of separating base/quote, so match those directly first.
          if (isXperpPair(p)) {
            const direct = pairsFromDb?.data?.result.find((f) => f.pair === p)
            return direct ?? null
          }
          const split = p.split('_')
          const find = pairsFromDb?.data?.result.find(
            (f) =>
              f.baseAsset.name === split[0] && f.quoteAsset.name === split[1],
          )
          if (find) {
            return find
          }
          return null
        })
        .filter((f) => f !== null) as ClearPairsSchema[],
    }
  }

  public async changeDCABotPairs(
    userId: string,
    botId?: string,
    botName?: string,
    pairsToChange?: {
      remove?: string[]
      add?: string[]
    },
    pairsToSet?: string[],
    pairsToSetMode?: PairsToSetMode,
    returnResult = false,
  ) {
    if (
      (pairsToChange &&
        ((!pairsToChange.add && !pairsToChange.remove) ||
          (!(pairsToChange.add ?? []).length &&
            !(pairsToChange.remove ?? []).length))) ||
      (pairsToSet && !pairsToSet.length)
    ) {
      return {
        status: StatusEnum.notok as const,
        reason: 'No pairs to change',
        data: null,
      }
    }
    const user = await this.userDb.readData({ _id: userId })
    if (!user || user.status === StatusEnum.notok) {
      return this.entityNotFound('User')
    }
    const bot = botId
      ? await this.dcaBotDb.readData({
          _id: botId,
          userId,
          isDeleted: { $ne: true },
        })
      : await this.dcaBotDb.readData({
          'settings.name': {
            $exists: true,
            $eq: botName,
          },
          userId,
          isDeleted: { $ne: true },
        })
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data || !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    if (!bot.data.result.settings.useMulti) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Pair update is not supported in single coin bots',
        data: null,
      }
    }
    let removed = 0
    let added = 0
    const pairsFromDb = await this.pairsDb.readData(
      { exchange: bot.data.result.exchange },
      {
        pair: 1,
        'baseAsset.name': 1,
        'baseAsset.minAmount': 1,
        'quoteAsset.name': 1,
        'quoteAsset.minAmount': 1,
      },
      {},
      true,
    )
    if (!pairsFromDb.data?.result) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Internal error. Please try again later',
        data: null,
      }
    }
    const current: Set<string> = new Set()

    bot.data.result.settings.pair.forEach((p) => {
      const find = pairsFromDb.data.result.find((f) => f.pair === p)
      if (find) {
        current.add(`${find.baseAsset.name}_${find.quoteAsset.name}`)
      }
    })
    const previous = Array.from(current)
    if (pairsToSet) {
      if (pairsToSetMode === PairsToSetMode.replace || !pairsToSetMode) {
        pairsToSet.forEach((p) => {
          if (!current.has(p)) {
            current.add(p)
            added++
          }
        })
        for (const c of current) {
          if (!pairsToSet.includes(c)) {
            current.delete(c)
            removed++
          }
        }
      }
      if (pairsToSetMode === PairsToSetMode.add) {
        pairsToSet.forEach((p) => {
          if (!current.has(p)) {
            current.add(p)
            added++
          }
        })
      }
      if (pairsToSetMode === PairsToSetMode.remove) {
        pairsToSet.forEach((p) => {
          if (current.has(p)) {
            current.delete(p)
            removed++
          }
        })
      }
    } else if (pairsToChange) {
      ;(pairsToChange.remove ?? []).forEach((p) => {
        if (current.has(p)) {
          current.delete(p)
          removed++
        }
      })
      ;(pairsToChange.add ?? []).forEach((p) => {
        if (!current.has(p)) {
          current.add(p)
          added++
        }
      })
    }
    if (removed === 0 && added === 0) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Nothing changed',
        data: null,
      }
    }
    let pairsBeforeSlice = Array.from(current)
    const notFound: string[] = []
    const notSupported: string[] = []
    pairsBeforeSlice = pairsBeforeSlice.filter((p) => {
      const [base, quote] = p.split('_')
      const symbol = Array.from(
        new Map(Object.entries(bot.data.result.symbol)).values(),
      ) as Symbols[]
      if (
        bot.data.result.settings.strategy === StrategyEnum.long ||
        (bot.data.result.settings.futures && !bot.data.result.settings.coinm)
      ) {
        if (quote !== symbol[0].quoteAsset) {
          notSupported.push(p)
          return false
        }
      }
      if (
        (!bot.data.result.settings.futures &&
          bot.data.result.settings.strategy === StrategyEnum.short) ||
        bot.data.result.settings.coinm
      ) {
        if (base !== symbol[0].baseAsset) {
          notSupported.push(p)
          return false
        }
      }
      return true
    })
    const checkBaseOrder = await this.checkBotPairsBySettings(
      bot.data.result.exchange,
      bot.data.result.settings,
      (
        await this.checkPairs(
          bot.data.result.exchange,
          pairsBeforeSlice,
          pairsFromDb,
        )
      )?.data ?? [],
    )
    if (checkBaseOrder.filtered.length === 0) {
      return {
        status: StatusEnum.notok as const,
        reason: "Pairs didn't pass settings check",
        data: null,
      }
    }

    const exchangeFormatPairs: string[] = []
    let pairsToSetInBot = checkBaseOrder.filtered
      .map((p) => `${p.baseAsset.name}_${p.quoteAsset.name}`)
      .filter((p) => {
        const [base, quote] = p.split('_')
        if (!base || !quote) {
          notFound.push(p)
          return false
        }
        const pair = pairsFromDb.data.result.find(
          (f) => f.baseAsset.name === base && f.quoteAsset.name === quote,
        )
        if (!pair) {
          notFound.push(p)
          return false
        }
        exchangeFormatPairs.push(pair.pair)
        return true
      })

    const sliced = pairsToSetInBot
    pairsToSetInBot = pairsToSetInBot
    if (
      !returnResult &&
      (notFound.length ||
        sliced.length ||
        checkBaseOrder.removed.length ||
        notSupported.length)
    ) {
      const msg = `Cannot set some pairs.${
        notSupported.length
          ? ` Not supported by the bot: ${notSupported.join(', ')}.`
          : ''
      }${notFound.length ? ` Not found: ${notFound.join(', ')}.` : ''}${
        checkBaseOrder.removed.length
          ? ` Order size smaller than pair minimum: ${checkBaseOrder.removed
              .map((r) => `${r.baseAsset.name}_${r.quoteAsset.name}`)
              .join(', ')}.`
          : ''
      }${
        sliced.length
          ? ` Hidden due to max pairs limit: ${sliced.join(', ')}.`
          : ''
      }`
      this.botEventDb.createData({
        botId: `${bot.data.result._id}`,
        botType: BotType.dca,
        event: 'Warning',
        userId,
        paperContext: !!bot.data.result.paperContext,
        description: msg,
        type: MessageTypeEnum.warning,
      })
    }
    if (!pairsToSetInBot.length) {
      return {
        status: StatusEnum.notok as const,
        reason: 'No pairs to set',
        data: null,
      }
    }
    //@ts-ignore
    delete bot.data.result.settings._id
    if (!returnResult) {
      this.changeDCABot(
        {
          ...bot.data.result.settings,
          pair: exchangeFormatPairs,
          id: `${bot.data.result._id}`,
          vars: bot.data.result.vars,
        },
        userId,
        !!bot.data.result.paperContext,
        false,
      )
    }

    return {
      status: StatusEnum.ok as const,
      reason: null,
      data: {
        removed,
        added,
        current: returnResult ? exchangeFormatPairs : pairsToSetInBot,
        previous,
      },
    }
  }

  @IdMute(mutex, (userId: string) => `${userId}checkBigAccount`)
  private async checkBigAccount(userId: string, action: 'add' | 'remove') {
    const user = await this.userDb.readData({ _id: userId })
    if (!user || !user.data?.result) {
      return
    }
    if (
      (action === 'add' && user.data.result.bigAccount) ||
      (action === 'remove' && !user.data.result.bigAccount)
    ) {
      return
    }
    const paperBots = await this.botDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $eq: true },
    })
    const paperDcaBots = await this.dcaBotDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $eq: true },
    })
    const paperComboBots = await this.comboBotDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $eq: true },
    })
    const bots = await this.botDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $ne: true },
    })
    const dcaBots = await this.dcaBotDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $ne: true },
    })
    const comboBots = await this.comboBotDb.countData({
      userId,
      isDeleted: { $ne: true },
      paperContext: { $ne: true },
    })
    const bigAccount =
      (bots.data?.result ?? 0) +
        (dcaBots.data?.result ?? 0) +
        (comboBots.data?.result ?? 0) >
        500 ||
      (paperBots.data?.result ?? 0) +
        (paperDcaBots.data?.result ?? 0) +
        (paperComboBots.data?.result ?? 0) >
        500
    await this.userDb.updateData({ _id: userId }, { $set: { bigAccount } })
  }

  public async createBot(
    userId: string,
    _settings: BotSettings & {
      baseAsset?: string
      quoteAsset?: string
      exchange: ExchangeEnum
      exchangeUUID: string
      vars?: BotVars
    },
    paperContext: boolean,
  ) {
    const { vars, ...rawSettings } = _settings
    const settings = applyGridFuturesConstraints(rawSettings)
    if (
      (isPaper(settings.exchange) && !paperContext) ||
      (!isPaper(settings.exchange) && paperContext)
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Please switch to the correct context to create a bot',
        data: null,
      }
    }
    const user = await this.userDb.readData({ _id: userId })
    if (user.status === StatusEnum.notok) {
      return user
    }
    if (!user.data.result) {
      return this.entityNotFound('User')
    }
    // Resolve base/quote from the authoritative pairs collection rather than trusting the
    // client-supplied strings. Some clients flatten dash-delimited symbols (e.g. Coinbase
    // "SOL-EUR") into a malformed baseAsset "SOLEUR" with an empty quoteAsset, which then
    // fails order validation ("quoteAsset is required") and drops grid orders. The pair doc
    // is the source of truth (mirrors prepareDCABot/prepareComboBot).
    const pairDoc = await this.pairsDb.readData(
      { pair: settings.pair, exchange: settings.exchange },
      { 'baseAsset.name': 1, 'quoteAsset.name': 1 },
    )
    const resolvedPair = pairDoc.data?.result
    const baseAsset = resolvedPair?.baseAsset?.name || settings.baseAsset || ''
    const quoteAsset =
      resolvedPair?.quoteAsset?.name || settings.quoteAsset || ''
    const saveBotRequest = await this.botDb.createData({
      userId,
      status: BotStatusEnum.closed,
      settings: { ...settings, updatedBudget: true, newBalance: true },
      exchange: settings.exchange,
      exchangeUUID: settings.exchangeUUID,
      initialPrice: 0,
      symbol: {
        symbol: settings.pair,
        baseAsset,
        quoteAsset,
      },
      levels: {
        active: {
          buy: 0,
          sell: 0,
        },
        all: {
          buy: 0,
          sell: 0,
        },
      },
      transactionsCount: {
        buy: 0,
        sell: 0,
      },
      workingShift: [],
      workingTimeNumber: 0,
      initialBalances: {
        base: 0,
        quote: 0,
      },
      currentBalances: {
        base: 0,
        quote: 0,
      },
      usdRate: 0,
      lastPrice: 0,
      lastUsdRate: 0,
      assets: {
        used: {
          base: 0,
          quote: 0,
        },
        required: {
          base: 0,
          quote: 0,
        },
      },
      profit: {
        total: 0,
        totalUsd: 0,
        freeTotal: 0,
        freeTotalUsd: 0,
        pureBase: 0,
        pureQuote: 0,
      },
      profitToday: {
        totalToday: 0,
        totalTodayUsd: 0,
        start: 0,
        end: 0,
      },
      uuid: v4(),
      paperContext,
      realInitialBalances: { base: 0, quote: 0 },
      position: {
        qty: 0,
        price: 0,
        side: PositionSide.LONG,
      },
      stats: {
        drawdownPercent: 0,
        runUpPercent: 0,
        timeInProfit: 0,
        timeInLoss: 0,
        trackTime: 0,
        timeCountStart: Date.now(),
        unrealizedProfit: 0,
        usage: 0,
        maxUsage: 0,
      },
      vars,
    })
    if (saveBotRequest.status === StatusEnum.ok) {
      await updateRelatedBotsInVar(vars?.list ?? [])
      this.checkBigAccount(userId, 'add')
      return {
        status: 'OK',
        reason: null,
        data: {
          botId: saveBotRequest.data._id,
        },
      }
    }
    return saveBotRequest
  }
  public async processInternalApiCall({ method, params }: BotServicePayload) {
    if (!method) {
      return
    }
    this.handleDebug(
      `${loggerPrefix} Bot host | Internal api call ${method} ${
        Array.isArray(params)
          ? params[params.length - 1] === 'ignore'
            ? ''
            : JSON.stringify(params)
          : 'no params'
      }`,
    )
    //@ts-ignore
    const fn = this[method]
    if (typeof fn === 'function') {
      return await fn.call(this, ...params)
    }
  }
  private getServiceType() {
    return bosServiceType === BotType.combo
      ? BotType.combo
      : bosServiceType === BotType.dca
        ? BotType.dca
        : bosServiceType === BotType.hedgeCombo
          ? BotType.hedgeCombo
          : bosServiceType === BotType.hedgeDca
            ? BotType.hedgeDca
            : BotType.grid
  }
  private getRabbitQueueName(type?: BotType) {
    const serviceType = type || this.getServiceType()
    return serviceType === BotType.combo
      ? BotServiceQueues.comboQueue
      : serviceType === BotType.grid
        ? BotServiceQueues.gridQueue
        : serviceType === BotType.hedgeCombo
          ? BotServiceQueues.hedgeComboQueue
          : serviceType === BotType.hedgeDca
            ? BotServiceQueues.hedgeDcaQueue
            : BotServiceQueues.dcaQueue
  }
  protected async callExternalBotService<R>(
    type: BotType | 'all' | 'allWithHedge',
    method: string,
    ignoreParamsInLog = false,
    ...payload: unknown[]
  ): Promise<R | null> {
    this.handleDebug(
      `${loggerPrefix} Bot client | Api call ${method} ${
        ignoreParamsInLog
          ? ''
          : Array.isArray(payload)
            ? JSON.stringify(payload)
            : 'no params'
      }`,
    )
    if (type === 'all') {
      await Promise.all(
        [BotType.combo, BotType.dca, BotType.grid].map(async (t) => {
          await this.rabbit.sendWithCallback<BotServicePayload, R>(
            this.getRabbitQueueName(t),
            { method, params: payload },
            botServiceRpcTimeoutMs,
          )
        }),
      )
      return [] as unknown as R
    }
    if (type === 'allWithHedge') {
      await Promise.all(
        [
          BotType.combo,
          BotType.dca,
          BotType.grid,
          BotType.hedgeCombo,
          BotType.hedgeDca,
        ].map(async (t) => {
          await this.rabbit.sendWithCallback<BotServicePayload, R>(
            this.getRabbitQueueName(t),
            { method, params: payload },
            botServiceRpcTimeoutMs,
          )
        }),
      )
      return [] as unknown as R
    }
    const result = await this.rabbit.sendWithCallback<BotServicePayload, R>(
      this.getRabbitQueueName(type),
      { method, params: payload },
      botServiceRpcTimeoutMs,
    )
    if (!result) {
      throw new Error(notAvailable)
    }
    return result.response
  }

  public async createDCABot(
    userId: string,
    _settings: CreateDCABotInput,
    paperContext: boolean,
    cb?: () => Promise<unknown>,
  ) {
    const preparedBot = await this.prepareDCABot(
      userId,
      _settings,
      paperContext,
    )
    if (preparedBot.status === StatusEnum.notok) {
      return preparedBot
    }
    if (!preparedBot.data) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    const saveBotRequest = await this.dcaBotDb.createData(preparedBot.data)
    if (saveBotRequest.status === StatusEnum.ok) {
      if (cb) {
        await cb()
      }
      await updateRelatedBotsInVar(saveBotRequest?.data?.vars?.list ?? [])
      this.checkBigAccount(userId, 'add')
      const id = saveBotRequest.data._id.toString()
      if (preparedBot.data.settings.type === DCATypeEnum.terminal) {
        if (this.useBots) {
          await this.createNewBot(
            id,
            BotType.dca,
            userId,
            preparedBot.data.settings.exchange,
            saveBotRequest.data.uuid,
            [id, preparedBot.data.settings.exchange],
            (worker) => {
              worker.postMessage({
                do: 'method',
                botType: BotType.dca,
                botId: id,
                method: 'setStatus',
                args: [id, BotStatusEnum.open],
              })
            },
            paperContext,
            saveBotRequest.data.settings.type ?? DCATypeEnum.regular,
          )
        } else {
          this.callExternalBotService(
            BotType.dca,
            'changeStatus',
            false,
            userId,
            {
              status: BotStatusEnum.open,
              id,
              type: BotType.dca,
            },
            paperContext,
          )
        }
      }
      return {
        status: StatusEnum.ok as const,
        reason: null,
        data: {
          ...saveBotRequest.data,
          dealsInBot: { all: 0, active: 0 },
          deals: [],
          orders: [],
        },
      }
    }
    return saveBotRequest
  }

  protected async prepareDCABot(
    userId: string,
    _settings: DCABotSettings & {
      baseAsset?: string[]
      quoteAsset?: string[]
      exchange: ExchangeEnum
      exchangeUUID: string
      uuid?: string
      vars?: BotVars | null
    },
    paperContext: boolean,
  ) {
    const { vars, ...rest } = _settings
    // Same invariant as changeDCABot: a bot that scales DCA on atr/adr needs
    // the startDca indicator that prices its ladder, or it can never open a
    // deal. Seed it at creation so no client can produce one without. Bug #463.
    const settings = ensureDynamicArIndicator(rest)
    if (
      (isPaper(settings.exchange) && !paperContext) ||
      (!isPaper(settings.exchange) && paperContext)
    ) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Please switch to the correct context to create a bot',
        data: null,
      }
    }
    const user = await this.userDb.readData({ _id: userId })
    if (user.status === StatusEnum.notok) {
      return user
    }
    if (!user.data.result) {
      return this.entityNotFound('User')
    }
    const type = settings.type || DCATypeEnum.regular
    const symbols: Map<string, Symbols> = new Map()
    const assets: { used: MultiAssets; required: MultiAssets } = {
      used: { base: new Map(), quote: new Map() },
      required: { base: new Map(), quote: new Map() },
    }
    const initialBalances: MultiAssets = { base: new Map(), quote: new Map() }
    const currentBalances: MultiAssets = { base: new Map(), quote: new Map() }
    const usdRate: Map<string, number> = new Map()
    const lastUsdRate: Map<string, number> = new Map()
    const lastPrice: Map<string, number> = new Map()
    const pairs = await this.pairsDb.readData(
      { pair: { $in: settings.pair }, exchange: settings.exchange },
      {},
      {},
      true,
    )
    settings.pair.forEach((p) => {
      const base =
        pairs.data?.result.find((_p) => _p.pair === p)?.baseAsset.name ||
        settings.baseAsset?.find((a) => p.startsWith(a))
      const quote =
        pairs.data?.result.find((_p) => _p.pair === p)?.quoteAsset.name ||
        settings.quoteAsset?.find((a) => p.endsWith(a))
      if (base) {
        assets.used.base.set(base, 0)
        assets.required.base.set(base, 0)
        initialBalances.base.set(base, 0)
        currentBalances.base.set(base, 0)
      }
      if (quote) {
        assets.used.quote.set(quote, 0)
        assets.required.quote.set(quote, 0)
        initialBalances.quote.set(quote, 0)
        currentBalances.quote.set(quote, 0)
      }
      symbols.set(p, {
        symbol: p,
        baseAsset: base ?? '',
        quoteAsset: quote ?? '',
      })
      usdRate.set(p, 0)
      lastUsdRate.set(p, 0)
      lastPrice.set(p, 0)
    })

    return {
      status: StatusEnum.ok as const,
      reason: null,
      data: {
        userId,
        uuid: settings.uuid ?? v4(),
        status: BotStatusEnum.closed,
        settings: { ...settings, type },
        exchange: settings.exchange,
        exchangeUUID: settings.exchangeUUID,
        symbol: symbols,
        workingShift: [],
        workingTimeNumber: 0,
        initialBalances,
        currentBalances,
        usdRate,
        lastPrice,
        lastUsdRate,
        assets,
        profit: {
          total: 0,
          totalUsd: 0,
          freeTotal: 0,
          freeTotalUsd: 0,
          pureBase: 0,
          pureQuote: 0,
        },
        profitToday: {
          totalToday: 0,
          totalTodayUsd: 0,
          start: 0,
          end: 0,
        },
        deals: {
          active: 0,
          all: 0,
        },
        usage: {
          current: {
            base: 0,
            quote: 0,
          },
          max: {
            base: 0,
            quote: 0,
          },
          maxUsd: 0,
          currentUsd: 0,
          relative: 0,
        },
        paperContext,
        flags: [BotFlags.newBaseProfit],
        vars,
      },
    }
  }

  protected async prepareComboBot(
    userId: string,
    _settings: CreateComboBotInput,
    paperContext: boolean,
  ) {
    // Combo settings extend DCA settings and comboHelper extends dcaHelper, so
    // the atr/adr ladder — and its silent-no-deal failure — applies here too.
    const { vars, ...rest } = _settings
    const settings = ensureDynamicArIndicator(rest)
    if (
      (isPaper(settings.exchange) && !paperContext) ||
      (!isPaper(settings.exchange) && paperContext)
    ) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Please switch to the correct context to create a bot',
        data: null,
      }
    }
    const user = await this.userDb.readData({ _id: userId })
    if (user.status === StatusEnum.notok) {
      return user
    }
    if (!user.data.result) {
      return this.entityNotFound('User')
    }
    const type = settings.type || DCATypeEnum.regular
    const symbols: Map<string, Symbols> = new Map()
    const assets: { used: MultiAssets; required: MultiAssets } = {
      used: { base: new Map(), quote: new Map() },
      required: { base: new Map(), quote: new Map() },
    }
    const initialBalances: MultiAssets = { base: new Map(), quote: new Map() }
    const currentBalances: MultiAssets = { base: new Map(), quote: new Map() }
    const usdRate: Map<string, number> = new Map()
    const lastUsdRate: Map<string, number> = new Map()
    const lastPrice: Map<string, number> = new Map()
    const pairs = await this.pairsDb.readData(
      { pair: { $in: settings.pair }, exchange: settings.exchange },
      {},
      {},
      true,
    )
    settings.pair.forEach((p) => {
      const base =
        pairs.data?.result.find((_p) => _p.pair === p)?.baseAsset.name ||
        settings.baseAsset?.find((a) => p.startsWith(a))
      const quote =
        pairs.data?.result.find((_p) => _p.pair === p)?.quoteAsset.name ||
        settings.quoteAsset?.find((a) => p.endsWith(a))
      if (base) {
        assets.used.base.set(base, 0)
        assets.required.base.set(base, 0)
        initialBalances.base.set(base, 0)
        currentBalances.base.set(base, 0)
      }
      if (quote) {
        assets.used.quote.set(quote, 0)
        assets.required.quote.set(quote, 0)
        initialBalances.quote.set(quote, 0)
        currentBalances.quote.set(quote, 0)
      }
      symbols.set(p, {
        symbol: p,
        baseAsset: base ?? '',
        quoteAsset: quote ?? '',
      })
      usdRate.set(p, 0)
      lastUsdRate.set(p, 0)
      lastPrice.set(p, 0)
    })
    const flags: string[] = [BotFlags.newMinTp]
    if (settings.exchange === ExchangeEnum.kucoin) {
      flags.push(BotFlags.kucoinNewFee)
    }
    return {
      status: StatusEnum.ok as const,
      reason: null,
      data: {
        userId,
        uuid: v4(),
        status: BotStatusEnum.closed,
        settings: { ...settings, type, newBalance: true },
        exchange: settings.exchange,
        exchangeUUID: settings.exchangeUUID,
        symbol: symbols,
        workingShift: [],
        workingTimeNumber: 0,
        initialBalances,
        currentBalances,
        usdRate,
        lastPrice,
        lastUsdRate,
        assets,
        profit: {
          total: 0,
          totalUsd: 0,
          freeTotal: 0,
          freeTotalUsd: 0,
          pureBase: 0,
          pureQuote: 0,
        },
        profitToday: {
          totalToday: 0,
          totalTodayUsd: 0,
          start: 0,
          end: 0,
        },
        deals: {
          active: 0,
          all: 0,
        },
        usage: {
          current: {
            base: 0,
            quote: 0,
          },
          max: {
            base: 0,
            quote: 0,
          },
          currentUsd: 0,
          maxUsd: 0,
          relative: 0,
        },
        paperContext,
        dealsStatsForBot: [],
        useAssets: true,
        flags,
        vars,
      },
    }
  }

  public removeNullableValuesFromSettings(
    settings: ComboBotSettings,
  ): ComboBotSettings
  public removeNullableValuesFromSettings(
    settings: DCABotSettings,
  ): DCABotSettings
  public removeNullableValuesFromSettings(
    settings: DCABotSettings | ComboBotSettings,
  ): DCABotSettings | ComboBotSettings {
    for (const key of Object.keys(settings)) {
      const k = key as keyof typeof settings
      if (
        (settings[k] === undefined || settings[k] === null) &&
        k !== 'indicators' &&
        k !== 'dcaCustom' &&
        k !== 'multiTp' &&
        k !== 'multiSl'
      ) {
        delete settings[k]
      }
      if (k === 'indicators') {
        settings[k] = settings[k].map((i: SettingsIndicators) => {
          for (const iKey of Object.keys(i)) {
            const ik = iKey as keyof SettingsIndicators
            if (i[ik] === undefined || i[ik] === null) {
              delete i[ik]
            }
          }
          return i
        })
      }
      if (k === 'dcaCustom') {
        settings[k] = (settings[k] ?? []).map((i: DCACustom) => {
          for (const iKey of Object.keys(i)) {
            const ik = iKey as keyof DCACustom
            if (i[ik] === undefined || i[ik] === null) {
              delete i[ik]
            }
          }
          return i
        })
      }
      if (k === 'multiTp' || k === 'multiSl') {
        settings[k] = (settings[k] ?? []).map((i: MultiTP) => {
          for (const iKey of Object.keys(i)) {
            const ik = iKey as keyof MultiTP
            if (i[ik] === undefined || i[ik] === null) {
              delete i[ik]
            }
          }
          return i
        })
      }
    }
    return settings
  }

  public async createComboBot(
    userId: string,
    settings: CreateComboBotInput,
    paperContext: boolean,
  ) {
    const preparedBot = await this.prepareComboBot(
      userId,
      settings,
      paperContext,
    )
    if (preparedBot.status === StatusEnum.notok) {
      return preparedBot
    }
    if (!preparedBot.data) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    const saveBotRequest = await this.comboBotDb.createData(preparedBot.data)
    if (saveBotRequest.status === StatusEnum.ok) {
      await updateRelatedBotsInVar(saveBotRequest?.data?.vars?.list ?? [])

      this.checkBigAccount(userId, 'add')
      return {
        status: StatusEnum.ok as const,
        reason: null,
        data: {
          ...saveBotRequest.data,
          dealsInBot: { all: 0, active: 0 },
          deals: [],
          orders: [],
        },
      }
    }
    return saveBotRequest
  }
  public async createHedgeComboBot(
    userId: string,
    settings: {
      long: CreateComboBotInput
      short: CreateComboBotInput
      sharedSettings?: HedgeBotSettings
    },
    paperContext: boolean,
  ) {
    const preparedLongBot = await this.prepareComboBot(
      userId,
      settings.long,
      paperContext,
    )
    if (preparedLongBot.status === StatusEnum.notok) {
      return preparedLongBot
    }
    if (!preparedLongBot.data) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    const preparedShortBot = await this.prepareComboBot(
      userId,
      settings.short,
      paperContext,
    )
    if (preparedShortBot.status === StatusEnum.notok) {
      return preparedShortBot
    }
    if (!preparedShortBot.data) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    if (settings.sharedSettings?.useTp) {
      preparedLongBot.data.flags.push(BotFlags.externalTp)
      preparedShortBot.data.flags.push(BotFlags.externalTp)
    }
    if (settings.sharedSettings?.useSl) {
      preparedLongBot.data.flags.push(BotFlags.externalSl)
      preparedShortBot.data.flags.push(BotFlags.externalSl)
    }
    const saveLongBotRequest = await this.comboBotDb.createData(
      preparedLongBot.data,
    )
    if (saveLongBotRequest.status === StatusEnum.ok) {
      const saveShortBotRequest = await this.comboBotDb.createData(
        preparedShortBot.data,
      )
      if (saveShortBotRequest.status === StatusEnum.ok) {
        const saveHedgeBotResult = await hedgeComboBotDb.createData({
          sharedSettings: settings.sharedSettings,
          symbol: combineMaps(
            preparedLongBot.data.symbol,
            preparedShortBot.data.symbol,
          ),
          bots: [saveLongBotRequest.data._id, saveShortBotRequest.data._id],
          userId,
          uuid: v4(),
          status: BotStatusEnum.closed,
          workingShift: [],
          initialBalances: {
            long: preparedLongBot.data.initialBalances,
            short: preparedShortBot.data.initialBalances,
          },
          currentBalances: {
            long: preparedLongBot.data.currentBalances,
            short: preparedShortBot.data.currentBalances,
          },
          assets: {
            long: preparedLongBot.data.assets,
            short: preparedShortBot.data.assets,
          },
          profit: {
            total: 0,
            totalUsd: 0,
            freeTotal: 0,
            freeTotalUsd: 0,
            pureBase: 0,
            pureQuote: 0,
          },
          paperContext,
          flags: [
            ...new Set([
              ...preparedLongBot.data.flags,
              ...preparedShortBot.data.flags,
            ]),
          ],
        })
        if (saveHedgeBotResult.status === StatusEnum.notok) {
          await this.comboBotDb.deleteData({
            _id: `${saveLongBotRequest.data._id}`,
          })
          await this.comboBotDb.deleteData({
            _id: `${saveShortBotRequest.data._id}`,
          })
          return saveHedgeBotResult
        }
        await this.comboBotDb.updateManyData(
          {
            _id: {
              $in: [saveLongBotRequest.data._id, saveShortBotRequest.data._id],
            },
          },
          { $set: { parentBotId: `${saveHedgeBotResult.data._id}` } },
        )
        this.checkBigAccount(userId, 'add')
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            ...saveHedgeBotResult.data,
            dealsInBot: { all: 0, active: 0 },
            deals: [],
            orders: [],
          },
        }
      }
      await this.comboBotDb.deleteData({
        _id: `${saveLongBotRequest.data._id}`,
      })
      return saveShortBotRequest
    }
    return saveLongBotRequest
  }
  public async createHedgeDcaBot(
    userId: string,
    settings: {
      long: CreateComboBotInput
      short: CreateComboBotInput
      sharedSettings?: HedgeBotSettings
    },
    paperContext: boolean,
  ) {
    const preparedLongBot = await this.prepareDCABot(
      userId,
      settings.long,
      paperContext,
    )
    if (preparedLongBot.status === StatusEnum.notok) {
      return preparedLongBot
    }
    if (!preparedLongBot.data) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    const preparedShortBot = await this.prepareDCABot(
      userId,
      settings.short,
      paperContext,
    )
    if (preparedShortBot.status === StatusEnum.notok) {
      return preparedShortBot
    }
    if (!preparedShortBot.data) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot create bot',
        data: null,
      }
    }
    if (settings.sharedSettings?.useTp) {
      preparedLongBot.data.flags.push(BotFlags.externalTp)
      preparedShortBot.data.flags.push(BotFlags.externalTp)
    }
    if (settings.sharedSettings?.useSl) {
      preparedLongBot.data.flags.push(BotFlags.externalSl)
      preparedShortBot.data.flags.push(BotFlags.externalSl)
    }
    const saveLongBotRequest = await this.dcaBotDb.createData(
      preparedLongBot.data,
    )
    if (saveLongBotRequest.status === StatusEnum.ok) {
      const saveShortBotRequest = await this.dcaBotDb.createData(
        preparedShortBot.data,
      )
      if (saveShortBotRequest.status === StatusEnum.ok) {
        const saveHedgeBotResult = await hedgeDCABotDb.createData({
          sharedSettings: settings.sharedSettings,
          symbol: combineMaps(
            preparedLongBot.data.symbol,
            preparedShortBot.data.symbol,
          ),
          bots: [saveLongBotRequest.data._id, saveShortBotRequest.data._id],
          userId,
          uuid: v4(),
          status: BotStatusEnum.closed,
          workingShift: [],
          initialBalances: {
            long: preparedLongBot.data.initialBalances,
            short: preparedShortBot.data.initialBalances,
          },
          currentBalances: {
            long: preparedLongBot.data.currentBalances,
            short: preparedShortBot.data.currentBalances,
          },
          assets: {
            long: preparedLongBot.data.assets,
            short: preparedShortBot.data.assets,
          },
          profit: {
            total: 0,
            totalUsd: 0,
            freeTotal: 0,
            freeTotalUsd: 0,
            pureBase: 0,
            pureQuote: 0,
          },
          paperContext,
          flags: [
            ...new Set([
              ...preparedLongBot.data.flags,
              ...preparedShortBot.data.flags,
            ]),
          ],
        })
        if (saveHedgeBotResult.status === StatusEnum.notok) {
          await this.dcaBotDb.deleteData({
            _id: `${saveLongBotRequest.data._id}`,
          })
          await this.dcaBotDb.deleteData({
            _id: `${saveShortBotRequest.data._id}`,
          })
          return saveHedgeBotResult
        }
        await this.dcaBotDb.updateManyData(
          {
            _id: {
              $in: [saveLongBotRequest.data._id, saveShortBotRequest.data._id],
            },
          },
          { $set: { parentBotId: `${saveHedgeBotResult.data._id}` } },
        )
        this.checkBigAccount(userId, 'add')
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            ...saveHedgeBotResult.data,
            dealsInBot: { all: 0, active: 0 },
            deals: [],
            orders: [],
          },
        }
      }
      await this.dcaBotDb.deleteData({
        _id: `${saveLongBotRequest.data._id}`,
      })
      return saveShortBotRequest
    }
    return saveLongBotRequest
  }
  private botSettingsKeyToPropertyName(key: keyof BotSchema['settings']) {
    switch (key) {
      case 'budget':
        return 'Budget'
      case 'futuresStrategy':
      case 'strategy':
        return 'Strategy'
      case 'gridStep':
        return 'Grid step'
      case 'gridType':
        return 'Grid type'
      case 'levels':
        return 'Levels'
      case 'leverage':
        return 'Leverage'
      case 'lowPrice':
        return 'Low price'
      case 'marginType':
        return 'Margin type'
      case 'name':
        return 'Name'
      case 'orderFixedIn':
        return 'Order fixed in'
      case 'ordersInAdvance':
        return 'Smart orders'
      case 'pair':
        return 'Pair'
      case 'profitCurrency':
        return 'Profit currency'
      case 'sellDisplacement':
        return 'Sell displacement'
      case 'sl':
        return 'Use stop loss'
      case 'slAction':
        return 'Stop loss action'
      case 'slCondition':
        return 'Stop loss condition'
      case 'slLowPrice':
        return 'Stop loss price'
      case 'slPerc':
        return 'Stop loss percent'
      case 'startPrice':
        return 'Start price'
      case 'topPrice':
        return 'Top price'
      case 'tpPerc':
        return 'Take profit percent'
      case 'tpSl':
        return 'Use take profit'
      case 'tpSlAction':
        return 'Take profit action'
      case 'tpSlCondition':
        return 'Take profit condition'
      case 'tpTopPrice':
        return 'Take profit price'
      case 'useOrderInAdvance':
        return 'Use smart orders'
      case 'useStartPrice':
        return 'Use start price'
      default:
        return key
    }
  }
  private async setInitialPrice(
    userId: string,
    id: string,
    initialPrice: number,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService(
        BotType.grid,
        'setInitialPrice',
        false,
        userId,
        id,
        initialPrice,
      )
    }
    const find = this.bots.find((b) => b.id === id && b.userId === userId)
    if (find) {
      this.getWorkerById(find.worker)?.postMessage({
        do: 'method',
        botType: BotType.grid,
        botId: id,
        method: 'setInitialPrice',
        args: [initialPrice],
      })
    }
  }

  public async changeBot(
    input: BotSettings & {
      id: string
      initialPrice?: number
      buyType?: BuyTypeEnum
      buyCount?: string
      buyAmount?: number
      vars: BotVars
    },
    userId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        BotType.grid,
        'changeBot',
        false,
        input,
        userId,
        paperContext,
      )
    }
    const {
      id,
      initialPrice,
      buyType,
      buyCount,
      buyAmount,
      vars,
      ...settings
    } = input
    delete input.buyType
    delete input.buyCount
    delete input.buyAmount
    const bot = await this.botDb.readData({
      _id: id,
      userId,
      isDeleted: { $ne: true },
    })
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (bot.status === StatusEnum.ok && bot.data && !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const oldSettings = bot.data.result
    const set: { $set: Partial<BotSchema> } = {
      $set: { vars },
    }
    const settingKeys = Object.keys(settings)
    if (settingKeys.length > 0) {
      set.$set.settings = applyGridFuturesConstraints({
        ...oldSettings.settings,
        ...settings,
      })
    }
    const ignoreChanges = [
      'coinm',
      'futures',
      'newProfit',
      'newBalance',
      'prioritize',
      'updatedBudget',
    ]
    let changedString = ''
    Object.entries(settings).map(([key, value]) => {
      if (!ignoreChanges.includes(key) && key in oldSettings.settings) {
        //@ts-ignore
        const oldValue = oldSettings.settings[key]
        if (`${oldValue}` !== `${value}`)
          changedString = `${changedString}${
            changedString.length ? ', ' : ''
          }${this.botSettingsKeyToPropertyName(
            key as keyof BotSchema['settings'],
          )}: ${oldValue} -> ${value}`
      }
    })
    if (initialPrice) {
      set['$set'] = {
        ...set['$set'],
        initialPrice,
        initialPriceFrom:
          initialPrice !== oldSettings.initialPrice
            ? initialPrice === oldSettings.initialPriceStart
              ? oldSettings.initialPriceStartFrom
              : InitialPriceFromEnum.user
            : oldSettings.initialPriceFrom,
      }
      if (initialPrice !== oldSettings.initialPrice) {
        changedString = `${changedString}${
          changedString.length ? ', ' : ''
        }Initial Price: ${oldSettings.initialPrice} -> ${initialPrice}`

        const initialValue =
          oldSettings.initialPrice * oldSettings.initialBalances.base +
          oldSettings.initialBalances.quote
        let base = oldSettings.currentBalances.base
        let quote = oldSettings.currentBalances.quote
        if (oldSettings.settings.profitCurrency === 'base') {
          base += oldSettings.profit.freeTotal || oldSettings.profit.total
        }
        if (oldSettings.settings.profitCurrency === 'quote') {
          quote += oldSettings.profit.freeTotal || oldSettings.profit.total
        }
        let avgPrice = (initialValue - quote) / base
        if (
          avgPrice === Infinity ||
          avgPrice === -Infinity ||
          isNaN(avgPrice)
        ) {
          avgPrice = 0
        }
        set['$set'].avgPrice = avgPrice
      }
    }
    if (
      ((settings.gridStep &&
        `${oldSettings.settings.gridStep}` !== `${settings.gridStep}`) ||
        (settings.levels &&
          `${oldSettings.settings.levels}` !== `${settings.levels}`) ||
        (settings.topPrice &&
          `${oldSettings.settings.topPrice}` !== `${settings.topPrice}`) ||
        (settings.lowPrice &&
          `${oldSettings.settings.lowPrice}` !== `${settings.lowPrice}`) ||
        (settings.gridStep &&
          `${oldSettings.settings.gridStep}` !== `${settings.gridStep}`) ||
        (settings.sellDisplacement &&
          `${oldSettings.settings.sellDisplacement}` !==
            `${settings.sellDisplacement}`) ||
        (settings.gridType &&
          `${oldSettings.settings.gridType}` !== `${settings.gridType}`)) &&
      `${initialPrice}` === `${oldSettings.initialPrice}` &&
      ((buyType && buyType !== BuyTypeEnum.proceed) ||
        oldSettings.initialPriceFrom === InitialPriceFromEnum.swap)
    ) {
      set['$set'] = {
        ...set['$set'],
        //@ts-ignore
        initialPrice: null,
        //@ts-ignore
        initialPriceFrom: null,
        //@ts-ignore
        initialPriceStart: null,
        //@ts-ignore
        initialPriceStartFrom: null,
      }
    }
    const saveBotRequest = await this.botDb.updateData(
      { _id: id, userId },
      set,
      true,
      true,
    )
    if (saveBotRequest.status === StatusEnum.ok) {
      if (changedString.length) {
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: BotType.grid,
          event: BOT_CHANGE_EVENT,
          description: changedString,
          paperContext,
          metadata: JSON.stringify(
            getObjectsDiff(
              { ...oldSettings.settings },
              { ...oldSettings.settings, ...settings },
            ),
          ),
        })
      }
      const profitChanged =
        settings.profitCurrency &&
        oldSettings.settings.profitCurrency !== settings.profitCurrency
      const find = this.bots.find((b) => b.id === id && b.userId === userId)
      if (
        settingKeys.length > 0 &&
        !(settingKeys.length === 1 && settingKeys[0] === 'name')
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(oldSettings.status)
        ) {
          if (find) {
            this.getWorkerById(find.worker)?.postMessage({
              do: 'method',
              botType: BotType.grid,
              botId: id,
              method: 'reloadBot',
              args: [id, buyType, buyCount, buyAmount, profitChanged],
            })
          }
        } else if (profitChanged) {
          const _ex = this.ec.chooseExchangeFactory(oldSettings.exchange)
          if (_ex) {
            const ex = _ex('', '')
            const price = await ex.latestPrice(oldSettings.symbol.symbol)
            if (price && price.status === StatusEnum.ok) {
              const profit =
                oldSettings.profit.total *
                (settings.profitCurrency === 'base'
                  ? 1 / price.data
                  : price.data)
              const freeProfit =
                oldSettings.profit.freeTotal *
                (settings.profitCurrency === 'base'
                  ? 1 / price.data
                  : price.data)
              await this.botDb.updateData(
                { _id: id, userId },
                {
                  $set: {
                    'profit.total': profit,
                    'profit.freeTotal': freeProfit,
                  },
                },
              )
            }
          }
        }
      }
      if (
        settingKeys.length > 0 &&
        settingKeys.length === 1 &&
        settingKeys[0] === 'name'
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(oldSettings.status)
        ) {
          if (find) {
            this.getWorkerById(find.worker)?.postMessage({
              do: 'method',
              botType: BotType.grid,
              botId: id,
              method: 'changeName',
              args: [settings.name],
            })
          }
        }
      }
      if (
        initialPrice &&
        initialPrice !== oldSettings.initialPrice &&
        initialPrice !== 0
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(oldSettings.status)
        ) {
          await this.setInitialPrice(userId, id, initialPrice)
        }
      }
      return await this.getBot(
        BotType.grid,
        userId,
        id,
        undefined,
        paperContext,
      )
    }
    return saveBotRequest
  }

  public async changeDCABot(
    input: Partial<DCABotSettings> & { id: string; vars?: BotVars | null },
    userId: string,
    paperContext: boolean,
    // Default OFF: a settings save must not touch the orders of deals that are
    // already running. Only callers that genuinely re-own a running deal's
    // TP/SL — the hedge wrapper flipping externalTp/externalSl — pass true.
    replaceOrders = false,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        BotType.dca,
        'changeDCABot',
        false,
        input,
        userId,
        paperContext,
        replaceOrders,
      )
    }
    const { id, vars, ...settings } = input
    const bot = await this.dcaBotDb.readData({
      _id: id,
      userId,
      isDeleted: { $ne: true },
    })

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (bot.status === StatusEnum.ok && bot.data && !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const oldSettings = [bot.data.result].flat()[0]
    const set: { $set: Partial<DCABotSchema> } = {
      $set: { vars },
    }

    const resetStats =
      oldSettings.settings.profitCurrency !== settings.profitCurrency &&
      settings.profitCurrency &&
      oldSettings.settings.profitCurrency
    const resetBaseAsset =
      (typeof settings.useDca !== 'undefined' &&
        oldSettings.settings.useDca !== settings.useDca) ||
      (typeof settings.orderSize !== 'undefined' &&
        oldSettings.settings.orderSize !== settings.orderSize) ||
      (typeof settings.baseOrderSize !== 'undefined' &&
        oldSettings.settings.baseOrderSize !== settings.baseOrderSize) ||
      (typeof settings.ordersCount !== 'undefined' &&
        oldSettings.settings.ordersCount !== settings.ordersCount) ||
      (typeof settings.volumeScale !== 'undefined' &&
        oldSettings.settings.volumeScale !== settings.volumeScale) ||
      (typeof settings.orderSizeType !== 'undefined' &&
        oldSettings.settings.orderSizeType !== settings.orderSizeType) ||
      (typeof settings.maxNumberOfOpenDeals !== 'undefined' &&
        oldSettings.settings.maxNumberOfOpenDeals !==
          settings.maxNumberOfOpenDeals)
    const settingKeys = Object.keys(settings)
    if (settingKeys.length > 0) {
      // Seed the ATR/ADR startDca indicator when the merged result scales on
      // atr/adr without one. A save that never touched the "Base scaling on"
      // field skips the dashboards' own seeding and would otherwise persist a
      // bot that can never open a deal. Bug #463.
      set.$set.settings = ensureDynamicArIndicator({
        ...oldSettings.settings,
        ...settings,
      })
    }
    if (settings.pair && !oldSettings.settings.useMulti) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot change pair for non-multi pairs bot',
        data: null,
      }
    }
    if (
      settings.pair &&
      oldSettings.settings.useMulti &&
      settings.pair.length === 0
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Need to specify at least one pair',
        data: null,
      }
    }
    if (settings.pair && oldSettings.settings.useMulti) {
      const pairs = await this.pairsDb.readData(
        { pair: { $in: settings.pair } },
        {},
        {},
        true,
      )
      const symbolsMap: Map<
        string,
        { symbol: string; baseAsset: string; quoteAsset: string }
      > = new Map()
      if (pairs.status === StatusEnum.ok) {
        for (const p of pairs.data.result) {
          symbolsMap.set(p.pair, {
            symbol: p.pair,
            baseAsset: p.baseAsset.name,
            quoteAsset: p.quoteAsset.name,
          })
        }
        set.$set.symbol = symbolsMap
      }
    }

    // A bot-settings save applies to NEW deals only. Every deal that is
    // already running keeps the settings snapshot it opened with, and keeps
    // its resting orders untouched. We used to re-derive each open deal's
    // settings from the new bot settings here and then cancel + re-place the
    // whole order book; that re-targeted live TPs, cost every order its
    // exchange queue position, and left open deals with no TP/SL resting on
    // the exchange for the width of the cancel/re-place window — all for
    // saves (a Deal Start filter, say) that cannot affect an open deal at all.
    // A running deal is still editable individually via updateDealSettings.
    // Forum #5044.

    const saveBotRequest = await this.dcaBotDb.updateData(
      { _id: id, userId },
      set,
      true,
      true,
    )
    const find = this.dcaBots.find((b) => b.id === id && b.userId === userId)
    if (saveBotRequest.status === StatusEnum.ok) {
      await updateRelatedBotsInVar([
        ...new Set([...(vars?.list ?? []), ...(oldSettings.vars?.list ?? [])]),
      ])
      if (
        settingKeys.length > 0 &&
        !(settingKeys.length === 1 && settingKeys[0] === 'name')
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(oldSettings.status)
        ) {
          if (find) {
            this.getWorkerById(find.worker)?.postMessage({
              do: 'method',
              botType: BotType.dca,
              botId: id,
              method: 'reloadBot',
              // rebuildIndicators: the settings that define the indicator set
              // are exactly what just changed.
              args: [id, replaceOrders, true],
            })
          }
        }
      }
      if (
        settingKeys.length > 0 &&
        settingKeys.length === 1 &&
        settingKeys[0] === 'name'
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(oldSettings.status)
        ) {
          if (find) {
            this.getWorkerById(find.worker)?.postMessage({
              do: 'method',
              botType: BotType.dca,
              botId: id,
              method: 'changeName',
              args: [settings.name],
            })
          }
        }
      }
      this.botEventDb.createData({
        userId: saveBotRequest.data.userId,
        botId: saveBotRequest.data._id,
        botType: BotType.dca,
        event: BOT_CHANGE_EVENT,
        description: `DCA bot settings were changed ${getSettingsChangeDescription(
          { ...settings },
          { ...oldSettings.settings },
        )}`,
        metadata: JSON.stringify(
          getObjectsDiff(
            { ...oldSettings.settings },
            { ...oldSettings.settings, ...settings },
          ),
        ),
        paperContext,
      })
      if (resetStats || (resetBaseAsset && oldSettings.stats)) {
        await this.dcaBotDb
          .updateData(
            { _id: id },
            {
              $set: {
                stats: null,
                symbolStats: null,
                resetStatsAfter: +new Date(),
              },
            },
          )
          .then((res) => {
            if (res.status === StatusEnum.notok) {
              logger.error(
                `Bot ${id} Error while resetting dca stats`,
                res.reason,
              )
            }
          })
      }
      return await this.getBot(BotType.dca, userId, id, undefined, paperContext)
    }
    return saveBotRequest
  }

  public async changeComboBot(
    input: Partial<ComboBotSettings> & { id: string; vars?: BotVars | null },
    userId: string,
    paperContext: boolean,
    forceRestart = false,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        BotType.combo,
        'changeComboBot',
        false,
        input,
        userId,
        paperContext,
        forceRestart,
      )
    }
    const { id, vars, ...settings } = input
    const bot = await this.comboBotDb.readData({
      _id: id,
      userId,
      isDeleted: { $ne: true },
    })

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (bot.status === StatusEnum.ok && bot.data && !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const oldSettings = [bot.data.result].flat()[0]
    if (
      (settings.indicators ?? []).length === 0 &&
      oldSettings.settings.indicators.length === 0
    ) {
      delete settings.indicators
    }
    const resetStats =
      oldSettings.settings.profitCurrency !== settings.profitCurrency &&
      settings.profitCurrency &&
      oldSettings.settings.profitCurrency
    const resetBaseAsset =
      (typeof settings.useDca !== 'undefined' &&
        oldSettings.settings.useDca !== settings.useDca) ||
      (typeof settings.orderSize !== 'undefined' &&
        oldSettings.settings.orderSize !== settings.orderSize) ||
      (typeof settings.baseOrderSize !== 'undefined' &&
        oldSettings.settings.baseOrderSize !== settings.baseOrderSize) ||
      (typeof settings.ordersCount !== 'undefined' &&
        oldSettings.settings.ordersCount !== settings.ordersCount) ||
      (typeof settings.volumeScale !== 'undefined' &&
        oldSettings.settings.volumeScale !== settings.volumeScale) ||
      (typeof settings.orderSizeType !== 'undefined' &&
        oldSettings.settings.orderSizeType !== settings.orderSizeType) ||
      (typeof settings.maxNumberOfOpenDeals !== 'undefined' &&
        oldSettings.settings.maxNumberOfOpenDeals !==
          settings.maxNumberOfOpenDeals)
    const set: { $set: Partial<ComboBotSchema> } = {
      $set: { vars },
    }
    const settingKeys = Object.keys(settings)
    if (settingKeys.length > 0) {
      // See changeDCABot — combo inherits the same atr/adr ladder. Bug #463.
      set.$set.settings = ensureDynamicArIndicator({
        ...oldSettings.settings,
        ...settings,
      })
    }
    if (settings.pair && !oldSettings.settings.useMulti) {
      return {
        status: StatusEnum.notok,
        reason: 'Cannot change pair for non-multi pairs bot',
        data: null,
      }
    }
    if (
      settings.pair &&
      oldSettings.settings.useMulti &&
      settings.pair.length === 0
    ) {
      return {
        status: StatusEnum.notok,
        reason: 'Need to specify at least one pair',
        data: null,
      }
    }
    if (settings.pair && oldSettings.settings.useMulti) {
      const pairs = await this.pairsDb.readData(
        { pair: { $in: settings.pair } },
        {},
        {},
        true,
      )
      const symbolsMap: Map<
        string,
        { symbol: string; baseAsset: string; quoteAsset: string }
      > = new Map()
      if (pairs.status === StatusEnum.ok) {
        for (const p of pairs.data.result) {
          symbolsMap.set(p.pair, {
            symbol: p.pair,
            baseAsset: p.baseAsset.name,
            quoteAsset: p.quoteAsset.name,
          })
        }
        set.$set.symbol = symbolsMap
      }
    }

    // New deals only — a running combo deal keeps the settings snapshot it
    // opened with and keeps its resting orders. Same rule as changeDCABot.
    // Forum #5044.

    const saveBotRequest = await this.comboBotDb.updateData(
      { _id: id, userId },
      set,
      true,
      true,
    )
    if (saveBotRequest.status === StatusEnum.ok) {
      await updateRelatedBotsInVar([
        ...new Set([...(vars?.list ?? []), ...(oldSettings.vars?.list ?? [])]),
      ])
      const find = this.comboBots.find(
        (b) => b.id === id && b.userId === userId,
      )
      if (
        (settingKeys.length > 0 &&
          !(settingKeys.length === 1 && settingKeys[0] === 'name')) ||
        forceRestart
      ) {
        if (
          ['open', 'range', 'error', 'monitoring'].includes(
            oldSettings.status,
          ) ||
          forceRestart
        ) {
          // A TP/SL-only save used to route to setNewTp, which walks the open
          // deals and re-points their tpPerc/slPerc. That is the same
          // apply-to-running-deals behaviour as the full reload, just cheaper,
          // so it goes too: the worker soft-reloads to pick the new settings up
          // for the NEXT deal and every live deal keeps its own target.
          if (find) {
            this.getWorkerById(find.worker)?.postMessage({
              do: 'method',
              botType: BotType.combo,
              botId: id,
              method: 'reloadBot',
              args: [id, forceRestart, true],
            })
          } else {
            this.handleWarn(`Bot ${id} not found in changeComboBot`)
          }
        }
        if (
          settingKeys.length > 0 &&
          settingKeys.length === 1 &&
          settingKeys[0] === 'name'
        ) {
          if (
            ['open', 'range', 'error', 'monitoring'].includes(
              oldSettings.status,
            )
          ) {
            if (find) {
              this.getWorkerById(find.worker)?.postMessage({
                do: 'method',
                botType: BotType.combo,
                botId: id,
                method: 'changeName',
                args: [settings.name],
              })
            }
          }
        }
      }
      this.botEventDb.createData({
        userId: saveBotRequest.data.userId,
        botId: saveBotRequest.data._id,
        botType: BotType.combo,
        event: BOT_CHANGE_EVENT,
        description: `Combo bot settings were changed ${getSettingsChangeDescription(
          { ...settings },
          { ...oldSettings.settings },
        )}`,
        metadata: JSON.stringify(
          getObjectsDiff(
            { ...oldSettings.settings },
            { ...oldSettings.settings, ...settings },
          ),
        ),
        paperContext,
      })
      if (resetStats || (resetBaseAsset && oldSettings.stats)) {
        await this.comboBotDb
          .updateData(
            { _id: id },
            {
              $set: {
                stats: null,
                symbolStats: null,
                resetStatsAfter: +new Date(),
              },
            },
          )
          .then((res) => {
            if (res.status === StatusEnum.notok) {
              logger.error(
                `Bot ${id} Error while resetting combo stats`,
                res.reason,
              )
            }
          })
      }
      return await this.getBot(
        BotType.combo,
        userId,
        id,
        undefined,
        paperContext,
      )
    }
    return saveBotRequest
  }

  public async changeHedgeComboBot(
    input: {
      long: Partial<ComboBotSettings> & { id: string; vars?: BotVars | null }
      short: Partial<ComboBotSettings> & { id: string; vars?: BotVars | null }
      id: string
      sharedSettings?: HedgeBotSettings
    },
    userId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        BotType.hedgeCombo,
        'changeHedgeComboBot',
        false,
        input,
        userId,
        paperContext,
      )
    }
    const { id, long, short, sharedSettings } = input
    const bot = await hedgeComboBotDb.readData(
      {
        _id: id,
        userId,
        isDeleted: { $ne: true },
      },
      {},
      { populate: ['bots'] },
    )

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (bot.status === StatusEnum.ok && bot.data && !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const queries: Promise<unknown>[] = []

    bot.data.result.bots.forEach((b) => {
      if (sharedSettings?.useSl && !b.flags?.includes(BotFlags.externalSl)) {
        queries.push(
          this.comboBotDb.updateData(
            { _id: b._id },
            { $addToSet: { flags: BotFlags.externalSl } },
          ),
        )
      }
      if (sharedSettings?.useTp && !b.flags?.includes(BotFlags.externalTp)) {
        queries.push(
          this.comboBotDb.updateData(
            { _id: b._id },
            { $addToSet: { flags: BotFlags.externalTp } },
          ),
        )
      }
      if (!sharedSettings?.useSl && b.flags?.includes(BotFlags.externalSl)) {
        queries.push(
          this.comboBotDb.updateData(
            { _id: b._id },
            { $pull: { flags: BotFlags.externalSl } },
          ),
        )
      }
      if (!sharedSettings?.useTp && b.flags?.includes(BotFlags.externalTp)) {
        queries.push(
          this.comboBotDb.updateData(
            { _id: b._id },
            { $pull: { flags: BotFlags.externalTp } },
          ),
        )
      }
    })

    await Promise.all(queries)
    const diff = getObjectsDiff(
      bot.data.result.sharedSettings ?? {},
      sharedSettings ?? {},
    )
    const changed =
      !!Object.keys(diff?.added)?.length ||
      !!Object.keys(diff?.deleted)?.length ||
      !!Object.keys(diff?.updated)?.length
    if (changed) {
      await hedgeComboBotDb.updateData(
        { _id: bot.data.result._id },
        { $set: { sharedSettings } },
      )
      const find = this.hedgeComboBots.find(
        (b) => b.id === id && b.userId === userId,
      )
      if (find) {
        this.getWorkerById(find.worker)?.postMessage({
          do: 'method',
          botType: BotType.hedgeCombo,
          botId: id,
          method: 'reload',
          args: [id],
        })
      }
    }
    await Promise.all(
      bot.data.result.bots.map(
        async (b) =>
          await this.callExternalBotService(
            BotType.combo,
            'changeComboBot',
            false,
            b.settings.strategy === StrategyEnum.long ? long : short,
            userId,
            paperContext,
            changed,
          ),
      ),
    )

    return await this.getBot(
      BotType.hedgeCombo,
      userId,
      id,
      undefined,
      paperContext,
    )
  }

  public async changeHedgeDcaBot(
    input: {
      long: Partial<ComboBotSettings> & { id: string; vars?: BotVars | null }
      short: Partial<ComboBotSettings> & { id: string; vars?: BotVars | null }
      id: string
      sharedSettings?: HedgeBotSettings
    },
    userId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        BotType.hedgeDca,
        'changeHedgeDcaBot',
        false,
        input,
        userId,
        paperContext,
      )
    }
    const { id, long, short, sharedSettings } = input
    const bot = await hedgeDCABotDb.readData(
      {
        _id: id,
        userId,
        isDeleted: { $ne: true },
      },
      {},
      { populate: ['bots'] },
    )

    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (bot.status === StatusEnum.ok && bot.data && !bot.data.result) {
      return this.entityNotFound('Bot')
    }
    const queries: Promise<unknown>[] = []

    bot.data.result.bots.forEach((b) => {
      if (sharedSettings?.useSl && !b.flags?.includes(BotFlags.externalSl)) {
        queries.push(
          this.dcaBotDb.updateData(
            { _id: b._id },
            { $addToSet: { flags: BotFlags.externalSl } },
          ),
        )
      }
      if (sharedSettings?.useTp && !b.flags?.includes(BotFlags.externalTp)) {
        queries.push(
          this.dcaBotDb.updateData(
            { _id: b._id },
            { $addToSet: { flags: BotFlags.externalTp } },
          ),
        )
      }
      if (!sharedSettings?.useSl && b.flags?.includes(BotFlags.externalSl)) {
        queries.push(
          this.dcaBotDb.updateData(
            { _id: b._id },
            { $pull: { flags: BotFlags.externalSl } },
          ),
        )
      }
      if (!sharedSettings?.useTp && b.flags?.includes(BotFlags.externalTp)) {
        queries.push(
          this.dcaBotDb.updateData(
            { _id: b._id },
            { $pull: { flags: BotFlags.externalTp } },
          ),
        )
      }
    })

    await Promise.all(queries)
    const diff = getObjectsDiff(
      bot.data.result.sharedSettings ?? {},
      sharedSettings ?? {},
    )
    const changed =
      !!Object.keys(diff?.added)?.length ||
      !!Object.keys(diff?.deleted)?.length ||
      !!Object.keys(diff?.updated)?.length
    if (changed) {
      await hedgeDCABotDb.updateData(
        { _id: bot.data.result._id },
        { $set: { sharedSettings } },
      )
      const find = this.hedgeDcaBots.find(
        (b) => b.id === id && b.userId === userId,
      )
      if (find) {
        this.getWorkerById(find.worker)?.postMessage({
          do: 'method',
          botType: BotType.hedgeDca,
          botId: id,
          method: 'reload',
          args: [id],
        })
      }
    }
    await Promise.all(
      bot.data.result.bots.map(
        async (b) =>
          await this.callExternalBotService(
            BotType.dca,
            'changeDCABot',
            false,
            b.settings.strategy === StrategyEnum.long ? long : short,
            userId,
            paperContext,
            changed,
          ),
      ),
    )

    return await this.getBot(
      BotType.hedgeDca,
      userId,
      id,
      undefined,
      paperContext,
    )
  }

  @IdMute(
    mutex,
    (_userId: string, { id }: { id: string }) => `changeStatus${id}`,
  )
  public async changeStatus(
    userId: string,
    input: {
      status: BotStatusEnum
      id: string
      cancelPartiallyFilled?: boolean
      type?: BotType
      closeType?: CloseDCATypeEnum
      buyType?: BuyTypeEnum
      buyAmount?: number
      buyCount?: string
      closeGridType?: CloseGRIDTypeEnum
      hedgeConfig?: { [x in StrategyEnum]: ActionsEnum }
    },
    paperContext: boolean,
    restart = false,
    ignoreStats = false,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<typeof this.getBot>>(
        input.type ?? BotType.grid,
        'changeStatus',
        false,
        userId,
        input,
        paperContext,
        restart,
        ignoreStats,
      )
    }
    const {
      id,
      status,
      buyCount,
      buyType,
      buyAmount,
      cancelPartiallyFilled,
      closeType,
      closeGridType,
    } = input
    let { type } = input
    if (!type) {
      type = BotType.grid
    }
    if (status === 'open') {
      if (type === BotType.grid) {
        const findBot = this.bots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (findBot) {
          this.getWorkerById(findBot.worker)?.postMessage({
            do: 'method',
            botType: BotType.grid,
            botId: id,
            method: 'setStatus',
            args: [status, undefined, buyType, buyCount, buyAmount],
          })
        } else {
          const botData = await this.botDb.readData({
            _id: id,
            userId,
            isDeleted: { $ne: true },
          })

          if (botData.data?.result) {
            await this.createNewBot(
              id,
              type,
              userId,
              botData.data.result.exchange,
              botData.data?.result?.uuid || '',
              [
                id,
                botData.data.result.exchange,
                restart,
                true,
                restart,
                ignoreStats,
              ],
              (worker) => {
                worker.postMessage({
                  do: 'method',
                  botType: type,
                  botId: id,
                  method: 'setStatus',
                  args: [status, undefined, buyType, buyCount, buyAmount],
                })
              },
              paperContext,
            )
          } else {
            return this.entityNotFound('Bot')
          }
        }
      } else if (type === BotType.combo) {
        const findBot = this.comboBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (findBot) {
          this.getWorkerById(findBot.worker)?.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId: id,
            method: 'setStatus',
            args: [id, status],
          })
        } else {
          const botData = await this.comboBotDb.readData({
            _id: id,
            userId,
            isDeleted: { $ne: true },
          })
          if (botData.data?.result) {
            await this.createNewBot(
              id,
              type,
              userId,
              botData.data.result.exchange,
              botData.data?.result?.uuid || '',
              [id, botData.data.result.exchange, true, restart],
              (worker) => {
                worker.postMessage({
                  do: 'method',
                  botType: type,
                  botId: id,
                  method: 'setStatus',
                  args: [id, status],
                })
              },
              paperContext,
            )
          } else {
            return this.entityNotFound('Bot')
          }
        }
      } else if (type === BotType.hedgeCombo) {
        const findBot = this.hedgeComboBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (findBot) {
          this.getWorkerById(findBot.worker)?.postMessage({
            do: 'method',
            botType: BotType.hedgeCombo,
            botId: id,
            method: 'setStatus',
            args: [id, status, undefined, restart, false, input.hedgeConfig],
          })
        } else {
          const botData = await hedgeComboBotDb.readData(
            {
              _id: id,
              userId,
              isDeleted: { $ne: true },
            },
            {},
            { populate: { path: 'bots', select: 'exchange _id' } },
          )
          if (botData.data?.result) {
            await this.createNewBot(
              id,
              type,
              userId,
              botData.data.result.bots[0].exchange,
              botData.data?.result?.uuid || '',
              [
                {
                  botType: BotType.hedgeCombo,
                  id,
                  bots: botData.data.result.bots.map((d) => ({
                    id: `${d._id}`,
                    type: BotType.combo,
                  })),
                  paperContext: botData.data.result.paperContext,
                  userId: botData.data.result.userId,
                },
              ],
              (worker) => {
                worker.postMessage({
                  do: 'method',
                  botType: type,
                  botId: id,
                  method: 'setStatus',
                  args: [
                    id,
                    status,
                    undefined,
                    restart,
                    false,
                    input.hedgeConfig,
                  ],
                })
              },
              paperContext,
            )
          } else {
            return this.entityNotFound('Bot')
          }
        }
      } else if (type === BotType.hedgeDca) {
        const findBot = this.hedgeDcaBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (findBot) {
          this.getWorkerById(findBot.worker)?.postMessage({
            do: 'method',
            botType: BotType.hedgeDca,
            botId: id,
            method: 'setStatus',
            args: [id, status, undefined, restart, false, input.hedgeConfig],
          })
        } else {
          const botData = await hedgeDCABotDb.readData(
            {
              _id: id,
              userId,
              isDeleted: { $ne: true },
            },
            {},
            { populate: { path: 'bots', select: 'exchange _id' } },
          )
          if (botData.data?.result) {
            await this.createNewBot(
              id,
              type,
              userId,
              botData.data.result.bots[0].exchange,
              botData.data?.result?.uuid || '',
              [
                {
                  botType: BotType.hedgeDca,
                  id,
                  bots: botData.data.result.bots.map((d) => ({
                    id: `${d._id}`,
                    type: BotType.dca,
                  })),
                  paperContext: botData.data.result.paperContext,
                  userId: botData.data.result.userId,
                },
              ],
              (worker) => {
                worker.postMessage({
                  do: 'method',
                  botType: type,
                  botId: id,
                  method: 'setStatus',
                  args: [
                    id,
                    status,
                    undefined,
                    restart,
                    false,
                    input.hedgeConfig,
                  ],
                })
              },
              paperContext,
            )
          } else {
            return this.entityNotFound('Bot')
          }
        }
      } else {
        const findBot = this.dcaBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (findBot) {
          this.getWorkerById(findBot.worker)?.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId: id,
            method: 'setStatus',
            args: [id, status],
          })
        } else {
          const botData = await this.dcaBotDb.readData({
            _id: id,
            userId,
            isDeleted: { $ne: true },
          })
          if (botData.data?.result) {
            await this.createNewBot(
              id,
              type,
              userId,
              botData.data.result.exchange,
              botData.data?.result?.uuid || '',
              [id, botData.data.result.exchange, true, restart],
              (worker) => {
                worker.postMessage({
                  do: 'method',
                  botType: type,
                  botId: id,
                  method: 'setStatus',
                  args: [id, status],
                })
              },
              paperContext,
              botData.data.result.settings.type ?? DCATypeEnum.regular,
            )
          } else {
            return this.entityNotFound('Bot')
          }
        }
      }
    } else if (status === 'closed') {
      if (type === BotType.grid) {
        const bot = this.bots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (bot) {
          this.getWorkerById(bot.worker)?.postMessage({
            do: 'method',
            botType: BotType.grid,
            botId: id,
            method: 'setStatus',
            args: [
              status,
              cancelPartiallyFilled,
              undefined,
              undefined,
              undefined,
              closeGridType,
            ],
          })
        } else {
          return this.entityNotFound('Bot')
        }
      } else if (type === BotType.combo) {
        const bot = this.comboBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (bot) {
          this.getWorkerById(bot.worker)?.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId: id,
            method: 'setStatus',
            args: [id, status, closeType],
          })
        } else {
          return this.entityNotFound('Bot')
        }
      } else if (type === BotType.hedgeCombo) {
        const bot = this.hedgeComboBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (bot) {
          this.getWorkerById(bot.worker)?.postMessage({
            do: 'method',
            botType: BotType.hedgeCombo,
            botId: id,
            method: 'setStatus',
            args: [id, status, closeType],
          })
        } else {
          this.handleLog(`Hedge combo bot ${id} not found in changeStatus`)
          // Never demote a user-set `archive` status: a stray close signal for
          // an archived hedge bot (not in orchestrator memory) must be a no-op,
          // not silently un-archive it. Guard the direct fallback write.
          await hedgeComboBotDb.updateData(
            { _id: id, userId, status: { $ne: BotStatusEnum.archive } },
            { $set: { status: BotStatusEnum.closed } },
          )
        }
      } else if (type === BotType.hedgeDca) {
        const bot = this.hedgeDcaBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (bot) {
          this.getWorkerById(bot.worker)?.postMessage({
            do: 'method',
            botType: BotType.hedgeDca,
            botId: id,
            method: 'setStatus',
            args: [id, status, closeType],
          })
        } else {
          this.handleLog(`Hedge dca bot ${id} not found in changeStatus`)
          // Never demote a user-set `archive` status: a stray close signal for
          // an archived hedge bot (not in orchestrator memory) must be a no-op,
          // not silently un-archive it. Guard the direct fallback write.
          await hedgeDCABotDb.updateData(
            { _id: id, userId, status: { $ne: BotStatusEnum.archive } },
            { $set: { status: BotStatusEnum.closed } },
          )
        }
      } else {
        const bot = this.dcaBots.find(
          (bot) => bot.id === id && bot.userId === userId,
        )
        if (bot) {
          this.getWorkerById(bot.worker)?.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId: id,
            method: 'setStatus',
            args: [id, status, closeType],
          })
        } else {
          return this.entityNotFound('Bot')
        }
      }
    }
    if (buyCount) {
      this.botEventDb.createData({
        userId: userId,
        botId: id,
        event: 'Buy dialog',
        botType: type,
        description: `Buy count: ${buyCount}`,
        paperContext,
      })
    }
    if (buyType) {
      this.botEventDb.createData({
        userId: userId,
        botId: id,
        event: 'Buy dialog',
        botType: type,
        description: `Buy type: ${buyType}`,
        paperContext,
      })
    }
    return await this.getBot(type, userId, id, undefined, paperContext)
  }

  public async restartBot(
    userId: string,
    input: {
      id: string
      type: BotType
    },
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        input.type,
        'restartBot',
        false,
        userId,
        input,
        paperContext,
      )
    }
    const { id, type } = input
    if (type === BotType.grid) {
      const findBot = this.bots.find(
        (bot) => bot.id === id && bot.userId === userId,
      )
      if (findBot) {
        this.getWorkerById(findBot.worker)?.postMessage({
          do: 'method',
          botType: type,
          botId: id,
          method: 'reloadBot',
          args: [id],
        })
      } else {
        const botData = await this.botDb.readData({
          _id: id,
          userId,
          isDeleted: { $ne: true },
        })
        if (botData.data?.result) {
          await this.createNewBot(
            id,
            type,
            userId,
            botData.data.result.exchange,
            botData.data?.result?.uuid || '',
            [id, botData.data.result.exchange],
            (worker) => {
              worker.postMessage({
                do: 'method',
                botType: type,
                botId: id,
                method: 'reloadBot',
                args: [id],
              })
            },
            paperContext,
          )
        }
      }
    } else if (type === BotType.combo) {
      const findBot = this.comboBots.find(
        (bot) => bot.id === id && bot.userId === userId,
      )
      if (findBot) {
        this.getWorkerById(findBot.worker)?.postMessage({
          do: 'method',
          botType: BotType.combo,
          botId: id,
          method: 'reloadBot',
          args: [id],
        })
      } else {
        const botData = await this.comboBotDb.readData({
          _id: id,
          userId,
          isDeleted: { $ne: true },
        })
        if (botData.data?.result) {
          await this.createNewBot(
            id,
            type,
            userId,
            botData.data.result.exchange,
            botData.data?.result?.uuid || '',
            [id, botData.data.result.exchange],
            (worker) => {
              worker.postMessage({
                do: 'method',
                botType: type,
                botId: id,
                method: 'reloadBot',
                args: [id],
              })
            },
            paperContext,
          )
        } else {
          return this.entityNotFound('Bot')
        }
      }
    } else if (type === BotType.hedgeCombo) {
      const findBot = this.hedgeComboBots.find(
        (bot) => bot.id === id && bot.userId === userId,
      )
      if (findBot) {
        this.getWorkerById(findBot.worker)?.postMessage({
          do: 'method',
          botType: BotType.hedgeCombo,
          botId: id,
          method: 'reloadBot',
          args: [id],
        })
      }
    } else if (type === BotType.hedgeDca) {
      const findBot = this.hedgeDcaBots.find(
        (bot) => bot.id === id && bot.userId === userId,
      )
      if (findBot) {
        this.getWorkerById(findBot.worker)?.postMessage({
          do: 'method',
          botType: BotType.hedgeDca,
          botId: id,
          method: 'reloadBot',
          args: [id],
        })
      }
    } else {
      const findBot = this.dcaBots.find(
        (bot) => bot.id === id && bot.userId === userId,
      )
      if (findBot) {
        this.getWorkerById(findBot.worker)?.postMessage({
          do: 'method',
          botType: BotType.dca,
          botId: id,
          method: 'reloadBot',
          args: [id],
        })
      } else {
        const botData = await this.dcaBotDb.readData({
          _id: id,
          userId,
          isDeleted: { $ne: true },
        })
        if (botData.data?.result) {
          await this.createNewBot(
            id,
            type,
            userId,
            botData.data.result.exchange,
            botData.data?.result?.uuid || '',
            [id, botData.data.result.exchange],
            (worker) => {
              worker.postMessage({
                do: 'method',
                botType: type,
                botId: id,
                method: 'reloadBot',
                args: [id],
              })
            },
            paperContext,
            botData.data.result.settings.type ?? DCATypeEnum.regular,
          )
        } else {
          return this.entityNotFound('Bot')
        }
      }
    }
    this.botEventDb.createData({
      userId: userId,
      botId: id,
      botType: type,
      event: 'Restart',
      description: 'Bot restarted',
      paperContext,
    })
    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Restart signal sent',
    }
  }

  public async deleteBot(
    userId: string,
    id: string,
    type: BotType,
    forceClose = false,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        type,
        'deleteBot',
        false,
        userId,
        id,
        type,
        forceClose,
        paperContext,
      )
    }
    if (type && type === BotType.dca) {
      const bot = this.dcaBots.find((b) => b.id === id && b.userId === userId)
      if (bot) {
        const getBot = await this.getDCABotFromDb(
          userId,
          id,
          undefined,
          paperContext,
        )
        if (getBot.status === StatusEnum.notok) {
          return getBot
        }
        if (!getBot) {
          return this.entityNotFound('Bot')
        }
        if (getBot.data.locked) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot when it is locked',
            data: null,
          }
        }
        if ((getBot.data?.dealsInBot.active ?? 0) > 0) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot with active deal',
            data: null,
          }
        }
        const worker = this.getWorkerById(bot.worker)
        const responseId = v4()
        if (forceClose) {
          worker?.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId: id,
            method: 'stop',
            args: [CloseDCATypeEnum.leave, true],
            responseId,
          })
        } else {
          worker?.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId: id,
            method: 'stop',
            args: [CloseDCATypeEnum.cancel],
            responseId,
          })
          worker?.postMessage({
            do: 'delete',
            botType: BotType.dca,
            botId: id,
          })
        }
        this.dcaBots = this.dcaBots.filter((b) => b.id !== id)
        if (worker) {
          await this.updateResponseQueue(
            responseId,
            async () =>
              await this.changeWorkerBots(type, id, worker.threadId, -1),
          )
        }
      }

      const deleteBotRequest = await this.dcaBotDb.updateData(
        {
          _id: id,
          userId,
        },
        {
          $set: {
            isDeleted: true,
            deleteTime: +new Date() + 30 * 24 * 60 * 60 * 1000,
          },
        },
        true,
      )
      if (deleteBotRequest.status === StatusEnum.ok) {
        await updateRelatedBotsInVar([
          ...new Set([...(deleteBotRequest?.data?.vars?.list ?? [])]),
        ])
        await this.dcaDealsDb.updateManyData(
          { botId: id },
          { $set: { isDeleted: true } },
        )
        this.checkBigAccount(userId, 'remove')
        return {
          status: StatusEnum.ok,
          reason: 'Bot was deleted',
          data: null,
        }
      }
      return deleteBotRequest
    } else if (type && type === BotType.combo) {
      const bot = this.comboBots.find((b) => b.id === id && b.userId === userId)
      if (bot) {
        const getBot = await this.getComboBotFromDb(
          userId,
          id,
          undefined,
          paperContext,
        )
        if (getBot.status === StatusEnum.notok) {
          return getBot
        }
        if (!getBot) {
          return this.entityNotFound('Bot')
        }
        if (getBot.data.locked) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot when it is locked',
            data: null,
          }
        }
        if ((getBot.data?.dealsInBot.active ?? 0) > 0) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot with active deal',
            data: null,
          }
        }
        const worker = this.getWorkerById(bot.worker)
        const responseId = v4()
        if (forceClose) {
          worker?.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId: id,
            method: 'stop',
            args: [CloseDCATypeEnum.leave, true],
            responseId,
          })
        } else {
          worker?.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId: id,
            method: 'stop',
            args: [CloseDCATypeEnum.cancel],
            responseId,
          })
          worker?.postMessage({
            do: 'delete',
            botType: BotType.combo,
            botId: id,
          })
        }
        this.comboBots = this.comboBots.filter((b) => b.id !== id)
        if (worker) {
          await this.updateResponseQueue(
            responseId,
            async () =>
              await this.changeWorkerBots(type, id, worker.threadId, -1),
          )
        }
      }
      const deleteBotRequest = await this.comboBotDb.updateData(
        {
          _id: id,
          userId,
        },
        {
          $set: {
            isDeleted: true,
            deleteTime: +new Date() + 30 * 24 * 60 * 60 * 1000,
          },
        },
        true,
      )
      if (deleteBotRequest.status === StatusEnum.ok) {
        await updateRelatedBotsInVar([
          ...new Set([...(deleteBotRequest?.data?.vars?.list ?? [])]),
        ])
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: type,
          event: 'Delete',
          description: 'Bot deleted',
          paperContext,
        })
        await this.comboProfitDb.updateManyData(
          { botId: id },
          { $set: { isDeleted: true } },
        )
        this.checkBigAccount(userId, 'remove')
        return {
          status: StatusEnum.ok,
          reason: 'Bot was deleted',
          data: null,
        }
      }
      return deleteBotRequest
    } else if (type && type === BotType.hedgeCombo) {
      const bot = this.hedgeComboBots.find(
        (b) => b.id === id && b.userId === userId,
      )
      if (bot) {
        const getBot = await this.getHedgeComboBotFromDb(
          userId,
          id,
          undefined,
          paperContext,
        )
        if (getBot.status === StatusEnum.notok) {
          return getBot
        }
        if (!getBot) {
          return this.entityNotFound('Bot')
        }
        if (getBot.data.bots.some((b) => b.locked)) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot when it is locked',
            data: null,
          }
        }
        if (getBot.data?.bots?.some((b) => b.dealsInBot.active > 0)) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot with active deal',
            data: null,
          }
        }
        const worker = this.getWorkerById(bot.worker)
        const responseId = v4()
        if (forceClose) {
          worker?.postMessage({
            do: 'method',
            botType: BotType.hedgeCombo,
            botId: id,
            method: 'setStatus',
            args: [id, BotStatusEnum.closed, CloseDCATypeEnum.leave],
            responseId,
          })
        } else {
          worker?.postMessage({
            do: 'method',
            botType: BotType.hedgeCombo,
            botId: id,
            method: 'setStatus',
            args: [id, BotStatusEnum.closed, CloseDCATypeEnum.cancel],
            responseId,
          })
          worker?.postMessage({
            do: 'delete',
            botType: BotType.hedgeCombo,
            botId: id,
          })
        }
        this.hedgeComboBots = this.hedgeComboBots.filter((b) => b.id !== id)
        if (worker) {
          await this.updateResponseQueue(
            responseId,
            async () =>
              await this.changeWorkerBots(type, id, worker.threadId, -1),
          )
        }
      }
      const set = {
        isDeleted: true,
        deleteTime: +new Date() + 30 * 24 * 60 * 60 * 1000,
      }
      const deleteBotRequest = await hedgeComboBotDb.updateData(
        {
          _id: id,
          userId,
        },
        {
          $set: set,
        },
      )
      if (deleteBotRequest.status === StatusEnum.ok) {
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: type,
          event: 'Delete',
          description: 'Bot deleted',
          paperContext,
        })
        const bot = await hedgeComboBotDb.readData({ _id: id, userId })
        for (const b of bot.data?.result.bots ?? []) {
          await this.callExternalBotService<BaseReturn<string>>(
            BotType.combo,
            'deleteBot',
            false,
            userId,
            `${b}`,
            BotType.combo,
            forceClose,
            paperContext,
          )
        }

        this.checkBigAccount(userId, 'remove')
        return {
          status: StatusEnum.ok,
          reason: 'Bot was deleted',
          data: null,
        }
      }
      return deleteBotRequest
    } else if (type && type === BotType.hedgeDca) {
      const bot = this.hedgeDcaBots.find(
        (b) => b.id === id && b.userId === userId,
      )
      if (bot) {
        const getBot = await this.getHedgeDcaBotFromDb(
          userId,
          id,
          undefined,
          paperContext,
        )
        if (getBot.status === StatusEnum.notok) {
          return getBot
        }
        if (!getBot) {
          return this.entityNotFound('Bot')
        }
        if (getBot.data.bots.some((b) => b.locked)) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot when it is locked',
            data: null,
          }
        }
        if (getBot.data?.bots?.some((b) => b.dealsInBot.active > 0)) {
          return {
            status: StatusEnum.notok,
            reason: 'Cannot delete bot with active deal',
            data: null,
          }
        }
        const worker = this.getWorkerById(bot.worker)
        const responseId = v4()
        if (forceClose) {
          worker?.postMessage({
            do: 'method',
            botType: BotType.hedgeDca,
            botId: id,
            method: 'setStatus',
            args: [id, BotStatusEnum.closed, CloseDCATypeEnum.leave],
            responseId,
          })
        } else {
          worker?.postMessage({
            do: 'method',
            botType: BotType.hedgeDca,
            botId: id,
            method: 'setStatus',
            args: [id, BotStatusEnum.closed, CloseDCATypeEnum.cancel],
            responseId,
          })
          worker?.postMessage({
            do: 'delete',
            botType: BotType.hedgeDca,
            botId: id,
          })
        }
        this.hedgeDcaBots = this.hedgeDcaBots.filter((b) => b.id !== id)
        if (worker) {
          await this.updateResponseQueue(
            responseId,
            async () =>
              await this.changeWorkerBots(type, id, worker.threadId, -1),
          )
        }
      }
      const set = {
        isDeleted: true,
        deleteTime: +new Date() + 30 * 24 * 60 * 60 * 1000,
      }
      const deleteBotRequest = await hedgeDCABotDb.updateData(
        {
          _id: id,
          userId,
        },
        {
          $set: set,
        },
      )
      if (deleteBotRequest.status === StatusEnum.ok) {
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: type,
          event: 'Delete',
          description: 'Bot deleted',
          paperContext,
        })
        const bot = await hedgeDCABotDb.readData({ _id: id, userId })
        for (const b of bot.data?.result.bots ?? []) {
          await this.callExternalBotService<BaseReturn<string>>(
            BotType.dca,
            'deleteBot',
            false,
            userId,
            `${b}`,
            BotType.dca,
            forceClose,
            paperContext,
          )
        }

        this.checkBigAccount(userId, 'remove')
        return {
          status: StatusEnum.ok,
          reason: 'Bot was deleted',
          data: null,
        }
      }
      return deleteBotRequest
    } else {
      const bot = this.bots.find((b) => b.id === id && b.userId === userId)
      if (bot) {
        const worker = this.getWorkerById(bot.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.grid,
          botId: id,
          method: 'stop',
          args: [],
          responseId,
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.grid,
          botId: id,
        })
        this.bots = this.bots.filter((b) => b.id !== id)
        if (worker) {
          await this.updateResponseQueue(
            responseId,
            async () =>
              await this.changeWorkerBots(type, id, worker.threadId, -1),
          )
        }
      }
      const deleteBotRequest = await this.botDb.updateData(
        {
          _id: id,
          userId,
        },
        {
          $set: {
            isDeleted: true,
            deleteTime: +new Date() + 30 * 24 * 60 * 60 * 1000,
          },
        },
      )
      if (deleteBotRequest.status === StatusEnum.ok) {
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: type,
          event: 'Delete',
          description: 'Bot deleted',
          paperContext,
        })
        await this.transactionDb.updateManyData(
          { botId: id },
          { $set: { isDeleted: true } },
        )
        this.checkBigAccount(userId, 'remove')
        return {
          status: StatusEnum.ok,
          reason: 'Bot was deleted',
          data: null,
        }
      }
      return deleteBotRequest
    }
  }

  public async findActiveGrid(filter: Record<string, unknown> = {}, skip = 0) {
    const data = await this.botDb.readData<{
      userId: string
      _id: string
      uuid: string
      exchange: ExchangeEnum
      paperContext?: boolean
    }>(
      {
        status: {
          $in: [
            BotStatusEnum.open,
            BotStatusEnum.range,
            BotStatusEnum.error,
            BotStatusEnum.monitoring,
          ],
        },
        isDeleted: { $ne: true },
        exchangeUnassigned: { $ne: true },
        ...filter,
      },
      {
        userId: 1,
        _id: 1,
        uuid: 1,
        exchange: 1,
        paperContext: 1,
      },
      { limit: 1000, skip },
      true,
      true,
    )
    if (data.status === StatusEnum.notok) {
      return []
    }
    let bots = data.data.result
    if (data.data.count > bots.length + skip) {
      const nextData = await this.findActiveGrid(
        filter,
        data.data.result.length + skip,
      )
      bots = [...bots, ...nextData]
    }
    return bots
  }

  public async findActiveDCA(filter: Record<string, unknown> = {}, skip = 0) {
    const data = await this.dcaBotDb.readData<{
      _id: string
      userId: string
      exchange: ExchangeEnum
      uuid: string
      paperContext?: boolean
      settings: { type: DCATypeEnum }
      status: BotStatusEnum
      parentBotId?: string
    }>(
      {
        $and: [
          {
            $or: [
              { 'deals.active': { $gt: 0 } },
              {
                status: {
                  $in: [
                    BotStatusEnum.open,
                    BotStatusEnum.range,
                    BotStatusEnum.error,
                    BotStatusEnum.monitoring,
                  ],
                },
              },
            ],
          },
          {
            //parentBotId: { $exists: false },
            isDeleted: { $ne: true },
            exchangeUnassigned: { $ne: true },
            ...filter,
          },
        ],
      },
      {
        _id: 1,
        userId: 1,
        exchange: 1,
        uuid: 1,
        paperContext: 1,
        'settings.type': 1,
        status: 1,
        parentBotId: 1,
      },
      {
        limit: 1000,
        skip,
      },
      true,
      true,
    )
    if (data.status === StatusEnum.notok) {
      return []
    }
    let bots = data.data.result
    if (data.data.count > bots.length + skip) {
      const nextData = await this.findActiveDCA(
        filter,
        data.data.result.length + skip,
      )
      bots = [...bots, ...nextData]
    }
    return bots
  }

  public async findActiveCombo(filter: Record<string, unknown> = {}, skip = 0) {
    const data = await this.comboBotDb.readData<{
      _id: string
      userId: string
      exchange: ExchangeEnum
      uuid: string
      paperContext?: boolean
      status: BotStatusEnum
      parentBotId?: string
    }>(
      {
        $and: [
          {
            $or: [
              { 'deals.active': { $gt: 0 } },
              {
                status: {
                  $in: [
                    BotStatusEnum.open,
                    BotStatusEnum.range,
                    BotStatusEnum.error,
                    BotStatusEnum.monitoring,
                  ],
                },
              },
            ],
          },
          {
            isDeleted: { $ne: true },
            exchangeUnassigned: { $ne: true },
            ...filter,
          },
        ],
      },
      {
        _id: 1,
        userId: 1,
        exchange: 1,
        uuid: 1,
        paperContext: 1,
        status: 1,
        parentBotId: 1,
      },
      { limit: 1000, skip },
      true,
      true,
    )
    if (data.status === StatusEnum.notok) {
      return []
    }
    let bots = data.data.result
    if (data.data.count > bots.length + skip) {
      const nextData = await this.findActiveCombo(
        filter,
        data.data.result.length + skip,
      )
      bots = [...bots, ...nextData]
    }
    return bots
  }

  public async findActiveHedgeCombo(
    filter: Record<string, unknown> = {},
    skip = 0,
  ) {
    const findChild = await this.findActiveCombo(
      { parentBotId: { $exists: true }, ...filter },
      skip,
    )
    const data = await hedgeComboBotDb.readData<{
      _id: string
      userId: string
      exchange: ExchangeEnum
      uuid: string
      paperContext?: boolean
      status: BotStatusEnum
      bots: string[]
    }>(
      Object.entries(filter).length > 0
        ? {
            _id: {
              $in: findChild.map((c) => new Types.ObjectId(c.parentBotId)),
            },
          }
        : {
            $and: [
              {
                $or: [
                  {
                    _id: {
                      $in: findChild.map(
                        (c) => new Types.ObjectId(c.parentBotId),
                      ) as any[],
                    },
                  },
                  {
                    status: {
                      $in: [
                        BotStatusEnum.open,
                        BotStatusEnum.range,
                        BotStatusEnum.error,
                        BotStatusEnum.monitoring,
                      ],
                    },
                  },
                ],
              },
              {
                isDeleted: { $ne: true },
                exchangeUnassigned: { $ne: true },
                ...filter,
              },
            ],
          },
      {
        _id: 1,
        userId: 1,
        exchange: 1,
        uuid: 1,
        paperContext: 1,
        status: 1,
        bots: 1,
      },
      { limit: 1000, skip },
      true,
      true,
    )
    if (data.status === StatusEnum.notok) {
      return []
    }
    let bots = data.data.result
    if (data.data.count > bots.length + skip) {
      const nextData = await this.findActiveHedgeCombo(
        filter,
        data.data.result.length + skip,
      )
      bots = [...bots, ...nextData]
    }
    return bots
  }

  public async findActiveHedgeDca(
    filter: Record<string, unknown> = {},
    skip = 0,
  ) {
    const findChild = await this.findActiveDCA(
      { parentBotId: { $exists: true }, ...filter },
      skip,
    )
    const data = await hedgeDCABotDb.readData<{
      _id: string
      userId: string
      exchange: ExchangeEnum
      uuid: string
      paperContext?: boolean
      status: BotStatusEnum
      bots: string[]
    }>(
      Object.entries(filter).length > 0
        ? {
            _id: {
              $in: findChild.map((c) => new Types.ObjectId(c.parentBotId)),
            },
          }
        : {
            $and: [
              {
                $or: [
                  {
                    _id: {
                      $in: findChild.map(
                        (c) => new Types.ObjectId(c.parentBotId),
                      ) as any[],
                    },
                  },
                  {
                    status: {
                      $in: [
                        BotStatusEnum.open,
                        BotStatusEnum.range,
                        BotStatusEnum.error,
                        BotStatusEnum.monitoring,
                      ],
                    },
                  },
                ],
              },
              {
                isDeleted: { $ne: true },
                exchangeUnassigned: { $ne: true },
                ...filter,
              },
            ],
          },
      {
        _id: 1,
        userId: 1,
        exchange: 1,
        uuid: 1,
        paperContext: 1,
        status: 1,
        bots: 1,
      },
      { limit: 1000, skip },
      true,
      true,
    )
    if (data.status === StatusEnum.notok) {
      return []
    }
    let bots = data.data.result
    if (data.data.count > bots.length + skip) {
      const nextData = await this.findActiveHedgeDca(
        filter,
        data.data.result.length + skip,
      )
      bots = [...bots, ...nextData]
    }
    return bots
  }

  /**
   * Wait for one worker's `{ event: 'response', responseId }` reply, bounded.
   *
   * The stop legs below used `worker.once('message', …)`. `once` fires on the
   * FIRST message the worker sends — whatever it is — and node drops the
   * listener before running the callback, so an unrelated `createBot` /
   * `botClosed` / other-request `response` (one worker hosts up to
   * BOTS_PER_WORKER bots, all reporting on the same port) consumed the listener
   * and the promise never settled. `worker?.once` on an undefined worker — a
   * `this.bots` entry left behind by a terminated worker — never settled
   * either. Both stalls surface as the user's `deleteExchange` hanging until
   * the bot-service RPC gives up five minutes later.
   *
   * Same `on` + `removeListener` + timer idiom as `compareBalances`, except a
   * lapsed wait resolves rather than rejects: the close has already been posted
   * to the worker, and the rest of the sweep still has to run.
   */
  private waitForWorkerResponse(
    worker: Worker | undefined,
    responseId: string,
    label: string,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!worker) {
      this.handleWarn(`${loggerPrefix} ${label} | worker gone, not waiting`)
      return Promise.resolve(null)
    }
    const wait = Math.max(0, timeoutMs)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null
      const cb = (msg: { responseId?: string }) => {
        if (msg && msg.responseId === responseId) {
          worker.removeListener('message', cb)
          if (timer) {
            clearTimeout(timer)
          }
          resolve(msg)
        }
      }
      timer = setTimeout(() => {
        worker.removeListener('message', cb)
        this.handleWarn(
          `${loggerPrefix} ${label} | no reply within ${wait}ms, moving on`,
        )
        resolve(null)
      }, wait)
      worker.on('message', cb)
    })
  }

  public async stopBotByExchange(uuid: string, userId?: string) {
    if (!this.useBots) {
      return await this.callExternalBotService(
        'allWithHedge',
        'stopBotByExchange',
        false,
        uuid,
        userId,
      )
    }
    // Same reasoning as `unassignBotByExchange`: every bot collection is
    // indexed {userId, …}, so a filter on `exchangeUUID` alone can use none of
    // them and each sweep COLLSCANs the collection twice — once for the find,
    // once for `readData`'s countDocuments. A connection belongs to exactly one
    // user, so scoping by owner matches the same bots.
    const filter = userId
      ? { userId, exchangeUUID: uuid }
      : { exchangeUUID: uuid }
    const replyDeadline = +new Date() + stopByExchangeReplyBudget
    const grid =
      BotServiceType === BotType.grid ? await this.findActiveGrid(filter) : []
    const dca =
      BotServiceType === BotType.dca ? await this.findActiveDCA(filter) : []
    const hedgeDca =
      BotServiceType === BotType.hedgeDca
        ? await this.findActiveHedgeDca(filter)
        : []
    const combo =
      BotServiceType === BotType.combo ? await this.findActiveCombo(filter) : []
    const hedgeCombo =
      BotServiceType === BotType.hedgeCombo
        ? await this.findActiveHedgeCombo(filter)
        : []
    for (const g of grid ?? []) {
      const find = this.bots.find((b) => b.id === g._id.toString())
      if (find) {
        const worker = this.getWorkerById(find.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.grid,
          botId: find.id,
          method: 'setStatus',
          args: [
            BotStatusEnum.closed,
            true,
            undefined,
            undefined,
            undefined,
            CloseGRIDTypeEnum.cancel,
            true,
          ],
          responseId,
        })
        await this.waitForWorkerResponse(
          worker,
          responseId,
          `stopBotByExchange ${BotType.grid} ${find.id}`,
          replyDeadline - +new Date(),
        )
      }
    }
    for (const d of dca ?? []) {
      const find = this.dcaBots.find((b) => b.id === d._id.toString())
      if (find) {
        const worker = this.getWorkerById(find.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.dca,
          botId: find.id,
          method: 'setStatus',
          args: [
            find.id,
            BotStatusEnum.closed,
            CloseDCATypeEnum.cancel,
            undefined,
            true,
          ],
          responseId,
        })
        await this.waitForWorkerResponse(
          worker,
          responseId,
          `stopBotByExchange ${BotType.dca} ${find.id}`,
          replyDeadline - +new Date(),
        )
      }
    }
    for (const d of combo ?? []) {
      const find = this.comboBots.find((b) => b.id === d._id.toString())
      if (find) {
        const worker = this.getWorkerById(find.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.combo,
          botId: find.id,
          method: 'setStatus',
          args: [
            find.id,
            BotStatusEnum.closed,
            CloseDCATypeEnum.cancel,
            undefined,
            true,
          ],
          responseId,
        })
        await this.waitForWorkerResponse(
          worker,
          responseId,
          `stopBotByExchange ${BotType.combo} ${find.id}`,
          replyDeadline - +new Date(),
        )
      }
    }
    for (const d of hedgeDca ?? []) {
      const find = this.hedgeDcaBots.find((b) => b.id === d._id.toString())
      if (find) {
        const worker = this.getWorkerById(find.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.hedgeDca,
          botId: find.id,
          method: 'setStatus',
          args: [find.id, BotStatusEnum.closed, CloseDCATypeEnum.cancel],
          responseId,
        })
        await this.waitForWorkerResponse(
          worker,
          responseId,
          `stopBotByExchange ${BotType.hedgeDca} ${find.id}`,
          replyDeadline - +new Date(),
        )
      }
    }
    for (const d of hedgeCombo ?? []) {
      const find = this.hedgeComboBots.find((b) => b.id === d._id.toString())
      if (find) {
        const worker = this.getWorkerById(find.worker)
        const responseId = v4()
        worker?.postMessage({
          do: 'method',
          botType: BotType.hedgeCombo,
          botId: find.id,
          method: 'setStatus',
          args: [find.id, BotStatusEnum.closed, CloseDCATypeEnum.cancel],
          responseId,
        })
        await this.waitForWorkerResponse(
          worker,
          responseId,
          `stopBotByExchange ${BotType.hedgeCombo} ${find.id}`,
          replyDeadline - +new Date(),
        )
      }
    }
  }

  /**
   * `userId` is optional only so existing callers keep compiling — pass it.
   * The bot collections are indexed {userId, …}, so a filter on `exchangeUUID`
   * alone cannot use any of them and this sweep COLLSCANs `dcaBots`, `comboBots`
   * and `bots` in full. An exchange connection belongs to exactly one user and
   * `uuid` is a v4, so scoping by owner matches the same docs.
   */
  public async unassignBotByExchange(uuid: string, userId?: string) {
    const filter = userId
      ? { userId, exchangeUUID: uuid }
      : { exchangeUUID: uuid }
    const update = {
      $set: { exchangeUnassigned: true, status: BotStatusEnum.closed },
    }
    // Three different collections, one filter — no sweep needs another's
    // answer, but each used to wait for the one before it, so disconnecting an
    // account paid three serial bulk writes back to back. The notok checks below
    // keep reporting them in the original order.
    const [dca, combo, grid] = await Promise.all([
      this.dcaBotDb.updateManyData(filter, update),
      this.comboBotDb.updateManyData(filter, update),
      this.botDb.updateManyData(filter, update),
    ])
    if (dca.status === StatusEnum.notok) {
      return dca
    }
    if (combo.status === StatusEnum.notok) {
      return combo
    }
    if (grid.status === StatusEnum.notok) {
      return grid
    }
  }

  protected async handleBotRestartFromServiceStart(
    botId: string,
    botType: BotType,
    userId: string,
    uuid: string,
    exchange: ExchangeEnum,
    paperContext: boolean,
    metaBots: { id: string; type: BotType }[],
    dcaType?: DCATypeEnum,
    status?: BotStatusEnum,
    ignoreState = false,
  ) {
    if (botType === BotType.dca) {
      await this.createNewBot(
        botId,
        botType,
        userId,
        exchange,
        uuid,
        [`${botId}`, exchange, true, FULL_RESTART === 'false', ignoreState],
        (worker) => {
          const msgs: any[] = [
            {
              do: 'method',
              botType: BotType.dca,
              botId,
              method: 'start',
              args: [true, undefined, status],
            },
          ]
          if (status === BotStatusEnum.closed) {
            msgs.push({
              do: 'method',
              botType: BotType.dca,
              botId,
              method: 'stop',
              args: [CloseDCATypeEnum.leave],
            })
          }
          worker.postMessage(msgs)
          this.updateRestart()
        },
        paperContext,
        dcaType,
      )
    }
    if (botType === BotType.combo) {
      await this.createNewBot(
        botId,
        botType,
        userId,
        exchange,
        uuid,
        [
          `${botId}`,
          exchange,
          true,
          FULL_RESTART === 'false' && FULL_GRID_RESTAT === 'false',
          ignoreState,
        ],
        (worker) => {
          const msgs: any[] = [
            {
              do: 'method',
              botType,
              botId,
              method: 'start',
              args: [true, undefined, status],
            },
          ]
          if (status === BotStatusEnum.closed) {
            msgs.push({
              do: 'method',
              botType,
              botId,
              method: 'stop',
              args: [CloseDCATypeEnum.leave],
            })
          }
          worker.postMessage(msgs)
          this.updateRestart()
        },
        paperContext,
      )
    }
    if (botType === BotType.grid) {
      await this.createNewBot(
        botId,
        BotType.grid,
        userId,
        exchange,
        uuid,
        [
          `${botId}`,
          exchange,
          true,
          true,
          FULL_RESTART === 'false' && FULL_GRID_RESTAT === 'false',
          ignoreState,
        ],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.grid,
            botId,
            method: 'start',
            args: [],
          })
          this.updateRestart()
        },
        paperContext,
      )
    }
    if (botType === BotType.hedgeCombo) {
      await this.createNewBot(
        botId,
        botType,
        userId,
        exchange,
        uuid,
        [
          {
            botType,
            id: `${botId}`,
            bots: metaBots,
          },
        ],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType,
            botId,
            method: 'setStatus',
            args: [`${botId}`, BotStatusEnum.open, undefined, true],
          })
          if (status === BotStatusEnum.closed) {
            worker.postMessage({
              do: 'method',
              botType,
              botId,
              method: 'setStatus',
              args: [`${botId}`, status, CloseDCATypeEnum.leave, true],
            })
          }
          this.updateRestart()
        },
        paperContext,
      )
    }
    if (botType === BotType.hedgeDca) {
      await this.createNewBot(
        botId,
        botType,
        userId,
        exchange,
        uuid,
        [
          {
            botType,
            id: `${botId}`,
            bots: metaBots,
          },
        ],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType,
            botId,
            method: 'setStatus',
            args: [`${botId}`, BotStatusEnum.open, undefined, true],
          })
          if (status === BotStatusEnum.closed) {
            worker.postMessage({
              do: 'method',
              botType,
              botId,
              method: 'setStatus',
              args: [`${botId}`, status, CloseDCATypeEnum.leave, true],
            })
          }
          this.updateRestart()
        },
        paperContext,
      )
    }
  }

  protected setListener() {
    if (this.useBots) {
      this.setServiceListener()
    }
    if (this.useBots && BotServiceType !== BotType.grid) {
      this.rabbit.listenWithCallback<WebhookData[] | WebhookData, void>(
        webhookQueue,
        (data) => {
          this.handleDebug(
            `Webhook data received for ${[data]
              .flat()
              .map((d) => d.uuid)
              .join(',')} after restart`,
          )
          this.webhookProcess(data)
        },
      )
    }
  }

  private updateRestart() {
    this.restarted++
    this.lastRestartProgressAt = Date.now()
    // `>=`, not `===`: the counter can overshoot (a worker that terminates
    // mid-boot re-restarts its bots through the same callback), and an exact
    // match that is stepped over never arms the listener at all.
    if (this.restarted >= this.estimatedRestart) {
      this.armCommandListener('parity')
    }
  }

  /**
   * Open the restart window: record how many bots we expect to re-hydrate and
   * start the arming fallback.
   *
   * The bot service deliberately does not consume its command queue until every
   * bot is back (a command processed before its bot is recreated used to start
   * the bot twice). That ordering is correct, but it was
   * gated on an exact count with no escape hatch: if one bot never finished
   * re-hydrating, the listener never armed **for the life of the process**, and
   * every user start/stop/edit for that bot type sat in the durable queue until
   * the caller's RPC deadline expired — silently, indefinitely.
   *
   * The fallback arms the listener anyway when re-hydration has clearly stopped
   * making progress (`stalled`) or has run past an absolute ceiling (`cap`).
   * Both are logged as warnings and surfaced through `onCommandListenerArmed`,
   * because they mean some bots are live but unrestarted. Kill switch:
   * `BOT_RESTART_ARM_FALLBACK=false` restores the strict (deaf-on-stall) behaviour.
   */
  protected beginRestartWindow(estimated: number, expectedIds: string[] = []) {
    this.estimatedRestart = estimated
    this.restartWindowStartedAt = Date.now()
    this.lastRestartProgressAt = this.restartWindowStartedAt
    this.restartExpectedIds = new Set(expectedIds)
    this.restartFinishedIds = new Set()
    if (this.stragglerTimer) clearTimeout(this.stragglerTimer)
    if (!estimated) {
      this.armCommandListener('no-bots')
      return
    }
    if (!armFallbackEnabled) {
      this.handleWarn(
        `${loggerPrefix} Restart arm fallback DISABLED — a stalled re-hydration will leave this service deaf to commands`,
      )
      return
    }
    this.armWatchdog = setInterval(() => {
      if (this.commandListenerArmed) return
      const now = Date.now()
      if (now - this.lastRestartProgressAt >= armStallMs) {
        this.armCommandListener('stalled')
        return
      }
      if (now - this.restartWindowStartedAt >= armCapMs) {
        this.armCommandListener('cap')
      }
    }, armWatchdogTickMs)
    this.armWatchdog.unref?.()
  }

  /** Single-shot: start consuming the command queue, whatever got us here. */
  protected armCommandListener(reason: RestartArmReason) {
    if (this.commandListenerArmed) return
    this.commandListenerArmed = true
    if (this.armWatchdog) {
      clearInterval(this.armWatchdog)
      this.armWatchdog = undefined
    }
    const elapsedMs = this.restartWindowStartedAt
      ? Date.now() - this.restartWindowStartedAt
      : 0
    const msg = `${loggerPrefix} Command listener armed (${reason}): ${this.restarted}/${this.estimatedRestart} bots restarted in ${elapsedMs}ms`
    if (reason === 'stalled' || reason === 'cap') {
      this.handleWarn(
        `${msg} — re-hydration did not complete; ${
          this.estimatedRestart - this.restarted
        } bot(s) are live but unrestarted`,
      )
    } else {
      this.handleLog(msg)
    }
    this.onCommandListenerArmed(
      reason,
      this.restarted,
      this.estimatedRestart,
      elapsedMs,
    )
    this.scheduleStragglerCheck()
    this.setListener()
  }

  /**
   * Stragglers can only be judged AFTER the restart has had time to settle.
   *
   * Arming happens at *dispatch* parity — every bot has been handed to a worker
   * — which is not the same as every bot having reported back. On a fast type
   * the two coincide (hedgeCombo: all 30 finished inside 7.3s), but DCA takes
   * minutes, so measuring at arm time would report almost the entire fleet as
   * missing. That is exactly the bug this replaces: the first version computed
   * the difference at arm time, from a set the parent could never populate.
   *
   * So: wait, then compare what the workers reported against what we expected.
   */
  private scheduleStragglerCheck() {
    if (!this.restartExpectedIds.size) return
    if (this.stragglerTimer) clearTimeout(this.stragglerTimer)
    this.stragglerTimer = setTimeout(() => {
      const missing = [...this.restartExpectedIds].filter(
        (id) => !this.restartFinishedIds.has(id),
      )
      const finished = this.restartFinishedIds.size
      const expected = this.restartExpectedIds.size
      if (missing.length) {
        this.handleWarn(
          `${loggerPrefix} Restart stragglers: ${missing.length}/${expected} bot(s) never reported finished — ${missing
            .slice(0, 10)
            .join(', ')}${missing.length > 10 ? ' …' : ''}`,
        )
      } else {
        this.handleLog(
          `${loggerPrefix} Restart complete: all ${expected} bots reported finished`,
        )
      }
      this.onRestartStragglers(missing, finished, expected)
    }, stragglerDelayMs)
    this.stragglerTimer.unref?.()
  }

  /**
   * Telemetry hook for the delayed straggler verdict. Core keeps no stats of its
   * own; main-app overrides this to persist onto the restart-progress doc.
   */
  protected onRestartStragglers(
    _missingBotIds: string[],
    _finished: number,
    _expected: number,
  ): void {}

  /**
   * Telemetry hook. Core stays free of the stats collection; main-app overrides
   * this to persist the arm reason + shortfall onto the restart-progress doc.
   */
  protected onCommandListenerArmed(
    _reason: RestartArmReason,
    _restarted: number,
    _estimated: number,
    _elapsedMs: number,
  ): void {}

  protected setServiceListener() {
    if (!!bosServiceType) {
      const queue = this.getRabbitQueueName()
      this.handleDebug(`Set service listener for ${queue}`)
      this.rabbit.listenWithCallback<BotServicePayload, unknown>(
        queue,
        async (payload) => {
          return (await this.processInternalApiCall(payload)) ?? StatusEnum.ok
        },
        100,
      )
    }
  }

  public async findActiveBots() {
    if (!this.useBots) {
      return
    }
    this.handleLog('Start finding open bots')
    const findBotsData =
      BotServiceType === BotType.grid ? await this.findActiveGrid() : []
    const findDCABotsData =
      BotServiceType === BotType.dca ? await this.findActiveDCA() : []
    const findComboBotsData =
      BotServiceType === BotType.combo ? await this.findActiveCombo() : []
    const findHedgeComboBotsData =
      BotServiceType === BotType.hedgeCombo
        ? await this.findActiveHedgeCombo()
        : []
    const findHedgeDcaBotsData =
      BotServiceType === BotType.hedgeDca ? await this.findActiveHedgeDca() : []
    this.beginRestartWindow(
      (findBotsData ?? []).length +
        (findDCABotsData ?? []).length +
        (findComboBotsData ?? []).length +
        (findHedgeComboBotsData ?? []).length +
        (findHedgeDcaBotsData ?? []).length,
    )
    if (findDCABotsData && findDCABotsData.length > 0) {
      this.handleLog(`Found ${findDCABotsData.length} active DCA bots`)
      for (const bot of findDCABotsData) {
        const id = bot._id.toString()
        this.handleDebug(`${id} started from server start`)
        await this.handleBotRestartFromServiceStart(
          id,
          BotType.dca,
          `${bot.userId}`,
          bot.uuid,
          bot.exchange,
          !!bot.paperContext,
          [],
          bot.settings.type ?? DCATypeEnum.regular,
          bot.status,
        )
      }
    }
    if (findComboBotsData && findComboBotsData.length > 0) {
      this.handleLog(`Found ${findComboBotsData.length} active combo bots`)
      for (const bot of findComboBotsData) {
        const id = bot._id.toString()
        this.handleDebug(`${bot._id} started from server start`)
        await this.handleBotRestartFromServiceStart(
          id,
          BotType.combo,
          `${bot.userId}`,
          bot.uuid,
          bot.exchange,
          !!bot.paperContext,
          [],
          undefined,
          bot.status,
        )
      }
    }
    if (findHedgeComboBotsData && findHedgeComboBotsData.length > 0) {
      this.handleLog(
        `Found ${findHedgeComboBotsData.length} active hedge combo bots`,
      )
      for (const bot of findHedgeComboBotsData) {
        const id = bot._id.toString()
        this.handleDebug(`${bot._id} started from server start`)
        await this.handleBotRestartFromServiceStart(
          id,
          BotType.hedgeCombo,
          `${bot.userId}`,
          bot.uuid,
          bot.exchange,
          !!bot.paperContext,
          bot.bots.map((b) => ({
            id: `${b}`,
            type: BotType.combo,
          })),
          undefined,
          bot.status,
        )
      }
    }
    if (findHedgeDcaBotsData && findHedgeDcaBotsData.length > 0) {
      this.handleLog(
        `Found ${findHedgeDcaBotsData.length} active hedge dca bots`,
      )
      for (const bot of findHedgeDcaBotsData) {
        const id = bot._id.toString()
        this.handleDebug(`${bot._id} started from server start`)
        await this.handleBotRestartFromServiceStart(
          id,
          BotType.hedgeDca,
          `${bot.userId}`,
          bot.uuid,
          bot.exchange,
          !!bot.paperContext,
          bot.bots.map((b) => ({
            id: `${b}`,
            type: BotType.dca,
          })),
          undefined,
          bot.status,
        )
      }
    }
    if (findBotsData && findBotsData.length > 0) {
      this.handleLog(`Found ${findBotsData.length} open bots`)
      for (const bot of findBotsData) {
        const id = bot._id.toString()
        this.handleDebug(`${id} started from server start`)
        await this.handleBotRestartFromServiceStart(
          id,
          BotType.grid,
          `${bot.userId}`,
          bot.uuid,
          bot.exchange,
          !!bot.paperContext,
          [],
          undefined,
        )
      }
    }
    // The empty-service case is armed by `beginRestartWindow('no-bots')`; this
    // is the belt-and-braces path for a service that found nothing to restart.
    if (!this.estimatedRestart) {
      this.armCommandListener('no-bots')
    }
    this.handleLog('End finding open bots')
  }
  private async closeAllDeals(botIds: string[], type: BotType) {
    if (!this.useBots) {
      return await this.callExternalBotService(
        type,
        'closeAllDeals',
        false,
        botIds,
        type,
      )
    }
    const findLocal =
      type === BotType.dca
        ? this.dcaBots.filter((b) => botIds.includes(b.id))
        : this.comboBots.filter((b) => botIds.includes(b.id))
    if (findLocal.length > 0) {
      for (const b of findLocal) {
        this.getWorkerById(b.worker)?.postMessage({
          do: 'method',
          botType: type,
          botId: b.id,
          method: 'closeAllDeals',
          args: [CloseDCATypeEnum.cancel, '', false, false, true],
        })
      }
    }
  }

  public async setArchiveStatus(
    userId: string,
    type: BotType,
    botIds: string[],
    archive: boolean,
    paperContext?: boolean,
  ) {
    // Cold-store un-archive (design §1, PART 2 — archive is REVERSIBLE): a
    // cold-archived bot's history lives in ClickHouse and was deleted from Mongo.
    // Before it can go live again we REHYDRATE it (CH→Mongo copy-verify) and clear
    // its `coldArchived` flag. This runs synchronously here, BEFORE the status
    // flip, so a subsequently-started bot rebuilds its state from Mongo. If the
    // restore fails, reject the un-archive (the bot stays fully in CH, still
    // read-routed there — the user just retries). Grandfathered / non-cold
    // archived bots (coldArchived absent/false) skip this and un-archive as before.
    if (!archive && isColdStoreEnabled()) {
      const coldType: ColdBotType | null =
        type === BotType.grid
          ? 'grid'
          : type === BotType.combo
            ? 'combo'
            : type === BotType.dca
              ? 'dca'
              : null
      const dao = (
        coldType === 'grid'
          ? this.botDb
          : coldType === 'combo'
            ? this.comboBotDb
            : coldType === 'dca'
              ? this.dcaBotDb
              : null
      ) as { readData: (...args: any[]) => Promise<any> } | null
      if (coldType && dao) {
        const cold = await dao.readData(
          { _id: { $in: botIds }, userId, coldArchived: true },
          { _id: true },
          undefined,
          true,
        )
        const coldIds: string[] =
          cold.status === StatusEnum.ok
            ? (cold.data?.result ?? []).map((b: { _id: unknown }) => `${b._id}`)
            : []
        for (const botId of coldIds) {
          const ok = await ColdStoreRehydrator.getInstance().rehydrateBot(
            userId,
            coldType,
            botId,
          )
          if (!ok) {
            return {
              status: StatusEnum.notok,
              reason:
                'Could not restore this bot’s history from cold storage. Please try again.',
              data: [],
            }
          }
        }
      }
    }

    const res = await this._setArchiveStatusImpl(
      userId,
      type,
      botIds,
      archive,
      paperContext,
    )

    // On a successful archive, copy each newly-archived bot's order/transaction
    // history to ClickHouse (fire-and-forget, off the response path). Part 1
    // covers grid/dca/combo; hedge stays in Mongo. The archiver flips
    // `coldArchived` only after a verified copy — until then reads stay on Mongo.
    if (archive && res?.status === StatusEnum.ok && isColdStoreEnabled()) {
      const coldType: ColdBotType | null =
        type === BotType.grid
          ? 'grid'
          : type === BotType.combo
            ? 'combo'
            : type === BotType.dca
              ? 'dca'
              : null
      if (coldType) {
        const archivedIds = (
          (res.data as Array<{ _id?: unknown; status?: BotStatusEnum }>) ?? []
        )
          .filter((b) => b.status === BotStatusEnum.archive)
          .map((b) => `${b._id}`)
        if (archivedIds.length) {
          void ColdStoreArchiver.getInstance()
            .enqueueArchive(userId, coldType, archivedIds)
            .catch((e) =>
              logger.error(
                `[ColdStore] archive trigger failed: ${(e as Error).message}`,
              ),
            )
        }
      }
    }
    return res
  }

  private async _setArchiveStatusImpl(
    userId: string,
    type: BotType,
    botIds: string[],
    archive: boolean,
    paperContext?: boolean,
  ) {
    // Legacy rule: only stopped (`closed`) bots can be archived. Each branch
    // below filters the update on `status: closed`, so archiving a running
    // bot matches 0 docs — but updateMany still reports OK, so the API used
    // to return a false success. The dashboard then hid the bot locally and
    // it reappeared on the next full reload. Fail loudly instead, before
    // closeAllDeals runs, so nothing is mutated on a rejected archive.
    if (archive) {
      const archiveDb = (
        type === BotType.grid
          ? this.botDb
          : type === BotType.combo
            ? this.comboBotDb
            : type === BotType.hedgeCombo
              ? hedgeComboBotDb
              : type === BotType.hedgeDca
                ? hedgeDCABotDb
                : this.dcaBotDb
      ) as { readData: (...args: any[]) => Promise<any> }
      const current = await archiveDb.readData(
        { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
        { _id: true, status: true },
        undefined,
        true,
      )
      if (current.status === StatusEnum.notok) {
        return current
      }
      const notClosed = (current.data?.result ?? []).filter(
        (b: { status?: BotStatusEnum }) => b.status !== BotStatusEnum.closed,
      )
      if (notClosed.length > 0) {
        return {
          status: StatusEnum.notok,
          reason: 'Only stopped bots can be archived. Stop the bot first.',
          data: [],
        }
      }
    }
    if (type === BotType.grid) {
      const findBotsData = await this.botDb.updateManyData(
        {
          status: archive ? BotStatusEnum.closed : BotStatusEnum.archive,
          _id: { $in: botIds },
          userId,
        },
        {
          $set: {
            status: archive ? BotStatusEnum.archive : BotStatusEnum.closed,
            // Un-archive resets `updated` so the bot gets a fresh stopped-age
            // window — auto-archive keys off `updated`, so without this a
            // long-idle bot would be re-archived on the next cron. No-op on archive.
            ...(archive ? {} : { updated: new Date() }),
          },
        },
      )
      if (findBotsData.status === StatusEnum.ok) {
        const result = await this.botDb.readData(
          { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
          { _id: true, status: true },
          undefined,
          true,
        )
        return {
          status: StatusEnum.ok,
          reason: null,
          data: result.data?.result ?? [],
        }
      }
      return findBotsData
    }
    if (type === BotType.combo) {
      await this.closeAllDeals(botIds, type)

      const findComboBotsData = await this.comboBotDb.updateManyData(
        {
          $and: [
            {
              status: archive ? BotStatusEnum.closed : BotStatusEnum.archive,
            },
            { _id: { $in: botIds as any[] } },
            { userId },
          ],
        },
        {
          $set: {
            status: archive ? BotStatusEnum.archive : BotStatusEnum.closed,
            // Un-archive resets `updated` so the bot gets a fresh stopped-age
            // window — auto-archive keys off `updated`, so without this a
            // long-idle bot would be re-archived on the next cron. No-op on archive.
            ...(archive ? {} : { updated: new Date() }),
          },
        },
      )
      if (findComboBotsData.status === StatusEnum.ok) {
        const result = await this.comboBotDb.readData(
          { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
          { _id: true, status: true },
          undefined,
          true,
        )
        botIds.forEach((id) => {
          this.botEventDb.createData({
            userId: userId,
            botId: id,
            botType: type,
            event: BOT_STATUS_EVENT,
            description: 'Bot was archived',
            paperContext: !!paperContext,
          })
        })
        return {
          status: StatusEnum.ok,
          reason: null,
          data: result.data?.result ?? [],
        }
      }
      return findComboBotsData
    }
    if (type === BotType.hedgeCombo) {
      await this.closeAllDeals(botIds, type)

      const findComboBotsData = await hedgeComboBotDb.updateManyData(
        {
          $and: [
            {
              status: archive ? BotStatusEnum.closed : BotStatusEnum.archive,
            },
            { _id: { $in: botIds as any[] } },
            { userId },
          ],
        },
        {
          $set: {
            status: archive ? BotStatusEnum.archive : BotStatusEnum.closed,
            // Un-archive resets `updated` so the bot gets a fresh stopped-age
            // window — auto-archive keys off `updated`, so without this a
            // long-idle bot would be re-archived on the next cron. No-op on archive.
            ...(archive ? {} : { updated: new Date() }),
          },
        },
      )
      if (findComboBotsData.status === StatusEnum.ok) {
        const result = await hedgeComboBotDb.readData(
          { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
          { _id: true, status: true },
          undefined,
          true,
        )
        botIds.forEach((id) => {
          this.botEventDb.createData({
            userId: userId,
            botId: id,
            botType: type,
            event: BOT_STATUS_EVENT,
            description: 'Bot was archived',
            paperContext: !!paperContext,
          })
        })
        return {
          status: StatusEnum.ok,
          reason: null,
          data: result.data?.result ?? [],
        }
      }
      return findComboBotsData
    }
    if (type === BotType.hedgeDca) {
      await this.closeAllDeals(botIds, type)

      const findDcaBotsData = await hedgeDCABotDb.updateManyData(
        {
          $and: [
            {
              status: archive ? BotStatusEnum.closed : BotStatusEnum.archive,
            },
            { _id: { $in: botIds as any[] } },
            { userId },
          ],
        },
        {
          $set: {
            status: archive ? BotStatusEnum.archive : BotStatusEnum.closed,
            // Un-archive resets `updated` so the bot gets a fresh stopped-age
            // window — auto-archive keys off `updated`, so without this a
            // long-idle bot would be re-archived on the next cron. No-op on archive.
            ...(archive ? {} : { updated: new Date() }),
          },
        },
      )
      if (findDcaBotsData.status === StatusEnum.ok) {
        const result = await hedgeDCABotDb.readData(
          { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
          { _id: true, status: true },
          undefined,
          true,
        )
        botIds.forEach((id) => {
          this.botEventDb.createData({
            userId: userId,
            botId: id,
            botType: type,
            event: BOT_STATUS_EVENT,
            description: 'Bot was archived',
            paperContext: !!paperContext,
          })
        })
        return {
          status: StatusEnum.ok,
          reason: null,
          data: result.data?.result ?? [],
        }
      }
      return findDcaBotsData
    }
    await this.closeAllDeals(botIds, type)

    const findDCABotsData = await this.dcaBotDb.updateManyData(
      {
        $and: [
          {
            status: archive ? BotStatusEnum.closed : BotStatusEnum.archive,
          },
          { _id: { $in: botIds as any[] } },
          { userId },
        ],
      },
      {
        $set: {
          status: archive ? BotStatusEnum.archive : BotStatusEnum.closed,
          // Un-archive resets `updated` so the bot gets a fresh stopped-age
          // window — auto-archive keys off `updated`, so without this a
          // long-idle bot would be re-archived on the next cron. No-op on archive.
          ...(archive ? {} : { updated: new Date() }),
        },
      },
    )
    if (findDCABotsData.status === StatusEnum.ok) {
      const result = await this.dcaBotDb.readData(
        { _id: { $in: botIds }, userId, isDeleted: { $ne: true } },
        { _id: true, status: true },
        undefined,
        true,
      )
      botIds.forEach((id) => {
        this.botEventDb.createData({
          userId: userId,
          botId: id,
          botType: type,
          event: BOT_STATUS_EVENT,
          description: 'Bot was archived',
          paperContext: !!paperContext,
        })
      })
      return {
        status: StatusEnum.ok,
        reason: null,
        data: result.data?.result ?? [],
      }
    }
    return findDCABotsData
  }

  public async openDCADeal(
    userId: string,
    botId: string,
    symbol?: string,
    paperContext?: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'openDCADeal',
        false,
        userId,
        botId,
        symbol,
        paperContext,
      )
    }
    const findLocal = this.dcaBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'openNewDealMan',
        args: [symbol],
      })

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.dca,
        event: 'Open DCA deal',
        description: 'DCA deal opened manually',
        paperContext: !!paperContext,
        symbol,
      })
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to start',
      }
    }
    return {
      status: StatusEnum.notok,
      reason: 'Bot is not running',
      data: null,
    }
  }

  public async openComboDeal(
    userId: string,
    botId: string,
    symbol?: string,
    paperContext?: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.combo,
        'openComboDeal',
        false,
        userId,
        botId,
        symbol,
        paperContext,
      )
    }
    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.combo,
        botId: findLocal.id,
        method: 'openNewDealMan',
        args: [symbol],
      })

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.combo,
        event: 'Open Combo deal',
        description: 'Combo deal opened manually',
        paperContext: !!paperContext,
        symbol,
      })
      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to start',
      }
    }
    return {
      status: StatusEnum.notok,
      reason: 'Bot is not running',
      data: null,
    }
  }

  public async closeDCADeal(
    userId: string,
    _botId: string,
    dealId: string,
    type?: CloseDCATypeEnum,
    reopen = true,
    paperContext?: boolean,
    closeTrigger?: DCACloseTriggerEnum,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'closeDCADeal',
        false,
        userId,
        _botId,
        dealId,
        type,
        reopen,
        paperContext,
        closeTrigger,
      )
    }
    const findDeal = await this.dcaDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId

    const findLocal = this.dcaBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    const botData = await this.dcaBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.data?.result?.exchangeUnassigned) {
      await this.dcaDealsDb.updateData(
        { _id: dealId },
        { $set: { status: DCADealStatusEnum.canceled } },
      )
      await this.dcaBotDb.updateData(
        { _id: botId },
        { $inc: { 'deals.active': -1 } },
      )
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal will be canceled',
      }
    }
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'closeDealById',
        args: [
          botId,
          dealId,
          type,
          reopen,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          closeTrigger ?? DCACloseTriggerEnum.manual,
        ],
      })

      this.botEventDb.createData({
        userId: userId,
        botId,
        botType: BotType.dca,
        event: 'Close DCA deal',
        description: `DCA deal closed manually, id: ${dealId}`,
        paperContext: !!paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to be closed',
      }
    } else {
      if (botData.status === StatusEnum.notok) {
        return botData
      }
      if (!botData.data.result) {
        const deletedBot = await this.dcaBotDb.readData({
          _id: botId,
          userId,
          isDeleted: true,
        })
        if (deletedBot.status === StatusEnum.notok) {
          return deletedBot
        }
        if (deletedBot.data.result) {
          this.handleLog(`Bot ${botId} is deleted. Cancel deal ${dealId}`)
          const cancelRes = await this.dcaDealsDb.updateData(
            { _id: dealId, botId },
            { $set: { status: DCADealStatusEnum.canceled } },
          )
          if (cancelRes.status === StatusEnum.notok) {
            return cancelRes
          }
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            reason: null,
            data: 'Deal scheduled to be closed',
          }
        }
        return this.entityNotFound('Bot')
      }
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        botData.data.result.exchange,
        botData.data?.result?.uuid || '',
        [botId, botData.data.result.exchange, true, true],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'start',
            args: [true, undefined, BotStatusEnum.open],
          })
          if (botData.data.result.status === BotStatusEnum.closed) {
            worker.postMessage({
              do: 'method',
              botType: BotType.dca,
              botId,
              method: 'stop',
              args: [CloseDCATypeEnum.leave],
            })
          }
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'closeDealById',
            args: [
              botId,
              dealId,
              type,
              reopen,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              closeTrigger ?? DCACloseTriggerEnum.manual,
            ],
          })
        },
        !!paperContext,
        botData.data.result.settings.type ?? DCATypeEnum.regular,
      )

      this.botEventDb.createData({
        userId: userId,
        botId: _botId,
        botType: BotType.dca,
        event: 'Close DCA deal',
        description: `DCA deal closed manually, id: ${dealId}`,
        paperContext: !!paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to be closed',
      }
    }
  }

  /**
   * Restore a canceled DCA or terminal deal IN PLACE — bring it back as an
   * active bare position inside its own bot (no DCA, take profit or stop loss).
   *
   * Canceling a deal only cancels its open orders and marks it `canceled`; the
   * filled base position and the deal document survive. So we flip the deal
   * back to `open`, strip DCA/TP/SL at the deal level (deal settings override
   * bot settings in getAggregatedSettings), clear the close markers, and reload
   * the bot so its worker re-adopts the deal from the DB (the load path only
   * pulls `open`/`error`/`start` deals, so a canceled deal is invisible until
   * flipped). No new bot is created — the deal returns to the bot it lived in
   * (a terminal deal's bot is a terminal bot, so terminal deals restore in the
   * terminal).
   */
  public async restoreDeal(
    userId: string,
    _botId: string,
    dealId: string,
    paperContext?: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'restoreDeal',
        false,
        userId,
        _botId,
        dealId,
        paperContext,
      )
    }
    const findDeal = await this.dcaDealsDb.readData({
      _id: dealId,
      status: DCADealStatusEnum.canceled,
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId

    // Reactivate the deal as a bare position: no DCA/TP/SL, close markers
    // cleared, status back to open.
    const restore = await this.dcaDealsDb.updateData({ _id: dealId, botId }, {
      $set: {
        status: DCADealStatusEnum.open,
        'settings.useDca': false,
        'settings.useTp': false,
        'settings.useSl': false,
        closeBySl: false,
        closeByTp: false,
        notCheckSl: false,
        blockSl: false,
      },
      $unset: { closeTrigger: '', closeTime: '' },
    } as any)
    if (restore.status === StatusEnum.notok) {
      return restore
    }
    await this.dcaBotDb.updateData(
      { _id: botId },
      { $inc: { 'deals.active': 1 } },
    )
    this.botEventDb.createData({
      userId,
      botId,
      botType: BotType.dca,
      event: 'Restore DCA deal',
      description: `DCA deal restored as a bare active position (no DCA/TP/SL), id: ${dealId}`,
      paperContext: !!paperContext,
      deal: dealId,
      symbol: findDeal.data.result.symbol.symbol,
    })

    const findLocal = this.dcaBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (findLocal) {
      // Bot worker is running — reload it so it re-adopts the now-open deal.
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'reloadBot',
        args: [botId, false],
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to restore',
      }
    }

    // Bot worker isn't running — start it so the load path picks up the deal.
    const botData = await this.dcaBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.status === StatusEnum.notok) {
      return botData
    }
    if (!botData.data.result) {
      return this.entityNotFound('Bot')
    }
    await this.createNewBot(
      botId,
      BotType.dca,
      userId,
      botData.data.result.exchange,
      botData.data?.result?.uuid || '',
      [botId, botData.data.result.exchange, true, true],
      (worker) => {
        worker.postMessage({
          do: 'method',
          botType: BotType.dca,
          botId,
          method: 'start',
          args: [true, undefined, BotStatusEnum.open],
        })
      },
      !!paperContext,
      botData.data.result.settings.type ?? DCATypeEnum.regular,
    )
    return {
      status: StatusEnum.ok as StatusEnum.ok,
      reason: null,
      data: 'Deal scheduled to restore',
    }
  }

  public async closeComboDeal(
    userId: string,
    _botId: string,
    dealId: string,
    type?: CloseDCATypeEnum,
    reopen = true,
    paperContext?: boolean,
    closeTrigger?: DCACloseTriggerEnum,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.combo,
        'closeComboDeal',
        false,
        userId,
        _botId,
        dealId,
        type,
        reopen,
        paperContext,
        closeTrigger,
      )
    }
    const findDeal = await this.comboDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId

    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    const botData = await this.comboBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.data?.result?.exchangeUnassigned) {
      await this.comboDealsDb.updateData(
        { _id: dealId },
        { $set: { status: DCADealStatusEnum.canceled } },
      )
      await this.comboBotDb.updateData(
        { _id: botId },
        { $inc: { 'deals.active': -1 } },
      )
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal will be canceled',
      }
    }
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.combo,
        botId,
        method: 'closeDealById',
        args: [
          botId,
          dealId,
          type,
          reopen,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          closeTrigger ?? DCACloseTriggerEnum.manual,
        ],
      })

      this.botEventDb.createData({
        userId: userId,
        botId,
        botType: BotType.combo,
        event: 'Close Combo deal',
        description: `Combo deal closed manually, id: ${dealId}`,
        paperContext: !!paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to be closed',
      }
    } else {
      if (botData.status === StatusEnum.notok) {
        return botData
      }
      if (!botData.data.result) {
        const deletedBot = await this.comboBotDb.readData({
          _id: botId,
          userId,
          isDeleted: true,
        })
        if (deletedBot.status === StatusEnum.notok) {
          return deletedBot
        }
        if (deletedBot.data.result) {
          this.handleLog(`Bot ${botId} is deleted. Cancel deal ${dealId}`)
          const cancelRes = await this.comboDealsDb.updateData(
            { _id: dealId, botId },
            { $set: { status: DCADealStatusEnum.canceled } },
          )
          if (cancelRes.status === StatusEnum.notok) {
            return cancelRes
          }
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            reason: null,
            data: 'Deal scheduled to be closed',
          }
        }
        return this.entityNotFound('Bot')
      }
      await this.createNewBot(
        botId,
        BotType.combo,
        userId,
        botData.data.result.exchange,
        botData.data?.result?.uuid || '',
        [botId, botData.data.result.exchange, true, true],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId,
            method: 'start',
            args: [true, undefined, BotStatusEnum.open],
          })
          if (botData.data.result.status === BotStatusEnum.closed) {
            worker.postMessage({
              do: 'method',
              botType: BotType.combo,
              botId,
              method: 'stop',
              args: [CloseDCATypeEnum.leave],
            })
          }
          worker.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId,
            method: 'closeDealById',
            args: [
              botId,
              dealId,
              type,
              reopen,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              closeTrigger ?? DCACloseTriggerEnum.manual,
            ],
          })
        },
        !!paperContext,
      )

      this.botEventDb.createData({
        userId: userId,
        botId: _botId,
        botType: BotType.combo,
        event: 'Close Combo deal',
        description: `Combo deal closed manually, id: ${dealId}`,
        paperContext: !!paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: 'Deal scheduled to be closed',
      }
    }
  }

  public async mergeDeals(
    userId: string,
    botId: string,
    dealIds: string[],
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'mergeDeals',
        false,
        userId,
        botId,
        dealIds,
        paperContext,
      )
    }
    const findLocal = this.dcaBots.find((d) => d.id === botId && d.userId)
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'mergeDeals',
        args: [dealIds],
      })

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.dca,
        event: 'Merge DCA deals',
        description: `DCA deals was merged: ${dealIds.join(' ')}`,
        paperContext,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: `Request to merge ${dealIds.length} deals sent`,
      }
    }
    const botData = await this.dcaBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.data?.result) {
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        botData.data.result.exchange,
        botData.data?.result?.uuid || '',
        [botId, botData.data.result.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'mergeDeals',
            args: [dealIds],
          })
        },
        paperContext,
        botData.data.result.settings.type ?? DCATypeEnum.regular,
      )

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.dca,
        event: 'Merge DCA deals',
        description: `DCA deals was merged: ${dealIds.join(' ')}`,
        paperContext,
      })
    } else {
      return this.entityNotFound('Bot')
    }

    return {
      status: StatusEnum.ok as StatusEnum.ok,
      reason: null,
      data: 'Deal scheduled to be closed',
    }
  }

  public async mergeComboDeals(
    userId: string,
    botId: string,
    dealIds: string[],
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.combo,
        'mergeComboDeals',
        false,
        userId,
        botId,
        dealIds,
        paperContext,
      )
    }
    const findLocal = this.comboBots.find((d) => d.id === botId && d.userId)
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.combo,
        botId,
        method: 'mergeDeals',
        args: [dealIds],
      })

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.combo,
        event: 'Merge Combo deals',
        description: `Combo deals was merged: ${dealIds.join(' ')}`,
        paperContext,
      })
      return {
        status: StatusEnum.ok as StatusEnum.ok,
        reason: null,
        data: `Request to merge ${dealIds.length} deals sent`,
      }
    }
    const botData = await this.comboBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.data?.result) {
      await this.createNewBot(
        botId,
        BotType.combo,
        userId,
        botData.data.result.exchange,
        botData.data?.result?.uuid || '',
        [botId, botData.data.result.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.combo,
            botId,
            method: 'mergeDeals',
            args: [dealIds],
          })
        },
        !!paperContext,
      )

      this.botEventDb.createData({
        userId: userId,
        botId: botId,
        botType: BotType.combo,
        event: 'Merge Combo deals',
        description: `Combo deals was merged: ${dealIds.join(' ')}`,
        paperContext,
      })
    } else {
      return this.entityNotFound('Bot')
    }

    return {
      status: StatusEnum.ok as StatusEnum.ok,
      reason: null,
      data: 'Deal scheduled to be closed',
    }
  }

  public async webhookProcess(
    data: WebhookData[] | WebhookData,
    ignoreSettings = false,
  ) {
    if (!this.useBots) {
      try {
        const dcas: WebhookData[] = []
        const combos: WebhookData[] = []
        const hedgeCombos: WebhookData[] = []
        const hedgeDcas: WebhookData[] = []
        for (const d of [data].flat()) {
          const dca = await this.dcaBotDb.readData({ uuid: d.uuid })
          if (dca?.data?.result) {
            dcas.push(d)
          } else {
            const combo = await this.comboBotDb.readData({ uuid: d.uuid })
            if (combo?.data?.result) {
              combos.push(d)
            } else {
              const hedgeCombo = await hedgeComboBotDb.readData({
                uuid: d.uuid,
              })
              if (hedgeCombo?.data?.result) {
                hedgeCombos.push(d)
              } else {
                const hedgeDca = await hedgeDCABotDb.readData({
                  uuid: d.uuid,
                })
                if (hedgeDca?.data?.result) {
                  hedgeDcas.push(d)
                }
              }
            }
          }
        }
        if (
          dcas.length &&
          combos.length &&
          hedgeCombos.length &&
          hedgeDcas.length
        ) {
          await this.callExternalBotService(
            BotType.dca,
            'webhookProcess',
            false,
            dcas,
            ignoreSettings,
          )
          await this.callExternalBotService(
            BotType.combo,
            'webhookProcess',
            false,
            combos,
            ignoreSettings,
          )
          await this.callExternalBotService(
            BotType.hedgeCombo,
            'webhookProcess',
            false,
            hedgeCombos,
            ignoreSettings,
          )
          return await this.callExternalBotService(
            BotType.hedgeDca,
            'webhookProcess',
            false,
            hedgeDcas,
            ignoreSettings,
          )
        }
        if (dcas.length) {
          return await this.callExternalBotService(
            BotType.dca,
            'webhookProcess',
            false,
            dcas,
            ignoreSettings,
          )
        }
        if (combos.length) {
          return await this.callExternalBotService(
            BotType.combo,
            'webhookProcess',
            false,
            combos,
            ignoreSettings,
          )
        }
        if (hedgeCombos.length) {
          return await this.callExternalBotService(
            BotType.hedgeCombo,
            'webhookProcess',
            false,
            hedgeCombos,
            ignoreSettings,
          )
        }
        if (hedgeDcas.length) {
          return await this.callExternalBotService(
            BotType.hedgeDca,
            'webhookProcess',
            false,
            hedgeDcas,
            ignoreSettings,
          )
        }
        // Not one item resolved to a bot. This used to answer StatusEnum.ok,
        // so /trade_signal replied 200 to a signal it then dropped on the
        // floor — the single most misleading response the endpoint had, since
        // the sender (TradingView, n8n, a script) reads 200 as "delivered".
        // The overwhelmingly common cause is a payload carrying the bot's
        // Mongo `_id` instead of its `uuid`; both are opaque ids, so nothing
        // about the 200 told the user which one they had wrong.
        this.handleWarn(
          `Webhook signal for ${[data]
            .flat()
            .map((d) => d?.uuid ?? 'no-uuid')
            .join(', ')} matched no bot`,
        )
        return this.entityNotFound('Bot')
      } catch (e) {
        if ((e as Error)?.message === notAvailable) {
          this.handleWarn(
            'External service not available in webhook process. Will add to the queue',
          )
          this.rabbit.send(webhookQueue, data)
        }
      }
      return
    }
    if (BotServiceType === BotType.grid) {
      return StatusEnum.ok
    }
    for (const d of [data].flat()) {
      const result = await this.singleWebhookProcess(d, ignoreSettings)
      if ([data].flat().length === 1) {
        return result ?? StatusEnum.ok
      }
    }
    return StatusEnum.ok
  }

  @IdMute(mutex, (data?: WebhookData) => `${data?.uuid}singleWebhookProcess`)
  private async singleWebhookProcess(
    data: WebhookData,
    ignoreSettings = false,
  ) {
    if (!data) {
      return {
        status: StatusEnum.notok as const,
        reason: 'Empty webhook payload',
        data: null,
      }
    }
    const {
      action,
      uuid,
      symbol,
      qty,
      asset,
      pairsToSet,
      pairsToSetMode,
      closeType,
      type,
    } = data
    // A payload missing either field fell off the end of this method and
    // returned undefined, which webhookProcess reads as StatusEnum.ok — the
    // same silent 200 an unresolvable uuid used to get. Name the missing
    // field instead; it is almost always a template that rendered empty.
    const missing = missingWebhookFields(data)
    if (missing.length) {
      const reason = missingWebhookFieldsReason(missing)
      this.handleWarn(reason)
      return {
        status: StatusEnum.notok as const,
        reason,
        data: null,
      }
    }
    if (action && uuid) {
      let call: (() => unknown) | undefined
      // The cold-start path posts to the worker directly instead of setting
      // `call`, so it has to say so explicitly — otherwise the
      // nothing-was-dispatched guard at the end would reject a success.
      let dispatched = false
      let failReason: string | undefined
      let findBot = this.dcaBots.find((b) => b.uuid === uuid)
      if (!findBot) {
        //@ts-ignore
        findBot = this.comboBots.find((b) => b.uuid === uuid)
      }
      if (!findBot) {
        //@ts-ignore
        findBot = this.hedgeComboBots.find((b) => b.uuid === uuid)
      }
      const event: Omit<CleanBotEventSchema, '_id'> = {
        botId: '',
        botType: BotType.dca,
        userId: '',
        event: 'Webhook',
        description: 'Received webhook action',
        metadata: '',
        paperContext: false,
      }
      if (action === WebhookActionEnum.startBot) {
        if (findBot && findBot.dcaType !== DCATypeEnum.terminal) {
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'setStatus',
              args: [findBot.id, BotStatusEnum.open, undefined, true],
            })
        } else {
          let combo = false
          let hedgeCombo = false
          let hedgeDca = false
          let botData = await this.dcaBotDb.readData({
            uuid,
            isDeleted: { $ne: true },
          })
          if (!botData.data?.result) {
            //@ts-ignore
            botData = await this.comboBotDb.readData({
              uuid,
              isDeleted: { $ne: true },
            })

            combo = !!botData.data?.result
          }
          if (!botData.data?.result) {
            //@ts-ignore
            botData = await hedgeComboBotDb.readData(
              {
                uuid,
                isDeleted: { $ne: true },
              },
              {},
              { populate: 'bots' },
            )

            hedgeCombo = !!botData.data?.result
          }
          if (!botData.data?.result) {
            //@ts-ignore
            botData = await hedgeDCABotDb.readData(
              {
                uuid,
                isDeleted: { $ne: true },
              },
              {},
              { populate: 'bots' },
            )

            hedgeDca = !!botData.data?.result
          }
          if (
            hedgeDca ||
            hedgeCombo ||
            botData.data?.result?.settings.type !== DCATypeEnum.terminal
          ) {
            if (botData.data?.result) {
              this.handleDebug(`Received ${action} signal for ${uuid}`)
              const id = botData.data.result._id.toString()
              const type = hedgeDca
                ? BotType.hedgeDca
                : hedgeCombo
                  ? BotType.hedgeCombo
                  : combo
                    ? BotType.combo
                    : BotType.dca
              await new Promise(
                async (resolve) =>
                  await this.createNewBot(
                    id,
                    type,
                    botData?.data?.result?.userId ?? '',
                    botData?.data?.result?.exchange ?? ExchangeEnum.binance,
                    uuid,
                    hedgeDca
                      ? [
                          {
                            botType: BotType.hedgeDca,
                            id,
                            //@ts-ignore
                            bots: botData.data?.result.bots.map((d) => ({
                              id: `${d._id}`,
                              type: BotType.dca,
                            })),
                            paperContext: botData.data?.result.paperContext,
                            userId: botData.data?.result.userId,
                          },
                        ]
                      : hedgeCombo
                        ? [
                            {
                              botType: BotType.hedgeCombo,
                              id,
                              //@ts-ignore
                              bots: botData.data?.result.bots.map((d) => ({
                                id: `${d._id}`,
                                type: BotType.combo,
                              })),
                              paperContext: botData.data?.result.paperContext,
                              userId: botData.data?.result.userId,
                            },
                          ]
                        : [
                            id,
                            botData?.data?.result?.exchange ??
                              ExchangeEnum.binance,
                          ],
                    (worker) => {
                      worker.postMessage({
                        do: 'method',
                        botType: type,
                        botId: id,
                        method: 'setStatus',
                        args: [id, BotStatusEnum.open, undefined, true],
                      })
                      resolve([])
                    },
                    !!botData?.data?.result?.paperContext,
                    botData.data?.result?.settings?.type ?? DCATypeEnum.regular,
                  ),
              )
              event.botId = id
              event.userId = botData.data.result.userId
              event.botType = type
              event.metadata = JSON.stringify({ action })
              event.paperContext = !!botData.data.result.paperContext
              dispatched = true
            } else {
              this.handleWarn(
                `Received ${action} signal for ${uuid}, but bot not found`,
              )
              return this.entityNotFound('Bot')
            }
          } else {
            this.handleWarn(
              `Received ${action} signal for ${uuid}, but bot is terminal`,
            )
            failReason = `Action "${action}" is not available for a terminal bot`
          }
        }
      }
      if (
        !findBot &&
        action !== WebhookActionEnum.startBot &&
        action !== WebhookActionEnum.changePairs
      ) {
        this.handleDebug(
          `Received ${action} signal for ${uuid}, but bot is not running`,
        )
        return this.entityNotFound('Bot')
      }
      if (
        !findBot &&
        action === WebhookActionEnum.changePairs &&
        BotServiceType === BotType.dca
      ) {
        const botData = await this.dcaBotDb.readData({
          uuid,
          isDeleted: { $ne: true },
        })

        if (botData.data?.result?.settings?.type !== DCATypeEnum.terminal) {
          if (botData.data?.result) {
            const id = botData.data.result._id.toString()
            const type = BotType.dca
            await this.createNewBot(
              id,
              type,
              botData.data.result.userId,
              botData.data.result.exchange,
              uuid,
              [id, botData.data.result.exchange],
              () => void 0,
              !!botData.data.result.paperContext,
              botData?.data?.result?.settings?.type ?? DCATypeEnum.regular,
            )
          } else {
            this.handleWarn(
              `Received ${action} signal for ${uuid}, but bot not found`,
            )
            return this.entityNotFound('Bot')
          }
        } else {
          this.handleWarn(
            `Received ${action} signal for ${uuid}, but bot is terminal`,
          )
          failReason = `Action "${action}" is not available for a terminal bot`
        }
        findBot = this.dcaBots.find((b) => b.uuid === uuid)
      }
      if (findBot) {
        event.botId = findBot.id
        event.userId = findBot.userId
        event.botType = findBot.type
        event.paperContext = findBot.paperContext
        if (action === WebhookActionEnum.start) {
          event.metadata = JSON.stringify({ action, symbol })
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'openDealBySignal',
              args: [findBot.id, symbol, ignoreSettings],
            })
        }
        if (
          action === WebhookActionEnum.close ||
          action === WebhookActionEnum.closeSl
        ) {
          event.metadata = JSON.stringify({ action, symbol })
          event.symbol = symbol
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'closeDealBySignal',
              args: [
                symbol,
                ignoreSettings,
                action === WebhookActionEnum.closeSl,
              ],
            })
        }

        if (
          action === WebhookActionEnum.stopBot &&
          findBot.dcaType !== DCATypeEnum.terminal
        ) {
          event.metadata = JSON.stringify({ action })
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'setStatus',
              args: [
                findBot.id,
                BotStatusEnum.closed,
                undefined,
                true,
                undefined,
                undefined,
                closeType === 'limit'
                  ? CloseDCATypeEnum.closeByLimit
                  : closeType === 'market'
                    ? CloseDCATypeEnum.closeByMarket
                    : closeType === 'cancel'
                      ? CloseDCATypeEnum.cancel
                      : CloseDCATypeEnum.leave,
              ],
            })
        }
        if (
          action === WebhookActionEnum.addFunds &&
          qty &&
          qty !== '' &&
          asset &&
          asset !== ''
        ) {
          event.metadata = JSON.stringify({ action, symbol, qty, asset })
          event.symbol = symbol
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'addFundsForAllDeals',
              args: [qty, asset as OrderSizeTypeEnum, symbol, type, true],
            })
        }
        if (
          action === WebhookActionEnum.reduceFunds &&
          qty &&
          qty !== '' &&
          asset &&
          asset !== ''
        ) {
          event.metadata = JSON.stringify({ action, symbol, qty, asset })
          event.symbol = symbol
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = () =>
            findBot &&
            this.getWorkerById(findBot.worker)?.postMessage({
              do: 'method',
              botType: findBot.type,
              botId: findBot.id,
              method: 'reduceFundsInAllDeals',
              args: [qty, asset as OrderSizeTypeEnum, symbol, type, true],
            })
        }
        if (
          action === WebhookActionEnum.changePairs &&
          pairsToSet &&
          findBot.dcaType !== DCATypeEnum.terminal
        ) {
          event.metadata = JSON.stringify({ action, pairsToSet })
          this.handleDebug(`Received ${action} signal for ${uuid}`)
          call = async () =>
            findBot &&
            (await this.changeDCABotPairs(
              findBot.userId,
              findBot.id,
              undefined,
              undefined,
              pairsToSet,
              pairsToSetMode,
            ))
        }
      }
      // Nothing matched — an unknown action name, or a known one whose
      // required params/bot state were missing. Both used to fall through to
      // `return undefined`, which webhookProcess turned into StatusEnum.ok and
      // the /trade_signal route answered 200: a silent no-op that reads as
      // success. Say what happened instead.
      if (!call && !dispatched) {
        const reason =
          failReason ??
          (implementedWebhookActions.includes(action)
            ? `Action "${action}" could not be executed for bot ${uuid}. Check that the bot supports it and that all required parameters are present.`
            : `Unknown action "${action}". Supported actions: ${implementedWebhookActions.join(', ')}`)
        this.handleWarn(
          `Received ${action} signal for ${uuid}, but nothing was dispatched: ${reason}`,
        )
        return {
          status: StatusEnum.notok as const,
          reason,
          data: null,
        }
      }
      if (event.botId) {
        this.botEventDb.createData(event)
      }
      const result = call && (await call())
      if (result) {
        this.handleDebug(
          `Response ${action} signal for ${uuid}: ${JSON.stringify(result)}`,
        )
      }
      return result
    }
  }

  public async addDealFundsFromPublicApi(
    userId: string,
    botId: string | undefined,
    qty: string,
    asset: OrderSizeTypeEnum,
    symbol?: string,
    type?: AddFundsTypeEnum,
    dealId?: string,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'addDealFundsFromPublicApi',
        false,
        userId,
        botId,
        qty,
        asset,
        symbol,
        type,
        dealId,
      )
    }
    let botIdToUse = botId
    if (!botIdToUse && dealId) {
      const findDeal = await this.dcaDealsDb.readData({
        _id: dealId,
        userId,
      })
      if (findDeal.status === StatusEnum.notok) {
        return findDeal
      }
      if (!findDeal.data?.result) {
        return this.entityNotFound('Deal')
      }
      botIdToUse = findDeal.data.result.botId
    }
    if (botId) {
      const bot = await this.dcaBotDb.readData(
        { userId, _id: botId },
        undefined,
        {},
        false,
        false,
      )
      if (bot.reason === StatusEnum.notok) {
        return bot
      }
      if (!bot.data?.result) {
        return this.entityNotFound('Bot')
      }
    }
    const findBot = this.dcaBots.find((b) => b.id === botIdToUse)
    if (findBot) {
      this.getWorkerById(findBot.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findBot.id,
        method: 'addFundsForAllDeals',
        args: [
          qty,
          asset,
          symbol,
          type,
          undefined,
          undefined,
          undefined,
          dealId,
        ],
      })

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Add funds scheduled',
      }
    } else {
      return {
        status: StatusEnum.notok,
        reason: 'Bot is not running',
        data: null,
      }
    }
  }

  public async reduceDealFundsFromPublicApi(
    userId: string,
    botId: string | undefined,
    qty: string,
    asset: OrderSizeTypeEnum,
    symbol?: string,
    type?: AddFundsTypeEnum,
    dealId?: string,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'reduceDealFundsFromPublicApi',
        false,
        userId,
        botId,
        qty,
        asset,
        symbol,
        type,
        dealId,
      )
    }
    let botIdToUse = botId
    if (!botIdToUse && dealId) {
      const findDeal = await this.dcaDealsDb.readData({
        _id: dealId,
        userId,
      })
      if (findDeal.status === StatusEnum.notok) {
        return findDeal
      }
      if (!findDeal.data?.result) {
        return this.entityNotFound('Deal')
      }
      botIdToUse = findDeal.data.result.botId
    }
    if (botId) {
      const bot = await this.dcaBotDb.readData(
        { userId, _id: botId },
        undefined,
        {},
        false,
        false,
      )
      if (bot.reason === StatusEnum.notok) {
        return bot
      }
      if (!bot.data?.result) {
        return this.entityNotFound('Bot')
      }
    }
    const findBot = this.dcaBots.find((b) => b.id === botIdToUse)
    if (findBot) {
      this.getWorkerById(findBot.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findBot.id,
        method: 'reduceFundsInAllDeals',
        args: [
          qty,
          asset,
          symbol,
          type,
          undefined,
          undefined,
          undefined,
          dealId,
        ],
      })

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Reduce funds scheduled',
      }
    } else {
      return {
        status: StatusEnum.notok,
        reason: 'Bot is not running',
        data: null,
      }
    }
  }

  public async updateDCADealSettings(
    userId: string,
    _botId: string,
    dealId: string,
    settings: Partial<DCADealsSettings>,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'updateDCADealSettings',
        false,
        userId,
        _botId,
        dealId,
        settings,
      )
    }
    const findDeal = await this.dcaDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId
    const findLocal = this.dcaBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    let changedString = ''
    Object.entries(settings).map(([key, value]) => {
      if (key in findDeal.data.result.settings) {
        //@ts-ignore
        const oldValue = findDeal.data.result.settings[key]
        if (`${oldValue}` !== `${value}`)
          changedString = `${changedString}${
            changedString.length ? ', ' : ''
          }${this.botSettingsKeyToPropertyName(
            key as keyof BotSchema['settings'],
          )}: ${oldValue} -> ${value}`
      }
    })
    const updateDealSettingsEvent = () =>
      this.botEventDb.createData({
        userId: userId,
        botId,
        botType: BotType.dca,
        event: 'Deal change',
        description: changedString,
        paperContext: !!findDeal.data.result.paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
        metadata: JSON.stringify(
          getObjectsDiff(
            { ...findDeal.data.result.settings },
            { ...findDeal.data.result.settings, ...settings },
          ),
        ),
      })
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'updateDealSettings',
        args: [dealId, settings],
      })
      updateDealSettingsEvent()

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Settings update scheduled',
      }
    }
    const botData = await this.dcaBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.status === StatusEnum.notok) {
      return botData
    }
    if (!botData.data.result) {
      return this.entityNotFound('Bot')
    }
    await this.createNewBot(
      botId,
      BotType.dca,
      userId,
      botData.data.result.exchange,
      botData.data?.result?.uuid || '',
      [botId, botData.data.result.exchange],
      (worker) => {
        worker.postMessage({
          do: 'method',
          botType: BotType.dca,
          botId,
          method: 'updateDealSettings',
          args: [dealId, settings],
        })
        updateDealSettingsEvent()
      },
      !!findDeal.data.result.paperContext,
      botData.data.result.settings.type ?? DCATypeEnum.regular,
    )

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Settings updated',
    }
  }

  public async updateComboDealSettings(
    userId: string,
    _botId: string,
    dealId: string,
    settings: Partial<ComboDealsSettings>,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.combo,
        'updateComboDealSettings',
        false,
        userId,
        _botId,
        dealId,
        settings,
      )
    }
    const findDeal = await this.comboDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId
    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    let changedString = ''
    Object.entries(settings).map(([key, value]) => {
      if (key in findDeal.data.result.settings) {
        //@ts-ignore
        const oldValue = findDeal.data.result.settings[key]
        if (`${oldValue}` !== `${value}`)
          changedString = `${changedString}${
            changedString.length ? ', ' : ''
          }${this.botSettingsKeyToPropertyName(
            key as keyof BotSchema['settings'],
          )}: ${oldValue} -> ${value}`
      }
    })
    const updateDealSettingsEvent = () =>
      this.botEventDb.createData({
        userId: userId,
        botId,
        botType: BotType.combo,
        event: 'Deal change',
        description: changedString,
        paperContext: !!findDeal.data.result.paperContext,
        deal: dealId,
        symbol: findDeal.data.result.symbol.symbol,
        metadata: JSON.stringify(
          getObjectsDiff(
            { ...findDeal.data.result.settings },
            { ...findDeal.data.result.settings, ...settings },
          ),
        ),
      })
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.combo,
        botId: findLocal.id,
        method: 'updateDealSettings',
        args: [dealId, settings],
      })
      updateDealSettingsEvent()

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Settings update scheduled',
      }
    }
    const botData = await this.comboBotDb.readData({
      _id: botId,
      userId,
      isDeleted: { $ne: true },
    })
    if (botData.status === StatusEnum.notok) {
      return botData
    }
    if (!botData.data.result) {
      return this.entityNotFound('Bot')
    }
    await this.createNewBot(
      botId,
      BotType.combo,
      userId,
      botData.data.result.exchange,
      botData.data?.result?.uuid || '',
      [botId, botData.data.result.exchange],
      (worker) => {
        worker.postMessage({
          do: 'method',
          botType: BotType.combo,
          botId,
          method: 'updateDealSettings',
          args: [dealId, settings],
        })
        updateDealSettingsEvent()
      },
      !!findDeal.data.result.paperContext,
    )

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Settings updated',
    }
  }

  public async resetDealSettings(
    userId: string,
    botId: string,
    dealId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'resetDealSettings',
        false,
        userId,
        botId,
        dealId,
        paperContext,
      )
    }
    this.botEventDb.createData({
      userId: userId,
      botId: botId,
      botType: BotType.dca,
      event: 'Reset DCA deal settings',
      metadata: { dealId },
      paperContext,
      deal: dealId,
    })
    const findLocal = this.dcaBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId,
        method: 'resetDealSettings',
        args: [dealId],
      })

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Settings updated',
      }
    }
    return this.entityNotFound('Bot')
  }

  public async resetComboDealSettings(
    userId: string,
    botId: string,
    dealId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.combo,
        'resetComboDealSettings',
        false,
        userId,
        botId,
        dealId,
        paperContext,
      )
    }
    this.botEventDb.createData({
      userId: userId,
      botId: botId,
      botType: BotType.combo,
      event: 'Reset Combo deal settings',
      metadata: { dealId },
      paperContext,
      deal: dealId,
    })
    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (findLocal) {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.combo,
        botId,
        method: 'resetDealSettings',
        args: [dealId],
      })

      return {
        status: StatusEnum.ok,
        reason: null,
        data: 'Settings updated',
      }
    }
    return this.entityNotFound('Bot')
  }

  public async deleteAllUserPaperBots(userId: string) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        'all',
        'deleteAllUserPaperBots',
        false,
        userId,
      )
    }
    const requests: Promise<BaseReturn>[] = []
    const bots = await this.botDb.readData(
      {
        userId,
        paperContext: true,
      },
      undefined,
      undefined,
      true,
    )
    const dcaBots = await this.dcaBotDb.readData(
      {
        userId,
        paperContext: true,
      },
      undefined,
      undefined,
      true,
    )
    const comboBots = await this.comboBotDb.readData(
      {
        userId,
        paperContext: true,
      },
      undefined,
      undefined,
      true,
    )
    const hedgeComboBots = await hedgeComboBotDb.readData(
      {
        userId,
        paperContext: true,
      },
      undefined,
      undefined,
      true,
    )
    if (hedgeComboBots.status === StatusEnum.notok) {
      return hedgeComboBots
    }
    const hedgeDcaBots = await hedgeDCABotDb.readData(
      {
        userId,
        paperContext: true,
      },
      undefined,
      undefined,
      true,
    )
    if (hedgeDcaBots.status === StatusEnum.notok) {
      return hedgeDcaBots
    }
    if (comboBots.status === StatusEnum.notok) {
      return comboBots
    }
    if (dcaBots.status === StatusEnum.notok) {
      return dcaBots
    }
    if (bots.status === StatusEnum.notok) {
      return bots
    }
    let paperGridBots = 0
    let paperTradingBots = 0
    let paperComboBots = 0
    bots.data.result.forEach((b) => {
      const _id = b._id.toString()
      const find = this.bots.find((bot) => bot.id === _id)
      if (
        find &&
        [
          BotStatusEnum.error,
          BotStatusEnum.range,
          BotStatusEnum.open,
          BotStatusEnum.monitoring,
        ].includes(b.status)
      ) {
        const worker = this.getWorkerById(find.worker)
        paperGridBots += 1
        worker?.postMessage({
          do: 'method',
          botType: BotType.grid,
          botId: find.id,
          method: 'setStatus',
          args: [true, undefined, true, undefined, undefined, undefined, true],
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.grid,
          botId: find.id,
        })

        this.bots = this.bots.filter((bot) => bot.id !== _id)
      }
    })
    dcaBots.data.result.forEach((b) => {
      const _id = b._id.toString()
      const find = this.dcaBots.find((bot) => bot.id === _id)
      if (
        find &&
        [
          BotStatusEnum.error,
          BotStatusEnum.range,
          BotStatusEnum.open,
          BotStatusEnum.monitoring,
        ].includes(b.status)
      ) {
        const worker = this.getWorkerById(find.worker)
        paperTradingBots += 1
        //TODO: update set status araguments
        worker?.postMessage({
          do: 'method',
          botType: BotType.dca,
          botId: find.id,
          method: 'setStatus',
          args: [CloseDCATypeEnum.cancel, true, true, undefined, true],
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.dca,
          botId: find.id,
        })

        this.dcaBots = this.dcaBots.filter((bot) => bot.id !== _id)
      }
    })
    comboBots.data.result.forEach((b) => {
      const _id = b._id.toString()
      const find = this.comboBots.find((bot) => bot.id === _id)
      if (
        find &&
        [
          BotStatusEnum.error,
          BotStatusEnum.range,
          BotStatusEnum.open,
          BotStatusEnum.monitoring,
        ].includes(b.status)
      ) {
        paperComboBots += 1
        const worker = this.getWorkerById(find.worker)
        worker?.postMessage({
          do: 'method',
          botType: BotType.combo,
          botId: find.id,
          method: 'setStatus',
          args: [CloseDCATypeEnum.cancel, true, true, undefined, true],
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.combo,
          botId: find.id,
        })

        this.comboBots = this.comboBots.filter((bot) => bot.id !== _id)
      }
    })
    hedgeComboBots.data.result.forEach((b) => {
      const _id = b._id.toString()
      const find = this.hedgeComboBots.find((bot) => bot.id === _id)
      if (
        find &&
        [
          BotStatusEnum.error,
          BotStatusEnum.range,
          BotStatusEnum.open,
          BotStatusEnum.monitoring,
        ].includes(b.status)
      ) {
        paperComboBots += 1
        const worker = this.getWorkerById(find.worker)
        worker?.postMessage({
          do: 'method',
          botType: BotType.hedgeCombo,
          botId: find.id,
          method: 'setStatus',
          args: [CloseDCATypeEnum.cancel, true, true, undefined, true],
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.hedgeCombo,
          botId: find.id,
        })

        this.hedgeComboBots = this.hedgeComboBots.filter(
          (bot) => bot.id !== _id,
        )
      }
    })
    hedgeDcaBots.data.result.forEach((b) => {
      const _id = b._id.toString()
      const find = this.hedgeDcaBots.find((bot) => bot.id === _id)
      if (
        find &&
        [
          BotStatusEnum.error,
          BotStatusEnum.range,
          BotStatusEnum.open,
          BotStatusEnum.monitoring,
        ].includes(b.status)
      ) {
        paperComboBots += 1
        const worker = this.getWorkerById(find.worker)
        worker?.postMessage({
          do: 'method',
          botType: BotType.hedgeDca,
          botId: find.id,
          method: 'setStatus',
          args: [CloseDCATypeEnum.cancel, true, true, undefined, true],
        })
        worker?.postMessage({
          do: 'delete',
          botType: BotType.hedgeDca,
          botId: find.id,
        })

        this.hedgeDcaBots = this.hedgeDcaBots.filter((bot) => bot.id !== _id)
      }
    })
    const botIds: string[] = [
      bots.data.result.map((b) => b._id.toString() as string),
      dcaBots.data.result.map((b) => b._id.toString() as string),
      comboBots.data.result.map((b) => b._id.toString() as string),
      hedgeComboBots.data.result.map((b) => b._id.toString() as string),
      hedgeDcaBots.data.result.map((b) => b._id.toString() as string),
    ].flat()
    if (paperGridBots > 0 || paperTradingBots > 0 || paperComboBots > 0) {
      requests.push(
        this.userDb.updateData(
          { _id: userId },
          {
            $inc: {
              'bot_stats.total_bots':
                -paperGridBots - paperTradingBots - paperComboBots,
              'bot_stats.total_paper_bots':
                -paperGridBots - paperTradingBots - paperComboBots,
              'bot_stats.total_paper_tradingbots': -paperTradingBots,
              'bot_stats.total_paper_grids': -paperGridBots,
              'bot_stats.total_paper_combos': -paperComboBots,
            },
          },
        ),
      )
    }
    requests.push(this.botDb.deleteManyData({ userId, paperContext: true }))
    requests.push(
      this.transactionDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      this.botEventDb.deleteManyData({ userId, botId: { $in: botIds } }),
    )
    requests.push(
      this.botMessageDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(this.orderDb.deleteManyData({ userId, paperContext: true }))
    requests.push(this.dcaBotDb.deleteManyData({ userId, paperContext: true }))
    requests.push(
      this.dcaDealsDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      this.comboBotDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      hedgeComboBotDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(hedgeDCABotDb.deleteManyData({ userId, paperContext: true }))
    requests.push(
      this.comboDealsDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      this.comboMinigridDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      this.comboProfitDb.deleteManyData({ userId, paperContext: true }),
    )
    requests.push(
      this.comboTransactionDb.deleteManyData({ userId, paperContext: true }),
    )
    return Promise.all(requests)
      .then((res) => {
        res.forEach((r) => {
          if (r.status === StatusEnum.notok) {
            return {
              status: StatusEnum.notok,
              reason: 'Failed to delete all user bots',
              data: null,
            }
          }
        })
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          reason: null,
          data: null,
        }
      })
      .catch((e) => {
        logger.warn(new Date(), ` | ${e?.message || e}`)
        return {
          status: StatusEnum.notok,
          reason: 'Failed to delete all user bots',
          data: null,
        }
      })
  }

  public async getBotOrders(
    userId: string,
    id: string,
    shareId?: string,
    type?: BotType,
    publicBot = false,
    paperContext?: boolean,
    status?: OrderStatusType,
    page = 0,
    pageSize = 100,
    sortModel?: GridSortModel[],
    filterModel?: { items: GridFilterItem[]; linkOperator?: string },
  ) {
    const bot =
      type === BotType.hedgeDca
        ? await this.getHedgeDcaBotFromDb(
            userId,
            id,
            publicBot,
            paperContext ?? false,
            shareId,
          )
        : type === BotType.hedgeCombo
          ? await this.getHedgeComboBotFromDb(
              userId,
              id,
              publicBot,
              paperContext ?? false,
              shareId,
            )
          : type === BotType.grid
            ? await this.getBotFromDb(
                userId,
                id,
                publicBot,
                paperContext ?? false,
                shareId,
              )
            : type === BotType.combo
              ? await this.getComboBotFromDb(
                  userId,
                  id,
                  publicBot,
                  paperContext ?? false,
                  shareId,
                )
              : await this.getDCABotFromDb(
                  userId,
                  id,
                  publicBot,
                  paperContext ?? false,
                  shareId,
                )
    if (bot.status === StatusEnum.ok && bot.data) {
      const { filter, ...rest } = mapDataGridOptionsToMongoOptions({
        page,
        pageSize,
        sortModel,
        filterModel,
      })
      // Cold-store read routing: an archived (cold) bot's orders live in
      // ClickHouse, not Mongo. Hedge bots are never cold-archived (Part 1), so
      // the child-bot fan-out below only applies to Mongo reads.
      if (
        isColdStoreEnabled() &&
        (bot.data as { coldArchived?: boolean }).coldArchived
      ) {
        const cold = await coldReadOrders({
          userId,
          botId: id.toString(),
          statuses: status === 'NEW' ? ['NEW', 'PARTIALLY_FILLED'] : ['FILLED'],
          limit: rest.limit,
          skip: rest.skip,
        })
        if (cold) {
          return {
            status: StatusEnum.ok,
            data: { orders: cold.result, page, total: cold.count },
          }
        }
        // cold read failed → fall through to Mongo (graceful fallback)
      }
      const findOrderRequest = await this.orderDb.readData(
        {
          ...filter,
          botId:
            (type === BotType.hedgeCombo || type === BotType.hedgeDca) &&
            'bots' in bot.data
              ? {
                  $in: bot.data.bots.map((b) => `${b._id}`),
                }
              : id.toString(),
          status:
            status === 'NEW'
              ? { $in: ['NEW', 'PARTIALLY_FILLED'] }
              : { $eq: 'FILLED' },
        },
        undefined,
        rest,
        true,
        true,
      )
      if (findOrderRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            orders: findOrderRequest.data.result,
            page,
            total: findOrderRequest.data.count,
          },
        }
      }
      return findOrderRequest
    }
    return bot
  }

  public async getDealOrders(
    userId: string,
    id: string,
    dealId: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    all = false,
  ) {
    const bot = await this.getDCABotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      if (
        isColdStoreEnabled() &&
        (bot.data as { coldArchived?: boolean }).coldArchived
      ) {
        const cold = await coldReadOrders({
          userId,
          botId: id,
          dealId,
          statuses: all ? ['NEW', 'FILLED', 'PARTIALLY_FILLED'] : ['FILLED'],
          typeOrderNotIn: [TypeOrderEnum.br],
        })
        if (cold) {
          return { status: StatusEnum.ok, data: cold.result }
        }
        // cold read failed → fall through to Mongo (graceful fallback)
      }
      const findOrderRequest = await this.orderDb.readData(
        {
          dealId,
          botId: id,
          status: all
            ? { $in: ['NEW', 'FILLED', 'PARTIALLY_FILLED'] }
            : 'FILLED',
          typeOrder: { $ne: TypeOrderEnum.br },
        },
        undefined,
        undefined,
        true,
        true,
      )
      if (findOrderRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findOrderRequest.data.result,
        }
      }
      return findOrderRequest
    }
    return bot
  }

  public async getComboDealOrders(
    userId: string,
    id: string,
    dealId: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    all = false,
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      if (
        isColdStoreEnabled() &&
        (bot.data as { coldArchived?: boolean }).coldArchived
      ) {
        const cold = await coldReadOrders({
          userId,
          botId: id,
          dealId,
          statuses: all ? ['NEW', 'FILLED', 'PARTIALLY_FILLED'] : ['FILLED'],
          typeOrderNotIn: [TypeOrderEnum.br],
        })
        if (cold) {
          return { status: StatusEnum.ok, data: cold.result }
        }
        // cold read failed → fall through to Mongo (graceful fallback)
      }
      const findOrderRequest = await this.orderDb.readData(
        {
          dealId,
          botId: id,
          status: all
            ? { $in: ['NEW', 'FILLED', 'PARTIALLY_FILLED'] }
            : 'FILLED',
          typeOrder: { $ne: TypeOrderEnum.br },
        },
        undefined,
        undefined,
        true,
        true,
      )
      if (findOrderRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findOrderRequest.data.result,
        }
      }
      return findOrderRequest
    }
    return bot
  }

  public async getHedgeComboDealOrders(
    userId: string,
    id: string,
    dealId: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    all = false,
  ) {
    const bot = await this.getHedgeComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findOrderRequest = await this.orderDb.readData(
        {
          dealId,
          botId: { $in: bot.data.bots.map((b) => `${b._id}`) },
          status: all
            ? { $in: ['NEW', 'FILLED', 'PARTIALLY_FILLED'] }
            : 'FILLED',
          typeOrder: { $ne: TypeOrderEnum.br },
        },
        undefined,
        undefined,
        true,
        true,
      )
      if (findOrderRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findOrderRequest.data.result,
        }
      }
      return findOrderRequest
    }
    return bot
  }

  public async getHedgeDcaDealOrders(
    userId: string,
    id: string,
    dealId: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    all = false,
  ) {
    const bot = await this.getHedgeDcaBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findOrderRequest = await this.orderDb.readData(
        {
          dealId,
          botId: { $in: bot.data.bots.map((b) => `${b._id}`) },
          status: all
            ? { $in: ['NEW', 'FILLED', 'PARTIALLY_FILLED'] }
            : 'FILLED',
          typeOrder: { $ne: TypeOrderEnum.br },
        },
        undefined,
        undefined,
        true,
        true,
      )
      if (findOrderRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findOrderRequest.data.result,
        }
      }
      return findOrderRequest
    }
    return bot
  }

  public async getBotTransactions(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    page = 0,
  ) {
    const bot = await this.getBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      if (
        isColdStoreEnabled() &&
        (bot.data as { coldArchived?: boolean }).coldArchived
      ) {
        const cold = await coldReadTransactions({
          userId,
          botId: id.toString(),
          limit: 100,
          skip: page * 100,
          sort: 'desc',
        })
        if (cold) {
          return {
            status: StatusEnum.ok,
            data: {
              transactions: cold.result,
              page,
              total: cold.count,
            },
          }
        }
        // cold read failed → fall through to Mongo (graceful fallback)
      }
      const findTransactionsRequest = await this.transactionDb.readData(
        {
          botId: id.toString(),
          userId,
        },
        undefined,
        { limit: 100, sort: { updated: -1 }, skip: page * 100 },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            transactions: findTransactionsRequest.data.result,
            page,
            total: findTransactionsRequest.data.count,
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getBotDeals(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: DCADealStatusEnum,
    page = 0,
    pageSize?: number,
    sortModel?: GridSortModel[],
    filterModel?: { items: GridFilterItem[]; linkOperator?: string },
  ) {
    const bot = await this.getDCABotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    pageSize = Math.min(100, pageSize ?? 100)
    const { filter, limit, sort, skip } = mapDataGridOptionsToMongoOptions({
      page,
      pageSize,
      sortModel,
      filterModel,
    })
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.dcaDealsDb.readData(
        {
          botId: id.toString(),
          status:
            status === DCADealStatusEnum.open
              ? {
                  $in: [
                    DCADealStatusEnum.error,
                    DCADealStatusEnum.open,
                    DCADealStatusEnum.start,
                  ],
                }
              : { $in: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
          ...filter,
        },
        undefined,
        { limit, sort, skip },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
            page,
            total: findTransactionsRequest.data.count,
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getBotDealsStats(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getDCABotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const stats = await this.dcaDealsDb.aggregate([
        { $match: { botId: id.toString(), status: DCADealStatusEnum.closed } },
        {
          $project: {
            'usage.current.base': 1,
            'usage.current.quote': 1,
            'profit.totalUsd': 1,
            createTime: 1,
            closeTime: 1,
            'stats.timeInLoss': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInLoss', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInLoss',
              },
            },
            'stats.timeInProfit': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInProfit', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInProfit',
              },
            },
            moreThanZero: {
              $cond: [
                {
                  $gt: ['$profit.totalUsd', 0],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: '$botId',
            avgUsage: {
              $avg: bot.data.settings.futures
                ? bot.data.settings.coinm
                  ? '$usage.current.base'
                  : '$usage.current.quote'
                : bot.data.settings.strategy === StrategyEnum.long
                  ? '$usage.current.quote'
                  : '$usage.current.base',
            },
            avgProfit: { $avg: '$profit.totalUsd' },
            avgTradingTime: {
              $avg: {
                // @ts-ignore
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            },
            avgTimeInLoss: { $avg: '$stats.timeInLoss' },
            avgTimeInProfit: { $avg: '$stats.timeInProfit' },
            count: { $sum: 1 },
            countMoreThanZero: { $sum: '$moreThanZero' },
          },
        },
        {
          $project: {
            _id: 0,
            avgUsage: 1,
            avgProfit: 1,
            avgTradingTime: 1,
            avgTimeInLoss: 1,
            avgTimeInProfit: 1,
            winRate: {
              $multiply: [{ $divide: ['$countMoreThanZero', '$count'] }, 100],
            },
          },
        },
      ])
      if (stats.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            stats: stats.data?.result ? stats.data.result[0] : undefined,
          },
        }
      }
      return stats
    }
    return bot
  }

  /**
   * DCA-usage histogram for ONE bot, folded in Mongo over EVERY one of its
   * deals.
   *
   * The dashboard's DCA Analysis widget used to derive this client-side from
   * the deals it happened to have loaded: `getBotDeals` pages of 100 full deal
   * documents (~600 selected GraphQL fields each), capped at 5 pages by the
   * display loader. So a bot past 500 deals was silently analysed on a subset,
   * and the whole payload existed to read ONE integer per deal.
   *
   * What comes back is deliberately raw — the count of DCA (safety) orders
   * each deal actually filled, bucketed. Clamping those buckets to the bot's
   * CURRENT configured DCA count stays on the client, because that count comes
   * from the example-orders projection engine (which needs pair metadata and a
   * live price) and not from anything in this collection. Keeping that seam
   * means the numbers the widget renders are unchanged; only their coverage is.
   *
   * `levels.complete` counts the base order too, hence the -1: a deal that
   * filled nothing but its base order used 0 DCAs.
   *
   * No status filter, so one pass serves both halves of the widget — `finished`
   * is closed|canceled, `active` is everything else (open/start/error), exactly
   * the two groups `getBotDeals` splits on. The existing `{botId: 1}` index
   * bounds the scan; deals are not cold-store archived (only their orders and
   * transactions are), so this sees the bot's entire history.
   */
  private async dcaUsageHistogram(
    db: Pick<typeof dcaDealsDb, 'aggregate'>,
    match: PipelineStage.Match['$match'],
    /** Combo deals carry `transactions.buy`; DCA deals have only `levels`. */
    useTransactions: boolean,
  ) {
    const filled = useTransactions
      ? { $ifNull: ['$transactions.buy', '$levels.complete'] }
      : '$levels.complete'
    const agg = await db.aggregate<{
      _id: { finished: boolean; dcas: number; configured: number }
      deals: number
    }>([
      { $match: match },
      {
        $group: {
          _id: {
            finished: {
              $in: [
                '$status',
                [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
              ],
            },
            dcas: {
              $max: [0, { $subtract: [{ $ifNull: [filled, 0] }, 1] }],
            },
            // The ladder THIS deal ran under. Only used when the caller has no
            // projected count for the bot's current settings — the client-side
            // fold this replaced fell back to the deal's own `levels.all` there,
            // so carrying it keeps that path exact rather than approximating it
            // with a bot-wide maximum.
            configured: {
              $max: [0, { $subtract: [{ $ifNull: ['$levels.all', 0] }, 1] }],
            },
          },
          deals: { $sum: 1 },
        },
      },
    ])
    if (agg.status !== StatusEnum.ok) {
      return agg
    }
    type Bucket = { dcas: number; deals: number; configured: number }
    const finished: Bucket[] = []
    const active: Bucket[] = []
    let maxConfiguredDcas = 0
    for (const row of agg.data?.result ?? []) {
      const bucket = {
        dcas: Math.max(0, Math.floor(row._id?.dcas ?? 0)),
        deals: row.deals ?? 0,
        configured: Math.max(0, Math.floor(row._id?.configured ?? 0)),
      }
      ;(row._id?.finished ? finished : active).push(bucket)
      maxConfiguredDcas = Math.max(maxConfiguredDcas, bucket.configured)
    }
    const byDcas = (a: Bucket, b: Bucket) => a.dcas - b.dcas
    return {
      status: StatusEnum.ok as StatusEnum.ok,
      data: {
        finished: finished.sort(byDcas),
        active: active.sort(byDcas),
        maxConfiguredDcas,
      },
    }
  }

  public async getBotDcaUsage(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getDCABotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      return await this.dcaUsageHistogram(
        this.dcaDealsDb,
        { botId: id.toString() },
        false,
      )
    }
    return bot
  }

  public async getComboBotDcaUsage(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      return await this.dcaUsageHistogram(
        this.comboDealsDb,
        { botId: id.toString() },
        true,
      )
    }
    return bot
  }

  public async getComboBotDeals(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: DCADealStatusEnum,
    page = 0,
    pageSize?: number,
    sortModel?: GridSortModel[],
    filterModel?: { items: GridFilterItem[]; linkOperator?: string },
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    pageSize = Math.min(100, pageSize ?? 100)
    const { filter, limit, sort, skip } = mapDataGridOptionsToMongoOptions({
      page,
      pageSize,
      sortModel,
      filterModel,
    })
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.comboDealsDb.readData(
        {
          botId: id.toString(),
          status:
            status === DCADealStatusEnum.open
              ? {
                  $in: [
                    DCADealStatusEnum.error,
                    DCADealStatusEnum.open,
                    DCADealStatusEnum.start,
                  ],
                }
              : { $in: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
          ...filter,
        },
        undefined,
        { limit, sort, skip },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
            page,
            total: findTransactionsRequest.data.count,
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getHedgeComboBotDeals(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: DCADealStatusEnum,
    page = 0,
    pageSize?: number,
    sortModel?: GridSortModel[],
    filterModel?: { items: GridFilterItem[]; linkOperator?: string },
  ) {
    const bot = await this.getHedgeComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    pageSize = Math.min(100, pageSize ?? 100)
    const { filter, limit, sort, skip } = mapDataGridOptionsToMongoOptions({
      page,
      pageSize,
      sortModel,
      filterModel,
    })
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.comboDealsDb.readData(
        {
          botId: { $in: bot.data.bots.map((b) => `${b._id}`) },
          status:
            status === DCADealStatusEnum.open
              ? {
                  $in: [
                    DCADealStatusEnum.error,
                    DCADealStatusEnum.open,
                    DCADealStatusEnum.start,
                  ],
                }
              : { $in: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
          ...filter,
        },
        undefined,
        { limit, sort, skip },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
            page,
            total: findTransactionsRequest.data.count,
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getHedgeDcaBotDeals(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: DCADealStatusEnum,
    page = 0,
    pageSize?: number,
    sortModel?: GridSortModel[],
    filterModel?: { items: GridFilterItem[]; linkOperator?: string },
  ) {
    const bot = await this.getHedgeDcaBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    pageSize = Math.min(100, pageSize ?? 100)
    const { filter, limit, sort, skip } = mapDataGridOptionsToMongoOptions({
      page,
      pageSize,
      sortModel,
      filterModel,
    })
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.dcaDealsDb.readData(
        {
          botId: { $in: bot.data.bots.map((b) => `${b._id}`) },
          status:
            status === DCADealStatusEnum.open
              ? {
                  $in: [
                    DCADealStatusEnum.error,
                    DCADealStatusEnum.open,
                    DCADealStatusEnum.start,
                  ],
                }
              : { $in: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
          ...filter,
        },
        undefined,
        { limit, sort, skip },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
            page,
            total: findTransactionsRequest.data.count,
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getComboBotDealsStats(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const stats = await this.comboDealsDb.aggregate([
        { $match: { botId: id.toString(), status: DCADealStatusEnum.closed } },
        {
          $project: {
            'usage.current.base': 1,
            'usage.current.quote': 1,
            'profit.totalUsd': 1,
            createTime: 1,
            closeTime: 1,
            'stats.timeInLoss': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInLoss', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInLoss',
              },
            },
            'stats.timeInProfit': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInProfit', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInProfit',
              },
            },
            moreThanZero: {
              $cond: [
                {
                  $gt: ['$profit.totalUsd', 0],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: '$botId',
            avgUsage: {
              $avg: bot.data.settings.futures
                ? bot.data.settings.coinm
                  ? '$usage.current.base'
                  : '$usage.current.quote'
                : bot.data.settings.strategy === StrategyEnum.long
                  ? '$usage.current.quote'
                  : '$usage.current.base',
            },
            avgProfit: { $avg: '$profit.totalUsd' },
            avgTradingTime: {
              $avg: {
                // @ts-ignore
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            },
            avgTimeInLoss: { $avg: '$stats.timeInLoss' },
            avgTimeInProfit: { $avg: '$stats.timeInProfit' },
            count: { $sum: 1 },
            countMoreThanZero: { $sum: '$moreThanZero' },
          },
        },
        {
          $project: {
            _id: 0,
            avgUsage: 1,
            avgProfit: 1,
            avgTradingTime: 1,
            avgTimeInLoss: 1,
            avgTimeInProfit: 1,
            winRate: {
              $multiply: [{ $divide: ['$countMoreThanZero', '$count'] }, 100],
            },
          },
        },
      ])
      if (stats.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            stats: stats.data?.result ? stats.data.result[0] : undefined,
          },
        }
      }
      return stats
    }
    return bot
  }

  public async getComboBotDealsById(
    userId: string,
    botId: string,
    id: string[],
    paperContext: boolean,
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      botId,
      false,
      paperContext ?? false,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.comboDealsDb.readData(
        {
          botId: botId.toString(),
          _id: { $in: id.slice(0, 200).map((ids) => new Types.ObjectId(ids)) },
        },
        undefined,
        {},
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getDCABotDealsById(
    userId: string,
    botId: string,
    id: string[],
    paperContext: boolean,
  ) {
    const bot = await this.getDCABotFromDb(
      userId,
      botId,
      false,
      paperContext ?? false,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.dcaDealsDb.readData(
        {
          botId: botId.toString(),
          _id: { $in: id.slice(0, 200).map((ids) => new Types.ObjectId(ids)) },
        },
        undefined,
        {},
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            deals: findTransactionsRequest.data.result.map((d) => ({
              ...d,
              paperContext: !!paperContext,
            })),
          },
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getHedgeComboBotDealsStats(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getHedgeComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const stats = await this.comboDealsDb.aggregate([
        {
          $match: {
            userId,
            $expr: { $in: ['$botId', bot.data.bots.map((b) => `${b._id}`)] },
            status: DCADealStatusEnum.closed,
          },
        },
        {
          $project: {
            'usage.current.base': 1,
            'usage.current.quote': 1,
            'profit.totalUsd': 1,
            createTime: 1,
            closeTime: 1,
            'stats.timeInLoss': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInLoss', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInLoss',
              },
            },
            'stats.timeInProfit': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInProfit', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInProfit',
              },
            },
            moreThanZero: {
              $cond: [
                {
                  $gt: ['$profit.totalUsd', 0],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: '$botId',
            avgUsage: {
              $avg: bot.data.bots[0].settings.futures
                ? bot.data.bots[0].settings.coinm
                  ? '$usage.current.base'
                  : '$usage.current.quote'
                : bot.data.bots[0].settings.strategy === StrategyEnum.long
                  ? '$usage.current.quote'
                  : '$usage.current.base',
            },
            avgProfit: { $avg: '$profit.totalUsd' },
            avgTradingTime: {
              $avg: {
                // @ts-ignore
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            },
            avgTimeInLoss: { $avg: '$stats.timeInLoss' },
            avgTimeInProfit: { $avg: '$stats.timeInProfit' },
            count: { $sum: 1 },
            countMoreThanZero: { $sum: '$moreThanZero' },
          },
        },
        {
          $project: {
            _id: 0,
            avgUsage: 1,
            avgProfit: 1,
            avgTradingTime: 1,
            avgTimeInLoss: 1,
            avgTimeInProfit: 1,
            winRate: {
              $multiply: [{ $divide: ['$countMoreThanZero', '$count'] }, 100],
            },
          },
        },
      ])
      if (stats.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            stats: stats.data?.result ? stats.data.result[0] : undefined,
          },
        }
      }
      return stats
    }
    return bot
  }

  public async getHedgeDcaBotDealsStats(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
  ) {
    const bot = await this.getHedgeDcaBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const stats = await this.dcaDealsDb.aggregate([
        {
          $match: {
            userId,
            $expr: { $in: ['$botId', bot.data.bots.map((b) => `${b._id}`)] },
            status: DCADealStatusEnum.closed,
          },
        },
        {
          $project: {
            'usage.current.base': 1,
            'usage.current.quote': 1,
            'profit.totalUsd': 1,
            createTime: 1,
            closeTime: 1,
            'stats.timeInLoss': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInLoss', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInLoss',
              },
            },
            'stats.timeInProfit': {
              $cond: {
                if: { $gt: ['$stats.trackTime', 0] },
                then: {
                  $multiply: [
                    {
                      $subtract: [
                        {
                          $ifNull: ['$closeTime', '$updateTime'],
                        },
                        '$createTime',
                      ],
                    },
                    {
                      $divide: ['$stats.timeInProfit', '$stats.trackTime'],
                    },
                  ],
                },
                else: '$stats.timeInProfit',
              },
            },
            moreThanZero: {
              $cond: [
                {
                  $gt: ['$profit.totalUsd', 0],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: '$botId',
            avgUsage: {
              $avg: bot.data.bots[0].settings.futures
                ? bot.data.bots[0].settings.coinm
                  ? '$usage.current.base'
                  : '$usage.current.quote'
                : bot.data.bots[0].settings.strategy === StrategyEnum.long
                  ? '$usage.current.quote'
                  : '$usage.current.base',
            },
            avgProfit: { $avg: '$profit.totalUsd' },
            avgTradingTime: {
              $avg: {
                // @ts-ignore
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            },
            avgTimeInLoss: { $avg: '$stats.timeInLoss' },
            avgTimeInProfit: { $avg: '$stats.timeInProfit' },
            count: { $sum: 1 },
            countMoreThanZero: { $sum: '$moreThanZero' },
          },
        },
        {
          $project: {
            _id: 0,
            avgUsage: 1,
            avgProfit: 1,
            avgTradingTime: 1,
            avgTimeInLoss: 1,
            avgTimeInProfit: 1,
            winRate: {
              $multiply: [{ $divide: ['$countMoreThanZero', '$count'] }, 100],
            },
          },
        },
      ])
      if (stats.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: {
            stats: stats.data?.result ? stats.data.result[0] : undefined,
          },
        }
      }
      return stats
    }
    return bot
  }

  public async getComboBotMinigrids(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: 'open' | 'closed',
    page = 0,
  ) {
    const bot = await this.getComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.comboMinigridDb.readData(
        {
          botId: id.toString(),
          status:
            status === 'closed'
              ? {
                  $in: [ComboMinigridStatusEnum.closed],
                }
              : {
                  $in: [
                    ComboMinigridStatusEnum.active,
                    ComboMinigridStatusEnum.range,
                  ],
                },
        },
        undefined,
        { limit: 100, sort: { updated: -1 }, skip: page * 100 },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findTransactionsRequest.data.result,
          total: findTransactionsRequest.data.count,
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  public async getHedgeComboBotMinigrids(
    userId: string,
    id: string,
    shareId?: string,
    publicBot = false,
    paperContext?: boolean,
    status?: 'open' | 'closed',
    page = 0,
  ) {
    const bot = await this.getHedgeComboBotFromDb(
      userId,
      id,
      publicBot,
      paperContext ?? false,
      shareId,
    )
    if (bot.status === StatusEnum.ok && bot.data) {
      const findTransactionsRequest = await this.comboMinigridDb.readData(
        {
          botId: { $in: bot.data.bots.map((b) => `${b._id}`) },
          status:
            status === 'closed'
              ? {
                  $in: [ComboMinigridStatusEnum.closed],
                }
              : {
                  $in: [
                    ComboMinigridStatusEnum.active,
                    ComboMinigridStatusEnum.range,
                  ],
                },
        },
        undefined,
        { limit: 100, sort: { updated: -1 }, skip: page * 100 },
        true,
        true,
      )
      if (findTransactionsRequest.status === StatusEnum.ok) {
        return {
          status: StatusEnum.ok,
          data: findTransactionsRequest.data.result,
          total: findTransactionsRequest.data.count,
        }
      }
      return findTransactionsRequest
    }
    return bot
  }

  private async getBotFromDb(
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    const or: Record<string, unknown>[] = [
      { userId },
      { share: { $eq: true }, shareId },
    ]
    if (publicBot && !shareId) {
      or.push({ public: true })
    }
    const filter: Record<string, unknown> = {
      _id: id,
      $or: or,
      isDeleted: { $ne: true },
    }
    if (!publicBot && !shareId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }

    const findBotRequest = await this.botDb.readData(
      filter,
      undefined,
      {},
      false,
      false,
    )
    if (findBotRequest.status === StatusEnum.notok) {
      return findBotRequest
    }
    if (findBotRequest.data && !findBotRequest.data.result) {
      return this.entityNotFound('Bot')
    }
    const botData = { ...findBotRequest.data.result }
    if (shareId && userId !== botData.userId) {
      botData.uuid = ''
      botData.vars = { list: [], paths: [] }
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...botData,
      },
    }
  }

  private async getDCABotFromDb(
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    const or: Record<string, unknown>[] = [
      { userId },
      { share: { $eq: true }, shareId },
    ]
    if (publicBot && !shareId) {
      or.push({ public: true })
    }
    const filter: Record<string, unknown> = {
      _id: id,
      $or: or,
      isDeleted: { $ne: true },
    }

    if (!publicBot && !shareId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }

    const findBotRequest = await this.dcaBotDb.readData(
      filter,
      undefined,
      {},
      false,
      false,
    )
    if (findBotRequest.status === StatusEnum.notok) {
      return findBotRequest
    }
    if (findBotRequest.data && !findBotRequest.data.result) {
      return this.entityNotFound('Bot')
    }
    if (shareId && userId !== findBotRequest.data.result.userId) {
      findBotRequest.data.result.uuid = ''
      findBotRequest.data.result.vars = { list: [], paths: [] }
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...convertDCABotToArray(findBotRequest.data.result),
        dealsInBot: findBotRequest.data.result.deals,
      },
    }
  }

  private async getComboBotFromDb(
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    const or: Record<string, unknown>[] = [
      { userId },
      { share: { $eq: true }, shareId },
    ]
    if (publicBot && !shareId) {
      or.push({ public: true })
    }
    const filter: Record<string, unknown> = {
      _id: id,
      $or: or,
      isDeleted: { $ne: true },
    }

    if (!publicBot && !shareId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }

    const findBotRequest = await this.comboBotDb.readData(
      filter,
      undefined,
      {},
      false,
      false,
    )
    if (findBotRequest.status === StatusEnum.notok) {
      return findBotRequest
    }
    if (findBotRequest.data && !findBotRequest.data.result) {
      return this.entityNotFound('Bot')
    }
    if (shareId && userId !== findBotRequest.data.result.userId) {
      findBotRequest.data.result.uuid = ''
      findBotRequest.data.result.vars = { list: [], paths: [] }
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...convertComboBotToArray(findBotRequest.data.result),
        dealsInBot: findBotRequest.data.result.deals,
      },
    }
  }

  private async getHedgeComboBotFromDb(
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    const or: Record<string, unknown>[] = [
      { userId },
      { share: { $eq: true }, shareId },
    ]
    if (publicBot && !shareId) {
      or.push({ public: true })
    }
    const filter: Record<string, unknown> = {
      _id: id,
      $or: or,
      isDeleted: { $ne: true },
    }

    if (!publicBot && !shareId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }
    const findBotRequest = await hedgeComboBotDb.readData(
      filter,
      undefined,
      { populate: 'bots' },
      false,
      false,
    )
    if (findBotRequest.status === StatusEnum.notok) {
      return findBotRequest
    }
    if (findBotRequest.data && !findBotRequest.data.result) {
      return this.entityNotFound('Bot')
    }
    if (shareId) {
      findBotRequest.data.result.uuid = ''
    }
    const longBot = findBotRequest.data?.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.long,
    )
    const shortBot = findBotRequest.data?.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.short,
    )
    if (!longBot || !shortBot) {
      return this.entityNotFound('Bot')
    }
    const long = {
      ...convertComboBotToArray(longBot),
      dealsInBot: longBot.deals,
    }
    const short = {
      ...convertComboBotToArray(shortBot),
      dealsInBot: shortBot.deals,
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...convertHedgeComboBotToArray(findBotRequest.data.result),
        bots: [long, short],
      },
    }
  }

  private async getHedgeDcaBotFromDb(
    userId: string,
    id: string,
    publicBot = false,
    paperContext: boolean,
    shareId?: string,
  ) {
    const or: Record<string, unknown>[] = [
      { userId },
      { share: { $eq: true }, shareId },
    ]
    if (publicBot && !shareId) {
      or.push({ public: true })
    }
    const filter: Record<string, unknown> = {
      _id: id,
      $or: or,
      isDeleted: { $ne: true },
    }

    if (!publicBot && !shareId) {
      filter.paperContext = paperContext ? { $eq: true } : { $ne: true }
    }

    const findBotRequest = await hedgeDCABotDb.readData(
      filter,
      undefined,
      { populate: 'bots' },
      false,
      false,
    )
    if (findBotRequest.status === StatusEnum.notok) {
      return findBotRequest
    }
    if (findBotRequest.data && !findBotRequest.data.result) {
      return this.entityNotFound('Bot')
    }
    if (shareId) {
      findBotRequest.data.result.uuid = ''
    }
    const longBot = findBotRequest.data?.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.long,
    )
    const shortBot = findBotRequest.data?.result.bots.find(
      (b) => b.settings.strategy === StrategyEnum.short,
    )
    if (!longBot || !shortBot) {
      return this.entityNotFound('Bot')
    }
    const long = {
      ...convertComboBotToArray(longBot),
      dealsInBot: longBot.deals,
    }
    const short = {
      ...convertComboBotToArray(shortBot),
      dealsInBot: shortBot.deals,
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...convertHedgeComboBotToArray(findBotRequest.data.result),
        bots: [long, short],
      },
    }
  }

  private async getGridBotList(
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    dataGridInput: DataGridFilterInput = {},
  ) {
    let filter: {
      [x: string]: unknown
    } = {
      userId: userId,
    }
    if (token === 'demo') {
      filter.public = true
    }
    if (status) {
      filter.status = { $in: status }
    }
    let limit: number | undefined
    let skip: number | undefined
    let sort: { [x: string]: number } | undefined
    if (Object.keys(dataGridInput).length) {
      const {
        filter: dataGridFilter,
        sort: dataGridSort,
        limit: dataGridLimit,
        skip: dataGridSkip,
      } = mapDataGridOptionsToMongoOptions(dataGridInput)
      filter = { ...dataGridFilter, ...filter }
      limit = dataGridLimit
      skip = dataGridSkip
      sort = dataGridSort
    }
    const effectiveLimit = limit ?? 500
    const search = {
      ...filter,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      isDeleted: { $ne: true },
    }
    const options = { sort, limit: effectiveLimit, skip }
    // When the caller isn't paginating (no dataGridInput, no skip) the total is
    // just the returned length, unless we hit the limit exactly (can't infer).
    // Skipping the extra countDocuments avoids a second full scan per request.
    const skipCount =
      Object.keys(dataGridInput).length === 0 &&
      !(typeof skip === 'number' && skip > 0)
    const request = skipCount
      ? await this.botDb.readData(search, undefined, options, true, false)
      : await this.botDb.readData(search, undefined, options, true, true)
    if (request.status === StatusEnum.notok) {
      return request
    }
    const result = request.data.result
    let total: number
    if (!skipCount) {
      total = (request.data as unknown as { count: number }).count
    } else if (result.length < effectiveLimit) {
      total = result.length
    } else {
      const counted = await this.botDb.countData(search)
      total =
        counted.status === StatusEnum.ok ? counted.data.result : result.length
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: result.map((r) => ({
        ...r,
        workingTimeTotal:
          r.workingShift && r.workingShift.length > 0
            ? r.workingShift.reduce((acc, v) => {
                if (v.end) {
                  acc += v.end - v.start
                } else if (!v.end) {
                  acc += new Date().getTime() - v.start
                }
                return acc
              }, 0)
            : 0,
      })),
      total,
    }
  }

  private async getComboBotList(
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    all = false,
    dataGridInput: DataGridFilterInput = {},
  ) {
    let filter: {
      [x: string]: unknown
    } = {
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
    }
    if (token === 'demo') {
      filter.public = true
    }
    if (status) {
      filter.status = { $in: status }
    }
    if (!all) {
      filter['settings.type'] = { $ne: DCATypeEnum.terminal }
    }
    let limit: number | undefined
    let skip: number | undefined
    let sort: { [x: string]: number } | undefined
    if (Object.keys(dataGridInput).length) {
      const {
        filter: dataGridFilter,
        sort: dataGridSort,
        limit: dataGridLimit,
        skip: dataGridSkip,
      } = mapDataGridOptionsToMongoOptions(dataGridInput)
      filter = { ...dataGridFilter, ...filter }
      limit = dataGridLimit
      skip = dataGridSkip
      sort = dataGridSort
    }
    const effectiveLimit = limit ?? 500
    const search = {
      ...filter,
      isDeleted: { $ne: true },
      parentBotId: { $exists: false },
    }
    const options = { sort, limit: effectiveLimit, skip }
    const skipCount =
      Object.keys(dataGridInput).length === 0 &&
      !(typeof skip === 'number' && skip > 0)
    const request = skipCount
      ? await this.comboBotDb.readData(search, undefined, options, true, false)
      : await this.comboBotDb.readData(search, undefined, options, true, true)
    if (request.status === StatusEnum.notok) {
      return request
    }
    const result = request.data.result
    let total: number
    if (!skipCount) {
      total = (request.data as unknown as { count: number }).count
    } else if (result.length < effectiveLimit) {
      total = result.length
    } else {
      const counted = await this.comboBotDb.countData(search)
      total =
        counted.status === StatusEnum.ok ? counted.data.result : result.length
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: result.map((d) => ({
        ...d,
        ...convertComboBotToArray(d),
        dealsInBot: d.deals,
        workingTimeTotal:
          d.workingShift && d.workingShift.length > 0
            ? d.workingShift.reduce((acc, v) => {
                if (v.end) {
                  acc += v.end - v.start
                } else if (!v.end) {
                  acc += new Date().getTime() - v.start
                }
                return acc
              }, 0)
            : 0,
      })),
      total,
    }
  }

  private async getHedgeComboBotList(
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    all = false,
    dataGridInput: DataGridFilterInput = {},
  ) {
    let filter: {
      [x: string]: unknown
    } = {
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
    }
    if (token === 'demo') {
      filter.public = true
    }
    if (status) {
      filter.status = { $in: status }
    }
    if (!all) {
      filter['settings.type'] = { $ne: DCATypeEnum.terminal }
    }
    let limit: number | undefined
    let skip: number | undefined
    let sort: { [x: string]: number } | undefined
    if (Object.keys(dataGridInput).length) {
      const {
        filter: dataGridFilter,
        sort: dataGridSort,
        limit: dataGridLimit,
        skip: dataGridSkip,
      } = mapDataGridOptionsToMongoOptions(dataGridInput)
      filter = { ...dataGridFilter, ...filter }
      limit = dataGridLimit
      skip = dataGridSkip
      sort = dataGridSort
    }
    let _limit = Math.max(limit ?? 500, 500)
    const user = await this.userDb.readData({ _id: userId })
    if (user.status === StatusEnum.notok) {
      return user
    }
    if (user.data?.result?.bigAccount) {
      _limit = Math.max(limit ?? 1000, 1000)
      if (typeof sort === 'undefined') {
        sort = { status: -1 }
      }
    }
    const search = { ...filter, isDeleted: { $ne: true } }
    const options = { sort, limit: _limit, skip, populate: 'bots' }
    const skipCount =
      Object.keys(dataGridInput).length === 0 &&
      !(typeof skip === 'number' && skip > 0)
    const request = skipCount
      ? await hedgeComboBotDb.readData(search, undefined, options, true, false)
      : await hedgeComboBotDb.readData(search, undefined, options, true, true)
    if (request.status === StatusEnum.notok) {
      return request
    }
    const result = request.data.result
    let total: number
    if (!skipCount) {
      total = (request.data as unknown as { count: number }).count
    } else if (result.length < _limit) {
      total = result.length
    } else {
      const counted = await hedgeComboBotDb.countData(search)
      total =
        counted.status === StatusEnum.ok ? counted.data.result : result.length
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: result.map((d) => {
        const longBot = d.bots.find(
          (b) => b.settings.strategy === StrategyEnum.long,
        )
        const shortBot = d.bots.find(
          (b) => b.settings.strategy === StrategyEnum.short,
        )
        if (!longBot || !shortBot) {
          return {
            ...convertHedgeComboBotToArray(d),
          }
        }
        const long = {
          ...convertComboBotToArray(longBot),
          dealsInBot: longBot.deals,
        }
        const short = {
          ...convertComboBotToArray(shortBot),
          dealsInBot: shortBot.deals,
        }
        return { ...d, ...convertHedgeComboBotToArray(d), bots: [long, short] }
      }),
      total,
    }
  }

  private async getHedgeDcaBotList(
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    all = false,
    dataGridInput: DataGridFilterInput = {},
  ) {
    let filter: {
      [x: string]: unknown
    } = {
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
    }
    if (token === 'demo') {
      filter.public = true
    }
    if (status) {
      filter.status = { $in: status }
    }
    if (!all) {
      filter['settings.type'] = { $ne: DCATypeEnum.terminal }
    }
    let limit: number | undefined
    let skip: number | undefined
    let sort: { [x: string]: number } | undefined
    if (Object.keys(dataGridInput).length) {
      const {
        filter: dataGridFilter,
        sort: dataGridSort,
        limit: dataGridLimit,
        skip: dataGridSkip,
      } = mapDataGridOptionsToMongoOptions(dataGridInput)
      filter = { ...dataGridFilter, ...filter }
      limit = dataGridLimit
      skip = dataGridSkip
      sort = dataGridSort
    }
    let _limit = Math.max(limit ?? 500, 500)
    const user = await this.userDb.readData({ _id: userId })
    if (user.status === StatusEnum.notok) {
      return user
    }
    if (user.data?.result?.bigAccount) {
      _limit = Math.max(limit ?? 1000, 1000)
      if (typeof sort === 'undefined') {
        sort = { status: -1 }
      }
    }
    const search = { ...filter, isDeleted: { $ne: true } }
    const options = { sort, limit: _limit, skip, populate: 'bots' }
    const skipCount =
      Object.keys(dataGridInput).length === 0 &&
      !(typeof skip === 'number' && skip > 0)
    const request = skipCount
      ? await hedgeDCABotDb.readData(search, undefined, options, true, false)
      : await hedgeDCABotDb.readData(search, undefined, options, true, true)
    if (request.status === StatusEnum.notok) {
      return request
    }
    const result = request.data.result
    let total: number
    if (!skipCount) {
      total = (request.data as unknown as { count: number }).count
    } else if (result.length < _limit) {
      total = result.length
    } else {
      const counted = await hedgeDCABotDb.countData(search)
      total =
        counted.status === StatusEnum.ok ? counted.data.result : result.length
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: result.map((d) => {
        const longBot = d.bots.find(
          (b) => b.settings.strategy === StrategyEnum.long,
        )
        const shortBot = d.bots.find(
          (b) => b.settings.strategy === StrategyEnum.short,
        )
        if (!longBot || !shortBot) {
          return {
            ...convertHedgeComboBotToArray(d),
          }
        }
        const long = {
          ...convertComboBotToArray(longBot),
          dealsInBot: longBot.deals,
        }
        const short = {
          ...convertComboBotToArray(shortBot),
          dealsInBot: shortBot.deals,
        }
        return { ...d, ...convertHedgeComboBotToArray(d), bots: [long, short] }
      }),
      total,
    }
  }

  private async getDCABotList(
    userId: string,
    token: string,
    status?: BotStatusEnum[],
    paperContext?: boolean,
    all = false,
    dataGridInput: DataGridFilterInput = {},
  ) {
    let filter: {
      [x: string]: unknown
    } = {
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
    }
    if (token === 'demo') {
      filter.public = true
    }
    if (status) {
      filter.status = { $in: status }
    }
    if (!all) {
      filter['settings.type'] = {
        $nin: [DCATypeEnum.terminal],
      }
    }
    let limit: number | undefined
    let skip: number | undefined
    let sort: { [x: string]: number } | undefined
    if (Object.keys(dataGridInput).length) {
      const {
        filter: dataGridFilter,
        sort: dataGridSort,
        limit: dataGridLimit,
        skip: dataGridSkip,
      } = mapDataGridOptionsToMongoOptions(dataGridInput)
      filter = { ...dataGridFilter, ...filter }
      limit = dataGridLimit
      skip = dataGridSkip
      sort = dataGridSort
    }
    const effectiveLimit = limit ?? 500
    const search = {
      ...filter,
      isDeleted: { $ne: true },
      parentBotId: { $exists: false },
    }
    const options = { sort, limit: effectiveLimit, skip }
    const skipCount =
      Object.keys(dataGridInput).length === 0 &&
      !(typeof skip === 'number' && skip > 0)
    const request = skipCount
      ? await this.dcaBotDb.readData(search, undefined, options, true, false)
      : await this.dcaBotDb.readData(search, undefined, options, true, true)
    if (request.status === StatusEnum.notok) {
      return request
    }
    const result = request.data.result
    let total: number
    if (!skipCount) {
      total = (request.data as unknown as { count: number }).count
    } else if (result.length < effectiveLimit) {
      total = result.length
    } else {
      const counted = await this.dcaBotDb.countData(search)
      total =
        counted.status === StatusEnum.ok ? counted.data.result : result.length
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: result.map((d) => ({
        ...d,
        ...convertDCABotToArray(d),
        dealsInBot: d.deals,
        workingTimeTotal:
          d.workingShift && d.workingShift.length > 0
            ? d.workingShift.reduce((acc, v) => {
                if (v.end) {
                  acc += v.end - v.start
                } else if (!v.end) {
                  acc += new Date().getTime() - v.start
                }
                return acc
              }, 0)
            : 0,
      })),
      total,
    }
  }

  protected handleLog(msg: string) {
    logger.info(`${msg}`)
  }

  protected handleDebug(msg: string) {
    logger.debug(`${msg}`)
  }

  protected handleWarn(msg: string) {
    logger.debug(`${msg}`)
  }

  private handleError(msg: string) {
    logger.error(`${msg}`)
  }

  public async changeBotShare(
    {
      botId,
      share,
      type,
      userId,
    }: {
      type: BotType
      botId: string
      share: boolean
      userId: string
    },
    paperContext: boolean,
  ) {
    let shareId = ''
    if (share) {
      shareId = v4()
    }
    this.botEventDb.createData({
      userId: userId,
      botId: botId,
      botType: type,
      event: 'Change bot share',
      metadata: { share, shareId },
      paperContext,
    })
    const filter = { userId, _id: botId }
    if (type === BotType.dca) {
      if (share) {
        const get = await this.dcaBotDb.readData(filter)
        if (get.status === StatusEnum.notok) {
          return get
        }
        if (get.data.result.shareId) {
          return {
            status: StatusEnum.ok,
            data: {
              share,
              shareId: get.data.result.shareId,
            },
            reason: null,
          }
        }
      }
      const result = await this.dcaBotDb.updateData(
        filter,
        { $set: { share, shareId } },
        true,
      )
      if (result.status !== StatusEnum.ok) {
        return result
      }
      if (!result.data) {
        return this.entityNotFound('Bot')
      }
    }
    if (type === BotType.combo) {
      if (share) {
        const get = await this.comboBotDb.readData(filter)
        if (get.status === StatusEnum.notok) {
          return get
        }
        if (get.data.result.shareId) {
          return {
            status: StatusEnum.ok,
            data: {
              share,
              shareId: get.data.result.shareId,
            },
            reason: null,
          }
        }
      }
      const result = await this.comboBotDb.updateData(
        filter,
        { $set: { share, shareId } },
        true,
      )
      if (result.status !== StatusEnum.ok) {
        return result
      }
      if (!result.data) {
        return this.entityNotFound('Bot')
      }
    }
    if (type === BotType.grid) {
      if (share) {
        const get = await this.botDb.readData(filter)
        if (get.status === StatusEnum.notok) {
          return get
        }
        if (get.data.result.shareId) {
          return {
            status: StatusEnum.ok,
            data: {
              share,
              shareId: get.data.result.shareId,
            },
            reason: null,
          }
        }
      }
      const result = await this.botDb.updateData(
        filter,
        { $set: { share, shareId } },
        true,
      )
      if (result.status !== StatusEnum.ok) {
        return result
      }
      if (!result.data) {
        return this.entityNotFound('Bot')
      }
    }
    if (type === BotType.hedgeCombo) {
      if (share) {
        const get = await hedgeComboBotDb.readData(filter)
        if (get.status === StatusEnum.notok) {
          return get
        }
        if (get.data.result.shareId) {
          return {
            status: StatusEnum.ok,
            data: {
              share,
              shareId: get.data.result.shareId,
            },
            reason: null,
          }
        }
      }
      const result = await hedgeComboBotDb.updateData(
        filter,
        { $set: { share, shareId } },
        true,
      )
      if (result.status !== StatusEnum.ok) {
        return result
      }
      if (!result.data) {
        return this.entityNotFound('Bot')
      }
    }
    if (type === BotType.hedgeDca) {
      if (share) {
        const get = await hedgeDCABotDb.readData(filter)
        if (get.status === StatusEnum.notok) {
          return get
        }
        if (get.data.result.shareId) {
          return {
            status: StatusEnum.ok,
            data: {
              share,
              shareId: get.data.result.shareId,
            },
            reason: null,
          }
        }
      }
      const result = await hedgeDCABotDb.updateData(
        filter,
        { $set: { share, shareId } },
        true,
      )
      if (result.status !== StatusEnum.ok) {
        return result
      }
      if (!result.data) {
        return this.entityNotFound('Bot')
      }
    }
    return {
      status: StatusEnum.ok,
      data: {
        share,
        shareId,
      },
      reason: null,
    }
  }

  public async addDealFunds(
    botId: string,
    dealId: string,
    userId: string,
    paperContext: boolean,
    settings: AddFundsSettings,
    fromWebhook = false,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'addDealFunds',
        false,
        botId,
        dealId,
        userId,
        paperContext,
        settings,
        fromWebhook,
      )
    }
    const bot = await this.getDCABotFromDb(
      userId,
      botId,
      undefined,
      paperContext,
    )
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data) {
      return this.entityNotFound('Bot')
    }
    const findLocal = this.dcaBots.find((d) => d.id === botId)
    if (!findLocal) {
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        bot.data.exchange,
        bot.data.uuid,
        [botId, bot.data.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'addDealFunds',
            args: [botId, dealId, settings, fromWebhook],
          })
        },
        paperContext,
        bot.data.settings.type ?? DCATypeEnum.regular,
      )
    } else {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'addDealFunds',
        args: [botId, dealId, settings, fromWebhook],
      })
    }

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Add funds scheduled',
    }
  }

  public async reduceDealFunds(
    botId: string,
    dealId: string,
    userId: string,
    paperContext: boolean,
    settings: AddFundsSettings,
    fromWebhook = false,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'reduceDealFunds',
        false,
        botId,
        dealId,
        userId,
        paperContext,
        settings,
        fromWebhook,
      )
    }
    const bot = await this.getDCABotFromDb(
      userId,
      botId,
      undefined,
      paperContext,
    )
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data) {
      return this.entityNotFound('Bot')
    }
    const findLocal = this.dcaBots.find((d) => d.id === botId)
    if (!findLocal) {
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        bot.data.exchange,
        bot.data.uuid,
        [botId, bot.data.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'reduceDealFunds',
            args: [botId, dealId, settings, fromWebhook],
          })
        },
        paperContext,
        bot.data.settings.type ?? DCATypeEnum.regular,
      )
    } else {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'reduceDealFunds',
        args: [botId, dealId, settings, fromWebhook],
      })
    }

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Reduce funds scheduled',
    }
  }

  public async cancelTerminalDealOrder(
    botId: string,
    dealId: string,
    orderId: string,
    userId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'cancelTerminalDealOrder',
        false,
        botId,
        dealId,
        orderId,
        userId,
        paperContext,
      )
    }
    const bot = await this.getDCABotFromDb(
      userId,
      botId,
      undefined,
      paperContext,
    )
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data) {
      return this.entityNotFound('Bot')
    }
    const findLocal = this.dcaBots.find((d) => d.id === botId)
    if (!findLocal) {
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        bot.data.exchange,
        bot.data.uuid,
        [botId, bot.data.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'cancelTerminalDealOrder',
            args: [botId, dealId, orderId],
          })
        },
        paperContext,
        bot.data.settings.type ?? DCATypeEnum.regular,
      )
    } else {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId: findLocal.id,
        method: 'cancelTerminalDealOrder',
        args: [botId, dealId, orderId],
      })
    }

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Cancel order scheduled',
    }
  }

  public async cancelPendingAddFundsDealOrder(
    botId: string,
    dealId: string,
    orderId: string,
    userId: string,
    paperContext: boolean,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<BaseReturn<string>>(
        BotType.dca,
        'cancelPendingAddFundsDealOrder',
        false,
        botId,
        dealId,
        orderId,
        userId,
        paperContext,
      )
    }
    const bot = await this.getDCABotFromDb(
      userId,
      botId,
      undefined,
      paperContext,
    )
    if (bot.status === StatusEnum.notok) {
      return bot
    }
    if (!bot.data) {
      return this.entityNotFound('Bot')
    }
    const findLocal = this.dcaBots.find((d) => d.id === botId)
    if (!findLocal) {
      await this.createNewBot(
        botId,
        BotType.dca,
        userId,
        bot.data.exchange,
        bot.data.uuid,
        [botId, bot.data.exchange],
        (worker) => {
          worker.postMessage({
            do: 'method',
            botType: BotType.dca,
            botId,
            method: 'cancelPendingAddFundsDealOrder',
            args: [botId, dealId, orderId],
          })
        },
        paperContext,
        bot.data.settings.type ?? DCATypeEnum.regular,
      )
    } else {
      this.getWorkerById(findLocal.worker)?.postMessage({
        do: 'method',
        botType: BotType.dca,
        botId,
        method: 'cancelPendingAddFundsDealOrder',
        args: [botId, dealId, orderId],
      })
    }

    return {
      status: StatusEnum.ok,
      reason: null,
      data: 'Cancel pending add funds request scheduled',
    }
  }

  public async premanenetlyDeleteBots(skip = true) {
    const filter = {
      isDeleted: { $eq: true },
      deleteTime: { $lt: +new Date() },
    }
    let result = ``
    const grid = await this.botDb.readData(
      filter,
      undefined,
      undefined,
      true,
      true,
    )
    if (grid.status !== StatusEnum.ok) {
      return logger.error(grid.reason)
    }
    const trading = await this.dcaBotDb.readData(
      filter,
      undefined,
      undefined,
      true,
      true,
    )
    if (trading.status !== StatusEnum.ok) {
      return logger.error(trading.reason)
    }
    const combo = await this.comboBotDb.readData(
      filter,
      undefined,
      undefined,
      true,
      true,
    )
    if (combo.status !== StatusEnum.ok) {
      return logger.error(combo.reason)
    }
    const botIds = [
      ...grid.data.result.map((r) => r._id.toString()),
      ...trading.data.result.map((r) => r._id.toString()),
      ...combo.data.result.map((r) => r._id.toString()),
    ]
    // Cold-archived bots have their orders/transactions in ClickHouse, not
    // Mongo, so the Mongo cascade below deletes nothing for them — GC the CH
    // rows too (design §1b). Batched: ONE DELETE WHERE botId IN(…), idempotent.
    const coldBotIds = [
      ...grid.data.result,
      ...trading.data.result,
      ...combo.data.result,
    ]
      .filter((r) => (r as { coldArchived?: boolean }).coldArchived)
      .map((r) => `${r._id}`)
    if (grid.data.count > 0 || trading.data.count > 0 || combo.data.count > 0) {
      if (isColdStoreEnabled() && coldBotIds.length) {
        const cold = await ColdClient.getInstance().coldDelete(coldBotIds)
        if (cold?.ok) {
          result = `${result}ColdStore: removed ${coldBotIds.length} bot(s), `
        } else {
          // Non-fatal: the Mongo bot doc is deleted below regardless; orphaned
          // CH rows linger harmlessly until a follow-up orphan sweep reconciles.
          logger.error(
            `[ColdStore] coldDelete failed for ${coldBotIds.length} bot(s); CH rows may linger`,
          )
        }
      }
      const orders = await this.orderDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (orders.status !== StatusEnum.ok) {
        return logger.error(orders.reason)
      }
      result = `${result}Orders: ${orders.reason}, `
      const botEvents = await this.botEventDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (botEvents.status !== StatusEnum.ok) {
        return logger.error(botEvents.reason)
      }
      result = `${result}Bot events: ${botEvents.reason}, `

      const botMessages = await this.botMessageDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (botMessages.status !== StatusEnum.ok) {
        return logger.error(botMessages.reason)
      }
      result = `${result}Bot messages: ${botMessages.reason}, `
      // Deal/transaction ledgers are keyed by the executing bot's `_id`. Unlike
      // orders/events/messages above, they were NEVER purged here — the only
      // other cleaner is the weekly `!skip` orphan-sweep below, which fails at
      // production scale (its unbatched `deleteMany({_id:{$in:[…]}})` exceeds
      // Mongo's 16 MB command limit once orphans reach the millions, so it
      // throws and returns before finishing). Result: `dcadeals`,
      // `transactions` and `combotransactions` accumulated ~52–64% orphans on
      // prod. Purge them per-bot here, bounded to the (few-thousand) botIds
      // being GC'd this run, so the $in stays tiny and this never leaks again.
      const dcaDeals = await this.dcaDealsDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (dcaDeals.status !== StatusEnum.ok) {
        return logger.error(dcaDeals.reason)
      }
      result = `${result}DCA deals: ${dcaDeals.reason}, `
      const transactions = await this.transactionDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (transactions.status !== StatusEnum.ok) {
        return logger.error(transactions.reason)
      }
      result = `${result}Transactions: ${transactions.reason}, `
      const comboTransactions = await this.comboTransactionDb.deleteManyData({
        botId: {
          $in: botIds,
        },
      })
      if (comboTransactions.status !== StatusEnum.ok) {
        return logger.error(comboTransactions.reason)
      }
      result = `${result}Combo transactions: ${comboTransactions.reason}, `
      if (trading.data.count > 0) {
        const tradingDelete = await this.dcaBotDb.deleteManyData(filter)
        if (tradingDelete.status !== StatusEnum.ok) {
          return logger.error(tradingDelete.reason)
        }
        result = `${result}Trading: ${tradingDelete.reason}, `
      }
      if (combo.data.count > 0) {
        const comboDelete = await this.comboBotDb.deleteManyData(filter)
        if (comboDelete.status !== StatusEnum.ok) {
          return logger.error(comboDelete.reason)
        }
        result = `${result}Combo: ${comboDelete.reason}, `
      }
      if (grid.data.count > 0) {
        const gridDelete = await this.botDb.deleteManyData(filter)
        if (gridDelete.status !== StatusEnum.ok) {
          return logger.error(gridDelete.reason)
        }
        result = `${result}Grid: ${gridDelete.reason}, `
      }
    }
    if (!skip) {
      const comboDealWOutBots = await this.comboDealsDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'combobots',
            as: 'comboBot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            comboBot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (comboDealWOutBots.status === StatusEnum.notok) {
        return logger.error(comboDealWOutBots.reason)
      }
      const comboIds = (comboDealWOutBots.data.result as { _id: string }[]).map(
        (d) => d._id.toString(),
      )
      const comboDeleteResult = await this.comboDealsDb.deleteManyData({
        _id: { $in: comboIds },
      })
      if (comboDeleteResult.status === StatusEnum.notok) {
        return logger.error(comboDeleteResult.reason)
      } else {
        result = `${result}Deals without bot ${comboDeleteResult.reason}, `
      }
      const comboTransactionsWOutBots = await this.comboTransactionDb.aggregate(
        [
          botIdIsObjectId,
          {
            $lookup: {
              from: 'combobots',
              as: 'combobot',
              let: {
                searchBotId: {
                  $toObjectId: '$botId',
                },
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ['$_id', '$$searchBotId'],
                    },
                  },
                },
                {
                  $project: {
                    _id: 1,
                  },
                },
              ],
            },
          },
          {
            $match: {
              combobot: {
                //@ts-ignore
                $size: 0,
              },
            },
          },
        ],
      )
      if (comboTransactionsWOutBots.status === StatusEnum.notok) {
        return logger.error(comboTransactionsWOutBots.reason)
      }
      const comboTransactionsIds = (
        comboTransactionsWOutBots.data.result as { _id: string }[]
      ).map((d) => d._id.toString())
      const comboTransactionsDeleteResult =
        await this.comboTransactionDb.deleteManyData({
          _id: { $in: comboTransactionsIds },
        })
      if (comboTransactionsDeleteResult.status === StatusEnum.notok) {
        return logger.error(comboTransactionsDeleteResult.reason)
      } else {
        result = `${result}Combo transactions without bot ${comboTransactionsDeleteResult.reason}, `
      }
      const comboMinigridsWOutBots = await this.comboMinigridDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'combobots',
            as: 'combobot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            combobot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (comboMinigridsWOutBots.status === StatusEnum.notok) {
        return logger.error(comboMinigridsWOutBots.reason)
      }
      const comboMinigridIds = (
        comboMinigridsWOutBots.data.result as { _id: string }[]
      ).map((d) => d._id.toString())
      const comboMinigridDeleteResult =
        await this.comboMinigridDb.deleteManyData({
          _id: { $in: comboMinigridIds },
        })
      if (comboMinigridDeleteResult.status === StatusEnum.notok) {
        return logger.error(comboMinigridDeleteResult.reason)
      } else {
        result = `${result}Combo minigrids without bot ${comboMinigridDeleteResult.reason}, `
      }
      const comboProfitWOutBots = await this.comboProfitDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'combobots',
            as: 'combobot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            combobot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (comboProfitWOutBots.status === StatusEnum.notok) {
        return logger.error(comboProfitWOutBots.reason)
      }
      const comboProfitIds = (
        comboProfitWOutBots.data.result as { _id: string }[]
      ).map((d) => d._id.toString())
      const comboProfitDeleteResult = await this.comboProfitDb.deleteManyData({
        _id: { $in: comboProfitIds },
      })
      if (comboProfitDeleteResult.status === StatusEnum.notok) {
        return logger.error(comboProfitDeleteResult.reason)
      } else {
        result = `${result}Combo profit without bot ${comboProfitDeleteResult.reason}, `
      }
      const eventsWOutBots = await this.botEventDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'bots',
            as: 'bot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcabot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'combobots',
            as: 'combobot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            bot: {
              //@ts-ignore
              $size: 0,
            },
            dcabot: {
              //@ts-ignore
              $size: 0,
            },
            combobot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (eventsWOutBots.status === StatusEnum.notok) {
        return logger.error(eventsWOutBots.reason)
      }
      const eventIds = (eventsWOutBots.data.result as { _id: string }[]).map(
        (d) => d._id.toString(),
      )
      const eventsDeleteResult = await this.botEventDb.deleteManyData({
        _id: { $in: eventIds },
      })
      if (eventsDeleteResult.status === StatusEnum.notok) {
        return logger.error(eventsDeleteResult.reason)
      } else {
        result = `${result}Events without bot ${eventsDeleteResult.reason}, `
      }
      const messagesWOutBots = await this.botMessageDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'bots',
            as: 'bot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcabot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'combobots',
            as: 'combobot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            bot: {
              //@ts-ignore
              $size: 0,
            },
            dcabot: {
              //@ts-ignore
              $size: 0,
            },
            combobot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (messagesWOutBots.status === StatusEnum.notok) {
        return logger.error(messagesWOutBots.reason)
      }
      const messageIds = (
        messagesWOutBots.data.result as { _id: string }[]
      ).map((d) => d._id.toString())
      const messagesDeleteResult = await this.botMessageDb.deleteManyData({
        _id: { $in: messageIds },
      })
      if (messagesDeleteResult.status === StatusEnum.notok) {
        return logger.error(messagesDeleteResult.reason)
      } else {
        result = `${result}Messages without bot ${messagesDeleteResult.reason}, `
      }
      const dealWOutBots = await this.dcaDealsDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcaBot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            dcaBot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (dealWOutBots.status === StatusEnum.notok) {
        return logger.error(dealWOutBots.reason)
      }

      const ids = (dealWOutBots.data.result as { _id: string }[]).map((d) =>
        d._id.toString(),
      )
      const deleteResult = await this.dcaDealsDb.deleteManyData({
        _id: { $in: ids },
      })
      if (deleteResult.status === StatusEnum.notok) {
        return logger.error(deleteResult.reason)
      } else {
        result = `${result}Deals without bot ${deleteResult.reason}, `
      }
      const ordersWOutBots = await this.orderDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'bots',
            as: 'bot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'dcabots',
            as: 'dcabot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'combobots',
            as: 'combobot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            bot: {
              //@ts-ignore
              $size: 0,
            },
            dcabot: {
              //@ts-ignore
              $size: 0,
            },
            combobot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (ordersWOutBots.status === StatusEnum.notok) {
        return logger.error(ordersWOutBots.reason)
      }
      const ordersIds = (ordersWOutBots.data.result as { _id: string }[]).map(
        (d) => d._id.toString(),
      )
      const ordersDeleteResult = await this.orderDb.deleteManyData({
        _id: { $in: ordersIds },
      })
      if (ordersDeleteResult.status === StatusEnum.notok) {
        return logger.error(ordersDeleteResult.reason)
      } else {
        result = `${result}Orders without bot ${ordersDeleteResult.reason}, `
      }
      const transactionsWOutBots = await this.transactionDb.aggregate([
        botIdIsObjectId,
        {
          $lookup: {
            from: 'bots',
            as: 'bot',
            let: {
              searchBotId: {
                $toObjectId: '$botId',
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$_id', '$$searchBotId'],
                  },
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
          },
        },
        {
          $match: {
            bot: {
              //@ts-ignore
              $size: 0,
            },
          },
        },
      ])
      if (transactionsWOutBots.status === StatusEnum.notok) {
        return logger.error(transactionsWOutBots.reason)
      }
      const transactionsIds = (
        transactionsWOutBots.data.result as { _id: string }[]
      ).map((d) => d._id.toString())
      const transactionsDeleteResult = await this.transactionDb.deleteManyData({
        _id: { $in: transactionsIds },
      })
      if (transactionsDeleteResult.status === StatusEnum.notok) {
        return logger.error(transactionsDeleteResult.reason)
      } else {
        result = `${result}Transactions without bot ${transactionsDeleteResult.reason}, `
      }
    }

    return logger.info(result)
  }

  public async compareBalances(userId: string, _botId: string, dealId: string) {
    if (!this.useBots) {
      return await this.callExternalBotService<
        BaseReturn<CompareBalancesResponse>
      >(BotType.combo, 'compareBalances', false, userId, _botId, dealId)
    }
    const findDeal = await this.comboDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId
    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (!findLocal) {
      return this.entityNotFound('Bot')
    }
    const worker = this.getWorkerById(findLocal.worker)
    const result = await new Promise<CompareBalancesResponse | null>(
      (resolve, reject) => {
        const responseId = v4()
        let timer: NodeJS.Timeout | null = null
        const cb = (msg: any) => {
          if ('responseId' in msg && msg.responseId === responseId) {
            worker?.removeListener('message', cb)
            resolve(msg.response as CompareBalancesResponse)
            if (timer) {
              clearTimeout(timer)
            }
          }
        }
        timer = setTimeout(
          () => {
            this.handleDebug(`Timeout for compareBalances ${dealId}`)
            worker?.removeListener('message', cb)
            reject(null)
          },
          2 * 60 * 1000,
        )
        worker?.on('message', cb)
        worker?.postMessage({
          do: 'method',
          botType: BotType.combo,
          botId,
          method: 'compareBalances',
          args: [dealId],
          responseId,
        })
      },
    )
    if (result) {
      return {
        status: StatusEnum.ok,
        reason: null,
        data: result,
      }
    }
    return {
      status: StatusEnum.notok,
      data: null,
      reason: 'Unexpected error. Please try again later',
    }
  }

  public async manageBalanceDiff(
    userId: string,
    _botId: string,
    dealId: string,
    qty: number,
    side: OrderSideEnum,
  ) {
    if (!this.useBots) {
      return await this.callExternalBotService<
        BaseReturn<CompareBalancesResponse>
      >(
        BotType.combo,
        'manageBalanceDiff',
        false,
        userId,
        _botId,
        dealId,
        qty,
        side,
      )
    }
    const findDeal = await this.comboDealsDb.readData({
      _id: dealId,
      status: { $nin: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled] },
      userId,
    })
    if (findDeal.status === StatusEnum.notok) {
      return findDeal
    }
    if (!findDeal.data.result) {
      return this.entityNotFound('Deal')
    }
    const botId = findDeal.data.result.botId
    const findLocal = this.comboBots.find(
      (d) => d.id === botId && d.userId === userId,
    )
    if (!findLocal) {
      return this.entityNotFound('Bot')
    }
    const worker = this.getWorkerById(findLocal.worker)
    worker?.postMessage({
      do: 'method',
      botType: BotType.combo,
      botId,
      method: 'manageBalanceDiff',
      args: [dealId, qty, side],
    })
    return {
      status: StatusEnum.ok,
      data: null,
      reason: 'Rebalancing order scheduled',
    }
  }
  async checkNotEnoughBalanceError() {
    const prefix = `Checking not enough balance error bots`
    this.handleDebug(`${prefix} start`)
    const filter = {
      'notEnoughBalance.thresholdPassed': true,
      'notEnoughBalance.thresholdPassedTime': {
        $lt: +new Date() - 7 * 24 * 60 * 60 * 1000,
      },
      status: {
        $in: [
          BotStatusEnum.error,
          BotStatusEnum.monitoring,
          BotStatusEnum.range,
          BotStatusEnum.open,
        ],
      },
    }
    const fields = {
      _id: 1,
      parentBotId: 1,
    } as ProjectionFields<MainBot>
    const dcaBots = await this.dcaBotDb.readData(filter, fields, {}, true)
    const comboBots = await this.comboBotDb.readData(filter, fields, {}, true)
    const gridBots = await this.botDb.readData(filter, fields, {}, true)
    const singleBots: Map<string, { type: BotType; id: string }> = new Map()
    for (const bot of dcaBots.data?.result ?? []) {
      singleBots.set(
        bot.parentBotId ?? `${bot._id}`,
        bot.parentBotId
          ? { type: BotType.hedgeDca, id: bot.parentBotId }
          : { type: BotType.dca, id: `${bot._id}` },
      )
    }
    for (const bot of comboBots.data?.result ?? []) {
      singleBots.set(
        bot.parentBotId ?? `${bot._id}`,
        bot.parentBotId
          ? { type: BotType.hedgeCombo, id: bot.parentBotId }
          : { type: BotType.combo, id: `${bot._id}` },
      )
    }
    for (const bot of gridBots.data?.result ?? []) {
      singleBots.set(`${bot._id}`, {
        type: BotType.grid,
        id: `${bot._id}`,
      })
    }
    this.handleDebug(
      `${prefix} Found ${
        singleBots.size
      } bots with not enough balance error ${JSON.stringify([
        ...singleBots.values(),
      ])}`,
    )
    /** TODO: stop logic here */
    this.handleDebug(`${prefix} end`)
  }

  @IdMute(mutex, () => 'closeOldStartDeals')
  async closeOldStartDeals() {
    const prefix = `Closing old start deals | `
    this.handleLog(`${prefix} start`)
    const startDcaDeals = await this.dcaDealsDb.readData(
      {
        status: DCADealStatusEnum.start,
        $not: { type: 'terminal', 'settings.useLimitPrice': true },
        createTime: {
          $lt: +new Date() - 24 * 60 * 60 * 1000,
        },
      },
      {},
      {},
      true,
    )
    if (startDcaDeals.status === StatusEnum.notok) {
      this.handleError(
        `${prefix} error in reading deals: ${startDcaDeals.reason}`,
      )
    } else {
      this.handleLog(
        `${prefix} found ${startDcaDeals.data?.result.length} DCA deals to close`,
      )
      for (let i = 0; i < startDcaDeals.data?.result.length; i++) {
        const deal = startDcaDeals.data?.result[i]
        this.handleLog(
          `${prefix} closing DCA deal ${deal._id} ${i + 1}/${startDcaDeals.data?.result.length}`,
        )
        await this.closeDCADeal(
          deal.userId,
          deal.botId,
          `${deal._id}`,
          CloseDCATypeEnum.cancel,
          undefined,
          deal.paperContext,
          DCACloseTriggerEnum.auto,
        )
      }
    }
    const startComboDeals = await this.comboDealsDb.readData(
      {
        status: DCADealStatusEnum.start,
        createTime: {
          $lt: +new Date() - 24 * 60 * 60 * 1000,
        },
      },
      {},
      {},
      true,
    )
    if (startComboDeals.status === StatusEnum.notok) {
      this.handleError(
        `${prefix} error in reading combo deals: ${startComboDeals.reason}`,
      )
    } else {
      this.handleLog(
        `${prefix} found ${startComboDeals.data?.result.length} Combo deals to close`,
      )
      for (let i = 0; i < startComboDeals.data?.result.length; i++) {
        const deal = startComboDeals.data?.result[i]
        this.handleLog(
          `${prefix} closing Combo deal ${deal._id} ${i + 1}/${startDcaDeals.data?.result.length}`,
        )
        await this.closeComboDeal(
          deal.userId,
          deal.botId,
          `${deal._id}`,
          CloseDCATypeEnum.cancel,
          undefined,
          deal.paperContext,
          DCACloseTriggerEnum.auto,
        )
      }
    }
  }
}

export default Bot
