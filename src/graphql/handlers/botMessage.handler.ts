import { DEFAULT_DB_LIMIT, StatusEnum } from '../../../types'
import { botMessageDb } from '../../db/dbInit'

export const getBotMessage = async (
  userId: string,
  paperContext: boolean,
  unreadOnly = true,
  page?: number,
  pageSize?: number,
  search?: string,
) => {
  const filter: Record<string, unknown> = {
    userId,
    showUser: true,
    paperContext: paperContext ? { $eq: true } : { $ne: true },
  }
  // Both clauses are $or's, so they have to be $and'ed together — assigning
  // filter.$or twice made a search silently drop the unreadOnly (isDeleted)
  // clause and return already-deleted messages.
  const clauses: Record<string, unknown>[] = []
  if (unreadOnly) {
    clauses.push({
      $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }],
    })
  }
  if (search) {
    clauses.push({
      $or: [
        { message: { $regex: search, $options: 'i' } },
        { botName: { $regex: search, $options: 'i' } },
        { botId: { $regex: search, $options: 'i' } },
        { symbol: { $regex: search, $options: 'i' } },
        { exchange: { $regex: search, $options: 'i' } },
        { subType: { $regex: search, $options: 'i' } },
      ],
    })
  }
  if (clauses.length) {
    filter.$and = clauses
  }
  const result = await botMessageDb.readData(
    filter,
    undefined,
    {
      limit: pageSize ? Math.min(pageSize, DEFAULT_DB_LIMIT) : undefined,
      skip: ((page ?? 1) - 1) * (pageSize ?? 0),
      sort: { created: -1 },
    },
    true,
    true,
  )
  return result.status === StatusEnum.notok
    ? result
    : {
        ...result,
        total: result.data.count,
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
    result = await botMessageDb.updateManyData({ userId }, { isDeleted: true })
  }
  return result
}

export const deleteUserAllPaperMessages = async (userId: string) => {
  return botMessageDb.deleteManyData({ userId, paperContext: true })
}
