/**
 * Spec 044 gate — who gets bot base funding (phases 2 and 3).
 *
 * RELEASED to everyone (2026-10-19): {@link BASE_FUNDING_RELEASED} is true, so
 * every signed-in user is allowed and no role is read. The role path below is
 * kept so the feature can be narrowed back to role holders by flipping that
 * constant (a code change + deploy, by design — no runtime switch).
 *
 * While not released:
 * Only users holding the role {@link BASE_FUNDING_BETA_ROLE} in `user.groups`
 * (the admin user-roles editor, `PUT /user/groups`): exact, case-sensitive,
 * ≤ 60 s cache per process, a failed read keeps the last answer, otherwise not
 * granted. No environment or config switch: every other user — self-hosted
 * included — gets the behaviour from before base funding.
 *
 * The answer is taken ONCE, when a deal is created, and stamped on it
 * (`deal.baseFundingBeta`). Everything later for that deal follows the stamp,
 * so removing the role never strands a deal the bot funded. Pre-deal checks
 * (balance gate, previews, settings writes) ask the gate live.
 */
import { userDb } from '../db/dbInit'
import { createRoleReader } from '../utils/roleGate'

export const BASE_FUNDING_BETA_ROLE = 'BaseFundingBeta'

/** Base funding is generally available: every signed-in user is allowed. */
export const BASE_FUNDING_RELEASED = true

export const BASE_FUNDING_NOT_AVAILABLE =
  'Base funding is not available for your account yet.'

type RoleReader = ReturnType<typeof createRoleReader>

export class BaseFundingGate {
  private static _instance: BaseFundingGate | null = null
  static getInstance(): BaseFundingGate {
    if (!BaseFundingGate._instance) {
      BaseFundingGate._instance = new BaseFundingGate()
    }
    return BaseFundingGate._instance
  }

  private roles: RoleReader = createRoleReader(async (userId) => {
    const res = await userDb.readData({ _id: userId } as any, { groups: 1 })
    if (res.status !== 'OK') throw new Error(res.reason ?? 'read failed')
    return (res.data?.result as { groups?: unknown } | null | undefined)?.groups
  })

  private released = BASE_FUNDING_RELEASED

  /** May this user's NEW deals (and previews, settings) use base funding? */
  async isAllowed(userId: string | null | undefined): Promise<boolean> {
    if (!userId) {
      return false
    }
    if (this.released) {
      return true
    }
    return this.roles
      .hasRole(String(userId), BASE_FUNDING_BETA_ROLE)
      .catch(() => false)
  }

  /** Tests: exercise the role path (or the released one). */
  setReleased(released: boolean) {
    this.released = released
  }

  /** Tests: an injectable role reader. */
  setRoleReader(reader: RoleReader) {
    this.roles = reader
  }
}

/**
 * Spec 044 beta gate on bot settings writes (create / change, GraphQL and
 * v2 REST alike): a user without access cannot store a base-funding mode —
 * a non-`require` value is stored as `require` instead of refused, so an
 * edit carrying the whole settings object (dashboard, clones, API clients
 * echoing a read) never fails on a field the engine would ignore anyway.
 * Mutates and returns `settings`.
 */
export async function coerceBaseFundingSetting<
  T extends { baseFunding?: unknown },
>(userId: string | null | undefined, settings: T): Promise<T> {
  if (
    settings &&
    settings.baseFunding !== undefined &&
    settings.baseFunding !== null &&
    settings.baseFunding !== 'require' &&
    !(await BaseFundingGate.getInstance()
      .isAllowed(userId)
      .catch(() => false))
  ) {
    settings.baseFunding = 'require' as T['baseFunding']
  }
  return settings
}
