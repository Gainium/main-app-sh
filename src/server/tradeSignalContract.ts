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

export function missingWebhookFieldsReason(missing: string[]): string {
  return (
    `Webhook payload is missing required field(s): ${missing.join(', ')}. ` +
    `Expected a JSON object such as ` +
    `{"action":"startDeal","uuid":"<bot uuid>"}.`
  )
}
