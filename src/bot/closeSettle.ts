/**
 * Let a webhook close FINISH before the next action in the same payload runs.
 *
 * `/trade_signal` accepts an array, and `webhookProcess` awaits each item in
 * turn — but a close action only `postMessage`s the worker and returns, so
 * "await" here means "the message was posted", not "the position is closed".
 * A flip sent as [close/stop A, start B] therefore starts B while A's close is
 * still in flight, and B is refused for holding a position against its own
 * direction (`opposingPositionOwner.ts` describes the other half of this).
 *
 * This closes the gap on the sending side: after dispatching a close that is
 * meant to flatten, wait for that bot's deals to actually close before moving
 * on. Bounded and best-effort — a close that has not landed inside the window
 * leaves the next action to the start-side settle, exactly as today.
 */

/** ~15 s: long enough for a market close to fill, short of a webhook timeout. */
export const CLOSE_SETTLE = { attempts: 30, intervalMs: 500 }

/**
 * Polls `openDeals` until it reports none, and says whether that happened.
 *
 * An unreadable count is not "closed" — it spends an attempt and the wait
 * continues, so a DB blip cannot be mistaken for a completed close. Nothing
 * here throws: the caller is a webhook whose remaining items must still run.
 */
export async function awaitDealsClosed(
  openDeals: () => Promise<number | undefined>,
  opts: {
    attempts: number
    intervalMs: number
    sleep: (ms: number) => Promise<void>
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < Math.max(1, opts.attempts); attempt++) {
    let count: number | undefined
    try {
      count = await openDeals()
    } catch {
      count = undefined
    }
    if (count === 0) {
      return true
    }
    await opts.sleep(opts.intervalMs)
  }
  try {
    return (await openDeals()) === 0
  } catch {
    return false
  }
}
