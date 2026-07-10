import mongoose from 'mongoose'
import logger from '../utils/logger'

/**
 * Write-path side of the bot-error ownership system.
 *
 * The `boterrorrules` collection (owned/seeded by admin-app) is the shared
 * source of truth for message -> subType classification. Here in the bot
 * engine we consult it FIRST in getErrorSubType() so that new/updated rules
 * (added by admins or the Claus autonomous reclassifier) relabel newly-stored
 * errors WITHOUT a code deploy — only within the cache TTL, no restart.
 *
 * Read directly through the active mongoose driver connection (no schema
 * registration) to keep this dependency-light. The cache is self-priming: the
 * first getErrorSubType() call kicks off an async load and every TTL refreshes
 * in the background; until the first load lands we fall back to the static
 * errorDict, so this is always safe.
 *
 * NB: cross-service shared-Mongo contract — the doc shape here must stay in
 * sync with admin-app's botErrorRule schema.
 */

const logPrefix = 'errorRulesCache |'
const TTL_MS = 5 * 60 * 1000

interface CompiledRule {
  test: (msgLower: string) => boolean
  subType: string
}

let compiled: CompiledRule[] = []
let loadedAt = 0
let loading = false

async function load(): Promise<void> {
  if (loading) return
  loading = true
  try {
    const conn = mongoose.connection
    if (!conn || conn.readyState !== 1 || !conn.db) {
      // No live connection yet — leave the current cache (possibly empty) in
      // place; getErrorSubType falls through to the static errorDict.
      return
    }
    const docs = await conn.db
      .collection('boterrorrules')
      .find({ enabled: true })
      .sort({ priority: 1, _id: 1 })
      .toArray()
    const next: CompiledRule[] = []
    for (const r of docs) {
      const pattern = r?.pattern
      const subType = r?.subType
      if (!pattern || !subType) continue
      if (r.matchType === 'regex') {
        try {
          const re = new RegExp(String(pattern), 'i')
          next.push({ test: (m) => re.test(m), subType })
        } catch {
          // skip invalid regex rules
        }
      } else {
        const needle = String(pattern).toLowerCase()
        next.push({ test: (m) => m.includes(needle), subType })
      }
    }
    compiled = next
    loadedAt = Date.now()
  } catch (e) {
    logger.warn(
      `${logPrefix} failed to load rules: ${(e as Error)?.message || e}`,
    )
  } finally {
    loading = false
  }
}

/**
 * Return the rule-assigned subType for a message, or null if no rule matches.
 * Triggers a background refresh when the cache is stale but always answers from
 * the current in-memory ruleset (never blocks the caller).
 */
export function matchErrorRuleSubType(message: string): string | null {
  if (Date.now() - loadedAt > TTL_MS) {
    void load()
  }
  if (!compiled.length) return null
  const m = (message || '').toLowerCase()
  for (const rule of compiled) {
    if (rule.test(m)) return rule.subType
  }
  return null
}

/** Optional eager warm-up (e.g. from bot-worker boot). Fire-and-forget. */
export function primeErrorRules(): void {
  void load()
}
