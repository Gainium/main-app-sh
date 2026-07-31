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

export const getBotMessage = async (
  userId: string,
  paperContext: boolean,
  unreadOnly = true,
  page?: number,
  pageSize?: number,
  search?: string,
) => {
  // Point-set (equality) predicates only. `{$ne: true}` and `$exists` are
  // RANGES, which Mongo can only apply as residual FETCH filters — that is what
  // forced a fetch of all 801,949 of the account's docs to return the 2 rows its
  // live feed actually holds. `$in`
  // over the actual values yields exact index bounds that the
  // {userId, showUser, paperContext, isDeleted, created} index can serve, and
  // SORT_MERGE still supplies {created: -1} straight from the index, so there is
  // no blocking in-memory sort. `$in: [false, null]` also matches docs where the
  // field is absent, so it is equivalent to the old `$exists`/`$ne` forms.
  // isDeleted is ALWAYS constrained (to every value when !unreadOnly) — leaving
  // a hole in the middle of the index key would cost the index-provided sort.
  const filter: Record<string, unknown> = {
    userId,
    showUser: true,
    paperContext: paperContext ? true : { $in: [false, null] },
    isDeleted: unreadOnly
      ? { $in: [false, null] }
      : { $in: [true, false, null] },
  }
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
    result = await botMessageDb.updateData(
      { userId, _id: messageId },
      {
        isDeleted: true,
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
      { isDeleted: true },
    )
  }
  return result
}

export const deleteUserAllPaperMessages = async (userId: string) => {
  return botMessageDb.deleteManyData({ userId, paperContext: true })
}
