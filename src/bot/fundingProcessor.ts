import type { FundingHistoryEntry } from '../../types'
import type { FundingEvent } from './fundingStore'

/** A fill in the rewind window: signed base qty (buy = +, sell = −). */
export type SignedFill = {
  time: number
  /** Base qty for linear; contracts for inverse. Buy positive, sell negative. */
  signedQty: number
}

export type FundingComputeInput = {
  /** Settled events newer than `offset`, ascending by time. */
  events: FundingEvent[]
  /** Last processed settlement time (ms). */
  offset: number
  /**
   * Signed position (base qty for linear, contracts for inverse) held at a
   * settlement time. Caller resolves it from in-RAM state — DCA/Combo fold the
   * deal's in-memory fills; Grid rewinds its position-breakpoint history. No DB.
   */
  getQtyAt: (eventTime: number) => number
  /** Coin-margined (inverse) contract, e.g. Binance COINM. */
  inverse: boolean
  /** Contract size multiplier (USD/contract for inverse; usually 1 for linear). */
  contractMultiplier: number
  /** Quote → USD rate (≈1 for USDT-quoted). */
  usdRate: number
}

export type FundingComputeResult = {
  /** Funding in quote asset (coin for inverse), signed; negative = paid. */
  deltaQuote: number
  deltaUsd: number
  /** New offset to commit (max applied settlement time, or input offset). */
  maxTime: number
  /** Last applied settlement time, for the UI. */
  lastTime: number
  /** Number of events applied (incl. zero-fee — they still advance the offset). */
  applied: number
  /** Per-settlement detail, for the capped debug history. */
  entries: FundingHistoryEntry[]
}

/**
 * Reconstruct the position at each settlement T by rewinding fills that
 * happened after T out of the current position, then charge
 * `rate × notional(T)`. Position qty comes from real fills (authoritative);
 * the price multiplier is the exchange's mark price at T (in the event), which
 * is what funding is actually settled on — entry price would diverge.
 *
 *   linear : feeQuote = −qty(T) × markPrice(T) × mult × rate(T)
 *   inverse: feeUsd   = −contracts(T) × mult × rate(T)   (USD-notional contracts)
 */
export function computeFunding(
  input: FundingComputeInput,
): FundingComputeResult {
  const { events, offset, getQtyAt, inverse, contractMultiplier, usdRate } =
    input

  let deltaQuote = 0
  let deltaUsd = 0
  let maxTime = offset
  let lastTime = offset
  let applied = 0
  const entries: FundingHistoryEntry[] = []

  const sortedEvents = [...events].sort((a, b) => a.time - b.time)
  for (const event of sortedEvents) {
    if (event.time <= offset) {
      continue
    }
    // Signed position at the settlement (long = +, short = −). Direction is
    // carried by this sign, not an explicit side branch:
    //   fee = -qty(T) · mark · rate
    //   long  + positive rate → negative (we pay)   short + positive → we receive
    //   long  + negative rate → positive (we receive) short + negative → we pay
    const qtyAtT = getQtyAt(event.time)

    let feeQuote = 0
    let feeUsd = 0
    if (inverse) {
      // Coin-margined: contracts carry a fixed USD notional → USD fee is exact
      // without mark price; the coin amount needs the mark.
      feeUsd = -qtyAtT * contractMultiplier * event.rate
      feeQuote = event.markPrice ? feeUsd / event.markPrice : 0
    } else if (event.markPrice) {
      feeQuote = -qtyAtT * event.markPrice * contractMultiplier * event.rate
      feeUsd = feeQuote * usdRate
    }
    // No mark price for a linear event → can't value it; still advance the
    // offset so we don't reprocess, but contribute zero (publisher should
    // always resolve mark price, this is a safety valve).

    deltaQuote += feeQuote
    deltaUsd += feeUsd
    if (event.time > maxTime) {
      maxTime = event.time
      lastTime = event.time
    }
    applied++
    entries.push({
      time: event.time,
      rate: event.rate,
      markPrice: event.markPrice,
      qty: qtyAtT,
      feeQuote,
      feeUsd,
    })
  }

  return { deltaQuote, deltaUsd, maxTime, lastTime, applied, entries }
}
