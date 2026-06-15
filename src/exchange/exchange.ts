import AbstractExchange from './index'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
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

const { sleep } = utils

class Exchange extends AbstractExchange {
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
    bybitHost?: string,
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
        },
      },
      timeProfile,
    ).catch(this.handleError(this.getAllExchangeInfo, timeProfile))
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
            data: fees.data.data.map((f) => ({
              pair: f.pair,
              maker: Math.max(0, +f.maker),
              taker: Math.max(0, +f.taker),
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
    const result = await this.apiCall<CommonOrder>(
      {
        endpoint: 'order',
        method: 'post',
        body: order,
        isPrivate: true,
      },
      timeProfile,
    ).catch(this.handleError(this.openOrder, order, timeProfile))
    this.saveTimeProfile(result.timeProfile)
    if ((result.data.reason ?? '').indexOf(`ECONNRESET`) !== -1) {
      logger.error(
        `Got ECONNRESET in new order. Exchange: ${this.exchange}, symbol: ${order.symbol}`,
      )
      return this.openOrder.bind(this)(order)
    }
    return result.data
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

    const result = await this.apiCall<AllPricesResponse[]>(
      {
        endpoint: 'prices',
        method: 'get',
        params: {
          exchange: this.exchange,
        },
      },
      timeProfile,
    ).catch(this.handleError(this.getAllPrices, cache, timeProfile))
    if (result.data.status === StatusEnum.ok && result.data.data?.length) {
      try {
        if (cache) {
          const client = await RedisClient.getInstance()
          if (client.isReady) {
            await client.hSet(
              'allPrice',
              this.exchange,
              JSON.stringify(result.data),
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
    },
    timeProfile: ExchangeRequestTimeProfile,
    count = 0,
  ): Promise<{ data: BaseReturn<R>; timeProfile: ExchangeRequestTimeProfile }> {
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
          if (count < 5) {
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
          if (count < 5) {
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
