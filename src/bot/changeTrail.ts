import type {
  ChangeTrailActor,
  ChangeTrailChange,
  ChangeTrailSchema,
  ExcludeDoc,
} from '../../types'

/**
 * Change trail: pure helpers. The writer lives on the API-layer `Bot` class
 * (`recordChangeTrail`), where every settings change enters.
 */

export type ChangeTrailEntry = Omit<ExcludeDoc<ChangeTrailSchema>, '_id'>

/** Changes made through the dashboard / GraphQL unless a caller says otherwise. */
export const defaultChangeTrailActor: ChangeTrailActor = { type: 'user' }

export const resolveChangeTrailActor = (
  actor?: ChangeTrailActor | null,
  fallback: ChangeTrailActor = defaultChangeTrailActor,
): ChangeTrailActor =>
  actor && typeof actor === 'object' && actor.type ? actor : fallback

const comparable = (v: unknown) =>
  v !== null && typeof v === 'object' ? JSON.stringify(v) : `${v}`

/**
 * The paths a settings patch actually changes, with the value each had before.
 * Keys the patch leaves `undefined` are not changes; equal values (compared the
 * way the existing change events compare them, as strings) are dropped.
 */
export const settingsChanges = (
  before: Record<string, unknown> | undefined | null,
  patch: Record<string, unknown> | undefined | null,
): ChangeTrailChange[] => {
  const changes: ChangeTrailChange[] = []
  for (const [path, after] of Object.entries(patch ?? {})) {
    if (typeof after === 'undefined') {
      continue
    }
    const prev = before ? before[path] : undefined
    if (comparable(prev) === comparable(after)) {
      continue
    }
    changes.push({
      path,
      before: typeof prev === 'undefined' ? null : prev,
      after,
    })
  }
  return changes
}
