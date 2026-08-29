/**
 * v2 REST support for hedge bots (`hedgeCombo` / `hedgeDca`).
 *
 * A hedge bot is a wrapper document in its own collection holding two child
 * bots — one long, one short — so it cannot reuse the dca/combo/grid handlers:
 * different collection, the legs have to be populated, and several of the
 * wrapper's own fields are permanently stale (see `hedgeAggregate.ts`).
 *
 * Everything here reads through the same conversion the GraphQL path uses
 * (`convertHedgeComboBotToArray` / `convertComboBotToArray`), so a hedge bot
 * looks the same over REST as it does in the dashboard — Mongo `Map` fields
 * become `{ key, value }` arrays instead of serialising to `{}`.
 */

import { BotType, StrategyEnum, StatusEnum } from '../../../types'
import type {
  ComboBotSettings,
  CreateComboBotInput,
  DCABotSettings,
  HedgeBotSchema,
  HedgeBotSettings,
} from '../../../types'
import { hedgeComboBotDb, hedgeDCABotDb } from '../../db/dbInit'
import {
  convertHedgeComboBotToArray,
  convertComboBotToArray,
  checkDCABotSettings,
} from '../../bot/utils'
import { aggregateHedgeLegs } from '../../bot/hedgeAggregate'

/** Bot types handled by this module, as they appear in the `:botType` path segment. */
export const HEDGE_BOT_TYPES = [BotType.hedgeCombo, BotType.hedgeDca] as const

export type HedgeBotType = (typeof HEDGE_BOT_TYPES)[number]

export const isHedgeBotType = (botType: string): botType is HedgeBotType =>
  (HEDGE_BOT_TYPES as readonly string[]).includes(botType)

export const hedgeDbFor = (botType: HedgeBotType) =>
  botType === BotType.hedgeCombo ? hedgeComboBotDb : hedgeDCABotDb

/**
 * Every bot type the v2 bot routes accept, in the order they should be listed
 * back to a caller that got it wrong.
 */
export const ALL_BOT_TYPES = [
  BotType.dca,
  BotType.combo,
  BotType.grid,
  BotType.hedgeCombo,
  BotType.hedgeDca,
] as const

export const invalidBotTypeResponse = (allowed: readonly string[]) => ({
  status: StatusEnum.notok,
  reason: `Invalid bot type. Must be one of: ${allowed.join(', ')}`,
  data: null,
})

const legOf = (bots: any[] | undefined, strategy: StrategyEnum) =>
  bots?.find((b) => b?.settings?.strategy === strategy)

/**
 * Turn a populated hedge bot document into the v2 response shape.
 *
 * On top of the stored document it adds the figures the wrapper does not
 * maintain — `name`, `profit`, `profitByAssets`, `profitToday`,
 * `unrealizedProfit`, `workingTimeNumber`, `dealsInBot` — all derived from the
 * two legs, plus a `profitBasis` telling the caller how far to trust the
 * native-unit numbers. The stored (always-zero) `profit` is REPLACED, not
 * shadowed: returning it as-is is what would make every hedge bot look flat.
 */
export const serializeHedgeBot = (doc: HedgeBotSchema) => {
  const converted = convertHedgeComboBotToArray(doc as any)
  const rawLegs = (doc.bots ?? []) as any[]
  const rawLong = legOf(rawLegs, StrategyEnum.long)
  const rawShort = legOf(rawLegs, StrategyEnum.short)

  const aggregate = aggregateHedgeLegs(rawLong, rawShort)

  // The legs are populated documents, so they need the same Map -> array
  // conversion the wrapper gets. An unpopulated leg is a bare ObjectId (the
  // caller asked for a projection that dropped the join) — pass those through.
  const bots = rawLegs.map((leg) =>
    leg && typeof leg === 'object' && leg.settings
      ? { ...convertComboBotToArray(leg), dealsInBot: leg.deals }
      : leg,
  )

  return {
    ...converted,
    bots,
    // Mirrors how the dashboard titles a hedge bot: the wrapper has no name of
    // its own, so it borrows the long leg's (see `HedgeBotCard`).
    name: rawLong?.settings?.name || rawShort?.settings?.name || 'Hedge bot',
    profit: aggregate.profit,
    profitByAssets: aggregate.profitByAssets,
    profitToday: aggregate.profitToday,
    unrealizedProfit: aggregate.unrealizedProfit,
    workingTimeNumber: aggregate.workingTimeNumber,
    dealsInBot: aggregate.dealsInBot,
    profitBasis: {
      native: aggregate.nativeBasis,
      quoteAssets: aggregate.quoteAssets,
    },
  }
}

/** The only keys a hedge clone body may carry. */
const HEDGE_CLONE_BODY_KEYS = ['long', 'short', 'sharedSettings'] as const

type HedgeCloneBody = {
  long?: Partial<DCABotSettings | ComboBotSettings> & { pair?: string[] }
  short?: Partial<DCABotSettings | ComboBotSettings> & { pair?: string[] }
  sharedSettings?: Partial<HedgeBotSettings>
}

type CloneFailure = { ok: false; code: number; reason: string }
type CloneSuccess = { ok: true; botId: string }

/**
 * Clone a hedge bot.
 *
 * Unlike the dca/combo/grid clone this cannot merge a single flat settings
 * object: a hedge bot is two independent child bots, each with its own pair,
 * exchange and settings, plus the wrapper's `sharedSettings`. The body is
 * therefore `{ long?, short?, sharedSettings? }`, and each leg's overrides are
 * validated and applied against THAT leg's stored settings.
 *
 * Creation goes through `Bot.createHedgeComboBot` / `Bot.createHedgeDcaBot` —
 * the same call the dashboard's create mutation makes — so per-leg cost, the
 * parent cost rollup, the `parentBotId` back-link and the externalTp/externalSl
 * flag derivation all happen exactly as they do for a hand-built hedge bot.
 */
export const cloneHedgeBot = async (args: {
  Bot: any
  botType: HedgeBotType
  botId: string
  userId: string
  paperContext: boolean
  body: HedgeCloneBody | undefined
}): Promise<CloneFailure | CloneSuccess> => {
  const { Bot, botType, botId, userId, paperContext, body } = args
  const overrides = body ?? {}

  const unknownKeys = Object.keys(overrides).filter(
    (k) => !(HEDGE_CLONE_BODY_KEYS as readonly string[]).includes(k),
  )
  if (unknownKeys.length) {
    return {
      ok: false,
      code: 400,
      reason:
        `Unexpected key(s) in hedge clone body: ${unknownKeys.join(', ')}. ` +
        `A hedge bot has two legs, so overrides are per leg: ` +
        `{ "long": { ... }, "short": { ... }, "sharedSettings": { ... } }.`,
    }
  }

  const existing = await hedgeDbFor(botType).readData(
    {
      _id: botId,
      userId,
      paperContext: paperContext ? { $eq: true } : { $ne: true },
      isDeleted: { $ne: true },
    },
    undefined,
    { populate: 'bots' },
    false,
    false,
  )

  if (existing.status === StatusEnum.notok || !existing.data?.result) {
    return { ok: false, code: 404, reason: `${botType} bot not found` }
  }

  const source = existing.data.result as HedgeBotSchema
  const legs = (source.bots ?? []) as any[]
  const long = legOf(legs, StrategyEnum.long)
  const short = legOf(legs, StrategyEnum.short)

  // Match the legs by their own `strategy`, never by position in `bots`: the
  // array happens to be written [long, short] at creation, but every other
  // reader in the codebase resolves them by strategy and a half-repaired bot
  // would silently clone inverted.
  if (!long || !short) {
    return {
      ok: false,
      code: 400,
      reason:
        'Hedge bot is missing a long or short leg and cannot be cloned. ' +
        'Both legs must be present.',
    }
  }

  const isCombo = botType === BotType.hedgeCombo

  const buildLeg = async (
    leg: any,
    override: HedgeCloneBody['long'],
    label: 'long' | 'short',
  ): Promise<CloneFailure | { ok: true; input: CreateComboBotInput }> => {
    const { pair: _pair, ...rest } = override ?? {}

    if (Object.keys(rest).length > 0) {
      const check = checkDCABotSettings(leg.settings, rest as any, isCombo)
      if (check.status === StatusEnum.notok) {
        return {
          ok: false,
          code: 400,
          reason: `${label} leg: ${(check as { reason: string }).reason}`,
        }
      }
    }

    let pair = _pair
    if (pair?.length) {
      const pairsValidation = await Bot.checkPairs(leg.exchange, pair)
      if (pairsValidation.status === StatusEnum.notok) {
        return {
          ok: false,
          code: 400,
          reason: `${label} leg: invalid pair: ${pair}`,
        }
      }
      pair = (pairsValidation.data?.map((p: { pair: string }) => p.pair) ??
        []) as string[]
    }

    const combinedSettings: Record<string, any> = {
      ...leg.settings,
      ...(override ?? {}),
      pair: pair?.length ? pair : leg.settings.pair,
    }

    if (leg.settings?.name && !override?.name) {
      combinedSettings.name = `${leg.settings.name} (clone)`
    }

    // A leg's `strategy` is what makes it the long or the short side; letting
    // an override flip it would produce a hedge bot with two same-side legs
    // that `getHedgeComboBotFromDb` can then never resolve.
    combinedSettings.strategy =
      label === 'long' ? StrategyEnum.long : StrategyEnum.short

    delete combinedSettings._id
    delete combinedSettings.vars

    // Drop any bot-variable binding whose path the caller has just overridden
    // with a literal — same rule the dca/combo clone applies.
    const vars = leg.vars
      ? {
          ...leg.vars,
          paths: (leg.vars.paths ?? []).filter(
            (pth: { path: string }) => !(pth.path in rest),
          ),
        }
      : leg.vars
    if (vars) {
      const kept = vars.paths.map((pth: { variable: string }) => pth.variable)
      vars.list = (vars.list ?? []).filter((l: string) => kept.includes(l))
    }

    return {
      ok: true,
      input: {
        ...Bot.removeNullableValuesFromSettings(combinedSettings),
        exchange: leg.exchange,
        exchangeUUID: leg.exchangeUUID,
        vars,
      } as CreateComboBotInput,
    }
  }

  const longLeg = await buildLeg(long, overrides.long, 'long')
  if (!longLeg.ok) {
    return longLeg
  }
  const shortLeg = await buildLeg(short, overrides.short, 'short')
  if (!shortLeg.ok) {
    return shortLeg
  }

  const sharedSettings = {
    ...(source.sharedSettings ?? {}),
    ...(overrides.sharedSettings ?? {}),
  } as HedgeBotSettings

  const result = isCombo
    ? await Bot.createHedgeComboBot(
        userId,
        { long: longLeg.input, short: shortLeg.input, sharedSettings },
        paperContext,
      )
    : await Bot.createHedgeDcaBot(
        userId,
        { long: longLeg.input, short: shortLeg.input, sharedSettings },
        paperContext,
      )

  if (result.status === StatusEnum.notok) {
    return {
      ok: false,
      code: 400,
      reason: result.reason || `Failed to clone ${botType} bot`,
    }
  }
  if (!result.data?._id) {
    return {
      ok: false,
      code: 500,
      reason: 'Failed to retrieve cloned bot ID',
    }
  }

  return { ok: true, botId: `${result.data._id}` }
}
