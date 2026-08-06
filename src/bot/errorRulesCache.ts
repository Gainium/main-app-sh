import mongoose from 'mongoose'
import logger from '../utils/logger'

/**
 * Write-path side of the bot-error ownership + behaviour system.
 *
 * Two admin-owned collections back this cache (both seeded by admin-app; both
 * extendable by admins / the Claus reclassifier with NO code deploy):
 *
 *   `boterrorrules`     — message pattern -> subType. Consulted first in
 *                         getErrorSubType() so a mislabel can be corrected live.
 *   `boterrorsubtypes`  — subType -> BEHAVIOUR {showUser, errorsBot, userMessage}.
 *                         Consulted in handleErrors() so error visibility, whether
 *                         the bot flips to error, and the user-facing message are
 *                         data-driven instead of hardcoded per-subType branches.
 *
 * Read directly through the active mongoose driver connection (no schema
 * registration) to keep this dependency-light. The caches are self-priming: the
 * first lookup kicks off an async load and every TTL refreshes in the
 * background; until the first load lands we fall through to safe static
 * fallbacks (the errorDict for classification, DEFAULT_SUBTYPE_BEHAVIOR for
 * behaviour), so this is always safe.
 *
 * We also count rule HITS here — once per real error occurrence at the write
 * path — batched in memory and flushed on the TTL, so the admin page shows a
 * meaningful fire count (previously always 0).
 *
 * NB: cross-service shared-Mongo contract — the doc shapes here must stay in
 * sync with admin-app's botErrorRule / botErrorSubtype schemas, and
 * DEFAULT_SUBTYPE_BEHAVIOR must mirror admin-app's SUBTYPE_BEHAVIOR_OVERRIDES.
 */

const logPrefix = 'errorRulesCache |'
const TTL_MS = 5 * 60 * 1000

/**
 * How often a subType is allowed to occupy a NEW row in `botMessages`.
 *
 *   once     — one row per (bot, subType, visibility) until the user dismisses
 *              it. Repeats increment its `count` and move its `time`. This is
 *              what the visible path already did, except that repeats used to be
 *              thrown away instead of counted.
 *   coalesce — one row per `logWindowSec`. For conditions that genuinely recur
 *              and where "it happened again today" is worth a fresh row.
 *   always   — one row per occurrence, no coalescing. Opt-in only; this is the
 *              behaviour that produced 519,061 rows for a single bot.
 */
export type SubtypeLogMode = 'once' | 'coalesce' | 'always'

export interface SubtypeLogPolicy {
  mode: SubtypeLogMode
  windowMs: number
}

export interface SubtypeBehavior {
  showUser: boolean
  errorsBot: boolean
  userMessage?: string
  logMode?: SubtypeLogMode
  logWindowSec?: number
}

/** `coalesce` with no explicit window. */
const DEFAULT_COALESCE_WINDOW_MS = 60 * 60 * 1000

/**
 * Policy for a subType nobody has configured. Deliberately different by
 * visibility:
 *
 *   visible → `once`, which is exactly what the old count-gate enforced, so
 *             shipping this changes nothing a user can see.
 *   hidden  → `coalesce` hourly. These rows exist only so the admin page can
 *             count them; nobody reads them one by one. They had NO throttle at
 *             all (the old gate filtered on `showUser:true`, which no hidden row
 *             matches), which is how one suppressed subType came to write 553
 *             rows a day and 1.10M of the 2.70M rows on prod.
 */
function defaultLogPolicy(showUser: boolean): SubtypeLogPolicy {
  return showUser
    ? { mode: 'once', windowMs: 0 }
    : { mode: 'coalesce', windowMs: DEFAULT_COALESCE_WINDOW_MS }
}

/**
 * Static fallback used ONLY until `boterrorsubtypes` has loaded at least one
 * doc (cold start, or admin-app not yet deployed/seeded). Mirrors admin-app's
 * SUBTYPE_BEHAVIOR_OVERRIDES so a bot-worker restart never briefly flips a
 * benign error into a hard error. Once the DB cache is populated it is
 * authoritative and this is no longer consulted.
 */
const DEFAULT_SUBTYPE_BEHAVIOR: Record<string, SubtypeBehavior> = {
  'Exchange connection': { showUser: false, errorsBot: false },
  'Order price': { showUser: false, errorsBot: false },
  'Order processing': { showUser: false, errorsBot: false },
  'Futures position': { showUser: false, errorsBot: false },
  'Exchange rate limit': {
    showUser: true,
    errorsBot: false,
    userMessage:
      'Exchange temporarily rate-limited our requests. Orders are retried automatically and will resume shortly.',
  },
  'Exchange rules': {
    showUser: true,
    errorsBot: false,
    userMessage:
      'Binance temporarily restricted new orders on this account (Futures Quantitative Rules). New orders are paused and will resume automatically once the cooldown ends. Closing positions still works.',
  },
  'API keys error': {
    showUser: true,
    errorsBot: true,
    userMessage:
      'Your API key was rejected — check the key is valid AND that our server IP is whitelisted on the exchange.',
  },
  'Exchange orders limits': {
    showUser: true,
    errorsBot: true,
    userMessage: 'Maximum number of orders for pair exceeded',
  },
  // 'Indicators error' keeps the fail-safe default here; its message rewrite is
  // a dynamic prefix-strip kept in handleErrors (can't be a static message).
}

interface CompiledRule {
  id: string
  test: (msgLower: string) => boolean
  subType: string
}

// --- rule (message -> subType) cache ---------------------------------------
let compiled: CompiledRule[] = []
let rulesLoadedAt = 0
let rulesLoading = false

// --- subType -> behaviour cache --------------------------------------------
let subtypeMap = new Map<string, SubtypeBehavior>()
let subtypeLoadedAt = 0
let subtypeLoadedNonEmpty = false
let subtypeLoading = false

// --- pending rule-hit counts (ruleId -> increments), flushed on the TTL -----
const pendingHits = new Map<string, number>()

function liveDb() {
  const conn = mongoose.connection
  if (!conn || conn.readyState !== 1 || !conn.db) return null
  return conn.db
}

async function loadRules(): Promise<void> {
  if (rulesLoading) return
  rulesLoading = true
  try {
    const db = liveDb()
    if (!db) return
    const docs = await db
      .collection('boterrorrules')
      .find({ enabled: true })
      .sort({ priority: 1, _id: 1 })
      .toArray()
    const next: CompiledRule[] = []
    for (const r of docs) {
      const pattern = r?.pattern
      const subType = r?.subType
      if (!pattern || !subType) continue
      const id = String(r._id)
      if (r.matchType === 'regex') {
        try {
          const re = new RegExp(String(pattern), 'i')
          next.push({ id, test: (m) => re.test(m), subType })
        } catch {
          // skip invalid regex rules
        }
      } else {
        const needle = String(pattern).toLowerCase()
        next.push({ id, test: (m) => m.includes(needle), subType })
      }
    }
    compiled = next
    rulesLoadedAt = Date.now()
  } catch (e) {
    logger.warn(
      `${logPrefix} failed to load rules: ${(e as Error)?.message || e}`,
    )
  } finally {
    rulesLoading = false
  }
}

async function loadSubtypes(): Promise<void> {
  if (subtypeLoading) return
  subtypeLoading = true
  try {
    const db = liveDb()
    if (!db) return
    const docs = await db.collection('boterrorsubtypes').find({}).toArray()
    const next = new Map<string, SubtypeBehavior>()
    for (const d of docs) {
      if (!d?.subType) continue
      next.set(String(d.subType), {
        showUser: d.showUser ?? true,
        errorsBot: d.errorsBot ?? true,
        userMessage: d.userMessage || undefined,
        logMode: d.logMode || undefined,
        logWindowSec:
          typeof d.logWindowSec === 'number' ? d.logWindowSec : undefined,
      })
    }
    subtypeMap = next
    subtypeLoadedAt = Date.now()
    subtypeLoadedNonEmpty = next.size > 0
  } catch (e) {
    logger.warn(
      `${logPrefix} failed to load subtype behaviours: ${
        (e as Error)?.message || e
      }`,
    )
  } finally {
    subtypeLoading = false
  }
}

async function flushHits(): Promise<void> {
  if (!pendingHits.size) return
  const db = liveDb()
  if (!db) return
  const entries = [...pendingHits.entries()]
  pendingHits.clear()
  try {
    const ops = entries
      .filter(([id]) => mongoose.Types.ObjectId.isValid(id))
      .map(([id, inc]) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(id) },
          update: { $inc: { hits: inc } },
        },
      }))
    if (ops.length) {
      await db.collection('boterrorrules').bulkWrite(ops, { ordered: false })
    }
  } catch (e) {
    // Best-effort: put the counts back so a transient failure doesn't lose them.
    for (const [id, inc] of entries) {
      pendingHits.set(id, (pendingHits.get(id) ?? 0) + inc)
    }
    logger.warn(
      `${logPrefix} failed to flush rule hits: ${(e as Error)?.message || e}`,
    )
  }
}

/**
 * Return the rule-assigned subType for a message, or null if no rule matches.
 * Triggers a background refresh when the cache is stale but always answers from
 * the current in-memory ruleset (never blocks the caller).
 */
export function matchErrorRuleSubType(message: string): string | null {
  if (Date.now() - rulesLoadedAt > TTL_MS) {
    void loadRules()
    void flushHits()
  }
  if (!compiled.length) return null
  const m = (message || '').toLowerCase()
  for (const rule of compiled) {
    if (rule.test(m)) return rule.subType
  }
  return null
}

/**
 * Behaviour for an (already-resolved) subType, or null when unconfigured
 * (caller then keeps today's fail-safe default: shown, errors bot, raw msg).
 * DB is authoritative once loaded; before that we use the static fallback.
 */
export function getSubTypeBehavior(
  subType: string | null | undefined,
): SubtypeBehavior | null {
  if (!subType) return null
  if (Date.now() - subtypeLoadedAt > TTL_MS) {
    void loadSubtypes()
  }
  if (subtypeLoadedNonEmpty) return subtypeMap.get(subType) ?? null
  return DEFAULT_SUBTYPE_BEHAVIOR[subType] ?? null
}

/**
 * Log policy for a subType at a given visibility. Falls back to
 * {@link defaultLogPolicy} when the subType has no row, or has one that predates
 * the policy columns — which is every row until an admin sets one, so the
 * fallback is the behaviour that actually ships.
 *
 * `showUser` is a parameter rather than read off the behaviour row because the
 * caller may already have overridden it (the leverage-`Futures position` case
 * bypasses the table entirely, and explicit `sendError:false` call sites are not
 * expressible as a row at all).
 */
export function getSubTypeLogPolicy(
  subType: string | null | undefined,
  showUser: boolean,
): SubtypeLogPolicy {
  const behavior = getSubTypeBehavior(subType)
  const mode = behavior?.logMode
  if (mode !== 'once' && mode !== 'coalesce' && mode !== 'always') {
    return defaultLogPolicy(showUser)
  }
  if (mode !== 'coalesce') return { mode, windowMs: 0 }
  const sec = behavior?.logWindowSec
  return {
    mode,
    windowMs:
      typeof sec === 'number' && sec > 0
        ? sec * 1000
        : DEFAULT_COALESCE_WINDOW_MS,
  }
}

/**
 * The `bucket` a message written at `time` belongs to under `policy`, or null
 * for `always` (no coalescing — the row stays out of the unique index).
 */
export function logPolicyBucket(
  policy: SubtypeLogPolicy,
  time: number,
): number | null {
  if (policy.mode === 'always') return null
  // `once` is the degenerate window: everything lands in bucket 0, so the key is
  // unique per (bot, subType, visibility) for as long as the row is undismissed.
  if (policy.mode === 'once') return 0
  return Math.floor(time / policy.windowMs)
}

/**
 * Record ONE hit against the rule that matches this message (called once per
 * real error occurrence at the write path). Batched in memory; flushed on the
 * TTL. No-op when no rule matches (a static-errorDict-only classification).
 */
export function noteErrorRuleHit(message: string): void {
  if (!compiled.length) return
  const m = (message || '').toLowerCase()
  for (const rule of compiled) {
    if (rule.test(m)) {
      pendingHits.set(rule.id, (pendingHits.get(rule.id) ?? 0) + 1)
      return
    }
  }
}

/** Optional eager warm-up (e.g. from bot-worker boot). Fire-and-forget. */
export function primeErrorRules(): void {
  void loadRules()
  void loadSubtypes()
}
