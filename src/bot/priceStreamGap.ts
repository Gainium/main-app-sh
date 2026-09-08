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
  /**
   * Has `entered` been returned for this gap? False while the boot grace
   * suppressed it — a gap that was never announced must not announce its
   * recovery either.
   */
  announced: boolean
}

export type PriceStreamGapOptions = {
  /**
   * Boot grace: for this long after `startedAt`, a symbol that has never been
   * seen with a live tick is served from REST silently instead of being
   * reported as gapped. On a bot load every symbol starts with no stream data,
   * and the subscriptions come up over the following minutes; without the
   * grace the first poll flags them all and two runs later declares them all
   * recovered. A symbol that still has not ticked once the grace is over is
   * reported as before.
   */
  graceMs?: number
  startedAt?: number
}

export class PriceStreamGapTracker {
  private states: Map<string, GapState> = new Map()
  /** Symbols observed fresh without our own injection explaining it. */
  private seenLive: Set<string> = new Set()
  private readonly graceMs: number
  private readonly startedAt: number

  constructor(
    private readonly repeatEveryMs: number,
    options: PriceStreamGapOptions = {},
  ) {
    this.graceMs = options.graceMs ?? 0
    this.startedAt = options.startedAt ?? 0
  }

  private inGrace(symbol: string, now: number) {
    return now - this.startedAt < this.graceMs && !this.seenLive.has(symbol)
  }

  /**
   * @param stale true when this run is about to serve the symbol from REST
   * because the stream has gone quiet past the timeout.
   * @returns the state change worth logging, or null when nothing changed.
   */
  note(symbol: string, stale: boolean, now: number): PriceStreamGapEvent {
    const state = this.states.get(symbol)
    if (stale) {
      const announce = !this.inGrace(symbol, now)
      if (!state) {
        this.states.set(symbol, {
          since: now,
          lastLogged: now,
          servedLastRun: true,
          announced: announce,
        })
        return announce ? { kind: 'entered' } : null
      }
      state.servedLastRun = true
      if (!state.announced) {
        if (!announce) {
          return null
        }
        // Grace is over and the symbol still has no stream: report it now,
        // from the moment we first served it.
        state.announced = true
        state.lastLogged = now
        return { kind: 'entered' }
      }
      if (now - state.lastLogged >= this.repeatEveryMs) {
        state.lastLogged = now
        return { kind: 'persisting', minutes: minutesSince(state.since, now) }
      }
      return null
    }
    if (!state) {
      this.seenLive.add(symbol)
      return null
    }
    if (state.servedLastRun) {
      // Fresh only because we injected a price last run — not evidence of a
      // live stream. Clear the flag and wait for a run that finds it fresh
      // without our help.
      state.servedLastRun = false
      return null
    }
    this.seenLive.add(symbol)
    this.states.delete(symbol)
    if (!state.announced) {
      return null
    }
    return { kind: 'recovered', minutes: minutesSince(state.since, now) }
  }

  /** Symbols currently believed to have no live price stream. */
  gapped(): string[] {
    return [...this.states.keys()]
  }

  /** Gapped symbols that have been reported as such. */
  reported(): string[] {
    return [...this.states.entries()]
      .filter(([, s]) => s.announced)
      .map(([symbol]) => symbol)
  }

  forget(symbol: string) {
    this.states.delete(symbol)
  }
}

function minutesSince(since: number, now: number) {
  return Math.round((now - since) / 60000)
}
