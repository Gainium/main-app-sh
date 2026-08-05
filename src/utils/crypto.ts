import CryptoJs from 'crypto-js'
import { getCredentialResolver, isResolverManaged } from './credentialResolver'
import logger from './logger'

/**
 * The key this build falls back to when ENCRYPT_KEY is not set. Every value
 * written before a rotation is under it, so it must stay readable until the
 * backfill (`src/cli/rotateEncryptKey.js`) has re-encrypted everything and
 * reported zero remaining.
 */
export const FALLBACK_KEY = '4d01d0f4-af0c-4f60-b7f7-6396ad7823f4'

/**
 * Marks a ciphertext as written under ENCRYPT_KEY rather than FALLBACK_KEY.
 *
 * The alternative — try the new key, fall back on failure — is not safe here.
 * CryptoJS does not signal a wrong key: it returns bytes that usually fail
 * UTF-8 decoding and yield '', but in ~0.46% of cases (measured over 200k
 * trials) it yields a short non-empty string instead. At that rate, roughly
 * one credential in 200 would silently decrypt to garbage rather than falling
 * back, which surfaces as an unexplained exchange auth failure. Tagging makes
 * the choice of key deterministic instead of probabilistic.
 */
const KEY_TAG = 'g2:'

const key = process.env.ENCRYPT_KEY || FALLBACK_KEY

/**
 * Whether this process encrypts under a key belonging to this installation
 * rather than the one compiled into the build.
 *
 * Exposed so the API can tell the dashboard to recommend setting one. It
 * reports a yes/no only — never the key, its length, or its source.
 */
export const isEncryptKeyConfigured = (): boolean => key !== FALLBACK_KEY

// Said once per process at import time, because the alternative — saying
// nothing — is how an installation runs for months without anyone noticing
// the setting exists. Says what to do, not just that something is off.
if (!isEncryptKeyConfigured()) {
  // "has no key of its own" rather than "is not set": ENCRYPT_KEY may in fact
  // be set, to the build's own default value. Same posture, and telling an
  // operator a variable they just set is unset sends them the wrong way.
  logger.warn(
    'ENCRYPT_KEY: this installation has no encryption key of its own — ' +
      'stored exchange API credentials are encrypted with the key that ships ' +
      'in the build, which is the same for every installation. Setting your ' +
      'own is recommended.',
  )
  logger.warn(
    'ENCRYPT_KEY: generate one with ./setupEncryptKey.sh in your docker-sh ' +
      'directory and restart the stack. Credentials already stored are ' +
      're-encrypted for you on the next start — nothing else to run.',
  )
  logger.warn(
    'ENCRYPT_KEY: back the key up before you generate data under it — see ' +
      '"Encryption key" in docker-sh/DEPLOYMENT.md.',
  )
}

/**
 * Prefix of CryptoJS's salted output. Every value this module has ever written
 * without a tag begins with it, so it identifies "this module wrote it" without
 * attempting a decryption.
 */
const AES_PREFIX = 'U2FsdGVkX1'

/**
 * Whether this module can read `str` on its own — i.e. it wrote it, under
 * either key. False for anything else, including formats a host resolver owns.
 */
export const isReadableHere = (str: unknown): boolean =>
  typeof str === 'string' &&
  (str.startsWith(KEY_TAG) || str.startsWith(AES_PREFIX))

const raw = (str: string, k: string) => {
  try {
    return CryptoJs.AES.decrypt(str, k).toString(CryptoJs.enc.Utf8)
  } catch {
    return str
  }
}

/**
 * Encrypts under the active key. Output is tagged only when the value is
 * being written under a rotated ENCRYPT_KEY *and* the caller did not supply
 * its own key — so with ENCRYPT_KEY unset the output is byte-compatible with
 * every value already at rest, and callers that pass their own service key
 * (watchdog, presets, backtest tokens) are untouched.
 */
export const encrypt = (str: string, k?: string) => {
  const ciphertext = CryptoJs.AES.encrypt(str, k ?? key).toString()
  return k === undefined && key !== FALLBACK_KEY
    ? KEY_TAG + ciphertext
    : ciphertext
}

/**
 * Decrypts a value written by `encrypt`.
 *
 * An explicit `k` is honoured exactly as before — those call sites own both
 * ends of their own token and never participate in the rotation. Otherwise
 * the tag decides: tagged values are under ENCRYPT_KEY, untagged values are
 * under FALLBACK_KEY. Note untagged values resolve to FALLBACK_KEY even after
 * a rotation, which is what keeps un-backfilled rows readable.
 */
export const decrypt = (str: string, k?: string) => {
  if (k !== undefined) {
    return raw(
      typeof str === 'string' && str.startsWith(KEY_TAG)
        ? str.slice(KEY_TAG.length)
        : str,
      k,
    )
  }
  if (typeof str === 'string' && str.startsWith(KEY_TAG)) {
    return raw(str.slice(KEY_TAG.length), key)
  }
  return raw(str, FALLBACK_KEY)
}

/**
 * Async form of `decrypt`, for values that may be in a format only the host
 * application understands (see `credentialResolver.ts`).
 *
 * With no resolver registered this is `decrypt` with a promise around it, so
 * call sites can be migrated to it before — or without ever — a resolver
 * existing. That is deliberate: it lets the read path ship and be verified on
 * its own, ahead of anything that writes the new format.
 *
 * An explicit `k` never reaches the resolver. Those call sites own both ends of
 * their own token and are not stored credentials, so they keep the exact
 * behaviour they have always had.
 */
export const decryptAsync = async (
  str: string,
  k?: string,
): Promise<string> => {
  if (k === undefined) {
    if (isResolverManaged(str)) {
      // Non-null: isResolverManaged is false when nothing is registered.
      return getCredentialResolver()!.resolve(str)
    }
    if (typeof str === 'string' && str !== '' && !isReadableHere(str)) {
      // The value is in neither format this module writes, and no resolver
      // claims it. Falling through would hand it to AES under the fallback
      // key, which does not fail: it returns '' or a short run of bytes, and
      // the caller uses that as if it were the credential. The result is an
      // authentication failure at the exchange with no exception anywhere —
      // the single hardest thing to diagnose in this whole path.
      //
      // The realistic cause is a process that is missing the configuration its
      // peers have, so say that rather than describing the bytes.
      throw new Error(
        'decryptAsync: stored value is in a format this process cannot read. ' +
          'It was most likely written by a process configured with a ' +
          'credential resolver that this one does not have.',
      )
    }
  }
  return decrypt(str, k)
}

/** True when `str` was written under the active ENCRYPT_KEY. */
export const isRotated = (str: unknown): boolean =>
  typeof str === 'string' && str.startsWith(KEY_TAG)
