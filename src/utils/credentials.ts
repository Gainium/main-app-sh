/**
 * The one place a stored credential is turned back into plaintext.
 *
 * Every read of `key` / `secret` / `passphrase` off a stored connection, and of
 * `secret` off a stored API key, should go through this module. Not because the
 * one-liner it replaces is long, but because three later changes each become a
 * single edit here instead of one edit per call site:
 *
 *   1. A blind index — a keyed fingerprint of the credential — so that dedupe
 *      can compare connections without unwrapping either of them. That is one
 *      change to `connectionMatches` rather than six near-identical rewrites
 *      spread over two resolver files.
 *   2. Binding the ciphertext to the account it belongs to, so a value lifted
 *      from one row cannot be replayed against another. This needs the
 *      connection in hand at unwrap time; `AbstractExchange`'s constructor
 *      never has it, and `resolveConnection(e)` always does.
 *   3. The `.find()` → sequential-loop restructuring that an asynchronous
 *      comparison forces. Solved once, in `findMatchingConnection`.
 *
 * There is deliberately no `resolveConnections(list)`. A list endpoint that
 * unwrapped every connection would turn one page load into N unwraps; the
 * connection list is the single hottest place this would show up. Resolve one
 * connection, when something actually needs its plaintext.
 */
import { decryptAsync } from './crypto'

/** The stored fields this module reads. Structural, so any row shape fits. */
export type StoredConnection = {
  key: string
  secret: string
  passphrase?: string
}

/** A stored API key, of which only the secret is encrypted. */
export type StoredApiKey = {
  secret: string
}

/** Plaintext credentials, as the caller supplied or recovered them. */
export type ConnectionCredentials = {
  key: string
  secret: string
  /** `''` when the connection has no passphrase, never `undefined`. */
  passphrase: string
}

/**
 * Plaintext to compare a stored connection against.
 *
 * The passphrase is compared **only when the property is present**. The two
 * dedupe shapes in the codebase differ exactly there: the add-connection
 * duplicate check compares all three fields, while the bybit/okx leg-linking
 * checks compare key and secret alone and decide the rest from the provider.
 * Passing `{ key, secret }` expresses the second; passing a `passphrase` — even
 * an `undefined` one, as destructuring an optional argument gives you —
 * expresses the first.
 */
export type CredentialCandidate = {
  key: string
  secret: string
  passphrase?: string
}

/**
 * Recover a connection's plaintext credentials.
 *
 * `passphrase` is normalised to `''` when the connection has none, which is
 * what every consumer of this shape wants. The one place that needs to tell
 * "absent" from "empty" is duplicate detection, and that is `connectionMatches`
 * rather than this function.
 */
export const resolveConnection = async (
  e: StoredConnection,
): Promise<ConnectionCredentials> => ({
  key: await decryptAsync(e.key),
  secret: await decryptAsync(e.secret),
  passphrase: e.passphrase ? await decryptAsync(e.passphrase) : '',
})

/** Recover an API key's plaintext secret. */
export const resolveApiSecret = (api: StoredApiKey): Promise<string> =>
  resolveSecret(api.secret)

/**
 * Recover any single stored secret field.
 *
 * The escape hatch for credentials that are neither an exchange connection nor
 * an API key — an agent's own LLM key, for instance. Prefer the named helpers
 * where one fits: they carry the field names, so a future blind index or
 * account binding can find their call sites. This one cannot.
 */
export const resolveSecret = (value: string): Promise<string> =>
  decryptAsync(value)

/**
 * Whether `e` holds the credentials in `candidate`.
 *
 * Compares plaintext, so it unwraps `e`. Short-circuits: a differing key costs
 * one unwrap, not three.
 *
 * The passphrase comparison reproduces the existing check exactly, including
 * the part that looks like an oversight: when the stored connection has no
 * passphrase, the *stored* falsy value is compared rather than a normalised
 * `''`. So a stored `undefined` does not match a supplied `''`. Normalising
 * both would silently make duplicate detection stricter and start rejecting
 * connections that are accepted today, which is not a change to make in passing
 * — if it should change, change it deliberately and on its own.
 */
export const connectionMatches = async (
  e: StoredConnection,
  candidate: CredentialCandidate,
): Promise<boolean> => {
  if ((await decryptAsync(e.key)) !== candidate.key) return false
  if ((await decryptAsync(e.secret)) !== candidate.secret) return false
  if (!('passphrase' in candidate)) return true
  const stored = e.passphrase ? await decryptAsync(e.passphrase) : e.passphrase
  return stored === candidate.passphrase
}

/**
 * The first connection in `list` holding `candidate`'s credentials, or `null`.
 *
 * This exists because `Array.prototype.find` cannot take an asynchronous
 * predicate — it treats the returned promise as truthy and hands back the first
 * element every time, silently. Every dedupe site that compares decrypted
 * credentials has to become a sequential loop; this is that loop, written once.
 *
 * `also` is a synchronous extra condition — provider equality, or the
 * bybit/okx same-family rules. It is evaluated **first**, so connections it
 * rules out are never unwrapped at all. That ordering is the difference between
 * unwrapping one connection and unwrapping every connection the user owns.
 */
export const findMatchingConnection = async <T extends StoredConnection>(
  list: readonly T[],
  candidate: CredentialCandidate,
  also?: (e: T) => boolean,
): Promise<T | null> => {
  for (const e of list) {
    if (also && !also(e)) continue
    if (await connectionMatches(e, candidate)) return e
  }
  return null
}
