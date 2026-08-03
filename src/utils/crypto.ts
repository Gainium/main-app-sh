import CryptoJs from 'crypto-js'

/**
 * The key this build falls back to when ENCRYPT_KEY is not set. Every value
 * written before a rotation is under it, so it must stay readable until the
 * backfill (main-app `scripts/rotateEncryptKey.js`) has re-encrypted
 * everything and reported zero remaining.
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
