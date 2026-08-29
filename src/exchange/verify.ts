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
 * slowest, so that one venue holds the entire accounts page.
 *
 * Deliberately NOT VERIFY_TIMEOUT_MS. That 30s is the budget for `addExchange`,
 * where the user typed new keys and the ONLY useful answer is the live one, so
 * waiting is worth it. Here there is nothing to wait for: every timeout resolves
 * to the reading already on the connection, so a probe that runs the full 30s
 * returns exactly what it would have returned at 6s — it just holds the whole
 * accounts page while it does. Spending the browser's entire ceiling to
 * reproduce a value we already have is the whole of bug #267.
 */
const PROBE_TIMEOUT_MS = 6_000

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
  // `provider`/`uuid` are read only to name the connection in the timeout warn
  // — without them a wedged venue is unidentifiable in the logs.
  stored: {
    status?: boolean
    hedge?: boolean
    provider?: ExchangeEnum
    uuid?: string
  },
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
      `verify | connection probe exceeded ${PROBE_TIMEOUT_MS}ms for ${
        stored.provider ?? 'unknown provider'
      } (${stored.uuid ?? 'no uuid'}), keeping stored status/hedge`,
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

/**
 * Cap on the whole alternate-origin sweep below.
 *
 * Deliberately much tighter than VERIFY_TIMEOUT_MS: this runs AFTER a
 * verification has already failed, inside an `addExchange` that is still
 * holding the user's browser against its own 30s ceiling. The sweep is a
 * bonus diagnosis, never the answer the mutation owes the user — so if it
 * cannot finish quickly it is dropped, and the failure is reported without it.
 */
const OKX_ORIGIN_PROBE_TIMEOUT_MS = 8_000

/** Every OKX platform a key could have been issued on. */
const OKX_ORIGINS: OKXSource[] = [OKXSource.com, OKXSource.my, OKXSource.app]

/**
 * Find which OKX platform a key actually belongs to, after it failed on the
 * one the user picked.
 *
 * OKX runs each region as a separate venue and a key only authenticates
 * against its issuer, so "API key doesn't exist" on okx.com and a perfectly
 * good my.okx.com key are the same event. The origin lives behind an
 * "Advanced Settings" disclosure that defaults to okx.com, so EU users — the
 * ones who most need to change it — routinely never see it. In prod logs for
 * 2026-08-04..28 this class accounted for 18 of 39 OKX verification failures.
 *
 * The caller uses the answer to NAME the right origin, not to switch to it.
 * That restraint is deliberate: `addExchange` decides the tradable universe
 * from `okxSource` BEFORE it verifies anything — OKX Europe has no
 * coin-margined product and its X-Perps are beta-gated to the Alpha group —
 * so adopting an origin here would land the user on the EU venue with none of
 * those restrictions applied. Telling them which dropdown value is correct
 * costs one click and keeps every existing guard in force.
 *
 * ONLY call this for a key-not-found style rejection. A timeout must never
 * reach here: 20 of those same 39 failures were the venue not answering in
 * time, and firing three more `sendtoall` fan-outs at a venue that is already
 * too slow is how the OKX rate-limit pile-up of bug #329 got built.
 *
 * Resolves to `undefined` unless EXACTLY ONE alternate authenticates —
 * nothing, several, or a sweep that overran its deadline all mean "no useful
 * answer", and the caller simply reports the original failure.
 */
export const probeOkxOrigins = async (
  tradeType: TradeTypeEnum,
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase: string | undefined,
  selected: OKXSource | undefined,
): Promise<OKXSource | undefined> => {
  if (paperExchanges.includes(provider)) {
    return undefined
  }
  const candidates = OKX_ORIGINS.filter(
    (origin) => origin !== (selected ?? OKXSource.com),
  )
  // Concurrent: these are independent read-only probes of the same key and
  // neither needs the other's answer, so the sweep costs one round trip of
  // wall clock rather than one per origin.
  const sweep = Promise.all(
    candidates.map((origin) =>
      verifyExchange(
        tradeType,
        provider,
        key,
        secret,
        passphrase,
        undefined,
        origin,
      )
        .then((res) => (res.status ? origin : undefined))
        // A probe that failed has told us nothing; only a success is evidence.
        .catch(() => undefined),
    ),
  )

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OKX_ORIGIN_PROBE_TIMEOUT_MS)
  })
  const settled = await Promise.race([sweep, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
  if (!settled) {
    logger.warn(
      `verify | OKX origin probe exceeded ${OKX_ORIGIN_PROBE_TIMEOUT_MS}ms, reporting the original failure`,
    )
    return undefined
  }
  const authenticated = settled.filter(
    (origin): origin is OKXSource => !!origin,
  )
  // More than one would mean the same credentials work on two OKX platforms,
  // which should be impossible. If it ever happens, naming one of them would
  // be a guess, so say nothing.
  return authenticated.length === 1 ? authenticated[0] : undefined
}

const verifiers = {
  verifyExchange: verifyExchange,
  verifyPaper: verifyPaper,
  probeConnectionState: probeConnectionState,
  probeOkxOrigins: probeOkxOrigins,
}

export default verifiers
