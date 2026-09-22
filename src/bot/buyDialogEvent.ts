import { BotStatusEnum, BotType, type BuyTypeEnum } from '../../types'

/**
 * Spec 081 — the `Buy dialog` bot event (rendered "Manual buy" in the
 * dashboard's event log).
 *
 * `changeStatus` accepts an optional buy mode, but only ONE of its branches
 * forwards it: a grid bot moving to `open` posts it to the grid worker, which
 * adopts it as the swap type. The grid stop branch hard-codes the three buy
 * arguments to `undefined`, and no combo/DCA/hedge branch takes them at all.
 *
 * Writing the event from the mere presence of the input therefore claimed a
 * manual buy for plain Stops and for bot types that never had one — both
 * dashboards carry the grid start dialog's default mode on every status
 * change. Origin must be read from the branch that consumed the mode, not
 * from the field being set.
 */
export const BUY_DIALOG_EVENT = 'Buy dialog'

/**
 * Was this status change the one that applies a chosen buy mode — i.e. may it
 * be recorded as a manual buy?
 */
export function isManualBuyStatusChange(
  type: BotType,
  status: BotStatusEnum,
): boolean {
  return type === BotType.grid && status === BotStatusEnum.open
}

/**
 * The `Buy dialog` rows a `changeStatus` request should leave behind, in
 * write order. Empty unless the request actually applied a buy mode.
 */
export function buyDialogEventsFor(input: {
  userId: string
  botId: string
  type: BotType
  status: BotStatusEnum
  buyType?: BuyTypeEnum
  buyCount?: string
  paperContext: boolean
}): {
  userId: string
  botId: string
  botType: BotType
  event: string
  description: string
  paperContext: boolean
}[] {
  if (!isManualBuyStatusChange(input.type, input.status)) {
    return []
  }
  const base = {
    userId: input.userId,
    botId: input.botId,
    botType: input.type,
    event: BUY_DIALOG_EVENT,
    paperContext: input.paperContext,
  }
  const events: (typeof base & { description: string })[] = []
  if (input.buyCount) {
    events.push({ ...base, description: `Buy count: ${input.buyCount}` })
  }
  if (input.buyType) {
    events.push({ ...base, description: `Buy type: ${input.buyType}` })
  }
  return events
}
