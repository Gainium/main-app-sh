import type DB from '../db'
import {
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
  BotStatusEnum,
  InitialPriceFromEnum,
  BotProgressCodeEnum,
  ExchangeEnum,
  BuyTypeEnum,
  CloseGRIDTypeEnum,
  BOT_STATUS_EVENT,
  PositionSide,
  StrategyEnum,
  FuturesStrategyEnum,
  BotType,
} from '../../types'
import MainBot from './main'

import type {
  BotData,
  BotSchema,
  TransactionSchema,
  PriceMessage,
  Grid,
  Order,
  ExecutionReport,
  ClearOrderSchema,
  ClearTransactionSchema,
  ClearBotSchema,
  ClearPairsSchema,
  OrderAdditionalParams,
  BotParentProcessStatsEventDtoGrid,
} from '../../types'
import utils from '../utils'
import { IdMutex, IdMute } from '../utils/mutex'
import { botDb, transactionDb } from '../db/dbInit'
import { DealStats } from './worker/statsService'
import { botMonitor, CalculateGridLiveStatsParams } from './botMonitor'

/**
 * Price in initial grids
 */
type PriceInGrid = {
  /**
   * Price for buy case
   */
  buy: number
  /**
   * Price for sell case
   */
  sell: number
}

export type InitialGrid = Omit<
  Grid,
  'side' | 'newClientOrderId' | 'qty' | 'price'
> & {
  price: PriceInGrid
}

/**
 * Enum for tpsl function
 * @enum {none|sl|tp}
 */
export enum TpSlReturn {
  none = 'none',
  sl = 'sl',
  tp = 'tp',
}

const mutex = new IdMutex()

const { sleep } = utils

function createBotHelper<
  Schema extends BotSchema = BotSchema,
  TBaseClass extends new (...args: any[]) => MainBot<Schema> = new (
    ...args: any[]
  ) => MainBot<Schema>,
>(BaseClass?: TBaseClass) {
  const ActualBaseClass = (BaseClass || MainBot) as TBaseClass extends new (
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
      ) => MainBot<Schema>

  /**
   * Class for operate bot functions
   */
  class BotHelper extends ActualBaseClass {
    private ordersInProgress: Set<string> = new Set()
    /** DB instance to work with transactions collection */
    protected transactionDb: DB<TransactionSchema>
    /** Object to store swap asset order */
    private swapAssetData: Order | null
    /** Array to store previous grids */
    protected prevGrids: Grid[] | null = null
    /** Array to store active grids */
    protected grids: Grid[] | null = null
    /** Array if initial grids */
    private initialGrid: InitialGrid[] | null = null
    /** Marker to show what type of start bot used: normal or after bot restart */
    protected restart: boolean
    /** Last filled order if exists. Used to continue bot work after service restart */
    private _lastFilled: Order | null
    /** Marker to show if it is a first start for bot */
    protected firstRun: boolean
    /** Marker to show if currently tp/sl is executed */
    protected lockTpSlCheck: boolean
    /** Swap order process lock */
    protected swapLock = false
    /** Swap order type */
    protected swapType: BuyTypeEnum = BuyTypeEnum.proceed
    /** Swap sell orders count */
    protected swapSellCount = 0
    /** Swap qty */
    protected swapOrderQty = 0
    /** Close order timer */
    private closeOrderTimer: NodeJS.Timeout | null = null
    /** Limit repostion timeout */
    private limitRepositionTimeout = 10000
    /** Stop filled */
    private stopFilled = false
    /** Block limit */
    protected blockLimit = false
    /** Swap assets started */
    private swapAssetsStarted = false
    /** Profit currency was changed */
    protected profitCurrencyChanged = false
    /** Filled update while loading */
    private filledWhileLoading: Map<string, Order> = new Map()
    private feeOrders: Set<string> = new Set()
    private feeProcessed: Set<string> = new Set()
    private blockCheck = false
    protected startTimeoutTime = 0
    protected limitTimer: NodeJS.Timeout | null = null
    protected enterMarketTimer: NodeJS.Timeout | null = null
    private statsTimer: NodeJS.Timeout | null = null
    private lastStatsCheck = 0
    /**
     * Prepare DB instaces
     *
     * Connect to socket io streams
     *
     * Set initial values
     * @param {string} id Id of the bot
     * @param {boolean} restart Show if bot starts after service restart.
     * @param {boolean} log Enable/disable logging
     * @returns {BotHelper} Bot class instance
     */
    constructor(
      id: string,
      exchange: ExchangeEnum,
      restart = false,
      log = true,
      serviceRestart = false,
    ) {
      super(id, exchange, log)
      this.db = botDb
      this.transactionDb = transactionDb
      this.swapAssetData = null
      this.priceUpdateCallback = this.priceUpdateCallback.bind(this)
      this.processFilledOrder = this.processFilledOrder.bind(this)
      this.processFilledSwap = this.processFilledSwap.bind(this)
      this.processLiquidationOrder = this.processLiquidationOrder.bind(this)
      this.handleUnknownOrder = this.handleUnknownOrder.bind(this)
      this.sortQueue = this.sortQueue.bind(this)
      this.processSellAtStop = this.processSellAtStop.bind(this)
      this.restart = restart
      this.serviceRestart = serviceRestart
      this._lastFilled = null
      this.firstRun = true
      this.log = log
      this.lockTpSlCheck = false
      this.cbFunctions = {
        sort: this.sortQueue,
        onFilled: this.processFilledOrder,
        onLiquidation: this.processLiquidationOrder,
      }
      this.callbackAfterUserStream = this.checkOrdersAfterReconnect.bind(this)
      this.priceTimerFn = this.priceTimerFn.bind(this)
    }
    set lastFilled(order: Order | null) {
      if (
        order?.typeOrder === TypeOrderEnum.liquidation ||
        order?.typeOrder === TypeOrderEnum.br
      ) {
        return
      }
      if (order) {
        this.setToRedis('lastFilled', order)
      } else {
        this.removeFromRedis('lastFilled')
      }
      this._lastFilled = order
    }
    get lastFilled() {
      return this._lastFilled
    }
    setStatsTimer() {
      const newTime = new Date()
      newTime.setMinutes(newTime.getMinutes() + 1)
      newTime.setSeconds(15, 0)
      this.statsTimer = setTimeout(
        () => this.updateLiveStats.bind(this)(this.botId, +newTime),
        +newTime - +new Date(),
      )
    }
    /**
     * Read orders from {@link MainBot#_loadOrders}<br />
     *
     * Find last filled order and set to @link BotHelper#lastFilled}
     *
     * <ul>Separate orders to:
     *
     * <li>1) type - swap, status - filled;</li>
     *
     * <li>2) type - regular, status - new & partially filled;</li>
     *
     * <li>3) type - regular, status - filled</li></ul>
     *
     * If swap order (1) exist - set to {@link BotHelper#swapAssetData}<br />
     *
     * If regular orders (2) exist - set to {@link BotHelper#orders}; convert to {@link Grid} type and set to {@link BotHelper#grids}, {@link BotHelper#prevGrids}<br />
     *
     * If regular filled orders (3) exist - set to {@link BotHelper#orders}<br />
     *
     * Read transactions from {@link BotHelper#transactionDb} filtered not empty fields idBuy & idSell (fields not empty only for profit in base case), return only idBuy & idSell fields<br />
     *
     * If transactions not empty - push idBuy & idSell to {@link BotHelper#usedOrderId}<br />
     */
    async loadOrders(): Promise<void> {
      const _id = this.startMethod('loadOrders')
      const orders = await this._loadOrders(undefined, true)
      let filledOrders: ClearOrderSchema[] = []
      if (orders.length > 0) {
        this.handleLog('Read orders from DB')
        if (this.restart) {
          if (this.serviceRestart) {
            const fromRedis = await this.getFromRedis<Order>('lastFilled')
            if (fromRedis) {
              this.handleLog(
                `Found last filled in redis ${fromRedis.price} ${fromRedis.executedQty} ${fromRedis.side}`,
              )
              this.lastFilled = fromRedis
            }
          }
          if (!this.serviceRestart || !this.lastFilled) {
            const last = await this.ordersDb.readData(
              {
                botId: this.botId,
                typeOrder: {
                  $in: [TypeOrderEnum.swap, TypeOrderEnum.regular],
                },
                status: 'FILLED',
              },
              {},
              { sort: { updateTime: -1 } },
            )
            this.lastFilled =
              last.data?.result ??
              (orders
                .filter(
                  (o) =>
                    o.status === 'FILLED' &&
                    [TypeOrderEnum.swap, TypeOrderEnum.regular].includes(
                      o.typeOrder,
                    ),
                )
                .sort(
                  (a, b) =>
                    (b.updateTime || b.transactTime || 0) -
                    (a.updateTime || a.transactTime || 0),
                )[0] ||
                null)
          }
        }
        if (this.futures && this.data) {
          const lastTP =
            [...orders]
              .sort((a, b) => b.updateTime - a.updateTime)
              .find((o) => o.typeOrder === TypeOrderEnum.stop)?.updateTime ?? 0
          this.data.position = await this.calculatePositionForOrders(
            orders.filter(
              (o) =>
                o.status === 'FILLED' &&
                o.updateTime > lastTP &&
                (this.data?.lastPositionChange
                  ? o.updateTime > this.data.lastPositionChange
                  : true) &&
                o.typeOrder !== TypeOrderEnum.stab,
            ),
          )
          this.updateData({ position: this.data.position })
          this.emit('bot settings update', { position: this.data.position })
        }
        const swapOrder = orders.find(
          (order) =>
            order.typeOrder === TypeOrderEnum.swap && order.status === 'FILLED',
        )
        const regularOrders = orders.filter(
          (order) =>
            order.typeOrder !== TypeOrderEnum.swap &&
            (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED'),
        )

        if (this.data?.settings.newProfit || this.profitBase) {
          filledOrders = orders.filter(
            (order) =>
              order.typeOrder === TypeOrderEnum.regular &&
              order.status === 'FILLED',
          )
        }

        if (swapOrder) {
          this.swapAssetData = { ...swapOrder }
        }
        if (regularOrders && regularOrders.length > 0) {
          regularOrders.map((o) => this.setOrder({ ...o }, false))
          this.setOrdersToRedis(
            this.botId,
            this.serviceRestart && !this.secondRestart,
          )
        }
      }
      this.handleLog('Read transactions from DB')

      const transactions = await this.transactionDb.readData(
        {
          idBuy: { $ne: '' },
          idSell: { $ne: '' },
          botId: this.botId,
          userId: this.userId,
        },
        { idBuy: 1, idSell: 1, botId: 1 },
        {},
        true,
      )
      if (
        transactions.status === StatusEnum.ok &&
        transactions.data.result.length > 0
      ) {
        const usedOrderId: Set<string> = new Set()
        const tr = transactions.data.result
        this.handleLog(`Found ${tr.length} transactions`)
        tr.map((t) => {
          usedOrderId.add(t.idBuy)
          usedOrderId.add(t.idSell)
        })
        filledOrders = filledOrders.filter(
          (fo) => !usedOrderId.has(fo.clientOrderId),
        )
      }
      if (transactions.status === StatusEnum.notok) {
        this.endMethod(_id)
        return this.handleErrors(
          transactions.reason,
          'loadOrders()',
          'Read transaction data',
        )
      }

      if (filledOrders && filledOrders.length > 0) {
        filledOrders.forEach((o) => this.setOrder(o, false))
        this.setOrdersToRedis(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        )
      }
      this.handleLog('Load orders end')
      if (this.futures) {
        await this.startFunding().catch(() => undefined)
      }
      this.endMethod(_id)
    }

    /**
     * Set bot status <br />
     *
     * If status closed - run {@link BotHelper#stop}<br />
     *
     * If status open - run {@link BotHelper#start}
     *
     * @param {BotStatusEnum} status Status to set for the bot
     * @param {boolean} [all] Set marker to swap order to place for all needed qty or only for required. Used in smart orders case
     * @param {boolean} [cancelPartiallyFilled] Set marker to swap order to place for all needed qty or only for required. Used in smart orders case
     */
    async setStatus(
      status: BotStatusEnum,
      cancelPartiallyFilled?: boolean,
      buyType?: BuyTypeEnum,
      buyCount?: string,
      buyAmount?: number,
      closeType?: CloseGRIDTypeEnum,
      ignoreErrors?: boolean,
    ): Promise<void> {
      const _id = this.startMethod('setStatus')
      this.ignoreErrors = !!ignoreErrors
      const currentStatus = this.data?.status
      if (status === currentStatus) {
        this.endMethod(_id)
        return
      }

      if (this.shouldProceed()) {
        this.botEventDb.createData({
          userId: this.userId,
          botId: this.botId,
          event: BOT_STATUS_EVENT,
          botType: this.botType,
          description: `${this.data?.status} -> ${status}`,
          paperContext: !!this.data?.paperContext,
        })
      }

      if (status === 'closed') {
        await this.stop(cancelPartiallyFilled, closeType)
      } else if (status === 'open') {
        this.swapType = buyType ?? this.swapType
        this.swapOrderQty = buyAmount ?? this.swapOrderQty
        this.swapSellCount =
          +(buyCount ?? `${this.swapSellCount}`) || this.swapSellCount
        await this.start()
      } else {
        await this.stop()
      }

      if (this.shouldProceed()) {
        this.botEventDb.createData({
          userId: this.userId,
          botId: this.botId,
          event: BOT_STATUS_EVENT,
          botType: this.botType,
          description: currentStatus
            ? `${currentStatus} -> ${status}`
            : `${status} status is set`,
          paperContext: !!this.data?.paperContext,
        })
      }

      this.endMethod(_id)
    }

    /**
     * Send end process
     */
    private sendEndProcess(end = false) {
      if ((!end && this.firstRun) || (end && !this.firstRun)) {
        if (this.data) {
          this.data.progress = undefined
        }
        this.updateProgress()
        this.firstRun = end
      }
    }

    get isShort() {
      return this.futures &&
        this.futuresStrategy !== FuturesStrategyEnum.neutral
        ? this.futuresStrategy === FuturesStrategyEnum.short
        : this.data?.settings.strategy === StrategyEnum.short
    }

    get futuresStrategy() {
      return this.data?.settings.futuresStrategy ?? FuturesStrategyEnum.neutral
    }
    /**
     * Get qty to initial swap<br />
     *
     * Get latest price using {@link BotHelper#getLatestPrice}<br />
     *
     * Generate current grids for {@link BotHelper#generateCurrentGrids}. Using {@link BotHelper#all} to count for all or current orders<br />
     *
     * Count all needee base amount for current grids and comission<br />
     *
     * Reset {@link BotHelper#grids} that was set after {@link BotHelper#generateCurrentGrids} executed
     *
     * @returns {Promise<number>} qty to initial swap
     */
    async getQtyToSwap(): Promise<number> {
      this.handleLog('Get qty to swap start')
      const _id = this.startMethod('getQtyToSwap')
      if (!this.data) {
        this.endMethod(_id)
        return 0
      }
      const { pair } = this.data.settings
      const fee = await this.getUserFee(pair)
      if (!fee) {
        this.endMethod(_id)
        return 0
      }
      if (
        [BuyTypeEnum.diff, BuyTypeEnum.sellDiff].includes(this.swapType) &&
        this.swapOrderQty !== 0
      ) {
        this.endMethod(_id)
        return this.math.round(
          Math.abs(this.swapOrderQty),
          await this.baseAssetPrecision(pair),
        )
      }
      let testGrids = false
      const lastPrice = await this.getLatestPrice(pair)
      const all =
        this.futuresStrategy !== FuturesStrategyEnum.neutral ||
        this.swapType === BuyTypeEnum.all ||
        (this.swapType === BuyTypeEnum.X &&
          !isNaN(this.swapSellCount) &&
          this.swapSellCount > 0)
      const oldGrids = await this.generateCurrentGrids(
        lastPrice,
        !this.isShort ? OrderSideEnum.buy : OrderSideEnum.sell,
        all,
        false,
        true,
      )
      const useMaxGrids =
        !this.futures &&
        ((this.data.settings.strategy === StrategyEnum.long &&
          this.data.settings.profitCurrency === 'base' &&
          oldGrids?.filter((g) => g.side === OrderSideEnum.sell).length) ||
          (this.data.settings.strategy === StrategyEnum.short &&
            this.data.settings.profitCurrency === 'quote' &&
            oldGrids?.filter((g) => g.side === OrderSideEnum.buy).length))

      if (lastPrice !== 0) {
        await this.generateCurrentGrids(
          useMaxGrids
            ? this.data.settings.strategy !== StrategyEnum.short
              ? +this.data.settings.topPrice * 1.1
              : +this.data.settings.lowPrice * 0.9
            : lastPrice,
          !this.isShort ? OrderSideEnum.buy : OrderSideEnum.sell,
          all,
        )
        if (useMaxGrids) {
          this.grids = [...(this.grids ?? [])]
            .sort((a, b) =>
              !this.isShort ? b.price - a.price : a.price - b.price,
            )
            .slice(
              0,
              !this.isShort
                ? oldGrids?.filter((g) => g.side === OrderSideEnum.sell).length
                : oldGrids?.filter((g) => g.side === OrderSideEnum.buy).length,
            )
        }
        testGrids = true
      }
      const res = this.grids
        ?.filter((g) =>
          useMaxGrids
            ? true
            : !this.isShort
              ? g.side === OrderSideEnum.sell
              : g.side === OrderSideEnum.buy,
        )
        .slice(
          0,
          this.futuresStrategy !== FuturesStrategyEnum.neutral
            ? (this.grids?.length ?? 1)
            : !isNaN(this.swapSellCount) &&
                this.swapSellCount > 0 &&
                this.swapType === BuyTypeEnum.X
              ? this.swapSellCount
              : (this.grids?.length ?? 1),
        )
        .reduce(
          (acc, grid) => {
            if (
              (useMaxGrids ||
                (grid.side &&
                  (!this.isShort
                    ? grid.side === OrderSideEnum.sell
                    : grid.side === OrderSideEnum.buy))) &&
              grid.qty
            ) {
              return {
                qty:
                  acc.qty +
                  grid.qty *
                    (this.futures ? 1 : !this.isShort ? 1 : grid.price),
                com: acc.com + grid.qty * fee.maker,
              }
            }
            return acc
          },
          { qty: 0, com: 0 } as { qty: number; com: number },
        ) || { qty: 0, com: 0 }
      const total = this.math.round(
        res.qty / (this.futures ? 1 : !this.isShort ? 1 : lastPrice) +
          (this.futures || this.data.settings.feeOrder ? 0 : res.com),
        await this.baseAssetPrecision(pair),
        false,
        true,
      )
      this.handleLog(`Swap qty - ${total}`)
      if (testGrids) {
        this.grids = null
      }
      this.handleLog('Get qty to swap end')
      this.endMethod(_id)
      return total
    }
    /**
     * Process filled swap
     */
    async processFilledSwap(order: Order) {
      if (!this.swapLock) {
        this.swapLock = true
        this.handleLog('Swap order status FILLED, run limitOrders()')
        await this.generateInitialBalances(parseFloat(order.price))
        await this.calculatePosition(order)
        this.limitOrders(this.botId, OrderSideEnum.buy, +order.price)
      }
    }
    private updateProgress(progress?: BotSchema['progress']) {
      if (this.data) {
        this.data.progress = progress
        this.updateData({ progress: progress ?? null })
        this.emit('bot settings update', { progress: progress ?? null })
      }
    }
    /**
     * Swap base asset to quoted asset to start the work<br />
     *
     * Call {@link BotHelper#getQtyToSwap} to get qty needed for grids, that supposted to be placed<br />
     *
     * If {@link BotHelper#orders} not empty - filter for {@link BotHelper#orderStatuses} and sum total base used<br />
     *
     * Get final qty. Subtract already in bot orders qty and already in user balance from all qty needed to swap<br />
     *
     * If final qty > 0 - request latest price using {@link BotHelper#getLatestPrice}<br />
     *
     * If qty * price < exchange min amount - use exchange min amount<br />
     *
     * Check if user has enough quote balance. If not return error<br />
     *
     * Place MARKET order. Save order to {@link BotHelper#swapAssetData} and DB orders collection<br />
     *
     * If not set bot initial price and initial balances, means first run, save this data to {@link BotHelper#data} and bot collection <br />
     *
     * If final qty < 0 - request latest price using {@link BotHelper#getLatestPrice} and use this price as initial bot price and calculate initial balances based on this price. Save to {@link BotHelper#swapAssetData} only property status: 'FILLED'<br />
     *
     * Run {@link BotHelper#limitOrders} to place working orders for bot<br />
     */
    async swapAssets(): Promise<void> {
      const _id = this.startMethod('swapAssets')
      if (this.swapAssetsStarted) {
        this.handleLog('Swap assets already in progress')
        this.endMethod(_id)
        return
      }
      this.swapAssetsStarted = true
      this.handleLog('Swap assets start')
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      const { pair } = this.data.settings
      const fee = await this.getUserFee(pair)
      const ed = await this.getExchangeInfo(pair)
      if (this.data && this.exchange && fee && ed) {
        if (
          !this.restart &&
          (this.futures
            ? this.futuresStrategy !== FuturesStrategyEnum.neutral &&
              this.data.position.qty === 0
            : this.swapType !== BuyTypeEnum.proceed &&
              (!this.futures ||
                (this.futures &&
                  this.futuresStrategy !== FuturesStrategyEnum.neutral)))
        ) {
          const qtyToSwap = await this.getQtyToSwap()
          this.handleLog('Get qty to swap')
          const inOrders = this.getOrdersByStatusAndDealId({
            defaultStatuses: true,
          })
            .filter((o) =>
              !this.isShort
                ? o.side === OrderSideEnum.sell
                : o.side === OrderSideEnum.buy,
            )
            .reduce((acc, v) => (acc += parseFloat(v.origQty)), 0)

          let exactQtyToSwap = this.math.round(
            this.swapType === BuyTypeEnum.sellDiff
              ? qtyToSwap - inOrders
              : (qtyToSwap - inOrders) / (1 - (this.futures ? 0 : fee.maker)),
            await this.baseAssetPrecision(pair),
            this.futures ? undefined : false,
            this.futures ? undefined : true,
          )
          if (exactQtyToSwap && exactQtyToSwap > 0) {
            const priceRequest = await this.getLatestPrice(pair)
            if (priceRequest === 0) {
              this.sendEndProcess()
              this.handleDebug('Get latest price. Latest price = 0. swapAssets')
              this.endMethod(_id)
              return
            }
            const price = priceRequest
            if (price * exactQtyToSwap < ed.quoteAsset.minAmount) {
              exactQtyToSwap = this.math.round(
                (ed.quoteAsset.minAmount / price) * 1.005,
                await this.baseAssetPrecision(pair),
                false,
                true,
              )
            }

            const swapSide =
              this.swapType === BuyTypeEnum.sellDiff
                ? !this.isShort
                  ? OrderSideEnum.sell
                  : OrderSideEnum.buy
                : !this.isShort
                  ? OrderSideEnum.buy
                  : OrderSideEnum.sell
            const bybit =
              this.data.exchange === ExchangeEnum.bybit &&
              swapSide === OrderSideEnum.buy
            if (bybit) {
              exactQtyToSwap = this.math.round(
                exactQtyToSwap * 1.005,
                await this.baseAssetPrecision(pair),
                true,
              )
            }
            this.handleLog(`Exact qty to swap - ${exactQtyToSwap}`)
            const balances = await this.checkAssets(true)
            const balance = this.futures
              ? this.coinm
                ? balances?.get(ed.baseAsset.name)
                : balances?.get(ed.quoteAsset.name)
              : swapSide === OrderSideEnum.buy
                ? balances?.get(ed.quoteAsset.name)
                : balances?.get(ed.baseAsset.name)
            const base = exactQtyToSwap
            const quote = price * exactQtyToSwap
            const required = this.futures
              ? this.coinm
                ? base
                : quote
              : swapSide === OrderSideEnum.buy
                ? quote
                : base

            if (
              required / this.currentLeverage > (balance?.free ?? Infinity) &&
              !this.data.settings.skipBalanceCheck
            ) {
              this.sendEndProcess()
              this.endMethod(_id)
              return this.handleErrors(
                `Not enough quote to place swap order. Your balance ${
                  balance?.free
                }, required amount is ${this.math.round(
                  !this.isShort ? price * exactQtyToSwap : exactQtyToSwap,
                  !this.isShort
                    ? ed?.priceAssetPrecision
                    : await this.baseAssetPrecision(ed.pair),
                )}`,
                'swapAssets()',
              )
            }
            const swapId = this.getOrderId(`GRID-BO`)
            this.swapAssetData = {
              clientOrderId: swapId,
              status: 'NEW',
              executedQty: '0',
              price: `${this.math.round(price, ed.priceAssetPrecision)}`,
              origPrice: `${price}`,
              cummulativeQuoteQty: `${price * exactQtyToSwap}`,
              orderId: '-1',
              origQty: `${exactQtyToSwap}`,
              side: swapSide,
              symbol: this.data.settings.pair,
              baseAsset: this.data.symbol.baseAsset,
              quoteAsset: this.data.symbol.quoteAsset,
              type: 'MARKET',
              updateTime: new Date().getTime(),
              exchange: this.data.exchange,
              exchangeUUID: this.data.exchangeUUID,
              typeOrder: TypeOrderEnum.swap,
              botId: this.botId,
              userId: this.userId,
              transactTime: new Date().getTime(),
              fills: [],
              positionSide: this.hedge
                ? this.futuresStrategy === FuturesStrategyEnum.long
                  ? PositionSide.LONG
                  : this.futuresStrategy === FuturesStrategyEnum.short
                    ? PositionSide.SHORT
                    : PositionSide.BOTH
                : PositionSide.BOTH,
            }
            const progress = {
              text: BotProgressCodeEnum.placeSwap,
              stage: 0,
              total:
                this.data.settings.useOrderInAdvance &&
                this.data.settings.ordersInAdvance
                  ? this.data.settings.ordersInAdvance
                  : this.data.settings.levels,
              isAllowedToCancel: true,
            }
            this.updateProgress(progress)
            const result = await this.sendOrderToExchange(this.swapAssetData)
            if (
              result &&
              result.clientOrderId !== this.swapAssetData.clientOrderId
            ) {
              this.swapAssetData.clientOrderId = result.clientOrderId
            }
            if (result) {
              this.swapAssetData.orderId = result.orderId
            }
            await sleep(5000)
            this.loadingComplete = true
            if (result && result.status === 'FILLED') {
              this.processFilledSwap(result)
            }
            if (!result) {
              this.updateProgress()
            }
          }
        } else {
          this.handleLog(`Swap order not needed`)

          if (!this.data.initialPrice) {
            const lastPrice = await this.getLatestPrice(pair)
            if (lastPrice !== 0) {
              this.generateInitialBalances(
                lastPrice,
                InitialPriceFromEnum.start,
              )
            }
          }
          if (this.data.initialPrice && !this.data.workingShift.length) {
            this.generateInitialBalances(
              this.data.initialPrice,
              InitialPriceFromEnum.start,
            )
          }
          //@ts-ignore
          this.swapAssetData = {
            status: 'FILLED',
          }
          if (
            this.lastFilled &&
            this.restart &&
            ((this.data.lastBalanceChange &&
              this.lastFilled.updateTime > this.data.lastBalanceChange) ||
              !this.data.lastBalanceChange)
          ) {
            this.handleDebug(
              `Found last filled order at price ${this.lastFilled.price}, side ${
                this.lastFilled.side
              }, qty ${this.lastFilled.origQty}, time ${new Date(
                this.lastFilled.updateTime ||
                  this.lastFilled.transactTime ||
                  new Date().getTime(),
              )}`,
            )
          }
          if (!this.lastFilled && this.restart) {
            this.handleDebug(`Not found last filled order`)
          }
          if (this.serviceRestart) {
            this.checkOrders(this.lastFilled && +this.lastFilled.price).then(
              async () => {
                this.loadingComplete = true
                await this.runAfterLoading()
              },
            )
          } else {
            this.limitOrders(
              this.botId,
              this.lastFilled
                ? this.lastFilled.side === 'BUY'
                  ? OrderSideEnum.buy
                  : OrderSideEnum.sell
                : OrderSideEnum.buy,
              this.restart && this.lastFilled
                ? parseFloat(this.lastFilled.price)
                : undefined,
            ).then(async () => {
              this.loadingComplete = true
              await this.runAfterLoading()
            })
          }
        }
        if (this.data.settings.feeOrder && (this.data.feeBalance ?? 0) <= 0) {
          await this.placeFeeOrder(
            this.botId,
            this.swapAssetData?.clientOrderId ?? 'swap order',
          )
        }
      }
      this.endMethod(_id)
      this.handleLog('Swap assets end')
    }
    /**
     * Generate initial grids<br />
     *
     * Get bot settings: top price, low price, levels, sell displacement, grid type<br />
     *
     * Calculate buy and sell prices for all grids from low price to top price
     */
    async generateGrids() {
      this.handleDebug('Generate base grids start')

      this.initialGrid = this.data
        ? await this.generateBasicGrids({
            pair: this.data.settings.pair,
            lowPrice: this.data.settings.lowPrice,
            topPrice: this.data.settings.topPrice,
            levels: this.data.settings.levels,
            sellDisplacement: this.data.settings.sellDisplacement,
            gridType: this.data.settings.gridType,
          })
        : null
      this.handleDebug('Generate base grids end')
    }
    /**
     * Generate current grids<br />
     *
     * Get initial grids<br />
     *
     * Fill them with calculated qty and genereated ids from {@link BotHelper#id}<br />
     *
     * Remove nearest grid to current price, if not set noslice paramater<br />
     *
     * If return grid paramter is set to true returns grids
     *
     * Set current value of {@link BotHelper#grids} set it to {@link BotHelper#prevGrids}<br />
     *
     * If not set all paramater to true - find closest grids for current price {@link BotHelper#findClosestGrids}<br />
     *
     * Set newly created data to {@link BotHelper#grids}
     *
     * @param {number} lastPrice price to calculate grid from
     * @param {boolean} [all] not execute find closest grids. Default = false
     * @param {boolean} [noslice] not remove nearest grid to current price. Default = false
     * @param {boolean} [returnGrid] return grid, not set them to {@link BotHelper#grids}. Default = false
     * @returns {void | Grid[]} return grid if set returnGrid parameter
     */
    async generateCurrentGrids(
      _lastPrice: number,
      _side: OrderSideEnum,
      all?: boolean,
      noslice?: boolean,
    ): Promise<void>
    async generateCurrentGrids(
      _lastPrice: number,
      _side: OrderSideEnum,
      all?: boolean,
      noslice?: boolean,
      returnGrid?: boolean,
    ): Promise<Grid[]>
    async generateCurrentGrids(
      _lastPrice: number,
      _side: OrderSideEnum,
      all = false,
      noslice = false,
      returnGrid = false,
    ): Promise<void | Grid[]> {
      if (!this.data) {
        return
      }
      const {
        pair,
        lowPrice,
        topPrice,
        levels,
        updatedBudget,
        budget,
        useOrderInAdvance,
        ordersInAdvance,
        profitCurrency,
        orderFixedIn,
      } = this.data.settings
      const result = await this.generateGridsOnPrice(
        {
          pair,
          initialGrids: this.initialGrid,
          lowPrice: +lowPrice,
          topPrice: +topPrice,
          levels: +levels,
          updatedBudget,
          _budget: +budget,
          _lastPrice,
          _initialPriceStart: this.data.initialPriceStart,
          _side,
          noslice,
          all,
          ordersInAdvance,
          useOrderInAdvance,
          profitCurrency,
          orderFixedIn,
        },
        undefined,
        this.data.settings.newBalance,
        this.feeOrder,
      )
      if (result) {
        if (returnGrid) {
          return result
        }
        this.prevGrids = this.grids
        this.grids = result
      }

      return []
    }
    /**
     * Count bot balances<br />
     *
     * Get used values from placed orders, that not filled yet, eg. New, Partially filled<br />
     *
     * To get total required values use {@link BotHelper#generateCurrentGrids} and set all flag<br />
     *
     * Set data to {@link BotHelper#data}, save to db, emit them using {@link BotHelper#ioUpdate}
     *
     * @param {number} latestPrice latest price to calculate balances for
     *
     */
    private async countBalances(latestPrice: number) {
      let totalBase = 0
      let totalQuote = 0
      let usedBase = 0
      let usedQuote = 0
      if (this.orders && this.orders.size > 0) {
        this.getOrdersByStatusAndDealId({ defaultStatuses: true }).map((o) => {
          let q = +o.origQty
          let p = +o.price
          if (isNaN(q) || !isFinite(q)) {
            q = 0
          }
          if (isNaN(p) || !isFinite(p)) {
            p = 0
          }
          if (this.futures) {
            if (this.coinm) {
              usedBase += q
            } else {
              usedQuote += q * p
            }
          } else {
            if (o.side === OrderSideEnum.sell) {
              usedBase += q
            } else {
              usedQuote += q * p
            }
          }
        })
        const allOrders = await this.generateCurrentGrids(
          latestPrice,
          OrderSideEnum.buy,
          true,
          false,
          true,
        )
        if (allOrders) {
          allOrders.map((o) => {
            if (this.futures) {
              if (this.coinm) {
                totalBase += o.qty
              } else {
                totalQuote += o.qty * o.price
              }
            } else {
              if (o.side === OrderSideEnum.sell) {
                totalBase += o.qty
              } else {
                totalQuote += o.qty * o.price
              }
            }
          })
        }
      }

      const assets = {
        used: {
          base: this.math.round(usedBase / this.currentLeverage, 10),
          quote: this.math.round(usedQuote / this.currentLeverage, 10),
        },
        required: {
          base: this.math.round(totalBase / this.currentLeverage, 10),
          quote: this.math.round(totalQuote / this.currentLeverage, 10),
        },
      }
      this.updateData({ assets })
      this.emit('bot settings update', { assets })
    }
    /**
     * Update order information previously return as 'unknown order' error <br />
     *
     * If order status = FILLED - run {@link BotHelper#createTransaction}
     *
     * @param {string} id id of the order that needed to find
     */
    private async handleUnknownOrder(order: Order): Promise<void> {
      if (order && order.status === 'FILLED') {
        this.processFilledOrder(order, order.updateTime)
        if (this.restart && !this.swapAssetData) {
          if (this.lastFilled) {
            if (
              this.lastFilled.side === order.side &&
              order.side === 'BUY' &&
              +order.origPrice < +this.lastFilled.origPrice
            ) {
              this.lastFilled = order
            } else if (
              this.lastFilled.side === order.side &&
              order.side === 'SELL' &&
              +order.origPrice > +this.lastFilled.origPrice
            ) {
              this.lastFilled = order
            } else if (this.lastFilled.side !== order.side) {
              this.lastFilled = order
            }
          } else if (!this.lastFilled) {
            this.lastFilled = order
          }
        }
      }
    }
    /** Check orders after socket reconnect */
    async checkOrdersAfterReconnect(_botId: string) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('orders check after reconnect'))
        return
      }
      if (this.blockCheck) {
        return
      }
      if (this.serviceRestart) {
        return
      }
      const _id = this.startMethod('checkOrdersAfterReconnect')
      this.blockCheck = true
      try {
        this.handleLog('Check order after user stream reconnect')
        const filledOrders: Order[] = []
        for (const o of this.getOrdersByStatusAndDealId({
          defaultStatuses: true,
        })) {
          const getOrder = await this.getOrder(o.clientOrderId, o.symbol, false)
          if (!getOrder || !getOrder.data) {
            this.handleWarn(`Not enough data to get order ${o.clientOrderId}`)
            continue
          }
          if (getOrder.status === StatusEnum.notok) {
            this.handleWarn(`Cannot get order ${getOrder.reason}`)
            continue
          }
          const mergedOrder = await this.mergeCommonOrderWithOrder(
            getOrder.data,
            o,
          )
          if (mergedOrder.status !== o.status) {
            this.emit('bot update', mergedOrder)
            this.deleteOrder(mergedOrder.clientOrderId)
            if (mergedOrder.status !== 'CANCELED') {
              this.setOrder(mergedOrder)
            }
            this.handleDebug(
              `${mergedOrder.typeOrder} order ${mergedOrder.clientOrderId} is ${mergedOrder.status}.`,
            )
            this.updateOrderOnDb(mergedOrder)
            if (mergedOrder.status === 'FILLED') {
              filledOrders.push(mergedOrder)
            }
          } else {
            this.handleDebug(
              `${mergedOrder.typeOrder} order ${mergedOrder.clientOrderId} not changed.`,
            )
          }
        }
        const [lastFilled] = filledOrders.sort(
          (a, b) => b.updateTime - a.updateTime,
        )
        if (lastFilled) {
          if (this.reconcileViaSweep) {
            // Greppable health signal: the periodic sweep (not a reconnect)
            // caught order fills the user stream had dropped.
            this.handleLog(
              `reconcile-sweep caught ${filledOrders.length} missed fill(s)`,
            )
            this.recordReconcileSweepCatch(filledOrders.length)
          }
          this.handleDebug(
            `Rebuilding grid after ${lastFilled.clientOrderId}, ${lastFilled.side}, base: ${lastFilled.executedQty}, quote: ${lastFilled.cummulativeQuoteQty}, price: ${lastFilled.price}`,
          )
        }
        for (const o of filledOrders) {
          this.processFilledOrder(
            o,
            o.updateTime,
            o.clientOrderId !== lastFilled.clientOrderId,
          )
        }
      } catch (e) {
        // Never leave blockCheck stuck on a throw — a wedged blockCheck silently
        // freezes all future order checks for this bot (root cause of the
        // user-stream-reconnect stall, community thread 4863).
        this.handleWarn(
          `Check orders after reconnect failed: ${(e as Error).message}`,
        )
      } finally {
        this.blockCheck = false
        this.endMethod(_id)
      }
    }
    /** Check orders after service restart */
    private async checkOrders(_lastPrice?: number | null) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('orders check'))
        return
      }
      if (this.blockCheck) {
        return
      }
      const _id = this.startMethod('checkOrders')
      this.blockCheck = true
      try {
        if (this.serviceRestart) {
          if (!this.data) {
            this.blockCheck = false
            this.endMethod(_id)
            return
          }

          const { pair } = this.data.settings
          const ed = await this.getExchangeInfo(pair)
          if (!ed) {
            this.blockCheck = false
            this.endMethod(_id)
            return
          }
          const activeTPSLOrder = this.getOrdersByStatusAndDealId({
            defaultStatuses: true,
          }).find((o) => o.typeOrder === TypeOrderEnum.stop)
          if (activeTPSLOrder) {
            const tpslOrderData = await this.getOrder(
              activeTPSLOrder.clientOrderId,
              pair,
              true,
            )
            if (!tpslOrderData || !tpslOrderData.data) {
              this.handleWarn(
                `Not enough data to get order ${activeTPSLOrder.clientOrderId}`,
              )
            } else if (tpslOrderData.status === StatusEnum.notok) {
              this.handleWarn(`Cannot get order ${tpslOrderData.reason}`)
            } else {
              const updatedOrder = await this.mergeCommonOrderWithOrder(
                tpslOrderData.data,
                activeTPSLOrder,
              )
              if (updatedOrder.status === 'CANCELED') {
                this.deleteOrder(updatedOrder.clientOrderId)
                this.handleDebug(
                  `TP/SL order ${updatedOrder.clientOrderId} is CANCELED.`,
                )
                this.restart = false
                this.serviceRestart = false
                this.updateOrderOnDb(updatedOrder)
                this.blockCheck = false
                this.endMethod(_id)
                return this.processSellAtStop(
                  updatedOrder.type === 'MARKET'
                    ? CloseGRIDTypeEnum.closeByMarket
                    : CloseGRIDTypeEnum.closeByLimit,
                )
              } else if (updatedOrder.status === 'FILLED') {
                this.setOrder(updatedOrder)
                this.handleDebug(
                  `TP/SL order ${updatedOrder.clientOrderId} is FILLED.`,
                )
                this.updateOrderOnDb(updatedOrder)
                this.blockCheck = false
                this.endMethod(_id)
                return this.processFilledOrder(
                  updatedOrder,
                  updatedOrder.updateTime,
                )
              } else if (
                updatedOrder.status === 'PARTIALLY_FILLED' &&
                activeTPSLOrder.status === 'NEW'
              ) {
                this.setOrder(updatedOrder)
                this.handleDebug(
                  `TP/SL order ${updatedOrder.clientOrderId} is PARTIALLY_FILLED.`,
                )
                this.blockCheck = false
                this.endMethod(_id)
                return this.updateOrderOnDb(updatedOrder)
              } else {
                this.handleDebug(
                  `TP/SL order not changed ${updatedOrder.clientOrderId}`,
                )
              }
            }
          }
          const activeSwapOrder = this.getOrdersByStatusAndDealId({
            defaultStatuses: true,
          }).find((o) => o.typeOrder === TypeOrderEnum.swap)
          if (activeSwapOrder) {
            const swapData = await this.getOrder(
              activeSwapOrder.clientOrderId,
              pair,
              true,
            )
            if (!swapData || !swapData.data) {
              this.handleWarn(
                `Not enough data to get order ${activeSwapOrder.clientOrderId}`,
              )
            } else if (swapData.status === StatusEnum.notok) {
              this.handleWarn(`Cannot get order ${swapData.reason}`)
            } else {
              const updatedOrder = await this.mergeCommonOrderWithOrder(
                swapData.data,
                activeSwapOrder,
              )
              if (updatedOrder.status === 'CANCELED') {
                this.swapAssetData = null
                this.handleDebug(
                  `Swap order ${updatedOrder.clientOrderId} is CANCELED.`,
                )
                this.restart = false
                this.serviceRestart = false
                this.updateOrderOnDb(updatedOrder)
                this.blockCheck = false
                this.endMethod(_id)
                return this.swapAssets()
              } else if (updatedOrder.status === 'FILLED') {
                this.swapAssetData = updatedOrder
                this.handleDebug(
                  `Swap order ${updatedOrder.clientOrderId} is FILLED.`,
                )
                this.updateOrderOnDb(updatedOrder)
                this.blockCheck = false
                this.endMethod(_id)
                return this.processFilledSwap(updatedOrder)
              } else if (
                updatedOrder.status === 'PARTIALLY_FILLED' &&
                activeSwapOrder.status === 'NEW'
              ) {
                this.swapAssetData = updatedOrder
                this.handleDebug(
                  `Swap order ${updatedOrder.clientOrderId} is PARTIALLY_FILLED.`,
                )
                this.blockCheck = false
                this.endMethod(_id)
                return this.updateOrderOnDb(updatedOrder)
              } else {
                this.handleDebug(
                  `Swap order not changed ${updatedOrder.clientOrderId}`,
                )
              }
            }
          }
          let lastPrice = _lastPrice
          if (!lastPrice) {
            lastPrice = await this.getLatestPrice(pair)
          }
          if (lastPrice) {
            await this.generateCurrentGrids(
              lastPrice,
              this.lastFilled?.side
                ? this.lastFilled.side === 'BUY'
                  ? OrderSideEnum.buy
                  : OrderSideEnum.sell
                : OrderSideEnum.buy,
            )

            const activeRegularOrders = this.getOrdersByStatusAndDealId({
              defaultStatuses: true,
            }).filter((o) => o.typeOrder === TypeOrderEnum.regular)

            const canceledOrders: Order[] = []
            const filledOrders: Order[] = []
            const partiallyFilledOrders: Order[] = []
            let newOrders: Grid[] = []
            const diff = this.findDiff(
              this.grids,
              activeRegularOrders.map((o) => this.mapOrderToGrid(o, false)),
              true,
            )
            if (diff.new.length > 0) {
              newOrders = diff.new
            }
            if (diff.cancel.length > 0) {
              for (const c of diff.cancel) {
                await this.cancelGridOnExchange(c)
              }
            }
            for (const o of activeRegularOrders.filter(
              (ao) =>
                !diff.cancel
                  .map((c) => c.newClientOrderId)
                  .includes(ao.clientOrderId),
            )) {
              const exchangeData = await this.getOrder(
                o.clientOrderId,
                pair,
                true,
              )
              if (!exchangeData || !exchangeData.data) {
                this.handleWarn(
                  `Not enough data to get order ${o.clientOrderId}`,
                )
              } else {
                if (exchangeData.status === StatusEnum.notok) {
                  this.handleWarn(`Cannot get order ${exchangeData.reason}`)
                } else {
                  const updatedOrder = await this.mergeCommonOrderWithOrder(
                    exchangeData.data,
                    o,
                  )
                  if (updatedOrder.status === 'CANCELED') {
                    this.emit('bot update', updatedOrder)
                    this.deleteOrder(updatedOrder.clientOrderId)
                    this.handleDebug(
                      `Order ${updatedOrder.clientOrderId} is CANCELED.`,
                    )
                    this.updateOrderOnDb(updatedOrder)
                    canceledOrders.push(o)
                  } else if (updatedOrder.status === 'FILLED') {
                    this.emit('bot update', updatedOrder)
                    this.deleteOrder(updatedOrder.clientOrderId)
                    if (this.data?.settings.profitCurrency === 'base') {
                      this.setOrder(updatedOrder)
                    }
                    this.handleDebug(
                      `Order ${updatedOrder.clientOrderId} is FILLED.`,
                    )
                    this.updateOrderOnDb(updatedOrder)
                    filledOrders.push(updatedOrder)
                  } else if (
                    o.status === 'NEW' &&
                    updatedOrder.status === 'PARTIALLY_FILLED'
                  ) {
                    this.emit('bot update', updatedOrder)
                    this.setOrder(updatedOrder)
                    this.handleDebug(
                      `Order ${updatedOrder.clientOrderId} is PARTIALLY_FILLED.`,
                    )
                    this.updateOrderOnDb(updatedOrder)
                    partiallyFilledOrders.push(o)
                  } else {
                    this.handleDebug(
                      `Regular order not changed ${updatedOrder.clientOrderId}`,
                    )
                  }
                }
              }
            }
            if (filledOrders.length > 0) {
              const [lastFilled] = filledOrders.sort(
                (a, b) => b.updateTime - a.updateTime,
              )
              this.handleDebug(
                `Rebuilding grid after ${lastFilled.clientOrderId}, ${lastFilled.side}, base: ${lastFilled.executedQty}, quote: ${lastFilled.cummulativeQuoteQty}, price: ${lastFilled.price}`,
              )
              for (const o of filledOrders) {
                this.processFilledOrder(
                  o,
                  o.updateTime,
                  o.clientOrderId !== lastFilled.clientOrderId,
                )
              }
            }
            for (const o of canceledOrders) {
              this.handleDebug(
                `Send order again ${o.clientOrderId}, ${o.side}, base: ${
                  o.origQty
                }, quote: ${+o.price * +o.origQty}, price: ${o.price}`,
              )
              await this.placeRegularOrder(this.mapOrderToGrid(o), ed)
            }
            for (const g of newOrders) {
              if (
                !this.filledWhileLoading.has(`${g.side}-${g.price}-${g.qty}`)
              ) {
                this.handleDebug(
                  `Order wasn't found in orders, but must be in grid ${
                    g.side
                  }, base: ${g.qty}, quote: ${g.price * g.qty}, price: ${g.price}`,
                )
                await this.placeRegularOrder(g, ed)
              }
            }
          }
          this.serviceRestart = false
        }
        this.blockCheck = false
        this.endMethod(_id)
      } catch (e) {
        // Never leave blockCheck stuck on a throw (see checkOrdersAfterReconnect).
        this.handleWarn(`Check orders failed: ${(e as Error).message}`)
        this.blockCheck = false
        this.endMethod(_id)
      }
    }
    /** Place regular order */
    private async placeRegularOrder(order: Grid, ed: ClearPairsSchema) {
      if (!this.isOrderExist(order, TypeOrderEnum.regular)) {
        const currentSide =
          this.futuresStrategy === FuturesStrategyEnum.long
            ? PositionSide.LONG
            : this.futuresStrategy === FuturesStrategyEnum.short
              ? PositionSide.SHORT
              : PositionSide.BOTH
        const reduce =
          (order.side === OrderSideEnum.buy &&
            currentSide === PositionSide.SHORT) ||
          (order.side === OrderSideEnum.sell &&
            currentSide === PositionSide.LONG)
        this.ordersInProgress.add(order.newClientOrderId)
        const r = await this.sendGridToExchange(
          order,
          {
            type: 'LIMIT',
            reduceOnly: reduce || undefined,
            positionSide: this.hedge ? currentSide : PositionSide.BOTH,
          },
          ed,
        )
        this.ordersInProgress.delete(order.newClientOrderId)
        return r
      } else {
        this.handleDebug(
          `Grid already exist qty: ${order.qty}, price: ${order.price}, side: ${order.side}`,
        )
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}processFeeOrder`)
    private async processFeeOrder(_botId: string, order: Order) {
      const { clientOrderId, typeOrder, symbol, executedQty, price } = order
      if (!this.data) {
        return
      }
      if (this.feeProcessed.has(clientOrderId)) {
        return
      }
      this.feeProcessed.add(clientOrderId)
      if (typeOrder !== TypeOrderEnum.fee) {
        this.handleWarn(
          `Fee order grid | Order not fee type ${clientOrderId} ${typeOrder}`,
        )
        return
      }
      const fee = await this.getUserFee(symbol)
      this.handleDebug(`Fee order grid | Process fee order ${clientOrderId}`)
      const size =
        (!this.isShort ? +executedQty : +executedQty * +price) *
        (1 - (fee?.maker ?? 0))
      this.data.feeBalance = (this.data.feeBalance ?? 0) + size
      this.updateData({ feeBalance: this.data.feeBalance })
      this.emit('bot settings update', { feeBalance: this.data.feeBalance })
    }

    @IdMute(mutex, (botId: string) => `${botId}placeFeeOrderCombo`)
    private async placeFeeOrder(_botId: string, orderId: string) {
      if (!this.data) {
        return
      }
      if (!this.data.settings.feeOrder) {
        return
      }
      if (this.feeOrders.has(orderId)) {
        this.handleDebug(`Fee order grid | Order ${orderId} already processed`)
        return
      }
      this.feeOrders.add(orderId)

      const order = await this._placeFeeOrder(
        this.botId,
        this.data.settings.pair,
        !this.isShort ? OrderSideEnum.buy : OrderSideEnum.sell,
        0,
      )
      if (order && order.status === 'FILLED') {
        this.processFeeOrder(this.botId, order)
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
    /**
     * Place and cancel orders<br />
     *
     * Get latest price using {@link BotHelper#getLatestPrice}<br />
     *
     * Generate current grids for given price<br />
     *
     * Run {@link BotHelper#findDiff}<br />
     *
     * Cancel and place orders from returned<br />
     *
     * After each order emit update via {@link BotHelper#ioUpdate}<br />
     *
     * After executing run {@link BotHelper#generateCurrentBalances}<br />
     *
     * If bot has only buy or sell orders - set status 'range' and stop counting working time
     *
     * @param {number} [latestPrice] Latest price to count
     */
    @IdMute(mutex, (botId: string) => `${botId}`)
    async limitOrders(
      _botId: string,
      side: OrderSideEnum,
      latestPrice?: number,
      realOrders?: boolean,
    ): Promise<void> {
      if (!this.data || this.data.status === BotStatusEnum.closed) {
        return
      }
      const _id = this.startMethod('limitOrders')
      const { pair } = this.data.settings
      const ed = await this.getExchangeInfo(pair)
      if (!ed) {
        this.endMethod(_id)
        return
      }
      let lastPrice = 0
      if (latestPrice && !realOrders) {
        lastPrice = latestPrice
      } else if (!realOrders) {
        const lastPriceRequest = await this.getLatestPrice(pair)
        if (lastPriceRequest !== 0) {
          lastPrice = lastPriceRequest
        }
      }
      if (!realOrders) {
        await this.generateCurrentBalances(lastPrice, side)
        if (this.blockLimit) {
          this.endMethod(_id)
          return
        }
        await this.generateCurrentGrids(lastPrice, side)
      }
      const orderSettings = this.findDiff(
        this.grids,
        realOrders
          ? this.getOrdersByStatusAndDealId({ status: 'NEW' }).map((o) =>
              this.mapOrderToGrid(o, false),
            )
          : this.prevGrids,
      )
      if (orderSettings && this.exchange && this.data) {
        if (this.data?.status !== BotStatusEnum.open && !realOrders) {
          this.restoreFromRangeOrError()
        }
        /**
         * Cancel all unnecessery orders, remove them from orders property
         */
        for (const order of orderSettings.cancel) {
          const result = await this.cancelGridOnExchange(order)
          if (result && !realOrders) {
            await this.countBalances(lastPrice)
          }
          if (result?.status === 'FILLED') {
            this.handleUnknownOrder(result)
          }
        }
        if (realOrders) {
          this.endMethod(_id)
          return
        }
        if (this.data.exchange === ExchangeEnum.kucoin) {
          await utils.sleep(300)
        }
        let i = 0
        /**
         * Add new orders, add them to orders property
         */
        for (const order of [...orderSettings.new].sort(
          (a, b) =>
            Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice),
        )) {
          i++
          const get = this.getOrderFromMap(order.newClientOrderId)
          if (get && get.status !== 'CANCELED') {
            this.handleLog(`Order duplicate: ${order.newClientOrderId}`)
            continue
          }
          const result = await this.placeRegularOrder(order, ed)
          if (result) {
            await this.countBalances(lastPrice)
            if (result.status === 'FILLED') {
              this.handleLog(
                `Order ${order.newClientOrderId} filled during placement`,
              )
              this.processFilledOrder(result, result.updateTime)
            }
          }
          if (!result) {
            this.grids = (this.grids ?? []).filter(
              (g) =>
                !(
                  g.price === order.price &&
                  g.qty === order.qty &&
                  g.side === order.side &&
                  g.type === order.type
                ),
            )
          }
          if (this.firstRun) {
            const progress = {
              text: BotProgressCodeEnum.placeOrder,
              stage: i,
              total: orderSettings.new.length,
              isAllowedToCancel: false,
            }
            this.updateProgress(progress)
          }
        }
        if (this.firstRun) {
          this.firstRun = false
        }
        this.sendEndProcess()
        this.avgPrice()
        this.updateLevels(lastPrice, side)
      }
      this.endMethod(_id)
    }
    async processLiquidationOrder(order: Order): Promise<void> {
      if (!this.futures) {
        return
      }
      const { symbol } = order
      this.handleLog(
        `Liquidation order ${order.clientOrderId}/${order.orderId} for ${symbol}`,
      )
      const compareSide =
        this.data?.position.side === PositionSide.LONG
          ? order.side === OrderSideEnum.sell
          : order.side === OrderSideEnum.buy

      const _price = +order.price
      if (
        compareSide &&
        !isNaN(_price) &&
        isFinite(_price) &&
        _price > 0 &&
        this.data?.position.side
      ) {
        if (this.closeOrderTimer) {
          clearTimeout(this.closeOrderTimer)
        }
        if (this.data) {
          if (!this.data || !this.futures || this.data.position.qty === 0) {
            return
          }
          const { qty, price, side } = this.data.position
          const profit =
            side === PositionSide.LONG
              ? _price * qty - price * qty
              : price * qty - _price * qty
          const profitUsd =
            (await this.getUsdRate(this.data.symbol.symbol)) * profit
          this.data.profit = {
            ...this.data.profit,
            total: this.data.profit.total + profit,
            totalUsd: this.data.profit.totalUsd + profitUsd,
            freeTotal: this.data.profit.total + profit,
            freeTotalUsd: this.data.profit.totalUsd + profitUsd,
          }
          this.data.lastPositionChange = +new Date()
          this.updateData({
            profit: this.data.profit,
            lastPositionChange: this.data.lastPositionChange,
          })
          this.emit('bot settings update', {
            profit: this.data.profit,
            lastPositionChange: this.data.lastPositionChange,
          })
          this.handleErrors(
            `Bot stopped due to position liquidation at ${new Date(
              order.updateTime,
            ).toUTCString()}`,
            'processLiquidationOrder',
            '',
            false,
            true,
          )
          this.resetPosition()

          this.stop()
        }
      }
    }
    private async processFeeBalance(order: Order) {
      if (
        this.data?.settings.feeOrder &&
        (!this.isShort
          ? order.side === OrderSideEnum.buy
          : order.side === OrderSideEnum.sell) &&
        this.data &&
        (order.typeOrder === TypeOrderEnum.regular ||
          order.typeOrder === TypeOrderEnum.fee)
      ) {
        const fee = await this.getUserFee(order.symbol)
        const feeSize = !this.isShort
          ? +order.executedQty * (fee?.maker ?? 0)
          : +order.executedQty * +order.price * (fee?.maker ?? 0)
        this.data.feeBalance = (this.data.feeBalance ?? 0) - feeSize
        this.updateData({
          feeBalance: this.data.feeBalance,
        })
        this.emit('bot settings update', { feeBalance: this.data.feeBalance })
        if (
          (this.data.feeBalance ?? 0) <= 0 &&
          order.typeOrder !== TypeOrderEnum.fee
        ) {
          await this.placeFeeOrder(this.botId, order.clientOrderId)
        }
      }
    }
    /**
     * Process filled order from queue<br />
     *
     * Run {@link BotHelper#createTransaction}<br />
     *
     * If true {@link BotHelper#isLastOrder} - run {@link BotHelper#limitOrders}<br />
     *
     * @param {Order} order Order data
     * @param {number} updateTime Update time
     */
    @IdMute(mutex, (order: Order) => `${order.botId}`)
    private async processFilledOrder(
      order: Order,
      updateTime: number,
      skipLimitOrders = false,
    ): Promise<void> {
      if (!this.shouldProceed()) {
        this.handleLog(
          this.notProceedMessage(`processFilledOrder ${order.clientOrderId}`),
        )
        return
      }
      if (this.ordersInProgress.has(order.clientOrderId)) {
        return this.handleDebug(
          `Order ${order.clientOrderId} is in progress, skip filled processing`,
        )
      }
      const _id = this.startMethod('processFilledOrder')
      if (!this.loadingComplete) {
        this.filledWhileLoading.set(
          `${order.side}-${+order.origPrice}-${+order.origQty}`,
          order,
        )
        this.runAfterLoadingQueue.push(() =>
          this.processFilledOrder.bind(this)(
            order,
            updateTime,
            skipLimitOrders,
          ),
        )
        this.endMethod(_id)
        return this.handleLog(
          `Loading not complete yet. Will process ${order.clientOrderId} after`,
        )
      }
      if (order.typeOrder === TypeOrderEnum.stab) {
        this.endMethod(_id)
        return
      }
      if (order.typeOrder === TypeOrderEnum.swap) {
        this.endMethod(_id)
        return this.processFilledSwap(order)
      }
      if (order.typeOrder === TypeOrderEnum.stop) {
        this.stopFilled = true
        this.processFilledStop(order)
        this.stop(true)
        this.endMethod(_id)
        return
      }
      const price = parseFloat(order.origPrice)

      if (order.typeOrder !== TypeOrderEnum.fee) {
        this.createTransaction(order)
        await this.calculatePosition(order)
      }
      if (
        !skipLimitOrders &&
        this.isLastOrder(
          updateTime,
          price,
          order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
        ) &&
        order.typeOrder !== TypeOrderEnum.fee
      ) {
        this.processFeeBalance(order)
        this.lastFilled = order
        this.limitOrders(
          this.botId,
          order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
          price,
        )
      }
      this.endMethod(_id)
    }
    protected resetPosition() {
      if (!this.data || !this.futures) {
        return
      }
      this.data.position = {
        side: PositionSide.LONG,
        qty: 0,
        price: 0,
      }
      this.emit('bot settings update', {
        position: this.data.position,
      })
      this.updateData({ position: this.data.position })
    }
    private async calculatePositionForOrders(orders: Order[]) {
      let pos = {
        side: PositionSide.LONG,
        qty: 0,
        price: 0,
      }
      for (const o of orders.sort((a, b) => a.updateTime - b.updateTime)) {
        const qty = +(o.executedQty ?? '0') || +o.origQty
        const price = +o.price
        pos = await this.calculateAbstractPosition(
          { qty, price, side: o.side, symbol: o.symbol },
          pos,
        )
      }
      return pos
    }
    private async calculatePosition(order: Order) {
      if (!this.data || !this.futures) {
        return
      }

      const qty = +(order.executedQty ?? '0') || +order.origQty
      const price = +order.price
      const current = await this.calculateAbstractPosition(
        { qty, price, side: order.side, symbol: order.symbol },
        this.data.position,
      )
      this.handleDebug(
        `Position after ${order.clientOrderId}, size: ${current.qty}, price: ${current.price}, side: ${current.side}`,
      )
      this.data.position = current
      // Keep a short signed-position breakpoint trail for funding rewind.
      const signedQty =
        (current.side === PositionSide.SHORT ? -1 : 1) * +current.qty
      const positionHistory = [
        ...(this.data.positionHistory ?? []),
        { time: +(order.updateTime ?? Date.now()), qty: signedQty },
      ].slice(-10)
      this.data.positionHistory = positionHistory
      this.updateData({ position: current, positionHistory })
      this.emit('bot settings update', { position: current })
    }
    // ---- Funding fees (Grid: per-bot, offset on the bot) ----

    protected override async startFunding(): Promise<void> {
      if (!this.futures || this.botType !== BotType.grid) {
        return
      }
      const pair = this.data?.settings.pair
      if (!pair) {
        return
      }
      // Initialise the offset to "now" the first time so we don't backfill
      // funding from before the feature existed.
      if (typeof this.data?.funding?.offset !== 'number') {
        const offset = +new Date()
        if (this.data) {
          this.data.funding = {
            total: 0,
            totalUsd: 0,
            offset,
            lastTime: 0,
          }
        }
        await this.updateData({ funding: this.data?.funding })
      }
      const fundingSym = await this.toFundingSymbol(pair)
      if (!fundingSym) {
        return
      }
      await this.subscribeFunding(fundingSym)
      await this.onFundingNotify(this.fundingChannelFor(fundingSym))
    }

    protected override async onFundingNotify(
      channelKey: string,
    ): Promise<void> {
      if (!this.futures || this.botType !== BotType.grid) {
        return
      }
      const fundingSym = this.fundingSymbolFromChannel(channelKey)
      if (!fundingSym) {
        return
      }
      await this.processGridFunding(fundingSym)
    }

    /** Resolve the signed position as of a settlement from the breakpoint trail. */
    private gridQtyResolver(): (eventTime: number) => number {
      const hist = this.data?.positionHistory ?? []
      const pos = this.data?.position
      const currentSigned = pos
        ? (pos.side === PositionSide.SHORT ? -1 : 1) * +pos.qty
        : 0
      return (eventTime: number) => {
        if (!hist.length) {
          return currentSigned
        }
        let qty = hist[0].qty
        for (const bp of hist) {
          if (bp.time <= eventTime) {
            qty = bp.qty
          } else {
            break
          }
        }
        return qty
      }
    }

    @IdMute(mutex, (fundingSym: string) => `${fundingSym}funding`)
    private async processGridFunding(fundingSym: string) {
      const pair = this.data?.settings.pair
      if (!pair) {
        return
      }
      const offset = this.data?.funding?.offset ?? 0
      const result = await this.computeFundingFor(
        fundingSym,
        pair,
        offset,
        this.gridQtyResolver(),
      )
      if (result.applied === 0) {
        return
      }
      this.handleDebug(
        `Funding. Quote: ${result.deltaQuote}, USD: ${result.deltaUsd}, max time: ${result.maxTime}, last time: ${result.lastTime}, applied: ${result.applied}`,
      )
      // Atomic + CAS on the offset (no read-modify-write clobber of concurrent
      // fill writes); also mirror into the in-memory bot.
      await this.db?.updateData(
        { _id: this.botId, 'funding.offset': offset } as any,
        {
          $inc: {
            'funding.total': result.deltaQuote,
            'funding.totalUsd': result.deltaUsd,
            // Grid has no deal close to fold at, and profit.total accumulates
            // (never reset), so fold funding into the headline P&L live.
            'profit.total': result.deltaQuote,
            'profit.totalUsd': result.deltaUsd,
          },
          $set: {
            'funding.offset': result.maxTime,
            'funding.lastTime': result.lastTime,
          },
          $push: {
            'funding.history': { $each: result.entries, $slice: -25 },
          },
        } as any,
      )
      if (this.data) {
        const f = this.data.funding ?? {
          total: 0,
          totalUsd: 0,
          offset,
          lastTime: 0,
          history: [],
        }
        this.data.funding = {
          total: (f.total ?? 0) + result.deltaQuote,
          totalUsd: (f.totalUsd ?? 0) + result.deltaUsd,
          offset: result.maxTime,
          lastTime: result.lastTime,
          history: [...(f.history ?? []), ...result.entries].slice(-25),
        }
        if (this.data.profit) {
          this.data.profit.total =
            (this.data.profit.total ?? 0) + result.deltaQuote
          this.data.profit.totalUsd =
            (this.data.profit.totalUsd ?? 0) + result.deltaUsd
        }
      }
      // Push the change to the UI.
      this.emit('bot settings update', {
        funding: this.data?.funding,
        profit: this.data?.profit,
      })
    }

    /**
     * Sort function for order queue
     */
    private sortQueue(a: ExecutionReport, b: ExecutionReport) {
      if (a.orderTime === b.orderTime) {
        if (a.orderStatus === 'FILLED' && a.orderStatus === b.orderStatus) {
          if (a.side === OrderSideEnum.buy) {
            return parseFloat(a.price) - parseFloat(b.price)
          }
          return parseFloat(b.price) - parseFloat(a.price)
        }
        if (a.side === OrderSideEnum.buy) {
          return parseFloat(b.price) - parseFloat(a.price)
        }
        return parseFloat(a.price) - parseFloat(b.price)
      }
      return a.orderTime - b.orderTime
    }
    /**
     * Cancel all orders<br />
     *
     * Update data in {@link BotHelper#orders}, save to orders collection in db, emit via {@link BotHelper#ioUpdate}<br />
     *
     * After each request run {@link BotHelper#countBalances}<br />
     *
     * @param {boolean} [cancelPartiallyFilled] cancel order with status PARTIALLY FILLED. Default = false
     */
    async cancelAllOrder(
      cancelPartiallyFilled = false,
      setErrors = true,
    ): Promise<void> {
      let lastPrice = 0
      if (this.exchange && this.data && this.orders) {
        const lastPriceRequest = await this.getLatestPrice(
          this.data.settings.pair,
        )
        if (lastPriceRequest !== 0) {
          lastPrice = lastPriceRequest
        }
        const newOrders = this.getOrdersByStatusAndDealId({
          status: cancelPartiallyFilled ? this.orderStatuses : 'NEW',
        })
        let i = 0
        for (const order of newOrders) {
          i++
          const cancel = await this.cancelOrderOnExchange(order, setErrors)

          if (cancel?.status === 'FILLED') {
            await this.handleUnknownOrder(cancel)
          }
          await this.countBalances(lastPrice)
          if (!this.firstRun) {
            const progress = {
              text: BotProgressCodeEnum.cancelOrder,
              stage: i,
              total: newOrders.length,
              isAllowedToCancel: false,
            }
            this.updateProgress(progress)
          }
        }
        this.sendEndProcess(true)
      }
    }
    protected async checkPriceToStart() {
      if (!this.data) {
        return true
      }
      const {
        swapType,
        swapSellCount,
        initPriceForStartPrice,
        haveStarted,
        settings: { useStartPrice, startPrice, pair },
      } = this.data
      if (haveStarted) {
        return true
      }
      if (
        useStartPrice &&
        startPrice &&
        startPrice !== '' &&
        startPrice !== '0' &&
        !isNaN(+startPrice)
      ) {
        const latestPrice = await this.getLatestPrice(pair)
        if (latestPrice === 0) {
          return true
        }
        const lp = initPriceForStartPrice ?? latestPrice
        this.swapType = swapType ?? this.swapType
        this.swapSellCount = swapSellCount ?? this.swapSellCount

        if (!swapType) {
          this.updateData({ swapType: this.swapType })
        }
        if (!swapSellCount) {
          this.updateData({ swapSellCount: this.swapSellCount })
        }
        if (!initPriceForStartPrice) {
          this.data.initPriceForStartPrice = lp
          this.updateData({ initPriceForStartPrice: lp })
        }
        if (!initPriceForStartPrice) {
          this.data.previousStatus = BotStatusEnum.open
          this.updateData({ previousStatus: BotStatusEnum.open })
        }
        if (
          (initPriceForStartPrice &&
            initPriceForStartPrice > +startPrice &&
            lp <= +startPrice) ||
          (initPriceForStartPrice &&
            initPriceForStartPrice < +startPrice &&
            lp >= +startPrice)
        ) {
          return true
        }

        if (initPriceForStartPrice && initPriceForStartPrice === +startPrice) {
          return true
        }
        return false
      }
      return true
    }

    override async afterUpdateExchangeInfo(_pairs: Set<string>): Promise<void> {
      const newData = await this.getExchangeInfo(this.data?.settings.pair ?? '')
      const old = this.precisions.get(this.data?.settings.pair ?? '')
      if (
        newData &&
        typeof old !== 'undefined' &&
        newData.priceAssetPrecision < old &&
        this.grids &&
        this.prevGrids &&
        this.initialGrid
      ) {
        this.grids = this.grids.map((g) => ({
          ...g,
          price: this.math.round(g.price, newData.priceAssetPrecision),
        }))
        this.prevGrids = this.prevGrids.map((g) => ({
          ...g,
          price: this.math.round(g.price, newData.priceAssetPrecision),
        }))
        this.initialGrid = this.initialGrid.map((g) => ({
          ...g,
          price: {
            buy: this.math.round(g.price.buy, newData.priceAssetPrecision),
            sell: this.math.round(g.price.sell, newData.priceAssetPrecision),
          },
        }))
      }
    }
    protected clearClassProperties(clearRedis = false, start = false) {
      mutex.clear(this.botId)
      this.lastLogs = []
      this.lastMethods = []
      this.currentMethods = new Map()
      this.zeroFee = false
      if (this.closeOrderTimer) {
        clearTimeout(this.closeOrderTimer)
        this.closeOrderTimer = null
      }
      this.swapAssetsStarted = false
      this.stopFilled = false
      this.blockLimit = false
      this.swapAssetData = null
      this.grids = null
      this.initialGrid = null
      this.prevGrids = null
      this.swapLock = false
      this.orders = new Map()
      this.orderStatusMap = new Map()
      this.orderDealMap = new Map()
      this.lockTpSlCheck = false
      this.lockProcessQueueMethod = false
      this.lastFilled = null
      this.userStreamInitialStart = true
      this.blockCheck = false
      this.ignoreErrors = false
      this.runAfterLoadingQueue = []
      this.pairsNotFound = new Set()
      this.stopPriceTimer()
      if (clearRedis) {
        this.clearRedis()
      }
      if (this.statsTimer) {
        clearTimeout(this.statsTimer)
      }
      this.lastStatsCheck = 0
      if (start) {
        if (this.closeTimer) {
          this.handleLog(`Clear close timer`)
          clearTimeout(this.closeTimer)
          this.closeTimer = null
        }
        this.setStatsTimer()
      }
      this.precisions = new Map()
    }
    /**
     * Start bot<br />
     *
     * Call {@link BotHelper#loadData} to load bot data from db, create exchange provider<br />
     *
     * Call {@link BotHelper#loadOrders} to load bot order from db<br />
     *
     * Call {@link BotHelper#fillExchangeInfo} to get symbol data from exchange<br />
     *
     * Call {@link BotHelper#cancelAllOrder} to cancel all previous orders to prevent overwriting new orders<br />
     *
     * Call {@link BotHelper#getUserFees} to get current fee for user for bot pair<br />
     *
     * Call {@link BotHelper#loadTodayProfit} to update todays bot profit<br />
     *
     * Call {@link BotHelper#getActiveOrders} to get active orders for bot pair, to check if bot not exceed the limit of orders<br />
     *
     * Call {@link BotHelper#generateGrids} to generate inital prices for grids<br />
     *
     * Call {@link BotHelper#connectAccountStream} to set callback to user account stream<br />
     *
     * Call {@link BotHelper#checkAssets} to set user asstes to {@link BotHelper#userFee}<br />
     *
     * Call {@link BotHelper#swapAssets} to place swap order if needed<br />
     *
     * If bot status not range - if working shift not started - run new working shift, save changes to db, send update vie {@link BotHelper#ioUpdate}  <br />
     */
    async start(): Promise<void> {
      const _id = this.startMethod('start')
      this.finishLoad = false
      this.clearClassProperties(undefined, true)
      const data = await this.loadData()
      if (data) {
        this.serviceRestart = false
        this.finishLoad = true
        this.endMethod(_id)
        return await this.stop()
      }
      if (this.data?.status === BotStatusEnum.archive) {
        this.serviceRestart = false
        this.finishLoad = true
        this.endMethod(_id)
        return await this.stop()
      }
      if (this.data?.exchangeUnassigned) {
        this.handleErrors(`Bot exchange unassigned. Bot will stop`, 'start')
        this.serviceRestart = false
        this.finishLoad = true
        this.endMethod(_id)
        return await this.stop()
      }
      if (
        this.hedge &&
        this.futures &&
        this.futuresStrategy === FuturesStrategyEnum.neutral
      ) {
        this.handleErrors(
          `Bot cannot run in hedge mode. Bot will stop`,
          'start',
        )
        this.serviceRestart = false
        this.finishLoad = true
        this.endMethod(_id)
        return await this.stop()
      }
      try {
        this.startPriceTimer()
        this.startConsumerHeartbeat()
        const checkStartCondition = await this.checkPriceToStart()
        this.handleLog(`Check start condition: ${checkStartCondition}`)
        if (checkStartCondition && this.data && !this.data.haveStarted) {
          this.data.haveStarted = true

          this.updateData({
            haveStarted: true,
            //@ts-ignore
            swapType: null,
            //@ts-ignore
            swapSellCount: null,
            //@ts-ignore
            initPriceForStartPrice: null,
          })
        }
        if (this.data) {
          this.data.status = checkStartCondition
            ? BotStatusEnum.open
            : BotStatusEnum.range
        }
        if (this.data && this.profitCurrencyChanged) {
          this.profitCurrencyChanged = false
          const price = await this.getLatestPrice(this.data.settings.pair)
          if (price !== 0) {
            const old = this.data.profit.total
            const oldFree = this.data.profit.freeTotal
            this.data.profit.total =
              old *
              (this.data.settings.profitCurrency === 'base' ? 1 / price : price)
            this.data.profit.freeTotal =
              oldFree *
              (this.data.settings.profitCurrency === 'base' ? 1 / price : price)
            this.emit('bot settings update', { profit: this.data.profit })
            this.updateData({ profit: this.data.profit })
            this.handleLog(
              `Profit currency changed. Recalculate profit. Old: ${old}, new: ${this.data.profit.total}`,
            )
          }
        }
        await this.fillExchangeInfo()

        await this.loadOrders()
        await this.getUserFees()
        await this.generateGrids()
        if (this.data?.initialPrice) {
          await this.generateInitialBalances(
            this.data.initialPrice,
            this.data.initialPriceFrom,
            true,
          )
        }
        if (
          this.serviceRestart &&
          !this.data?.realInitialBalances &&
          !this.data?.lastBalanceChange
        ) {
          this.handleLog('Last balance change not set, perform full restart')
          this.serviceRestart = false
        }
        this.avgPrice()
        if (!this.serviceRestart) {
          await this.cancelAllOrder()
          if (!this.restart) {
            if (this.data) {
              this.handleLog('Reset real initial balances by start')
              this.data.realInitialBalances = null
              this.data.lastBalanceChange = null
              this.updateData({
                realInitialBalances: null,
                lastBalanceChange: null,
              })
            }
          }
        }
        if (this.pairsNotFound.size) {
          this.handleWarn(`Exchange info not found. Bot will stop`)
          this.ignoreErrors = true
          this.serviceRestart = false
          await this.stop()
          if (this.data) {
            this.data.status = BotStatusEnum.closed
            await this.updateData({ status: this.data.status })
            this.emit('bot settings update', { status: this.data.status })
            this.ignoreErrors = false
            this.finishLoad = true
            this.endMethod(_id)
            return
          }
          this.ignoreErrors = false
        }
        if (this.data) {
          const { pair } = this.data.settings
          const ed = await this.getExchangeInfo(pair)
          const activeOrders = await this.getActiveOrders(pair)
          let thisActiveOrders =
            (this.data?.settings.useOrderInAdvance &&
            this.data.settings.ordersInAdvance
              ? this.data.settings.ordersInAdvance
              : this.data?.settings.levels) || 0
          const thisNewOrders = this.getOrdersByStatusAndDealId({
            defaultStatuses: true,
          }).length

          if (thisNewOrders > 0) {
            thisActiveOrders = thisActiveOrders - thisNewOrders
          }
          if (
            activeOrders + thisActiveOrders > (ed?.maxOrders || 0) &&
            !this.data?.paperContext
          ) {
            this.serviceRestart = false
            this.finishLoad = true
            this.endMethod(_id)
            return this.handleErrors(
              `This bot cannot run, due to max amout of orders on this symbol.\nMax amount - ${ed?.maxOrders}, active orders - ${activeOrders}, this bot orders - ${thisActiveOrders}`,
              'start()',
            )
          }
        }

        if (checkStartCondition) {
          await this.swapAssets()
        }
        if (this.data) {
          if (this.data.status === 'open') {
            const lastShift =
              this.data.workingShift[this.data.workingShift.length - 1]
            if (lastShift && lastShift.end) {
              this.data.workingShift = [
                ...this.data.workingShift,
                { start: new Date().getTime() },
              ]
            }
            if (!lastShift) {
              this.data.workingShift = [
                {
                  start: new Date().getTime(),
                },
              ]
            }
            const data = {
              status: 'open' as BotStatusEnum.open,
              workingShift: this.trimWorkingShift(this.data.workingShift),
              workingTimeNumber: this.getWorkingTimeNumber(),
            }
            this.updateData(data)
            this.emit('bot settings update', data)
          }
          if (this.data.status === BotStatusEnum.range) {
            const data = { status: this.data.status }
            this.updateData(data)
            this.emit('bot settings update', data)
          }
        }

        if (this.restart) {
          this.restart = false
        }
        if (this.serviceRestart) {
          this.serviceRestart = false
        }
        this.finishLoad = true
      } catch (e) {
        this.serviceRestart = false
        this.handleErrors(
          `Get error during bot start`,
          'start',
          '',
          false,
          false,
          false,
        )
      }
      this.finishLoad = true
      this.secondRestart = false
      this.endMethod(_id)
    }
    protected async profitAfterPositionClosed(result: Order) {
      if (!this.data || !this.futures || this.data.position.qty === 0) {
        return
      }
      const { qty, price, side } = this.data.position
      const profit =
        (side === PositionSide.LONG
          ? +result.price * qty - price * qty
          : price * qty - +result.price * qty) *
        (1 - ((await this.getUserFee(result.symbol))?.maker ?? 0))
      const profitUsd = (await this.getUsdRate(result.symbol)) * profit
      this.data.profit = {
        ...this.data.profit,
        total: this.data.profit.total + profit,
        totalUsd: this.data.profit.totalUsd + profitUsd,
        freeTotal: this.data.profit.total + profit,
        freeTotalUsd: this.data.profit.totalUsd + profitUsd,
      }
      this.updateData({ profit: this.data.profit })
      this.emit('bot settings update', { profit: this.data.profit })
    }
    private async processSellAtStop(
      type: CloseGRIDTypeEnum.closeByLimit | CloseGRIDTypeEnum.closeByMarket,
    ) {
      if (this.data) {
        const { pair } = this.data.settings
        const ed = await this.getExchangeInfo(pair)
        if (!ed) {
          return
        }
        const findTP = this.getOrdersByStatusAndDealId({
          status: ['FILLED', 'PARTIALLY_FILLED'],
        }).find((o) => o.typeOrder === TypeOrderEnum.stop)
        if (!findTP && !this.stopFilled) {
          const price = await this.getLatestPrice(pair)
          await this.cancelAllOrder(true)
          const progress = {
            text: BotProgressCodeEnum.placeStop,
            stage: 0,
            total: 1,
            isAllowedToCancel: false,
          }
          this.updateProgress(progress)
          let result: Order | void
          if (this.futures) {
            result = await this.sendGridToExchange(
              {
                side:
                  this.data.position.side === PositionSide.LONG
                    ? OrderSideEnum.sell
                    : OrderSideEnum.buy,
                qty: this.data.position.qty,
                price: this.math.round(price, ed.priceAssetPrecision),
                newClientOrderId: this.getOrderId(`GRID-TP`),
                number: 0,
                type: TypeOrderEnum.stop,
              },
              {
                type:
                  type === CloseGRIDTypeEnum.closeByLimit ? 'LIMIT' : 'MARKET',
                reduceOnly: true,
                positionSide: this.hedge
                  ? this.futuresStrategy === FuturesStrategyEnum.long
                    ? PositionSide.LONG
                    : this.futuresStrategy === FuturesStrategyEnum.short
                      ? PositionSide.SHORT
                      : PositionSide.BOTH
                  : PositionSide.BOTH,
              },
              ed,
            )
          } else {
            const qtyToSell = await this.sellBaseAmount()

            if (
              qtyToSell * price < ed.quoteAsset.minAmount ||
              qtyToSell < ed.baseAsset.minAmount
            ) {
              this.handleWarn(
                `Cannot place close order. Amount is lower than min allowed by exchange ${qtyToSell}. Executing stop method`,
              )
              return await this.stop(true)
            }
            result = await this.sendGridToExchange(
              {
                side: !this.isShort ? OrderSideEnum.sell : OrderSideEnum.buy,
                qty: qtyToSell,
                price: this.math.round(price, ed.priceAssetPrecision),
                newClientOrderId: this.getOrderId(`GRID-TP`),
                number: 0,
                type: TypeOrderEnum.stop,
              },
              {
                type:
                  type === CloseGRIDTypeEnum.closeByLimit ? 'LIMIT' : 'MARKET',
              },
              ed,
            )
          }
          if (!result || (result && result.status === 'CANCELED')) {
            this.updateProgress()
          }
          if (result && result.status === 'FILLED') {
            this.processFilledStop(result)
          }
          if (result && result.status !== 'FILLED') {
            this.closeOrderTimer = setTimeout(() => {
              this.handleLog('Reposition limit stop order')
              this.processSellAtStop(type)
            }, this.limitRepositionTimeout)
          }
        }
      }
    }
    private async processFilledStop(order: Order) {
      if (this.closeOrderTimer) {
        clearTimeout(this.closeOrderTimer)
      }
      if (this.limitTimer) {
        clearTimeout(this.limitTimer)
      }
      if (this.enterMarketTimer) {
        clearTimeout(this.enterMarketTimer)
      }
      if (this.data) {
        if (!this.futures) {
          const currentBalances = {
            base:
              this.data.currentBalances.base -
              +order.executedQty * (this.isShort ? -1 : 1),
            quote:
              this.data.currentBalances.quote +
              (order.cummulativeQuoteQty
                ? +order.cummulativeQuoteQty
                : +order.price * +order.executedQty) *
                (this.isShort ? -1 : 1),
          }
          const price = +order.price
          if (this.data.settings.feeOrder && this.data.feeBalance) {
            if (!this.isShort) {
              currentBalances.quote -= this.data.feeBalance * price
            } else {
              currentBalances.base -= this.data.feeBalance / price
            }
          }
          currentBalances.base =
            currentBalances.base < 0 ? 0 : currentBalances.base
          currentBalances.quote =
            currentBalances.quote < 0 ? 0 : currentBalances.quote
          const _fee = await this.getUserFee(this.data.symbol.symbol)
          const fee = this.profitBase
            ? +order.executedQty * (_fee?.maker ?? 0)
            : +(
                order.cummulativeQuoteQty ?? +order.price * +order.executedQty
              ) * (_fee?.maker ?? 0)
          const profit = this.profitBase
            ? currentBalances.base +
              currentBalances.quote / price -
              (this.data.initialBalances.base +
                this.data.initialBalances.quote / this.data.initialPrice)
            : currentBalances.base * price +
              currentBalances.quote -
              (this.data.initialBalances.base * this.data.initialPrice +
                this.data.initialBalances.quote)
          const profitUsd =
            (profit - fee) * (await this.getUsdRate(this.data.symbol.symbol))
          if (!this.shouldProceed()) {
            return
          }
          const res = await this.transactionDb.createData({
            updateTime: order.updateTime,
            side: order.side,
            amountBaseBuy:
              order.side === OrderSideEnum.buy ? +order.origQty : 0,
            amountQuoteBuy:
              order.side === OrderSideEnum.buy
                ? +(
                    order.cummulativeQuoteQty ??
                    +order.price * +order.executedQty
                  )
                : 0,
            amountBaseSell:
              order.side === OrderSideEnum.sell ? +order.origQty : 0,
            amountQuoteSell:
              order.side === OrderSideEnum.sell
                ? +(
                    order.cummulativeQuoteQty ??
                    +order.price * +order.executedQty
                  )
                : 0,
            amountFreeBaseBuy: 0,
            amountFreeQuoteBuy: 0,
            amountFreeBaseSell: 0,
            amountFreeQuoteSell: 0,
            priceSell: order.side === OrderSideEnum.sell ? +order.price : 0,
            priceBuy: order.side === OrderSideEnum.buy ? +order.price : 0,
            idBuy: order.side === OrderSideEnum.buy ? order.clientOrderId : '',
            idSell:
              order.side === OrderSideEnum.sell ? order.clientOrderId : '',
            feeBase: this.profitBase ? fee : 0,
            feeQuote: this.profitBase ? 0 : fee,
            profitBase: this.profitBase ? profit : 0,
            profitQuote: this.profitBase ? 0 : profit,
            botId: this.botId,
            userId: this.userId,
            symbol: this.data.settings.pair,
            baseAsset: order.baseAsset,
            quoteAsset: order.quoteAsset,
            profitUsdt: profitUsd,
            freeProfitUsd: profitUsd,
            profitCurrency: this.futures
              ? this.coinm
                ? order.baseAsset
                : order.quoteAsset
              : this.data.settings.profitCurrency === 'base'
                ? order.baseAsset
                : order.quoteAsset,
            paperContext: this.data.paperContext,
            cummulativeProfitBase: this.data.profit.total + profit - fee,
            cummulativeProfitQuote: this.data.profit.total + profit - fee,
            cummulativeProfitUsdt: this.data.profit.totalUsd + profitUsd,
            index: order.clientOrderId,
          })
          if (res.status === StatusEnum.ok) {
            this.emit('bot transaction update', {
              ...res,
              _id: `${res.data._id}`,
            })
          }
          const data = {
            currentBalances,
            feeBalance: 0,
            profit: {
              ...this.data.profit,
              total: this.data.profit.total + profit,
              totalUsd: this.data.profit.totalUsd + profitUsd,
            },
          }

          this.emit('bot settings update', data)
          this.updateData({ ...data })
        }
        this.handleLog('Stop order filled. Processing stop...')
        this.updateProgress()
        this.deleteOrder(order.clientOrderId)
        if (this.futures) {
          await this.profitAfterPositionClosed(order)
          this.resetPosition()
        }
        this.stop()
      }
    }
    /**
     * Stop work<br />
     *
     * Call {@link BotHelper#cancelAllOrder} to cancel all active orders<br />
     *
     * If swap order not filled - cancel swap order<br/>
     *
     * Close bot working shift<br />
     *
     * Send update via {@link BotHelper#ioUpdate}
     *
     * Unsubscribe from {@link BotHelper#ioUser} & {@link BotHelper#ioPrice}
     *
     * @param {boolean} [cancelPartiallyFilled] cancel order with status PARTIALLY FILLED
     *
     */
    async stop(
      cancelPartiallyFilled?: boolean,
      close = CloseGRIDTypeEnum.cancel,
      ignoreErrors = false,
    ): Promise<void> {
      if (this.limitTimer) {
        clearTimeout(this.limitTimer)
      }
      if (this.enterMarketTimer) {
        clearTimeout(this.enterMarketTimer)
      }
      this.ignoreErrors = ignoreErrors
      await this.afterBotStop()
      if (close !== CloseGRIDTypeEnum.cancel) {
        return await this.processSellAtStop(close)
      }
      this.blockLimit = true
      await this.cancelAllOrder(cancelPartiallyFilled, false)
      this.lockTpSlCheck = true
      if (this.exchange && this.data) {
        if (this.swapAssetData && this.swapAssetData.status !== 'FILLED') {
          await this.exchange.cancelOrder({
            symbol: this.data.settings.pair,
            newClientOrderId:
              this.data.exchange === ExchangeEnum.coinbase
                ? `${this.swapAssetData.orderId}`
                : this.swapAssetData.clientOrderId,
          })
        }
      }
      if (this.data) {
        const lastShift =
          this.data.workingShift[this.data.workingShift.length - 1]
        if (lastShift && !lastShift.end) {
          this.data.workingShift = [
            ...this.data.workingShift.filter(
              (w) => w.start !== lastShift.start,
            ),
            { ...lastShift, end: new Date().getTime() },
          ]
        }
        const { pair } = this.data.settings
        const lastPriceRequest = await this.getLatestPrice(pair)
        const lastPrice = lastPriceRequest

        const usdRate = (await this.getUsdRate(pair)) || 1
        if (this.redisSubGlobal) {
          for (const pair of await this.redisSubKeys([...this.pairs])) {
            this.redisSubGlobal.unsubscribe(pair, this.redisSubCb)
          }
        }
        this.closeUserStream()
        const data = {
          workingShift: this.trimWorkingShift(this.data.workingShift),
          workingTimeNumber: this.getWorkingTimeNumber(),
          status: BotStatusEnum.closed,
          previousStatus: BotStatusEnum.closed,
          lastPrice,
          lastUsdRate: usdRate,
          haveStarted: false,
        }
        this.data = { ...this.data, ...data }
        await this.updateData({ ...data })
        this.emit('bot settings update', data)
      }
      this.firstRun = true
      this.swapLock = false
      if (!this.data?.haveStarted) {
        await this.updateData({
          //@ts-ignore
          swapType: null,
          //@ts-ignore
          swapSellCount: null,
          //@ts-ignore
          initPriceForStartPrice: null,
        })
      }
      if (this.data?.status === BotStatusEnum.closed) {
        await this.unsubscribeFromExchangeInfo(this.data.settings.pair)
        await this.unsubscribeFromUserFee(this.data.settings.pair)
        await this.unsubscribeFromUser()
        await this.unsubscribeFromLastUsdData(`${this.data.settings.pair}_base`)
        await this.unsubscribeFromLastUsdData(
          `${this.data.settings.pair}_quote`,
        )
        await this.unsubscribeFromLastStreamData(this.data.settings.pair)
        this.clearClassProperties(true)
        this.sendBotClosed()
      }
      for (const _var of this.data?.vars?.list ?? []) {
        await this.unsubscribeFromGlobalVars(_var)
      }
      this.updateProgress()
      if (this.statsTimer) {
        clearInterval(this.statsTimer)
      }
    }
    @IdMute(mutex, (order: Order) => `${order.botId}stab`)
    async checkBalances(order: Order) {
      if (this.futures) {
        return
      }
      if (!this.data?.realInitialBalances || !this.data.lastBalanceChange) {
        return
      }
      this.handleDebug(`Diff check balances after ${order.clientOrderId}`)
      const orders = await this.ordersDb.readData(
        this.data.exchange === ExchangeEnum.bybit
          ? {
              botId: this.botId,
              status: { $in: ['FILLED', 'PARTIALLY_FILLED', 'CANCELED'] },
              executedQty: { $ne: '0' },
              typeOrder: { $in: [TypeOrderEnum.regular, TypeOrderEnum.stab] },
            }
          : {
              botId: this.botId,
              status: { $in: ['FILLED', 'PARTIALLY_FILLED'] },
              typeOrder: { $in: [TypeOrderEnum.regular, TypeOrderEnum.stab] },
            },
        {},
        undefined,
        true,
        true,
      )
      if (orders.status === StatusEnum.notok) {
        // Via handleErrors, not processError directly: calling processError
        // skips getErrorSubType, so this wrote rows under the ad-hoc subType
        // `readorders`, which exists in no rule and no behaviour row. The admin
        // owner filter could not classify it and no log policy could ever apply
        // to it. Same visibility as before (hidden, non-erroring, no bot event).
        return this.handleErrors(
          `Cannot read orders: ${orders.reason}`,
          'checkBalances',
          'readorders',
          false,
          false,
          false,
        )
      }
      if (orders.data.count === 0) {
        return
      }
      if (!this.data) {
        return
      }
      const { pair } = this.data.settings
      const ed = await this.getExchangeInfo(pair)
      const fee = await this.getUserFee(pair)
      if (!ed || !fee) {
        return
      }
      const filteredOrder = orders.data.result
        .filter(
          (o) =>
            o.updateTime >= (this.data?.lastBalanceChange ?? 0) &&
            o.updateTime <= order.updateTime,
        )
        .filter((o) =>
          this.data?.exchange === ExchangeEnum.bybit
            ? +o.executedQty > 0
            : true,
        )
      const last = order
      if (!last) {
        // See the note above — `noelem` was the same unclassifiable bypass.
        return this.handleErrors(
          `Cannot find last order in Diff`,
          'checkBalances',
          'noelem',
          false,
          false,
          false,
        )
      }

      const currentGrids = await this.generateCurrentGrids(
        +last.origPrice,
        last.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
        true,
        false,
        true,
      )
      const f = this.futures ? 0 : fee.maker
      const sell = filteredOrder
        .filter((o) => o.side === 'SELL')
        .reduce((acc, v) => acc + +v.origQty, 0)
      const buyQty = filteredOrder
        .filter((o) => o.side === 'BUY')
        .reduce((acc, v) => acc + +v.origQty, 0)
      const buy = buyQty * (1 - f)
      const sellQuoteQty = filteredOrder
        .filter((o) => o.side === 'SELL')
        .reduce((acc, v) => acc + +v.origQty * +v.price, 0)
      const buyQuote = filteredOrder
        .filter((o) => o.side === 'BUY')
        .reduce((acc, v) => acc + +v.origQty * +v.price, 0)
      const diff = buy - sell
      const avgBuy = buy === 0 ? 0 : buyQuote / buyQty
      const avgSell = sell === 0 ? 0 : sellQuoteQty / sell
      const currentBalanceBaseReal =
        this.data.realInitialBalances.base +
        diff -
        (this.data.settings.profitCurrency === 'base'
          ? (this.data.profit.total ?? 0)
          : 0)
      const partFilledQty = filteredOrder
        .filter(
          (fo) =>
            fo.status === 'PARTIALLY_FILLED' && +fo.origQty !== +fo.executedQty,
        )
        .reduce(
          (acc, fo) => acc + +fo.executedQty * (fo.side === 'BUY' ? 1 : -1),
          0,
        )
      const currentBalanceBaseTheoretical =
        currentGrids
          .filter((g) => g.side === OrderSideEnum.sell)
          .reduce((acc, g) => acc + g.qty, 0) + partFilledQty
      const balanceDiff = currentBalanceBaseReal - currentBalanceBaseTheoretical
      const absDiff = Math.abs(balanceDiff)
      const asset = this.data.symbol.baseAsset
      if (absDiff > 0) {
        this.handleDebug(
          `Diff in balance: sell - ${sell} ${asset}, buy - ${buy} ${asset}, real - ${currentBalanceBaseReal} ${asset}, theoretical - ${currentBalanceBaseTheoretical} (${partFilledQty} partially filled) ${asset}, diff - ${balanceDiff} ${asset}`,
        )
        const absDiffRounded = this.math.round(
          absDiff,
          await this.baseAssetPrecision(pair),
          true,
        )
        // slippage 1%
        if (absDiffRounded > ed.baseAsset.minAmount * 1.01) {
          const lp = await this.getLatestPrice(pair)
          // slippage 1%
          if (absDiffRounded * lp > ed.quoteAsset.minAmount * 1.01) {
            this.handleDebug(
              `Diff is more than min allowed by exchange. Placing order`,
            )
            const res = await this.sendGridToExchange(
              {
                price: this.math.round(lp, ed.priceAssetPrecision),
                qty: absDiffRounded,
                side: balanceDiff > 0 ? OrderSideEnum.sell : OrderSideEnum.buy,
                number: 1,
                newClientOrderId: this.getOrderId(`GRID-STAB`),
                type: TypeOrderEnum.stab,
              },
              { type: 'MARKET' },
              ed,
            )
            if (res) {
              let profit = 0
              if (
                (!isNaN(avgSell) && isFinite(avgSell) && res.side === 'BUY') ||
                (!isNaN(avgBuy) && isFinite(avgBuy) && res.side === 'SELL')
              ) {
                profit =
                  (res.side === 'SELL'
                    ? +res.price * +res.origQty - avgBuy * +res.origQty
                    : avgSell * +res.origQty - +res.price * +res.origQty) -
                  +res.price * +res.origQty * f
              }
              this.handleDebug(
                `Diff order is filled: profit - ${profit}, id - ${
                  res.clientOrderId
                }, base - ${res.origQty}, quote: - ${
                  +res.origQty * +res.price
                }, price - ${res.price}, side - ${res.side}, time - ${
                  res.updateTime
                }`,
              )
              await this.calculatePosition(res)
            } else {
              this.handleDebug(`Diff order not executed`)
            }
          } else {
            this.handleDebug(`Diff quote is lower than min allowed`)
          }
        } else {
          this.handleDebug(`Diff base is lower than min allowed`)
        }
      } else {
        this.handleDebug(`Diff balance is ${absDiff} (${balanceDiff})`)
      }
    }
    get profitBase() {
      return this.data?.settings.profitCurrency === 'base'
    }
    /**
     * Create transaction<br />
     *
     * For profit in base - find matched orders, down 1 grid buy if current order sell or up 1 grid if current order buy<br />
     *
     * For profit in quote - count profit for sell orders <br />
     *
     * Count fee for every transaction<br />
     *
     * Convert profit to USD<br />
     *
     * Save transaction to transaction collection in db<br />
     *
     * Update bot profit, profit today, transaction count. Save changes to db, emit updates via {@link BotHelper#ioUpdate}
     *
     * @param {Order} o Filled order to sount transaction for
     */
    @IdMute(
      mutex,
      (order: Order) => `${order.botId}transaction${order.clientOrderId}`,
    )
    async createTransaction(o: Order): Promise<void> {
      if (!this.data) {
        return
      }
      const { pair } = this.data.settings
      const ed = await this.getExchangeInfo(pair)
      const fee = await this.getUserFee(pair)
      if (!ed || !fee) {
        return
      }
      const read = await this.transactionDb.countData({
        index: o.clientOrderId,
      })
      if (read.status === StatusEnum.ok && read.data.result) {
        this.handleDebug(
          `Transaction already exists with executor ${o.clientOrderId}`,
        )
        return
      }
      this.updateUserProfitStep()
      if (this.initialGrid && this.exchange) {
        const prices = this.initialGrid.map((ig) => ig.price)
        prices[prices.length - 1].buy = this.math.round(
          this.data.settings.topPrice,
          ed.priceAssetPrecision,
        )
        const grids = await this.generateCurrentGrids(
          this.data.settings.topPrice * 2,
          OrderSideEnum.buy,
          true,
          true,
          true,
        )
        const qty = parseFloat(o.origQty)
        const price = parseFloat(o.price)
        let comBase = o.side === OrderSideEnum.buy ? qty * fee.maker : 0
        let comQuote =
          o.side === OrderSideEnum.sell ? qty * price * fee.maker : 0
        let profitQuote = 0
        let matchedPrice = 0
        let matchQty = 0
        let profitBase = 0
        let profitFreeBase = 0
        let profitFreeQuote = 0
        let matchedId = ''
        let profitUsdt = 0
        let freeProfitUsd = 0
        let amountBaseBuy = o.side === 'SELL' ? 0 : parseFloat(o.origQty)
        let amountFreeBaseBuy = amountBaseBuy
        let amountQuoteBuy =
          o.side === 'SELL' ? 0 : parseFloat(o.origQty) * parseFloat(o.price)
        let amountFreeQuoteBuy = amountQuoteBuy
        let amountBaseSell = o.side === 'BUY' ? 0 : parseFloat(o.origQty)
        let amountFreeBaseSell = amountBaseSell
        let amountQuoteSell =
          o.side === 'BUY' ? 0 : parseFloat(o.origQty) * parseFloat(o.price)
        let amountFreeQuoteSell = amountQuoteSell
        if (this.data.settings.newProfit && !this.futures) {
          if (o.side === OrderSideEnum.sell && this.profitBase) {
            comBase = comQuote / price
          }
          if (o.side === OrderSideEnum.buy && !this.profitBase) {
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
          }).filter((o) => o.typeOrder === TypeOrderEnum.regular)

          const match = filledOrders.find(
            (g) =>
              parseFloat(g.origPrice) ===
                (o.side === OrderSideEnum.sell
                  ? prices[index - 1]?.buy || 0
                  : prices[index + 1]?.sell || 0) &&
              g.side !== o.side &&
              g.updateTime < o.updateTime,
          )
          const needMatch = !this.isShort
            ? o.side === OrderSideEnum.buy ||
              (this.data.initialPriceStart &&
                o.side === OrderSideEnum.sell &&
                +o.price <= this.data.initialPriceStart)
            : o.side === OrderSideEnum.sell ||
              (this.data.initialPriceStart &&
                o.side === OrderSideEnum.buy &&
                +o.price >= this.data.initialPriceStart)
          let matchedFreeQty = 0
          let matchedFreePrice = 0
          if (!needMatch && !match) {
            this.deleteOrder(o.clientOrderId)
            matchedId = 'initial price'
            matchQty = !this.isShort
              ? +o.executedQty
              : (+o.executedQty * +o.price) /
                (this.data.initialPriceStart ?? +o.price)
            matchedPrice = this.data.initialPriceStart ?? +o.price
            let selfFind = prices.findIndex((p) =>
              this.isShort ? p.buy === +o.origPrice : p.sell === +o.origPrice,
            )
            if (selfFind === -1) {
              selfFind = prices.findIndex((p) =>
                this.isShort ? p.sell === +o.origPrice : p.buy === +o.origPrice,
              )
            }
            const correspondingOrder = grids.find(
              (g) =>
                g.price ===
                  (selfFind === -1 ||
                  (this.isShort
                    ? selfFind === prices.length - 1
                    : selfFind === 0)
                    ? prices.find((p) =>
                        this.isShort
                          ? p.buy === +o.origPrice
                          : p.sell === +o.origPrice,
                      )?.[this.isShort ? 'sell' : 'buy']
                    : prices[this.isShort ? selfFind + 1 : selfFind - 1]?.[
                        this.isShort ? 'sell' : 'buy'
                      ]) && g.side !== o.side,
            )
            if (correspondingOrder) {
              matchedFreeQty = correspondingOrder.qty
              matchedFreePrice = correspondingOrder.price
              if (
                (this.profitBase && !this.isShort) ||
                (!this.profitBase && this.isShort)
              ) {
                matchQty = correspondingOrder.qty
                matchedPrice = correspondingOrder.price
                matchedFreeQty = 0
                matchedFreePrice = 0
              }
            }
          } else if (match) {
            this.deleteOrder(o.clientOrderId)
            this.deleteOrder(match.clientOrderId)
            matchedId = match.clientOrderId
            matchQty = parseFloat(match.origQty)
            matchedPrice = parseFloat(match.price)
          }
          if (matchedPrice !== 0) {
            const pnlBase =
              o.side === OrderSideEnum.sell ? matchQty - qty : qty - matchQty
            const pnlQuote =
              o.side === OrderSideEnum.sell
                ? qty * price - matchQty * matchedPrice
                : matchQty * matchedPrice - qty * price
            const pnlFreeBase =
              o.side === OrderSideEnum.sell
                ? (matchedFreeQty || matchQty) - qty
                : qty - (matchedFreeQty || matchQty)
            const pnlFreeQuote =
              o.side === OrderSideEnum.sell
                ? qty * price -
                  (matchedFreeQty || matchQty) *
                    (matchedFreePrice || matchedPrice)
                : (matchedFreeQty || matchQty) *
                    (matchedFreePrice || matchedPrice) -
                  qty * price
            profitBase +=
              pnlBase +
              pnlQuote / (o.side === OrderSideEnum.buy ? price : matchedPrice)
            profitQuote +=
              pnlQuote +
              pnlBase * (o.side === OrderSideEnum.buy ? price : matchedPrice)
            profitFreeBase +=
              (pnlFreeBase || pnlBase) +
              (pnlFreeQuote || pnlQuote) /
                (o.side === OrderSideEnum.buy
                  ? price
                  : matchedFreePrice || matchedPrice)
            profitFreeQuote +=
              (pnlFreeQuote || pnlQuote) +
              (pnlFreeBase || pnlBase) *
                (o.side === OrderSideEnum.buy
                  ? price
                  : matchedFreePrice || matchedPrice)
            if (o.side === 'BUY') {
              amountBaseSell = matchQty
              amountQuoteSell = matchQty * matchedPrice
              amountFreeBaseSell = matchedFreeQty || matchQty
              amountFreeQuoteSell =
                (matchedFreeQty || matchQty) *
                (matchedFreePrice || matchedPrice)
            }
            if (o.side === 'SELL') {
              amountBaseBuy = matchQty
              amountQuoteBuy = matchQty * matchedPrice
              amountFreeBaseBuy = matchedFreeQty || matchQty
              amountFreeQuoteBuy =
                (matchedFreeQty || matchQty) *
                (matchedFreePrice || matchedPrice)
            }
          }
        } else {
          if (!this.profitBase && !this.futures) {
            if (o.side === OrderSideEnum.buy) {
              comQuote = comBase * price
            }
            if (o.side === OrderSideEnum.sell) {
              let index = prices.findIndex((p) => p.sell === price)
              if (index === -1) {
                index = prices.findIndex((p) => p.buy === price)
              }
              const buyMatch = grids.find(
                (g) =>
                  index !== -1 &&
                  g.price === prices[index - 1].buy &&
                  g.side === OrderSideEnum.buy,
              )
              if (buyMatch) {
                profitBase = buyMatch.qty - qty
                profitQuote =
                  qty * price -
                  buyMatch.qty * buyMatch.price +
                  profitBase * price
                matchedPrice = buyMatch.price
                amountBaseBuy = buyMatch.qty
                amountQuoteBuy = buyMatch.qty * buyMatch.price
              }
            }
            this.deleteOrder(o.clientOrderId)
          }
          if (this.profitBase || this.futures) {
            if (o.side === OrderSideEnum.sell) {
              comBase = comQuote / parseFloat(o.price)
            }
            if (this.futuresStrategy !== FuturesStrategyEnum.neutral) {
              const withMatch =
                (this.futuresStrategy === FuturesStrategyEnum.long &&
                  o.side === OrderSideEnum.sell) ||
                (this.futuresStrategy === FuturesStrategyEnum.short &&
                  o.side === OrderSideEnum.buy)
              if (withMatch) {
                matchedId = 'position price'
                matchQty = this.profitBase
                  ? (price * qty) / (this.data.position.price || price)
                  : qty
                matchedPrice = this.data.position.price || price
                const pnlBase =
                  o.side === OrderSideEnum.sell
                    ? matchQty - qty
                    : qty - matchQty
                const pnlQuote =
                  o.side === OrderSideEnum.sell
                    ? qty * price - matchQty * matchedPrice
                    : matchQty * matchedPrice - qty * price
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
              }).filter((o) => o.typeOrder === TypeOrderEnum.regular)

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
                this.deleteOrder(o.clientOrderId)
                this.deleteOrder(match.clientOrderId)
                matchedId = match.clientOrderId
                matchQty = parseFloat(match.origQty)
                matchedPrice = parseFloat(match.price)
                const pnlBase =
                  o.side === OrderSideEnum.sell
                    ? matchQty - qty
                    : qty - matchQty
                const pnlQuote =
                  o.side === OrderSideEnum.sell
                    ? qty * price - matchQty * matchedPrice
                    : matchQty * matchedPrice - qty * price
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
        const totalQuote =
          profitQuote - (comQuote === 0 ? comBase * price : comQuote)
        const totalFreeQuote =
          (profitFreeQuote || profitQuote) -
          (comQuote === 0 ? comBase * price : comQuote)
        const usdRate = await this.getUsdRate(pair)
        profitUsdt = totalQuote * usdRate
        freeProfitUsd = (totalFreeQuote || totalQuote) * usdRate
        const updateTime = o.updateTime || o.transactTime || 0
        const transaction: Omit<ClearTransactionSchema, '_id'> = {
          updateTime,
          side: o.side,
          amountBaseBuy,
          amountQuoteBuy,
          amountBaseSell,
          amountQuoteSell,
          amountFreeBaseBuy,
          amountFreeQuoteBuy,
          amountFreeBaseSell,
          amountFreeQuoteSell,
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
          symbol: this.data.settings.pair,
          baseAsset: ed.baseAsset.name,
          quoteAsset: ed.quoteAsset.name,
          profitUsdt,
          freeProfitUsd,
          profitCurrency: this.futures
            ? this.coinm
              ? ed.baseAsset.name
              : ed.quoteAsset.name
            : this.data.settings.profitCurrency === 'base'
              ? ed.baseAsset.name
              : ed.quoteAsset.name,
          paperContext: this.data.paperContext,
          cummulativeProfitBase: this.data.profit.total + profitBase - comBase,
          cummulativeProfitQuote:
            this.data.profit.total + profitQuote - comQuote,
          cummulativeProfitUsdt: this.data.profit.totalUsd + profitUsdt,
          index: o.clientOrderId,
        }
        const res = await this.transactionDb.createData(transaction)
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
          this.saveProfitToDb(profitUsdt, res.data.updateTime)
          const data: Partial<BotData> = {
            transactionsCount: {
              buy: this.data?.transactionsCount?.buy
                ? this.data?.transactionsCount?.buy +
                  (o.side === OrderSideEnum.buy ? 1 : 0)
                : o.side === OrderSideEnum.buy
                  ? 1
                  : 0,
              sell: this.data?.transactionsCount?.sell
                ? this.data?.transactionsCount?.sell +
                  (o.side === OrderSideEnum.sell ? 1 : 0)
                : o.side === OrderSideEnum.sell
                  ? 1
                  : 0,
            },
            profit: {
              total: this.data?.profit?.total
                ? this.data?.profit?.total +
                  (this.data.settings.profitCurrency === 'base'
                    ? profitBase - comBase
                    : profitQuote - comQuote)
                : this.data?.settings.profitCurrency === 'base'
                  ? profitBase - comBase
                  : profitQuote - comQuote,
              totalUsd: this.data?.profit?.totalUsd
                ? this.data?.profit?.totalUsd + profitUsdt
                : profitUsdt,
              freeTotal:
                this.data?.profit.freeTotal || this.data.profit.total
                  ? (this.data?.profit?.freeTotal || this.data.profit.total) +
                    (this.data.settings.profitCurrency === 'base'
                      ? (profitFreeBase || profitFreeBase) - comBase
                      : (profitFreeQuote || profitQuote) - comQuote)
                  : this.data?.settings.profitCurrency === 'base'
                    ? (profitFreeBase || profitFreeBase) - comBase
                    : (profitFreeQuote || profitQuote) - comQuote,
              freeTotalUsd:
                this.data.profit.freeTotalUsd || this.data?.profit?.totalUsd
                  ? (this.data.profit.freeTotalUsd ||
                      this.data?.profit?.totalUsd) +
                    (freeProfitUsd || profitUsdt)
                  : freeProfitUsd || profitUsdt,
              pureBase: 0,
              pureQuote: 0,
            },
          }
          if (this.data) {
            this.data.transactionsCount =
              data.transactionsCount || this.data.transactionsCount
            this.data.profit = data.profit || this.data.profit
          }
          this.emit('bot settings update', data)
          this.updateData({ ...data })
          this.emit('bot transaction update', {
            ...transaction,
            _id: `${res.data._id}`,
          })
          this.handleDebug(
            `Transaction saved - ${`${res.data._id}`}, executor - ${
              o.clientOrderId
            }`,
          )
          if (
            ((this.data?.transactionsCount.buy ?? 0) +
              (this.data?.transactionsCount.sell ?? 0)) %
              5 ===
              0 &&
            this.orderQueue.length === 0 &&
            mutex.get(this.botId) === 0
          ) {
            this.limitOrders(this.botId, OrderSideEnum.buy, undefined, true)
          }
        }
      }
    }
    /**
     * Calculate initial balances from initial price<br />
     *
     * Save to db, emit updates via {@link BotHelper#ioUpdate}
     *
     * @param {number} price Initial price to count balances from
     * @param {InitialPriceFromEnum} [from] Initial price from swap order or latest price. Default: swap
     */
    protected async generateInitialBalances(
      price: number,
      from: InitialPriceFromEnum = InitialPriceFromEnum.swap,
      onlyBalances = false,
    ): Promise<void> {
      if (!onlyBalances) {
        const orders = await this.ordersDb.readData(
          { status: 'FILLED', botId: this.botId },
          { price: 1, origQty: 1, side: 1 },
          {},
          true,
        )
        let _price = price
        if (orders.status === StatusEnum.notok) {
          this.handleErrors(
            `Cannot read orders for intial price ${orders.reason}`,
            'initial balances',
            '',
            false,
            false,
            false,
          )
        } else {
          const sell = orders.data.result.filter((o) => o.side === 'SELL')
          const buy = orders.data.result.filter((o) => o.side === 'BUY')
          const sellQuote = sell.reduce(
            (acc, v) => acc + +v.origQty * +v.price,
            0,
          )
          const sellBase = sell.reduce((acc, v) => acc + +v.origQty, 0)
          const buyQuote = buy.reduce(
            (acc, v) => acc + +v.origQty * +v.price,
            0,
          )
          const buyBase = buy.reduce((acc, v) => acc + +v.origQty, 0)
          const pr = !this.isShort ? buyQuote / buyBase : sellQuote / sellBase
          if (pr && !isNaN(pr) && pr > 0) {
            this.handleLog(
              `Set new initial price based on filled orders: ${pr}, parameter price: ${price}`,
            )
            _price = pr
          }
        }
        if (!this.data) {
          return
        }
        const { pair } = this.data.settings
        const usdRate = (await this.getUsdRate(pair)) || 1
        const data: Partial<ClearBotSchema> = {
          initialPrice: _price,
          initialPriceStart: _price,
          initialPriceFrom: from,
          initialPriceStartFrom: from,
          usdRate,
        }
        if (this.data) {
          this.data = { ...this.data, ...data }
        }
        this.emit('bot settings update', data)
        this.updateData({ ...data })
      }
      const initialGrids = await this.generateCurrentGrids(
        price,
        OrderSideEnum.buy,
        true,
        false,
        true,
      )
      let diff = 0
      if (this.data?.settings.newBalance) {
        const allBuys = await this.generateCurrentGrids(
          (this.data?.settings.topPrice ?? price) * 2,
          OrderSideEnum.sell,
          true,
          false,
          true,
        )
        const allBuysQuote = allBuys.reduce(
          (acc, v) => acc + v.qty * v.price,
          0,
        )
        const currentQuote = initialGrids.reduce(
          (acc, v) => acc + v.qty * v.price,
          0,
        )
        diff = Math.max(allBuysQuote - currentQuote, 0)
        this.handleDebug(
          `Calculate diff in generate initial balance ${diff}, all buy - ${allBuysQuote}, current - ${currentQuote}`,
        )
      }
      const initialBalances = {
        base: initialGrids.reduce(
          (acc, v) => (acc += v.side === OrderSideEnum.sell ? v.qty : 0),
          0,
        ),
        quote:
          initialGrids.reduce(
            (acc, v) =>
              (acc += v.side === OrderSideEnum.buy ? v.qty * v.price : 0),
            0,
          ) + diff,
      }
      if (this.data) {
        if (
          (this.data.initialBalances.base !== initialBalances.base ||
            this.data.initialBalances.quote !== initialBalances.quote) &&
          (this.data.initialBalances.base !== 0 ||
            this.data.initialBalances.quote !== 0)
        ) {
          this.handleDebug(
            'Reset real initial balances by initial balance change',
          )
          this.data.realInitialBalances = null
          this.data.lastBalanceChange = null
          this.updateData({
            realInitialBalances: null,
            lastBalanceChange: null,
          })
        }
      }
      const data = {
        initialBalances,
      }
      if (this.data) {
        this.data = { ...this.data, ...data }
      }

      this.emit('bot settings update', data)

      this.updateData({ ...data })
    }
    /**
     * Calculate current balances from current price<br />
     *
     * Save to db, emit updates via {@link BotHelper#ioUpdate}
     *
     * @param {number} price Price to count balances from
     */
    private async generateCurrentBalances(
      price: number,
      side: OrderSideEnum,
    ): Promise<void> {
      const currentGrids = await this.generateCurrentGrids(
        price,
        side,
        true,
        false,
        true,
      )
      let diff = 0
      if (this.data?.settings.newBalance) {
        const allBuys = await this.generateCurrentGrids(
          (this.data?.settings.topPrice ?? price) * 2,
          OrderSideEnum.sell,
          true,
          false,
          true,
        )
        const allBuysQuote = allBuys.reduce(
          (acc, v) => acc + v.qty * v.price,
          0,
        )
        const currentQuote = currentGrids.reduce(
          (acc, v) => acc + v.qty * v.price,
          0,
        )
        diff = Math.max(allBuysQuote - currentQuote, 0)
        this.handleDebug(
          `Calculate diff in generate current balance ${diff}, all buy - ${allBuysQuote}, current - ${currentQuote}`,
        )
      }
      const currentBalances = {
        base: currentGrids.reduce(
          (acc, v) => (acc += v.side === OrderSideEnum.sell ? v.qty : 0),
          0,
        ),
        quote:
          currentGrids.reduce(
            (acc, v) =>
              (acc += v.side === OrderSideEnum.buy ? v.qty * v.price : 0),
            0,
          ) + diff,
      }
      const orders = this.getOrdersByStatusAndDealId({
        defaultStatuses: true,
      })
      const levels = {
        active: {
          buy: orders.filter((o) => o.side === OrderSideEnum.buy).length || 0,
          sell: orders.filter((o) => o.side === OrderSideEnum.sell).length || 0,
        },
        all: {
          buy:
            currentGrids.filter((o) => o.side === OrderSideEnum.buy).length ||
            0,
          sell:
            currentGrids.filter((o) => o.side === OrderSideEnum.sell).length ||
            0,
        },
      }
      const data: Partial<ClearBotSchema> = {
        currentBalances,
        levels,
      }
      if (!this.data?.realInitialBalances || !this.data?.lastBalanceChange) {
        this.handleLog(`Set new real initial balances`)
        data.lastBalanceChange = +new Date()
        data.realInitialBalances = currentBalances
      }
      if (this.data) {
        this.data = { ...this.data, ...data }
      }
      this.emit('bot settings update', data)
      this.updateData({ ...data })
    }
    private async updateLevels(
      price: number,
      side: OrderSideEnum,
    ): Promise<void> {
      const currentGrids = await this.generateCurrentGrids(
        price,
        side,
        true,
        false,
        true,
      )
      const orders = this.getOrdersByStatusAndDealId({
        defaultStatuses: true,
      })
      const levels = {
        active: {
          buy: orders.filter((o) => o.side === OrderSideEnum.buy).length || 0,
          sell: orders.filter((o) => o.side === OrderSideEnum.sell).length || 0,
        },
        all: {
          buy:
            currentGrids.filter((o) => o.side === OrderSideEnum.buy).length ||
            0,
          sell:
            currentGrids.filter((o) => o.side === OrderSideEnum.sell).length ||
            0,
        },
      }
      const data: Partial<ClearBotSchema> = {
        levels,
      }
      if (this.data) {
        this.data = { ...this.data, ...data }
      }
      this.emit('bot settings update', data)
      this.updateData({ ...data })
    }
    /**
     * Function to check if tp/sl condition is met<br />
     *
     * For price reached case - check if current price break the boundaries<br />
     *
     * For value changed case - calculate current value @ current price and initial value @ initial price and check if diff break the boundaries<br/>
     * @param {number} lastPrice Price to check condition for
     * @returns {TpSlReturn}
     */
    tpSl(lastPrice: number): { value: TpSlReturn; text: string } {
      if (this.data && (this.data.settings.tpSl || this.data.settings.sl)) {
        const {
          slLowPrice,
          tpTopPrice,
          tpPerc,
          slPerc,
          tpSlCondition,
          slCondition,
          tpSl,
          sl,
        } = this.data.settings
        const { initialBalances, initialPrice, currentBalances } = this.data
        if (
          tpSlCondition === 'priceReached' &&
          tpTopPrice &&
          tpSl &&
          this.isShort
        ) {
          if (lastPrice <= tpTopPrice) {
            const text = `Last price: ${lastPrice}, TP price: ${tpTopPrice}, TP trigger`
            this.handleLog(text)
            return { text, value: TpSlReturn.tp }
          }
        }
        if (
          slCondition === 'priceReached' &&
          slLowPrice &&
          sl &&
          this.isShort
        ) {
          if (lastPrice >= slLowPrice) {
            const text = `Last price: ${lastPrice}, SL price: ${slLowPrice}, SL trigger`
            this.handleLog(text)
            return { text, value: TpSlReturn.sl }
          }
        }
        if (
          tpSlCondition === 'priceReached' &&
          tpTopPrice &&
          tpSl &&
          !this.isShort
        ) {
          if (lastPrice >= tpTopPrice) {
            const text = `Last price: ${lastPrice}, TP price: ${tpTopPrice}, TP trigger`
            this.handleLog(text)
            return { text, value: TpSlReturn.tp }
          }
        }
        if (
          slCondition === 'priceReached' &&
          slLowPrice &&
          sl &&
          !this.isShort
        ) {
          if (lastPrice <= slLowPrice) {
            const text = `Last price: ${lastPrice}, SL price: ${slLowPrice}, SL trigger`
            this.handleLog(text)
            return { text, value: TpSlReturn.sl }
          }
        }
        if (
          (tpSlCondition === 'valueChanged' &&
            tpPerc &&
            initialPrice &&
            tpSl) ||
          (slCondition === 'valueChanged' && slPerc && initialPrice && sl)
        ) {
          const initialValue =
            initialBalances.base * initialPrice + initialBalances.quote
          if (this.futures) {
            const current = this.data.position
            const diff =
              current.side === PositionSide.LONG
                ? lastPrice - current.price
                : current.price - lastPrice
            const perc = current.price !== 0 ? diff / current.price : 0
            const val = current.qty * perc * lastPrice
            const valueChange = val + this.data.profit.total
            const totalPerc =
              valueChange / (initialValue / this.currentLeverage)
            if (
              tpSlCondition === 'valueChanged' &&
              tpPerc &&
              initialPrice &&
              tpSl
            ) {
              if (totalPerc >= tpPerc) {
                const value = this.math.round(totalPerc * 100)
                const refValue = this.math.round(tpPerc * 100)
                const text = `Position unPnL ${value}%, in settings ${refValue}%, TP trigger`
                this.handleLog(text)
                return { text, value: TpSlReturn.tp }
              }
            }
            if (
              slCondition === 'valueChanged' &&
              slPerc &&
              initialPrice &&
              sl
            ) {
              if (totalPerc <= slPerc) {
                const value = this.math.round(totalPerc * 100)
                const refValue = this.math.round(slPerc * 100)
                const text = `Position unPnL ${value}%, in settings ${refValue}%, SL trigger`
                this.handleLog(text)
                return { text, value: TpSlReturn.sl }
              }
            }
          } else {
            const currentValue =
              currentBalances.base * lastPrice +
              currentBalances.quote +
              this.data.profit.total *
                (this.data.settings.profitCurrency === 'base' ? lastPrice : 1)
            if (
              tpSlCondition === 'valueChanged' &&
              tpPerc &&
              initialPrice &&
              tpSl
            ) {
              const diff = (currentValue - initialValue) / initialValue
              if (diff >= tpPerc) {
                const value = this.math.round(diff * 100)
                const refValue = this.math.round(tpPerc * 100)
                const text = `Initial value: ${initialValue}, current value: ${currentValue}, diff: ${value}%, in settings ${refValue}%, TP trigger`
                this.handleLog(text)
                return { text, value: TpSlReturn.tp }
              }
            }
            if (
              slCondition === 'valueChanged' &&
              slPerc &&
              initialPrice &&
              sl
            ) {
              const diff = (currentValue - initialValue) / initialValue
              if (diff <= slPerc) {
                const value = this.math.round(diff * 100)
                const refValue = this.math.round(slPerc * 100)
                const text = `Initial value: ${initialValue}, current value: ${currentValue}, diff: ${value}%, in settings ${refValue}%, SL trigger`
                this.handleLog(text)
                return { text, value: TpSlReturn.sl }
              }
            }
          }
        }
      }
      return { text: '', value: TpSlReturn.none }
    }
    /**
     * Get base qty to sell if tp/sl action is stop and sell<br />
     *
     * @returns {number} Min amount between user base balance and current balances base amount
     */
    async sellBaseAmount(): Promise<number> {
      if (!this.data) {
        return 0
      }
      const { pair } = this.data.settings
      const ed = await this.getExchangeInfo(pair)
      if (!ed) {
        return 0
      }
      const orders = this.getOrdersByStatusAndDealId({
        defaultStatuses: true,
      })
      if (!this.isShort) {
        const balances = await this.checkAssets(true, true)
        const currentSellOrders = orders
          .filter((o) => o.side === OrderSideEnum.sell)
          .reduce(
            (acc, v) =>
              acc +
              (v.status === 'FILLED'
                ? +v.origQty
                : +v.origQty - +v.executedQty),
            0,
          )
        const currentBuyOrders = orders
          .filter(
            (o) =>
              o.status === 'PARTIALLY_FILLED' && o.side === OrderSideEnum.buy,
          )
          .reduce((acc, v) => acc + +v.executedQty, 0)
        const currentOrders = currentSellOrders + currentBuyOrders

        return this.math.round(
          Math.min(
            (balances?.get(ed.baseAsset.name)?.free ?? 0) + currentOrders,
            (this.data?.currentBalances.base || 0) +
              (this.data.feeBalance ?? 0),
          ),
          await this.baseAssetPrecision(ed.pair),
          true,
        )
      }
      const balances = await this.checkAssets(true, true)
      const currentBuyOrders = orders
        .filter((o) => o.side === OrderSideEnum.buy)
        .reduce(
          (acc, v) =>
            acc +
            (v.status === 'FILLED' ? +v.origQty : +v.origQty - +v.executedQty),
          0,
        )
      const currentSellOrders = orders
        .filter(
          (o) =>
            o.status === 'PARTIALLY_FILLED' && o.side === OrderSideEnum.sell,
        )
        .reduce((acc, v) => acc + +v.executedQty, 0)
      const currentOrders = currentSellOrders + currentBuyOrders

      const latestPrice = await this.getLatestPrice(this.data.symbol.symbol)
      return this.math.round(
        Math.min(
          (balances?.get(ed.quoteAsset.name)?.free ?? 0) / latestPrice +
            currentOrders,
          (this.data?.currentBalances.quote || 0) / latestPrice +
            (this.data.feeBalance ?? 0),
        ),
        await this.baseAssetPrecision(ed.pair),
        true,
      )
    }
    /** Set price timer */
    startPriceTimer() {
      if (this.priceTimer) {
        clearTimeout(this.priceTimer)
      }
      this.priceTimer = setInterval(
        () => this.priceTimerFn(this.botId),
        this.priceTimeout,
      )
    }
    /** Stop price timer */
    stopPriceTimer() {
      if (this.priceTimer) {
        clearTimeout(this.priceTimer)
      }
    }
    async afterBotStop() {
      this.stopPriceTimer()
      this.stopConsumerHeartbeat()
      this.stopQuantRulesRetries()
      return
    }
    /** Check if price not update */

    @IdMute(mutex, (botId: string) => `${botId}priceTimerFn`)
    async priceTimerFn(_botId: string) {
      if (!this.data) {
        return
      }
      const symbol = this.data.symbol.symbol
      const lastStreamData = this.getLastStreamData(symbol)
      if (+new Date() - (lastStreamData?.time ?? 0) < this.priceTimeout) {
        return
      }
      const needPrice =
        this.data.settings.tpSl ||
        this.data.settings.sl ||
        (this.data.settings.useStartPrice && !this.data.haveStarted)
      if (!needPrice) {
        return
      }
      if (this.exchange) {
        this.handleDebug(`Grid Required prices for ${symbol} in price timer`)
        const allPrices = await this.exchange?.getAllPrices(true)
        this.handleDebug(`Get all prices in price timer`)
        if (allPrices.status === StatusEnum.ok) {
          const prices = allPrices.data.filter((p) => p.pair === symbol)
          for (const p of prices) {
            this.priceUpdateCallback(this.botId, {
              symbol: p.pair,
              price: p.price,
              time: +new Date(),
              volume: 0,
            })
          }
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}closeBotByTp`)
    protected async closeBotByTp(
      _botId: string,
      msg: PriceMessage,
      oldTpSl?: ReturnType<typeof this.tpSl>,
      forceMarket = false,
    ) {
      const ed = await this.getExchangeInfo(msg.symbol)
      if (!ed || !this.data) {
        return
      }
      if (oldTpSl) {
        const find = this.allOrders.find(
          (o) => o.typeOrder === TypeOrderEnum.stop,
        )
        if (find?.status === 'PARTIALLY_FILLED') {
          this.handleLog(
            `Found close order with status partially filled ${find.clientOrderId}`,
          )
          return
        }
        if (find?.status === 'FILLED') {
          this.handleLog(
            `Found close order with status filled ${find.clientOrderId}`,
          )
          return
        }
      }
      const { value: result, text } = oldTpSl || this.tpSl(msg.price)
      if (result !== TpSlReturn.none) {
        if (!oldTpSl) {
          const event = result === TpSlReturn.tp ? 'Take Profit' : 'Stop Loss'

          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event,
            botType: this.botType,
            description: `${event} action triggered: ${text}`,
            paperContext: !!this.data?.paperContext,
          })
        }
        if (
          (this.data.settings.tpSlAction === 'stop' &&
            result === TpSlReturn.tp) ||
          (this.data.settings.slAction === 'stop' && result === TpSlReturn.sl)
        ) {
          this.stop()
        } else if (
          (this.data.settings.tpSlAction === 'stopAndSell' &&
            result === TpSlReturn.tp) ||
          (this.data.settings.slAction === 'stopAndSell' &&
            result === TpSlReturn.sl)
        ) {
          this.blockLimit = true
          await this.cancelAllOrder(true)
          const payload: { grid?: Grid; additional?: OrderAdditionalParams } =
            {}
          const price = !oldTpSl
            ? msg.price
            : (await this.getLatestPrice(ed.pair)) || msg.price
          const type = forceMarket
            ? 'MARKET'
            : result === TpSlReturn.sl
              ? this.data.settings.slLimit
                ? 'LIMIT'
                : 'MARKET'
              : this.data.settings.tpSlLimit
                ? 'LIMIT'
                : 'MARKET'
          if (this.futures && this.data.position.qty !== 0) {
            const { side, qty } = this.data.position
            payload.grid = {
              side:
                side === PositionSide.LONG
                  ? OrderSideEnum.sell
                  : OrderSideEnum.buy,
              qty,
              price,
              newClientOrderId: this.getOrderId(`GRID-TP`),
              number: 0,
              type: TypeOrderEnum.stop,
            }
            payload.additional = {
              type,
              reduceOnly: true,
              positionSide: this.hedge
                ? this.futuresStrategy === FuturesStrategyEnum.long
                  ? PositionSide.LONG
                  : this.futuresStrategy === FuturesStrategyEnum.short
                    ? PositionSide.SHORT
                    : PositionSide.BOTH
                : PositionSide.BOTH,
            }
          } else if (!this.futures) {
            const qty = await this.sellBaseAmount()
            if (qty * msg.price < ed.quoteAsset.minAmount) {
              this.handleLog(
                'Cannot place order. Amount is lower than min allowed on exchange. Executing stop method',
              )
              return this.stop(true)
            } else {
              payload.grid = {
                side: !this.isShort ? OrderSideEnum.sell : OrderSideEnum.buy,
                qty,
                price,
                newClientOrderId: this.getOrderId(`GRID-TP`),
                number: 0,
                type: TypeOrderEnum.stop,
              }
              payload.additional = {
                type,
              }
            }
          }
          if (payload.grid && payload.additional) {
            const resultOrder = await this.sendGridToExchange(
              payload.grid,
              payload.additional,
              ed,
            )
            if (resultOrder && resultOrder.status !== 'FILLED') {
              this.startTimeoutTime = +new Date()
              if (
                this.enterMarketTimeout === 0 ||
                (this.enterMarketTimeout !== 0 &&
                  +new Date() + this.orderLimitRepositionTimeout <
                    (this.startTimeoutTime ?? new Date().getTime()) +
                      this.enterMarketTimeout)
              ) {
                this.limitTimer = setTimeout(
                  () =>
                    this.closeBotByTp(this.botId, msg, {
                      value: result,
                      text,
                    }),
                  this.orderLimitRepositionTimeout,
                )
              }

              if (
                this.enterMarketTimeout !== 0 &&
                !this.enterMarketTimer &&
                payload.additional.type === 'LIMIT'
              ) {
                this.enterMarketTimer = setTimeout(
                  () =>
                    this.closeBotByTp(
                      this.botId,
                      msg,
                      {
                        value: result,
                        text,
                      },
                      true,
                    ),
                  this.enterMarketTimeout,
                )
              }
              return
            }
            if (resultOrder && resultOrder.status === 'FILLED') {
              this.handleLog('Stop order filled. Processing stop...')
            }
            if (
              resultOrder &&
              resultOrder.status === 'FILLED' &&
              this.futures
            ) {
              await this.profitAfterPositionClosed(resultOrder)
              this.resetPosition()
            }
            if (
              resultOrder &&
              resultOrder.status === 'FILLED' &&
              !this.futures
            ) {
              const multiplier = resultOrder.side === 'BUY' ? 1 : -1
              const currentBalances = {
                base:
                  this.data.currentBalances.base +
                  +(resultOrder.executedQty || resultOrder.origQty) *
                    multiplier,
                quote:
                  this.data.currentBalances.quote +
                  (resultOrder.cummulativeQuoteQty
                    ? parseFloat(resultOrder.cummulativeQuoteQty)
                    : +resultOrder.price * +resultOrder.executedQty) *
                    multiplier *
                    -1,
              }
              const price = +resultOrder.price
              if (this.data.settings.feeOrder && this.data.feeBalance) {
                if (!this.isShort) {
                  currentBalances.quote -= this.data.feeBalance * price
                } else {
                  currentBalances.base -= this.data.feeBalance / price
                }
              }
              currentBalances.base =
                currentBalances.base < 0 ? 0 : currentBalances.base
              currentBalances.quote =
                currentBalances.quote < 0 ? 0 : currentBalances.quote
              const _fee = await this.getUserFee(this.data.symbol.symbol)
              const fee = this.profitBase
                ? +resultOrder.executedQty * (_fee?.maker ?? 0)
                : +(
                    resultOrder.cummulativeQuoteQty ??
                    +resultOrder.price * +resultOrder.executedQty
                  ) * (_fee?.maker ?? 0)
              const profit = this.profitBase
                ? currentBalances.base +
                  currentBalances.quote / price -
                  (this.data.initialBalances.base +
                    this.data.initialBalances.quote / this.data.initialPrice)
                : currentBalances.base * price +
                  currentBalances.quote -
                  (this.data.initialBalances.base * this.data.initialPrice +
                    this.data.initialBalances.quote)
              const profitUsd =
                (profit - fee) *
                (await this.getUsdRate(this.data.symbol.symbol))
              const res = await this.transactionDb.createData({
                updateTime: resultOrder.updateTime,
                side: resultOrder.side,
                amountBaseBuy:
                  resultOrder.side === OrderSideEnum.buy
                    ? +resultOrder.origQty
                    : 0,
                amountQuoteBuy:
                  resultOrder.side === OrderSideEnum.buy
                    ? +(
                        resultOrder.cummulativeQuoteQty ??
                        +resultOrder.price * +resultOrder.executedQty
                      )
                    : 0,
                amountBaseSell:
                  resultOrder.side === OrderSideEnum.sell
                    ? +resultOrder.origQty
                    : 0,
                amountQuoteSell:
                  resultOrder.side === OrderSideEnum.sell
                    ? +(
                        resultOrder.cummulativeQuoteQty ??
                        +resultOrder.price * +resultOrder.executedQty
                      )
                    : 0,
                amountFreeBaseBuy: 0,
                amountFreeQuoteBuy: 0,
                amountFreeBaseSell: 0,
                amountFreeQuoteSell: 0,
                priceSell:
                  resultOrder.side === OrderSideEnum.sell
                    ? +resultOrder.price
                    : 0,
                priceBuy:
                  resultOrder.side === OrderSideEnum.buy
                    ? +resultOrder.price
                    : 0,
                idBuy:
                  resultOrder.side === OrderSideEnum.buy
                    ? resultOrder.clientOrderId
                    : '',
                idSell:
                  resultOrder.side === OrderSideEnum.sell
                    ? resultOrder.clientOrderId
                    : '',
                feeBase: this.profitBase ? fee : 0,
                feeQuote: this.profitBase ? 0 : fee,
                profitBase: this.profitBase ? profit : 0,
                profitQuote: this.profitBase ? 0 : profit,
                botId: this.botId,
                userId: this.userId,
                symbol: this.data.settings.pair,
                baseAsset: ed.baseAsset.name,
                quoteAsset: ed.quoteAsset.name,
                profitUsdt: profitUsd,
                freeProfitUsd: profitUsd,
                profitCurrency: this.futures
                  ? this.coinm
                    ? ed.baseAsset.name
                    : ed.quoteAsset.name
                  : this.data.settings.profitCurrency === 'base'
                    ? ed.baseAsset.name
                    : ed.quoteAsset.name,
                paperContext: this.data.paperContext,
                cummulativeProfitBase: this.data.profit.total + profit - fee,
                cummulativeProfitQuote: this.data.profit.total + profit - fee,
                cummulativeProfitUsdt: this.data.profit.totalUsd + profitUsd,
                index: resultOrder.clientOrderId,
              })
              if (res.status === StatusEnum.ok) {
                this.emit('bot transaction update', {
                  ...res,
                  _id: `${res.data._id}`,
                })
              }
              const data = {
                currentBalances,
                profit: {
                  ...this.data.profit,
                  total: this.data.profit.total + profit,
                  totalUsd: this.data.profit.totalUsd + profitUsd,
                },
              }
              this.saveProfitToDb(
                profitUsd,
                res.data?.updateTime ?? +new Date(),
              )
              this.emit('bot settings update', data)
              this.updateData({ ...data })
            }
            this.stop(true)
          }
        }
      } else {
        this.lockTpSlCheck = false
      }
    }
    /**
     * Price update callback<br />
     *
     * Call {@link BotHelper#tpSl} to check if tp/sl condition is met<br />
     *
     * If met - if action stop - call {@link BotHelper#stop}, if action stop and sell - get qty to sell {@link BotHelper#sellBaseAmount} if this qty > exchange min amount to place order - place order and call {@link BotHelper#stop}
     *
     * @param {PriceMessage} msg Update from {@link BotHelper#ioPrice}
     */
    @IdMute(
      mutex,
      (botId: string, msg: PriceMessage) => `${botId}price${msg.symbol}`,
      100,
    )
    override async priceUpdateCallback(
      _botId: string,
      msg: PriceMessage,
    ): Promise<void> {
      if (!this.finishLoad) {
        return
      }
      if (msg.symbol !== this.data?.settings.pair) {
        this.lockTpSlCheck = false
        return
      }
      if (!this.lockTpSlCheck) {
        if (+new Date() - (this.lastPriceCheck.get(msg.symbol) ?? 0) < 1000) {
          this.lockTpSlCheck = false
          return
        }
        this.lockTpSlCheck = true
        const time = msg.time ? msg.time : (msg.eventTime ?? msg.time)
        const lastStreamData = this.getLastStreamData(msg.symbol)
        if (time < (lastStreamData?.time ?? 0)) {
          this.lockTpSlCheck = false
          return
        }
        this.setLastStreamData(msg.symbol, { price: msg.price, time })
        if (msg.price === lastStreamData?.price) {
          this.lockTpSlCheck = false
          return
        }

        if (
          +new Date() - (this.lastCheckPerSymbol.get(msg.symbol) ?? 0) >
          60 * 1000
        ) {
          this.lastCheckPerSymbol.set(msg.symbol, +new Date())
          if (this.data) {
            const data: BotParentProcessStatsEventDtoGrid = {
              event: 'processStats',
              botId: this.botId,
              botType: BotType.grid,
              payload: {
                data: msg,
                bot: {
                  _id: this.botId,
                  exchange: this.data.exchange,
                  initialBalances: this.data.initialBalances,
                  initialPrice: this.data.initialPrice,
                  currentBalances: this.data.currentBalances,
                  realInitialBalances: this.data.realInitialBalances,
                  settings: {
                    marginType: this.data.settings.marginType,
                    leverage: this.data.settings.leverage,
                    profitCurrency: this.data.settings.profitCurrency,
                  },
                  position: this.data.position,
                  profit: {
                    total: this.data.profit.total,
                  },
                  stats: this.data.stats,
                },
              },
            }
            DealStats.getInstance().updateStats(data)
          }
        }
        const ed = await this.getExchangeInfo(msg.symbol)
        if (!ed) {
          this.lockTpSlCheck = false
          return
        }

        if (this.data) {
          const {
            initPriceForStartPrice,
            haveStarted,
            settings: { useStartPrice, startPrice },
          } = this.data
          if (!haveStarted && useStartPrice) {
            if (
              startPrice &&
              startPrice !== '' &&
              startPrice !== '0' &&
              !isNaN(+startPrice) &&
              initPriceForStartPrice
            ) {
              if (
                (initPriceForStartPrice <= +startPrice &&
                  msg.price >= +startPrice) ||
                (initPriceForStartPrice >= +startPrice &&
                  msg.price <= +startPrice)
              ) {
                this.handleLog(
                  `Start price reached current: ${msg.price}, init: ${initPriceForStartPrice}, start: ${startPrice}`,
                )
                this.data.haveStarted = true
                this.updateData({
                  haveStarted: true,
                  //@ts-ignore
                  swapType: null,
                  //@ts-ignore
                  swapSellCount: null,
                  //@ts-ignore
                  initPriceForStartPrice: null,
                })
                this.swapAssets()
                this.lockTpSlCheck = false
                return
              }
              if (this.data.status !== BotStatusEnum.range) {
                this.setRangeOrError()
              }
              this.lockTpSlCheck = false
              return
            }
            if (this.data.status !== BotStatusEnum.range) {
              this.setRangeOrError()
            }
            this.lockTpSlCheck = false
            return
          }
          if (
            this.data.status === BotStatusEnum.range &&
            msg.price >= this.data.settings.lowPrice &&
            msg.price <= this.data.settings.topPrice
          ) {
            this.restoreFromRangeOrError()
          }
          if (
            this.data.status === BotStatusEnum.open &&
            (msg.price < this.data.settings.lowPrice ||
              msg.price > this.data.settings.topPrice)
          ) {
            this.setRangeOrError()
          }
        }
        if (this.exchange && this.data) {
          await this.closeBotByTp(this.botId, msg)
        } else {
          this.lockTpSlCheck = false
        }
      }
    }
    /**
     * Calculate avg price for base
     */
    protected async avgPrice() {
      if (this.data && this.data.initialPrice) {
        const currentGrids = await this.generateCurrentGrids(
          this.data.initialPrice,
          OrderSideEnum.buy,
          true,
          false,
          true,
        )
        let currentBase = this.data.initialBalances.base
        let currentQuote = this.data.initialBalances.quote
        if (this.data.settings.profitCurrency === 'base') {
          currentBase += this.data.profit.freeTotal || this.data.profit.total
        }
        if (this.data.settings.profitCurrency === 'quote') {
          currentQuote += this.data.profit.freeTotal || this.data.profit.total
        }
        const latestPrice = this.data.initialPrice
        let avgPrice = this.data.initialPrice
        const currentValue = currentBase * latestPrice + currentQuote
        const initialValue =
          this.data.initialPrice * this.data.initialBalances.base +
          this.data.initialBalances.quote
        let quote = currentQuote
        let base = currentBase
        for (const g of currentGrids
          .filter((cg) =>
            currentValue > initialValue
              ? cg.side === OrderSideEnum.buy
              : currentValue < initialValue
                ? cg.side === OrderSideEnum.sell
                : false,
          )
          .sort((a, b) =>
            currentValue > initialValue
              ? b.price - a.price
              : currentValue < initialValue
                ? a.price - b.price
                : 1,
          )) {
          const currentGridsOnPrice = await this.generateCurrentGrids(
            g.price,
            g.side,
            true,
            false,
            true,
          )
          const newBase =
            currentGridsOnPrice
              .filter((g) => g.side === OrderSideEnum.sell)
              .reduce((acc, v) => acc + v.qty, 0) +
            (this.data.settings.profitCurrency === 'base'
              ? this.data.profit.freeTotal || this.data.profit.total
              : 0)
          const newQuote =
            currentGridsOnPrice
              .filter((g) => g.side === OrderSideEnum.buy)
              .reduce((acc, v) => acc + v.qty * v.price, 0) +
            (this.data.settings.profitCurrency === 'quote'
              ? this.data.profit.freeTotal || this.data.profit.total
              : 0)
          if (
            (currentValue > initialValue &&
              newBase * g.price + newQuote > initialValue) ||
            (currentValue < initialValue &&
              newBase * g.price + newQuote < initialValue)
          ) {
            quote = newQuote
            base = newBase
          } else {
            break
          }
        }
        /*let base = this.data.currentBalances.base
      let quote = this.data.currentBalances.quote
      if (this.data.settings.profitCurrency === 'base') {
        base += this.data.profit?.total
      }
      if (this.data.settings.profitCurrency === 'quote') {
        quote += this.data.profit?.total
      }
      const profit = this.data.profit?.total
      let used = 0
      if (currentGrids.length > 0) {
        for (const g of currentGrids) {
          if (
            (this.data.settings.profitCurrency === 'base' &&
              g.qty <= profit - used) ||
            (this.data.settings.profitCurrency === 'quote' &&
              g.qty * g.price <= profit - used)
          ) {
            const tempQuote = quote - g.qty * g.price
            if (tempQuote >= 0) {
              used +=
                this.data.settings.profitCurrency === 'base'
                  ? g.qty
                  : g.qty * g.price
              quote = tempQuote
              base += g.qty
            }
          } else {
            break
          }
        }
      }*/

        avgPrice = (initialValue - quote) / base
        if (avgPrice === Infinity || avgPrice === -Infinity) {
          avgPrice = 0
        }
        if (isNaN(avgPrice) || this.data.profit.total === 0) {
          avgPrice = this.data.initialPrice
        }
        this.data.avgPrice = avgPrice
        this.emit('bot settings update', { avgPrice })
        this.updateData({ avgPrice })
      }
    }
    /**
     * Reload bot after settings changed
     */
    override async reloadBot(
      _botId: string,
      buyType?: BuyTypeEnum,
      buyCount?: string,
      buyAmount?: number,
      profitCurrencyChanged?: boolean,
    ) {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer)
        this.reloadTimer = null
      }
      if (this.restartProcess) {
        return this.handleLog('Bot already restarting')
      }
      this.handleLog(`Reload bot`)
      const _id = this.startMethod('reloadBot')
      this.restartProcess = true
      await this.cancelAllOrder()
      this.firstRun = true
      if (!buyType) {
        this.restart = true
      } else {
        this.restart = false
        this.swapLock = false
      }
      this.grids = null
      this.prevGrids = null
      this.swapType = buyType ?? BuyTypeEnum.proceed
      this.swapSellCount = buyCount ? +buyCount : 0
      this.swapOrderQty = buyAmount ?? 0
      if (!this.data?.haveStarted) {
        await this.updateData({
          swapType: undefined,
          swapSellCount: undefined,
          initPriceForStartPrice: undefined,
        })
      }
      this.profitCurrencyChanged = !!profitCurrencyChanged
      this.endMethod(_id)
      await this.start()
      this.restartProcess = false
    }
    /**
     * Set new initial price<br />
     *
     * Update avg price<br />
     *
     * @param {number} initialPrice price to set
     */
    setInitialPrice(initialPrice: number) {
      if (this.data) {
        if (initialPrice !== this.data.initialPrice) {
          this.data.initialPrice = initialPrice
          this.emit('bot settings update', { initialPrice })

          this.updateData({ initialPrice })
          this.generateInitialBalances(
            this.data.initialPrice,
            this.data.initialPriceFrom,
            true,
          )
          this.avgPrice()
        }
      }
    }
    @IdMute(mutex, (botId: string) => `${botId}updateLiveStats`)
    async updateLiveStats(_botId: string, time: number) {
      if (!this.data || !this.shouldProceed()) {
        this.handleDebug(`No data or shouldn't proceed for live stats update`)
        return
      }
      if (time < this.lastStatsCheck) {
        this.handleDebug(
          `Time ${time} is before last stats check ${this.lastStatsCheck}`,
        )
        return
      }
      if (this.statsTimer) {
        clearTimeout(this.statsTimer)
      }
      this.handleDebug(`Updating live stats at time ${time}`)
      this.lastStatsCheck = time
      const botStats: CalculateGridLiveStatsParams = {
        bot: {
          _id: this.botId,
          stats: this.data.stats,
          symbol: this.data.symbol,
          initialBalances: this.data.initialBalances,
          initialPrice: this.data.initialPrice,
          usdRate: this.data.usdRate,
          exchange: this.data.exchange,
          profit: this.data.profit,
          status: this.data.status,
          position: this.data.position,
          currentBalances: this.data.currentBalances,
          lastPrice: this.data.lastPrice,
          lastUsdRate: this.data.lastUsdRate,
          workingShift: this.data.workingShift,
          settings: {
            profitCurrency: this.data.settings.profitCurrency,
            marginType: this.data.settings.marginType,
            leverage: this.data.settings.leverage,
            budget: this.data.settings.budget,
            pair: this.data.settings.pair,
            futures: this.data.settings.futures,
          },
        },
      }
      await botMonitor.calculateGridLiveStats(botStats)
      this.setStatsTimer()
    }
  }

  return BotHelper as new (
    id: string,
    exchange: ExchangeEnum,
    log?: boolean,
    serviceRestart?: boolean,
    ignoreStats?: boolean,
  ) => BotHelper & InstanceType<TBaseClass>
}

export default createBotHelper
