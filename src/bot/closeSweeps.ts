/**
 * Spec 182. A deal close cancels the deal's orders one venue call at a time,
 * and a long combo ladder takes tens of seconds to sweep. The deal is already
 * `closed` when the sweep starts, so a process stop in the middle left the
 * rest of its orders live with nothing on any restart path able to find them:
 * the Redis order snapshot can be older than the deal itself.
 *
 * The bot therefore records each sweep in its Redis hash (`closeSweeps`)
 * before it starts and clears the record when it is done; a later start
 * resumes the ones it finds. This module holds the decisions — no I/O.
 */

/** A recorded sweep older than this is dropped unread. */
export const closeSweepMaxAgeMs = 7 * 24 * 60 * 60 * 1000

export type CloseSweepEntry = { dealId: string; at: number }

/** What this process knows about a deal a recorded sweep names. */
export type CloseSweepDealState = 'held' | 'inFlight' | null

/** The Redis value, read defensively: anything malformed is ignored. */
export const parseCloseSweeps = (raw: unknown): Map<string, number> => {
  const out = new Map<string, number>()
  if (!Array.isArray(raw)) {
    return out
  }
  for (const e of raw) {
    if (
      e &&
      typeof e.dealId === 'string' &&
      e.dealId &&
      typeof e.at === 'number' &&
      Number.isFinite(e.at)
    ) {
      out.set(e.dealId, e.at)
    }
  }
  return out
}

export const serializeCloseSweeps = (
  entries: Map<string, number>,
): CloseSweepEntry[] => [...entries].map(([dealId, at]) => ({ dealId, at }))

/**
 * Which recorded sweeps a start resumes. A deal this process still holds is
 * not finished — its own close clears the record — and a sweep running in
 * this process (a reload raced it) must not be run twice.
 */
export const closeSweepsToResume = (
  entries: Map<string, number>,
  now: number,
  stateOf: (dealId: string) => CloseSweepDealState,
  maxAgeMs = closeSweepMaxAgeMs,
): { resume: string[]; expired: string[] } => {
  const resume: string[] = []
  const expired: string[] = []
  for (const [dealId, at] of entries) {
    if (now - at > maxAgeMs) {
      expired.push(dealId)
      continue
    }
    if (stateOf(dealId) === null) {
      resume.push(dealId)
    }
  }
  return { resume, expired }
}
