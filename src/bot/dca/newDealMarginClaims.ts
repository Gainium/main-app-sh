/**
 * Core spec 288. Margin that new futures deals of ONE bot have been promised
 * by the balance gate but that a balance read may not show as used yet.
 *
 * A bot that opens several deals at once gates each of them against a balance
 * read taken before any of them reached the exchange, so every deal saw the
 * same free figure and the venue refused the ones the account could not fund.
 * Each deal that passes the gate now claims its base-order margin here, and
 * the next gate subtracts what is still claimed.
 *
 * A claim lives through three stages:
 *  - `gated`: passed the gate, the base order is not sent yet;
 *  - `placing`: the base order is on its way to the exchange;
 *  - `placed`: the placement call returned at `placedAt`.
 * Only a balance read that STARTED after `placedAt` can show the margin as
 * used, so that read retires the claim. The ack or the fill alone does not:
 * a read already in flight when it happened still shows the old figure.
 * A deal that ends before its base order is sent releases its claim directly.
 * A `gated` claim older than {@link GATED_CLAIM_TTL_MS} is dropped too, so a
 * deal that died on an unexpected error cannot hold margin for the bot's life.
 *
 * In memory and per bot: it covers the burst a single bot opens, not other
 * bots on the account (their margin is in the read once their order lands).
 */
export type MarginClaimStage = 'gated' | 'placing' | 'placed'

type Claim = {
  asset: string
  margin: number
  stage: MarginClaimStage
  claimedAt: number
  placedAt?: number
}

/** A deal goes from the gate to its base order in seconds; past this, it died. */
export const GATED_CLAIM_TTL_MS = 10 * 60 * 1000

export class NewDealMarginClaims {
  private claims = new Map<string, Claim>()
  private seq = 0

  /**
   * Retire every claim a read started at `readStartedAt` already reflects.
   * Call with the time taken BEFORE the balance request was sent.
   */
  settle(readStartedAt: number) {
    for (const [id, c] of this.claims) {
      if (
        (c.stage === 'placed' &&
          c.placedAt !== undefined &&
          c.placedAt < readStartedAt) ||
        (c.stage === 'gated' &&
          readStartedAt - c.claimedAt > GATED_CLAIM_TTL_MS)
      ) {
        this.claims.delete(id)
      }
    }
  }

  /** Margin still claimed on `asset`, not yet visible in a balance read. */
  claimed(asset: string) {
    let total = 0
    for (const c of this.claims.values()) {
      if (c.asset === asset) {
        total += c.margin
      }
    }
    return total
  }

  /** Register a claim; returns its id. */
  claim(asset: string, margin: number, at = Date.now()) {
    const id = `${++this.seq}`
    this.claims.set(id, { asset, margin, stage: 'gated', claimedAt: at })
    return id
  }

  /** The base order is being sent. */
  placing(id?: string) {
    const c = id ? this.claims.get(id) : undefined
    if (c) {
      c.stage = 'placing'
    }
  }

  /** The placement call returned; the next read started after `at` settles it. */
  placed(id: string | undefined, at: number) {
    const c = id ? this.claims.get(id) : undefined
    if (c) {
      c.stage = 'placed'
      c.placedAt = at
    }
  }

  /** The deal ended before its base order was sent. */
  release(id?: string) {
    if (id) {
      this.claims.delete(id)
    }
  }

  get size() {
    return this.claims.size
  }
}
