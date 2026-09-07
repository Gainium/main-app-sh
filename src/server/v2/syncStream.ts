import type { Request, Response } from 'express'

/**
 * Keeping a long synchronous request alive through a CDN / reverse proxy.
 *
 * `POST /api/v2/backtest/:botType/request/sync` submits a backtest and then
 * holds the connection until the run reaches a terminal status — by design,
 * for up to an hour. A proxy in front of the origin will not wait that long
 * for a silent connection: Cloudflare, for one, gives up at ~100 s and answers
 * the caller with a 524 that the origin never sees. The backtest itself is
 * unaffected (it was already submitted and keeps running), but the caller
 * loses the response AND, on the plain-JSON path, the request id with it — so
 * they cannot pick the result up later either.
 *
 * The fix is to stop being silent. Both modes below commit the response head
 * immediately and then emit something every `heartbeatMs`, which resets the
 * proxy's idle timer:
 *
 *   - `sse`  — opt-in via `Accept: text/event-stream`. The request id goes out
 *              as the first event, so a caller whose connection dies mid-run
 *              still has it and can poll
 *              `GET /api/v2/backtest/{botType}/requests/{id}`.
 *   - `json` — everyone else. Heartbeats are newlines, which are legal
 *              insignificant whitespace ahead of a JSON document, so existing
 *              clients keep working byte-for-byte with no change: `JSON.parse`
 *              and `res.json()` both skip leading whitespace.
 *
 * Committing the head early means the status code is fixed before the outcome
 * is known. That is sound for this route specifically: every failure that
 * warrants a non-200 (cost estimation, credit block, submit) is decided BEFORE
 * the wait begins, and the wait itself resolves rather than rejects. A late
 * failure is reported in-body as `status: "notok"`, which is what the response
 * envelope is for.
 *
 * Note the SSE variant is served over POST, so browsers' `EventSource` cannot
 * consume it (that is GET-only). Clients read the response body as a stream —
 * the same shape as other streaming HTTP APIs.
 *
 * Proxy buffering is the other half of this: nginx buffers upstream responses
 * by default and would sit on the heartbeats, which would leave the connection
 * just as silent from the CDN's point of view. `X-Accel-Buffering: no` turns
 * that off for this response only, with no change to the vhost.
 */

/** Interval between heartbeats. ~5x margin under Cloudflare's ~100 s. */
export const SYNC_STREAM_HEARTBEAT_MS = 20_000

export type SyncStreamMode = 'sse' | 'json'

export type SyncStreamEnvelope = {
  status: string
  reason: string | null
  data: unknown
}

/**
 * Which mode the caller asked for. Only an explicit `text/event-stream` in
 * `Accept` opts in — a wildcard `Accept` header must not, or every ordinary
 * client would silently start receiving a format it cannot parse.
 */
export function syncStreamMode(req: Request): SyncStreamMode {
  const accept = req.headers?.accept
  const raw = Array.isArray(accept) ? accept.join(',') : accept || ''
  return raw.toLowerCase().includes('text/event-stream') ? 'sse' : 'json'
}

export type SyncStream = {
  /** True once the client is gone or the response has been finished. */
  readonly done: boolean
  /** Write the final envelope and end the response. Safe to call once. */
  finish: (envelope: SyncStreamEnvelope) => void
  /** Stop heartbeating without writing anything (client already gone). */
  dispose: () => void
}

/**
 * Commit the response head, announce the request id (SSE only) and start
 * heartbeating. The returned handle is inert once the client disconnects, so
 * callers do not have to check before finishing.
 */
export function openSyncStream(
  res: Response,
  opts: {
    mode: SyncStreamMode
    requestId: string
    heartbeatMs?: number
    onClientGone?: () => void
  },
): SyncStream {
  const { mode, requestId, heartbeatMs = SYNC_STREAM_HEARTBEAT_MS } = opts
  let done = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  res.status(200)
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  // nginx buffers proxied responses by default, which would hold the
  // heartbeats and defeat the whole point.
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader(
    'Content-Type',
    mode === 'sse'
      ? 'text/event-stream; charset=utf-8'
      : 'application/json; charset=utf-8',
  )
  res.flushHeaders()

  if (mode === 'sse') {
    // First, before any waiting: the id the caller needs to recover the run if
    // this connection does not survive.
    res.write(`event: accepted\ndata: ${JSON.stringify({ requestId })}\n\n`)
  } else {
    // Proves the pipe is open end-to-end rather than sitting in a buffer.
    res.write('\n')
  }

  res.on('close', () => {
    if (done) return
    done = true
    stop()
    opts.onClientGone?.()
  })

  timer = setInterval(() => {
    if (done || res.writableEnded) {
      stop()
      return
    }
    // An SSE comment line: ignored by every consumer, but it is bytes on the
    // wire, which is all the proxy's idle timer cares about.
    res.write(mode === 'sse' ? ': ping\n\n' : '\n')
  }, heartbeatMs)

  return {
    get done() {
      return done
    },
    finish: (envelope: SyncStreamEnvelope) => {
      if (done || res.writableEnded) return
      done = true
      stop()
      if (mode === 'sse') {
        res.write(`event: result\ndata: ${JSON.stringify(envelope)}\n\n`)
        res.end()
      } else {
        res.end(JSON.stringify(envelope))
      }
    },
    dispose: () => {
      done = true
      stop()
    },
  }
}
