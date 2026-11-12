import { dcaBotDb } from '../../db/dbInit'
import { BotStatusEnum, StatusEnum } from '../../../types'

/**
 * One source (a DCA/Combo deal or a grid bot) can be moved to the terminal
 * once.
 *
 * A move creates a terminal deal that adopts the source's coins as an import
 * (no exchange order) and only then cancels the source. Nothing stopped the
 * same move being submitted again: the source was read without a status
 * check, so a second submit, seconds or minutes later, adopted the same coins
 * into a second terminal deal. Two deals then claim one position, and
 * whichever closes second has nothing left to sell.
 *
 * Refused when the source has already ended, when a live terminal bot already
 * imports it, or while a move of the same source is still in flight in this
 * process (a double click lands before the first move's terminal bot exists).
 */
const inFlight = new Set<string>()

export const TERMINAL_MOVE_ALREADY_MOVED =
  'This position was already moved to the terminal'
export const TERMINAL_MOVE_IN_PROGRESS =
  'This position is already being moved to the terminal'
export const TERMINAL_MOVE_SOURCE_ENDED =
  'This position is already closed and cannot be moved to the terminal'

export function terminalMoveRefusalReason(input: {
  sourceEnded: boolean
  inFlight: boolean
  existingImport: boolean
}): string | null {
  if (input.inFlight) {
    return TERMINAL_MOVE_IN_PROGRESS
  }
  if (input.existingImport) {
    return TERMINAL_MOVE_ALREADY_MOVED
  }
  if (input.sourceEnded) {
    return TERMINAL_MOVE_SOURCE_ENDED
  }
  return null
}

async function hasLiveTerminalImport(userId: string, sourceId: string) {
  const found = await dcaBotDb.readData(
    {
      userId,
      'settings.importFrom': sourceId,
      isDeleted: { $ne: true },
      status: { $ne: BotStatusEnum.closed },
    } as any,
    { _id: 1 },
  )
  return found.status === StatusEnum.ok && !!found.data?.result
}

/**
 * Runs `move` only if the source may be moved, holding the in-flight claim
 * for the whole move. Returns the refusal in the resolvers' response shape.
 */
export async function withTerminalMoveGuard<T>(
  userId: string,
  sourceId: string,
  sourceEnded: boolean,
  move: () => Promise<T>,
): Promise<T | { status: StatusEnum.notok; reason: string; data: null }> {
  const key = `${userId}:${sourceId}`
  const reason = terminalMoveRefusalReason({
    sourceEnded,
    inFlight: inFlight.has(key),
    existingImport:
      !inFlight.has(key) && (await hasLiveTerminalImport(userId, sourceId)),
  })
  if (reason || inFlight.has(key)) {
    return {
      status: StatusEnum.notok,
      reason: reason ?? TERMINAL_MOVE_IN_PROGRESS,
      data: null,
    }
  }
  inFlight.add(key)
  try {
    return await move()
  } finally {
    inFlight.delete(key)
  }
}
