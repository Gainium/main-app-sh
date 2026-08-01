import axios from 'axios'
import http from 'http'
import {
  BaseReturn,
  BybitHost,
  CoinbaseKeysType,
  ExchangeEnum,
  ExchangeKeyPermissions,
  OKXSource,
  StatusEnum,
  TradeTypeEnum,
} from '../../types'
import { paperExchanges } from './paper/utils'
import { EXCHANGE_SERVICE_API_URL, PAPER_TRADING_API_URL } from '../config'
import logger from '../utils/logger'

/** Mirrors the connector's VerifyResponse. `permissions` is optional: the
 *  field is additive on that cross-service contract, and paper verification
 *  (which has no real key) never carries one. */
export type VerifyResponse = {
  status: boolean
  reason: string
  permissions?: ExchangeKeyPermissions
  /**
   * Set when we never got a verdict at all — the connector timed out, 502'd or
   * dropped the socket. Locally computed, never sent by the connector, so it
   * adds nothing to that cross-service contract.
   *
   * `status: false` alongside this does NOT mean "these keys are bad"; it only
   * means "no answer". Callers that PERSIST a connection's status must leave
   * the stored value alone when this is set.
   */
  unreachable?: boolean
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
    // Same rule as verifyNormal below: a paper-trading service that is down
    // has not told us the simulated account is broken.
    .catch((e) => ({
      status: false,
      unreachable: true,
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
        return { status: false, reason: res.statusText, unreachable: true }
      }
      return res.data
    })
    .catch((e) => {
      // Nothing that lands here is a verdict about the keys: the connector
      // answers "these keys are bad" with HTTP 200 and `status: false`.
      // Everything else — a timeout, a 502 from a wedged connector node, a
      // dropped socket — means we simply never got an answer, so flag it.
      // A timeout says nothing about the keys, so don't let the caller fall
      // through to its generic "API keys not valid" text. This reason is
      // curated (no braces, no "catch") so addExchange surfaces it verbatim.
      if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
        return {
          status: false,
          unreachable: true,
          reason:
            'The exchange did not respond in time. Please try again in a moment.',
        }
      }
      return {
        status: false,
        unreachable: true,
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

/**
 * Cap on ONE stored connection's live probe on the accounts page.
 *
 * `verify` already gives up at VERIFY_TIMEOUT_MS, but `getHedge` inherits
 * exchange.ts's 5-minute axios ceiling and retries up to five times on a 502 —
 * so on its own a single wedged venue can park a probe for tens of minutes.
 * `updateStatus` fans these out with `Promise.all`, which waits for the
 * slowest, so that one venue holds the entire accounts page. Give up at the
 * same 30s the browser does and answer from what we already stored.
 */
const PROBE_TIMEOUT_MS = VERIFY_TIMEOUT_MS

/**
 * Live-probe one already-stored exchange connection for the accounts page.
 *
 * `verify` and `getHedge` are independent read-only probes of the SAME keys —
 * neither needs the other's answer — so they run CONCURRENTLY here, and the
 * pair is capped at PROBE_TIMEOUT_MS.
 *
 * Every failure mode resolves to the values already on the connection. The
 * caller PERSISTS what this returns, and a connector that timed out or 502'd
 * has told us nothing about the user's keys: answering `false` there would
 * mark a healthy connection broken and flip `hedge` — which drives live
 * trading — for every user holding the affected exchange. This is the rule
 * `fetchKeyPermissions` above already follows for permissions.
 */
export const probeConnectionState = async (
  stored: { status?: boolean; hedge?: boolean },
  runVerify: () => Promise<VerifyResponse>,
  /** Omitted for spot connections, which have no hedge mode to read. */
  runHedge?: () => Promise<BaseReturn<boolean>>,
): Promise<{
  status: boolean
  hedge: boolean
  permissions?: ExchangeKeyPermissions
}> => {
  const storedStatus = stored.status ?? false
  const storedHedge = stored.hedge ?? false
  // Neither probe rejects (both funnel through their own catch/handleError),
  // but they are raced away below and must not be able to surface an
  // unhandled rejection if that ever changes.
  const probes = Promise.all([
    runVerify().catch(
      (e: Error): VerifyResponse => ({
        status: false,
        unreachable: true,
        reason: e?.message ?? 'verify failed',
      }),
    ),
    runHedge
      ? runHedge().catch(() => null)
      : Promise.resolve<BaseReturn<boolean> | null>(null),
  ])

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
  })
  const settled = await Promise.race([probes, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })

  if (!settled) {
    logger.warn(
      `verify | connection probe exceeded ${PROBE_TIMEOUT_MS}ms, keeping stored status/hedge`,
    )
    return { status: storedStatus, hedge: storedHedge }
  }

  const [verified, hedge] = settled
  return {
    // `unreachable` is "no answer", not "bad keys" — keep what we had.
    status: verified.unreachable ? storedStatus : verified.status,
    // Spot connections have no hedge mode; a failed read keeps the stored one.
    hedge: !runHedge
      ? false
      : hedge?.status === StatusEnum.ok
        ? !!hedge.data
        : storedHedge,
    permissions: verified.permissions,
  }
}

const verifiers = {
  verifyExchange: verifyExchange,
  verifyPaper: verifyPaper,
  probeConnectionState: probeConnectionState,
}

export default verifiers
