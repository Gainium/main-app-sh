export const KEYS = {
  lastEventTime: 'stream:lastEventTime', // sorted set, member=accountId, score=epochMs
  hasConsumer: (accountId: string) => `stream:hasConsumer:${accountId}`, // TTL key
  watchdogState: (accountId: string) => `stream:watchdogState:${accountId}`, // hash
  activeIncidents: 'watchdog:activeIncidents', // plain set
} as const

export const CONSUMER_TTL_SECONDS = 30
export const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 30m
export const MAX_RECHECK_MS = 4 * 60 * 60_000 // 4h

import logger from '../utils/logger'

export const log = (type: keyof typeof logger, ...msg: unknown[]) => {
  logger[type](`[Stream Watchdog]`, ...msg)
}
