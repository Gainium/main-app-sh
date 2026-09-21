import { StatusEnum } from '../../types'
import type { BaseReturn, CommonOrder } from '../../types'
import type { OpenOrderRequest } from '../exchange'

/**
 * Kraken's published ceiling for `AddOrderBatch`: 2..15 orders, one pair. The
 * floor is the connector's problem (a one-order call is served as a plain
 * placement); the ceiling is ours, because exceeding it would have the venue
 * refuse the whole batch rather than trim it.
 */
export const MAX_BATCH_PLACE_CHUNK = 15

/**
 * How long a flush waits for a participant that has neither arrived nor bailed,
 * and how long a delivered participant is given to report itself settled.
 *
 * Both are anti-deadlock stops, not tuning. Nothing in a correct run reaches
 * either: every participant is wrapped so that it arrives, bails or settles in
 * a `finally`. They exist because the alternative to a late flush is a burst of
 * orders that never leaves the process, and the alternative to a late delivery
 * is a bot that stops placing orders altogether.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * What a participant gets when the flush ITSELF threw.
 *
 * Deliberately ambiguous-shaped (`isAmbiguousOrderFailure` matches `timeout`):
 * a throw can only happen after `openOrdersBatch` — which catches its own
 * transport failures — has already been entered, so the wire call may well have
 * reached the venue. An order in that state is UNCONFIRMED, not refused, and
 * the engine must resolve it against the venue rather than write it off (which
 * would drop it from `orders` and orphan a live order) or re-place it (which
 * would duplicate one).
 */
const unconfirmed = (message: string): BaseReturn<CommonOrder> => ({
  status: StatusEnum.notok,
  reason: `Batch placement timeout/failure, order state unconfirmed: ${message}`,
  data: null,
})

type Participant = {
  id: string
  /** Position in the expected list = the order the caller's loop would place in. */
  index: number
  state: 'waiting' | 'arrived' | 'bailed' | 'delivered'
  request?: OpenOrderRequest
  deliver?: (result: BaseReturn<CommonOrder>) => void
  /** Resolved by `settled`, awaited before the NEXT participant is delivered. */
  settledSignal?: () => void
}

/**
 * Coalesces one burst of placements into as few venue calls as possible,
 * WITHOUT letting any of the bookkeeping around them run concurrently.
 *
 * The problem it solves is arithmetic, not architecture. Kraken spot meters
 * private REST against a 20-token bucket refilling at 0.5/s, and one placement
 * costs two tokens (AddOrder plus the QueryOrders re-read). A burst of twenty
 * therefore empties the bucket in the first few and then pays ~4s apiece for
 * the rest, while `AddOrderBatch` places up to fifteen for the cost of one
 * call. The saving is entirely in the WIRE calls.
 *
 * So only the wire call is shared. Each participant still runs its own
 * pre-send section, still receives its own per-order answer, and — this is the
 * part that makes the change small — still runs its whole post-send
 * continuation with nothing else running alongside it:
 *
 *   resolve participant i  ->  wait for `settled(i)`  ->  resolve participant i+1
 *
 * Everything the engine does after a placement (the balance latch, the
 * cooldown guards, `countBalances`, the DB writes, the emits) is therefore as
 * serial as it is today, in the same order. The only thing that genuinely
 * happens in parallel is the stretch of work BEFORE the send, which is where
 * the caller has to have done its thinking (spec `082` §7).
 *
 * Pure enough to unit-test with no bot: it knows about participant ids, a send
 * function, and nothing else.
 */
export class OpenOrderBatcher {
  private readonly participants = new Map<string, Participant>()
  private readonly maxChunk: number
  private readonly timeoutMs: number
  private readonly onDebug: (message: string) => void
  private readonly sendBatch: (
    orders: OpenOrderRequest[],
  ) => Promise<BaseReturn<CommonOrder>[]>
  private flushTimer: NodeJS.Timeout | null = null
  private flushed = false
  private disposed = false

  constructor(
    expected: string[],
    sendBatch: (
      orders: OpenOrderRequest[],
    ) => Promise<BaseReturn<CommonOrder>[]>,
    opts: {
      maxChunk?: number
      timeoutMs?: number
      onDebug?: (message: string) => void
    } = {},
  ) {
    this.sendBatch = sendBatch
    this.maxChunk = Math.max(1, opts.maxChunk ?? MAX_BATCH_PLACE_CHUNK)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onDebug = opts.onDebug ?? (() => undefined)
    expected.forEach((id, index) => {
      this.participants.set(id, { id, index, state: 'waiting' })
    })
    this.flushTimer = setTimeout(() => {
      if (this.flushed || this.disposed) {
        return
      }
      this.onDebug(
        `Batch placement flush timer fired with ${this.pendingCount()} participant(s) still unaccounted for — sending what arrived`,
      )
      void this.flush()
    }, this.timeoutMs)
    // Never hold the process open for a batch of orders.
    this.flushTimer.unref?.()
  }

  /** Is this order one of the participants this batch is waiting for? */
  has(id?: string): boolean {
    return !!id && !this.disposed && this.participants.has(id)
  }

  /**
   * Park here instead of placing the order alone, and get back the answer for
   * THIS order — indistinguishable from what a single placement would have
   * returned.
   *
   * A participant that arrives after the batch has already gone (a late
   * pre-send section, or one that outlived the flush timer) is not made to
   * wait for a flush that will never come: it is sent as a batch of one, which
   * the exchange client serves as an ordinary single placement.
   */
  async send(request: OpenOrderRequest): Promise<BaseReturn<CommonOrder>> {
    const id = `${request.newClientOrderId ?? ''}`
    const participant = this.participants.get(id)
    if (!participant || participant.state !== 'waiting' || this.flushed) {
      this.onDebug(
        `Order ${id} reached the send site outside its batch — placing it on its own`,
      )
      const [result] = await this.sendBatch([request])
      return result ?? unconfirmed(`no answer for ${id}`)
    }
    participant.state = 'arrived'
    participant.request = request
    const answer = new Promise<BaseReturn<CommonOrder>>((resolve) => {
      participant.deliver = resolve
    })
    if (this.pendingCount() === 0) {
      void this.flush()
    }
    return answer
  }

  /**
   * This participant settled WITHOUT reaching the send site — a pre-send gate
   * short-circuited it, it was refused, or it threw. It is not coming, so the
   * others must not wait for it.
   */
  bail(id: string): void {
    const participant = this.participants.get(id)
    if (!participant || participant.state !== 'waiting') {
      return
    }
    participant.state = 'bailed'
    if (this.pendingCount() === 0 && !this.flushed) {
      void this.flush()
    }
  }

  /**
   * This participant has finished everything it does with its answer. Called
   * from the caller's `finally`, so it runs whether the continuation returned
   * or threw — which is what keeps the one-at-a-time delivery from stalling on
   * an error path.
   *
   * A participant that never reached the send site settles as a bail, so a
   * single `finally` covers both. That is deliberate: a caller that had to
   * decide which of the two to call would eventually get it wrong, and getting
   * it wrong parks the whole burst.
   */
  settled(id: string): void {
    const participant = this.participants.get(id)
    if (!participant) {
      return
    }
    if (participant.state === 'waiting') {
      this.bail(id)
      return
    }
    participant.settledSignal?.()
    participant.settledSignal = undefined
  }

  /** Stop the timers. The caller does this in its own `finally`. */
  dispose(): void {
    this.disposed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** Participants that have neither arrived nor bailed. */
  private pendingCount(): number {
    let pending = 0
    for (const p of this.participants.values()) {
      if (p.state === 'waiting') {
        pending++
      }
    }
    return pending
  }

  private arrivedInLoopOrder(): Participant[] {
    return [...this.participants.values()]
      .filter((p) => p.state === 'arrived')
      .sort((a, b) => a.index - b.index)
  }

  /**
   * Send what arrived and hand the answers back one participant at a time.
   *
   * Chunked because the venue has a ceiling, sequential across chunks because
   * a burst that runs the account out of funds must run out in the same place
   * it would have today — nearest level first, in order — rather than wherever
   * a race happened to put it. All the chunks are sent before ANY answer is
   * delivered, so no participant's bookkeeping runs while another chunk is in
   * flight.
   */
  private async flush(): Promise<void> {
    if (this.flushed) {
      return
    }
    this.flushed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const waiting = this.arrivedInLoopOrder()
    if (!waiting.length) {
      return
    }
    const results: BaseReturn<CommonOrder>[] = []
    try {
      for (let at = 0; at < waiting.length; at += this.maxChunk) {
        const chunk = waiting.slice(at, at + this.maxChunk)
        const answers = await this.sendBatch(
          chunk.map((p) => p.request as OpenOrderRequest),
        )
        for (let i = 0; i < chunk.length; i++) {
          results.push(
            answers?.[i] ?? unconfirmed(`no answer for ${chunk[i].id}`),
          )
        }
      }
    } catch (e) {
      // `openOrdersBatch` catches its own transport failures, so reaching here
      // means a defect, not a venue outcome — and a defect AFTER the wire call
      // may have left live orders behind. Every parked participant is told its
      // order is unconfirmed, never refused.
      const message = `${(e as Error)?.message ?? e}`
      this.onDebug(`Batch placement threw: ${message}`)
      for (let i = results.length; i < waiting.length; i++) {
        results.push(unconfirmed(message))
      }
    }
    for (let i = 0; i < waiting.length; i++) {
      await this.deliver(waiting[i], results[i] ?? unconfirmed('no answer'))
    }
  }

  /** Resolve one participant, then wait for it to report itself settled. */
  private async deliver(
    participant: Participant,
    result: BaseReturn<CommonOrder>,
  ): Promise<void> {
    const done = new Promise<void>((resolve) => {
      let released = false
      const release = () => {
        if (released) {
          return
        }
        released = true
        clearTimeout(guard)
        resolve()
      }
      const guard = setTimeout(() => {
        this.onDebug(
          `Order ${participant.id} did not report itself settled — releasing the batch queue`,
        )
        release()
      }, this.timeoutMs)
      guard.unref?.()
      participant.settledSignal = release
    })
    participant.state = 'delivered'
    participant.deliver?.(result)
    participant.deliver = undefined
    await done
  }
}

export default OpenOrderBatcher
