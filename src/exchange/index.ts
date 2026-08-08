import { StatusEnum, ExchangeIntervals, MarginType } from '../../types'
import type {
  AccountFill,
  OrderTypes,
  ExchangeInfo,
  BaseReturn,
  FreeAsset,
  CommonOrder,
  UserFee,
  ReturnBad,
  ReturnGood,
  OrderTypeT,
  CandleResponse,
  FundingRateResponse,
  AllPricesResponse,
  PositionSide,
  LeverageBracket,
  PositionInfo,
  TradeResponse,
  CoinbaseKeysType,
  OKXSource,
  BybitHost,
} from '../../types'
import { decrypt, decryptAsync } from '../utils/crypto'
import { isResolverManaged } from '../utils/credentialResolver'

export interface Exchange {
  returnGood<T>(): (r: T) => ReturnGood<T>
  returnBad(): (e: Error) => ReturnBad
  getBalance(): Promise<BaseReturn<FreeAsset>>
  getMarginAvailableUsd(): Promise<BaseReturn<number | null>>
  openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    positionSide: PositionSide
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>>
  getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>>
  cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>>
  latestPrice(symbol: string): Promise<BaseReturn<number>>
  getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>>
  getAllExchangeInfo(): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>>
  getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  getAllOpenOrders(
    symbol: string,
    returnOrders: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  getUserFees(symbol: string): Promise<BaseReturn<UserFee>>
  getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>>
  getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>>
  getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>>
  getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
  ): Promise<BaseReturn<FundingRateResponse[]>>
  getAllPrices(cache?: boolean): Promise<BaseReturn<AllPricesResponse[]>>
  changeMargin(data: {
    symbol: string
    margin: MarginType
    leverage: number
  }): Promise<BaseReturn<MarginType>>
  changeLeverage(data: {
    symbol: string
    leverage: number
  }): Promise<BaseReturn<number>>

  getHedge(_symbol?: string): Promise<BaseReturn<boolean>>

  setHedge(value: boolean): Promise<BaseReturn<boolean>>

  futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>>

  futures_getPositions(symbol?: string): Promise<BaseReturn<PositionInfo[]>>

  getUid(): Promise<BaseReturn<string | number>>

  getAffiliate(uid: string | number): Promise<BaseReturn<boolean>>
}

/** Abstract class for exchanges. Every supported exchange must extends this class */
abstract class AbsctractExchange implements Exchange {
  public key?: string
  public secret?: string
  public passphrase?: string
  public subaccount?: boolean
  /** Constructor method
   * @param {string} key api key
   * @param {string} secret api secret
   */
  public allPricesCachePeriod = 1 * 60 * 1000
  public keysType?: CoinbaseKeysType
  public okxSource?: OKXSource
  public bybitHost?: BybitHost
  /**
   * Set when at least one credential is in a format that only the host
   * application can read, and therefore could not be resolved in the
   * constructor — resolving it is asynchronous and a constructor is not.
   * While true, `key`/`secret`/`passphrase` still hold the stored value.
   */
  private credentialsPending = false
  /** Memoises the in-flight resolution so concurrent calls collapse into one. */
  private credentialsPromise: Promise<void> | null = null
  constructor(
    key?: string,
    secret?: string,
    passphrase?: string,
    _environment?: 'live' | 'sandbox',
    keysType?: CoinbaseKeysType,
    okxSource?: OKXSource,
    bybitHost?: BybitHost,
    subaccount?: boolean,
  ) {
    this.credentialsPending =
      isResolverManaged(key) ||
      isResolverManaged(secret) ||
      isResolverManaged(passphrase)
    if (this.credentialsPending) {
      // Keep the stored values untouched; `ensureCredentials` replaces them
      // with plaintext before the first request that needs them.
      this.key = key
      this.secret = secret
      this.passphrase = passphrase
    } else {
      this.key = key ? decrypt(key) : key
      this.secret = secret ? decrypt(secret) : secret
      this.passphrase = passphrase ? decrypt(passphrase) : passphrase
    }
    this.keysType = keysType
    this.okxSource = okxSource
    this.bybitHost = bybitHost
    this.subaccount = subaccount
  }

  /**
   * Whether anything still needs resolving. Synchronous on purpose: callers
   * check this *before* awaiting, so a build with no resolver registered pays
   * no `await` at all. Awaiting an async function that returns immediately
   * still yields to the microtask queue, which costs a scheduling delay on
   * every request and — worse — makes any timing taken around it a measure of
   * event-loop lag rather than of credential work.
   */
  protected hasPendingCredentials(): boolean {
    return this.credentialsPending
  }

  /**
   * Resolves any credential the constructor had to defer. A no-op — and not
   * even a microtask's worth of work — when nothing was deferred, which is
   * every case where no resolver is registered.
   *
   * Call this at the top of any method that reads `key`/`secret`/`passphrase`.
   * A failure leaves the instance pending rather than half-resolved, so the
   * next attempt retries instead of sending a stored value as if it were
   * plaintext.
   */
  protected async ensureCredentials(): Promise<void> {
    if (!this.credentialsPending) {
      return
    }
    if (!this.credentialsPromise) {
      this.credentialsPromise = (async () => {
        const [key, secret, passphrase] = await Promise.all([
          this.key ? decryptAsync(this.key) : Promise.resolve(this.key),
          this.secret
            ? decryptAsync(this.secret)
            : Promise.resolve(this.secret),
          this.passphrase
            ? decryptAsync(this.passphrase)
            : Promise.resolve(this.passphrase),
        ])
        this.key = key
        this.secret = secret
        this.passphrase = passphrase
        this.credentialsPending = false
      })().catch((e) => {
        // Drop the memo so a later call can retry a transient failure.
        this.credentialsPromise = null
        throw e
      })
    }
    await this.credentialsPromise
  }
  /** Function to handle and format success result */
  returnGood<T>() {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
    })
  }
  /** Function to handle and format error result */
  returnBad() {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
    })
  }
  /** Count price precision */
  getPricePrecision(price: string) {
    let use = price
    // if price exp fromat, 1e-7
    if (price.indexOf('e-') !== -1) {
      use = Number(price).toFixed(parseFloat(price.split('e-')[1]))
    }
    // if price have no 1, 0.00025
    if (use.indexOf('1') === -1) {
      const dec = use.replace('0.', '')
      const numbers = dec.replace(/0/g, '')
      const place = dec.indexOf(numbers)
      if (place <= 1) {
        return place
      }
      //0.0000025
      use = `0.${'0'.repeat(place - 1)}1`
    }
    return use.indexOf('1') === 0 ? 0 : use.replace('0.', '').indexOf('1') + 1
  }
  /**
   * Get Balance abstract function
   *
   * @returns {Promise<BaseReturn>} {asset: string; free: number }[] balances array
   */
  abstract getBalance(): Promise<BaseReturn<FreeAsset>>
  /**
   * USD margin available on a pooled-collateral futures account, or `null` when
   * the venue has no such pool and the quote-asset balance is authoritative.
   * Concrete default lives on the HTTP exchange; the paper simulator keeps the
   * `null` answer, since simulated accounts are already quote-denominated.
   */
  async getMarginAvailableUsd(): Promise<BaseReturn<number | null>> {
    return {
      status: StatusEnum.ok,
      data: null,
      reason: null,
    }
  }

  /**
   * Executions on the account, newest first — read-only reconciliation feed.
   * Empty for every venue that publishes no such history, and for the paper
   * simulator, whose fills we already own in full.
   */
  async getAccountFills(_sinceMs?: number): Promise<BaseReturn<AccountFill[]>> {
    return {
      status: StatusEnum.ok,
      data: [],
      reason: null,
    }
  }
  /** Open order abstract function
   * @param {string} options.symbol pair
   * @param {OrderTypes} options.side BUY or SELL
   * @param {number} options.quantity quantity
   * @param {number} options.price limit price
   * @param {string} options.newClientOrderId order id
   * @return {Promise<BaseReturn<Order>>} Order data
   */
  abstract openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnle?: boolean
    marginType?: MarginType
    leverage?: number
  }): Promise<BaseReturn<CommonOrder>>
  /** Open order abstract function
   * @param {string} options.symbol pair
   * @param {string} options.newClientOrderId order id
   * @return {Promise<BaseReturn<Order>>}  order data
   */
  abstract getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>>
  /** Cancel order
   * @param {string} options.symbol pair
   * @param {string} options.newClientOrderId order id
   * @return {<BaseReturn<Order>>}  order data
   */
  abstract cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>>
  /** Get latest price for a given pair
   * @param {string} symbol symbol to look for
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  abstract latestPrice(
    symbol: string,
    cache?: boolean,
  ): Promise<BaseReturn<number>>
  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @return {Promise<ExchangeInfo>} Promise\<EchangeInfo> for quoted asset: min order, min step, max order, for base asset: min order and for pair max orders
   */
  abstract getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>>
  /** Get exchange info for all pair
   * @return {Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>>} for quoted asset: min order, min step, max order, for base asset: min order and for pair max orders
   */
  abstract getAllExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  >
  /**
   * Authoritative, account-scoped SPOT instruments for an authenticated account.
   * Only OKX Europe (`okxSource=my`) has a per-account universe that diverges from
   * the public feed; the real exchange client overrides this. Default (paper +
   * every other exchange): not supported.
   */
  async getAccountSpotExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  > {
    return this.returnBad()(new Error('Method not supported'))
  }
  /**
   * Authoritative, account-scoped FUTURES instruments for an authenticated
   * account. Only OKX Europe (`okxSource=my`) has X-Perps that diverge from the
   * public feed; the real exchange client overrides this. Default (paper + every
   * other exchange): not supported.
   */
  async getAccountFuturesExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  > {
    return this.returnBad()(new Error('Method not supported'))
  }
  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} returnOrders return orders or orders count
   * @return {Promise<BaseReturn<number>> | Promise<BaseReturn<Order>>} Promise\<BaseReturn> array of opened orders
   */
  abstract getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  abstract getAllOpenOrders(
    symbol: string,
    returnOrders: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  /** Get user fees for given pair
   * @param {string} symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} Promise\<BaseReturn> object of maker and taker fees {maker: number; taker: number}
   */
  abstract getUserFees(symbol: string): Promise<BaseReturn<UserFee>>
  /** Get user fees for all pair
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} Promise\<BaseReturn> object of maker and taker fees {maker: number; taker: number}
   */
  abstract getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>>
  /**
   * Get candles data for given interval
   * @param {string} symbol Symbol
   * @param {ExchangeIntervals} interval Interval
   * @param {number} from From time in ms
   * @param {number} [to] To time in ms
   * @param {number} [count] Data count
   */
  abstract getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>>

  abstract getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>>
  abstract getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
  ): Promise<BaseReturn<FundingRateResponse[]>>
  /**
   * Get all prices
   */
  abstract getAllPrices(
    cache?: boolean,
  ): Promise<BaseReturn<AllPricesResponse[]>>
  abstract changeMargin(data: {
    symbol: string
    margin: MarginType
    leverage: number
  }): Promise<BaseReturn<MarginType>>
  abstract changeLeverage(data: {
    symbol: string
    leverage: number
    side: PositionSide
  }): Promise<BaseReturn<number>>
  abstract getHedge(_symbol?: string): Promise<BaseReturn<boolean>>

  abstract setHedge(value: boolean): Promise<BaseReturn<boolean>>

  abstract futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>>

  abstract futures_getPositions(
    symbol?: string,
  ): Promise<BaseReturn<PositionInfo[]>>
  abstract cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>>
  abstract getUid(): Promise<BaseReturn<string | number>>

  abstract getAffiliate(uid: string | number): Promise<BaseReturn<boolean>>
}

export default AbsctractExchange
