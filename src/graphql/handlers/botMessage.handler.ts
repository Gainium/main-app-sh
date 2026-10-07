import { DEFAULT_DB_LIMIT, StatusEnum } from '../../../types'
import { botMessageDb } from '../../db/dbInit'

// The notifications panel asks for its default page-1 load with NO input at all
// (main-dash-redesign `useNotifications` sends no `input` when
// page === 1 && !search && !unreadOnly, which is also what the Navbar's
// count-only mount does), so `pageSize` arrives undefined here. That used to
// mean "no limit", which made the resolver fetch AND serialise every message the
// account had ever received. Measured on a seeded 801,949-message account in the
// reporter's shape: the paper feed returned 793,679 rows / 308MB of JSON in 22.7s
// to render a 20-row panel. Bound the unpaginated feed instead: it is far deeper
// than the panel can display, and the rows and `total` stay byte-identical for
// every account below the bound.
const UNPAGINATED_FEED_LIMIT = 5000

export type BotMessageView = 'unread' | 'read' | 'all'
const BOT_MESSAGE_VIEWS: readonly string[] = ['unread', 'read', 'all']

/** Not yet read. `null` also matches rows written before `isRead` existed. */
const UNREAD = { $in: [false, null] }
const NOT_DELETED = { $in: [false, null] }
const ANY_BOOL = { $in: [true, false, null] }

/**
 * The notifications feed filter (spec 137 §2.2/§2.3). Returns null for an
 * unknown `view`.
 *
 * Point-set (equality) predicates only. `{$ne: true}` and `$exists` are
 * RANGES, which Mongo can only apply as residual FETCH filters — that is what
 * forced a fetch of all 801,949 of the account's docs to return the 2 rows its
 * live feed actually holds. `$in` over the actual values yields exact index
 * bounds that the {userId, showUser, paperContext, isDeleted, isRead, created}
 * index can serve, and SORT_MERGE still supplies {created: -1} straight from
 * the index, so there is no blocking in-memory sort. `$in: [false, null]` also
 * matches docs where the field is absent. isDeleted and isRead are ALWAYS
 * constrained — leaving a hole in the middle of the index key would cost the
 * index-provided sort.
 *
 * Read is not delete: a read row stays `isDeleted:false` and is reachable from
 * the `read` and `all` views. `unreadOnly:false` without a view is the legacy
 * archive (every visible row, deleted ones included) that older dashboards send.
 */
export const botMessageFeedFilter = (
  userId: string,
  paperContext: boolean,
  {
    view,
    unreadOnly = true,
    search,
    type,
    botId,
  }: {
    view?: string
    unreadOnly?: boolean
    search?: string
    type?: string
    botId?: string
  },
): Record<string, unknown> | null => {
  if (view !== undefined && view !== null && !BOT_MESSAGE_VIEWS.includes(view)) {
    return null
  }
  const resolved: BotMessageView | 'legacyArchive' =
    (view as BotMessageView | undefined) ??
    (unreadOnly ? 'unread' : 'legacyArchive')
  const filter: Record<string, unknown> = {
    userId,
    showUser: true,
    paperContext: paperContext ? true : { $in: [false, null] },
    isDeleted: resolved === 'legacyArchive' ? ANY_BOOL : NOT_DELETED,
    isRead:
      resolved === 'unread'
        ? UNREAD
        : resolved === 'read'
          ? { $in: [true] }
          : ANY_BOOL,
  }
  // Severity / bot narrowing for the history page (§3.4). Residual filters
  // after the index-bounded prefix — the history page is paginated and the
  // set they apply to is bounded by the 90-day read TTL.
  if (type) filter.type = type
  if (botId) filter.botId = botId
  if (search) {
    filter.$or = [
      { message: { $regex: search, $options: 'i' } },
      { botName: { $regex: search, $options: 'i' } },
      { botId: { $regex: search, $options: 'i' } },
      { symbol: { $regex: search, $options: 'i' } },
      { exchange: { $regex: search, $options: 'i' } },
      { subType: { $regex: search, $options: 'i' } },
    ]
  }
  return filter
}

export const getBotMessage = async (
  userId: string,
  paperContext: boolean,
  {
    view,
    unreadOnly = true,
    page,
    pageSize,
    search,
    type,
    botId,
  }: {
    view?: string
    unreadOnly?: boolean
    page?: number
    pageSize?: number
    search?: string
    type?: string
    botId?: string
  } = {},
) => {
  const filter = botMessageFeedFilter(userId, paperContext, {
    view,
    unreadOnly,
    search,
    type,
    botId,
  })
  if (!filter) {
    return {
      status: StatusEnum.notok,
      reason: `Unknown view ${view}`,
      data: null,
    }
  }
  const cappedPageSize = pageSize
    ? Math.min(pageSize, DEFAULT_DB_LIMIT)
    : undefined
  const result = await botMessageDb.readData(
    filter,
    undefined,
    {
      limit: cappedPageSize ?? UNPAGINATED_FEED_LIMIT,
      skip: ((page ?? 1) - 1) * (cappedPageSize ?? 0),
      sort: { created: -1 },
    },
    true,
    false,
  )
  if (result.status === StatusEnum.notok) {
    return result
  }
  // Bound the count the same way. `readData`'s own `countNeed` runs an unbounded
  // countDocuments, which repeated the identical full scan a second time —
  // measured at 3.5s of the live feed's 11.0s on the seeded account. countData's
  // `limit` arg caps it, so the worst case is UNPAGINATED_FEED_LIMIT keys instead
  // of the whole collection.
  const count = await botMessageDb.countData(filter, UNPAGINATED_FEED_LIMIT)
  return {
    ...result,
    total:
      count.status === StatusEnum.notok
        ? result.data.result.length
        : count.data.result,
  }
}

export const deleteBotMessage = async (userId: string, messageId?: string) => {
  let result
  if (messageId) {
    // `$unset bucket` alongside the tombstone: it takes the row out of
    // `botMessageCoalesceKey` so a recurrence inserts a new, visible message
    // instead of incrementing the one the user just dismissed.
    result = await botMessageDb.updateData(
      { userId, _id: messageId },
      {
        $set: { isDeleted: true },
        $unset: { bucket: '' },
      },
      true,
      true,
    )
  } else {
    // Bound the clear-all by isDeleted, the field the update itself writes.
    // `{userId}` alone matched EVERY message the account had ever received, so
    // each "mark all read" click re-examined the whole history even when there
    // was nothing left to mark: measured on a seeded 800,000-message account in
    // the reporter's shape, a repeat click examined 800,000 keys + 800,000 docs
    // (userId_1 has no isDeleted in its key, so every doc had to be FETCHed to
    // discover it was already deleted) for 0 modified rows, in 13.3s — the
    // reported 13,182ms worst case almost exactly.
    // `$in: [false, null]` is a point-set, so the
    // {userId, showUser, paperContext, isDeleted, created} index can bound it
    // directly and the repeat becomes 3 keys / 0 docs / ~45ms. `null` also
    // matches docs where the field is absent, so legacy messages written before
    // the schema default are still cleared — same rows as before, same result.
    result = await botMessageDb.updateManyData(
      { userId, isDeleted: { $in: [false, null] } },
      { $set: { isDeleted: true }, $unset: { bucket: '' } },
    )
  }
  return result
}

/**
 * Acknowledge one message (by id) or every unread message of the user (spec
 * 137 §2.4). Unlike `deleteBotMessage` the row is NOT tombstoned: it stays in
 * the feed's `read`/`all` views until `botMessageReadHistoryTtl` reaps it 90
 * days after `readAt`.
 *
 * `$unset bucket` for the same reason the dismiss does it: it takes the row out
 * of `botMessageCoalesceKey`, so the next occurrence of the condition inserts a
 * fresh unread message instead of incrementing one the user already read.
 *
 * Both paths filter on `isRead` unread, so re-marking is a no-op that keeps the
 * original `readAt`, and on not-deleted, so a deleted row is never revived into
 * the history. The clear-all is bounded by the same point-sets as the feed for
 * the reason given on `deleteBotMessage` below.
 */
export const markBotMessageRead = async (
  userId: string,
  messageId?: string,
) => {
  const update = {
    $set: { isRead: true, readAt: new Date() },
    $unset: { bucket: '' as const },
  }
  if (messageId) {
    return botMessageDb.updateData(
      { userId, _id: messageId, isDeleted: NOT_DELETED, isRead: UNREAD },
      update,
    )
  }
  return botMessageDb.updateManyData(
    { userId, isDeleted: NOT_DELETED, isRead: UNREAD },
    update,
  )
}

export const deleteUserAllPaperMessages = async (userId: string) => {
  return botMessageDb.deleteManyData({ userId, paperContext: true })
}
