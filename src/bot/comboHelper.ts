import Big from 'big.js'
import type {
  ComboBotSchema,
  ComboDealsSchema,
  ComboDealsSettings,
  CleanComboMinigridSchema,
  ClearComboTransactionSchema,
  ExcludeDoc,
  Grid,
  Order,
  CleanComboDealsSchema,
  PriceMessage,
  GridBreakpoint,
  PositionInBot,
  Symbols,
  Sizes,
  DynamicArPrices,
  BotParentProcessStatsEventDtoDcaCombo,
  DealStopLossCombo,
  CompareBalancesResponse,
  OrderStatusType,
} from '../../types'
import type { InitialGrid } from './helper'
import type { FullDeal } from './dcaHelper'
import {
  minigridDb,
  comboTransactionsDb,
  comboDealsDb,
  comboBotDb,
} from '../db/dbInit'
import {
  BotStatusEnum,
  ExchangeEnum,
  ComboTpBase,
  StartConditionEnum,
  OrderSizeTypeEnum,
  BotFlags,
  PositionSide,
  DCADealStatusEnum,
  CloseDCATypeEnum,
  ComboMinigridStatusEnum,
  OrderSideEnum,
  BotType,
  setToRedisDelay,
  StatusEnum,
  TypeOrderEnum,
  OrderTypeEnum,
  FuturesStrategyEnum,
  BalancesAction,
  IndicatorStartConditionEnum,
  BotStartTypeEnum,
  DCADealFlags,
  ActionsEnum,
  DCACloseTriggerEnum,
} from '../../types'
import { IdMute, IdMutex } from '../utils/mutex'
import utils from '../utils'
const { sleep } = utils
import { RunWithDelay } from '../utils/delay'
import { DealStats } from './worker/statsService'
import createDCABotHelper from './dcaHelper'

const mutex = new IdMutex()
const mutexConcurrently = new IdMutex(300)

export type FullMinigrid = {
  schema: CleanComboMinigridSchema
  initialGrids: InitialGrid[]
  currentOrders: Grid[]
}

export type LastMinigridOrdes = {
  time: number
  side: OrderSideEnum.buy | OrderSideEnum.sell
  price: number
}

type MainBot<
  Schema extends ComboBotSchema = ComboBotSchema,
  Deal extends ComboDealsSchema = ComboDealsSchema,
> = InstanceType<ReturnType<typeof createDCABotHelper<Schema, Deal>>>

function createComboBotHelper<
  Schema extends ComboBotSchema = ComboBotSchema,
  Deal extends ComboDealsSchema = ComboDealsSchema,
  TBaseClass extends new (...args: any[]) => MainBot = new (
    ...args: any[]
  ) => MainBot,
>(BaseClass?: TBaseClass) {
  const ActualBaseClass = (BaseClass ||
    createDCABotHelper<Schema, Deal>()) as TBaseClass extends new (
    ...args: any[]
  ) => infer T
    ? new (
        id: string,
        exchange: ExchangeEnum,
        log?: boolean,
        serviceRestart?: boolean,
        ignoreStats?: boolean,
      ) => T
    : new (
        id: string,
        exchange: ExchangeEnum,
        log?: boolean,
        serviceRestart?: boolean,
        ignoreStats?: boolean,
      ) => InstanceType<ReturnType<typeof createDCABotHelper<Schema, Deal>>>

  class ComboBot extends ActualBaseClass {
    private minigridDb = minigridDb
    private minigrids: Map<string, FullMinigrid> = new Map()
    transactionsDb = comboTransactionsDb
    private lastMinigridOrder: Map<string, LastMinigridOrdes> = new Map()
    private usedOrderId: Map<string, Set<string>> = new Map()
    private feeOrderReasons: Map<string, string[]> = new Map()
    private lastFilledOrderMap: Map<string, Order> = new Map()

    constructor(
      id: string,
      exchange: ExchangeEnum,
      log = true,
      serviceRestart = false,
      ignoreStats = false,
    ) {
      super(id, exchange, log, serviceRestart, ignoreStats)
      this.dealsDb = comboDealsDb
      this.db = comboBotDb
      this.botType = BotType.combo
      this.combo = true
      this.triggerStopLossCombo = this.triggerStopLossCombo.bind(this)
    }
    setMingridByDeal(dealId: string, id: string) {
      if (!id) {
        return
      }
      this.minigridDealMap.set(
        dealId,
        (this.minigridDealMap.get(dealId) ?? new Set()).add(id),
      )
    }
    removeMingridByDeal(dealId: string, id: string) {
      const get = this.minigridDealMap.get(dealId)
      if (get) {
        get.delete(id)
      }
    }
    @RunWithDelay(
      (botId: string) => `${botId}saveMinigridToRedis`,
      (_botId: string, restart: boolean) => setToRedisDelay * (restart ? 5 : 2),
    )
    saveMinigridToRedis(_botId: string, _restart: boolean) {
      this.setToRedis('minigrids', this.allMinigrids)
    }
    setMinigrid(minigrid: FullMinigrid, save = true) {
      this.minigrids.set(minigrid.schema._id, minigrid)
      this.setMingridByDeal(minigrid.schema.dealId, minigrid.schema._id)
      if (save) {
        this.saveMinigridToRedis(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        )
      }
    }
    getMinigrid(key?: string) {
      if (!key) {
        return
      }
      return this.minigrids.get(key)
    }
    deleteMinigrid(id: string, save = true) {
      const get = this.minigrids.get(id)
      this.minigrids.delete(id)
      if (get) {
        this.removeMingridByDeal(get.schema.dealId, id)
      }
      if (save) {
        this.saveMinigridToRedis(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        )
      }
    }
    getMinigridByDealId({ dealId }: { dealId?: string | string[] }) {
      const ids: Set<string> = new Set()
      if (dealId) {
        for (const s of [dealId].flat()) {
          const getByDeal = this.minigridDealMap.get(s)
          if (getByDeal) {
            for (const id of getByDeal) {
              ids.add(id)
            }
          }
        }
      }
      const result: FullMinigrid[] = []
      for (const id of ids) {
        const order = this.minigrids.get(id)
        if (order) {
          result.push(order)
        }
      }
      return result
    }
    get allMinigrids() {
      return [...this.minigrids.values()]
    }
    updateUsedOrderId() {
      this.setToRedis(
        'usedOrderId',
        [...this.usedOrderId.entries()].map(([k, s]) => [k, [...s.values()]]),
      )
    }

    @IdMute(
      mutex,
      (fullDeal: FullMinigrid) =>
        `${fullDeal.schema._id}@${fullDeal.schema.botId}saveMinigrid`,
    )
    private async saveMinigrid(
      fullMinigrid: FullMinigrid,
      minigrid: Partial<any>,
    ) {
      const minigridId = fullMinigrid.schema._id
      const get = this.getMinigrid(minigridId)
      let fullResult: FullMinigrid = fullMinigrid
      if (get) {
        const result: FullMinigrid = {
          ...fullMinigrid,
          schema: {
            ...get.schema,
            ...minigrid,
          },
        }
        fullResult = result
        this.setMinigrid(fullResult)
      }
      if (minigrid && Object.keys(minigrid).length && this.shouldProceed()) {
        this.minigridDb
          .updateData({ _id: minigridId }, { $set: { ...minigrid } as any })
          .then((res) => {
            if (res.status === StatusEnum.notok) {
              this.handleErrors(
                `Error saving minigrid: ${minigridId}. Reason: ${res.reason}`,
                '',
                '',
                false,
                false,
                false,
              )
            }
          })
        this.emit('bot minigrid update', {
          ...fullMinigrid.schema,
          botName: this.data?.settings.name ?? '',
        })
      }
    }
    get feeOrder() {
      return this.futures
        ? undefined
        : typeof this.data?.settings.feeOrder !== 'undefined' &&
            this.data?.settings.feeOrder
          ? false
          : undefined
    }
    private async createMinigrid(
      deal: ExcludeDoc<ComboDealsSchema>,
      order: Order,
      lockClose: boolean,
      _initialPrice?: number,
    ) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('create minigrid'))
        return
      }
      const _id = this.startMethod('createMinigrid')
      this.handleLog(`Create minigrid for ${order.clientOrderId}`)
      const findDeal = this.getDeal(deal._id)
      const settings = (await this.getAggregatedSettings(
        findDeal?.deal,
      )) as ComboBotSchema['settings']
      const baseOrder = order.typeOrder === TypeOrderEnum.dealStart
      const price = deal.initialPrice
      const stepScale = parseFloat(settings.stepScale)
      const stepVal = baseOrder
        ? 1
        : order.dcaLevel
          ? stepScale ** (order.dcaLevel - 2)
          : 1
      const gridStep =
        (baseOrder
          ? price * (+(settings.baseStep ?? settings.step) / 100)
          : price * (+settings.step / 100)) * stepVal
      const startPrice = baseOrder
        ? order.type === OrderTypeEnum.market
          ? +order.price
          : +order.origPrice
        : +order.origPrice
      const initialPrice = _initialPrice ?? startPrice
      const lowPrice = this.isLong ? startPrice : startPrice - gridStep
      const topPrice = this.isLong ? startPrice + gridStep : startPrice
      const pair = deal.symbol.symbol
      const ed = await this.getExchangeInfo(pair)
      const levels = Math.floor(
        +(baseOrder
          ? (settings.baseGridLevels ?? settings.gridLevel)
          : settings.gridLevel),
      )
      const fee =
        order.type === OrderTypeEnum.market
          ? ((await this.getUserFee(pair))?.taker ?? 0)
          : ((await this.getUserFee(pair))?.maker ?? 0)
      const sellDisplacement = fee * 2
      const profitCurrency = settings.futures
        ? 'quote'
        : settings.profitCurrency
      const orderFixedIn = settings.futures
        ? settings.coinm
          ? ('quote' as const)
          : ('base' as const)
        : settings.profitCurrency === 'quote'
          ? ('base' as const)
          : ('quote' as const)
      const initialGrids: InitialGrid[] =
        (await this.generateBasicGrids({
          pair,
          topPrice,
          lowPrice,
          sellDisplacement,
          gridType: 'arithmetic',
          levels,
        })) ?? []
      const precision = await this.baseAssetPrecision(pair)
      let budget =
        order.minigridBudget ??
        (this.futures
          ? this.coinm
            ? +order.executedQty
            : this.math.round(+order.executedQty * startPrice, precision, true)
          : (this.math.round(+order.executedQty / levels, precision, true) -
              (ed?.baseAsset.step ?? 0) * levels) *
            startPrice *
            levels *
            (1 - fee))
      const feeFactor = 1 + fee
      const executed =
        (this.coinm ? +order.executedQty : +order.executedQty * +order.price) *
        (settings.futures ? 1 : !this.isLong ? 2 - feeFactor : 1)
      if (executed < budget && !this.futures) {
        budget = executed
      }
      let grids = (
        (await this.generateGridsOnPrice(
          {
            pair,
            initialGrids,
            lowPrice,
            topPrice,
            levels,
            updatedBudget: true,
            _budget: budget,
            _lastPrice: initialPrice,
            _initialPriceStart: initialPrice,
            _side:
              order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
            all: true,
            profitCurrency,
            orderFixedIn,
          },
          !this.isLong,
          this.data?.settings.newBalance,
          this.feeOrder,
          findDeal?.deal.tags?.includes('newSell'),
        )) ?? []
      ).map((g) => ({
        ...g,
        newClientOrderId: this.getOrderId(`CMB-GR`),
        dealId: deal._id,
        type: TypeOrderEnum.dealGrid,
      }))
      const buys = grids.filter((g) => g.side === OrderSideEnum.buy)
      const sells = grids.filter((g) => g.side === OrderSideEnum.sell)
      const base = sells.reduce((acc, o) => acc + o.qty, 0)
      const quote = buys.reduce((acc, o) => acc + o.qty * o.price, 0)
      const asset = {
        base,
        quote,
      }
      const time = order.updateTime
      const minigridSchema: Omit<CleanComboMinigridSchema, '_id'> = {
        botId: this.botId,
        userId: this.userId,
        dealId: deal._id,
        dcaOrderId: order.clientOrderId,
        grids: { buy: buys.length, sell: sells.length },
        status: ComboMinigridStatusEnum.active,
        initialBalances: asset,
        currentBalances: asset,
        initialPrice: initialPrice,
        realInitialPrice: +order.price,
        lastPrice: initialPrice,
        lastSide: order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
        profit: {
          total: 0,
          totalUsd: 0,
          pureBase: 0,
          pureQuote: 0,
        },
        feePaid: {
          base: 0,
          quote: 0,
        },
        avgPrice: initialPrice,
        createTime: time,
        updateTime: time,
        assets: { used: asset, required: asset },
        paperContext: !!this.data?.paperContext,
        exchange: this.data?.exchange ?? '',
        exchangeUUID: this.data?.exchangeUUID ?? '',
        symbol: deal.symbol,
        settings: {
          topPrice,
          lowPrice,
          levels,
          budget,
          sellDisplacement,
          profitCurrency,
          orderFixedIn,
        },
        transactions: {
          buy: 0,
          sell: 0,
        },
        lockClose,
      }
      const saved = await this.minigridDb.createData(minigridSchema)
      if (saved.status === StatusEnum.notok) {
        this.handleErrors(
          `Cannot create minigrid: ${saved.reason}`,
          'createDeal()',
          'create deal',
        )
        this.endMethod(_id)
        return
      }
      this.handleLog(
        `Create minigrid ${saved.data._id} for ${order.clientOrderId}`,
      )
      const minigridId = `${saved.data._id}`
      grids = grids.map((g) => ({ ...g, minigridId }))
      const minigrid: FullMinigrid = {
        initialGrids,
        currentOrders: grids,
        schema: { ...minigridSchema, _id: minigridId },
      }
      this.setMinigrid(minigrid)
      this.endMethod(_id)
      return grids
    }
    private async prepareMinigrids(
      minigrids: ExcludeDoc<CleanComboMinigridSchema>[],
    ): Promise<FullMinigrid[]> {
      let result: FullMinigrid[] = []
      for (const minigrid of minigrids) {
        let initialGrids: InitialGrid[] = []
        let currentOrders: Grid[] = []
        const safeMinigridId = `${minigrid._id}`
        if (minigrid.initialPrice !== 0 && minigrid.lastPrice !== 0) {
          const pair = minigrid.symbol.symbol
          const {
            settings: {
              lowPrice,
              topPrice,
              sellDisplacement,
              levels,
              budget,
              profitCurrency,
              orderFixedIn,
            },
          } = minigrid
          initialGrids =
            (await this.generateBasicGrids({
              pair,
              topPrice,
              lowPrice,
              sellDisplacement,
              gridType: 'arithmetic',
              levels,
            })) ?? []
          currentOrders = (
            (await this.generateGridsOnPrice(
              {
                pair,
                initialGrids,
                lowPrice,
                topPrice,
                levels,
                updatedBudget: true,
                _budget: budget,
                _lastPrice: minigrid.lastPrice,
                _initialPriceStart: minigrid.initialPrice,
                _side: minigrid.lastSide,
                all: true,
                profitCurrency,
                orderFixedIn,
              },
              !this.isLong,
              this.data?.settings.newBalance,
              this.feeOrder,
              this.getDeal(minigrid.dealId)?.deal.tags?.includes('newSell'),
            )) ?? []
          ).map((g) => ({
            ...g,
            newClientOrderId: this.getOrderId(`CMB-GR`),
            dealId: minigrid.dealId,
            type: TypeOrderEnum.dealGrid,
            minigridId: safeMinigridId,
          }))
        }
        const fullMinigrid = {
          initialGrids,
          currentOrders,
          schema: {
            ...minigrid,
            _id: safeMinigridId,
          },
        }
        result = [
          ...result.filter((m) => m.schema._id !== safeMinigridId),
          fullMinigrid,
        ]
      }
      return result
    }

    private async loadMinigrids() {
      this.handleLog('Start finding minigrids')
      const _id = this.startMethod('loadMinigrids')
      if (this.serviceRestart && !this.secondRestart) {
        const fromRedis = await this.getFromRedis<FullMinigrid[]>('minigrids')
        if (fromRedis?.length) {
          this.handleLog(`Found in redis ${fromRedis.length} minigrids`)
          for (const m of fromRedis) {
            if (m.schema.status !== ComboMinigridStatusEnum.closed) {
              const currentOrders: Grid[] = []
              for (const o of m.currentOrders) {
                currentOrders.push({
                  ...o,
                  qty: this.math.round(
                    o.qty,
                    await this.baseAssetPrecision(m.schema.symbol.symbol),
                  ),
                  newClientOrderId: this.getOrderId(`CMB-GR`),
                })
              }
              this.setMinigrid(
                {
                  ...m,
                  currentOrders,
                },
                false,
              )
            }
          }
        }
      }
      if (
        !(this.serviceRestart && !this.secondRestart) ||
        !this.minigrids.size
      ) {
        const minigridData = await this.minigridDb.readData(
          {
            botId: this.botId,
            dealId: { $in: [...this.deals.keys()] },
          } as any,
          undefined,
          {},
          true,
        )

        if (minigridData.status === StatusEnum.notok) {
          this.loadingComplete = true
          this.endMethod(_id)
          return this.handleErrors(
            `Error getting mingrids from DB: ${minigridData.reason}`,
            'loadOrders()',
            'reading deals',
          )
        }
        this.handleLog(
          `Found ${minigridData.data.result?.length} minigrids for active deals`,
        )
        const filteredMinigrids = minigridData.data.result.filter(
          (m) => m.status !== ComboMinigridStatusEnum.closed,
        )
        const closedMinigrids = minigridData.data.result.filter(
          (m) => m.status === ComboMinigridStatusEnum.closed,
        )
        for (const c of closedMinigrids) {
          const deal = this.getDeal(c.dealId)
          const order = this.getOrderFromMap(c.dcaOrderId)
          if (
            order &&
            deal &&
            order.typeOrder === TypeOrderEnum.dealStart &&
            deal.deal.status === DCADealStatusEnum.open
          ) {
            if (!deal.closeBySl) {
              this.handleLog(
                `Found closed base order minigrid ${c._id} for deal ${deal?.deal._id}`,
              )
              deal.closeBySl = true

              this.saveDeal(deal)
              this.closeDealById(
                this.botId,
                deal.deal._id,
                CloseDCATypeEnum.closeByMarket,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                DCACloseTriggerEnum.base,
              )
            }
          }
        }
        this.handleLog(`Found ${filteredMinigrids.length} active minigrids`)
        if (filteredMinigrids.length > 0) {
          const openMinigrids = [...filteredMinigrids].filter((m) =>
            [
              ComboMinigridStatusEnum.active,
              ComboMinigridStatusEnum.range,
            ].includes(m.status),
          )

          filteredMinigrids
            .map((m) => ({
              schema: { ...m, _id: `${m._id}` },
              initialGrids: [],
              currentOrders: [],
            }))
            .map((m) => this.setMinigrid(m, false))

          for (const minigrid of await this.prepareMinigrids(openMinigrids)) {
            this.setMinigrid(minigrid, false)
          }
          this.saveMinigridToRedis(
            this.botId,
            this.serviceRestart && !this.secondRestart,
          )
          for (const m of this.allMinigrids) {
            if (!(await this.getExchangeInfo(m.schema.symbol.symbol))) {
              this.handleDebug(
                `Cannot find exchange info for ${m.schema.symbol.symbol}`,
              )
              this.fillExchangeInfo(m.schema.symbol.symbol)
              if (await this.confirmPairMissing(m.schema.symbol.symbol)) {
                this.handleDebug(`Push ${m.schema.symbol.symbol} to not found`)
                this.pairsNotFound.add(m.schema.symbol.symbol)
              }
            }
            if (!(await this.getUserFee(m.schema.symbol.symbol))) {
              this.handleDebug(`Cannot find fee for ${m.schema.symbol.symbol}`)
              this.getUserFees(m.schema.symbol.symbol)
              if (!(await this.getUserFee(m.schema.symbol.symbol))) {
                this.handleDebug(`Push ${m.schema.symbol.symbol} to not found`)
                this.pairsNotFound.add(m.schema.symbol.symbol)
              }
            }
          }
        }
      }
      this.endMethod(_id)
    }
    private async loadTransactions() {
      this.handleLog('Start finding transactions')
      const _id = this.startMethod('loadTransactions')

      if (this.serviceRestart && !this.secondRestart) {
        const fromRedis =
          await this.getFromRedis<[string, string[]][]>('usedOrderId')
        if (fromRedis?.length) {
          this.handleLog(
            `Found used orders id in redis ${fromRedis.length} length`,
          )
          fromRedis.forEach(([d, s]) => {
            this.usedOrderId.set(d, new Set(s))
          })
        }
      }
      if (
        !(this.serviceRestart && !this.secondRestart) ||
        !this.usedOrderId.size
      ) {
        const transactions = await this.transactionsDb.readData(
          {
            $and: [{ idBuy: { $ne: '' } }, { idSell: { $ne: '' } }],
            botId: this.botId,
            dealId: { $in: [...this.deals.keys()] },
            userId: this.userId,
          },
          { idBuy: 1, idSell: 1, dealId: 1 },
          {},
          true,
        )
        if (transactions.status === StatusEnum.notok) {
          this.loadingComplete = true
          this.endMethod(_id)
          return this.handleErrors(
            `Error getting transactions from DB: ${transactions.reason}`,
            'loadOrders()',
            'reading transactions',
          )
        }
        this.handleLog(
          `Found ${transactions.data.result?.length} total transactions for active deals`,
        )
        transactions.data.result.map((t) => {
          if (t.dealId) {
            const set = this.usedOrderId.get(t.dealId) ?? new Set()
            set.add(t.idBuy)
            set.add(t.idSell)
            this.usedOrderId.set(t.dealId, set)
          }
        })
      }
      this.endMethod(_id)
    }
    override async loadOrders(): Promise<void> {
      const _id = this.startMethod('loadOrders')
      await super.loadOrders()
      await this.loadMinigrids()
      await this.loadTransactions()
      this.endMethod(_id)
    }
    get futuresStrategy(): FuturesStrategyEnum | undefined {
      return this.futures
        ? this.isLong
          ? FuturesStrategyEnum.long
          : FuturesStrategyEnum.short
        : undefined
    }

    @IdMute(mutexConcurrently, () => 'createTransaction')
    @IdMute(mutex, (o: Order) => `${o.botId}transaction`)
    private async createTransaction(
      o: Order,
      minigrid: FullMinigrid,
    ): Promise<null | {
      profitBase: number
      profitQuote: number
      profitUsdt: number
      profitPureBase: number
      profitPureQuote: number
      pureFeeBase: number
      pureFeeQuote: number
    }> {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('create transaction'))
        return null
      }
      if (!this.data) {
        return null
      }
      const _id = this.startMethod('createTransaction')
      const pair = minigrid.schema.symbol.symbol
      const ed = await this.getExchangeInfo(pair)
      const fee = await this.getUserFee(pair)
      if (!ed || !fee) {
        this.endMethod(_id)
        return null
      }
      const read = await this.transactionsDb.countData({
        index: o.clientOrderId,
      })
      if (read.status === StatusEnum.ok && read.data.result) {
        this.handleDebug(
          `Transaction already exists with executor ${o.clientOrderId}`,
        )
        this.endMethod(_id)
        return null
      }
      if (minigrid.initialGrids.length === 0) {
        this.handleErrors(
          `Minigrids initial grids not set`,
          'create transaction',
          '',
          false,
          false,
          false,
        )
        this.endMethod(_id)
        return null
      }
      const prices = minigrid.initialGrids.map((ig) => ig.price)
      prices[prices.length - 1].buy = this.math.round(
        minigrid.schema.settings.topPrice,
        ed.priceAssetPrecision,
      )
      const { dealId } = minigrid.schema
      const deal = this.getDeal(dealId)
      const settings = await this.getAggregatedSettings(deal?.deal)
      const grids =
        (await this.generateGridsOnPrice(
          {
            pair,
            initialGrids: minigrid.initialGrids,
            lowPrice: minigrid.schema.settings.lowPrice,
            topPrice: minigrid.schema.settings.topPrice,
            levels: minigrid.schema.settings.levels,
            updatedBudget: true,
            _budget: minigrid.schema.settings.budget,
            _lastPrice: minigrid.schema.settings.topPrice * 2,
            _initialPriceStart: minigrid.schema.initialPrice,
            _side: OrderSideEnum.buy,
            all: true,
            profitCurrency: settings.futures
              ? 'quote'
              : (settings.profitCurrency ?? 'quote'),
            orderFixedIn: settings.futures
              ? settings.coinm
                ? ('quote' as const)
                : ('base' as const)
              : settings.profitCurrency === 'quote'
                ? ('base' as const)
                : ('quote' as const),
            noslice: true,
          },
          !this.isLong,
          this.data?.settings.newBalance,
          this.feeOrder,
          deal?.deal.tags?.includes('newSell'),
        )) ?? []
      const _profitBase = await this.profitBase(deal?.deal)
      const qty = parseFloat(o.origQty)
      const price = parseFloat(o.price)
      let comBase = o.side === OrderSideEnum.buy ? qty * fee.maker : 0
      let comQuote = o.side === OrderSideEnum.sell ? qty * price * fee.maker : 0
      let profitQuote = 0
      let matchedPrice = 0
      let matchQty = 0
      let profitBase = 0
      let pureBase = 0
      let pureQuote = 0
      const pureFeeBase = comBase
      const pureFeeQuote = comQuote
      let matchedId = ''
      let profitUsdt = 0
      let amountBaseBuy = o.side === 'SELL' ? 0 : parseFloat(o.origQty)
      let amountQuoteBuy =
        o.side === 'SELL' ? 0 : parseFloat(o.origQty) * parseFloat(o.price)
      let amountBaseSell = o.side === 'BUY' ? 0 : parseFloat(o.origQty)
      let amountQuoteSell =
        o.side === 'BUY' ? 0 : parseFloat(o.origQty) * parseFloat(o.price)
      const usedSet = this.usedOrderId.get(o.dealId ?? '') ?? new Set()
      if (!this.futures) {
        if (o.side === OrderSideEnum.sell && _profitBase) {
          comBase = comQuote / price
        }
        if (o.side === OrderSideEnum.buy && !_profitBase) {
          comQuote = comBase * price
        }
        let index = prices.findIndex(
          (p) => (o.side === OrderSideEnum.sell ? p.sell : p.buy) === price,
        )
        if (index === -1) {
          index = prices.findIndex(
            (p) => (o.side === OrderSideEnum.sell ? p.buy : p.sell) === price,
          )
        }
        const filledOrders = this.getOrdersByStatusAndDealId({
          status: 'FILLED',
          dealId: o.dealId,
        }).filter(
          (or) =>
            or.typeOrder === TypeOrderEnum.dealGrid &&
            or.minigridId === o.minigridId &&
            !usedSet.has(or.clientOrderId),
        )

        const match = filledOrders.find(
          (g) =>
            parseFloat(g.price) ===
              (o.side === OrderSideEnum.sell
                ? prices[index - 1]?.buy || 0
                : prices[index + 1]?.sell || 0) &&
            g.side !== o.side &&
            g.updateTime < o.updateTime,
        )
        const { realInitialPrice, initialPrice } = minigrid.schema
        const needMatch = this.isLong
          ? o.side === OrderSideEnum.buy ||
            (initialPrice &&
              o.side === OrderSideEnum.sell &&
              +o.price <= initialPrice)
          : o.side === OrderSideEnum.sell ||
            (initialPrice &&
              o.side === OrderSideEnum.buy &&
              +o.price >= initialPrice)
        if (!needMatch && !match) {
          matchedId = 'initial price'
          matchQty = _profitBase
            ? (+o.price * +o.executedQty) / (realInitialPrice ?? +o.price)
            : +o.executedQty
          matchedPrice = realInitialPrice ?? +o.price
          usedSet.add(o.clientOrderId)
        } else if (match) {
          matchedId = match.clientOrderId
          matchQty = parseFloat(match.origQty)
          matchedPrice = parseFloat(match.price)
          usedSet.add(o.clientOrderId)
          usedSet.add(match.clientOrderId)
        }
        if (matchedPrice !== 0) {
          const pnlBase =
            o.side === OrderSideEnum.sell ? matchQty - qty : qty - matchQty
          const pnlQuote =
            o.side === OrderSideEnum.sell
              ? qty * price - matchQty * matchedPrice
              : matchQty * matchedPrice - qty * price
          pureBase = pnlBase
          pureQuote = pnlQuote
          profitBase +=
            pnlBase +
            pnlQuote / (o.side === OrderSideEnum.buy ? price : matchedPrice)
          profitQuote +=
            pnlQuote +
            pnlBase * (o.side === OrderSideEnum.buy ? price : matchedPrice)
          if (o.side === 'BUY') {
            amountBaseSell = matchQty
            amountQuoteSell = matchQty * matchedPrice
          }
          if (o.side === 'SELL') {
            amountBaseBuy = matchQty
            amountQuoteBuy = matchQty * matchedPrice
          }
        }
      } else {
        if (!_profitBase && !this.futures) {
          if (o.side === OrderSideEnum.buy) {
            comQuote = comBase * price
          }
          if (o.side === OrderSideEnum.sell) {
            let index = prices.findIndex((p) => p.sell === price)
            if (index === -1) {
              index = prices.findIndex((p) => p.buy === price)
            }
            const buyMatch = (grids ?? []).find(
              (g) =>
                index !== -1 &&
                g.price === prices[index - 1].buy &&
                g.side === OrderSideEnum.buy,
            )
            if (buyMatch) {
              profitBase = buyMatch.qty - qty
              profitQuote =
                qty * price - buyMatch.qty * buyMatch.price + profitBase * price
              matchedPrice = buyMatch.price
              amountBaseBuy = buyMatch.qty
              amountQuoteBuy = buyMatch.qty * buyMatch.price
            }
          }
          usedSet.add(o.clientOrderId)
        }
        if (_profitBase || this.futures) {
          if (o.side === OrderSideEnum.sell) {
            comBase = comQuote / parseFloat(o.price)
          }
          if (!usedSet.has(o.clientOrderId)) {
            if (this.futuresStrategy !== FuturesStrategyEnum.neutral) {
              const withMatch =
                (this.futuresStrategy === FuturesStrategyEnum.long &&
                  o.side === OrderSideEnum.sell) ||
                (this.futuresStrategy === FuturesStrategyEnum.short &&
                  o.side === OrderSideEnum.buy)
              usedSet.add(o.clientOrderId)
              if (withMatch) {
                matchedId = 'position price'
                matchQty = _profitBase
                  ? (price * qty) / (minigrid.schema.avgPrice || price)
                  : qty
                matchedPrice = minigrid.schema.avgPrice || price
                const pnlBase =
                  o.side === OrderSideEnum.sell
                    ? matchQty - qty
                    : qty - matchQty
                const pnlQuote =
                  o.side === OrderSideEnum.sell
                    ? qty * price - matchQty * matchedPrice
                    : matchQty * matchedPrice - qty * price
                pureBase = pnlBase
                pureQuote = pnlQuote
                profitBase +=
                  pnlBase +
                  pnlQuote /
                    (o.side === OrderSideEnum.buy ? price : matchedPrice)
                profitQuote +=
                  pnlQuote +
                  pnlBase *
                    (o.side === OrderSideEnum.buy ? price : matchedPrice)
                if (o.side === 'BUY') {
                  amountBaseSell = matchQty
                  amountQuoteSell = matchQty * matchedPrice
                }
                if (o.side === 'SELL') {
                  amountBaseBuy = matchQty
                  amountQuoteBuy = matchQty * matchedPrice
                }
              }
            } else {
              let index = prices.findIndex(
                (p) =>
                  (o.side === OrderSideEnum.sell ? p.sell : p.buy) === price,
              )
              if (index === -1) {
                index = prices.findIndex(
                  (p) =>
                    (o.side === OrderSideEnum.sell ? p.buy : p.sell) === price,
                )
              }
              const filledOrders = this.getOrdersByStatusAndDealId({
                status: 'FILLED',
                dealId: o.dealId,
              }).filter(
                (or) =>
                  or.minigridId === o.minigridId &&
                  !usedSet.has(or.clientOrderId),
              )
              const match = filledOrders.find(
                (g) =>
                  parseFloat(g.price) ===
                    (o.side === OrderSideEnum.sell
                      ? prices[index - 1]?.buy || 0
                      : prices[index + 1]?.sell || 0) &&
                  g.side !== o.side &&
                  g.updateTime < o.updateTime,
              )
              if (match) {
                matchedId = match.clientOrderId
                matchQty = parseFloat(match.origQty)
                matchedPrice = parseFloat(match.price)
                usedSet.add(matchedId)
                usedSet.add(o.clientOrderId)
                const pnlBase =
                  o.side === OrderSideEnum.sell
                    ? matchQty - qty
                    : qty - matchQty
                const pnlQuote =
                  o.side === OrderSideEnum.sell
                    ? qty * price - matchQty * matchedPrice
                    : matchQty * matchedPrice - qty * price
                pureBase = pnlBase
                pureQuote = pnlQuote
                profitBase +=
                  pnlBase +
                  pnlQuote /
                    (o.side === OrderSideEnum.buy ? price : matchedPrice)
                profitQuote +=
                  pnlQuote +
                  pnlBase *
                    (o.side === OrderSideEnum.buy ? price : matchedPrice)
                if (o.side === 'BUY') {
                  amountBaseSell = matchQty
                  amountQuoteSell = matchQty * matchedPrice
                }
                if (o.side === 'SELL') {
                  amountBaseBuy = matchQty
                  amountQuoteBuy = matchQty * matchedPrice
                }
              }
            }
          }
        }
      }
      this.usedOrderId.set(o.dealId ?? '', usedSet)
      this.updateUsedOrderId()
      const totalQuote =
        profitQuote - (comQuote === 0 ? comBase * price : comQuote)
      const usdRate = await this.getUsdRate(pair)
      profitUsdt = totalQuote * usdRate
      const updateTime = o.updateTime || o.transactTime || 0
      const transaction: Omit<ClearComboTransactionSchema, '_id'> = {
        updateTime,
        side: o.side,
        amountBaseBuy,
        amountQuoteBuy,
        amountBaseSell,
        amountQuoteSell,
        priceSell:
          o.side === OrderSideEnum.sell ? parseFloat(o.price) : matchedPrice,
        priceBuy:
          o.side === OrderSideEnum.buy ? parseFloat(o.price) : matchedPrice,
        idBuy: o.side === OrderSideEnum.buy ? o.clientOrderId : matchedId,
        idSell: o.side === OrderSideEnum.sell ? o.clientOrderId : matchedId,
        feeBase: comBase,
        feeQuote: comQuote,
        profitBase,
        profitQuote,
        botId: this.botId,
        userId: this.userId,
        symbol: pair,
        baseAsset: ed.baseAsset.name,
        quoteAsset: ed.quoteAsset.name,
        profitUsdt,
        profitCurrency: this.futures
          ? this.coinm
            ? ed.baseAsset.name
            : ed.quoteAsset.name
          : _profitBase
            ? ed.baseAsset.name
            : ed.quoteAsset.name,
        paperContext: this.data.paperContext,
        index: o.clientOrderId,
        dealId: o.dealId,
        minigridId: o.minigridId,
        amountFreeBaseBuy: 0,
        amountFreeBaseSell: 0,
        amountFreeQuoteBuy: 0,
        amountFreeQuoteSell: 0,
        freeProfitUsd: 0,
        pureBase,
        pureFeeBase,
        pureFeeQuote,
        pureQuote,
      }
      const res = await this.transactionsDb.createData(transaction)
      if (res.status === StatusEnum.notok) {
        this.handleErrors(
          res.reason,
          'createTransaction()',
          'Save transaction to DB',
          false,
          false,
          false,
        )
      }
      if (res.status === StatusEnum.ok) {
        this.handleDebug(
          `Transaction saved - ${`${res.data._id}`}, executor - ${
            o.clientOrderId
          }`,
        )
        this.endMethod(_id)
        return {
          profitBase: profitBase - (comBase === 0 ? comQuote / price : comBase),
          profitQuote:
            profitQuote - (comQuote === 0 ? comBase * price : comQuote),
          profitUsdt,
          profitPureBase: pureBase - pureFeeBase,
          profitPureQuote: pureQuote - pureFeeQuote,
          pureFeeBase,
          pureFeeQuote,
        }
      }
      this.endMethod(_id)
      return null
    }
    private calculateMinigridBalances(grids: Grid[]) {
      const buys = grids.filter((g) => g.side === OrderSideEnum.buy)
      const sells = grids.filter((g) => g.side === OrderSideEnum.sell)
      const base = sells.reduce((acc, s) => acc + s.qty, 0)
      const quote = buys.reduce((acc, s) => acc + s.qty * s.price, 0)
      return { base, quote }
    }
    private async calculateDealBalances(dealId?: string) {
      if (this.data) {
        const updateOpenDeals = dealId
          ? this.getDeal(dealId)
          : this.getOpenDeals()
        if (updateOpenDeals) {
          for (const d of [updateOpenDeals].flat()) {
            await this.updateDealBalances(d)
          }
        }
      }
    }
    private async getDealLowestlevel(dealId: string) {
      let lowestLevel = 0
      const allOpenMinigrids = this.getMinigridByDealId({ dealId }).filter(
        (m) => m.schema.status !== ComboMinigridStatusEnum.closed,
      )
      for (const m of allOpenMinigrids) {
        const order =
          this.getOrderFromMap(m.schema.dcaOrderId) ||
          (
            await this.ordersDb.readData<{ dcaLevel?: number }>(
              {
                clientOrderId: m.schema.dcaOrderId,
              },
              { dcaLevel: 1 },
            )
          ).data?.result
        if (order && order.dcaLevel && order.dcaLevel > lowestLevel) {
          lowestLevel = order.dcaLevel
        }
      }
      return lowestLevel
    }
    private async closeMinigrid(dealId: string, minigrid: FullMinigrid) {
      this.handleLog(`Change dca level for ${dealId}`)
      const get = this.getDeal(dealId)
      const deal =
        get && get.deal.status !== DCADealStatusEnum.closed ? get : undefined
      const order =
        this.getOrderFromMap(minigrid.schema.dcaOrderId) ||
        (
          await this.ordersDb.readData(
            {
              clientOrderId: minigrid.schema.dcaOrderId,
            },
            { dcaLevel: 1 },
          )
        ).data?.result
      if (deal && deal.deal.lastFilledLevel) {
        const lowestLevel = await this.getDealLowestlevel(deal.deal._id)
        if (lowestLevel && !isNaN(lowestLevel)) {
          deal.deal.lastFilledLevel = lowestLevel
        } else {
          deal.deal.lastFilledLevel = Math.max(
            order?.dcaLevel
              ? order.dcaLevel - 1
              : deal.deal.lastFilledLevel - 1,
            0,
          )
        }
        deal.deal.allowBaseProcess = true
        deal.deal.levels.complete = Math.max(
          Math.max(deal.deal.lastFilledLevel, 0),
          0,
        )

        this.saveDeal(deal, {
          lastFilledLevel: deal.deal.lastFilledLevel,
          allowBaseProcess: deal.deal.allowBaseProcess,
          levels: deal.deal.levels,
        })
      }
      this.deleteMinigrid(minigrid.schema._id)
    }
    private async processCloseMinigrid(minigridId: string) {
      this.handleLog(`Close minigrid ${minigridId}`)
      const minigrid = this.getMinigrid(minigridId)
      if (minigrid) {
        minigrid.schema.status = ComboMinigridStatusEnum.closed
        this.saveMinigrid(minigrid, { status: minigrid.schema.status })
      }
    }
    private updateBotDealStats(dealId: string) {
      const deal = this.getDeal(dealId)
      if (this.data) {
        this.data.dealsStatsForBot = [
          ...this.data.dealsStatsForBot.filter((d) => d.dealId !== dealId),
        ]
        if (
          deal &&
          [
            DCADealStatusEnum.error,
            DCADealStatusEnum.start,
            DCADealStatusEnum.open,
          ].includes(deal.deal.status)
        ) {
          this.data.dealsStatsForBot.push({
            avgPrice: deal.deal.avgPrice,
            usage: deal.deal.usage,
            profit: deal.deal.profit,
            feePaid: deal.deal.feePaid,
            dealId,
            symbol: deal.deal.symbol.symbol,
            currentBalances: deal.deal.currentBalances,
            initialBalances: deal.deal.initialBalances,
            comboTpBase: deal.deal.settings.comboTpBase,
          })
        }
        const data = { dealsStatsForBot: this.data.dealsStatsForBot }
        this.updateData(data)
        this.emit('bot settings update', data)
      }
    }
    private async avgPrice(
      dealToSearch: string,
      dealId?: string,
      minigridId?: string,
    ): Promise<{ real: number; display: number }> {
      if (this.futures) {
        let filledDealOrder = this.getOrdersByStatusAndDealId({
          status: 'FILLED',
          dealId: dealToSearch,
        }).filter(
          (o) =>
            (dealId ? true : o.minigridId === minigridId) &&
            (o.typeOrder === TypeOrderEnum.dealRegular ||
              o.typeOrder === TypeOrderEnum.dealStart ||
              o.typeOrder === TypeOrderEnum.dealGrid),
        )
        if (minigridId) {
          const minigrid = this.getMinigrid(minigridId)
          const minigridOrder = this.getOrderFromMap(
            minigrid?.schema?.dcaOrderId,
          )
          if (minigridOrder) {
            filledDealOrder.push(minigridOrder)
          }
        }
        filledDealOrder = [...filledDealOrder].sort(
          (a, b) => a.updateTime - b.updateTime,
        )
        let pos: PositionInBot = {
          price: 0,
          side: PositionSide.LONG,
          qty: 0,
        }
        for (const o of filledDealOrder) {
          pos = await this.calculateAbstractPosition(
            {
              qty: +(o.executedQty ?? '0') || +o.origQty,
              price: +o.price,
              side: o.side,
              symbol: o.symbol,
            },
            pos,
          )
        }
        return {
          real: pos.price,
          display: pos.price,
        }
      }
      const filledDealOrder = this.getOrdersByStatusAndDealId({
        status: 'FILLED',
        dealId: dealToSearch,
      }).filter(
        (o) =>
          (dealId ? true : o.minigridId === minigridId) &&
          (o.typeOrder === TypeOrderEnum.dealRegular ||
            o.typeOrder === TypeOrderEnum.dealStart ||
            o.typeOrder === TypeOrderEnum.dealGrid ||
            o.typeOrder === TypeOrderEnum.fee ||
            o.typeOrder === TypeOrderEnum.rebalance) &&
          o.side === (this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell),
      )
      let base = filledDealOrder.reduce(
        (acc, v) => acc + parseFloat(v.executedQty),
        0,
      )
      let quote = filledDealOrder.reduce(
        (acc, v) => acc + parseFloat(v.executedQty) * parseFloat(v.price),
        0,
      )
      let d: FullDeal<ExcludeDoc<ComboDealsSchema>> | undefined
      if (dealId) {
        d = this.getDeal(dealId)
      }
      if (minigridId) {
        const minigrid = this.getMinigrid(minigridId)
        if (minigrid) {
          d = this.getDeal(minigrid.schema.dealId)
          base += this.isLong
            ? minigrid.schema.initialBalances.base
            : minigrid.schema.initialBalances.quote /
              minigrid.schema.initialPrice
          quote += this.isLong
            ? minigrid.schema.initialPrice *
              minigrid.schema.initialBalances.base
            : minigrid.schema.initialBalances.quote
        }
      }
      const real = quote / base
      let display = real
      if (dealId) {
        if (!isNaN(real)) {
          if (d) {
            /* const qty = this.isLong
              ? d.deal.currentBalances.base
              : d.deal.initialBalances.base - d.deal.currentBalances.base
            const quote = this.isLong
              ? d.deal.initialBalances.quote - d.deal.currentBalances.quote
              : d.deal.currentBalances.quote
            display = +quote / qty */
            const profitBase = await this.profitBase(d.deal)
            const longMult = this.isLong ? 1 : -1
            const qty = this.isLong
              ? d.deal.currentBalances.base
              : d.deal.initialBalances.base - d.deal.currentBalances.base
            const quote =
              (this.isLong
                ? d.deal.initialBalances.quote - d.deal.currentBalances.quote
                : d.deal.currentBalances.quote) +
              (profitBase ? 0 : d.deal.profit.total * longMult)
            const fee =
              (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0
            display = profitBase
              ? quote /
                (qty -
                  d.deal.profit.total * longMult -
                  (-d.deal.profit.total + (d.deal.fullFee ?? 0) + qty * fee) /
                    longMult)
              : (+(d.deal.fullFee ?? 0) -
                  d.deal.profit.total +
                  quote * longMult) /
                (qty * (longMult - fee))
          }
        }
      }
      display = Math.max(0, display)
      return { real, display }
    }
    @RunWithDelay(
      (botId: string, dealId: string) => `${dealId}@${botId}autoRebalancing`,
      10 * 1000,
    )
    public async autoRebalancing(_botId: string, dealId: string) {
      if (!this.data?.settings.autoRebalancing || this.futures) {
        return
      }
      this.handleDebug(
        `Auto Rebalancing | Start auto rebalancing for ${dealId}`,
      )
      const compareBalances = await this.compareBalances(dealId)
      const rawResponse = `raw - ${compareBalances.diffBase} diffBase, ${compareBalances.diffQuote} diffQuote, ${compareBalances.suggestedAction} suggestedAction`
      if (
        (this.isLong &&
          compareBalances.suggestedAction === BalancesAction.add) ||
        (!this.isLong &&
          compareBalances.suggestedAction === BalancesAction.reduce)
      ) {
        const diff = this.isLong
          ? compareBalances.diffBase
          : compareBalances.diffQuote
        const side =
          compareBalances.suggestedAction === BalancesAction.add
            ? OrderSideEnum.buy
            : OrderSideEnum.sell
        this.handleDebug(
          `Auto Rebalancing | Found balances diff for ${dealId}. Diff - ${diff}, side - ${side}, ${rawResponse}`,
        )
        this.manageBalanceDiff(dealId, Math.abs(diff), side)
      } else {
        this.handleDebug(
          `Auto Rebalancing | No diff for ${dealId}. ${rawResponse}`,
        )
      }
    }

    @IdMute(mutex, (dealId: string) => `${dealId}compareBalances`)
    public async compareBalances(dealId: string) {
      this.handleDebug(`Compare balances for ${dealId}`)
      const response: CompareBalancesResponse = {
        currentBase: 0,
        currentQuote: 0,
        realBase: 0,
        realQuote: 0,
        filledBase: 0,
        filledQuote: 0,
        feeBase: 0,
        feeQuote: 0,
        suggestedAction: BalancesAction.none,
        diffBase: 0,
        diffQuote: 0,
      }
      try {
        if (this.futures) {
          this.handleDebug(`Futures bot. Skip compare balances`)
          return response
        }
        const deal = this.getDeal(dealId)
        if (!deal) {
          this.handleDebug(`Deal ${dealId} not found in compareBalances`)
          return response
        }
        response.currentBase = deal.deal.currentBalances.base
        response.currentQuote = deal.deal.currentBalances.quote
        const fee = await this.getUserFee(deal.deal.symbol.symbol)
        this.handleDebug(`Start getting orders for ${dealId}`)
        const orders = await this.ordersDb.aggregate<{
          side: OrderSideEnum
          qty: number
          value: number
          feeBase: number
          feeQuote: number
        }>([
          {
            $match: {
              botId: this.botId,
              dealId,
              //@ts-ignore
              status: { $in: ['FILLED', 'PARTIALLY_FILLED'] },
              typeOrder: {
                //@ts-ignore
                $nin: [TypeOrderEnum.br, TypeOrderEnum.rebalance],
              },
            },
          },
          {
            $project: {
              qty: { $toDouble: '$executedQty' },
              value: {
                $multiply: [
                  { $toDouble: '$executedQty' },
                  { $toDouble: '$price' },
                ],
              },
              side: 1,
              type: 1,
              _id: 0,
            },
          },
          {
            $group: {
              _id: '$side',
              side: { $first: '$side' },
              qty: { $sum: '$qty' },
              value: { $sum: '$value' },
              feeBase: {
                $sum: {
                  $cond: {
                    if: {
                      $and: [
                        { $eq: ['$side', 'BUY'] },
                        { $ne: ['$exchange', ExchangeEnum.kucoin] },
                      ],
                    },
                    then: {
                      $multiply: [
                        { $toDouble: '$qty' },
                        {
                          //@ts-ignore
                          $cond: {
                            if: { $eq: ['$type', 'MARKET'] },
                            then: fee?.taker ?? 0,
                            else: fee?.maker,
                          },
                        },
                      ],
                    },
                    else: 0,
                  },
                },
              },
              feeQuote: {
                $sum: {
                  $cond: {
                    if: {
                      $or: [
                        { $eq: ['$side', 'SELL'] },
                        { $eq: ['$exchange', ExchangeEnum.kucoin] },
                      ],
                    },
                    then: {
                      $multiply: [
                        { $toDouble: '$value' },
                        {
                          //@ts-ignore
                          $cond: {
                            if: { $eq: ['$type', 'MARKET'] },
                            then: fee?.taker ?? 0,
                            else: fee?.maker,
                          },
                        },
                      ],
                    },
                    else: 0,
                  },
                },
              },
            },
          },
        ])
        this.handleDebug(`Stop getting orders for ${dealId}`)
        if (orders.status === StatusEnum.notok) {
          this.handleErrors(
            `Error getting orders: ${orders.reason}`,
            'compareBalances()',
            'reading orders',
            false,
            false,
            false,
          )
          return response
        }
        const buy = orders.data.result.find((o) => o.side === OrderSideEnum.buy)
        const sell = orders.data.result.find(
          (o) => o.side === OrderSideEnum.sell,
        )
        response.filledBase = deal.deal.initialBalances.base
        response.filledQuote = deal.deal.initialBalances.quote
        if (buy) {
          response.feeBase += buy.feeBase
          response.feeQuote += buy.feeQuote
          response.filledBase += buy.qty
          response.filledQuote -= buy.value
        }
        if (sell) {
          response.feeBase += sell.feeBase
          response.feeQuote += sell.feeQuote
          response.filledBase -= sell.qty
          response.filledQuote += sell.value
        }
        const balances = await this.getBalancesFromExchange()
        if (!balances || balances.status === StatusEnum.notok) {
          this.handleErrors(
            `Error getting balances from exchange: ${balances?.reason}`,
            'compareBalances()',
            'reading balances',
            false,
            false,
            false,
          )
          return response
        }
        const findBase = balances.data.find(
          (b) => b.asset === deal.deal.symbol.baseAsset,
        )
        const findQuote = balances.data.find(
          (b) => b.asset === deal.deal.symbol.quoteAsset,
        )
        response.realBase = (findBase?.free ?? 0) + (findBase?.locked ?? 0)
        response.realQuote = (findQuote?.free ?? 0) + (findQuote?.locked ?? 0)
        const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
        const lastPrice = await this.getLatestPrice(deal.deal.symbol.symbol)
        if (this.isLong) {
          const diff =
            response.filledBase - response.feeBase - response.realBase
          response.diffBase = diff
          if (
            Math.abs(diff) > (ed?.baseAsset.minAmount ?? 0) &&
            Math.abs(diff) * lastPrice > (ed?.quoteAsset.minAmount ?? 0)
          ) {
            response.suggestedAction =
              diff > 0 ? BalancesAction.add : BalancesAction.reduce
          }
        }
        if (!this.isLong) {
          const diff =
            response.filledQuote - response.feeQuote - response.realQuote
          response.diffQuote = diff
          if (
            Math.abs(diff) > (ed?.quoteAsset.minAmount ?? 0) &&
            Math.abs(diff) / lastPrice > (ed?.baseAsset.minAmount ?? 0)
          ) {
            response.suggestedAction =
              diff > 0 ? BalancesAction.reduce : BalancesAction.add
          }
        }
        return response
      } catch (e) {
        this.handleErrors(
          `Catch in compareBalances: ${e}`,
          'compareBalances()',
          '',
          false,
          false,
          false,
        )
        return response
      }
    }

    @IdMute(
      mutex,
      (order: Order) =>
        `processRebalanceOrder${order.dealId}-${order.clientOrderId}`,
    )
    private async processRebalanceOrder(order: Order) {
      this.handleDebug(`Process rebalance order ${order.clientOrderId}`)
      const { dealId } = order
      if (!dealId) {
        this.handleWarn('DealId not found in processRebalanceOrder')
        return
      }
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.handleWarn(`Deal ${dealId} not found in processRebalanceOrder`)
        return
      }
      const avgs = await this.avgPrice(dealId, dealId)
      let avgPrice = avgs.real
      avgPrice = isNaN(avgPrice) ? deal.deal.avgPrice : avgPrice
      deal.deal.avgPrice = avgPrice
      deal.deal.displayAvg = isNaN(avgs.display)
        ? deal.deal.displayAvg || deal.deal.avgPrice
        : avgs.display
      deal.deal.settings.avgPrice = deal.deal.avgPrice
      this.saveDeal(deal, {
        avgPrice: deal.deal.avgPrice,
        displayAvg: deal.deal.displayAvg,
        'settings.avgPrice': deal.deal.settings.avgPrice,
      })
    }

    @IdMute(mutex, (dealId: string) => `processRebalanceDeal${dealId}`)
    public async manageBalanceDiff(
      dealId: string,
      qty: number,
      side: OrderSideEnum,
    ) {
      this.handleDebug(`Manage balance diff for ${dealId}, ${qty}, ${side}`)
      if (this.futures) {
        this.handleDebug(`Futures bot. Skip manage balance diff`)
        return
      }
      try {
        const deal = this.getDeal(dealId)
        if (!deal) {
          this.handleWarn(`Deal ${dealId} not found in manageBalanceDiff`)
          return
        }
        const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
        if (!ed) {
          this.handleErrors(
            `Error getting exchange info for ${deal.deal.symbol.symbol}`,
            'manageBalanceDiff()',
            'reading exchange info',
            false,
            false,
            false,
          )
          return
        }
        const lastPrice = await this.getLatestPrice(deal.deal.symbol.symbol)
        if (!this.isLong) {
          qty = qty / lastPrice
        }
        qty = this.math.round(
          qty,
          await this.baseAssetPrecision(deal.deal.symbol.symbol),
        )
        const price = this.math.round(lastPrice, ed.priceAssetPrecision)
        const result = await this.sendGridToExchange(
          {
            number: 0,
            price,
            side,
            newClientOrderId: this.getOrderId(`GA-BAL`),
            qty,
            type: TypeOrderEnum.rebalance,
            dealId,
          },
          {
            dealId,
            type: 'MARKET',
          },
          ed,
        )
        if (result && result.status === 'FILLED') {
          this.processRebalanceOrder(result)
        }
      } catch (e) {
        this.handleErrors(
          `Catch in manageBalanceDiff: ${e}`,
          'manageBalanceDiff()',
          '',
          false,
          false,
          false,
        )
      }
    }
    override async afterDealUpdate(dealId: string) {
      this.updateBotDealStats(dealId)
    }
    private async findDiffCombo(
      newGrids: Grid[] | null,
      oldGrids: Grid[] | null,
      latestPrice: number,
      order?: Order,
      deal?: FullDeal<ExcludeDoc<ComboDealsSchema>>,
      ignoreQty = false,
    ) {
      const settings = await this.getAggregatedSettings(deal?.deal)
      if (settings.comboUseSmartGrids && latestPrice && !isNaN(latestPrice)) {
        const comboSmartGridsCount = parseFloat(
          settings.comboSmartGridsCount || '0',
        )
        if (comboSmartGridsCount && !isNaN(comboSmartGridsCount)) {
          const allMinigrids = this.getMinigridByDealId({
            dealId: deal?.deal._id,
          }).filter((m) => m.schema.status !== ComboMinigridStatusEnum.closed)
          const gridOrders = allMinigrids
            .map((m) => m.currentOrders)
            .flat()
            .map((g) => ({
              ...g,
              newClientOrderId: this.getOrderId(`CMB-GR`),
            }))
          const orders = [...gridOrders].sort(
            (a, b) =>
              Math.abs(latestPrice - a.price) - Math.abs(latestPrice - b.price),
          )
          let updatedGrids = orders.slice(0, comboSmartGridsCount)
          const sells = updatedGrids.filter(
            (g) => g.side === OrderSideEnum.sell,
          )
          const buys = updatedGrids.filter((g) => g.side === OrderSideEnum.buy)
          if (
            ((!sells.length && buys.length > 1) ||
              (!buys.length && sells.length > 1)) &&
            updatedGrids.length > 1
          ) {
            this.handleDebug(
              `Diff in combo orders | Sells ${sells.length}, buys ${buys.length}`,
            )
            const closest = !sells.length
              ? orders.find((o) => o.side === OrderSideEnum.sell)
              : orders.find((o) => o.side === OrderSideEnum.buy)
            if (closest) {
              this.handleDebug(
                `Diff in combo orders | Replace with closest ${closest.newClientOrderId} ${closest.price} ${closest.qty} ${closest.side}`,
              )
              updatedGrids = updatedGrids.slice(0, updatedGrids.length - 1)
              updatedGrids.push(closest)
            }
          }
          const prev = (oldGrids ?? []).filter(
            (g) => g.type === TypeOrderEnum.dealGrid,
          )
          return this.findDiff(
            [
              ...updatedGrids,
              ...(newGrids ?? []).filter(
                (g) => g.type !== TypeOrderEnum.dealGrid,
              ),
            ],
            [
              ...prev,
              ...this.getOrdersByStatusAndDealId({
                status: ['NEW', 'PARTIALLY_FILLED', 'FILLED'],
                dealId: deal?.deal._id,
              })
                .filter(
                  (o) =>
                    (o.status === 'NEW' ||
                      o.status === 'PARTIALLY_FILLED' ||
                      (order?.typeOrder === TypeOrderEnum.dealGrid &&
                        order &&
                        o.status === 'FILLED' &&
                        o.updateTime > order.updateTime &&
                        o.clientOrderId !== order.clientOrderId)) &&
                    o.typeOrder !== TypeOrderEnum.br,
                )
                .map((o) => this.mapOrderToGrid(o)),
            ],
            ignoreQty,
          )
        }
      }
      return this.findDiff(newGrids, oldGrids, ignoreQty)
    }

    @IdMute(
      mutex,
      (botId: string, order: Order) => `${botId}update${order.dealId}`,
    )
    override async updateDeal(_botId: string, order: Order) {
      const _id = this.startMethod('updateDeal')
      this.ordersInBetweenUpdates.delete(order.clientOrderId)
      const price = parseFloat(order.price)
      const qty = parseFloat(order.executedQty)
      const { dealId } = order
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        dealId &&
        this.orders &&
        findDeal.deal.status === DCADealStatusEnum.open
      ) {
        findDeal.deal.lastPrice = parseFloat(order.price)
        this.handleDebug(
          `Deal ${dealId} balances before ${findDeal.deal.currentBalances.base} base, ${findDeal.deal.currentBalances.quote} quote`,
        )
        findDeal.deal.currentBalances = {
          base:
            findDeal.deal.currentBalances.base +
            qty * (order.side === OrderSideEnum.buy ? 1 : -1),
          quote:
            findDeal.deal.currentBalances.quote +
            qty * price * (order.side === OrderSideEnum.sell ? 1 : -1),
        }
        this.handleDebug(
          `Deal ${dealId} balances after ${findDeal.deal.currentBalances.base} base, ${findDeal.deal.currentBalances.quote} quote`,
        )
        findDeal.deal.updateTime = order.updateTime

        this.handleLog(`Regular order FILLED ${order.clientOrderId}`)
        const avgs = await this.avgPrice(dealId, dealId)
        let avgPrice = avgs.real
        avgPrice = isNaN(avgPrice) ? findDeal.deal.avgPrice : avgPrice
        findDeal.deal.avgPrice = avgPrice
        findDeal.deal.displayAvg = isNaN(avgs.display)
          ? findDeal.deal.displayAvg || findDeal.deal.avgPrice
          : avgs.display
        findDeal.deal.settings.avgPrice = findDeal.deal.avgPrice
        findDeal.deal.levels.complete = Math.max(
          findDeal.deal.levels.complete,
          order.dcaLevel ? order.dcaLevel : findDeal.deal.levels.complete + 1,
        )
        if (findDeal.deal.levels.complete > findDeal.deal.levels.all) {
          findDeal.deal.levels.all = findDeal.deal.levels.complete
        }
        findDeal.previousOrders = findDeal.currentOrders
        const lowestLevel = await this.getDealLowestlevel(dealId)
        if (lowestLevel && !isNaN(lowestLevel)) {
          findDeal.deal.lastFilledLevel = Math.max(
            lowestLevel,
            order.dcaLevel ?? findDeal.deal.levels.complete,
          )
          findDeal.deal.levels.complete = Math.max(
            findDeal.deal.levels.complete,
            findDeal.deal.lastFilledLevel ?? findDeal.deal.levels.complete,
          )
        } else {
          findDeal.deal.lastFilledLevel = order.dcaLevel
            ? order.dcaLevel
            : findDeal.deal.levels.complete
        }
        findDeal.currentOrders = await this.createCurrentDealOrders(
          findDeal.deal.symbol.symbol,
          price,
          findDeal.initialOrders,
          findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
          findDeal.deal.initialPrice,
          findDeal.deal._id,
          false,
          findDeal.deal,
          false,
        )
        findDeal.deal.allowBaseProcess = false
        this.handleDebug(
          `Avg price ${findDeal.deal.avgPrice} @ ${findDeal.deal.symbol.baseAsset} / ${findDeal.deal.symbol.quoteAsset}`,
        )
        findDeal.deal.fullFee = await this.getCommDeal(findDeal.deal)
        this.saveDeal(findDeal, {
          avgPrice: findDeal.deal.avgPrice,
          displayAvg: findDeal.deal.displayAvg,
          'settings.avgPrice': findDeal.deal.settings.avgPrice,
          currentBalances: findDeal.deal.currentBalances,
          updateTime: findDeal.deal.updateTime,
          levels: findDeal.deal.levels,
          lastPrice: findDeal.deal.lastPrice,
          lastFilledLevel: findDeal.deal.lastFilledLevel,
          allowBaseProcess: findDeal.deal.allowBaseProcess,
          fullFee: findDeal.deal.fullFee,
        }).then(() => {
          this.updateUsage(dealId).then(async () => {
            const d = this.getDeal(dealId)
            if (d) {
              await this.checkDealSlMethods(d)
            }
            this.checkDealsPriceExtremum()
          })
          this.updateBotDealStats(dealId)
          this.updateAssets(dealId)
        })

        const gridOrders = await this.createMinigrid(
          findDeal.deal,
          order,
          false,
        )
        if (!gridOrders) {
          this.handleWarn(
            `Grid orders not created ${findDeal.deal._id} ${order.clientOrderId}`,
          )
        }
        const orders = [...findDeal.currentOrders, ...(gridOrders ?? [])]
        await this.placeOrders(
          this.botId,
          order.symbol,
          dealId,
          await this.findDiffCombo(
            orders.filter((o) => !o.hide),
            findDeal.previousOrders.filter((o) => !o.hide),
            +order.price,
            order,
            findDeal,
          ),
        )
        this.updateDealLastPrices(this.botId)
        this.autoRebalancing(this.botId, dealId)
      } else if (
        dealId &&
        order.botId === this.botId &&
        (!findDeal || findDeal.deal.status === DCADealStatusEnum.closed)
      ) {
        await this.sellRemainder(
          dealId,
          +order.origQty,
          +order.price,
          false,
          findDeal,
        )
      }
      this.endMethod(_id)
    }
    private isLastMinigridOrder(
      time: number,
      price: number,
      side: OrderSideEnum,
      minigridId: string,
    ): boolean {
      let lastOrder = this.lastMinigridOrder.get(minigridId) ?? {
        price: 0,
        time: 0,
        side: OrderSideEnum.buy,
      }
      let result = false
      if (lastOrder.price === 0) {
        lastOrder = {
          time,
          price,
          side,
        }
        result = true
      } else {
        if (side === lastOrder.side && side === OrderSideEnum.sell) {
          if (price > lastOrder.price) {
            lastOrder = {
              time,
              price,
              side,
            }
            result = true
          }
        } else if (side === lastOrder.side && side === OrderSideEnum.buy) {
          if (price < lastOrder.price) {
            lastOrder = {
              time,
              price,
              side,
            }
            result = true
          }
        } else if (side !== lastOrder.side) {
          lastOrder = {
            time,
            price,
            side,
          }
          result = true
        }
      }
      this.lastMinigridOrder.set(minigridId, lastOrder)
      return result
    }
    override async processNewOrder(order: Order) {
      const minigrid = this.getMinigrid(order.minigridId)

      if (minigrid?.schema.status === ComboMinigridStatusEnum.closed) {
        this.cancelOrderOnExchange(order)
      }
    }

    @IdMute(mutex, (dealId) => `updateUsage${dealId}`)
    override async updateUsage(
      dealId: string,
      reset = false,
      noBotUsage = false,
      sendAlert = false,
    ) {
      const runBot = () => {
        if (!noBotUsage) {
          this.calculateBotUsage(this.botId)
        }
      }
      const findDeal = this.getDeal(dealId)
      if (this.data && findDeal) {
        const long = this.isLong
        const leverage = await this.getLeverageMultipler(findDeal.deal)
        const bo = this.findBaseOrderByDeal(findDeal.deal._id)
        const regular = findDeal.initialOrders.filter(
          (o) => o.type === TypeOrderEnum.dealRegular,
        )

        const boQty = +(bo?.executedQty ?? '0') || +(bo?.origQty ?? '0') || 0
        const boPrice = +(bo?.price ?? '0') || 0
        const totalBase = regular.reduce((acc, g) => acc + g.qty, 0) + boQty
        const totalQuote =
          regular.reduce((acc, g) => acc + g.qty * g.price, 0) + boQty * boPrice
        const base = (await this.profitBase(findDeal.deal))
          ? findDeal.deal.profit.total
          : 0

        const quote = !(await this.profitBase(findDeal.deal))
          ? findDeal.deal.profit.total
          : 0

        const hiddenDCA = findDeal.initialOrders.filter(
          (o) => o.type === TypeOrderEnum.dealRegular && o.hide,
        )
        const hiddenBase = hiddenDCA.reduce((acc, g) => acc + g.qty, 0) + boQty
        const hiddenQuote =
          hiddenDCA.reduce((acc, g) => acc + g.qty * g.price, 0) +
          boQty * boPrice

        const rate = await this.getUsdRate(
          findDeal.deal.symbol.symbol,
          this.futures
            ? this.coinm
              ? 'base'
              : 'quote'
            : long
              ? 'quote'
              : 'base',
        )
        const maxBase =
          (this.futures ? (this.coinm ? totalBase : 0) : long ? 0 : totalBase) /
          leverage
        const maxQuote =
          (this.futures
            ? this.coinm
              ? 0
              : totalQuote
            : long
              ? totalQuote
              : 0) / leverage
        const currentBase =
          (!reset
            ? this.futures
              ? this.coinm
                ? long
                  ? findDeal.deal.currentBalances.base
                  : Math.max(
                      findDeal.deal.initialBalances.base -
                        (findDeal.deal.currentBalances.base - base),
                      hiddenBase,
                    )
                : 0
              : long
                ? 0
                : Math.max(
                    findDeal.deal.initialBalances.base -
                      (findDeal.deal.currentBalances.base - base),
                    hiddenBase,
                  )
            : 0) / leverage
        const currentQuote =
          (!reset
            ? this.futures
              ? this.coinm
                ? 0
                : !long
                  ? findDeal.deal.currentBalances.quote
                  : Math.max(
                      findDeal.deal.initialBalances.quote -
                        (findDeal.deal.currentBalances.quote - quote),
                      hiddenQuote,
                    )
              : long
                ? Math.max(
                    findDeal.deal.initialBalances.quote -
                      (findDeal.deal.currentBalances.quote - quote),
                    hiddenQuote,
                  )
                : 0
            : 0) / leverage
        const maxUsd = this.futures
          ? this.coinm
            ? maxBase * rate
            : maxQuote * rate
          : long
            ? maxQuote * rate
            : maxBase * rate
        const currentUsd = this.futures
          ? this.coinm
            ? currentBase * rate
            : currentQuote * rate
          : long
            ? currentQuote * rate
            : currentBase * rate
        if (sendAlert) {
          this.sendEightyAlert(findDeal)
          await this.sendHundredAlert(findDeal)
        }
        let relative = currentUsd / maxUsd
        if (isNaN(relative) || !isFinite(relative)) {
          relative = 0
        }
        findDeal.deal.usage = {
          max: {
            base: maxBase,
            quote: maxQuote,
          },
          current: {
            base: currentBase,
            quote: currentQuote,
          },
          maxUsd,
          currentUsd: currentUsd,
          relative: relative,
        }
        if (findDeal.deal.usage.current.base > findDeal.deal.usage.max.base) {
          findDeal.deal.usage.max.base = findDeal.deal.usage.current.base
        }
        if (findDeal.deal.usage.current.quote > findDeal.deal.usage.max.quote) {
          findDeal.deal.usage.max.quote = findDeal.deal.usage.current.quote
        }
        const costValue =
          this.futures && findDeal.deal.status === DCADealStatusEnum.closed
            ? this.coinm
              ? findDeal.deal.usage.current.base *
                findDeal.deal.avgPrice *
                leverage
              : findDeal.deal.usage.current.quote * leverage
            : Math.max(
                (this.futures
                  ? this.coinm
                    ? findDeal.deal.usage.current.base * findDeal.deal.avgPrice
                    : findDeal.deal.usage.current.quote
                  : long
                    ? findDeal.deal.usage.current.quote
                    : findDeal.deal.usage.current.base) * leverage,
                0,
              )
        const sizeValue =
          this.futures && !this.coinm
            ? findDeal.deal.status === DCADealStatusEnum.closed
              ? (findDeal.deal.usage.current.quote * leverage) /
                findDeal.deal.avgPrice
              : long
                ? findDeal.deal.currentBalances.base
                : findDeal.deal.initialBalances.base -
                  findDeal.deal.currentBalances.base
            : Math.max(
                (this.futures
                  ? this.coinm
                    ? findDeal.deal.usage.current.base
                    : findDeal.deal.usage.current.quote
                  : long
                    ? findDeal.deal.usage.current.quote
                    : findDeal.deal.usage.current.base) * leverage,
                0,
              )
        const costMultiplier = this.futures
          ? 1
          : long
            ? 1
            : findDeal.deal.avgPrice
        const sizeDenominator = this.futures
          ? 1
          : long
            ? findDeal.deal.avgPrice
            : 1
        let s = sizeValue / sizeDenominator
        s = isNaN(s) ? 0 : isFinite(s) ? s : 0
        let c = costValue * costMultiplier
        c = isNaN(c) ? 0 : c
        this.saveDeal(findDeal, {
          usage: findDeal.deal.usage,
          size: s,
          cost: c / leverage,
          value: c,
        }).then(runBot)
      }
      if (!findDeal && reset) {
        runBot()
      }
    }
    override async processCanceledOrder(
      order: Order,
      _updateTime: number,
      expired: boolean,
    ): Promise<void> {
      if (!expired) {
        return
      }
      if (order.typeOrder === TypeOrderEnum.dealGrid) {
        const positionChanged =
          (this.isLong && order.side === OrderSideEnum.sell) ||
          (!this.isLong && order.side === OrderSideEnum.buy)
        if (positionChanged) {
          const findMinigrid = this.getMinigrid(order.minigridId)

          if (findMinigrid) {
            findMinigrid.currentOrders = findMinigrid.currentOrders.filter(
              (o) =>
                !(
                  o.price === +order.origPrice &&
                  o.qty === +order.origQty &&
                  o.side === order.side
                ),
            )
            this.setMinigrid(findMinigrid)
          }
          const findDeal = this.getDeal(order.dealId)
          if (findDeal) {
            findDeal.currentOrders = findDeal.currentOrders.filter(
              (o) =>
                !(
                  o.price === +order.origPrice &&
                  o.qty === +order.origQty &&
                  o.side === order.side
                ),
            )
            this.saveDeal(findDeal)
          }
        }
      }
    }

    @IdMute(mutex, (order: Order) => `${order.botId}update${order.dealId}`)
    private async updateMinigrid(order: Order) {
      const _id = this.startMethod('updateMinigrid')
      const minigrid = this.getMinigrid(order.minigridId)

      if (!minigrid) {
        this.handleWarn(
          `Cannot find minigrid for ${order.minigridId} ${order.clientOrderId}`,
        )
        const findInDb = await this.minigridDb.readData({
          _id: order.minigridId,
        })
        if (findInDb.data?.result) {
          this.handleLog(
            `Found minigrid in db for ${order.minigridId} ${order.clientOrderId}, status: ${findInDb.data.result.status}`,
          )
        }
        if (findInDb.data?.result.status === ComboMinigridStatusEnum.closed) {
          this.handleLog(
            `Minigrid is closed, checking for deal ${order.dealId}`,
          )
          const dealInDb = await this.dealsDb.readData({
            _id: order.dealId,
          })
          if (dealInDb.data?.result) {
            this.handleLog(
              `Found deal in db for ${order.dealId}, status: ${dealInDb.data.result.status}`,
            )
            if (dealInDb.data.result.status === DCADealStatusEnum.closed) {
              this.handleLog(`Deal is closed, sell remainder`)
              await this.sellRemainder(
                `${dealInDb.data.result._id}`,
                +order.origQty,
                +order.price,
                false,
                {
                  deal: {
                    ...dealInDb.data.result,
                    _id: `${dealInDb.data.result._id}`,
                  },
                  initialOrders: [],
                  currentOrders: [],
                  previousOrders: [],
                  closeBySl: false,
                  notCheckSl: false,
                  closeByTp: false,
                },
                false,
              )
            }
          }
        }
        this.endMethod(_id)
        return
      }
      this.handleLog(
        `Update minigrid ${order.minigridId} ${order.clientOrderId}`,
      )
      const { dealId } = minigrid.schema
      let deal = this.getDeal(dealId)
      const settings = await this.getAggregatedSettings(deal?.deal)
      const pair = minigrid.schema.symbol.symbol
      const tr = await this.createTransaction(order, minigrid)
      if (!tr) {
        this.handleWarn(
          `Cannot create transaction for ${order.minigridId} ${order.clientOrderId}`,
        )
      }
      let toPlace: { new: Grid[]; cancel: Grid[] } = { new: [], cancel: [] }

      const total = (await this.profitBase(deal?.deal))
        ? (tr?.profitBase ?? 0)
        : (tr?.profitQuote ?? 0)
      const totalUsd = tr?.profitUsdt ?? 0
      minigrid.schema.transactions.buy += order.side === 'BUY' ? 1 : 0
      minigrid.schema.transactions.sell += order.side === 'SELL' ? 1 : 0
      minigrid.schema.profit.total += total
      minigrid.schema.profit.totalUsd += totalUsd
      minigrid.schema.profit.pureBase =
        (minigrid.schema.profit.pureBase ?? 0) + (tr?.profitPureBase ?? 0)
      minigrid.schema.profit.pureQuote =
        (minigrid.schema.profit.pureQuote ?? 0) + (tr?.profitPureQuote ?? 0)
      minigrid.schema.feePaid = {
        base: (minigrid.schema.feePaid?.base ?? 0) + (tr?.pureFeeBase ?? 0),
        quote: (minigrid.schema.feePaid?.quote ?? 0) + (tr?.pureFeeQuote ?? 0),
      }

      minigrid.schema.updateTime = order.updateTime
      if (deal) {
        deal.deal.profit.total += total
        deal.deal.profit.totalUsd += totalUsd
        deal.deal.profit.gridProfit = deal.deal.profit.total
        deal.deal.profit.gridProfitUsd = deal.deal.profit.totalUsd

        deal.deal.profit.pureBase =
          (deal.deal.profit.pureBase ?? 0) + (tr?.profitPureBase ?? 0)
        deal.deal.profit.pureQuote =
          (deal.deal.profit.pureQuote ?? 0) + (tr?.profitPureQuote ?? 0)
        deal.deal.feePaid = {
          base: (deal.deal.feePaid?.base ?? 0) + (tr?.pureFeeBase ?? 0),
          quote: (deal.deal.feePaid?.quote ?? 0) + (tr?.pureFeeQuote ?? 0),
        }
        deal.deal.transactions = {
          buy:
            (deal.deal.transactions?.buy ?? 0) + (order.side === 'BUY' ? 1 : 0),
          sell:
            (deal.deal.transactions?.sell ?? 0) +
            (order.side === 'SELL' ? 1 : 0),
        }

        const avgs = await this.avgPrice(dealId, dealId)
        let avgPrice = avgs.real
        avgPrice = isNaN(avgPrice) ? deal.deal.avgPrice : avgPrice
        deal.deal.avgPrice = avgPrice
        deal.deal.displayAvg = isNaN(avgs.display)
          ? deal.deal.displayAvg || deal.deal.displayAvg
          : avgs.display
        deal.deal.settings.avgPrice = deal.deal.avgPrice
        deal.deal.fullFee = await this.getCommDeal(deal.deal)
        deal.deal.updateTime = minigrid.schema.updateTime
        this.saveDeal(deal, {
          profit: deal.deal.profit,
          avgPrice: deal.deal.avgPrice,
          'settings.avgPrice': deal.deal.settings.avgPrice,
          displayAvg: deal.deal.displayAvg,
          feePaid: deal.deal.feePaid,
          transactions: deal.deal.transactions,
          fullFee: deal.deal.fullFee,
          updateTime: deal.deal.updateTime,
        })
      }
      let grids: Grid[] = (
        (await this.generateGridsOnPrice(
          {
            pair,
            initialGrids: minigrid.initialGrids,
            lowPrice: minigrid.schema.settings.lowPrice,
            topPrice: minigrid.schema.settings.topPrice,
            levels: minigrid.schema.settings.levels,
            updatedBudget: true,
            _budget: minigrid.schema.settings.budget,
            _lastPrice: +order.origPrice,
            _initialPriceStart: minigrid.schema.initialPrice,
            _side:
              order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
            all: true,
            profitCurrency: settings.futures
              ? 'quote'
              : (settings.profitCurrency ?? 'quote'),
            orderFixedIn: settings.futures
              ? settings.coinm
                ? ('quote' as const)
                : ('base' as const)
              : settings.profitCurrency === 'quote'
                ? ('base' as const)
                : ('quote' as const),
          },
          !this.isLong,
          this.data?.settings.newBalance,
          this.feeOrder,
          deal?.deal.tags?.includes('newSell'),
        )) ?? []
      ).map((g) => ({
        ...g,
        newClientOrderId: this.getOrderId(`CMB-GR`),
        dealId,
        type: TypeOrderEnum.dealGrid,
        minigridId: minigrid.schema._id,
      }))

      let prev = minigrid.currentOrders
      const isLatest = this.isLastMinigridOrder(
        order.updateTime,
        +order.origPrice,
        order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
        minigrid.schema._id,
      )
      if (!isLatest) {
        this.handleDebug(
          `Not latest order ${order.clientOrderId}, apply previous minigrid orders`,
        )
        grids = minigrid.currentOrders.map((g) => ({
          ...g,
          newClientOrderId: this.getOrderId(`CMB-GR`),
        }))
      }
      const wasClosed =
        minigrid.schema.status === ComboMinigridStatusEnum.closed
      if (grids) {
        const buys = grids.filter((g) => g.side === OrderSideEnum.buy).length
        const sells = grids.filter((g) => g.side === OrderSideEnum.sell).length
        this.handleDebug(
          `Minigrid ${minigrid.schema._id} buys - ${buys}, sells - ${sells} after ${order.clientOrderId}`,
        )
        const closeMinigrid =
          !minigrid.schema.lockClose &&
          ((this.isLong && sells === 0) || (!this.isLong && buys === 0))
        minigrid.schema.status = closeMinigrid
          ? ComboMinigridStatusEnum.closed
          : minigrid.schema.status
        minigrid.currentOrders = grids
        const currentBalances = this.calculateMinigridBalances(grids)
        minigrid.schema.currentBalances = currentBalances
        minigrid.schema.assets = {
          used: currentBalances,
          required: currentBalances,
        }
        minigrid.schema.grids = {
          buy: grids.filter((g) => g.side === OrderSideEnum.buy).length,
          sell: grids.filter((g) => g.side == OrderSideEnum.sell).length,
        }
        const avgs = await this.avgPrice(dealId, undefined, minigrid.schema._id)
        let avgPrice = avgs.real
        avgPrice = isNaN(avgPrice) ? minigrid.schema.avgPrice : avgPrice
        minigrid.schema.avgPrice = avgPrice
        const prevPrice = minigrid.schema.lastPrice
        minigrid.schema.lastPrice = isLatest
          ? +order.origPrice
          : minigrid.schema.lastPrice
        minigrid.schema.lastSide = isLatest
          ? order.side === 'BUY'
            ? OrderSideEnum.buy
            : OrderSideEnum.sell
          : minigrid.schema.lastSide
        if (settings.comboUseSmartGrids && settings.comboSmartGridsCount) {
          const count = +(settings.comboSmartGridsCount ?? '0')
          if (count && !isNaN(count)) {
            prev = [
              ...(closeMinigrid ? [] : prev),
              ...this.getMinigridByDealId({ dealId })
                .filter(
                  (m) =>
                    m.schema.status !== ComboMinigridStatusEnum.closed &&
                    m.schema._id !== minigrid.schema._id,
                )
                .map((m) => m.currentOrders)
                .flat(),
            ]
              .sort(
                (a, b) =>
                  Math.abs(prevPrice - a.price) - Math.abs(prevPrice - b.price),
              )
              .slice(0, count)
          }
        }
        toPlace = await this.findDiffCombo(
          [
            ...grids,
            ...(deal?.currentOrders ?? []).map((o) => ({
              ...o,
              newClientOrderId:
                o.type === TypeOrderEnum.dealRegular
                  ? this.getOrderId(`CMB-RO`)
                  : o.newClientOrderId,
            })),
          ],
          [
            ...prev,
            ...(this.getOrdersByStatusAndDealId({
              dealId,
              defaultStatuses: true,
            })
              .filter((o) => o.typeOrder === TypeOrderEnum.dealRegular)
              .map((o) => this.mapOrderToGrid(o)) ?? []),
          ],
          minigrid.schema.lastPrice,
          order,
          deal,
        )
      } else {
        this.handleWarn(`Cannot create grid order after ${order.clientOrderId}`)
      }
      this.saveMinigrid(minigrid, {
        transactions: minigrid.schema.transactions,
        profit: minigrid.schema.profit,
        updateTime: minigrid.schema.updateTime,
        currentBalances: minigrid.schema.currentBalances,
        assets: minigrid.schema.assets,
        status: minigrid.schema.status,
        grids: minigrid.schema.grids,
        lastPrice: minigrid.schema.lastPrice,
        lastSide: minigrid.schema.lastSide,
        avgPrice: minigrid.schema.avgPrice,
        feePaid: minigrid.schema.feePaid,
      })

      if (
        dealId &&
        order.botId === this.botId &&
        (!deal || deal.deal.status === DCADealStatusEnum.closed)
      ) {
        this.handleDebug(`Deal ${dealId} is closed, will sell the remainder`)
        await this.sellRemainder(
          dealId,
          +order.origQty,
          +order.price,
          false,
          deal,
        )
        this.endMethod(_id)
        return
      }

      await this.calculateDealBalances(dealId).then(async () => {
        const d = this.getDeal(dealId)
        if (d && minigrid.schema.status !== ComboMinigridStatusEnum.closed) {
          await this.checkDealSlMethods(d)
        }
        this.checkDealsPriceExtremum()
      })
      this.updateBotDealStats(dealId)
      this.calculateBotBalances()
      this.updateAssets(dealId)
      deal = this.getDeal(dealId)
      if (wasClosed) {
        this.handleLog(`Minigrid ${minigrid.schema._id} was closed`)
        this.endMethod(_id)
        return
      }
      if (minigrid.schema.status === ComboMinigridStatusEnum.closed) {
        this.handleLog(
          `Close ${minigrid.schema._id} minigrid after ${order.clientOrderId}`,
        )

        let deal = this.getDeal(dealId)
        await this.closeMinigrid(dealId, minigrid)
        await sleep(100)
        const get = this.getDeal(dealId)
        deal =
          get && get.deal.status !== DCADealStatusEnum.closed ? get : undefined
        if (deal) {
          const minigridOrder = await this.ordersDb.readData<{
            typeOrder: TypeOrderEnum
            dcaLevel?: number
          }>(
            {
              clientOrderId: minigrid.schema.dcaOrderId,
            },
            { typeOrder: 1, dcaLevel: 1 },
          )
          if (
            minigridOrder.data?.result?.typeOrder === TypeOrderEnum.dealStart
          ) {
            if (!deal.closeBySl) {
              deal.closeBySl = true
              this.handleLog(`Close deal ${dealId} after base minigrid close`)
              this.endMethod(_id)
              return this.closeDealById(
                this.botId,
                dealId,
                CloseDCATypeEnum.closeByMarket,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                DCACloseTriggerEnum.base,
              )
            }
            this.endMethod(_id)
            return this.handleDebug(`Deal ${dealId} already closing`)
          }
          this.updateUsage(dealId).then(async () => {
            const d = this.getDeal(dealId)
            if (d) {
              await this.checkDealSlMethods(d)
            }
            this.checkDealsPriceExtremum()
          })
          if (minigridOrder.data?.result?.dcaLevel) {
            deal.deal.ignoreLevels = Array.from(
              new Set([
                ...(deal.deal.ignoreLevels ?? []),
                minigridOrder.data.result.dcaLevel,
              ]),
            )
            this.saveDeal(deal, { ignoreLevels: deal.deal.ignoreLevels })
          }
          const orders = await this.createCurrentDealOrders(
            pair,
            +order.price,
            deal.initialOrders,
            deal.deal.avgPrice,
            deal.deal.initialPrice,
            deal.deal._id,
            undefined,
            deal.deal,
            undefined,
            undefined,
          )
          const findOriginOrder = orders.find(
            (o) =>
              o.price === minigrid.schema.initialPrice &&
              o.type === TypeOrderEnum.dealRegular &&
              !o.hide,
          )
          if (!findOriginOrder) {
            this.handleDebug(
              `Minigrid start order not found in current orders. Search in initial orders`,
            )
            const findOrderInInitial = deal.initialOrders.find(
              (io) =>
                io.price === minigrid.schema.initialPrice &&
                io.type === TypeOrderEnum.dealRegular &&
                !io.hide,
            )
            if (findOrderInInitial) {
              this.handleDebug(
                `Minigrid start order found in initial orders. Will be added to current`,
              )
              orders.push({
                ...findOrderInInitial,
                newClientOrderId: this.getOrderId('CMB-RO'),
              })
            }
          }
          deal.previousOrders = deal.currentOrders.map((o) => ({
            ...o,
            newClientOrderId: this.getOrderId('CMB-RO'),
          }))
          deal.currentOrders = orders.map((o) => ({
            ...o,
            newClientOrderId: this.getOrderId('CMB-RO'),
          }))
          this.saveDeal(deal)
          const minigridOrders = this.getOrdersByStatusAndDealId({
            status: 'NEW',
            dealId: minigrid.schema.dealId,
          }).filter(
            (o) => o.minigridId === minigrid.schema._id && o.status === 'NEW',
          )
          for (const o of minigridOrders) {
            await this.cancelOrderOnExchange(o)
          }
          for (const o of this.pendingOrdersList.get(minigrid.schema._id) ??
            []) {
            this.stopList.add(o.newClientOrderId)
          }
          this.pendingOrdersList.delete(minigrid.schema._id)
          if (!deal.closeBySl) {
            await this.placeOrders(
              this.botId,
              pair,
              dealId,
              await this.findDiffCombo(
                orders.filter((o) => !o.hide),
                deal.previousOrders.filter((o) => !o.hide),
                +order.price,
                order,
                deal,
              ),
            )
          } else {
            this.handleDebug(
              `Deal ${dealId} is closing, will not place new orders`,
            )
          }
        }
        this.endMethod(_id)
        return
      }
      if (
        deal &&
        !deal.closeBySl &&
        this.data?.settings.feeOrder &&
        (this.isLong
          ? order.side === OrderSideEnum.buy
          : order.side === OrderSideEnum.sell) &&
        !this.futures
      ) {
        const fee = await this.getUserFee(order.symbol)
        const newKucoinFee =
          this.kucoinSpot && this.data.flags?.includes(BotFlags.kucoinNewFee)
        const feeSize = newKucoinFee
          ? +order.executedQty * +order.price * (fee?.maker ?? 0)
          : this.isLong
            ? +order.executedQty * (fee?.maker ?? 0)
            : +order.executedQty * +order.price * (fee?.maker ?? 0)
        deal.deal.feeBalance =
          newKucoinFee && this.isLong
            ? 0
            : (deal.deal.feeBalance ?? 0) - feeSize
        deal.deal.currentBalances = {
          quote: this.isLong
            ? deal.deal.currentBalances.quote - (newKucoinFee ? feeSize : 0)
            : deal.deal.currentBalances.quote - feeSize,
          base: this.isLong
            ? deal.deal.currentBalances.base - (newKucoinFee ? 0 : feeSize)
            : deal.deal.currentBalances.base,
        }
        this.saveDeal(deal, {
          feeBalance: deal.deal.feeBalance,
          currentBalances: deal.deal.currentBalances,
        })
        if (
          deal.deal.feeBalance <=
          (this.kucoinSpot && this.data.flags?.includes(BotFlags.kucoinNewFee)
            ? (await this.getFeeOrderSize(order.dealId ?? '')) * +order.price
            : 0)
        ) {
          await this.placeFeeOrder(this.botId, dealId, order.clientOrderId)
        }
      }
      if (!isLatest) {
        this.handleDebug(`Order ${order.clientOrderId} is not latest`)
        this.endMethod(_id)
        return
      }
      for (const o of toPlace.new) {
        if (o.minigridId) {
          this.pendingOrdersList.set(
            o.minigridId,
            (this.pendingOrdersList.get(o.minigridId) ?? []).concat(o),
          )
        }
      }
      if (!deal?.closeBySl) {
        await this.placeOrders(this.botId, pair, dealId, toPlace)
        this.autoRebalancing(this.botId, dealId)
      } else {
        this.handleDebug(`Deal ${dealId} is closing, will not place new orders`)
      }
      this.endMethod(_id)
    }
    override async afterDealClose(dealId: string) {
      const mingrids = this.getMinigridByDealId({ dealId })
      for (const m of mingrids) {
        await this.processCloseMinigrid(m.schema._id)
        this.deleteMinigrid(m.schema._id, false)
      }
      this.saveMinigridToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
      this.usedOrderId.delete(dealId)
      this.updateUsedOrderId()
      this.updateBotDealStats(dealId)
    }
    override clearClassProperties(clearRedis = false, start = false) {
      super.clearClassProperties(clearRedis, start)
      this.minigrids = new Map()
      this.lastMinigridOrder = new Map()
      this.usedOrderId = new Map()
    }
    override async afterBotStop() {
      // super handles stopPriceTimer / stopReconcileSweep /
      // stopQuantRulesRetries — combo bots arm the price timer + reconcile
      // sweep via the inherited DCA start().
      await super.afterBotStop()
      for (const m of this.allMinigrids) {
        await this.processCloseMinigrid(m.schema._id)
      }
    }

    @IdMute(
      mutex,
      (order: Order) =>
        `${order.botId}process${order.symbol}${order.dealId ?? ''}`,
    )
    override async processFilledOrder(order: Order): Promise<void> {
      if (!this.shouldProceed()) {
        this.handleLog(
          this.notProceedMessage(`processFilledOrder ${order.clientOrderId}`),
        )
        return
      }
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.processFilledOrder.bind(this)(order),
        )
        return this.handleLog('Loading not complete yet')
      }
      this.handleLog(
        `Processing ${order.clientOrderId} ${order.typeOrder} ${order.dcaLevel}`,
      )
      if (
        +(this.lastFilledOrderMap.get(order.symbol)?.updateTime ?? '0') <
        +order.updateTime
      ) {
        this.lastFilledOrderMap.set(order.symbol, order)
      }
      const { dealId, clientOrderId } = order
      const getSet = dealId
        ? (this.processedFilled.get(dealId) ?? new Set<string>())
        : new Set<string>()
      if (dealId && !getSet.has(clientOrderId)) {
        this.processedFilled.set(dealId, getSet.add(clientOrderId))
        if (
          order.typeOrder === TypeOrderEnum.dealTP &&
          (order.clientOrderId.indexOf('D-SR') === -1 ||
            order.clientOrderId.indexOf('DSR') === -1)
        ) {
          this.allowToPlaceOrders.delete(dealId)
          this.closeDeal(this.botId, dealId, order)
        }
        if (order.typeOrder === TypeOrderEnum.dealGrid) {
          this.updateMinigrid(order)
        }
        if (order.typeOrder === TypeOrderEnum.dealStart) {
          this.startDeal(order)
        }
        if (order.typeOrder === TypeOrderEnum.dealRegular) {
          this.ordersInBetweenUpdates.add(order.clientOrderId)
          this.updateDeal(this.botId, order)
        }
        if (order.typeOrder === TypeOrderEnum.fee) {
          this.processFeeOrder(this.botId, order)
        }
        if (order.typeOrder === TypeOrderEnum.rebalance) {
          this.processRebalanceOrder(order)
        }
      } else {
        this.handleLog(`Order ${clientOrderId} was already processed`)
      }
    }
    override getInitalDealSettings(): ComboDealsSettings | undefined {
      if (this.data) {
        return this.utils.getInitalDealSettings(
          BotType.combo,
          this.data.settings,
        )
      }
    }
    override async updateAssets(
      dealId: string,
      deal?: FullDeal<CleanComboDealsSchema>,
    ) {
      const findDeal = deal ?? this.getDeal(dealId)
      if (this.data && findDeal) {
        const long = this.isLong
        let requiredBase = 0
        let requiredQuote = 0
        const settings = await this.getAggregatedSettings(findDeal.deal)
        const current = await this.createCurrentDealOrders(
          findDeal.deal.symbol.symbol,
          findDeal.deal.lastPrice,
          findDeal.initialOrders,
          findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
          findDeal.deal.initialPrice,
          findDeal.deal._id,
          settings.useSmartOrders &&
            settings.activeOrdersCount !== settings.ordersCount,
          findDeal.deal,
          true,
          false,
        )
        let used = current
        if (
          settings.useSmartOrders &&
          settings.activeOrdersCount !== settings.ordersCount
        ) {
          used = await this.createCurrentDealOrders(
            findDeal.deal.symbol.symbol,
            findDeal.deal.lastPrice,
            findDeal.initialOrders,
            findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
            findDeal.deal.initialPrice,
            findDeal.deal._id,
            false,
            findDeal.deal,
            true,
            false,
          )
        }
        const usedRegular = used.filter(
          (u) => u.type === TypeOrderEnum.dealRegular,
        )
        const all = current.filter((g) => g.type === TypeOrderEnum.dealRegular)
        const leverage = await this.getLeverageMultipler(findDeal.deal)
        const minigrids = this.getMinigridByDealId({ dealId })
        const minigridsQuote = minigrids.reduce(
          (acc, v) =>
            acc +
            v.currentOrders
              .filter((fo) => fo.side === OrderSideEnum.buy)
              .reduce((accO, vO) => accO + vO.qty * vO.price, 0),
          0,
        )
        const minigridsBase = minigrids.reduce(
          (acc, v) =>
            acc +
            v.currentOrders
              .filter((fo) => fo.side === OrderSideEnum.sell)
              .reduce((accO, vO) => accO + vO.qty, 0),
          0,
        )
        if (long) {
          requiredQuote = this.coinm
            ? 0
            : all.reduce((acc, v) => acc + v.qty * v.price, 0) + minigridsQuote
          if (this.coinm) {
            requiredBase = all.reduce((acc, v) => acc + v.qty, 0)
          }
          if (!this.futures) {
            requiredBase = minigridsBase
          }
        }
        if (!long) {
          requiredBase =
            this.futures && !this.coinm
              ? 0
              : all.reduce((acc, v) => acc + v.qty, 0) + minigridsBase
          if (!(this.futures && !this.coinm)) {
            requiredQuote = minigridsQuote
          } else {
            requiredQuote = all.reduce((acc, v) => acc + v.qty * v.price, 0)
          }
        }
        let usedBase =
          used
            .filter((g) => g.side === OrderSideEnum.sell)
            .reduce((acc, v) => acc + v.qty, 0) + minigridsBase
        let usedQuote =
          used
            .filter((g) => g.side === OrderSideEnum.buy)
            .reduce((acc, v) => acc + v.qty * v.price, 0) + minigridsQuote
        if (this.futures) {
          if (this.coinm) {
            usedQuote = 0
            usedBase = usedRegular.reduce((acc, v) => acc + v.qty, 0)
          } else {
            usedBase = 0
            usedQuote = usedRegular.reduce((acc, v) => acc + v.qty * v.price, 0)
          }
        }
        findDeal.deal.assets = {
          used: {
            base: usedBase / leverage,
            quote: usedQuote / leverage,
          },
          required: {
            base: requiredBase / leverage,
            quote: requiredQuote / leverage,
          },
        }
        this.handleDebug(
          `Deal ${findDeal.deal._id} assets used: base - ${findDeal.deal.assets.used.base}, quote - ${findDeal.deal.assets.used.quote}, assets required: base - ${findDeal.deal.assets.required.base}, quote - ${findDeal.deal.assets.required.quote}`,
        )
        this.saveDeal(findDeal, { assets: findDeal.deal.assets })
        this.updateBotAssets()
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}processFeeOrder`)
    private async processFeeOrder(_botId: string, order: Order) {
      const { dealId, clientOrderId, typeOrder, symbol, executedQty, price } =
        order
      const getSet = dealId
        ? (this.feeProcessed.get(dealId) ?? new Set<string>())
        : new Set<string>()
      if (getSet.has(clientOrderId)) {
        return
      }
      this.feeProcessed.set(dealId ?? '', getSet.add(clientOrderId))
      if (typeOrder !== TypeOrderEnum.fee) {
        this.handleWarn(
          `Fee order combo | Order not fee type ${clientOrderId} ${typeOrder}`,
        )
        return
      }
      const fee = await this.getUserFee(symbol)
      this.handleDebug(`Fee order combo | Process fee order ${clientOrderId}`)
      const size =
        (this.kucoinSpot && this.data?.flags?.includes(BotFlags.kucoinNewFee)
          ? +executedQty * +price
          : this.isLong
            ? +executedQty
            : +executedQty * +price) *
        (1 - (fee?.maker ?? 0))
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.handleWarn(
          `Fee order combo | Deal not found for ${dealId} ${clientOrderId}`,
        )
        return
      }
      deal.deal.feeBalance = (deal.deal.feeBalance ?? 0) + size
      deal.deal.feePaid = {
        base:
          (deal.deal.feePaid?.base ?? 0) +
          (this.isLong ? +order.executedQty * (fee?.taker ?? 0) : 0),
        quote:
          (deal.deal.feePaid?.quote ?? 0) +
          (!this.isLong
            ? +order.executedQty * +order.price * (fee?.taker ?? 0)
            : 0),
      }
      deal.deal.fullFee = await this.getCommDeal(deal.deal)
      const avgPrice = await this.avgPrice(deal.deal._id, dealId)
      if (!isNaN(avgPrice.real)) {
        deal.deal.avgPrice = avgPrice.real
        deal.deal.displayAvg = avgPrice.display
      }
      this.saveDeal(deal, {
        feeBalance: deal.deal.feeBalance,
        avgPrice: deal.deal.avgPrice,
        displayAvg: deal.deal.displayAvg,
        fullFee: deal.deal.fullFee,
      })
    }
    private async getFeeOrderSize(dealId: string) {
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.handleErrors(
          `Cannot find deal ${dealId} in getFeeOrderSize`,
          '',
          '',
          false,
          false,
          false,
        )
        return 0
      }
      const minigrids = this.getMinigridByDealId({ dealId })
      if (!minigrids.length) {
        this.handleErrors(
          `Cannot find minigrids for ${dealId} in getFeeOrderSize`,
          '',
          '',
          false,
          false,
          false,
        )
        return 0
      }
      const fee = await this.getUserFee(deal.deal.symbol.symbol)
      if (!fee) {
        this.handleErrors(
          `Cannot find fee for ${deal.deal.symbol.symbol} in getFeeOrderSize`,
          '',
          '',
          false,
          false,
          false,
        )
        return 0
      }
      const kucoinSpot =
        this.kucoinSpot && this.data?.flags?.includes(BotFlags.kucoinNewFee)
      const result =
        Math.max(
          ...minigrids.flatMap((m) =>
            m.currentOrders
              .filter((co) =>
                kucoinSpot
                  ? true
                  : this.isLong
                    ? co.side === OrderSideEnum.buy
                    : co.side === OrderSideEnum.sell,
              )
              .map((co) => co.qty),
          ),
        ) *
        fee.maker *
        (kucoinSpot
          ? Math.max(...minigrids.map((m) => m.schema.settings.levels))
          : 2)
      return result
    }

    @IdMute(mutex, (botId: string) => `${botId}placeFeeOrderCombo`)
    private async placeFeeOrder(
      _botId: string,
      dealId: string,
      orderId: string,
    ) {
      const deal = this.getDeal(dealId)
      if (deal?.deal.action === ActionsEnum.useOppositeBalance) {
        this.handleDebug(
          `Fee order combo | Deal ${dealId} is using opposite balance, skip fee order`,
        )
        return
      }
      if (
        this.kucoinSpot &&
        this.data?.flags?.includes(BotFlags.kucoinNewFee) &&
        this.isLong
      ) {
        this.handleDebug(
          `Fee order combo | Kucoin spot long bot, skip fee order`,
        )
        if (deal && deal.deal.feeBalance) {
          this.saveDeal(deal, { feeBalance: 0 })
        }
        return
      }
      if (!deal) {
        this.handleWarn(`Fee order combo | Cannot find deal ${dealId}`)
        return
      }
      if (this.data?.feeBalance && this.data.feeBalance > 0) {
        this.handleDebug(
          `Fee order combo | Found fee balance in bot ${this.data.feeBalance}`,
        )
        deal.deal.feeBalance = this.data.feeBalance
        this.data.feeBalance = 0
        this.updateData({ feeBalance: 0 })
        this.saveDeal(deal, { feeBalance: deal.deal.feeBalance })
        return
      }
      if (!this.data?.settings.feeOrder) {
        return
      }
      const val = this.feeOrderReasons.get(dealId) ?? []
      if (val.includes(orderId)) {
        this.handleDebug(`Fee order combo | Order ${orderId} already processed`)
        return
      }
      if (val.length) {
        val.push(orderId)
      } else {
        this.feeOrderReasons.set(dealId, [orderId])
      }
      const minigrids = this.getMinigridByDealId({ dealId })
      if (!minigrids.length) {
        this.handleWarn(
          `Fee order combo | Cannot find minigrids for deal ${dealId}`,
        )
        return
      }
      const kucoinSpot =
        this.kucoinSpot && this.data?.flags?.includes(BotFlags.kucoinNewFee)
      const size =
        Math.max(
          ...minigrids.flatMap((m) =>
            m.currentOrders
              .filter((co) =>
                kucoinSpot
                  ? true
                  : this.isLong
                    ? co.side === OrderSideEnum.buy
                    : co.side === OrderSideEnum.sell,
              )
              .map((co) => co.qty),
          ),
        ) *
        (kucoinSpot
          ? Math.max(...minigrids.map((m) => m.schema.settings.levels))
          : 1)

      const order = await this._placeFeeOrder(
        this.botId,
        deal.deal.symbol.symbol,
        this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell,
        size,
        dealId,
      )
      if (order && order.status === 'FILLED') {
        this.processFeeOrder(this.botId, order)
      }
    }

    @IdMute(mutex, (order: Order) => `${order.botId}${order.clientOrderId}`)
    override async startDeal(orderBo: Order) {
      const _id = this.startMethod('startDeal')
      const { dealId } = orderBo
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        dealId &&
        findDeal.deal.status === DCADealStatusEnum.start &&
        findDeal.initialOrders.length === 0
      ) {
        this.handleLog('Base order FILLED')
        const initialPrice = parseFloat(orderBo.price)
        const qty = parseFloat(orderBo.executedQty)
        await this.clearDealTimer(dealId)
        const long = this.isLong
        findDeal.initialOrders = await this.createInitialDealOrders(
          findDeal.deal.symbol.symbol,
          initialPrice,
          dealId,
          findDeal.deal,
        )
        const hiddenDCA = [...findDeal.initialOrders.filter((o) => o.hide)]
        findDeal.currentOrders = await this.createCurrentDealOrders(
          findDeal.deal.symbol.symbol,
          initialPrice,
          findDeal.initialOrders,
          initialPrice,
          initialPrice,
          dealId,
          false,
          findDeal.deal,
          false,
        )
        findDeal.previousOrders = []
        findDeal.deal.initialBalances = {
          base: long
            ? 0
            : findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.sell)
                .reduce((acc, v) => acc + v.qty, 0) + qty,
          quote: long
            ? findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.buy)
                .reduce((acc, v) => acc + v.qty * v.price, 0) +
              initialPrice * qty
            : 0,
        }
        findDeal.deal.currentBalances = {
          base: long ? qty : findDeal.deal.initialBalances.base - qty,
          quote: long
            ? findDeal.deal.initialBalances.quote - qty * initialPrice
            : qty * initialPrice,
        }
        const fee = await this.getUserFee(orderBo.symbol)
        findDeal.deal.initialPrice = initialPrice
        findDeal.deal.lastPrice = initialPrice
        findDeal.deal.avgPrice = initialPrice
        findDeal.deal.displayAvg = initialPrice
        findDeal.deal.settings.avgPrice = initialPrice
        findDeal.deal.status = DCADealStatusEnum.open
        findDeal.deal.updateTime = orderBo.updateTime
        findDeal.deal.levels.complete = hiddenDCA.length + 1
        findDeal.deal.lastFilledLevel = 1
        findDeal.deal.totalAssetAmount = qty
        findDeal.deal.fullFee = await this.getCommDeal(findDeal.deal)
        findDeal.deal.feePaid = {
          base:
            (findDeal.deal.feePaid?.base ?? 0) +
            (long ? +orderBo.executedQty * (fee?.taker ?? 0) : 0),
          quote:
            (findDeal.deal.feePaid?.quote ?? 0) +
            (!long
              ? +orderBo.executedQty * +orderBo.price * (fee?.taker ?? 0)
              : 0),
        }
        this.saveDeal(findDeal, {
          initialBalances: findDeal.deal.initialBalances,
          currentBalances: findDeal.deal.currentBalances,
          initialPrice: findDeal.deal.initialPrice,
          lastPrice: findDeal.deal.lastPrice,
          avgPrice: findDeal.deal.avgPrice,
          'settings.avgPrice': findDeal.deal.settings.avgPrice,
          updateTime: findDeal.deal.updateTime,
          levels: findDeal.deal.levels,
          status: findDeal.deal.status,
          lastFilledLevel: findDeal.deal.lastFilledLevel,
          totalAssetAmount: findDeal.deal.totalAssetAmount,
          displayAvg: findDeal.deal.displayAvg,
          fullFee: findDeal.deal.fullFee,
          feePaid: findDeal.deal.feePaid,
        })
        const dcaOrders = findDeal.currentOrders
        let gridOrders = await this.createMinigrid(
          findDeal.deal,
          orderBo,
          false,
        )
        if (!gridOrders) {
          this.handleWarn(
            `Grid orders not created ${findDeal.deal._id} ${orderBo.clientOrderId}`,
          )
        }
        for (const h of hiddenDCA) {
          const ed = await this.getExchangeInfo(orderBo.symbol)
          if (ed) {
            const order = {
              ...this.mapGridToOrder(
                h,
                {
                  dealId: findDeal.deal._id,
                  type: 'LIMIT',
                  reduceOnly: !!this.futures,
                  positionSide: this.hedge
                    ? this.isLong
                      ? PositionSide.LONG
                      : PositionSide.SHORT
                    : PositionSide.BOTH,
                },
                ed,
              ),
              status: 'CANCELED' as const,
              minigridBudget: h.minigridBudget,
            }
            order.executedQty = `${+order.origQty}`
            const m = await this.createMinigrid(
              findDeal.deal,
              order,
              true,
              initialPrice,
            )
            if (!gridOrders) {
              this.handleWarn(
                `Grid orders not created ${findDeal.deal._id} ${h.newClientOrderId}`,
              )
            } else {
              gridOrders = [...gridOrders, ...(m ?? [])]
              await this.saveOrderToDb(order)
            }
          }
        }
        const orders = [...dcaOrders, ...(gridOrders ?? [])]
        this.updateUsage(dealId).then(async () => {
          await this.checkDealsAllowedMethods()
          const d = this.getDeal(dealId)
          if (d) {
            await this.checkDealSlMethods(d)
          }
        })
        await this.placeFeeOrder(this.botId, dealId, orderBo.clientOrderId)
        this.updateAssets(dealId)
        await this.placeOrders(
          this.botId,
          orderBo.symbol,
          dealId,
          await this.findDiffCombo(
            orders.filter((o) => !o.hide),
            [],
            initialPrice,
            orderBo,
            findDeal,
          ),
        )
        await this.checkOpenedDeals()
        this.updateDealLastPrices(this.botId)
        this.sendDealOpenedAlert(findDeal.deal, orderBo)
      }
      if (
        findDeal &&
        dealId &&
        findDeal.deal.status === DCADealStatusEnum.open &&
        findDeal.deal.allowBaseProcess
      ) {
        this.updateDeal(this.botId, orderBo)
      }
      if (findDeal) {
        this.updateDealBalances(findDeal)
        this.calculateBotBalances()
      }
      if (dealId) {
        this.updateBotDealStats(dealId)
      }
      this.endMethod(_id)
    }
    override async createInitialDealOrders(
      _symbol: string,
      price: number,
      dealId: string,
      deal?: ExcludeDoc<ComboDealsSchema>,
    ): Promise<Grid[]> {
      this.handleDebug('Generate initial deal orders')
      const ed = await this.getExchangeInfo(_symbol)
      if (this.data && ed && this.orders) {
        const settings = await this.getAggregatedSettings(deal)
        const { orderSizeType, comboActiveMinigrids, useActiveMinigrids } =
          settings
        const symbol = ed
        const orderSize = +(settings.orderSize ?? '0')
        const ordersCount = settings.ordersCount
        const precision = await this.baseAssetPrecision(_symbol)
        const step = +(settings.step ?? '1') / 100
        const stepScale = +(settings.stepScale ?? '1')
        const volumeScale = +(settings.volumeScale ?? '1')
        const latestPrice = this.math.round(price, symbol.priceAssetPrecision)
        const useDca = settings.useDca
        const ordersSide = this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell
        const gridStep = latestPrice * step
        const orders: Grid[] = []
        const fee = await this.getUserFee(symbol.pair)
        const feeFactor = 1 + (fee?.maker ?? 0)
        if (useDca) {
          const breakpoints: GridBreakpoint[] = []
          const long = this.isLong
          let balanceUseQty = 0
          if (
            orderSizeType === OrderSizeTypeEnum.percFree ||
            orderSizeType === OrderSizeTypeEnum.percTotal
          ) {
            if (settings.orderSizePercQty && settings.orderSizePercQty !== 0) {
              balanceUseQty = settings.orderSizePercQty
            } else {
              balanceUseQty = await this.getBalancePercQty(
                orderSizeType,
                orderSize,
                dealId,
                symbol.pair,
              )
            }
          }
          for (let i = 1; i <= (ordersCount ?? 0); i++) {
            const stepVal = stepScale ** (i - 1)
            const volumeVal = volumeScale ** (i - 1)
            let price = this.math.round(
              (i === 1 ? latestPrice : orders[orders.length - 1].price) -
                (this.isLong ? 1 : -1) * gridStep * stepVal,
              symbol.priceAssetPrecision,
            )
            if (i === 1) {
              if (price === latestPrice) {
                price = this.math.round(
                  latestPrice +
                    (this.isLong ? -1 : 1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
            }
            if (i > 1) {
              if (price === orders[orders.length - 1].price) {
                price = this.math.round(
                  orders[orders.length - 1].price +
                    (this.isLong ? -1 : 1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
            }
            if (price <= 0) {
              break
            }
            price = this.math.round(price, ed.priceAssetPrecision)
            const findBreakpoint = breakpoints
              .sort((a, b) => (long ? b.price - a.price : a.price - b.price))
              .find((b) => price === b.price)
            if (findBreakpoint) {
              price = this.math.round(
                findBreakpoint.displacedPrice,
                symbol.priceAssetPrecision,
              )
            }
            let qty = this.math.round(
              ((orderSize * (this.coinm ? ed.quoteAsset.minAmount : 1)) /
                price) *
                volumeVal +
                (deal?.sizes?.dca?.[i - 1] ?? 0),
              precision,
            )
            if (orderSizeType === OrderSizeTypeEnum.base) {
              qty = this.math.round(
                orderSize * volumeVal + (deal?.sizes?.dca?.[i - 1] ?? 0),
                precision,
              )
            }
            if (orderSizeType === OrderSizeTypeEnum.usd) {
              qty = this.math.round(
                (orderSize * volumeVal) /
                  ((await this.getUsdRate(symbol.pair, 'quote')) *
                    latestPrice) +
                  (deal?.sizes?.dca?.[i - 1] ?? 0),
                precision,
              )
            }
            if (
              orderSizeType === OrderSizeTypeEnum.percFree ||
              orderSizeType === OrderSizeTypeEnum.percTotal
            ) {
              qty = this.futures
                ? this.coinm
                  ? this.math.round(balanceUseQty * volumeVal, precision)
                  : this.math.round(
                      (balanceUseQty / price) * volumeVal,
                      precision,
                    )
                : long
                  ? this.math.round(
                      (balanceUseQty / price) * volumeVal,
                      precision,
                    )
                  : this.math.round(balanceUseQty * volumeVal, precision)
            }
            if (qty < symbol.baseAsset.minAmount) {
              qty = symbol.baseAsset.minAmount
            }
            if (qty * price < symbol.quoteAsset.minAmount && !this.coinm) {
              qty = this.math.round(
                symbol.quoteAsset.minAmount / price,
                precision,
                false,
                true,
              )
            }
            if (settings.coinm && !this.isBitget) {
              const cont = (price * qty) / symbol.quoteAsset.minAmount
              if (cont < 1) {
                qty = this.math.round(
                  symbol.quoteAsset.minAmount / price,
                  precision,
                  false,
                  true,
                )
              } else if (cont % 1 > Number.EPSILON) {
                qty = this.math.round(
                  (this.math.round(cont, 0) * symbol.quoteAsset.minAmount) /
                    price,
                  precision,
                  false,
                  true,
                )
              }
            }
            try {
              const mod = +new Big(qty).mod(symbol.baseAsset.step).toFixed(20)
              if (mod !== 0) {
                qty = this.math.round(
                  qty - mod + symbol.baseAsset.step,
                  precision,
                  false,
                  true,
                )
              }
            } catch (e) {
              this.handleErrors(
                `Big number error ${(e as Error).message || e}`,
                'createInitialDealOrders',
                '',
                false,
                false,
                false,
              )
            }
            const pair = symbol.pair
            const topPrice = this.isLong ? price + gridStep * stepVal : price
            const lowPrice = this.isLong ? price : price - gridStep * stepVal
            const levels = Math.floor(+(settings.gridLevel ?? '1'))
            const sellDisplacement = (fee?.maker ?? 0) * 2
            const initialGrids =
              (await this.generateBasicGrids({
                pair,
                topPrice,
                lowPrice,
                sellDisplacement,
                gridType: 'arithmetic',
                levels,
              })) ?? []
            const minigridBudget =
              (this.coinm ? qty : qty * price) *
              (settings.futures ? 1 : !long ? 2 - feeFactor : 1)
            const isActiveMinigrid =
              !!(
                useActiveMinigrids &&
                typeof comboActiveMinigrids !== 'undefined' &&
                i <= +comboActiveMinigrids
              ) && !(deal?.ignoreLevels ?? []).includes(i + 1)
            const grids =
              (await this.generateGridsOnPrice(
                {
                  pair,
                  initialGrids,
                  lowPrice,
                  topPrice,
                  levels,
                  updatedBudget: true,
                  _budget: minigridBudget,
                  _lastPrice: isActiveMinigrid
                    ? this.isLong
                      ? topPrice
                      : lowPrice
                    : price,
                  _initialPriceStart: isActiveMinigrid
                    ? this.isLong
                      ? topPrice
                      : lowPrice
                    : price,
                  _side:
                    ordersSide === 'BUY'
                      ? OrderSideEnum.buy
                      : OrderSideEnum.sell,
                  all: true,
                  profitCurrency: settings.futures
                    ? 'quote'
                    : (settings.profitCurrency ?? 'quote'),
                  orderFixedIn: settings.futures
                    ? settings.coinm
                      ? ('quote' as const)
                      : ('base' as const)
                    : settings.profitCurrency === 'quote'
                      ? ('base' as const)
                      : ('quote' as const),
                },
                !this.isLong,
                this.data.settings.newBalance,
                this.feeOrder,
                deal?.tags?.includes('newSell'),
              )) ?? []
            const useBase =
              (!deal && this.data.settings.newBalance) || deal?.newBalance
                ? long
                : deal?.settings.updatedComboAdjustments
                  ? long && settings.profitCurrency === 'base'
                  : long && settings.profitCurrency === 'quote'
            if (this.coinm) {
              const qtyByGrids = this.math.round(
                (grids.reduce(
                  (acc, v) =>
                    acc +
                    Math.max(
                      this.math.round(
                        (v.qty * v.price) / symbol.quoteAsset.minAmount,
                        0,
                        true,
                      ),
                      0,
                    ),
                  0,
                ) *
                  symbol.quoteAsset.minAmount) /
                  price,
                precision,
                false,
                true,
              )
              qty = qtyByGrids
            } else {
              const qtyByGrids =
                useBase || settings.futures
                  ? this.math.round(
                      grids.reduce((acc, v) => acc + v.qty, 0) *
                        (settings.futures ? 1 : 1 / (2 - feeFactor)),
                      precision,
                      false,
                      (deal?.flags ?? []).includes(
                        DCADealFlags.futuresPrecision,
                      )
                        ? !settings.futures
                        : true,
                    )
                  : this.math.round(
                      grids.reduce((acc, v) => acc + v.qty * v.price, 0),
                      ed.priceAssetPrecision,
                      false,
                      true,
                    )
              if (
                (useBase && qtyByGrids > qty) ||
                (!useBase && qtyByGrids > qty * price * (2 - feeFactor)) ||
                settings.futures
              ) {
                qty =
                  useBase || settings.futures
                    ? deal?.settings.updatedComboAdjustments
                      ? this.math.round(
                          qtyByGrids * (settings.futures ? 1 : feeFactor),
                          precision,
                          false,
                          (deal?.flags ?? []).includes(
                            DCADealFlags.futuresPrecision,
                          )
                            ? !settings.futures
                            : true,
                        )
                      : qtyByGrids
                    : this.math.round(
                        (qtyByGrids / price) *
                          (settings.futures ? 1 : feeFactor),
                        precision,
                        false,
                        true,
                      )
              }
            }
            orders.push({
              qty,
              price,
              side: ordersSide,
              newClientOrderId: this.getOrderId(`CMB-RO`),
              number: i,
              type: TypeOrderEnum.dealRegular,
              dealId,
              dcaLevel: i + 1,
              minigridBudget,
              hide: isActiveMinigrid,
            })
          }
        }
        const result = [...orders]

        return result
      }
      return []
    }
    override async createCurrentDealOrders(
      symbol: string,
      _price: number,
      initialOrders: Grid[],
      _avgPrice: number,
      _boPrice: number,
      dealId: string,
      all = false,
      deal?: CleanComboDealsSchema,
      _noCheck = true,
      _filterSl = true,
      addBase = false,
    ): Promise<Grid[]> {
      if (this.data && this.orders) {
        if (initialOrders.length > 0) {
          const settings = await this.getAggregatedSettings(deal)
          const activeOrders = settings.activeOrdersCount
          const useSmartOrders = settings.useSmartOrders
          const base = this.findBaseOrderByDeal(dealId)
          const orders = [
            ...initialOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ),
          ]
          if (addBase) {
            orders.push({
              number: 0,
              price: this.math.round(
                +(base?.price ?? '0'),
                (await this.getExchangeInfo(symbol))?.priceAssetPrecision ?? 8,
              ),
              side:
                base?.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
              newClientOrderId: this.getOrderId(`CMB-BO`),
              qty: this.math.round(
                +(base?.executedQty ?? '0'),
                await this.baseAssetPrecision(deal?.symbol.symbol ?? ''),
              ),
              type: TypeOrderEnum.dealStart,
              dealId,
              dcaLevel: 1,
              minigridId: base?.minigridId,
            })
          }
          let currentOrders: Grid[] = []
          const long = this.isLong
          if (long) {
            currentOrders = orders
              .filter(
                (o) =>
                  !o.hide && (o.dcaLevel ?? 0) > (deal?.lastFilledLevel ?? 0),
              )
              .sort((a, b) => b.price - a.price)
          }
          if (!long) {
            currentOrders = orders
              .filter(
                (o) =>
                  !o.hide && (o.dcaLevel ?? 0) > (deal?.lastFilledLevel ?? 0),
              )
              .sort((a, b) => a.price - b.price)
          }

          if (!all && useSmartOrders) {
            currentOrders = currentOrders.slice(
              0,
              (activeOrders ?? 0) > 0 ? activeOrders : 1,
            )
          }
          return [...currentOrders].map((o) => ({
            ...o,
            newClientOrderId: this.getOrderId(`CMB-RO`),
          }))
        }
      }
      return []
    }
    override async checkBalance(symbol: string) {
      const result = {
        status: true,
        required: 0,
        available: 0,
        price: 0,
      }
      if (
        this.data?.action &&
        this.data.action !== ActionsEnum.noAction &&
        this.data.action !== ActionsEnum.useBalance
      ) {
        this.handleDebug(`Balance check skipped. Action is ${this.data.action}`)
        return result
      }
      const settings = await this.getAggregatedSettings()
      if (settings.skipBalanceCheck) {
        this.handleDebug(`Balance check skipped`)
        return result
      }
      const ed = await this.getExchangeInfo(symbol)
      if (!ed) {
        return result
      }
      const ex = await this.getExchangeInfo(symbol)
      const balance = await this.checkAssets(true, true)
      const leverage = await this.getLeverageMultipler()
      const latestPrice = await this.getLatestPrice(symbol)
      if (latestPrice === 0) {
        this.handleDebug('Latest price is 0, bypass check balance')
        return result
      }
      const base = await this.getBaseOrder(
        symbol,
        undefined,
        undefined,
        latestPrice,
      )
      if (!base) {
        this.handleDebug('Cannot get base order, bypass check balance')
        return result
      }
      const initialGrids = await this.createInitialDealOrders(
        symbol,
        latestPrice,
        '',
      )
      const currentGrids = await this.createCurrentDealOrders(
        symbol,
        latestPrice,
        initialGrids,
        latestPrice,
        latestPrice,
        '',
        false,
        undefined,
        true,
      )
      const usedGrids = currentGrids.filter(
        (g) =>
          g.side === (this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell),
      )
      let additionalValue = 0
      if (this.useCompountReduce) {
        const settings = await this.getAggregatedSettings()
        const profit =
          (this.data?.profit.total ?? 0) /
          (settings.profitCurrency === 'base' ? 1 : +base.price)
        if (profit < 0 && settings.useRiskReduction) {
          additionalValue =
            profit * (+(settings.riskReductionValue ?? '50') / 100)
        }
        if (profit > 0 && settings.useReinvest) {
          additionalValue = profit * (+(settings.reinvestValue ?? '50') / 100)
        }
      }
      const requiredAmount = this.futures
        ? this.coinm
          ? currentGrids.reduce((acc, g) => acc + g.qty, 0) +
            +base.origQty +
            additionalValue
          : currentGrids.reduce((acc, g) => acc + g.qty * g.price, 0) +
            (+base.origQty + additionalValue) * +base.price
        : this.isLong
          ? usedGrids.reduce(
              (acc, g) =>
                acc +
                g.price * g.qty +
                (!ex
                  ? 0
                  : this.futures
                    ? 0
                    : ex.baseAsset.step *
                      +(this.data?.settings.gridLevel ?? '1')) *
                  g.price,
              0,
            ) +
            (+base.origQty + additionalValue) * +base.price +
            (!ex
              ? 0
              : this.futures
                ? 0
                : ex.baseAsset.step *
                  +(
                    this.data?.settings.baseGridLevels ||
                    this.data?.settings.gridLevel ||
                    '1'
                  )) *
              +base.price
          : usedGrids.reduce(
              (acc, g) =>
                acc +
                g.qty +
                (!ex
                  ? 0
                  : this.futures
                    ? 0
                    : ex.baseAsset.step *
                      +(this.data?.settings.gridLevel ?? '1')),
              0,
            ) +
            +base.origQty +
            additionalValue +
            (!ex
              ? 0
              : this.futures
                ? 0
                : ex.baseAsset.step *
                  +(
                    this.data?.settings.baseGridLevels ||
                    this.data?.settings.gridLevel ||
                    '1'
                  ))

      const available =
        (this.futures
          ? this.coinm
            ? (balance?.get(ed.baseAsset.name)?.free ?? 0)
            : (balance?.get(ed.quoteAsset.name)?.free ?? 0)
          : this.isLong
            ? (balance?.get(ed.quoteAsset.name)?.free ?? 0)
            : balance?.get(ed.baseAsset.name)?.free) ?? 0
      if (requiredAmount / leverage > available) {
        return {
          status: false,
          required: requiredAmount / leverage,
          available,
          price: latestPrice,
        }
      }
      return result
    }

    override async afterUpdateExchangeInfo(pairs: Set<string>): Promise<void> {
      const oldPrecisions = new Map([...this.precisions.entries()])
      await super.afterUpdateExchangeInfo(pairs)
      let updateMinigrids = false
      for (const o of pairs) {
        const newData = await this.getExchangeInfo(o)
        const getOld = oldPrecisions.get(o)
        if (
          newData &&
          typeof getOld !== 'undefined' &&
          newData.priceAssetPrecision < getOld
        ) {
          const mingrids = this.allMinigrids.filter(
            (m) => m.schema.symbol.symbol === o,
          )
          updateMinigrids = !!mingrids.length
          for (const m of mingrids) {
            m.currentOrders = m.currentOrders.map((co) => {
              co.price = this.math.round(co.price, newData.priceAssetPrecision)
              return co
            })
            m.initialGrids = m.initialGrids.map((io) => {
              io.price = {
                buy: this.math.round(io.price.buy, newData.priceAssetPrecision),
                sell: this.math.round(
                  io.price.sell,
                  newData.priceAssetPrecision,
                ),
              }
              return io
            })
            this.setMinigrid(m, false)
          }
        }
        if (updateMinigrids) {
          this.saveMinigridToRedis(this.botId, false)
        }
      }
    }

    override async getBaseOrder(
      symbol: string,
      dealId?: string,
      _forceMarket?: boolean,
      _inputPrice?: number,
      count = 0,
      _fixSize = 0,
      sizes?: Sizes | null,
    ) {
      const fee = await this.getUserFee(symbol)
      const ed = await this.getExchangeInfo(symbol)
      if (this.data && this.exchange && ed && fee) {
        const settings = await this.getAggregatedSettings()
        const { orderSizeType } = settings
        const baseOrderSize = +(settings.baseOrderSize ?? '0')
        const precision = await this.baseAssetPrecision(symbol)
        const priceRequest = await this.getLatestPrice(symbol)
        if (priceRequest === 0) {
          this.handleDebug('Get latest price. Latest price = 0. getBaseOrder')
          return
        }
        const slippage = count === 0 ? 0 : 0.01 * (1 + count / 10)
        let price = priceRequest * (1 - slippage * (this.isLong ? 1 : -1))
        price = this.math.round(price, ed.priceAssetPrecision)
        const feeFactor = this.futures ? 1 : 1 + fee.taker
        let qty = this.math.round(
          (baseOrderSize / price) * feeFactor + (sizes?.base ?? 0),
          precision,
          true,
        )
        if (orderSizeType === OrderSizeTypeEnum.base) {
          qty = this.math.round(
            baseOrderSize * feeFactor + (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (orderSizeType === OrderSizeTypeEnum.usd) {
          qty = this.math.round(
            (baseOrderSize * feeFactor) /
              ((await this.getUsdRate(symbol, 'quote')) * price) +
              (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (orderSizeType === OrderSizeTypeEnum.quote && this.coinm) {
          qty = this.math.round(
            (baseOrderSize * ed.quoteAsset.minAmount) / price +
              (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (
          orderSizeType === OrderSizeTypeEnum.percFree ||
          orderSizeType === OrderSizeTypeEnum.percTotal
        ) {
          const balances = await this.getBalancesFromExchange()
          if (balances && balances.status === StatusEnum.ok) {
            const long = this.isLong
            const asset = this.futures
              ? this.coinm
                ? ed.baseAsset.name
                : ed.quoteAsset.name
              : long
                ? ed.quoteAsset.name
                : ed.baseAsset.name
            const find = balances.data.find((b) => b.asset === asset)
            if (find) {
              let useQty =
                orderSizeType === OrderSizeTypeEnum.percFree
                  ? find.free
                  : find.free + find.locked
              if (dealId) {
                if (this.shouldProceed()) {
                  await this.dealsDb.updateData({ _id: `${dealId}` } as any, {
                    $set: { balanceStart: useQty },
                  })
                }

                const findDeal = this.getDeal(`${dealId}`)
                if (findDeal) {
                  findDeal.deal.balanceStart = useQty
                  this.saveDeal(findDeal, {
                    balanceStart: findDeal.deal.balanceStart,
                  })
                }
              }
              useQty = useQty * (baseOrderSize / 100)
              if (this.futures) {
                useQty *= await this.getLeverageMultipler(
                  this.getDeal(dealId)?.deal,
                )
              }
              qty = this.math.round(
                (this.futures
                  ? this.coinm
                    ? useQty
                    : useQty / priceRequest
                  : long
                    ? useQty / priceRequest
                    : useQty) * (baseOrderSize === 100 ? 1 : feeFactor),
                precision,
                true,
              )
            } else {
              return this.handleErrors(
                `Asset ${asset} not found in user balances`,
                'placeBaseOrder',
              )
            }
          } else {
            return this.handleErrors(
              `Error getting balance: ${balances?.reason}`,
              'placeBaseOrder',
            )
          }
        }
        if (qty < ed.baseAsset.minAmount) {
          qty = this.math.round(
            ed.baseAsset.minAmount * feeFactor,
            precision,
            false,
            true,
          )
        }
        if (qty * price < ed.quoteAsset.minAmount) {
          qty = this.math.round(
            (ed.quoteAsset.minAmount / price) * feeFactor,
            precision,
            false,
            true,
          )
        }
        if (this.coinm && !this.isBitget) {
          const cont = (price * qty) / ed.quoteAsset.minAmount
          if (cont < 1) {
            qty = this.math.round(
              ed.quoteAsset.minAmount / price,
              precision,
              false,
              true,
            )
          } else if (cont % 1 > Number.EPSILON) {
            qty = this.math.round(
              (this.math.round(cont, 0) * ed.quoteAsset.minAmount) / price,
              precision,
              false,
              true,
            )
          }
        }
        try {
          const mod = +new Big(qty).mod(ed.baseAsset.step).toFixed(20)
          if (mod !== 0) {
            qty = this.math.round(
              qty - mod + ed.baseAsset.step,
              precision,
              false,
              true,
            )
          }
        } catch (e) {
          this.handleErrors(
            `Big number error ${(e as Error).message || e}`,
            'getBaseOrder',
            '',
            false,
            false,
            false,
          )
        }
        const baseId = this.getOrderId(`CMB-BO`)
        qty = this.math.round(qty, precision)
        const baseOrder: Order = {
          clientOrderId: baseId,
          status: 'NEW',
          executedQty: '0',
          price: `${price}`,
          origPrice: `${price}`,
          cummulativeQuoteQty: `${price * qty}`,
          orderId: '-1',
          origQty: `${qty}`,
          side: this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell,
          symbol,
          type: OrderTypeEnum.market,
          updateTime: new Date().getTime(),
          transactTime: new Date().getTime(),
          exchange: this.data.exchange,
          exchangeUUID: this.data.exchangeUUID,
          typeOrder: TypeOrderEnum.dealStart,
          botId: this.botId,
          userId: this.userId,
          dealId,
          fills: [],
          baseAsset: ed.baseAsset.name,
          quoteAsset: ed.quoteAsset.name,
          positionSide: this.hedge
            ? this.isLong
              ? PositionSide.LONG
              : PositionSide.SHORT
            : PositionSide.BOTH,
          dcaLevel: 1,
        }
        const pair = symbol

        const topPrice = this.isLong
          ? price * (1 + +(settings.baseStep ?? settings.step ?? '0') / 100)
          : price
        const lowPrice = this.isLong
          ? price
          : price * (1 - +(settings.baseStep ?? settings.step ?? '0') / 100)
        const levels = Math.floor(
          +(settings.baseGridLevels ?? settings.gridLevel ?? '1'),
        )
        const sellDisplacement = fee.maker * 2
        const initialGrids =
          (await this.generateBasicGrids({
            pair,
            topPrice,
            lowPrice,
            sellDisplacement,
            gridType: 'arithmetic',
            levels,
          })) ?? []
        baseOrder.minigridBudget =
          +(this.coinm
            ? +baseOrder.origQty
            : +baseOrder.price * +baseOrder.origQty || '0') *
          (settings.futures ? 1 : !this.isLong ? 2 - feeFactor : 1)
        const findDeal = this.getDeal(dealId)
        const grids =
          (await this.generateGridsOnPrice(
            {
              pair,
              initialGrids,
              lowPrice,
              topPrice,
              levels,
              updatedBudget: true,
              _budget: baseOrder.minigridBudget,
              _lastPrice: price,
              _initialPriceStart: price,
              _side:
                baseOrder.side === 'BUY'
                  ? OrderSideEnum.buy
                  : OrderSideEnum.sell,
              all: true,
              profitCurrency: settings.futures
                ? 'quote'
                : (settings.profitCurrency ?? 'quote'),
              orderFixedIn: settings.futures
                ? settings.coinm
                  ? ('quote' as const)
                  : ('base' as const)
                : settings.profitCurrency === 'quote'
                  ? ('base' as const)
                  : ('quote' as const),
            },
            !this.isLong,
            this.data?.settings.newBalance,
            this.feeOrder,
            findDeal?.deal.tags?.includes('newSell'),
          )) ?? []
        const useBase =
          (!findDeal && this.data.settings.newBalance) ||
          findDeal?.deal.newBalance
            ? this.isLong
            : findDeal?.deal?.settings.updatedComboAdjustments
              ? this.isLong && settings.profitCurrency === 'base'
              : this.isLong && settings.profitCurrency === 'quote'
        if (this.coinm && !this.isBitget) {
          const ed = await this.getExchangeInfo(symbol)
          const qtyByGrids = this.math.round(
            (grids.reduce(
              (acc, v) =>
                acc +
                Math.max(
                  this.math.round(
                    (v.qty * v.price) / (ed?.quoteAsset.minAmount ?? 1),
                    0,
                    true,
                  ),
                  0,
                ),
              0,
            ) *
              (ed?.quoteAsset.minAmount ?? 1)) /
              price,
            precision,
          )
          baseOrder.origQty = `${qtyByGrids}`
          baseOrder.cummulativeQuoteQty = `${price * qtyByGrids}`
        } else {
          const qtyByGrids =
            useBase || settings.futures
              ? this.math.round(
                  grids.reduce((acc, v) => acc + v.qty, 0) *
                    (settings.futures ? 1 : 1 / (2 - feeFactor)),
                  precision,
                  false,
                  (findDeal?.deal.flags ?? []).includes(
                    DCADealFlags.futuresPrecision,
                  )
                    ? !settings.futures
                    : true,
                )
              : this.math.round(
                  grids.reduce((acc, v) => acc + v.qty * v.price, 0),
                  ed.priceAssetPrecision,
                  false,
                  true,
                )
          if (
            (useBase && qtyByGrids > qty) ||
            (!useBase &&
              qtyByGrids >
                +baseOrder.origQty * +baseOrder.price * (2 - feeFactor)) ||
            settings.futures
          ) {
            baseOrder.origQty = `${
              useBase || settings.futures
                ? findDeal?.deal?.settings.updatedComboAdjustments
                  ? this.math.round(
                      qtyByGrids * feeFactor,
                      precision,
                      false,
                      (findDeal?.deal.flags ?? []).includes(
                        DCADealFlags.futuresPrecision,
                      )
                        ? !settings.futures
                        : true,
                    )
                  : qtyByGrids
                : this.math.round(
                    (qtyByGrids / +baseOrder.price) * feeFactor,
                    precision,
                    false,
                    true,
                  )
            }`
            baseOrder.cummulativeQuoteQty = `${price * +baseOrder.origQty}`
          }
        }
        return baseOrder
      }
    }
    override async createDeal(
      symbol: string,
      _fixSl = 0,
      _fixTp = 0,
      _fixSize = 0,
      _dynamicAr: DynamicArPrices[] = [],
      sizes?: Sizes | null,
    ): Promise<string | undefined> {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('create deal'))
        return
      }
      const _id = this.startMethod('createDeal')
      const time = new Date().getTime()
      let symbolData: Symbols | undefined
      try {
        const ed = await this.getExchangeInfo(symbol)
        if (!ed) {
          this.handleWarn(`Cannot create deal for ${symbol}. ED not found`)
          this.endMethod(_id)
          return
        }
        symbolData = {
          symbol: ed.pair,
          baseAsset: ed.baseAsset.name,
          quoteAsset: ed.quoteAsset.name,
        }
      } catch (e) {
        this.handleWarn(
          `Cannot create deal for ${symbol}. Catch error in reading exchange data: ${
            (e as Error)?.message ?? e
          }`,
        )
        this.endMethod(_id)
        return
      }
      if (!symbolData) {
        this.handleWarn(
          `Cannot create deal for ${symbol}. Symbol data not found. Data size ${this.data?.symbol?.size}`,
        )
        this.endMethod(_id)
        return
      }
      const dealSettings = this.getInitalDealSettings()
      if (this.data && symbolData && dealSettings) {
        const flags: DCADealFlags[] = [DCADealFlags.futuresPrecision]
        if (this.data.flags?.includes(BotFlags.externalSl)) {
          flags.push(DCADealFlags.externalSl)
        }
        if (this.data.flags?.includes(BotFlags.externalTp)) {
          flags.push(DCADealFlags.externalTp)
        }
        const record = await this.dealsDb.createData({
          botId: this.botId,
          userId: this.userId,
          status: DCADealStatusEnum.start,
          initialBalances: {
            base: 0,
            quote: 0,
          },
          currentBalances: {
            base: 0,
            quote: 0,
          },
          initialPrice: 0,
          avgPrice: 0,
          displayAvg: 0,
          profit: {
            total: 0,
            totalUsd: 0,
            pureBase: 0,
            pureQuote: 0,
            gridProfit: 0,
            gridProfitUsd: 0,
          },
          feePaid: {
            base: 0,
            quote: 0,
          },
          lastPrice: 0,
          commission: 0,
          createTime: time,
          updateTime: time,
          levels: {
            all: this.data.settings.useDca
              ? this.data.settings.ordersCount +
                1 -
                (this.data.settings.useActiveMinigrids
                  ? +(this.data.settings.comboActiveMinigrids ?? '0')
                  : 0)
              : 1,
            complete: 0,
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
          },
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
          settings: {
            ...dealSettings,
            updatedComboAdjustments:
              (dealSettings.orderSizeType === OrderSizeTypeEnum.percFree ||
                dealSettings.orderSizeType === OrderSizeTypeEnum.percTotal) &&
              (dealSettings.coinm || dealSettings.profitCurrency === 'base')
                ? true
                : undefined,
          },
          parentId: null,
          childIds: [],
          parent: false,
          child: false,
          gridBreakpoints: [],
          paperContext: this.data.paperContext,
          type: this.data.settings.type,
          symbol: symbolData,
          exchange: this.data.exchange,
          exchangeUUID: this.data.exchangeUUID,
          strategy: this.data.settings.strategy,
          stats: {
            drawdownPercent: 0,
            runUpPercent: 0,
            timeInProfit: 0,
            timeInLoss: 0,
            trackTime: 0,
            timeCountStart: Date.now(),
          },
          lastFilledLevel: 0,
          totalAssetAmount: 0,
          newBalance: true,
          transactions: {
            buy: 0,
            sell: 0,
          },
          sizes: sizes || undefined,
          tags: ['newSell'],
          flags,
          parentBotId: this.data.parentBotId,
          action: this.data.settings.futures ? undefined : this.data.action,
        } as any)
        if (record.status === StatusEnum.notok) {
          this.handleErrors(
            `Cannot create deal: ${record.reason}`,
            'createDeal()',
            'create deal',
          )
          this.endMethod(_id)
          return
        }
        const dealId = `${record.data._id}`
        this.handleLog(`Deal created with id ${dealId}`)
        this.setDeal({
          deal: { ...record.data, _id: dealId },
          initialOrders: [],
          currentOrders: [],
          previousOrders: [],
          closeBySl: false,
          notCheckSl: false,
          closeByTp: false,
        })
        this.resetPending(this.botId, symbol)
        this.emit('bot deal update', record.data)
        await this.updateBotDeals(this.botId, true)
        this.endMethod(_id)
        return dealId
      }
      this.handleWarn(
        `Cannot create deal for ${symbol}, data: ${!!this
          .data}, symbolData: ${!!symbolData}, dealSettings: ${!!dealSettings}`,
      )
      this.endMethod(_id)
      return
    }

    @IdMute(
      mutex,
      (botId: string, symbol: string) => `${botId}placeBaseOrder${symbol}`,
    )
    override async placeBaseOrder(
      _botId: string,
      symbol: string,
      oldDealId?: string,
      forceMarket = false,
      cancelPending = false,
      count = 0,
      _fixSl = 0,
      _fixTp = 0,
      _fixSize = 0,
      _dynamicAr: DynamicArPrices[] = [],
      sizes?: Sizes | null,
    ) {
      const _id = this.startMethod('placeBaseOrder')
      let dealId: string | undefined
      if (!oldDealId) {
        this.handleLog('Create new deal')
        dealId = await this.createDeal(
          symbol,
          _fixSl,
          _fixTp,
          _fixSize,
          _dynamicAr,
          sizes,
        )
        if (!dealId) {
          this.resetPending(this.botId, symbol)
          this.endMethod(_id)
          return this.handleErrors(
            `Cannot create deal for ${symbol}`,
            'placeBaseOrder',
            '',
            false,
          )
        }
      }
      if (oldDealId) {
        dealId = oldDealId
      }
      if (cancelPending) {
        for (const order of this.getOrdersByStatusAndDealId({
          status: 'NEW',
          dealId,
        }).filter((o) => o.typeOrder === TypeOrderEnum.dealStart)) {
          const o = await this.cancelOrderOnExchange(order)
          if (o?.status === 'FILLED') {
            this.endMethod(_id)
            return this.handleUnknownOrder(o)
          }
        }
      }
      const currentBase = this.getOrdersByStatusAndDealId({
        status: ['NEW', 'PARTIALLY_FILLED'],
        dealId,
      }).find((o) => o.typeOrder === TypeOrderEnum.dealStart)
      if (currentBase) {
        this.endMethod(_id)
        return this.handleDebug(
          `Deal ${dealId} already have and active start order`,
        )
      }
      if (this.data && this.exchange) {
        const baseOrder = await this.getBaseOrder(
          symbol,
          dealId,
          forceMarket,
          undefined,
          count,
          _fixSize,
          sizes,
        )
        if (forceMarket && sizes && this.useCompountReduce && baseOrder) {
          const deal = this.getDeal(dealId)
          if (deal && deal.deal.sizes) {
            deal.deal.sizes.origBase = +baseOrder.origQty + deal.deal.sizes.base
            this.saveDeal(deal, { sizes: deal.deal.sizes })
          }
        }
        if (baseOrder) {
          this.updateDealLastPrices(this.botId, {
            symbol,
            entry: +baseOrder.price,
            avg: +baseOrder.price,
            time: this.getDeal(dealId)?.deal.createTime,
          })
          if (!this.data.settings.futures) {
            if (this.data?.action) {
              this.db?.updateData(
                { _id: this.botId },
                { $unset: { action: null } },
              )
              this.data.action = undefined
            }
            if (!oldDealId && dealId) {
              const deal = this.getDeal(dealId)
              if (!deal) {
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                return this.handleErrors(
                  `Cannot find deal ${dealId} after creation`,
                  'placeBaseOrder',
                  '',
                  false,
                  false,
                  false,
                )
              }
              if (
                deal.deal.action &&
                deal.deal.action !== ActionsEnum.useBalance
              ) {
                if (deal.deal.action === ActionsEnum.noAction) {
                  this.resetPending(this.botId, symbol)
                  this.endMethod(_id)
                  return this.handleErrors(
                    `Cannot place base order. Action is noAction`,
                    'placeBaseOrder',
                  )
                }
                let proceedBaseOrder = false
                if (
                  [
                    ActionsEnum.buyDiff,
                    ActionsEnum.buyForAll,
                    ActionsEnum.sellDiff,
                    ActionsEnum.sellForAll,
                  ].includes(deal.deal.action) &&
                  deal.deal.settings.useDca
                ) {
                  this.handleDebug(`Action ${deal.deal.action} detected`)
                  const lp = await this.getLatestPrice(symbol)
                  const orders = await this.createInitialDealOrders(
                    symbol,
                    lp,
                    dealId,
                    deal.deal,
                  )
                  const required = this.isLong
                    ? orders.reduce((acc, v) => acc + v.qty * v.price, 0) / lp
                    : orders.reduce((acc, v) => acc + v.qty, 0) * lp
                  this.handleDebug(
                    `Required amount for ${deal.deal.action} is ${required}, price is ${lp}`,
                  )
                  const ei = await this.getExchangeInfo(symbol)
                  const balance =
                    (await this.checkAssets(true, true))?.get(
                      (this.isLong
                        ? ei?.baseAsset.name
                        : ei?.quoteAsset.name) ?? '',
                    )?.free ?? 0
                  this.handleDebug(`Available balance is ${balance}`)
                  const orderSize = [
                    ActionsEnum.buyDiff,
                    ActionsEnum.sellDiff,
                  ].includes(deal.deal.action)
                    ? required - balance
                    : required
                  this.handleDebug(`Order size is ${orderSize}`)
                  if (orderSize > 0) {
                    const price = `${this.math.round(
                      lp,
                      ei?.priceAssetPrecision,
                    )}`
                    const qty = `${this.math.round(
                      orderSize * (this.isLong ? 1 : 1 / lp),
                      await this.baseAssetPrecision(symbol),
                    )}`
                    const r = await this.sendOrderToExchange(
                      {
                        clientOrderId: this.getOrderId('CMB-H'),
                        status: 'NEW',
                        executedQty: '0',
                        price: price,
                        origPrice: price,
                        cummulativeQuoteQty: `${+price * +qty}`,
                        orderId: '-1',
                        origQty: `${qty}`,
                        side: this.isLong
                          ? OrderSideEnum.sell
                          : OrderSideEnum.buy,
                        symbol,
                        type: OrderTypeEnum.market,
                        updateTime: new Date().getTime(),
                        transactTime: new Date().getTime(),
                        exchange: this.data.exchange,
                        exchangeUUID: this.data.exchangeUUID,
                        typeOrder: TypeOrderEnum.dealStart,
                        botId: this.botId,
                        userId: this.userId,
                        dealId,
                        fills: [],
                        baseAsset: ei?.baseAsset.name ?? '',
                        quoteAsset: ei?.quoteAsset.name ?? '',
                      },
                      true,
                    )
                    if (typeof r === 'string') {
                      this.endMethod(_id)
                      return this.handleErrors(
                        `Error placing order: ${r}`,
                        'placeBaseOrder',
                        '',
                        false,
                        false,
                        false,
                      )
                    }
                    if (!r) {
                      this.endMethod(_id)
                      return this.handleErrors(
                        `Error placing order`,
                        'placeBaseOrder',
                        '',
                        false,
                        false,
                        false,
                      )
                    }
                    this.handleDebug(`Order ${r.clientOrderId} filled`)
                  }
                  proceedBaseOrder = true
                }
                if (deal.deal.action === ActionsEnum.useOppositeBalance) {
                  this.handleDebug(`Action ${deal.deal.action} detected`)
                  proceedBaseOrder = true
                }
                if (proceedBaseOrder) {
                  baseOrder.status = 'FILLED'
                  baseOrder.executedQty = baseOrder.origQty
                  this.setOrder(baseOrder)
                  this.ordersDb.createData(baseOrder)
                  this.endMethod(_id)
                  return this.startDeal(baseOrder)
                }
              }
            }
          }
          this.handleLog('Send base order')
          const result = await this.sendOrderToExchange(
            {
              ...baseOrder,
              type:
                count === this.slippageRetry
                  ? OrderTypeEnum.limit
                  : OrderTypeEnum.market,
            },
            true,
          )
          if (result) {
            if (typeof result === 'string') {
              if (
                (result.indexOf('NOTIONAL') !== -1 ||
                  result.indexOf("Order's notional")) !== -1 &&
                count < this.slippageRetry
              ) {
                this.handleDebug(
                  `Cannot place base order due to slippage ${
                    baseOrder.clientOrderId
                  }, attempt ${count + 1}`,
                )
                await sleep(250)
                this.placeBaseOrder(
                  this.botId,
                  symbol,
                  dealId,
                  forceMarket,
                  cancelPending,
                  count + 1,
                )
              } else {
                this.handleOrderErrors(
                  result,
                  baseOrder,
                  'limitOrders()',
                  `Send new order request ${baseOrder.clientOrderId}, qty ${baseOrder.origQty}, price ${baseOrder.price}, side ${baseOrder.side}`,
                )
              }
            } else if (result.status === 'FILLED') {
              await this.startDeal(result)
            } else {
              if (baseOrder.clientOrderId !== result.clientOrderId) {
                baseOrder.clientOrderId = result.clientOrderId
              }
            }
          }
        }
      }
      this.endMethod(_id)
    }

    @IdMute(mutex, (botId: string) => `${botId}newDeal`)
    override async openNewDeal(
      _botId: string,
      symbol: string,
      skip = false,
      dynamic = false,
      time = 0,
      cbIfNotOpened?: () => void,
    ) {
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.openNewDeal.bind(this)(
            this.botId,
            symbol,
            skip,
            dynamic,
            time,
            cbIfNotOpened,
          ),
        )
        return this.handleDebug('Loading not complete yet')
      }
      if (!skip && this.data?.status === BotStatusEnum.monitoring) {
        this.handleDebug('Bot is in monitoring mode. Wont open new deal')
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
        return
      }
      const _id = this.startMethod('openNewDeal')
      const settings = await this.getAggregatedSettings()
      const t = this.openNewDealTimer.get(symbol)
      if (t) {
        clearTimeout(t)
        this.openNewDealTimer.delete(symbol)
      }
      if (!this.pairs.has(symbol)) {
        this.unsubscribeFromExchangeInfo(symbol)
        this.unsubscribeFromUserFee(symbol)
        this.endMethod(_id)
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
        return this.handleDebug(`Bot settings does not contain ${symbol}`)
      }
      const ed = await this.getExchangeInfo(symbol)
      const skipRange = skip && !dynamic
      if (await this.checkMaxDeals(this.botId, symbol)) {
        this.handleLog('Open new deal')
        if (this.data && ed) {
          const activeOrders = await this.getActiveOrders(symbol)
          const thisActiveOrders =
            +(this.data.settings.comboActiveMinigrids ?? '0') *
              +(this.data.settings.gridLevel ?? '0') +
            +(
              this.data.settings.baseGridLevels ??
              this.data.settings.gridLevel ??
              '0'
            ) +
            (this.data.settings.useSmartOrders
              ? +this.data.settings.activeOrdersCount
              : this.data.settings.ordersCount)
          if (activeOrders + thisActiveOrders > ed.maxOrders) {
            this.loadingComplete = true
            this.endMethod(_id)
            return this.handleErrors(
              `Deal cannot start due to max amout of orders on this symbol.\nMax amount - ${
                ed?.maxOrders || 0
              }, active orders - ${activeOrders}, this deal orders - ${thisActiveOrders}`,
              'start()',
            )
          }
        }
        if (
          ed &&
          (skipRange || (await this.checkInRange(symbol))) &&
          this.data?.status !== BotStatusEnum.closed
        ) {
          let checkBalance = await this.checkBalance(symbol)
          if (!checkBalance.status) {
            this.handleDebug(
              `Not enough balance to start new deal. Required: ${checkBalance.required}, available: ${checkBalance.available}, repeat check in 5 seconds`,
            )
            await sleep(5000)
            checkBalance = await this.checkBalance(symbol)
          }
          if (checkBalance.status) {
            if (!(skip && !dynamic)) {
              const cooldownStart = await this.checkCooldownStart(
                this.botId,
                symbol,
              )
              if (!cooldownStart.status) {
                this.handleDebug(
                  `Deal must wait because of cooldown start check. Time: ${cooldownStart.time}, last opened: ${cooldownStart.last}, diff: ${cooldownStart.diff}, cooldown: ${cooldownStart.cooldown} ${symbol} ${settings.cooldownAfterDealStartOption}`,
                )
                this.resetPending(this.botId, symbol)
                if (settings.startCondition === StartConditionEnum.asap) {
                  this.openNewDealTimer.set(
                    symbol,
                    setTimeout(
                      () => this.openDealAfterTimer(),
                      cooldownStart.last +
                        cooldownStart.cooldown -
                        +new Date() -
                        1,
                    ),
                  )
                }
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
              const cooldownStop = await this.checkCooldownStop(
                this.botId,
                symbol,
              )
              if (!cooldownStop.status) {
                this.handleDebug(
                  `Deal must wait because of cooldown stop check. Time: ${cooldownStop.time}, last closed: ${cooldownStop.last}, diff: ${cooldownStop.diff}, cooldown: ${cooldownStop.cooldown} ${symbol} ${settings.cooldownAfterDealStartOption}`,
                )
                if (settings.startCondition === StartConditionEnum.asap) {
                  this.openNewDealTimer.set(
                    symbol,
                    setTimeout(
                      () => this.openDealAfterTimer(),
                      cooldownStop.last +
                        cooldownStop.cooldown -
                        +new Date() -
                        1,
                    ),
                  )
                }
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
            }
            this.updateDealLastTime(this.botId, 'opened', +new Date(), symbol)
            let sizes: Sizes | undefined | null
            if (this.useCompountReduce) {
              sizes = await this.calculateCompoundReduce(symbol)
            }
            await this.placeBaseOrder(
              this.botId,
              symbol,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              sizes,
            )
          } else {
            const asset = this.futures
              ? this.coinm
                ? ed.baseAsset.name
                : ed.quoteAsset.name
              : this.isLong
                ? ed.quoteAsset.name
                : ed.baseAsset.name
            const msg = `Not enough balance to start new deal required: ${
              checkBalance.required
            } ${asset}, available: ${checkBalance.available} ${asset}${
              checkBalance.price
                ? `, price: ${checkBalance.price} ${ed.quoteAsset.name}`
                : ''
            }`
            this.handleErrors(msg, 'openNewDeal', '', false, true)
            this.resetPending(this.botId, symbol)
            if (cbIfNotOpened) {
              cbIfNotOpened()
            }
          }
        } else {
          if (cbIfNotOpened) {
            cbIfNotOpened()
          }
          this.resetPending(this.botId, symbol)
        }
      }
      this.endMethod(_id)
    }

    private getActiveMinigrids() {
      return this.allMinigrids.filter(
        (m) => m.schema.status !== ComboMinigridStatusEnum.closed,
      )
    }
    private async checkMinigridRange(price: number, symbol: string) {
      for (const m of this.getActiveMinigrids().filter(
        (s) => s.schema.symbol.symbol === symbol,
      )) {
        if (
          (price > m.schema.settings.topPrice ||
            price < m.schema.settings.lowPrice) &&
          m.schema.status === ComboMinigridStatusEnum.active
        ) {
          m.schema.status = ComboMinigridStatusEnum.range
          this.saveMinigrid(m, { status: m.schema.status })
        }
        if (
          price <= m.schema.settings.topPrice &&
          price >= m.schema.settings.lowPrice &&
          m.schema.status === ComboMinigridStatusEnum.range
        ) {
          m.schema.status = ComboMinigridStatusEnum.active
          this.saveMinigrid(m, { status: m.schema.status })
        }
      }
    }

    override async isDealForStopLoss(
      d: FullDeal<ExcludeDoc<ComboDealsSchema>>,
    ) {
      const { useSl, useTp } = await this.getAggregatedSettings(d.deal)
      return (
        (useSl && !this.data?.flags?.includes(BotFlags.externalSl)) ||
        (useTp && !this.data?.flags?.includes(BotFlags.externalTp))
      )
    }
    override async checkDealsAllowedMethods() {
      const deals = this.getOpenDeals()
      let count = 0
      let countDCALevelCheck = 0
      for (const d of deals) {
        if (await this.isDealForStopLoss(d)) {
          count++
        }
        if (this.isDealForDCALevelCheck(d)) {
          countDCALevelCheck++
        }
      }
      if (deals.length && count) {
        this.allowedMethods.add('checkDealsStopLoss')
      } else {
        this.allowedMethods.delete('checkDealsStopLoss')
      }

      if (deals.length && countDCALevelCheck) {
        this.allowedMethods.add('checkDCALevel')
      } else {
        this.allowedMethods.delete('checkDCALevel')
      }

      this.handleDebug(
        `Check deals allowed methods: ${[...this.allowedMethods].join(', ')}`,
      )
      await this.checkDealsForStopLossMethods()
      this.checkDealsPriceExtremum()
    }
    async triggerStopLossCombo(
      dealId: string,
      sl: boolean,
      tp: boolean,
    ): Promise<void> {
      const d = this.getDeal(dealId)
      if (!d) {
        this.handleErrors(
          `Cannot find deal in trigger stop loss`,
          'triggerMoveSl',
          '',
          false,
          false,
          false,
        )
        return
      }
      const { comboSlLimit, comboTpLimit } = await this.getAggregatedSettings(
        d.deal,
      )
      d.closeBySl = true
      d.notCheckSl = true
      this.saveDeal(d)
      this.closeDealById(
        this.botId,
        dealId,
        sl
          ? comboSlLimit
            ? CloseDCATypeEnum.closeByLimit
            : CloseDCATypeEnum.closeByMarket
          : tp
            ? comboTpLimit
              ? CloseDCATypeEnum.closeByLimit
              : CloseDCATypeEnum.closeByMarket
            : CloseDCATypeEnum.closeByMarket,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sl,
      )
    }
    async claculateTpSlFromPrice(
      d: FullDeal<CleanComboDealsSchema>,
      price: number,
    ) {
      const profitBase = await this.profitBase(d.deal)
      const qty = this.isLong
        ? d.deal.currentBalances.base
        : d.deal.initialBalances.base - d.deal.currentBalances.base
      const quote =
        (this.isLong
          ? d.deal.initialBalances.quote - d.deal.currentBalances.quote
          : d.deal.currentBalances.quote) +
        (profitBase ? 0 : d.deal.profit.total * (this.isLong ? 1 : -1))
      const quoteTp = qty * price
      const base =
        quote / price +
        (profitBase ? d.deal.profit.total * (this.isLong ? 1 : -1) : 0)
      const fee = (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0
      const total =
        d.deal.profit.total +
        (profitBase ? qty - base : quoteTp - quote) * (this.isLong ? 1 : -1) -
        (d.deal.fullFee ?? 0) -
        (profitBase ? qty * fee : quoteTp * fee)
      const comboBasedOn = await this.comboBasedOn(d.deal)
      const usageBase =
        comboBasedOn === ComboTpBase.full
          ? d.deal.usage.max.base
          : d.deal.usage.current.base
      const usageQuote =
        comboBasedOn === ComboTpBase.full
          ? d.deal.usage.max.quote
          : d.deal.usage.current.quote
      const { avgPrice } = await this.getAggregatedSettings(d.deal)
      const avgToUse = d.deal.avgPrice || (avgPrice ?? d.deal.avgPrice)
      const denominator = this.futures
        ? this.coinm
          ? usageBase
          : usageQuote
        : this.isLong
          ? usageQuote * (profitBase ? 1 / avgToUse : 1)
          : usageBase * (profitBase ? 1 : avgToUse)
      const perc = total / denominator
      return perc
    }
    async getDealStopLossPriceCombo(
      d: FullDeal<CleanComboDealsSchema>,
    ): Promise<DealStopLossCombo> {
      const { avgPrice, slPerc, tpPerc, useTp, useSl } =
        await this.getAggregatedSettings(d.deal)
      const tpToUse = +(tpPerc ?? '0') / 100
      const slToUse = +(slPerc ?? '0') / 100
      let tp: number | null = null
      let sl: number | null = null
      const profitBase = await this.profitBase(d.deal)
      const longMult = this.isLong ? 1 : -1
      const qty = this.isLong
        ? d.deal.currentBalances.base
        : d.deal.initialBalances.base - d.deal.currentBalances.base
      const quote =
        (this.isLong
          ? d.deal.initialBalances.quote - d.deal.currentBalances.quote
          : d.deal.currentBalances.quote) +
        (profitBase ? 0 : d.deal.profit.total * longMult)
      const fee = (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0
      const comboBasedOn = await this.comboBasedOn(d.deal)
      const usageBase =
        comboBasedOn === ComboTpBase.full
          ? d.deal.usage.max.base
          : d.deal.usage.current.base
      const usageQuote =
        comboBasedOn === ComboTpBase.full
          ? d.deal.usage.max.quote
          : d.deal.usage.current.quote
      const avgToUse = d.deal.avgPrice || (avgPrice ?? d.deal.avgPrice)
      const denominator = this.futures
        ? this.coinm
          ? usageBase
          : usageQuote
        : this.isLong
          ? usageQuote * (profitBase ? 1 / avgToUse : 1)
          : usageBase * (profitBase ? 1 : avgToUse)
      const quoteTp = qty * d.deal.initialPrice
      const base =
        quote / d.deal.initialPrice +
        (profitBase ? d.deal.profit.total * longMult : 0)
      const total =
        d.deal.profit.total +
        (profitBase ? qty - base : quoteTp - quote) * longMult -
        (d.deal.fullFee ?? 0) -
        (profitBase ? qty * fee : quoteTp * fee)
      if (denominator) {
        if (profitBase) {
          if (useTp) {
            tp =
              quote /
              (qty -
                d.deal.profit.total * longMult -
                (tpToUse * denominator -
                  d.deal.profit.total +
                  (d.deal.fullFee ?? 0) +
                  qty * fee) /
                  longMult)
          }
          if (useSl) {
            sl =
              quote /
              (qty -
                d.deal.profit.total * longMult -
                (slToUse * denominator -
                  d.deal.profit.total +
                  (d.deal.fullFee ?? 0) +
                  qty * fee) /
                  longMult)
          }
        }
        if (!profitBase) {
          if (useTp) {
            tp =
              (tpToUse * denominator +
                (d.deal.fullFee ?? 0) -
                d.deal.profit.total +
                quote * longMult) /
              (qty * (longMult - fee))
          }
          if (useSl) {
            sl =
              (slToUse * denominator +
                (d.deal.fullFee ?? 0) -
                d.deal.profit.total +
                quote * longMult) /
              (qty * (longMult - fee))
          }
        }
      }
      if (tp !== null && tp <= 0) {
        this.handleDebug(`TP less than 0, skip new tp ${tp}`)
        tp = null
      }
      if (sl !== null && sl <= 0) {
        this.handleDebug(`SL less than 0, skip new sl ${sl}`)
        sl = null
      }
      if (tp !== null || sl !== null) {
        const get = this.dealsForStopLossCombo.get(d.deal._id)
        if (tp !== null && get?.tp !== tp) {
          const tpPerc = await this.claculateTpSlFromPrice(d, tp)
          const tpLog = `Deal: ${
            d.deal._id
          } new take profit. TP set level: ${tp}, TP set: ${
            tpToUse * 100
          }%, TP calculated: ${
            tpPerc * 100
          }, total: ${total}, denominator: ${denominator}, quote: ${quote}, quoteTP: ${quoteTp}, qty: ${qty}, fullFee: ${
            d.deal.fullFee
          }, profit: ${d.deal.profit.total}`
          if (tpPerc < 0) {
            this.handleDebug(`NEW PERCENT LOWER THAN 0 skip new tp, ${tpLog}`)
            tp = null
          } else if (tpToUse * 0.9 > tpPerc) {
            this.handleWarn(`TP calculated diff more than 10%, ${tpLog}`)
          } else {
            this.handleDebug(tpLog)
          }
          if (tp !== null) {
            this.botEventDb.createData({
              userId: this.userId,
              botId: this.botId,
              event: 'Take Profit',
              botType: this.botType,
              description: `Set new TP price ${tp}. Calculated TP: ${this.math.round(
                tpPerc * 100,
              )}%, target TP: ${this.math.round(tpToUse * 100)}%`,
              paperContext: !!this.data?.paperContext,
              deal: d.deal._id,
              symbol: d.deal.symbol.symbol,
            })
          }
        }
        if (sl !== null && get?.sl !== sl) {
          const slPerc = await this.claculateTpSlFromPrice(d, sl)
          this.handleDebug(
            `Deal: ${d.deal._id} new stop loss. SL set level: ${sl}, Sl set: ${
              slToUse * 100
            }%, SL calculated: ${
              slPerc * 100
            }, total: ${total}, denominator: ${denominator}, quote: ${quote}, quoteTP: ${quoteTp}, qty: ${qty}, fullFee: ${
              d.deal.fullFee
            }, profit: ${d.deal.profit.total}`,
          )
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: 'Stop Loss',
            botType: this.botType,
            description: `Set new SL price ${sl}. Calculated SL: ${this.math.round(
              slPerc * 100,
            )}%, target SL: ${this.math.round(slToUse * 100)}%`,
            paperContext: !!this.data?.paperContext,
            deal: d.deal._id,
            symbol: d.deal.symbol.symbol,
          })
        }
      }

      return { tp: Math.max(tp ?? 0, 0), sl: Math.max(sl ?? 0, 0) }
    }
    override async setDealForStopLoss(deal: FullDeal<CleanComboDealsSchema>) {
      if (await this.isDealForStopLoss(deal)) {
        this.dealsForStopLossCombo.set(
          deal.deal._id,
          await this.getDealStopLossPriceCombo(deal),
        )
        this.allowedMethods.add('checkDealsStopLoss')
      }
    }
    override async checkDealSlMethods(deal: FullDeal<CleanComboDealsSchema>) {
      await this.setDealForStopLoss(deal)
      this.setDealForDCALevelCheck(deal)
    }
    override async checkDealsForStopLoss() {
      const activeDeals: [string, DealStopLossCombo][] = []
      for (const d of this.allDealsData) {
        if (await this.isDealForStopLoss(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            await this.getDealStopLossPriceCombo(d),
          ] as [string, DealStopLossCombo])
        }
      }

      this.dealsForStopLossCombo = new Map(activeDeals)
    }

    override async checkDealsForStopLossMethods() {
      await this.checkDealsForStopLoss()
      this.checkDealsForDCALevelCheck()
    }

    @IdMute(mutex, (botId: string) => `${botId}unrealizedProfit`, 200)
    private async unrealizedProfit() {
      if (!this.allowedMethods.has('checkDealsStopLoss')) {
        return
      }
      const symbol = this.data?.settings?.pair?.[0]
      if (!symbol) {
        return
      }
      const lastOrder = this.lastFilledOrderMap.get(symbol)
      const lastPrice = +(lastOrder?.price ?? '0')
      const lastStreamData = this.getLastStreamData(symbol)
      if (lastPrice && !isNaN(lastPrice) && isFinite(lastPrice) && lastOrder) {
        if ((lastStreamData?.time ?? 0) < lastOrder.updateTime) {
          this.setLastStreamData(symbol, {
            price: lastPrice,
            time: lastOrder.updateTime,
          })
        }
      }
      const price = this.getLastStreamData(symbol)?.price
      if (!price) {
        return
      }
      for (const [deal, data] of this.dealsForStopLossCombo) {
        const { tp, sl } = data
        if (!tp && !sl) {
          continue
        }
        const d = this.getDeal(deal)
        if (!d || d.closeBySl || d.deal.status !== DCADealStatusEnum.open) {
          continue
        }
        const { useSl, useTp } = await this.getAggregatedSettings(d.deal)
        const slTrigger =
          !!sl &&
          ((this.isLong && price <= sl) || (!this.isLong && price >= sl))
        const tpTrigger =
          !!tp &&
          ((this.isLong && price >= tp) || (!this.isLong && price <= tp))
        const close = slTrigger || tpTrigger
        if (!isNaN(sl) && isFinite(sl) && useSl && slTrigger && !d.closeBySl) {
          this.handleLog(
            `Deal: ${deal} closing by stop loss. SL set: ${sl}, SL last : ${price}`,
          )
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: 'Stop Loss',
            botType: this.botType,
            description: `Deal close trigger. SL set: ${sl}, SL last : ${price}`,
            paperContext: !!this.data?.paperContext,
            deal: d.deal._id,
            symbol: d.deal.symbol.symbol,
          })
        }
        if (!isNaN(tp) && isFinite(tp) && useTp && tpTrigger && !d.closeBySl) {
          this.handleLog(
            `Deal: ${deal} closing by take profit. TP set: ${tp}, TP last : ${price}`,
          )
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: 'Take Profit',
            botType: this.botType,
            description: `Deal close trigger. TP set: ${tp}, TP last : ${price}`,
            paperContext: !!this.data?.paperContext,
            deal: d.deal._id,
            symbol: d.deal.symbol.symbol,
          })
        }

        if (close) {
          await this.triggerStopLossCombo(d.deal._id, slTrigger, tpTrigger)
        }
      }
    }
    override processOrdersAfterCheck(
      filledOrders: Order[],
      partiallyFilledOrders: Order[],
    ) {
      for (const base of filledOrders.filter(
        (o) => o.typeOrder === TypeOrderEnum.dealStart,
      )) {
        this.processFilledOrder(base)
      }
      for (const fee of filledOrders.filter(
        (o) => o.typeOrder === TypeOrderEnum.fee,
      )) {
        this.processFilledOrder(fee)
      }
      for (const tp of filledOrders
        .filter((o) => o.typeOrder === TypeOrderEnum.dealTP)
        .sort((a, b) =>
          this.isLong
            ? +a.origPrice - +b.origPrice
            : +b.origPrice - +a.origPrice,
        )) {
        this.processFilledOrder(tp)
      }
      for (const dca of filledOrders
        .filter((o) => o.typeOrder === TypeOrderEnum.dealRegular)
        .sort((a, b) =>
          this.isLong
            ? +b.origPrice - +a.origPrice
            : +a.origPrice - +b.origPrice,
        )) {
        this.processFilledOrder(dca)
      }
      for (const grid of filledOrders.filter(
        (o) => o.typeOrder === TypeOrderEnum.dealGrid,
      )) {
        this.processFilledOrder(grid)
      }
      for (const partially of partiallyFilledOrders) {
        this.processPartiallyFilledOrder(partially)
      }
    }
    override async getDiffForCheckOrders(
      deal: FullDeal<CleanComboDealsSchema>,
      activeRegularOrders: Order[],
    ) {
      const minigrids = this.getMinigridByDealId({
        dealId: deal.deal._id,
      }).filter((m) => m.schema.status !== ComboMinigridStatusEnum.closed)
      const latestOrder = this.getOrdersByStatusAndDealId({
        status: ['FILLED', 'CANCELED'],
        dealId: deal.deal._id,
      })
        .filter((o) => o.status === 'FILLED' || +o.executedQty > 0)
        .sort((a, b) => +b.updateTime - +a.updateTime)[0]
      return await this.findDiffCombo(
        [
          ...deal.currentOrders.filter((g) => g.type !== TypeOrderEnum.dealTP),
          ...[...minigrids.flatMap((m) => m.currentOrders)],
        ].filter((o) => !o.hide),
        activeRegularOrders.map((o) => this.mapOrderToGrid(o)),
        latestOrder ? +latestOrder.price : deal.deal.lastPrice,
        undefined,
        deal,
        true,
      )
    }

    @IdMute(
      mutex,
      (botId: string, msg: PriceMessage) => `${botId}price${msg.symbol}`,
      200,
    )
    override async priceUpdateCallback(
      _botId: string,
      msg: PriceMessage,
    ): Promise<void> {
      if (!this.finishLoad) {
        return
      }
      if (
        this.data?.status === BotStatusEnum.closed &&
        this.data?.deals.active === 0
      ) {
        return
      }
      if (this.blockPriceCheck) {
        return
      }
      if (+new Date() - (this.lastPriceCheck.get(msg.symbol) ?? 0) < 500) {
        return
      }
      this.lastPriceCheck.set(msg.symbol, +new Date())
      const time = msg.time ? msg.time : (msg.eventTime ?? msg.time)
      const lastStreamData = this.getLastStreamData(msg.symbol)
      if (time < (lastStreamData?.time ?? 0)) {
        return
      }
      this.setLastStreamData(msg.symbol, { price: msg.price, time })
      if (msg.price === lastStreamData?.price) {
        return
      }
      const settings = await this.getAggregatedSettings()
      if (
        +new Date() - (this.lastCheckPerSymbol.get(msg.symbol) ?? 0) >
        (this.data?.parentBotId ? 30 * 1000 : 60 * 1000)
      ) {
        this.lastCheckPerSymbol.set(msg.symbol, +new Date())
        for (const d of this.getOpenDeals(false, msg.symbol)) {
          if (this.data) {
            const data: BotParentProcessStatsEventDtoDcaCombo = {
              event: 'processStats',
              botId: this.botId,
              botType:
                this.botType === BotType.combo ? BotType.combo : BotType.dca,
              payload: {
                combo: this.botType === BotType.combo,
                data: msg,
                deal: {
                  _id: d.deal._id,
                  settings: {
                    futures: d.deal.settings.futures,
                    marginType: d.deal.settings.marginType,
                    leverage: d.deal.settings.leverage,
                    comboTpBase: d.deal.settings.comboTpBase,
                    coinm: d.deal.settings.coinm,
                    profitCurrency: d.deal.settings.profitCurrency,
                  },
                  currentBalances: d.deal.currentBalances,
                  initialBalances: d.deal.initialBalances,
                  profit: {
                    total: d.deal.profit.total,
                    pureBase: d.deal.profit.pureBase,
                    pureQuote: d.deal.profit.pureQuote,
                  },
                  feePaid: d.deal.feePaid,
                  avgPrice: d.deal.avgPrice,
                  strategy: d.deal.strategy,
                  usage: d.deal.usage,
                  stats: d.deal.stats,
                  flags: d.deal.flags,
                  tpFilledHistory: d.deal.tpFilledHistory,
                  reduceFunds: d.deal.reduceFunds,
                  botId: this.botId,
                },
                fee: (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0,
                usdRate: (await this.getUsdRate(d.deal.symbol.symbol)) ?? 0,
              },
            }
            try {
              DealStats.getInstance().updateStats(data)
            } catch (e) {
              this.handleErrors(
                `Cannot send deal ${d.deal._id} stats to parent process ${e}`,
                'priceUpdateCallback',
                '',
                false,
                false,
                false,
              )
            }
          }
        }
        this.checkMinigridRange(msg.price, msg.symbol)

        await this.checkDynamic(this.botId, msg.symbol, +msg.price)
      }

      // Combo bots — unlike DCA — had no path to clear a transient `error`
      // status on a clean tick, so a benign error (e.g. a since-suppressed
      // `unknownOid`) left the bot wearing the error badge until a full reload.
      // Mirror DCA: reaching here means the price update processed fine, so
      // restore the bot out of error.
      if (
        this.data?.status === BotStatusEnum.error &&
        this.data.previousStatus !== BotStatusEnum.closed
      ) {
        this.restoreFromRangeOrError()
      }
      if (this.data?.status === 'range') {
        if (await this.checkInRange(msg.symbol, msg.price)) {
          this.restoreFromRangeOrError()
          if (
            settings.startCondition === StartConditionEnum.asap &&
            this.getOpenDeals().length === 0
          ) {
            this.openNewDeal(this.botId, msg.symbol)
          }
        }
      }
      if (
        msg.price >= (this.lowestHigh.get(msg.symbol) ?? Infinity) ||
        msg.price <= (this.highestLow.get(msg.symbol) ?? 0)
      ) {
        this.unrealizedProfit()
        this.checkDCALevel(this.botId, msg.price, msg.symbol)
      }
      if (
        this.data &&
        this.data.settings.useBotController &&
        (this.data.settings.botStart === BotStartTypeEnum.price ||
          this.data.settings.botActualStart === BotStartTypeEnum.price)
      ) {
        if (
          (this.data.status === BotStatusEnum.monitoring ||
            (this.data.status === BotStatusEnum.error &&
              this.data.previousStatus === BotStatusEnum.monitoring)) &&
          this.data?.settings.botActualStart === BotStartTypeEnum.price &&
          !this.startSent
        ) {
          if (
            this.data.settings.startBotPriceCondition ===
            IndicatorStartConditionEnum.gt
              ? msg.price > +(this.data.settings.startBotPriceValue ?? Infinity)
              : msg.price < +(this.data.settings.startBotPriceValue ?? 0)
          ) {
            this.startSent = true
            this.handleLog(
              `Start bot by price condition ${msg.price} ${this.data.settings.startBotPriceCondition} ${this.data.settings.startBotPriceValue}`,
            )
            this.setStatus(
              this.botId,
              BotStatusEnum.open,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            )
          }
        }
        if (
          (this.data.status === BotStatusEnum.open ||
            this.data.status === BotStatusEnum.range ||
            (this.data.status === BotStatusEnum.error &&
              (this.data.previousStatus === BotStatusEnum.open ||
                this.data.previousStatus === BotStatusEnum.range))) &&
          this.data?.settings.botStart === BotStartTypeEnum.price &&
          !this.stopSent
        ) {
          if (
            this.data.settings.stopBotPriceCondition ===
            IndicatorStartConditionEnum.gt
              ? msg.price > +(this.data.settings.stopBotPriceValue ?? Infinity)
              : msg.price < +(this.data.settings.stopBotPriceValue ?? 0)
          ) {
            this.stopSent = true
            const setMonitoring =
              this.data.settings.stopStatus === BotStatusEnum.monitoring &&
              (this.data.settings.botActualStart ===
                BotStartTypeEnum.indicators ||
                this.data.settings.botActualStart === BotStartTypeEnum.price)
            this.handleLog(
              `Stop bot by price condition ${msg.price} ${this.data.settings.stopBotPriceCondition} ${this.data.settings.stopBotPriceValue}, set monitoring ${setMonitoring} (${this.data.settings.stopStatus}, ${this.data.settings.botActualStart})`,
            )
            await this.setStatus(
              this.botId,
              BotStatusEnum.closed,
              this.data.settings.stopType,
            )
            if (setMonitoring) {
              this.setStatus(this.botId, BotStatusEnum.open)
            }
          }
        }
      }
    }
    override async getOrdersToRestartAfterSettingsUpdate(dealId: string) {
      const d = this.getDeal(dealId)
      const findMinigrids = this.getMinigridByDealId({ dealId }).filter(
        (m) => m.schema.status !== ComboMinigridStatusEnum.closed,
      )
      const prepared = await this.prepareMinigrids(
        findMinigrids.map((m) => m.schema),
      )
      for (const minigrid of prepared) {
        this.setMinigrid(minigrid, false)
      }
      this.saveMinigridToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
      const latestOrder = this.getOrdersByStatusAndDealId({
        status: ['FILLED', 'CANCELED'],
        dealId,
      })
        .filter((o) => o.status === 'FILLED' || +o.executedQty > 0)
        .sort((a, b) => +b.updateTime - +a.updateTime)[0]
      return await this.findDiffCombo(
        [
          ...(d?.currentOrders ?? []),
          ...[...prepared.flatMap((m) => m.currentOrders)],
        ],
        [],
        latestOrder ? +latestOrder.price : (d?.deal.lastPrice ?? 0),
        undefined,
        d,
      )
    }
    override async restoreWork() {
      const _id = this.startMethod('restoreWork')
      const serviceRestart = this.serviceRestart
      if (!serviceRestart) {
        this.calculateBotDeals()
      } else {
        this.handleDebug('Service restart skip calculate bot deals')
      }
      this.handleLog('Checking for existing deals')
      const settings = await this.getAggregatedSettings()
      const asapSymbols = await this.getSymbolsToOpenAsapDeals()
      if (serviceRestart) {
        const ordersWithClosedMinigrids = this.getOrdersByStatusAndDealId({
          status: 'NEW',
          dealId: [...this.deals.keys()],
        }).filter(
          (o) =>
            o.typeOrder === TypeOrderEnum.dealGrid &&
            !this.getActiveMinigrids()
              .map((m) => m.schema._id)
              .includes(o.minigridId),
        )
        for (const o of ordersWithClosedMinigrids ?? []) {
          this.handleLog(
            `Cancel order ${o.clientOrderId} because minigrid is closed`,
          )
          await this.cancelOrderOnExchange(o)
        }
        await this.checkOrders(this.botId)
      } else {
        await this.cancelAllOrder()
        await this.checkOrders(this.botId, true)
      }

      const openDeals = this.getOpenDeals()
      const activeDeals = openDeals.filter(
        (d) => d.deal.status === DCADealStatusEnum.open,
      )
      const startDeals = openDeals.filter(
        (d) => d.deal.status === DCADealStatusEnum.start,
      )
      if (startDeals.length > 0) {
        for (const d of startDeals) {
          const inDb = await this.ordersDb.readData<{
            symbol: string
            clientOrderId: string
            status: OrderStatusType
          }>(
            {
              botId: this.botId,
              dealId: d.deal._id,
              typeOrder: TypeOrderEnum.dealStart,
              status: { $ne: 'CANCELED' },
            },
            { symbol: 1, clientOrderId: 1, status: 1 },
          )
          if (inDb && inDb.status === StatusEnum.ok && inDb.data.result) {
            if (inDb.data.result.status !== 'FILLED') {
              await this.checkBaseOrder(
                this.botId,
                inDb.data.result.symbol,
                inDb.data.result.clientOrderId,
                d.deal._id,
              )
            } else {
              this.handleLog(
                `Deal ${d.deal._id} in status start, but found filled base order`,
              )
              const full = await this.ordersDb.readData({
                clientOrderId: inDb.data.result.clientOrderId,
              })
              if (full.data?.result) {
                await this.startDeal(full.data.result)
              } else {
                this.handleWarn(
                  `Cannot find full order for ${inDb.data.result.clientOrderId}`,
                )
              }
            }
          } else {
            this.handleLog(
              `${d.deal._id} not started yet. Place base order again`,
            )
            await this.placeBaseOrder(
              this.botId,
              d.deal.symbol.symbol,
              d.deal._id,
            )
          }
        }
      }
      if (activeDeals.length > 0) {
        this.handleLog(`Found ${activeDeals.length} open deals`)
        for (const d of activeDeals) {
          const dealMinigrids = this.getMinigridByDealId({
            dealId: d.deal._id,
          }).filter((m) => m.schema.status !== ComboMinigridStatusEnum.closed)
          if (dealMinigrids.length === 0) {
            this.handleDebug(`Deal doesn't have active minigrid`)
          }
          if (!serviceRestart) {
            this.updateDealBalances(d)
            d.deal = {
              ...d.deal,
              levels: {
                complete: d.deal.levels.complete,
                all: Math.max(
                  d.deal.levels.complete,
                  d.initialOrders.filter(
                    (o) => o.type === TypeOrderEnum.dealRegular,
                  ).length + 1,
                ),
              },
            }
            const avgs = await this.avgPrice(d.deal._id)
            d.deal.avgPrice = !isNaN(avgs.real) ? avgs.real : d.deal.avgPrice
            d.deal.displayAvg = !isNaN(avgs.display)
              ? avgs.display
              : d.deal.displayAvg
            this.saveDeal(d, {
              levels: d.deal.levels,
              avgPrice: d.deal.avgPrice,
              displayAvg: d.deal.displayAvg,
            })
            this.updateAssets(d.deal._id)
            const findTp = this.getOrdersByStatusAndDealId({
              status: 'PARTIALLY_FILLED',
              dealId: `${d.deal._id}`,
            }).find((o) => o.typeOrder === TypeOrderEnum.dealTP)
            if (!findTp) {
              const findMinigrids = this.getMinigridByDealId({
                dealId: d.deal._id,
              }).filter(
                (m) => m.schema.status !== ComboMinigridStatusEnum.closed,
              )
              const latestOrder = this.getOrdersByStatusAndDealId({
                status: ['FILLED', 'CANCELED'],
                dealId: `${d.deal._id}`,
              })
                .filter((o) => o.status === 'FILLED' || +o.executedQty > 0)
                .sort((a, b) => +b.updateTime - +a.updateTime)[0]
              await this.placeOrders(
                this.botId,
                d.deal.symbol.symbol,
                d.deal._id,
                await this.findDiffCombo(
                  [
                    ...d.currentOrders,
                    ...[...findMinigrids.flatMap((m) => m.currentOrders)],
                  ].filter((o) => !o.hide),
                  [],
                  latestOrder ? +latestOrder.price : d.deal.lastPrice,
                  undefined,
                  d,
                ),
              )
            }
          }
        }
      }
      if (!serviceRestart) {
        this.updateDealLastPrices(this.botId)
      } else {
        this.handleDebug('Service restart skip update last deal price')
      }
      if (
        settings.startCondition === StartConditionEnum.asap &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        if (
          activeDeals.length === 0 &&
          startDeals.length === 0 &&
          !settings.useMulti
        ) {
          if (await this.checkInRange(asapSymbols[0])) {
            this.openNewDeal(this.botId, asapSymbols[0])
          } else {
            if (
              !settings.useDynamicPriceFilter &&
              settings.useStaticPriceFilter
            ) {
              this.setRangeOrError()
            }
          }
        }
        if (settings.useMulti) {
          for (const symbol of asapSymbols) {
            if (await this.checkInRange(symbol)) {
              await this.openNewDeal(this.botId, symbol)
            }
          }
        }
      }
      if (
        settings.startCondition === StartConditionEnum.timer &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        this.startTimeBasedTrigger()
      }
      await this.startIndicatorInit(serviceRestart, activeDeals.length)
      if (!serviceRestart) {
        this.calculateBotBalances()
      } else {
        this.handleDebug('Service restart skip calculate bot balances')
      }
      await this.calculateUsage()
      this.endMethod(_id)
    }
  }

  return ComboBot as new (
    id: string,
    exchange: ExchangeEnum,
    log?: boolean,
    serviceRestart?: boolean,
    ignoreStats?: boolean,
  ) => ComboBot & InstanceType<TBaseClass>
}

export default createComboBotHelper
