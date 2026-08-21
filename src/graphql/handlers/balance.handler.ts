import { balanceDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'

import type { ClearUserSchema } from '../../../types'

export const getBalances = async (
  user: ClearUserSchema,
  shouldSumBalance = true,
  assets?: string[],
  uuid?: string,
  paperContext?: boolean,
) => {
  const userId = user._id.toString()
  const search: {
    userId: string
    exchangeUUID?: string
    asset?: { $in: string[] }
    $or: Array<Record<string, { $gt: number }>>
  } = {
    userId,
    $or: [{ free: { $gt: 0 } }, { locked: { $gt: 0 } }],
  }
  // A futures leg that shares its API key with a spot leg (OKX / Bybit
  // unified accounts) is `linkedTo` that spot leg: the balance refresher
  // skips linked legs and stores the shared pool ONLY under the source uuid,
  // and the bot engine resolves the link when it checks funds. Do the same
  // here — read the source uuid's rows, but tag them with the uuid the caller
  // asked for — or the bot form shows "BAL 0" for every linked futures leg
  // (the legacy dashboard resolved `linkedTo` client-side; the redesign
  // doesn't, and first surfaced on OKX Europe where the only futures leg is
  // linked). No-uuid / summed reads are unchanged.
  const linkedSourceUuid = uuid
    ? user.exchanges.find((e) => e.uuid === uuid)?.linkedTo
    : undefined
  if (uuid) {
    search.exchangeUUID = linkedSourceUuid || uuid
  }
  if (assets && assets.length > 0) {
    search.asset = { $in: assets }
  }
  const balance = await balanceDb.readData(
    { ...search, paperContext: paperContext ? { $eq: true } : { $ne: true } },
    undefined,
    {},
    true,
    true,
  )
  if (balance.status === StatusEnum.notok) {
    return balance
  }
  if (balance.data.count === 0) {
    return {
      status: StatusEnum.ok,
      reason: null,
      data: [],
    }
  }
  let final: typeof balance.data.result = []
  const userExchanges = user.exchanges.map((e) => e.uuid)
  if (shouldSumBalance) {
    balance.data.result
      .filter((b) => userExchanges.includes(b.exchangeUUID))
      .forEach((b) => {
        const find = final.find((f) => f.asset === b.asset)
        if (!find) {
          final.push(b)
        }
        if (find) {
          find.free += b.free
          find.locked += b.locked
          final = [...final.filter((f) => f.asset !== b.asset), find]
        }
      })
  } else {
    final = balance.data.result.filter((b) =>
      userExchanges.includes(b.exchangeUUID),
    )
  }
  return {
    status: StatusEnum.ok,
    reason: null,
    data: final.map((d) => {
      // Re-tag rows read through a `linkedTo` hop with the requested leg.
      const remap = !!uuid && !!linkedSourceUuid
      const outUuid = remap ? uuid : d.exchangeUUID
      const outExchange = remap
        ? (user.exchanges.find((e) => e.uuid === uuid)?.provider ??
          d.exchange)
        : d.exchange
      return {
        asset: d.asset,
        free: `${d.free}`,
        locked: `${d.locked}`,
        exchange: shouldSumBalance ? '' : outExchange,
        exchangeUUID: shouldSumBalance ? '' : outUuid,
        exchangeName: shouldSumBalance
          ? ''
          : user.exchanges.find((e) => e.uuid === outUuid)?.name ||
            outExchange,
      }
    }),
  }
}
