import axios from 'axios'
import http from 'http'
import {
  BybitHost,
  CoinbaseKeysType,
  ExchangeEnum,
  ExchangeKeyPermissions,
  OKXSource,
  TradeTypeEnum,
} from '../../types'
import { paperExchanges } from './paper/utils'
import { EXCHANGE_SERVICE_API_URL, PAPER_TRADING_API_URL } from '../config'

/** Mirrors the connector's VerifyResponse. `permissions` is optional: the
 *  field is additive on that cross-service contract, and paper verification
 *  (which has no real key) never carries one. */
type VerifyResponse = {
  status: boolean
  reason: string
  permissions?: ExchangeKeyPermissions
}

// These two calls go out with `sendtoall=true`, and the balancer fans a
// sendtoall request over its connector hosts SERIALLY, each with a 5-minute
// axios timeout (exchange-balancer/src/index.ts). With no timeout on our side a
// single wedged connector leg could park an interactive `addExchange` for
// minutes. 30s matches the dashboard's own apiClient ceiling (main-dash-sh
// core/src/lib/apiClient.ts), so we now give up exactly when the browser does
// and can answer with a real reason instead of holding the socket open.
const VERIFY_TIMEOUT_MS = 30_000

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
  bybitHost?: BybitHost,
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
      timeout: VERIFY_TIMEOUT_MS,
      timeoutErrorMessage: 'Verify request timed out',
    },
  )
    .then((res) => {
      if (res.status >= 400) {
        return { status: false, reason: res.statusText }
      }
      return res.data
    })
    .catch((e) => {
      // A timeout says nothing about the keys, so don't let the caller fall
      // through to its generic "API keys not valid" text. This reason is
      // curated (no braces, no "catch") so addExchange surfaces it verbatim.
      if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
        return {
          status: false,
          reason:
            'The exchange did not respond in time. Please try again in a moment.',
        }
      }
      return {
        status: false,
        reason: `Error in verifying real trading account ${e}`,
      }
    })
}

/**
 * Read a key's current permissions without running a full verification.
 *
 * Used by the periodic re-check. Deliberately NOT `/verify`: verification has
 * side effects on a connection's `status`, and an audit sweep must never be
 * able to mark a working connection as broken. This endpoint only reports.
 *
 * Resolves to `undefined` on any failure — the caller then leaves the stored
 * reading alone rather than overwriting it with an absence.
 */
export const fetchKeyPermissions = async (
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase?: string,
  keysType?: CoinbaseKeysType,
  okxSource?: OKXSource,
  bybitHost?: BybitHost,
  subaccount?: boolean,
): Promise<ExchangeKeyPermissions | undefined> => {
  if (paperExchanges.includes(provider)) {
    return undefined
  }
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
  return axios<ExchangeKeyPermissions>(
    `${EXCHANGE_SERVICE_API_URL}/keyPermissions`,
    {
      method: 'get',
      headers: authHeaders,
      httpAgent: new http.Agent({ keepAlive: true }),
      timeout: VERIFY_TIMEOUT_MS,
      timeoutErrorMessage: 'keyPermissions request timed out',
    },
  )
    .then((res) => (res.status >= 400 ? undefined : res.data))
    .catch(() => undefined)
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
    timeout: VERIFY_TIMEOUT_MS,
    timeoutErrorMessage: 'accountType request timed out',
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
  bybitHost?: BybitHost,
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
