import logger from '../utils/logger'
import RedisClient from '../db/redis'
import { ExchangeEnum } from '../../types'
import { LOG_PREFIX } from './types'

/**
 * Detector counters (spec §11) — HINCRBY gainium:failsafe:counters:<exchange>
 * plus a periodic INFO summary line. The RedisWrapper has no hIncrBy; we reach
 * the raw node-redis client via `.instance`.
 */

export type CounterField =
  | 'candidates'
  | 'debounceKilled'
  | 'confirmed'
  | 'falsePositive'
  | 'skippedCap'
  | 'skippedCongestion'
  | 'skippedUsage'
  | 'skippedKill'
  | 'sweepsPublished'
  | 'pingsPublished'
  | 'sweepsUnacked'
  | 'deafBots'
  | 'selfHealsSent'

const FIELDS: CounterField[] = [
  'candidates',
  'debounceKilled',
  'confirmed',
  'falsePositive',
  'skippedCap',
  'skippedCongestion',
  'skippedUsage',
  'skippedKill',
  'sweepsPublished',
  'pingsPublished',
  'sweepsUnacked',
  'deafBots',
  'selfHealsSent',
]

export class Counters {
  private key(exchange: ExchangeEnum | string): string {
    return `gainium:failsafe:counters:${exchange}`
  }

  async bump(
    exchange: ExchangeEnum | string,
    field: CounterField,
    by = 1,
  ): Promise<void> {
    try {
      const redis = await RedisClient.getInstance()
      // hIncrBy is not exposed on the wrapper; use the raw client.
      await redis.instance?.hIncrBy(this.key(exchange), field, by)
    } catch (e) {
      logger.error(`${LOG_PREFIX} counter bump error: ${e}`)
    }
  }

  /** Emit one INFO line per exchange with its current counter snapshot. */
  async logSummary(exchanges: (ExchangeEnum | string)[]): Promise<void> {
    try {
      const redis = await RedisClient.getInstance()
      for (const exchange of exchanges) {
        const raw = await redis.instance?.hGetAll(this.key(exchange))
        if (!raw || Object.keys(raw).length === 0) continue
        const parts = FIELDS.map((f) => `${f}=${raw[f] ?? 0}`).join(' ')
        logger.info(`${LOG_PREFIX} counters ${exchange} | ${parts}`)
      }
    } catch (e) {
      logger.error(`${LOG_PREFIX} counter summary error: ${e}`)
    }
  }
}
