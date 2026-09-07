/**
 * Tracks, per symbol, whether the bot is being fed by the live
 * `trade@<symbol>@<exchange>` Redis stream or by the REST price poll that
 * exists only as a fallback for it.
 *
 * Why this needs its own state machine rather than a boolean:
 *
 * The fallback (`priceTimerFn` in dcaHelper/helper) re-injects the REST price
 * through `priceUpdateCallback`, which writes it into `lastStreamData`. One
 * poll therefore makes the symbol look "fresh" to the very next poll — the
 * freshness is our own. Comparing staleness alone would flip-flop between
 * "stale" and "fresh" forever on a symbol whose stream is completely dead, and
 * any log hung off that comparison would flap with it.
 *
 * `servedLastRun` is the fix: freshness only counts as a live tick when the
 * previous run did NOT inject a price. Recovery therefore takes one extra run
 * to declare, which is the right trade for never crying wolf.
 */
export type PriceStreamGapEvent =
  | { kind: 'entered' }
  | { kind: 'persisting'; minutes: number }
  | { kind: 'recovered'; minutes: number }
  | null

type GapState = {
  since: number
  lastLogged: number
  /** Did the previous run inject a REST price for this symbol? */
  servedLastRun: boolean
}

export class PriceStreamGapTracker {
  private states: Map<string, GapState> = new Map()

  constructor(private readonly repeatEveryMs: number) {}

  /**
   * @param stale true when this run is about to serve the symbol from REST
   * because the stream has gone quiet past the timeout.
   * @returns the state change worth logging, or null when nothing changed.
   */
  note(symbol: string, stale: boolean, now: number): PriceStreamGapEvent {
    const state = this.states.get(symbol)
    if (stale) {
      if (!state) {
        this.states.set(symbol, {
          since: now,
          lastLogged: now,
          servedLastRun: true,
        })
        return { kind: 'entered' }
      }
      state.servedLastRun = true
      if (now - state.lastLogged >= this.repeatEveryMs) {
        state.lastLogged = now
        return { kind: 'persisting', minutes: minutesSince(state.since, now) }
      }
      return null
    }
    if (!state) {
      return null
    }
    if (state.servedLastRun) {
      // Fresh only because we injected a price last run — not evidence of a
      // live stream. Clear the flag and wait for a run that finds it fresh
      // without our help.
      state.servedLastRun = false
      return null
    }
    this.states.delete(symbol)
    return { kind: 'recovered', minutes: minutesSince(state.since, now) }
  }

  /** Symbols currently believed to have no live price stream. */
  gapped(): string[] {
    return [...this.states.keys()]
  }

  forget(symbol: string) {
    this.states.delete(symbol)
  }
}

function minutesSince(since: number, now: number) {
  return Math.round((now - since) / 60000)
}
