/**
 * Spec 257 — the checks `POST /api/v2/deals/dca/merge` runs before it hands a
 * merge to the bot worker. Pure: the route reads the deals and passes them in.
 *
 * The worker re-checks what it needs (spec 138) and reports refusals as bot
 * errors; these checks exist so a caller gets most refusals back as a 4xx
 * instead of a bot event to go looking for.
 */
import { isValidObjectId } from 'mongoose'
import type { MergeDealsOptions } from '../../bot/dcaHelper'

type Refusal = { ok: false; status: 400 | 404 | 409; reason: string }

export type MergeDealsRequest = {
  dealIds: string[]
  /** One of `dealIds`; its bot owns the merged deal. */
  targetDealId: string
  options: MergeDealsOptions
}

/** The fields of a stored DCA deal the checks read. */
export type MergeCandidate = {
  _id: string
  status: string
  botId: string
  symbol: { symbol: string }
  strategy: string
  exchangeUUID: string
  paperContext?: boolean | null
  child?: boolean | null
  parentId?: string | null
}

const refuse = (status: Refusal['status'], reason: string): Refusal => ({
  ok: false,
  status,
  reason,
})

/** §1.2.2 — the body's shape. */
export function parseMergeDealsBody(
  body: Record<string, unknown>,
): { ok: true; value: MergeDealsRequest } | Refusal {
  const { dealIds, targetDealId, useTp, useSl, useDca, dcaOrders } = body ?? {}
  if (!Array.isArray(dealIds) || dealIds.length < 2) {
    return refuse(400, '`dealIds` must be an array of at least 2 deal IDs')
  }
  if (dealIds.some((id) => typeof id !== 'string' || !isValidObjectId(id))) {
    return refuse(400, '`dealIds` contains an invalid deal ID')
  }
  const ids = dealIds as string[]
  if (new Set(ids).size !== ids.length) {
    return refuse(400, '`dealIds` contains the same deal more than once')
  }
  if (
    targetDealId !== undefined &&
    (typeof targetDealId !== 'string' || !ids.includes(targetDealId))
  ) {
    return refuse(400, '`targetDealId` must be one of `dealIds`')
  }
  const options: MergeDealsOptions = {}
  for (const [key, value] of [
    ['useTp', useTp],
    ['useSl', useSl],
    ['useDca', useDca],
  ] as const) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'boolean') {
      return refuse(400, `\`${key}\` must be a boolean`)
    }
    options[key] = value
  }
  if (dcaOrders !== undefined && dcaOrders !== null) {
    if (
      typeof dcaOrders !== 'number' ||
      !Number.isInteger(dcaOrders) ||
      dcaOrders < 1
    ) {
      return refuse(400, '`dcaOrders` must be a positive integer')
    }
    options.dcaOrders = dcaOrders
  }
  return {
    ok: true,
    value: {
      dealIds: ids,
      targetDealId: (targetDealId as string | undefined) ?? ids[0],
      options,
    },
  }
}

/**
 * §1.2.3–7 — the deals the caller owns among `ids`, against each other and
 * the request's trading context. Returns the bot that will own the merge.
 */
export function checkMergeCandidates(
  ids: string[],
  targetDealId: string,
  deals: MergeCandidate[],
  paperContext: boolean,
): { ok: true; botId: string } | Refusal {
  const byId = new Map(deals.map((d) => [`${d._id}`, d]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) {
    return refuse(404, `DCA deals not found: ${missing.join(', ')}`)
  }
  const list = ids.map((id) => byId.get(id)!)
  for (const d of list) {
    if (d.child && d.parentId) {
      return refuse(409, `Deal ${d._id} was already merged into ${d.parentId}`)
    }
  }
  for (const d of list) {
    if (d.status !== 'open') {
      return refuse(
        409,
        `Deal ${d._id} is ${d.status}; only open deals can be merged`,
      )
    }
  }
  for (const d of list) {
    if (!!d.paperContext !== paperContext) {
      return refuse(
        400,
        `Deal ${d._id} is a ${d.paperContext ? 'paper' : 'real'} trading deal; send the matching paper-context header`,
      )
    }
  }
  const [first] = list
  const differs = (pick: (d: MergeCandidate) => string) =>
    list.some((d) => pick(d) !== pick(first))
  if (differs((d) => d.symbol?.symbol)) {
    return refuse(400, 'All deals must be on the same pair')
  }
  if (differs((d) => d.strategy)) {
    return refuse(400, 'All deals must be the same side (long or short)')
  }
  if (differs((d) => `${d.exchangeUUID}`)) {
    return refuse(400, 'All deals must be on the same exchange account')
  }
  return { ok: true, botId: `${byId.get(targetDealId)!.botId}` }
}
