/**
 * Quote held by bot-funded deals (main-app spec 044 §5).
 *
 * A short spot deal the bot funded itself records its base order as a virtual
 * entry: nothing was sold, so the quote that entry "produced" is the account's
 * own, still sitting free on the exchange. The deal's take profit spends it to
 * buy the base back. Nothing on the venue locks it, so every balance check on
 * the account has to subtract it, or another bot can spend the quote a take
 * profit needs.
 *
 * Read from the deals collections, across bots and processes; cached briefly
 * because it is asked on every deal-open check.
 */
import logger from '../utils/logger'
import { comboDealsDb, dcaDealsDb } from '../db/dbInit'
import { DCADealStatusEnum, StatusEnum } from '../../types'

const logPrefix = 'FundingReservation'

/** Short enough that a deal opened by another worker is seen within a tick. */
const TTL_MS = 5_000

const HOLDING_STATUSES = [
  DCADealStatusEnum.start,
  DCADealStatusEnum.open,
  DCADealStatusEnum.error,
]

export class FundingReservation {
  private static _instance: FundingReservation | null = null
  static getInstance(): FundingReservation {
    if (!FundingReservation._instance) {
      FundingReservation._instance = new FundingReservation()
    }
    return FundingReservation._instance
  }

  private cache = new Map<string, { at: number; value: number }>()

  private key(exchangeUUID: string, quoteAsset: string) {
    return `${exchangeUUID}@${quoteAsset}`
  }

  /** Σ virtual-entry quote reserved by this account's open deals, in `quoteAsset`. */
  async reservedQuote(exchangeUUID: string, quoteAsset: string) {
    if (!exchangeUUID || !quoteAsset) {
      return 0
    }
    const key = this.key(exchangeUUID, quoteAsset)
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) {
      return hit.value
    }
    const filter = {
      exchangeUUID,
      'symbol.quoteAsset': quoteAsset,
      status: { $in: HOLDING_STATUSES },
      'botFunding.virtualEntry.quoteReserved': { $gt: 0 },
    }
    const projection = { 'botFunding.virtualEntry.quoteReserved': 1 }
    let value = 0
    const reads = await Promise.all([
      dcaDealsDb.readData(filter as any, projection, {}, true),

      comboDealsDb.readData(filter as any, projection, {}, true),
    ])
    for (const res of reads) {
      if (res.status !== StatusEnum.ok) {
        // An extra guard, not the only one: the venue still refuses an order
        // the account cannot fund. Report and count nothing for this side.
        logger.error(
          `${logPrefix} | cannot read reserved quote for ${key}: ${res.reason}`,
        )
        continue
      }
      for (const d of res.data.result) {
        value += d.botFunding?.virtualEntry?.quoteReserved ?? 0
      }
    }
    this.cache.set(key, { at: Date.now(), value })
    return value
  }

  /** A deal of this account just reserved or released quote. */
  invalidate(exchangeUUID: string, quoteAsset: string) {
    this.cache.delete(this.key(exchangeUUID, quoteAsset))
  }
}
