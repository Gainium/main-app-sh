import {
  CoinbaseKeysType,
  ExchangeEnum,
  OKXSource,
  TradeTypeEnum,
} from '../../types'

/**
 * Turn a failed key verification into something the user can act on.
 *
 * WHY THIS EXISTS
 * ---------------
 * The connector already learns exactly why a key was refused — "API key
 * doesn't exist", "Unmatched IP", "you are in unified account mode" — and
 * hands it back in `VerifyResponse.reason`. But that reason is
 * `JSON.stringify(BaseReturn)`, so it arrives wrapped in `usage` and
 * `timeProfile` noise, and the old call sites suppressed anything containing a
 * brace and answered `API keys not valid for <tradeType>` instead. Over
 * 2026-08-04..28 that collapsed 370 failures across 93 distinct users into one
 * message that says nothing; several users retried 8, 13 and 19 times.
 *
 * THE RULE
 * --------
 * Extraction and interpretation are separate, and interpretation NEVER
 * replaces the exchange's own words:
 *
 *   extract      Pull the exchange's sentence out of the envelope. Mechanical,
 *                cannot be wrong, and on its own turns an unreadable dump into
 *                one clean line.
 *   interpret    Guess what the user should DO about it. Fallible — venues
 *                reword their errors without warning — so it is only ever
 *                PREPENDED to the extracted original. A stale or mistaken rule
 *                then costs the user nothing: the ground truth is still right
 *                there underneath it.
 *
 * That ordering is the whole safety argument. Never "improve" this by dropping
 * the original once a rule matches.
 *
 * SELF-HOSTED
 * -----------
 * This module ships in `core`, so it runs on customer-operated deployments
 * too. Guidance must therefore describe VENUE behaviour only — never Gainium
 * cloud infrastructure. In particular: do not name egress IPs here. A
 * self-hosted install calls the exchange from the customer's own address, and
 * printing ours would send them to allowlist the wrong thing. Point at the
 * allowlist as a concept and let the (cloud-specific) help article carry the
 * numbers.
 */

/** Everything a rule may look at. */
export type VerifyFailureContext = {
  provider: ExchangeEnum
  tradeType: TradeTypeEnum
  /** Raw `VerifyResponse.reason`, exactly as the connector produced it. */
  reason?: string
  /** Submitted credentials — Coinbase's rules read their SHAPE, never a value. */
  key?: string
  secret?: string
  keysType?: CoinbaseKeysType
  okxSource?: OKXSource
  /**
   * The OKX platform the key was found to actually belong to, when the caller
   * ran `probeOkxOrigins` after a key-not-found rejection. Turns the origin
   * guidance from "check this dropdown" into "set it to this value".
   */
  detectedOkxSource?: OKXSource
}

/**
 * A venue message long enough to be a signed payload rather than a sentence is
 * truncated: Bybit's signature error inlines the whole `origin_string[...]`,
 * which is both unreadable and derived from the credential.
 */
const MAX_EXCHANGE_MESSAGE = 300

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * The reason is sometimes a bare envelope (`{"status":"NOTOK",...}`) and
 * sometimes prose with an envelope embedded in it (`Binance catch code=-1022
 * {"code":-1022,"msg":"..."} Signature ...`). Take the widest brace-delimited
 * span and let JSON.parse decide whether it was really an object.
 */
const embeddedObject = (raw: string): unknown => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return undefined
  }
  return parseJson(raw.slice(start, end + 1))
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** `reason` is the connector's own envelope field; `msg` is the venue's. */
const messageFrom = (obj: unknown): string | undefined => {
  const rec = asRecord(obj)
  if (!rec) {
    return undefined
  }
  for (const field of ['reason', 'msg'] as const) {
    const v = rec[field]
    if (typeof v === 'string' && v.trim()) {
      return v.trim()
    }
  }
  return undefined
}

const truncate = (s: string): string =>
  s.length > MAX_EXCHANGE_MESSAGE
    ? `${s.slice(0, MAX_EXCHANGE_MESSAGE).trimEnd()}…`
    : s

/**
 * The exchange's own words, or `undefined` when the payload carried none.
 *
 * `undefined` is a real answer and a common one: Coinbase's `getApiPermission`
 * swallows its error and reports `{"status":"OK","data":false,"reason":null}`,
 * so there is genuinely nothing to quote. Returning the raw envelope there
 * would show the user a JSON dump and teach them nothing.
 */
export const extractExchangeReason = (raw?: string): string | undefined => {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    return undefined
  }
  const obj = parseJson(trimmed) ?? embeddedObject(trimmed)
  const message = messageFrom(obj)
  if (message) {
    return truncate(message)
  }
  // Structured but message-less (Coinbase's null reason, Binance's permission
  // dump). The structural rules below read those; quoting them helps nobody.
  if (asRecord(obj)) {
    return undefined
  }
  // No object at all: already prose, and usually already curated upstream
  // (Kraken's WebSocket-permission text, Hyperliquid's agent-address text).
  return truncate(trimmed)
}

const family = (provider: ExchangeEnum): string => `${provider}`.toLowerCase()

const matches = (message: string | undefined, re: RegExp): boolean =>
  !!message && re.test(message)

/** Which OKX platform the submitted credentials were about to be checked on. */
const okxOriginHost = (source?: OKXSource): string =>
  source === OKXSource.my
    ? 'my.okx.com'
    : source === OKXSource.app
      ? 'app.okx.com'
      : 'okx.com'

/** How that platform is described in the dropdown, so the two agree. */
const okxOriginLabel = (source: OKXSource): string =>
  source === OKXSource.my
    ? 'my.okx.com (OKX Europe)'
    : source === OKXSource.app
      ? 'app.okx.com (regional entities such as OKX US or Australia)'
      : 'okx.com (global)'

/**
 * True when OKX refused the key in the way it refuses a key issued by one of
 * its OTHER regional platforms.
 *
 * The caller uses this to decide whether sweeping the other origins is worth a
 * round trip. It must stay narrow: a timeout or a rate-limit answer must NOT
 * match, because re-probing a venue that is already failing to answer is how
 * an OKX rate-limit pile-up starts.
 */
export const isOkxOriginSuspect = (
  provider: ExchangeEnum,
  reason?: string,
): boolean => {
  if (!family(provider).startsWith('okx')) {
    return false
  }
  return matches(
    extractExchangeReason(reason),
    /api key doesn'?t exist|apikey does not exist|invalid ok-access-key/i,
  )
}

/**
 * A Coinbase Developer Platform key is recognisable without asking Coinbase:
 * the key NAME is a resource path, and the secret is a PEM private key. Legacy
 * keys are neither. This is why the Coinbase rules can say something useful
 * even though the venue told us nothing at all.
 */
const looksLikeCloudCoinbaseKey = (key?: string, secret?: string): boolean => {
  const k = key ?? ''
  const s = secret ?? ''
  return (
    (k.includes('organizations/') && k.includes('/apiKeys/')) ||
    /-----BEGIN (EC )?PRIVATE KEY-----/.test(s)
  )
}

/**
 * An Ed25519 CDP key, which the portal now issues BY DEFAULT: the secret is
 * the raw 64-byte private key as one line of base64 (86 chars, usually padded
 * to 88) with no PEM armour, and the key id is a bare UUID. Our Coinbase SDK
 * signs its JWTs with ES256 only, so this key can NEVER authenticate — with
 * "Cloud Trading Keys" selected jsonwebtoken refuses to sign at all
 * ("secretOrPrivateKey must be an asymmetric key when using ES256"), and under
 * the default "Legacy Keys" it is HMAC-signed into a plain 401. Neither dead
 * end names the actual problem, and the shape fails looksLikeCloudCoinbaseKey,
 * so without its own rule the cloud-type case would fall into the "switch to
 * Legacy Keys" advice — the one change that cannot help.
 */
const looksLikeEd25519CoinbaseSecret = (secret?: string): boolean => {
  const s = (secret ?? '').trim()
  return !s.includes('-----BEGIN') && /^[A-Za-z0-9+/]{86}(==)?$/.test(s)
}

/** The Binance permission flag this trade type actually needs. */
const binanceRequiredFlag = (
  tradeType: TradeTypeEnum,
): { field: string; label: string } | undefined =>
  tradeType === TradeTypeEnum.futures
    ? { field: 'enableFutures', label: 'Enable Futures' }
    : tradeType === TradeTypeEnum.margin
      ? { field: 'enableMargin', label: 'Enable Margin' }
      : tradeType === TradeTypeEnum.spot
        ? {
            field: 'enableSpotAndMarginTrading',
            label: 'Enable Spot & Margin Trading',
          }
        : undefined

/**
 * What we think the user should do, or `undefined` when no rule is confident.
 *
 * Every branch here is a guess about a third party's wording. That is
 * acceptable only because the caller always prints the venue's own message
 * underneath whatever this returns.
 */
export const interpretVerifyFailure = (
  ctx: VerifyFailureContext,
  exchangeSaid = extractExchangeReason(ctx.reason),
): string | undefined => {
  const provider = family(ctx.provider)
  const said = exchangeSaid

  if (provider.startsWith('okx')) {
    if (
      matches(
        said,
        /api key doesn'?t exist|apikey does not exist|invalid ok-access-key/i,
      )
    ) {
      // When the sweep found the issuing platform there is nothing left to
      // guess — name it, and let the user change one dropdown. We stop short
      // of switching it for them on purpose: addExchange derives the tradable
      // universe from `okxSource` BEFORE verifying, and OKX Europe has no
      // coin-margined product and beta-gates its X-Perps, so adopting an
      // origin here would bypass those guards.
      if (ctx.detectedOkxSource && ctx.detectedOkxSource !== ctx.okxSource) {
        return `These credentials belong to ${okxOriginLabel(
          ctx.detectedOkxSource,
        )}, but this connection is set to ${okxOriginHost(
          ctx.okxSource,
        )}. OKX runs each region as a separate platform and a key only works on the one that issued it. Open Advanced Settings and set "OKX Origin" to ${okxOriginHost(
          ctx.detectedOkxSource,
        )}, then try again.`
      }
      return `OKX does not recognise this API key on ${okxOriginHost(
        ctx.okxSource,
      )}. OKX runs each region as a separate platform and a key only works on the one that issued it. Open Advanced Settings and set "OKX Origin" to the site you were logged in to when you created the key — my.okx.com for OKX Europe (EEA), app.okx.com for regional entities such as OKX US or Australia, okx.com otherwise.`
    }
    if (matches(said, /ok-access-passphrase incorrect/i)) {
      return 'OKX rejected the passphrase. This is the passphrase you chose when creating the API key, not your OKX account password. If you are updating an existing connection, re-enter it here — the field starts blank, and leaving it blank keeps the passphrase stored with your previous key.'
    }
  }

  if (provider.startsWith('bybit')) {
    if (matches(said, /unmatched ip/i)) {
      return "This API key is restricted to specific IP addresses and Bybit did not see a permitted one. Add Gainium's IP addresses to the key's allowlist on Bybit, or remove the restriction."
    }
    if (matches(said, /api key is invalid/i)) {
      return 'Bybit does not recognise this API key. Check that the key was copied in full, that it has not been deleted or expired, and that Advanced Settings names the Bybit site your account is on.'
    }
    if (matches(said, /check permissions/i)) {
      return 'The key reached Bybit but is missing a permission Gainium needs. Edit the key on Bybit and enable read and trade access for the account type you are connecting.'
    }
    if (matches(said, /error sign/i)) {
      return 'Bybit rejected the request signature, which almost always means the API secret is wrong or was truncated when pasted. Re-copy the secret and try again.'
    }
  }

  if (provider.startsWith('bitget')) {
    if (
      matches(
        said,
        /unified account mode.*classic account api|classic account api is not supported/i,
      )
    ) {
      return "Your Bitget account is in Unified Account mode, which this API key cannot be used with. Create the key from Bitget's Unified Account API settings and connect that one instead."
    }
    if (matches(said, /apikey\/password is incorrect/i)) {
      return 'Bitget rejected the passphrase (it calls it the API password). This is the passphrase you set when creating the key, not your Bitget account password. When updating an existing connection, re-enter it — leaving it blank keeps the passphrase stored with your previous key.'
    }
    if (matches(said, /apikey does not exist/i)) {
      return 'Bitget does not recognise this API key. Check that it was copied in full and has not been deleted.'
    }
  }

  if (provider.startsWith('kucoin')) {
    if (matches(said, /400006|invalid request ip/i)) {
      return "This API key is restricted to specific IP addresses and KuCoin did not see a permitted one. Add Gainium's IP addresses to the key's allowlist on KuCoin, or remove the restriction."
    }
    if (matches(said, /400004|invalid kc-api-passphrase/i)) {
      return 'KuCoin rejected the passphrase. This is the passphrase you chose when creating the API key, not your KuCoin account password. When updating an existing connection, re-enter it — leaving it blank keeps the passphrase stored with your previous key.'
    }
    if (matches(said, /400003|does not exist or site mismatch/i)) {
      return 'KuCoin does not recognise this API key. Check that it was copied in full, that it has not been deleted, and that it was created on the same KuCoin site your account is on.'
    }
  }

  if (provider.startsWith('kraken')) {
    if (matches(said, /eapi:invalid key|authenticationerror/i)) {
      return 'Kraken did not accept this key and secret. Check that both were copied in full — a Kraken secret is long and easy to truncate — and that the key has not been deleted.'
    }
    if (matches(said, /egeneral:permission denied/i)) {
      return 'The key reached Kraken but is missing a permission Gainium needs. Edit the key on Kraken and enable the query and trade permissions for the account you are connecting.'
    }
  }

  if (provider.startsWith('binance')) {
    if (matches(said, /signature for this request is not valid/i)) {
      return 'Binance rejected the request signature, which almost always means the API secret is wrong or was truncated when pasted. Re-copy the secret and try again.'
    }
    // Structural: on a permission failure the connector sends the permission
    // object itself as the reason, so there is no sentence to quote — but it
    // says precisely which switch is off.
    const perms = asRecord(parseJson((ctx.reason ?? '').trim()))
    const required = binanceRequiredFlag(ctx.tradeType)
    if (perms && required && perms[required.field] === false) {
      return `Your Binance API key does not have "${required.label}" turned on, which Gainium needs to trade ${ctx.tradeType}. Edit the key in Binance's API Management and enable it.`
    }
  }

  if (provider.startsWith('coinbase')) {
    // Checked before the key-type rules: the Ed25519 shape matches neither
    // key type, and no Key Type toggle can make it work. The message-match
    // arm is the belt to the shape check's braces — it fires on the ES256
    // signing error even if Coinbase reshapes its key export.
    if (
      looksLikeEd25519CoinbaseSecret(ctx.secret) ||
      matches(said, /asymmetric key when using es256/i)
    ) {
      return 'This is an Ed25519 API key, which Gainium cannot use yet. Create a new key at portal.cdp.coinbase.com and choose the ECDSA signature algorithm (Coinbase preselects Ed25519 — expand the key options to change it). Then connect with the key\'s full name ("organizations/…/apiKeys/…", not just the key id), its "-----BEGIN EC PRIVATE KEY-----" secret, and Key Type set to "Cloud Trading Keys" in Advanced Settings.'
    }
    // Coinbase tells us nothing: `getApiPermission` catches its own error and
    // reports success-with-false. The key's SHAPE is the only evidence there
    // is, so lead with the mismatch when we can see one.
    const looksCloud = looksLikeCloudCoinbaseKey(ctx.key, ctx.secret)
    if (looksCloud && ctx.keysType === CoinbaseKeysType.legacy) {
      return 'This looks like a Coinbase Developer Platform key, but Key Type is set to "Legacy Keys". Open Advanced Settings and change Key Type to "Cloud Trading Keys".'
    }
    if (!looksCloud && ctx.keysType === CoinbaseKeysType.cloud) {
      return 'Key Type is set to "Cloud Trading Keys", but this does not look like a Coinbase Developer Platform key. Either switch Key Type to "Legacy Keys", or create a Trading key at portal.cdp.coinbase.com and use its full key name and private key.'
    }
    return "Coinbase refused the key without saying why. The usual causes are the wrong Key Type in Advanced Settings, the key missing View and Trade permissions, or the key's IP allowlist not including Gainium's addresses."
  }

  return undefined
}

/** Display name for the venue, for the "<X> replied:" line. */
const venueLabel = (provider: ExchangeEnum): string => {
  const p = family(provider)
  const known = [
    ['okx', 'OKX'],
    ['binance', 'Binance'],
    ['bybit', 'Bybit'],
    ['bitget', 'Bitget'],
    ['kucoin', 'KuCoin'],
    ['coinbase', 'Coinbase'],
    ['kraken', 'Kraken'],
    ['hyperliquid', 'Hyperliquid'],
    ['mexc', 'MEXC'],
  ] as const
  return known.find(([prefix]) => p.startsWith(prefix))?.[1] ?? 'The exchange'
}

/**
 * The single `reason` string the GraphQL mutation returns to the dashboard.
 *
 * Shape is always guidance-then-evidence, and the evidence is never dropped:
 *
 *   <what to do about it, when a rule matched>
 *
 *   OKX replied: "API key doesn't exist"
 *
 * With no rule match the first line falls back to today's wording, so this can
 * only ever add information to an existing failure, never remove it.
 */
export const buildVerifyFailureReason = (ctx: VerifyFailureContext): string => {
  const exchangeSaid = extractExchangeReason(ctx.reason)
  const guidance = interpretVerifyFailure(ctx, exchangeSaid)
  const head = guidance ?? `API keys not valid for ${ctx.tradeType}.`
  return exchangeSaid
    ? `${head}\n\n${venueLabel(ctx.provider)} replied: "${exchangeSaid}"`
    : head
}
