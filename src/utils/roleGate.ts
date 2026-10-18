/**
 * Role-based rollout helpers, ported from main-app `src/agents/max/allowlist.ts`
 * (core must not import main-app). Pure and injectable so they can be tested
 * without a database.
 *
 * Semantics (same as the Max gate): a role is an exact, case-sensitive name
 * in `user.groups`; each user's roles are cached ≤ `ttlMs` per process; a
 * failed read keeps the last answer (or no roles); the cache is bounded.
 */

/** Pure: the role names on a user document's `groups` value. */
export const resolveGroups = (raw: unknown): readonly string[] =>
  Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : []

export const ROLE_CACHE_TTL_MS = 60_000

/**
 * Per-user role cache over an injectable reader. Entries expire after
 * `ttlMs`; the map is bounded so a long-lived process can't grow it without
 * limit.
 */
export function createRoleReader(
  readGroups: (userId: string) => Promise<unknown>,
  ttlMs = ROLE_CACHE_TTL_MS,
  now: () => number = Date.now,
  maxEntries = 50_000,
) {
  const cache = new Map<string, { at: number; groups: readonly string[] }>()
  const groupsOf = async (userId: string): Promise<readonly string[]> => {
    const hit = cache.get(userId)
    if (hit && now() - hit.at < ttlMs) return hit.groups
    let groups: readonly string[]
    try {
      groups = resolveGroups(await readGroups(userId))
    } catch {
      groups = hit?.groups ?? []
    }
    cache.delete(userId)
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(userId, { at: now(), groups })
    return groups
  }
  return {
    hasRole: async (userId: string, role: string) =>
      (await groupsOf(userId)).includes(role),
    reset: () => cache.clear(),
  }
}
