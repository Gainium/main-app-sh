import AbstractExchange, { Exchange } from '../index'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  FundingRateResponse,
  CommonOrder,
  ExchangeEnum,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  OrderSideType,
  OrderStatusType,
  OrderTypes,
  OrderTypeT,
  StatusEnum,
  UserFee,
  MarginType,
  LeverageBracket,
  PositionInfo,
  PositionSide,
  TradeResponse,
} from '../../../types'
import { CreateOrderResponse, PaperOrder, UserBalanceResponse } from './types'
import { mapPaperToReal, paperExchanges, PaperExchangeType } from './utils'
import axios, { AxiosError } from 'axios'
import http from 'http'
import logger from '../../utils/logger'
import RedisClient from '../../db/redis'
import { removePaperFormExchangeName } from '../helpers'
import utils from '../../utils'
import { PAPER_TRADING_API_URL } from '../../config'

const { sleep } = utils

class PaperError extends Error {
  constructor(message?: string | null) {
    super(message || 'Unknown error')
  }
}

class PaperExchange extends AbstractExchange implements Exchange {
  private exchange: ExchangeEnum
  constructor(exchange: ExchangeEnum, key: string, secret: string) {
    super(key, secret)
    if (paperExchanges.includes(exchange)) {
      this.exchange = mapPaperToReal(exchange as PaperExchangeType)
    } else {
      this.exchange = exchange
    }
  }

  async cancelOrder(order: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    const { newClientOrderId, symbol } = order
    return this.apiCall<{ reason?: string }>({
      endpoint: 'order',
      method: 'delete',
      body: {
        key: this.key,
        secret: this.secret,
        symbol,
        externalId: newClientOrderId,
      },
    })
      .then(async (res) => {
        if (res.reason) {
          return this.returnBad()(new PaperError(res.reason))
        }
        const ord = await this.getOrder({ symbol, newClientOrderId })
        if (ord.status === StatusEnum.notok) {
          return this.returnBad()(new PaperError(ord.reason))
        }
        return this.returnGood<CommonOrder>()(ord.data)
      })
      .catch(this.handlePaperErrors())
  }

  async getAllExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  > {
    return this.apiCall<BaseReturn<(ExchangeInfo & { pair: string })[]>>({
      endpoint: 'exchange/all',
      method: 'get',
      params: {
        exchange: this.exchange,
      },
    }).catch(this.handlePaperErrors())
  }

  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[] | number>> {
    return this.apiCall<CommonOrder[]>({
      endpoint: 'order/all/open',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
        symbol,
      },
    })
      .then((orders) => {
        if (returnOrders) {
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            data: orders,
            reason: null,
          }
        }
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          data: orders.length,
          reason: null,
        }
      })
      .catch(this.handlePaperErrors())
  }

  async getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    return this.apiCall<{ maker: number; taker: number }>({
      endpoint: 'user/fees',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
      },
    })
      .then(async (fees) => {
        const tickers = await this.getAllExchangeInfo()
        if (tickers.status === StatusEnum.ok) {
          const makerFee = fees.maker
          const takerFee = fees.taker
          const data = tickers.data.map((t) => ({
            pair: t.pair,
            maker: makerFee,
            taker: takerFee,
          }))
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            data,
            reason: null,
          }
        }
        return {
          status: StatusEnum.notok as StatusEnum.notok,
          data: null,
          reason: tickers?.reason,
        }
      })
      .catch(this.handlePaperErrors())
  }

  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    return this.apiCall<UserBalanceResponse>({
      endpoint: 'user/balance',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
        exchange: this.exchange,
      },
    })
      .then((accountInfo) => {
        const balances = accountInfo || []
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          data: balances.balance.map((balance) => ({
            asset: balance.asset,
            free: balance.free,
            locked: balance.locked,
          })),
        }
      })
      .catch(this.handlePaperErrors())
  }

  async getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>> {
    return this.apiCall<BaseReturn<ExchangeInfo>>({
      endpoint: 'exchange',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
        exchange: this.exchange,
        symbol,
      },
    }).catch(this.handlePaperErrors())
  }

  async getOrder(data: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    const { newClientOrderId, symbol } = data
    return this.apiCall<CommonOrder>({
      endpoint: 'order',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
        newClientOrderId,
        symbol,
      },
    })
      .then((res) => {
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          reason: null,
          data: {
            ...res,
            status: res.status as OrderStatusType,
            type: res.type as OrderTypeT,
            side: res.side as OrderSideType,
            fills: [],
          },
        }
      })
      .catch(this.handlePaperErrors())
  }

  async getOrderById(data: {
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.apiCall<PaperOrder>({
      endpoint: `order/${data.orderId}`,
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
      },
    })
      .then((res) => {
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          reason: null,
          data: {
            ...res,
            status: res.status as OrderStatusType,
            type: res.type as OrderTypeT,
            side: res.side as OrderSideType,
            fills: [],
          },
        }
      })
      .catch(this.handlePaperErrors())
  }

  async getUserFees(_symbol: string): Promise<BaseReturn<UserFee>> {
    return this.apiCall<{ maker: number; taker: number }>({
      endpoint: 'user/fees',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
      },
    })
      .then((fees) => {
        const { maker, taker } = fees
        return {
          status: StatusEnum.ok as StatusEnum.ok,
          data: {
            maker,
            taker,
          },
          reason: null,
        }
      })
      .catch(this.handlePaperErrors())
  }

  async latestPrice(
    symbol: string,
    cache = false,
  ): Promise<BaseReturn<number>> {
    try {
      if (cache) {
        const client = await RedisClient.getInstance()
        if (client.isReady) {
          const key = `${removePaperFormExchangeName(this.exchange)}${symbol}`
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

    const result = await this.apiCall<BaseReturn<number>>({
      endpoint: 'exchange/latestPrice',
      method: 'get',
      params: {
        symbol,
        exchange: this.exchange,
      },
    }).catch(this.handlePaperErrors())
    if (
      result.status === StatusEnum.ok &&
      typeof result.data !== 'undefined' &&
      result.data !== null
    ) {
      try {
        if (cache) {
          const client = await RedisClient.getInstance()
          if (client.isReady) {
            await client.hSet(
              'latestPrice',
              `${removePaperFormExchangeName(this.exchange)}${symbol}`,
              JSON.stringify(result),
            )
            await client.hExpire(
              'latestPrice',
              `${removePaperFormExchangeName(this.exchange)}${symbol}`,
              2.5 * 60,
            )
          }
        }
      } catch (e) {
        logger.error(`Error in getAllPrices redis cache: ${e}`)
      }
    }
    return result
  }

  async openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: 'LIMIT' | 'MARKET'
    reduceOnly?: boolean
    positionSide?: PositionSide
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>> {
    const {
      symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type,
      reduceOnly,
      positionSide,
    } = order
    const request = this.apiCall<CreateOrderResponse>({
      endpoint: 'order',
      method: 'post',
      body: {
        key: this.key,
        secret: this.secret,
        symbol,
        amount: quantity,
        type: type || 'LIMIT',
        exchange: this.exchange,
        side,
        externalId: newClientOrderId,
        price,
        reduceOnly,
        positionSide,
      },
    })
    return request
      .then(async (res) => {
        const orderData = await this.getOrderById({
          orderId: res.orderId,
        })
        if (orderData.status === StatusEnum.ok) {
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            data: orderData.data,
            reason: null,
          }
        }
        return this.returnBad()(new PaperError(orderData.reason))
      })
      .catch(this.handlePaperErrors())
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
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
    const res = await this.apiCall<BaseReturn<CandleResponse[]>>({
      endpoint: 'exchange/candles',
      method: 'get',
      params: {
        ...params,
        exchange: this.exchange,
      },
    }).catch(this.handlePaperErrors())
    if (
      res.status === StatusEnum.notok &&
      res.reason.includes('parameter verification failed')
    ) {
      return this.returnGood<CandleResponse[]>()([])
    }
    return res
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    // Paper deals accrue real funding: the paper service proxies this through
    // to exchange-connector for the underlying real exchange + symbol.
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
    const res = await this.apiCall<BaseReturn<FundingRateResponse[]>>({
      endpoint: 'exchange/fundingRateHistory',
      method: 'get',
      params: {
        ...params,
        exchange: this.exchange,
      },
    }).catch(this.handlePaperErrors())
    if (
      res.status === StatusEnum.notok &&
      res.reason.includes('parameter verification failed')
    ) {
      return this.returnGood<FundingRateResponse[]>()([])
    }
    return res
  }

  async getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.apiCall<BaseReturn<TradeResponse[]>>({
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
    }).catch(this.handlePaperErrors())
  }

  async getAllPrices(cache = true): Promise<BaseReturn<AllPricesResponse[]>> {
    try {
      if (cache) {
        const client = await RedisClient.getInstance()
        const exName = `${removePaperFormExchangeName(this.exchange)}`
        if (client.isReady) {
          const prices = await client.hGet('allPrice', exName)
          if (prices) {
            const parse = JSON.parse(prices) as BaseReturn<AllPricesResponse[]>
            if (parse && parse.data) {
              if (
                !parse.timeProfile?.exchangeRequestEndTime ||
                +new Date() - parse.timeProfile.exchangeRequestEndTime >
                  this.allPricesCachePeriod
              ) {
                logger.debug(
                  `Got all prices from cache but expired, delete ${this.exchange} from cache`,
                )
                client.hDel('allPrice', exName)
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
    const result = await this.apiCall<BaseReturn<AllPricesResponse[]>>({
      endpoint: 'exchange/prices',
      method: 'get',
      params: {
        exchange: this.exchange,
      },
    }).catch(this.handlePaperErrors())
    if (result.status === StatusEnum.ok && result.data) {
      try {
        if (cache) {
          const client = await RedisClient.getInstance()
          if (client.isReady) {
            await client.hSet(
              'allPrice',
              removePaperFormExchangeName(this.exchange),
              JSON.stringify(result),
            )
            await client.hExpire(
              'allPrice',
              removePaperFormExchangeName(this.exchange),
              this.allPricesCachePeriod / 1000,
            )
          }
        }
      } catch (e) {
        logger.error(`Error in getAllPrices redis cache: ${e}`)
      }
    }

    return result
  }

  async changeLeverage(data: {
    symbol: string
    leverage: number
    side: PositionSide
  }): Promise<BaseReturn<number>> {
    const { leverage, symbol, side } = data
    return this.apiCall<BaseReturn<number>>({
      endpoint: 'user/leverage',
      method: 'post',
      body: {
        leverage,
        symbol,
        side,
        key: this.key,
        secret: this.secret,
      },
      isPrivate: true,
    }).catch(this.handlePaperErrors())
  }

  async changeMargin(data: {
    symbol: string
    margin: MarginType
    leverage: number
  }): Promise<BaseReturn<MarginType>> {
    const { margin } = data
    return {
      status: StatusEnum.ok as StatusEnum.ok,
      data: margin,
      reason: null,
    }
  }

  async getHedge(_symbol?: string): Promise<BaseReturn<boolean>> {
    return this.apiCall<boolean>({
      endpoint: 'user/hedge',
      method: 'get',
      isPrivate: true,
      body: {
        key: this.key,
        secret: this.secret,
      },
    })
      .then((d) => this.returnGood<boolean>()(d))
      .catch(this.handlePaperErrors())
  }

  async setHedge(hedge: boolean): Promise<BaseReturn<boolean>> {
    return this.apiCall<void>({
      endpoint: 'user/hedge',
      method: 'post',
      isPrivate: true,
      body: {
        key: this.key,
        secret: this.secret,
        hedge,
      },
    })
      .then(() => this.returnGood<boolean>()(hedge))
      .catch(this.handlePaperErrors())
  }

  async futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>> {
    return this.returnGood<LeverageBracket[]>()([])
  }

  async futures_getPositions(
    symbol?: string,
  ): Promise<BaseReturn<PositionInfo[]>> {
    return this.apiCall<PositionInfo[]>({
      endpoint: 'user/positions',
      method: 'get',
      isPrivate: true,
      body: {
        key: this.key,
        secret: this.secret,
        symbol,
      },
    })
      .then((d) => this.returnGood<PositionInfo[]>()(d))
      .catch(this.handlePaperErrors())
  }

  getAllOrders(): Promise<BaseReturn<CommonOrder[]>> {
    return this.apiCall<CommonOrder[]>({
      endpoint: 'order/all',
      method: 'get',
      params: {
        key: this.key,
        secret: this.secret,
      },
    })
      .then((d) => this.returnGood<CommonOrder[]>()(d))
      .catch(this.handlePaperErrors())
  }

  cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.apiCall<CommonOrder>({
      endpoint: 'order/byid',
      method: 'delete',
      body: {
        key: this.key,
        secret: this.secret,
        ...order,
      },
    })
      .then((d) => this.returnGood<CommonOrder>()(d))
      .catch(this.handlePaperErrors())
  }

  async getUid(): Promise<BaseReturn<string | number>> {
    return this.returnGood<number>()(-1)
  }

  async getAffiliate(_uid: string | number): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>()(false)
  }

  private handlePaperErrors() {
    return async (
      e: Error & {
        response?: { data?: { statusCode: boolean; message: string } }
      },
    ) => {
      const errorMessage = e?.response?.data?.message || `${e.message}`
      return this.returnBad()(new Error(errorMessage))
    }
  }

  private apiCall<R>(
    request: {
      endpoint: string
      method: 'post' | 'get' | 'delete'
      params?: Record<string, unknown>
      body?: Record<string, unknown>
      isPrivate?: boolean
    },
    count = 0,
  ): Promise<R> {
    const { endpoint, params, body, method } = request
    const headers: Record<string, string> = {
      'Content-type': 'application/json',
    }
    return axios({
      url: `${PAPER_TRADING_API_URL}/${endpoint}`,
      method,
      params: params,
      data: body,
      headers: headers,
      httpAgent: new http.Agent({ keepAlive: true }),
    })
      .then(async (res) => {
        if (res?.status >= 400) {
          if (res?.status === 408) {
            const time = 500
            if (count < 5) {
              logger.error(
                `Paper Received code:${res.status}, status:${res.statusText} (${
                  res.data?.reason
                } ${
                  this.exchange
                }), endpoint: ${endpoint}, method: ${method}, exchange: ${
                  this.exchange
                }, sleep ${time / 1000}s`,
              )
              await sleep(time)
              return this.apiCall(request, count + 1)
            } else {
              throw new Error(`Paper Exchange connector | ${res?.statusText}`)
            }
          }
          throw new Error(`Paper Exchange connector | ${res?.statusText}`)
        }
        return res.data
      })
      .catch(async (res: AxiosError<{ message: unknown }>) => {
        if (res.response?.status !== 400) {
          logger.error(
            `Paper Catch code:${res.response?.status} (${res.status}), status:${res.response?.statusText} (${res.message}), endpoint: ${endpoint}, method: ${method}, exchange: ${this.exchange}`,
          )
        }
        if (!res.response || res.response.status === 408) {
          if (count < 5) {
            await sleep(500)
            return this.apiCall(request, count + 1)
          } else {
            throw new Error(
              `Paper Exchange connector | ${
                res.response?.data?.message ??
                res.response?.statusText ??
                res?.message
              }`,
            )
          }
        }
        throw new Error(
          `${
            res.response?.data?.message ??
            res.response?.statusText ??
            res?.message
          }`,
        )
      })
  }
}

export default PaperExchange
