/**
 * Strips bearer secrets out of text before it is written anywhere a person or
 * another system can read it (log lines, error text returned to a client,
 * alert bodies).
 *
 * Covered today: Telegram bot tokens (`<bot id>:<secret>`). Telegram puts the
 * token in the request path (`/bot<token>/<method>`), so every network-level
 * error raised by an HTTP client talking to it — its message, its stack, its
 * request config — carries the token verbatim.
 *
 * Erring here costs a few characters of diagnostics, never a secret, so the
 * patterns are deliberately broad.
 */
import { inspect } from 'util'

export const REDACTED = '<redacted>'

/** `bot<id>:<secret>` as it appears in a request URL or path. */
const TOKEN_IN_PATH = /bot\d{5,}:[A-Za-z0-9_-]{20,}/g
/** A bare `<id>:<secret>` token, not embedded in a longer word. */
const BARE_TOKEN = /(?<![A-Za-z0-9_-])\d{5,}:[A-Za-z0-9_-]{30,}/g

/** Cheap pre-check so the common line (no secret) costs one scan. */
const MAYBE = /\d{5,}:[A-Za-z0-9_-]{20,}/

export const redactSecrets = (text: string): string => {
  if (typeof text !== 'string' || !MAYBE.test(text)) {
    return text
  }
  return text
    .replace(TOKEN_IN_PATH, `bot${REDACTED}`)
    .replace(BARE_TOKEN, REDACTED)
}

/**
 * Fields an HTTP/Telegram error carries that are useful and never secret.
 * Everything else (request config, headers, the request object, the URL) is
 * dropped rather than redacted, because it is where the secret lives.
 */
const KEPT_FIELDS = [
  'code',
  'errno',
  'type',
  'status',
  'response',
  'description',
  'error_code',
  'parameters',
] as const

/**
 * Returns an Error safe to log, rethrow or return: message and stack are
 * redacted, nested `cause` is sanitized too, and only the fields in
 * `KEPT_FIELDS` are copied (their string content redacted as well).
 */
export const sanitizeError = (err: unknown, depth = 0): Error => {
  if (!(err instanceof Error)) {
    return new Error(
      redactSecrets(typeof err === 'string' ? err : inspect(err)),
    )
  }
  const safe = new Error(redactSecrets(err.message))
  safe.name = err.name
  safe.stack = redactSecrets(err.stack ?? '')
  const src = err as unknown as Record<string, unknown>
  const dst = safe as unknown as Record<string, unknown>
  for (const f of KEPT_FIELDS) {
    if (src[f] !== undefined) {
      dst[f] =
        typeof src[f] === 'string'
          ? redactSecrets(src[f] as string)
          : typeof src[f] === 'object' && src[f] !== null
            ? JSON.parse(redactSecrets(JSON.stringify(src[f])))
            : src[f]
    }
  }
  if (src.cause !== undefined && depth < 5) {
    dst.cause = sanitizeError(src.cause, depth + 1)
  }
  return safe
}

/**
 * One logger argument → what is safe to hand to `console.*`. Strings are
 * redacted; objects (errors included) are rendered the way `console` would
 * render them and the rendering is redacted, so a secret nested anywhere
 * `console` would have printed is covered. Rendering here instead of in
 * `console` costs nothing extra; it only drops TTY colours. Other values pass
 * through.
 */
export const redactLogArg = (arg: unknown): unknown => {
  if (typeof arg === 'string') {
    return redactSecrets(arg)
  }
  if (arg !== null && typeof arg === 'object' && !(arg instanceof Date)) {
    return redactSecrets(inspect(arg))
  }
  return arg
}
