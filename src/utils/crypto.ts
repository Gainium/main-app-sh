import CryptoJs from 'crypto-js'
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
      'directory, restart the stack, then re-encrypt what is already stored ' +
      'with: docker compose run --rm cli-runner npm run cli:rotate-encrypt-key',
  )
  logger.warn(
    'ENCRYPT_KEY: back the key up before you generate data under it — see ' +
      '"Encryption key" in docker-sh/DEPLOYMENT.md.',
  )
}

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

/** True when `str` was written under the active ENCRYPT_KEY. */
export const isRotated = (str: unknown): boolean =>
  typeof str === 'string' && str.startsWith(KEY_TAG)
