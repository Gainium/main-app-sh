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
    { action?: string; uuid?: string } | undefined
  >
  return (
    signals
      .map((d) => `${d?.action ?? 'no-action'}:${d?.uuid ?? 'no-uuid'}`)
      .join(', ') || 'empty payload'
  )
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

export function missingWebhookFieldsReason(missing: string[]): string {
  return (
    `Webhook payload is missing required field(s): ${missing.join(', ')}. ` +
    `Expected a JSON object such as ` +
    `{"action":"startDeal","uuid":"<bot uuid>"}.`
  )
}

/**
 * The longest a signal may wait before it is executed. A TradingView alert is
 * a decision about the market at the moment it fired; executed a minute later
 * it may be the wrong decision, and the sender (which gave up after a few
 * seconds) can no longer tell that it ran. So a signal is either executed
 * within this window of reaching our API or it is rejected with the reason —
 * never queued and executed late. Covers the wait for a bot that is still
 * re-loading after a service restart, a command queue that is not consumed
 * yet, and the replay of a signal the API could not hand over.
 */
export const WEBHOOK_SIGNAL_MAX_AGE_MS = 10_000

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
 * signal (sent by an API process that predates the stamp) is never expired
 * here, so a mixed-version rollout keeps today's behaviour for it.
 */
export function webhookSignalExpired(
  receivedAt: number | undefined,
  now: number,
  maxAgeMs = WEBHOOK_SIGNAL_MAX_AGE_MS,
): boolean {
  return webhookSignalAgeMs(receivedAt, now) > maxAgeMs
}

/**
 * The instant past which a signal must not be executed: the cap measured from
 * when the API received it, or from `intakeAt` (when this process took it) for
 * an unstamped signal.
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

export function webhookSignalExpiredReason(
  action: string,
  ageMs: number,
): string {
  return (
    `Bot is restarting on our side, so "${action}" was not executed. ` +
    `The signal arrived ${Math.round(ageMs / 1000)}s ago; signals that cannot ` +
    `run within ${WEBHOOK_SIGNAL_MAX_AGE_MS / 1000}s are dropped, not executed late.`
  )
}
