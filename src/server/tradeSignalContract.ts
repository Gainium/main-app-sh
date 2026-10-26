import bodyParser from 'body-parser'
import type express from 'express'

import { StatusEnum } from '../../types'

/**
 * `/trade_signal` is the only endpoint whose callers are third-party alert
 * senders — TradingView alerts, n8n flows, shell scripts — rather than our own
 * frontend. That makes it the one endpoint where a malformed body is routine
 * rather than a programming error, and it is the reason this contract is
 * pulled out of both server entrypoints instead of living in either: the cloud
 * (`main-app/src/server/index.ts`) and self-hosted (`core/src/server/index.ts`)
 * routes are byte-identical, and a webhook that behaves differently between
 * them is a support case nobody can reproduce.
 *
 * Two failure modes used to leave no evidence at all:
 *
 *  - An unparsable body died inside the shared `bodyParser.json()` mounted on
 *    `/`, so Express answered a bare HTML `Bad Request` from its default error
 *    handler. That happens before any route runs, so nothing was logged and no
 *    bot was ever resolved — "did this bot's webhook 400?" was unanswerable.
 *  - A parsable body that matched no bot was answered `200 OK`, which every
 *    sender reads as "delivered".
 */
const RAW_BODY_SNIPPET_CHARS = 200

type RawTradeSignalBody = { rawTradeSignalBody?: string }

/**
 * Enough of the body to show the *shape* of the mistake — a quoted/escaped
 * JSON string, single-quoted keys, an alert template that rendered empty —
 * without committing an arbitrary third-party payload to the logs.
 */
export function rawTradeSignalSnippet(req: unknown): string {
  return (req as RawTradeSignalBody)?.rawTradeSignalBody ?? ''
}

export function invalidJsonBodyReason(message: string): string {
  return (
    `Invalid JSON body: ${message}. Send the payload as a raw JSON object ` +
    `with double-quoted keys and Content-Type: application/json — not as a ` +
    `quoted or escaped JSON string, and not with unquoted keys.`
  )
}

/**
 * One-line description of what a sender asked for, keyed by the uuid it
 * actually used. Deliberately reports `no-uuid`/`no-action` rather than
 * dropping the entry: a template that rendered empty is the common cause, and
 * the absence is the diagnosis.
 */
export function tradeSignalSummary(body: unknown): string {
  const signals = [body].flat() as Array<
    { action?: unknown; uuid?: unknown } | undefined
  >
  return (
    signals
      .map(
        (d) =>
          `${summaryField(d?.action, 'no-action')}:${summaryField(d?.uuid, 'no-uuid')}`,
      )
      .join(', ') || 'empty payload'
  )
}

/**
 * A sender-supplied value as it goes into the log line: JSON-escaped, so a
 * newline or control character cannot start a line of its own. A plain text
 * value reads exactly as before (no quotes); anything else is shown as JSON.
 */
function summaryField(value: unknown, absent: string): string {
  if (value === undefined || value === null) return absent
  const text =
    typeof value === 'string'
      ? JSON.stringify(value).slice(1, -1)
      : (JSON.stringify(value) ?? String(value))
  return text.length > RAW_BODY_SNIPPET_CHARS
    ? `${text.slice(0, RAW_BODY_SNIPPET_CHARS)}…`
    : text
}

/**
 * Mount ahead of the shared `app.use('/', bodyParser.json())` so `/trade_signal`
 * is parsed here first, with the raw bytes retained. body-parser marks the
 * request as parsed, so the shared mount is then a no-op for these requests
 * rather than a second parse.
 */
export function mountTradeSignalParser(
  app: express.Express,
  log: (message: string) => void,
): void {
  app.use(
    '/trade_signal',
    bodyParser.json({
      verify: (req, _res, buf) => {
        ;(req as unknown as RawTradeSignalBody).rawTradeSignalBody = buf
          .toString('utf8')
          .slice(0, RAW_BODY_SNIPPET_CHARS)
      },
    }),
  )
  app.use(
    '/trade_signal',
    (
      err: (Error & { type?: string }) | undefined,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!err) {
        next()
        return
      }
      // Size limits and the like keep whatever handling they had.
      if (err.type !== 'entity.parse.failed') {
        next(err)
        return
      }
      log(
        `[trade_signal] unparsable body from ${req.ip ?? 'unknown'}: ${
          err.message
        } | body starts: ${JSON.stringify(rawTradeSignalSnippet(req))}`,
      )
      res.status(400).send({
        status: StatusEnum.notok,
        reason: invalidJsonBodyReason(err.message),
        data: null,
      })
    },
  )
}

/**
 * Which of the two required fields a payload is missing. Both are required by
 * `singleWebhookProcess`, which used to fall off the end and return
 * `undefined` when either was absent — read by `webhookProcess` as
 * `StatusEnum.ok`, i.e. the same silent 200 an unresolvable uuid used to get.
 */
export function missingWebhookFields(data: unknown): string[] {
  const d = data as { action?: unknown; uuid?: unknown } | undefined
  return [!d?.action && 'action', !d?.uuid && 'uuid'].filter(
    Boolean,
  ) as string[]
}

/**
 * Why a signal for a uuid that no running bot holds was not executed, from the
 * stored bot's status (`undefined` when no bot has that uuid). An active status
 * with no running bot means the bot service is re-loading its bots.
 */
export function webhookBotNotRunningReason(
  status: string | undefined,
  action: string,
): string {
  if (!status) return 'Bot not found'
  if (status === 'closed') {
    return `Bot is stopped, so "${action}" was not executed. Start the bot first.`
  }
  if (status === 'archive') {
    return `Bot is archived, so "${action}" was not executed.`
  }
  return `Bot is restarting on our side, so "${action}" was not executed.`
}

/** Longest `action` / `uuid` / `signalId` a signal may carry; a bot uuid is 36. */
export const WEBHOOK_TEXT_FIELD_MAX_CHARS = 64

const webhookTextFields = ['action', 'uuid', 'signalId'] as const

/**
 * Which of the text fields a payload carries as something other than short
 * plain text — an object, an array, a number, or an over-long string. The bot
 * lookups take `uuid` as a value to match, so such a signal is refused before
 * any of them. Absent and empty fields are `missingWebhookFields`' to report.
 */
export function malformedWebhookFields(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  return webhookTextFields.filter((field) => {
    const value = d[field]
    if (value === undefined || value === null || value === '') return false
    return (
      typeof value !== 'string' || value.length > WEBHOOK_TEXT_FIELD_MAX_CHARS
    )
  })
}

export function malformedWebhookFieldsReason(fields: string[]): string {
  return (
    `Webhook field(s) ${fields.join(', ')} must be plain text of at most ` +
    `${WEBHOOK_TEXT_FIELD_MAX_CHARS} characters. Expected a JSON object such as ` +
    `{"action":"startDeal","uuid":"<bot uuid>"}.`
  )
}

export function missingWebhookFieldsReason(missing: string[]): string {
  return (
    `Webhook payload is missing required field(s): ${missing.join(', ')}. ` +
    `Expected a JSON object such as ` +
    `{"action":"startDeal","uuid":"<bot uuid>"}.`
  )
}

/**
 * The latest a signal may still run, measured from when the API received it.
 * A TradingView alert is a decision about the market at the moment it fired;
 * executed minutes later it may be the wrong one. So a signal runs if it can
 * run within this window — straight away, after waiting for a bot that is
 * still re-loading, or when its bot service comes back and takes it from the
 * queue or the replay queue — and is otherwise dropped with the reason logged.
 */
export const WEBHOOK_SIGNAL_MAX_AGE_MS = 60_000

/**
 * The cap for a close signal (`closeDeal`, `closeDealSl`). A late close takes
 * risk off rather than adding it — on a leveraged position, closing two
 * minutes late is usually far better than not closing — so it may run for
 * longer. It still has a cap: a close replayed an hour later, after the user
 * may have dealt with the position themselves, must not run blind. And a late
 * close only closes deals that were already open when the signal arrived (see
 * `webhookCloseOpenedBefore`), never one a newer signal opened in between.
 */
export const WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS = 15 * 60_000

const lateTolerantActions = new Set(['closeDeal', 'closeDealSl'])

/** The cap that applies to this action. */
export function webhookSignalMaxAgeMs(action?: string): number {
  return action && lateTolerantActions.has(action)
    ? WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS
    : WEBHOOK_SIGNAL_MAX_AGE_MS
}

/**
 * For a close that runs later than the ordinary cap: only deals created before
 * this instant may be closed. undefined = no restriction (the close is on
 * time, or the signal is unstamped).
 */
export function webhookCloseOpenedBefore(
  receivedAt: number | undefined,
  now: number,
): number | undefined {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) {
    return undefined
  }
  return now - receivedAt > WEBHOOK_SIGNAL_MAX_AGE_MS ? receivedAt : undefined
}

/** Age of a signal stamped `receivedAt` at the API; 0 when unstamped or from the future. */
export function webhookSignalAgeMs(
  receivedAt: number | undefined,
  now: number,
): number {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return 0
  return Math.max(0, now - receivedAt)
}

/**
 * True when a stamped signal is already older than the cap. An unstamped
 * signal (from an API that predates the stamp) is never expired here, so a
 * mixed-version rollout keeps the old behaviour for it.
 */
export function webhookSignalExpired(
  receivedAt: number | undefined,
  now: number,
  maxAgeMs = WEBHOOK_SIGNAL_MAX_AGE_MS,
): boolean {
  return webhookSignalAgeMs(receivedAt, now) > maxAgeMs
}

/**
 * The instant past which a signal must not start: the cap from when the API
 * received it, or from `intakeAt` (this process took it) when unstamped. A
 * stamp from a clock ahead of ours cannot extend it.
 */
export function webhookSignalDeadline(
  receivedAt: number | undefined,
  intakeAt: number,
  maxAgeMs = WEBHOOK_SIGNAL_MAX_AGE_MS,
): number {
  const start =
    typeof receivedAt === 'number' && Number.isFinite(receivedAt)
      ? Math.min(receivedAt, intakeAt)
      : intakeAt
  return start + maxAgeMs
}

/** "60s" / "15 min" — how a cap is written to the user. */
export function formatSignalCap(ms: number): string {
  return ms % 60_000 === 0 && ms > 60_000
    ? `${ms / 60_000} min`
    : `${ms / 1000}s`
}

export function webhookSignalExpiredReason(
  action: string,
  ageMs: number,
): string {
  return (
    `Bot is restarting on our side, so "${action}" was not executed. ` +
    `The signal arrived ${Math.round(ageMs / 1000)}s ago; signals that cannot ` +
    `run within ${formatSignalCap(webhookSignalMaxAgeMs(action))} are dropped, not executed late.`
  )
}

/** What a user is told about a signal that did not run, or ran late. */
export type WebhookSignalNotice = {
  uuid: string
  action: string
  /**
   * `refused`: the bot was stopped/archived/restarting and the signal was not
   * executed. `expired`: it could not run within its cap and was dropped.
   * `lateClose`: a close ran after the ordinary cap.
   */
  kind: 'refused' | 'expired' | 'lateClose'
  reason: string
  receivedAt?: number
}

/** The bot-log line for a late close. */
export function lateCloseNoticeReason(
  action: string,
  receivedAt: number,
  now: number,
): string {
  const at = new Date(receivedAt).toISOString().slice(11, 19)
  return (
    `"${action}" received at ${at} UTC ran ${Math.round((now - receivedAt) / 1000)}s later, because the bot was not ready when it arrived. ` +
    `It acted only on deals that were already open at ${at} UTC.`
  )
}
