/**
 * Conditional cooldown after deal stop (`cooldownAfterDealStopTrigger`).
 *
 * `any` (the default, and the behaviour when the setting is missing) starts
 * the cooldown after every closed deal and is measured from `lastClosedDeal`.
 * `sl` and `loss` start it only after a close that matched, and are measured
 * from the last such close — recorded separately, so a winning close inside the
 * window does not shorten it. Both are recorded on every close whatever the bot
 * is set to, so switching the trigger takes effect from history at once.
 *
 * Mirrors `@gainium/backtester` (`DCABacktesting.closeDeal`), which must give
 * the same answer for a backtest of the same bot.
 */
import {
  CooldownOptionsEnum,
  CooldownStopTriggerEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
} from '../../../types'
import type { LastClosesByTrigger } from '../../../types'

export type ConditionalCooldownTrigger = keyof LastClosesByTrigger

type ClosedDealLike = {
  status?: DCADealStatusEnum
  closeTrigger?: DCACloseTriggerEnum
  profit?: { total?: number }
}

type LastCloses = {
  lastClosedDeal?: number
  lastClosedDealPerSymbol?: { symbol: string; time: number }[]
  lastClosedDealByTrigger?: LastClosesByTrigger
  lastClosedDealByTriggerPerSymbol?: (LastClosesByTrigger & {
    symbol: string
  })[]
}

/** The conditional triggers a just-closed deal matches. */
export const cooldownTriggersForClose = (
  deal: ClosedDealLike,
): ConditionalCooldownTrigger[] => {
  // a cancelled deal sent no closing order — nothing was stopped out or realized
  if (deal.status === DCADealStatusEnum.canceled) {
    return []
  }
  const matched: ConditionalCooldownTrigger[] = []
  if (
    deal.closeTrigger === DCACloseTriggerEnum.sl ||
    deal.closeTrigger === DCACloseTriggerEnum.liquidation
  ) {
    matched.push(CooldownStopTriggerEnum.sl)
  }
  const total = +(deal.profit?.total ?? 0)
  if (Number.isFinite(total) && total < 0) {
    matched.push(CooldownStopTriggerEnum.loss)
  }
  return matched
}

/** Bot data after recording `time` for every trigger in `matched`. */
export const recordCooldownTriggers = (
  data: LastCloses,
  matched: ConditionalCooldownTrigger[],
  time: number,
  symbol: string,
): Required<
  Pick<
    LastCloses,
    'lastClosedDealByTrigger' | 'lastClosedDealByTriggerPerSymbol'
  >
> => {
  const byTrigger = { ...(data.lastClosedDealByTrigger ?? {}) }
  const perSymbol = [...(data.lastClosedDealByTriggerPerSymbol ?? [])]
  if (!matched.length) {
    return {
      lastClosedDealByTrigger: byTrigger,
      lastClosedDealByTriggerPerSymbol: perSymbol,
    }
  }
  const index = perSymbol.findIndex((d) => d.symbol === symbol)
  const entry = { ...(index >= 0 ? perSymbol[index] : {}), symbol }
  for (const trigger of matched) {
    byTrigger[trigger] = time
    entry[trigger] = time
  }
  if (index >= 0) {
    perSymbol[index] = entry
  } else {
    perSymbol.push(entry)
  }
  return {
    lastClosedDealByTrigger: byTrigger,
    lastClosedDealByTriggerPerSymbol: perSymbol,
  }
}

/** The close time the cooldown after deal stop is measured from. */
export const lastCloseForCooldown = (
  data: LastCloses | null | undefined,
  trigger: CooldownStopTriggerEnum | undefined,
  scope: CooldownOptionsEnum,
  symbol: string,
): number => {
  const conditional =
    trigger === CooldownStopTriggerEnum.sl ||
    trigger === CooldownStopTriggerEnum.loss
  if (scope === CooldownOptionsEnum.bot) {
    return (
      (conditional
        ? data?.lastClosedDealByTrigger?.[trigger]
        : data?.lastClosedDeal) ?? 0
    )
  }
  return (
    (conditional
      ? data?.lastClosedDealByTriggerPerSymbol?.find(
          (d) => d.symbol === symbol,
        )?.[trigger]
      : data?.lastClosedDealPerSymbol?.find((d) => d.symbol === symbol)
          ?.time) ?? 0
  )
}
