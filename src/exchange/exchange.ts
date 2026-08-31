import AbstractExchange from './index'
import {
  AccountFill,
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  FundingRateResponse,
  CommonOrder,
  ExchangeEnum,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  OrderTypes,
  StatusEnum,
  UserFee,
  MarginType,
  PositionSide,
  LeverageBracket,
  PositionInfo,
  TradeResponse,
  CoinbaseKeysType,
  ExchangeRequestTimeProfile,
  OKXSource,
  BybitHost,
} from '../../types'
import axios, { AxiosError } from 'axios'
import http from 'http'
import logger from '../utils/logger'
import utils from '../utils'
import TimeProfiler from './timeProfiler'
import RedisClient from '../db/redis'
import { EXCHANGE_SERVICE_API_URL } from '../config'
import { brokerCodesDb } from '../db/dbInit'
import ExpirableMap from '../utils/expirableMap'
import { isAmbiguousOrderFailure } from '../utils/exchange'

const { sleep } = utils

/**
 * In-flight `getAllPrices` connector calls, keyed by exchange.
 *
 * The Redis `allPrice` cache below only coalesces callers that arrive AFTER a
 * table has been written. It does nothing for callers that miss at the same
 * moment, and every price-driven caller in a bot process misses together: each
 * grid bot runs its own `priceTimerFn` (`core/src/bot/helper.ts`) keyed by bot
 * id, so N bots on one exchange fire N `getAllPrices` in the same tick. On
 * Binance USDⓈ-M that is N x weight-10 `futures_getAllPrices` against a
 * process-wide weight budget shared by every Binance user on that connector
 * node, which parks their `openOrder`/`cancelOrder` behind the flood.
 *
 * Worse, the flood is self-sustaining: once the connector parks a call it
 * answers `Response timeout` (NOTOK), and a NOTOK table is deliberately never
 * cached — so the cache can never re-warm and 100% of subsequent ticks fan out
 * again.
 *
 * The table is a function of the exchange alone (the `prices` endpoint is a
 * public read whose only parameter is `exchange`), so one call safely serves
 * every concurrent caller. Same single-flight shape as `fetchOnce` in
 * `core/src/utils/leverageBracketCache.ts`, which fixed the same fan-out for
 * the leverage-bracket table.
 */
const allPricesInFlight = new Map<
  ExchangeEnum,
  Promise<{
    data: BaseReturn<AllPricesResponse[]>
    timeProfile: ExchangeRequestTimeProfile
  }>
>()

/**
 * Run `fetchPrices` only if no call for `exchange` is already running;
 * otherwise join the running one. Rejections still propagate to every caller,
 * so each keeps its own `handleError` retry ladder.
 */
const fetchAllPricesOnce = (
  exchange: ExchangeEnum,
  fetchPrices: () => Promise<{
    data: BaseReturn<AllPricesResponse[]>
    timeProfile: ExchangeRequestTimeProfile
  }>,
) => {
  const existing = allPricesInFlight.get(exchange)
  if (existing) {
    return existing
  }
  const pending = Promise.resolve()
    .then(fetchPrices)
    .finally(() => {
      allPricesInFlight.delete(exchange)
    })
  allPricesInFlight.set(exchange, pending)
  return pending
}

class Exchange extends AbstractExchange {
  /**
   * How many times a placement may be re-sent after the venue has CONFIRMED
   * the previous send did not land. Low on purpose: each pass costs a venue
   * round trip, and the failure this bounds (a genuinely lost send) is rare.
   */
  private static readonly OPEN_ORDER_RESEND_ATTEMPTS = 3
  /** Linear backoff between confirmed-safe resends. */
  private static readonly OPEN_ORDER_RESEND_DELAY_MS = 500
  protected readonly exchange: ExchangeEnum
  protected isOkx: boolean
  protected brokerCodes = new ExpirableMap<string, string>(60 * 60 * 1000) // 1 hour cache
  protected timeProfiler = TimeProfiler.getInstance()
  protected shouldCheckAffiliate = false
  constructor(
    exchange: ExchangeEnum,
    key: string,
    secret: string,
    passphrase?: string,
    _environment?: 'live' | 'sandbox',
    keysType?: CoinbaseKeysType,
    okxSource?: OKXSource,
    bybitHost?: BybitHost,
    subaccount?: boolean,
    shouldCheckAffiliate?: boolean,
  ) {
    super(
      key,
      secret,
      passphrase,
      undefined,
      keysType,
      okxSource,
      bybitHost,
      subaccount,
    )
    this.exchange = exchange
    this.isOkx = [
      ExchangeEnum.okx,
      ExchangeEnum.okxLinear,
      ExchangeEnum.okxInverse,
    ].includes(this.exchange)
    this.shouldCheckAffiliate = shouldCheckAffiliate ?? false
  }

  protected saveTimeProfile(_profile: ExchangeRequestTimeProfile) {
    return
  }

  protected getEmptyTimeProfile(
    requestName: string,
  ): ExchangeRequestTimeProfile {
    return this.timeProfiler.getEmptyTimeProfile(requestName, this.exchange)
  }

  protected startProfilerTime(
    profiler: ExchangeRequestTimeProfile,
  ): ExchangeRequestTimeProfile {
    return this.timeProfiler.startProfilerTime(profiler)
  }

  protected endProfilerTime(
    profiler: ExchangeRequestTimeProfile,
  ): ExchangeRequestTimeProfile {
    return this.timeProfiler.endProfilerTime(profiler)
  }

  async cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile('cancelOrder'),
  ): Promise<BaseReturn<CommonOrder>> {
    const { newClientOrderId, symbol } = order
    const result = await this.apiCall<CommonOrder>(
      {
        endpoint: 'order',
        method: 'delete',
        body: {
          symbol,
          newClientOrderId,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.cancelOrder, order, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    if ((result.data.reason ?? '').indexOf(`ECONNRESET`) !== -1) {
      logger.error(
        `Got ECONNRESET in cancel order. Exchange: ${this.exchange}, symbol: ${order.symbol}`,
      )
      await sleep(5e3)
      return this.cancelOrder.bind(this)(order)
    }
    return result.data
  }

  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile('getAllExchangeInfo'),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    const result = await this.apiCall<(ExchangeInfo & { pair: string })[]>(
      {
        endpoint: 'exchange/all',
        method: 'get',
        params: {
          exchange: this.exchange,
          // Forward the OKX origin so an okxSource=my client gets the OKX Europe
          // universe (okxLinear → X-Perps). Undefined for non-OKX / global and
          // simply omitted from the query — no behaviour change there.
          okxsource: this.okxSource,
        },
      },
      timeProfile,
    ).catch(this.handleError(this.getAllExchangeInfo, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * Authoritative, account-scoped SPOT instruments (OKX Europe `okxSource=my`).
   * Private call: keys + `okxsource` travel as headers (via `isPrivate`), so the
   * connector hits the authenticated `/exchange/account` endpoint on eea.okx.com
   * and returns the account's real USDC/EUR spot universe (not the public USDT
   * feed). Non-OKX exchanges resolve to the abstract "not supported" default.
   */
  async getAccountSpotExchangeInfo(
    timeProfile = this.getEmptyTimeProfile('getAccountSpotExchangeInfo'),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    const result = await this.apiCall<(ExchangeInfo & { pair: string })[]>(
      {
        endpoint: 'exchange/account',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getAccountSpotExchangeInfo, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * Authoritative, account-scoped FUTURES instruments (OKX Europe X-Perps,
   * `okxSource=my`). Private call: keys + `okxsource` travel as headers, so the
   * connector hits the authenticated `/exchange/account/futures` endpoint on
   * eea.okx.com and returns the account's real X-Perp universe. Non-OKX / non-EU
   * exchanges resolve to the abstract "not supported" default.
   */
  async getAccountFuturesExchangeInfo(
    timeProfile = this.getEmptyTimeProfile('getAccountFuturesExchangeInfo'),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    const result = await this.apiCall<(ExchangeInfo & { pair: string })[]>(
      {
        endpoint: 'exchange/account/futures',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getAccountFuturesExchangeInfo, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
    timeProfile?: ExchangeRequestTimeProfile,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: true,
    timeProfile?: ExchangeRequestTimeProfile,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
    timeProfile = this.getEmptyTimeProfile('getAllOpenOrders'),
  ): Promise<BaseReturn<CommonOrder[] | number>> {
    const result = await this.apiCall<CommonOrder[] | number>(
      {
        endpoint: 'open/all',
        method: 'get',
        params: {
          symbol,
          returnOrders,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(
      this.handleError<BaseReturn<CommonOrder[] | number>>(
        this.getAllOpenOrders,
        symbol,
        returnOrders,
        timeProfile,
      ),
    )
    this.saveTimeProfile(result.timeProfile)
    const orders = result.data as BaseReturn<CommonOrder[]>
    const number = result.data as BaseReturn<number>
    return returnOrders ? orders : number
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile('getAllUserFees'),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    const result = await this.apiCall<(UserFee & { pair: string })[]>(
      {
        endpoint: 'fees/all',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    )
      .then((fees) => {
        if (fees.data.status === StatusEnum.notok) {
          return fees
        }

        return {
          data: {
            status: StatusEnum.ok as StatusEnum.ok,
            // This rebuilds each entry as a literal rather than spreading, so
            // ANY field the connector adds is silently dropped here unless it
            // is named. `source` is carried because the fee sweep uses it to
            // report which user got published-schedule rates instead of their
            // account's real ones — without it that call is invisible, since
            // the fallback returns a plausible number with status OK.
            data: fees.data.data.map((f) => ({
              pair: f.pair,
              maker: Math.max(0, +f.maker),
              taker: Math.max(0, +f.taker),
              ...(f.source ? { source: f.source } : {}),
            })),
            reason: null,
          },
          timeProfile: fees.timeProfile,
        }
      })
      .catch(this.handleError(this.getAllUserFees, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getBalance(
    timeProfile = this.getEmptyTimeProfile('getBalance'),
  ): Promise<BaseReturn<FreeAsset>> {
    const result = await this.apiCall<FreeAsset>(
      {
        endpoint: 'balance',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getBalance, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * USD margin available on a pooled-collateral futures account. Returns `null`
   * for every venue that doesn't pool collateral — and also whenever the call
   * fails, because "no opinion" must degrade to the existing quote-asset check
   * rather than block a deal. See `getMarginAvailableUsd` in the connector.
   */
  async getMarginAvailableUsd(
    timeProfile = this.getEmptyTimeProfile('getMarginAvailableUsd'),
  ): Promise<BaseReturn<number | null>> {
    const result = await this.apiCall<number | null>(
      {
        endpoint: 'marginAvailableUsd',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getMarginAvailableUsd, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * Executions on the account, newest first — NOT the public tape
   * (`getTrades`). Read-only, for reconciling what the venue actually did
   * against what we recorded.
   *
   * Every fill carries the client order id WE supplied, so a fill the venue
   * reports against one of our ids, for an order we recorded as
   * cancelled-and-unfilled, is a fill we lost. Trades the user placed by hand
   * carry no id of ours and drop out on their own.
   *
   * `sinceMs` pages backwards; an empty array means there is no more history
   * (and is also what every venue publishing no such feed returns).
   */
  async getAccountFills(
    sinceMs?: number,
    timeProfile = this.getEmptyTimeProfile('getAccountFills'),
  ): Promise<BaseReturn<AccountFill[]>> {
    const result = await this.apiCall<AccountFill[]>(
      {
        endpoint: 'accountFills',
        method: 'get',
        isPrivate: true,
        params: sinceMs ? { since: `${sinceMs}` } : undefined,
      },
      timeProfile,
    ).catch(this.handleError(this.getAccountFills, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile('getExchangeInfo'),
  ): Promise<BaseReturn<ExchangeInfo>> {
    const result = await this.apiCall<ExchangeInfo>(
      {
        endpoint: 'exchange',
        method: 'get',
        params: {
          symbol,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getExchangeInfo, symbol, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile('getOrder'),
  ): Promise<BaseReturn<CommonOrder>> {
    const { newClientOrderId, symbol } = data
    const result = await this.apiCall<CommonOrder>(
      {
        endpoint: 'order',
        method: 'get',
        params: {
          newClientOrderId,
          symbol,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getOrder, data, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * Resolve several orders in one connector call.
   *
   * Best-effort by contract: a venue with no multi-id lookup, and a transport
   * with no such route at all (paper-trading), both answer NOTOK, and every
   * caller must already own a per-order fallback. Nothing here decides
   * correctness — it only decides how many round trips the fallback has to
   * make.
   */
  override async getOrdersBatch(
    data: { symbol: string; newClientOrderIds: string[] },
    timeProfile = this.getEmptyTimeProfile('getOrdersBatch'),
  ): Promise<BaseReturn<CommonOrder[]>> {
    const result = await this.apiCall<CommonOrder[]>(
      {
        endpoint: 'orders/batch',
        method: 'post',
        body: {
          symbol: data.symbol,
          newClientOrderIds: data.newClientOrderIds,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getOrdersBatch, data, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getUserFees(
    _symbol: string,
    timeProfile = this.getEmptyTimeProfile('getUserFees'),
  ): Promise<BaseReturn<UserFee>> {
    const result = await this.apiCall<UserFee>(
      {
        endpoint: 'fees',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getUserFees, _symbol, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async latestPrice(
    symbol: string,
    cache = false,
    timeProfile = this.getEmptyTimeProfile('latestPrice'),
  ): Promise<BaseReturn<number>> {
    try {
      if (cache) {
        const client = await RedisClient.getInstance()
        if (client.isReady) {
          const key = `${this.exchange}${symbol}`
          const prices = await client.hGet('latestPrice', key)
          if (prices) {
            const parse = JSON.parse(prices) as BaseReturn<number>
            if (
              parse &&
              typeof parse.data !== 'undefined' &&
              parse.data !== null
            ) {
              if (
                !parse.timeProfile?.exchangeRequestEndTime ||
                +new Date() - parse.timeProfile.exchangeRequestEndTime >
                  2.5 * 60 * 1000
              ) {
                client.hDel('latestPrice', key)
              } else {
                return parse
              }
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Error in getAllPrices redis cache: ${e}`)
    }
    const result = await this.apiCall<number>(
      {
        endpoint: 'latestPrice',
        method: 'get',
        params: {
          symbol,
          exchange: this.exchange,
        },
      },
      timeProfile,
    ).catch(this.handleError(this.latestPrice, cache, symbol, timeProfile))
    if (
      result.data.status === StatusEnum.ok &&
      typeof result.data.data !== 'undefined' &&
      result.data.data !== null
    ) {
      try {
        if (cache) {
          const client = await RedisClient.getInstance()
          if (client.isReady) {
            await client.hSet(
              'latestPrice',
              `${this.exchange}${symbol}`,
              JSON.stringify(result.data),
            )
            await client.hExpire(
              'latestPrice',
              `${this.exchange}${symbol}`,
              2.5 * 60,
            )
          }
        }
      } catch (e) {
        logger.error(`Error in getAllPrices redis cache: ${e}`)
      }
    }
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /** One send. No retry of any kind — see {@link Exchange#openOrder}. */
  private async sendOpenOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
      leverage?: number
    },
    timeProfile: ExchangeRequestTimeProfile,
  ): Promise<BaseReturn<CommonOrder>> {
    const result = await this.apiCall<CommonOrder>(
      {
        endpoint: 'order',
        method: 'post',
        body: order,
        isPrivate: true,
        noAutoRetry: true,
      },
      timeProfile,
    ).catch(
      // NOT `handleError`: that helper's own ladder re-drives the whole method
      // up to five more times on ECONNRESET/socket-hang-up/fetch-failed, which
      // is the same blind resend this method exists to prevent. The ladders
      // compose, so one logical placement could reach the venue many times over
      // under the same client order id. This mirrors `handleError`'s terminal
      // branch only.
      async (
        e: Error & { response?: { data?: { message: string } } },
      ): Promise<{
        data: BaseReturn<CommonOrder>
        timeProfile: ExchangeRequestTimeProfile
      }> => {
        const message = e?.response?.data?.message || e?.message
        return {
          data: this.returnBad()(new Error(message)) as BaseReturn<CommonOrder>,
          timeProfile,
        }
      },
    )
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  /**
   * Place an order, and never place it twice.
   *
   * `POST /order` is the only call in this class that CHANGES the venue, so it
   * is the only one whose blind retry can double a position. Every retry layer
   * this class has fires on outcomes that are silent about whether the request
   * arrived — timeouts, resets, 5xx, a bare rejected promise — and re-sends the
   * identical `newClientOrderId`. A venue that rejects a duplicate client order
   * id absorbs that; Hyperliquid accepts it and opens a second live order.
   * Measured against the real built class with a lost response: 2 live orders
   * from one placement when only the first response is lost, 6 when all are.
   *
   * So the automatic ladders are off here (`noAutoRetry`, plus a non-retrying
   * error handler in `sendOpenOrder`) and the retry is re-expressed as
   * RESOLVE-then-resend:
   *
   *   1. send once
   *   2. on an ambiguous failure, ask the venue what happened to this client
   *      order id
   *   3. if the venue has it, that IS the result — return it, never resend
   *   4. only resend when the venue answers, definitively, that it does not
   *      have it
   *   5. if the lookup is itself inconclusive, give up and report the failure
   *      rather than guess. An unconfirmed order is the caller's problem to
   *      resolve (it still holds the id); a duplicate position is nobody's.
   *
   * Without `newClientOrderId` there is nothing to resolve BY, so that case
   * keeps the old single-shot behaviour.
   */
  async openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
      leverage?: number
    },
    timeProfile = this.getEmptyTimeProfile('openOrder'),
  ): Promise<BaseReturn<CommonOrder>> {
    let result = await this.sendOpenOrder(order, timeProfile)
    if (!order.newClientOrderId) {
      return result
    }
    for (
      let attempt = 1;
      attempt <= Exchange.OPEN_ORDER_RESEND_ATTEMPTS &&
      result.status === StatusEnum.notok &&
      isAmbiguousOrderFailure(result.reason);
      attempt++
    ) {
      logger.error(
        `Ambiguous new-order outcome (${result.reason}). Exchange: ${this.exchange}, symbol: ${order.symbol}, id: ${order.newClientOrderId}. Asking the venue before resending.`,
      )
      const placed = await this.getOrder({
        symbol: order.symbol,
        newClientOrderId: order.newClientOrderId,
      })
      if (placed.status === StatusEnum.ok && placed.data) {
        logger.error(
          `Order ${order.newClientOrderId} DID reach ${this.exchange} despite the failed response — adopting it instead of resending.`,
        )
        return placed
      }
      if (isAmbiguousOrderFailure(placed.reason)) {
        logger.error(
          `Cannot tell whether ${order.newClientOrderId} reached ${this.exchange} (lookup: ${placed.reason}). Not resending.`,
        )
        return result
      }
      // The venue answered and does not have it: the send genuinely did not
      // land, so this resend cannot duplicate anything.
      await sleep(Exchange.OPEN_ORDER_RESEND_DELAY_MS * attempt)
      result = await this.sendOpenOrder(order, timeProfile)
    }
    return result
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile('getCandles'),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const params: {
      symbol: string
      interval: ExchangeIntervals
      from?: number
      to?: number
      count?: number
    } = {
      symbol,
      interval,
    }
    if (from) {
      params.from = from
    }
    if (to) {
      params.to = to
    }
    if (countData) {
      params.count = countData
    }
    const result = await this.apiCall<CandleResponse[]>(
      {
        endpoint: 'candles',
        method: 'get',
        params: {
          ...params,
          exchange: this.exchange,
        },
      },
      timeProfile,
    ).catch(
      this.handleError(
        this.getCandles,
        symbol,
        interval,
        from,
        to,
        countData,
        timeProfile,
      ),
    )
    this.saveTimeProfile(result.timeProfile)
    if (
      result.data.status === StatusEnum.notok &&
      result.data.reason.includes('parameter verification failed')
    ) {
      return this.returnGood<CandleResponse[]>()([])
    }
    return result.data
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
    timeProfile = this.getEmptyTimeProfile('getFundingRateHistory'),
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    const params: {
      symbol: string
      from?: number
      to?: number
      limit?: number
    } = { symbol }
    if (from) {
      params.from = from
    }
    if (to) {
      params.to = to
    }
    if (limit) {
      params.limit = limit
    }
    const result = await this.apiCall<FundingRateResponse[]>(
      {
        endpoint: 'fundingRateHistory',
        method: 'get',
        params: {
          ...params,
          exchange: this.exchange,
        },
      },
      timeProfile,
    ).catch(
      this.handleError(
        this.getFundingRateHistory,
        symbol,
        from,
        to,
        limit,
        timeProfile,
      ),
    )
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile('getTrades'),
  ): Promise<BaseReturn<TradeResponse[]>> {
    const result = await this.apiCall<TradeResponse[]>(
      {
        endpoint: 'trades',
        method: 'get',
        params: {
          ...{
            symbol,
            fromId,
            startTime,
            endTime,
          },
          exchange: this.exchange,
        },
      },
      timeProfile,
    ).catch(
      this.handleError(
        this.getTrades,
        symbol,
        fromId,
        startTime,
        endTime,
        timeProfile,
      ),
    )
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getAllPrices(
    cache = true,
    timeProfile = this.getEmptyTimeProfile('getAllPrices'),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    try {
      if (cache) {
        const client = await RedisClient.getInstance()
        if (client.isReady) {
          const prices = await client.hGet('allPrice', this.exchange)
          if (prices) {
            const parse = JSON.parse(prices) as BaseReturn<AllPricesResponse[]>
            if (parse && parse.data && parse.data.length) {
              if (
                !parse.timeProfile?.exchangeRequestEndTime ||
                +new Date() - parse.timeProfile.exchangeRequestEndTime >
                  this.allPricesCachePeriod
              ) {
                logger.debug(
                  `Got all prices from cache but expired, delete ${this.exchange} from cache`,
                )
                client.hDel('allPrice', this.exchange)
                return this.getAllPrices(cache)
              } else {
                return parse
              }
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Error in getAllPrices redis cache: ${e}`)
    }

    const fetchAndCache = async () => {
      const fresh = await this.apiCall<AllPricesResponse[]>(
        {
          endpoint: 'prices',
          method: 'get',
          params: {
            exchange: this.exchange,
          },
        },
        timeProfile,
      )
      if (fresh.data.status === StatusEnum.ok && fresh.data.data?.length) {
        try {
          if (cache) {
            const client = await RedisClient.getInstance()
            if (client.isReady) {
              await client.hSet(
                'allPrice',
                this.exchange,
                JSON.stringify(fresh.data),
              )
              await sleep(50)
              await client.hExpire(
                'allPrice',
                this.exchange,
                this.allPricesCachePeriod / 1000,
              )
            }
          }
        } catch (e) {
          logger.error(`Error in getAllPrices redis cache: ${e}`)
        }
      }
      return fresh
    }

    // Only the cached path coalesces: an explicit `cache: false` caller is
    // asking for its own fresh read, and no caller does that today.
    const result = await (
      cache ? fetchAllPricesOnce(this.exchange, fetchAndCache) : fetchAndCache()
    ).catch(this.handleError(this.getAllPrices, cache, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async changeLeverage(
    data: {
      symbol: string
      leverage: number
      side: PositionSide
    },
    timeProfile = this.getEmptyTimeProfile('changeLeverage'),
  ): Promise<BaseReturn<number>> {
    const { leverage, symbol } = data
    const result = await this.apiCall<number>(
      {
        endpoint: 'leverage',
        method: 'post',
        body: {
          leverage,
          symbol,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.changeLeverage, data, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile('getHedge'),
  ): Promise<BaseReturn<boolean>> {
    const result = await this.apiCall<boolean>(
      {
        endpoint: 'hedge',
        method: 'get',
        isPrivate: true,
        body: { symbol: _symbol },
      },
      timeProfile,
    ).catch(this.handleError(this.getHedge, _symbol, timeProfile))

    return result.data
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile('futures_getPositions'),
  ): Promise<BaseReturn<PositionInfo[]>> {
    const result = await this.apiCall<PositionInfo[]>(
      {
        endpoint: 'positions',
        method: 'get',
        isPrivate: true,
        body: { symbol },
      },
      timeProfile,
    ).catch(this.handleError(this.futures_getPositions, symbol, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile('setHedge'),
  ): Promise<BaseReturn<boolean>> {
    const result = await this.apiCall<boolean>(
      {
        endpoint: 'hedge',
        method: 'post',
        body: { value },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.setHedge, value, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile('futures_leverageBracket'),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    const result = await this.apiCall<LeverageBracket[]>(
      {
        endpoint: 'leverageBracket',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.futures_leverageBracket, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getUid(
    timeProfile = this.getEmptyTimeProfile('getUid'),
  ): Promise<BaseReturn<string | number>> {
    const result = await this.apiCall<string | number>(
      {
        endpoint: 'uid',
        method: 'get',
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.getUid, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile('getAffiliate'),
  ): Promise<BaseReturn<boolean>> {
    const result = await this.apiCall<boolean>(
      {
        endpoint: 'affiliate',
        method: 'get',
        isPrivate: true,
        body: { uid },
      },
      timeProfile,
    ).catch(this.handleError(this.getAffiliate, uid, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async changeMargin(
    data: {
      symbol: string
      margin: MarginType
      leverage: number
    },
    timeProfile = this.getEmptyTimeProfile('changeMargin'),
  ): Promise<BaseReturn<MarginType>> {
    const { margin, symbol, leverage } = data
    const result = await this.apiCall<MarginType>(
      {
        endpoint: 'margin',
        method: 'post',
        body: {
          margin,
          symbol,
          leverage,
        },
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.changeMargin, data, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  async cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile('cancelOrderByOrderIdAndSymbol'),
  ): Promise<BaseReturn<CommonOrder>> {
    const result = await this.apiCall<CommonOrder>(
      {
        endpoint: 'orders/byid',
        method: 'delete',
        body: order,
        isPrivate: true,
      },
      timeProfile,
    ).catch(
      this.handleError(this.cancelOrderByOrderIdAndSymbol, order, timeProfile),
    )
    this.saveTimeProfile(result.timeProfile)
    return result.data
  }

  protected handleError<T>(cb: (...args: any[]) => Promise<T>, ...args: any[]) {
    return async (
      e: Error & {
        response?: { data?: { statusCode: boolean; message: string } }
      },
    ) => {
      const timeProfile: ExchangeRequestTimeProfile = args[args.length - 1]
      const errorMessage = e?.response?.data?.message || e?.message
      if (
        (!errorMessage ||
          errorMessage
            .toLowerCase()
            .indexOf('too many request'.toLowerCase()) !== -1 ||
          errorMessage.toLowerCase().indexOf('socket hang up'.toLowerCase()) !==
            -1 ||
          errorMessage.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !==
            -1 ||
          errorMessage.toLowerCase().indexOf('fetch failed'.toLowerCase()) !==
            -1) &&
        timeProfile.appAttempts < 5
      ) {
        const wait = 10e3 * (1 + 0.5 * ((timeProfile.appAttempts || 1) - 1))
        logger.error(
          `API | Got ${errorMessage} error. Waiting ${wait / 1e3} seconds`,
        )
        await sleep(wait)
        timeProfile.appAttempts++
        args.splice(args.length - 1, 1, timeProfile)
        const newResult = await cb.bind(this)(...args)
        return { data: newResult, timeProfile }
      }

      return { data: this.returnBad()(new Error(errorMessage)), timeProfile }
    }
  }

  protected async apiCall<R>(
    request: {
      endpoint: string
      method: 'post' | 'get' | 'delete'
      params?: Record<string, unknown>
      body?: Record<string, unknown>
      isPrivate?: boolean
      /**
       * Opt this request OUT of the transport retry ladders below.
       *
       * They fire on timeouts, resets and 5xx — outcomes that do not say
       * whether the request reached the venue — and re-send the identical body.
       * For a read that is free. For `POST /order` it is a second live order on
       * any venue that does not deduplicate `newClientOrderId` (Hyperliquid
       * does not), so that one caller resends deliberately, after asking the
       * venue what happened. See {@link Exchange#openOrder}.
       */
      noAutoRetry?: boolean
    },
    timeProfile: ExchangeRequestTimeProfile,
    count = 0,
  ): Promise<{ data: BaseReturn<R>; timeProfile: ExchangeRequestTimeProfile }> {
    // Credentials this instance could not resolve in its constructor are
    // resolved here, before anything reads them into the auth headers below.
    // No-op unless a resolver is registered and owns one of the values.
    if (this.hasPendingCredentials()) {
      const credentialStart = Date.now()
      await this.ensureCredentials()
      timeProfile.credentialResolveMs = Date.now() - credentialStart
    }
    const { endpoint, params, body, method } = request
    const authHeaders: Record<string, string> = {
      'Content-type': 'application/json',
    }
    let code = ''
    const shouldCheckExchange = [
      ExchangeEnum.hyperliquid,
      ExchangeEnum.hyperliquidLinear,
    ].includes(this.exchange)
      ? this.shouldCheckAffiliate
      : true
    if (
      ((endpoint === 'order' && method === 'post') ||
        (endpoint.startsWith('fees') && method === 'get')) &&
      shouldCheckExchange
    ) {
      const eName = this.exchange.startsWith('hyperliquid')
        ? ExchangeEnum.hyperliquid
        : this.exchange
      const isBybitWithHost =
        this.exchange.startsWith('bybit') && this.bybitHost !== null
      const key = isBybitWithHost ? `${eName}@${this.bybitHost}` : eName
      const get = this.brokerCodes.get(key)
      if (get) {
        code = get
      } else {
        let codeWithZone = ''
        if (isBybitWithHost) {
          codeWithZone =
            (
              await brokerCodesDb.readData({
                exchange: eName,
                zone: this.bybitHost,
              })
            )?.data?.result?.code || ''
        }
        code =
          codeWithZone ||
          (
            await brokerCodesDb.readData({
              exchange: eName,
            })
          )?.data?.result?.code ||
          ''
        this.brokerCodes.set(key, code)
      }
    }
    if (request.isPrivate) {
      if (this.key != null) {
        authHeaders.key = this.key
      }
      if (this.secret != null) {
        authHeaders.secret = this.secret
      }
      if (this.keysType != null) {
        authHeaders.keystype = this.keysType
      }
      if (this.okxSource != null) {
        authHeaders.okxsource = this.okxSource
      }
      if (this.bybitHost != null) {
        authHeaders.bybithost = this.bybitHost
      }
      if (this.passphrase) {
        authHeaders.passphrase = this.passphrase
      }
      authHeaders.code = code
      authHeaders.exchange = this.exchange
    }
    authHeaders.subaccount = this.subaccount ? 'true' : 'false'
    timeProfile = this.startProfilerTime(timeProfile)
    return axios<BaseReturn<R>>({
      url: `${EXCHANGE_SERVICE_API_URL}/${endpoint}`,
      method,
      params: params,
      data: body,
      headers: authHeaders,
      httpAgent: new http.Agent({ keepAlive: true }),
      timeout:
        this.isOkx && endpoint === 'candles' ? 15 * 60 * 1000 : 5 * 60 * 1000,
      timeoutErrorMessage: 'Request Timeout',
    })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile)
        if (
          res.status === 408 ||
          res.status === 404 ||
          res.status === 502 ||
          res.status === 400 ||
          res.statusText.toLowerCase().indexOf('fetch failed'.toLowerCase()) !==
            -1 ||
          res.statusText
            .toLowerCase()
            .indexOf('socket hang up'.toLowerCase()) !== -1 ||
          res.statusText
            .toLowerCase()
            .indexOf('too many request'.toLowerCase()) !== -1 ||
          (res.data?.reason ?? '')
            .toLowerCase()
            .indexOf('too many request'.toLowerCase()) !== -1 ||
          res.statusText.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !==
            -1 ||
          res.statusText
            .toLowerCase()
            .indexOf('Server Timeout'.toLowerCase()) !== -1 ||
          res.statusText
            .toLowerCase()
            .indexOf(
              'Client network socket disconnected before secure TLS connection was established'.toLowerCase(),
            ) !== -1
        ) {
          if (count < 5 && !request.noAutoRetry) {
            const time = res?.status === 404 ? 3000 : 1000
            logger.error(
              `Received code:${res.status}, status:${res.statusText} (${
                res.data?.reason
              } ${
                this.exchange
              }), endpoint: ${endpoint}, method: ${method}, exchange: ${
                this.exchange
              }, sleep ${time / 1000}s`,
            )
            await sleep(time)
            return this.apiCall<R>(request, timeProfile, count + 1)
          } else {
            throw new Error(`Exchange connector | ${res.statusText}`)
          }
        }
        if (res.status >= 400) {
          throw new Error(res.statusText)
        }
        return {
          data: res.data,
          timeProfile: { ...(res.data.timeProfile ?? {}), ...timeProfile },
        }
      })
      .catch(async (res: AxiosError) => {
        timeProfile = this.endProfilerTime(timeProfile)
        logger.error(
          `Catch code:${res.response?.status} (${res.status}), status:${res.response?.statusText} (${res.message}), endpoint: ${endpoint}, method: ${method}, exchange: ${this.exchange}`,
        )
        const port =
          `${res.message}`
            .toLowerCase()
            .indexOf('EADDRNOTAVAIL'.toLowerCase()) !== -1
        if (
          !res.response ||
          res.message.toLowerCase().includes('EPIPE'.toLowerCase()) ||
          res.message.toLowerCase().includes('Request Timeout'.toLowerCase()) ||
          res.status === 408 ||
          res.status === 404 ||
          res.status === 405 ||
          res.status === 400 ||
          res.status === 500 ||
          res.response.status === 408 ||
          res.response.status === 502 ||
          res.response.status === 404 ||
          res.response.status === 405 ||
          res.response.status === 400 ||
          res.response.status === 500 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('fetch failed'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('socket hang up'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('too many request'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
          (res.message as string)
            .toLowerCase()
            .indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
          (res.message as string)
            .toLowerCase()
            .indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
          port ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('Server Timeout'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('Server Error'.toLowerCase()) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf(
              'Client network socket disconnected before secure TLS connection was established'.toLowerCase(),
            ) !== -1 ||
          (res.response.statusText as string)
            .toLowerCase()
            .indexOf('Internal Server Error'.toLowerCase()) !== -1
        ) {
          if (count < 5 && !request.noAutoRetry) {
            const time =
              res?.response?.status === 404 ||
              res?.response?.status === 405 ||
              res?.response?.status === 408 ||
              port
                ? 3000
                : 500
            await sleep(time)
            return this.apiCall(request, timeProfile, count + 1)
          } else {
            throw new Error(`Exchange connector | ${res.response?.statusText}`)
          }
        }
        throw new Error(res.response.statusText)
      })
  }
}

export default Exchange
