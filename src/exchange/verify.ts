import axios from 'axios'
import http from 'http'
import {
  CoinbaseKeysType,
  ExchangeEnum,
  OKXSource,
  TradeTypeEnum,
} from '../../types'
import { paperExchanges } from './paper/utils'
import { EXCHANGE_SERVICE_API_URL, PAPER_TRADING_API_URL } from '../config'

type VerifyResponse = { status: boolean; reason: string }

const verifyPaper = async (key: string, secret: string) => {
  const result: VerifyResponse = await axios<{
    verified: boolean
  }>(`${PAPER_TRADING_API_URL}/user/verify?key=${key}&secret=${secret}`, {
    method: 'get',
    headers: {
      'Content-type': 'application/json',
    },
    httpAgent: new http.Agent({ keepAlive: true }),
  })
    .then((res) => ({ status: res.data.verified, reason: '' }))
    .catch((e) => ({
      status: false,
      reason: `Error in verifying paper trading account ${e}`,
    }))
  return result
}

const verifyNormal = async (
  tradeType: TradeTypeEnum,
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase?: string,
  keysType?: CoinbaseKeysType,
  okxSource?: OKXSource,
  bybitHost?: string,
  subaccount?: boolean,
): Promise<VerifyResponse> => {
  const authHeaders: Record<string, string> = {
    'Content-type': 'application/json',
  }
  authHeaders.key = key
  authHeaders.secret = secret
  if (passphrase) {
    authHeaders.passphrase = passphrase
  }
  if (keysType) {
    authHeaders.keysType = keysType
  }
  if (okxSource) {
    authHeaders.okxSource = okxSource
  }
  if (bybitHost) {
    authHeaders.bybitHost = bybitHost
  }
  authHeaders.subaccount = subaccount ? 'true' : 'false'
  authHeaders.exchange = provider
  authHeaders.sendtoall = 'true'
  return axios<VerifyResponse>(
    `${EXCHANGE_SERVICE_API_URL}/verify?tradeType=${tradeType}`,
    {
      method: 'get',
      headers: authHeaders,
      httpAgent: new http.Agent({ keepAlive: true }),
    },
  )
    .then((res) => {
      if (res.status >= 400) {
        return { status: false, reason: res.statusText }
      }
      return res.data
    })
    .catch((e) => {
      return {
        status: false,
        reason: `Error in verifying real trading account ${e}`,
      }
    })
}

export const bybitAccountType = async (
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase?: string,
): Promise<{ type: number }> => {
  const authHeaders: Record<string, string> = {
    'Content-type': 'application/json',
  }
  authHeaders.key = key
  authHeaders.secret = secret
  if (passphrase) {
    authHeaders.passphrase = passphrase
  }
  authHeaders.exchange = provider
  authHeaders.sendtoall = 'true'
  return axios(`${EXCHANGE_SERVICE_API_URL}/accountType`, {
    method: 'get',
    headers: authHeaders,
    httpAgent: new http.Agent({ keepAlive: true }),
  })
    .then((res) => {
      if (res.status >= 400) {
        return 1
      }
      return res.data
    })
    .catch(() => {
      return 1
    })
}

const verifyExchange = async (
  tradeType: TradeTypeEnum,
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase?: string,
  keysType?: CoinbaseKeysType,
  okxSource?: OKXSource,
  bybitHost?: string,
  subaccount?: boolean,
): Promise<VerifyResponse> => {
  if (paperExchanges.includes(provider)) {
    return verifyPaper(key, secret)
  }
  return verifyNormal(
    tradeType,
    provider,
    key,
    secret,
    passphrase,
    keysType,
    okxSource,
    bybitHost,
    subaccount,
  )
}

const verifiers = {
  verifyExchange: verifyExchange,
  verifyPaper: verifyPaper,
}

export default verifiers
