import { BotType } from '../../types'

/**
 * Which process owns each indicator-service subscription, so a restart beacon
 * can drop exactly that process's stale subscriber ids.
 *
 * A room (exchange/symbol/interval/indicator config) is shared by every
 * subscriber with the same config — bots of different types, bots in
 * different processes, the metrics service, other consumer services. The old restart
 * handler called `removeCallback(room)` for every room the restarted process
 * had touched, which emptied the room's whole subscriber list. The room kept
 * publishing, but its live subscribers from other processes were no longer
 * counted, so the next time the (re-subscribed) restarted process left the
 * room its count reached zero and the room was closed under them — they kept
 * listening on a channel nothing published to any more.
 *
 * The owner key is the restart beacon the owning process publishes on
 * `serviceLog`: `botService${BotServiceType}` for bot processes,
 * `metricsService`, or the `service` a consumer process sends with its
 * subscriptions.
 */
export const indicatorSubscriberOwner = (msg: {
  type: string
  service?: string
}): string => {
  if (msg.service) {
    return msg.service
  }
  // Senders that predate `service`: bot processes were keyed by bot type.
  if (Object.values(BotType).includes(msg.type as BotType)) {
    return `botService${msg.type}`
  }
  return msg.type
}

export class IndicatorSubscriberOwners {
  /** owner → room → subscriber ids */
  private owners: Map<string, Map<string, Set<string>>> = new Map()

  add(owner: string, room: string, id: string) {
    const rooms = this.owners.get(owner) ?? new Map<string, Set<string>>()
    const ids = rooms.get(room) ?? new Set<string>()
    ids.add(id)
    rooms.set(room, ids)
    this.owners.set(owner, rooms)
  }

  /** Forget one subscriber id, whichever owner holds it. Returns its room. */
  remove(id: string): string | undefined {
    for (const [owner, rooms] of this.owners) {
      for (const [room, ids] of rooms) {
        if (ids.delete(id)) {
          if (ids.size === 0) {
            rooms.delete(room)
          }
          if (rooms.size === 0) {
            this.owners.delete(owner)
          }
          return room
        }
      }
    }
    return undefined
  }

  /** Remove and return every subscriber id held by `owner`. */
  take(owner: string): { room: string; id: string }[] {
    const rooms = this.owners.get(owner)
    this.owners.delete(owner)
    const out: { room: string; id: string }[] = []
    for (const [room, ids] of rooms ?? []) {
      for (const id of ids) {
        out.push({ room, id })
      }
    }
    return out
  }
}
