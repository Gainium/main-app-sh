import logger from '../utils/logger'

/**
 * Arming for the two Kraken-spot bulk venue calls, spec
 * `specs/076.kraken-spot-bulk-cancel-and-bulk-place.md` §5.
 *
 * Both flags gate code that talks to a live venue with real money — one that
 * cancels many resting orders in a single request, one that places many. Neither
 * is a behaviour anyone asked for by running the engine, so deploying them must
 * not, by itself, change how a single account is traded. An operator arms them
 * deliberately, one bot first, having read what the batch path logs.
 *
 * The shape is the one `BOT_TP_COVERAGE_REPAIR` established (spec `016`): `1`
 * for the whole fleet, or a comma-separated list of bot ids for a careful
 * rollout. It is a separate parser rather than that one reused because the
 * subject is different — bot ids, which are ObjectIds *or* UUIDs, where that
 * flag names deal ids — and a validator that accepted both shapes for both
 * flags would accept a deal id typed into a bot-id flag and silently arm
 * nothing.
 */
export type BatchScope =
  | { kind: 'off' }
  | { kind: 'fleet' }
  | { kind: 'bots'; botIds: Set<string> }
  | { kind: 'invalid'; tokens: string[] }

/**
 * A bot id, in either spelling the platform issues: a Mongo ObjectId, or a
 * UUID for the bots created with one (`src/server/v2/api.ts` accepts both).
 * Anything else is a typo, and a typo must not silently arm the fleet or
 * silently arm nothing that reads like a success.
 */
const BOT_ID = /^([0-9a-f]{24}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i

/** Reads one of the two flags. Every ambiguous value answers "do not batch". */
export const parseBatchScope = (raw: string | undefined): BatchScope => {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'off' }
  if (/^(1|true|yes)$/i.test(value)) return { kind: 'fleet' }
  const tokens = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const bad = tokens.filter((t) => !BOT_ID.test(t))
  if (bad.length || !tokens.length) return { kind: 'invalid', tokens: bad }
  return { kind: 'bots', botIds: new Set(tokens.map((t) => t.toLowerCase())) }
}

/** May this bot use the batch path? */
export const batchScopeAllows = (scope: BatchScope, botId: string): boolean =>
  scope.kind === 'fleet' ||
  (scope.kind === 'bots' && scope.botIds.has(`${botId}`.toLowerCase()))

/**
 * The startup line. An operator arming a venue-changing path has to be able to
 * confirm from the log that the engine read what he typed — particularly for
 * the `invalid` case, which is the one that looks like nothing happened.
 */
export const describeBatchScope = (scope: BatchScope): string => {
  switch (scope.kind) {
    case 'fleet':
      return 'ARMED for every Kraken spot bot (fleet-wide)'
    case 'bots':
      return `ARMED for ${scope.botIds.size} bot(s): ${[...scope.botIds].join(
        ', ',
      )}`
    case 'invalid':
      return (
        `value not understood, so nothing is armed — not a bot id: ` +
        `${scope.tokens.join(', ')}. Expected 1/true/yes for every Kraken ` +
        `spot bot, or a comma-separated list of bot ids`
      )
    case 'off':
      return 'not armed'
  }
}

const cancelScope = parseBatchScope(process.env.BOT_BATCH_CANCEL)
const placeScope = parseBatchScope(process.env.BOT_BATCH_PLACE)

/**
 * Say what was read, once per process. Silent while unset: that is the state
 * the whole fleet runs in, and this would otherwise be two lines on every boot
 * of every bot worker forever.
 */
const announce = (name: string, subject: string, scope: BatchScope) => {
  if (!(process.env[name] ?? '').trim()) {
    return
  }
  const line = `${name}: ${subject} ${describeBatchScope(scope)}`
  if (scope.kind === 'invalid') {
    logger.warn(line)
  } else {
    logger.info(line)
  }
}

announce('BOT_BATCH_CANCEL', 'bulk order cancel', cancelScope)
announce('BOT_BATCH_PLACE', 'bulk order placement', placeScope)

/** Is bulk CANCEL armed for this bot? */
export const batchCancelEnabled = (botId: string): boolean =>
  batchScopeAllows(cancelScope, botId)

/** Is bulk PLACEMENT armed for this bot? */
export const batchPlaceEnabled = (botId: string): boolean =>
  batchScopeAllows(placeScope, botId)
