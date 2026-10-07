import { AsyncLocalStorage } from 'async_hooks'
import { createHash } from 'crypto'

/**
 * Who an exchange request is made for, stamped onto its telemetry row.
 *
 * Request telemetry used to carry only the exchange and the request name, so a
 * venue's weight budget filling up could be measured but never attributed: a
 * single account polling its balance in a loop looked exactly like a thousand
 * bots each reading theirs once. These fields are what make the question
 * "which account, from which code path" answerable from the telemetry alone.
 */
export type ExchangeRequestContext = {
  userId?: string
  botId?: string
  exchangeUUID?: string
}

/**
 * Stable, non-reversible reference to the exchange account behind a client.
 *
 * Derived from the API key AS STORED (the constructor argument), never from
 * the resolved plaintext: a key whose resolution is deferred would otherwise
 * change reference the moment it resolved, splitting one account in two. Every
 * client built from the same stored record therefore shares one reference,
 * which is what lets per-account accounting work without the caller having to
 * supply any identity. 16 hex chars of SHA-256 — enough to tell accounts apart,
 * useless for recovering the key.
 */
export const accountRefFor = (storedKey?: string): string =>
  storedKey
    ? createHash('sha256').update(storedKey).digest('hex').slice(0, 16)
    : ''

const callerStorage = new AsyncLocalStorage<{ caller: string }>()

/**
 * Run `fn` with `caller` as the code path recorded on every exchange request it
 * makes, however deep and across however many awaits.
 *
 * The OUTERMOST tag wins: a nested call keeps the tag it inherited. Generic
 * helpers (`checkAssets`, `getBalancesFromExchange`) tag themselves as a
 * fallback, and the call sites that matter most — sizing a deal from the
 * balance — wrap them with a more specific tag that must not be overwritten.
 *
 * Async-local rather than a field on the client because one bot shares one
 * client across concurrent paths; a field would race and mislabel requests.
 */
export const withExchangeCaller = <T>(caller: string, fn: () => T): T =>
  callerStorage.getStore()?.caller ? fn() : callerStorage.run({ caller }, fn)

/** The code path tag in effect, or '' outside any {@link withExchangeCaller}. */
export const currentExchangeCaller = (): string =>
  callerStorage.getStore()?.caller ?? ''
