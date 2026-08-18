import type { Response } from 'express'
import {
  StatusEnum,
  UserSchema,
  BotVars,
  CreateDCABotInput,
  ExchangeInUser,
  BotSettings,
  StrategyEnum,
} from '../../../types'
import { globalVarsDb } from '../../db/dbInit'
import DB from '../../db'
import ExchangeChooser from '../../exchange/exchangeChooser'
import { RetryBackoff, type BackoffCheck } from '../../bot/retryBackoff'
import logger from '../../utils/logger'
import { isFutures, isCoinm, isPaper } from '../../utils'
import { indicatorConfigDefaults } from './botDefaults'
import { Types } from 'mongoose'
import { CreateDCABotInputRaw, CreateGridBotInputRaw } from './api'
/**
 * Circuit breaker for a caller that keeps asking for a terminal deal we keep
 * refusing.
 *
 * A 400 fixes the honesty problem — the caller is finally told why — but it
 * does not fix an automation that ignores the answer and re-sends every fifteen
 * seconds. Each attempt still costs a position read on the way to the same
 * refusal: against a real connection that is a credentialed venue call out of
 * the same rate-limit budget as trading, and against a paper one a round trip
 * to paper-trading. The second is cheap; neither is worth paying repeatedly for
 * an answer we already have.
 *
 * So: after a few CONSECUTIVE refusals of the same constraint, stop paying for
 * the check and replay the refusal from Redis instead, with a Retry-After the
 * caller can honour. The window widens per refusal and expires on its own, so
 * the attempt after it lands like any other — a user who closes the position
 * gets their next deal through with no intervention.
 *
 * Fed ONLY by refusals this endpoint decides itself. It is deliberately not fed
 * by the engine's asynchronous start failures: some of those are ours (a
 * transient exchange-info miss, a connector blip), and a breaker that blocks
 * trading on the strength of a platform hiccup is a worse failure than the
 * noise it was built to stop.
 */
export const terminalDealGuard = new RetryBackoff({
  namespace: 'td',
  minMs: 60 * 1000,
  // Capped well below the sibling cooldowns: this one refuses a trade, so the
  // cost of holding it open too long is the user's, not ours.
  maxMs: 15 * 60 * 1000,
})

/**
 * Consecutive refusals tolerated before the breaker starts answering for the
 * endpoint. Above one, so a caller who reacts to the first 400 — reads it,
 * fixes the position, retries — never meets the breaker at all.
 */
export const TERMINAL_DEAL_GUARD_THRESHOLD = 3

/** The breaker answers only once the same constraint has been refused repeatedly. */
export const isTerminalDealGuardOpen = (
  cooldown: BackoffCheck,
): cooldown is Extract<BackoffCheck, { suppressed: true }> =>
  cooldown.suppressed && cooldown.attempt >= TERMINAL_DEAL_GUARD_THRESHOLD

/**
 * What the breaker is counting: this user, this connection, this symbol, this
 * kind of refusal. Not the deal — two identical deals are the same constraint,
 * and a different symbol is a different question that deserves its own answer.
 */
export const terminalDealGuardKey = (
  userId: string,
  exchangeUUID: string,
  symbol: string,
  kind: string,
): string[] => [userId, exchangeUUID, symbol, kind]

/**
 * The direction a bot will open. The engine consults `futuresStrategy` first
 * and falls back to `strategy` (core/src/bot/main.ts, `check positions`); a
 * terminal deal is a DCA bot, which carries no `futuresStrategy`, so the
 * fallback is the whole rule here.
 */
const requiredPositionSide = (settings: CreateDCABotInput): 'LONG' | 'SHORT' =>
  settings.strategy === StrategyEnum.long ? 'LONG' : 'SHORT'

/**
 * Pre-flight for the engine's "existing position" rule.
 *
 * A futures bot refuses to start when a position is already open on the symbol
 * in the opposite direction — see `loadData` → `check positions` in
 * `core/src/bot/main.ts`. That refusal happens inside the bot worker, well
 * after the HTTP request has answered. For a bot the caller already owns that
 * is tolerable: the bot persists, and the refusal shows up as a message on it.
 *
 * For a terminal deal it is not. The request itself is what creates the bot, so
 * a caller who is told the deal was created has no object to watch and no way
 * to learn it was dropped a few milliseconds later — and the abandoned bot is
 * left behind, closed and dealless, for every attempt.
 *
 * So ask the same question before creating anything, and let the caller have
 * the answer as a 400. Deliberately conservative — it reports only a conflict
 * it is certain of, and anything it cannot establish (positions unreadable, a
 * symbol it cannot line up, a hedge account that may legitimately hold both
 * sides) falls through to the engine's own check, which is the behaviour that
 * exists today.
 *
 * @returns the reason to reject with, or null to proceed
 */
export const findConflictingFuturesPosition = async (
  exchange: ExchangeInUser,
  settings: CreateDCABotInput,
  ec = ExchangeChooser,
): Promise<string | null> => {
  // No paper exclusion, because the engine has none for this check: the side
  // rule fires for `botType === dca` outright, and a terminal deal is a DCA bot.
  // `paperExchanges` guards only the margin-type rule and the grid branch. A
  // paper connection that is refused by the engine must be refused here too, or
  // the pre-check silently does nothing for exactly the accounts most likely to
  // be driven by an automation on a loop.
  if (!settings.futures || exchange.hedge) {
    return null
  }
  const requiredSide = requiredPositionSide(settings)
  // Terminal deals are single-pair. Taking the first entry keeps the symbol
  // identical to the one the engine checks, so the two cannot disagree about
  // formatting — and a symbol that does not line up simply finds no position.
  const symbol = [settings.pair].flat()[0]
  if (!symbol) {
    return null
  }
  try {
    const factory = ec.chooseExchangeFactory(exchange.provider)
    if (!factory) {
      return null
    }
    const provider = factory(
      exchange.key,
      exchange.secret,
      exchange.passphrase,
      undefined,
      exchange.keysType,
      exchange.okxSource,
      exchange.bybitHost,
    )
    const positions = await provider.futures_getPositions(symbol)
    if (positions.status !== StatusEnum.ok) {
      return null
    }
    const conflict = positions.data.find((p) => {
      if (p.symbol !== symbol || +p.positionAmt === 0) {
        return false
      }
      const side =
        p.positionSide === 'BOTH'
          ? +p.positionAmt > 0
            ? 'LONG'
            : 'SHORT'
          : p.positionSide
      return side !== requiredSide
    })
    if (!conflict) {
      return null
    }
    const side =
      conflict.positionSide === 'BOTH'
        ? +conflict.positionAmt > 0
          ? 'LONG'
          : 'SHORT'
        : conflict.positionSide
    // Same wording the engine uses for the same condition, so a caller who has
    // seen one of these in their bot messages recognises the other.
    return `Cannot start when existing position not met bot settings. Side in active position is ${side}, but bot will open ${requiredSide}. Symbol: ${symbol}`
  } catch (e) {
    logger.warn(
      `findConflictingFuturesPosition | ${exchange.provider} ${symbol} | ${
        (e as Error)?.message ?? e
      }`,
    )
    return null
  }
}

/**
 * Common validation helper for bot creation
 * Validates exchangeUUID, fetches user data, finds exchange, and verifies paper/real context
 */
export const validateBotCreationContext = async <
  R extends UserSchema = UserSchema,
>(
  input: CreateDCABotInputRaw,
  userId: string,
  userDb: DB<R>,
  res: Response,
  paperContext: boolean = false,
): Promise<
  | { valid: false }
  | { valid: true; userData: any; exchange: any; paperContext: boolean }
> => {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input === null
  ) {
    res.status(400).json({
      status: StatusEnum.notok,
      reason: 'Invalid input: expected non-empty object',
    })
    return { valid: false }
  }
  try {
    if (JSON.stringify(input) === '{}') {
      res.status(400).json({
        status: StatusEnum.notok,
        reason: 'Input cannot be an empty object',
      })
    }
  } catch {
    res.status(400).json({
      status: StatusEnum.notok,
      reason: 'Invalid input format',
    })
  }

  // 1. Validate exchangeUUID is provided FIRST
  if (!input.exchangeUUID) {
    res.status(400).json({
      status: StatusEnum.notok,
      reason: 'exchangeUUID is required',
    })
    return { valid: false }
  }

  // 2. Get user document
  const userResult = await userDb.readData({ _id: userId })
  if (userResult.status !== StatusEnum.ok || !userResult.data?.result) {
    res.status(500).json({
      status: StatusEnum.notok,
      reason: 'Failed to fetch user data',
    })
    return { valid: false }
  }

  const userData = userResult.data.result

  // 3. Find exchange in user's exchanges
  const exchange = userData.exchanges?.find(
    (ex: any) => ex.uuid === input.exchangeUUID,
  )

  if (!exchange) {
    res.status(400).json({
      status: StatusEnum.notok,
      reason: 'Exchange not found',
    })
    return { valid: false }
  }

  // 4. Verify exchange matches paper/real context
  const isExchangePaper = isPaper(exchange.provider)
  if (isExchangePaper !== paperContext) {
    res.status(400).json({
      status: StatusEnum.notok,
      reason: paperContext
        ? 'Exchange is not a paper trading exchange'
        : 'Exchange is a paper trading exchange, use paper context',
    })
    return { valid: false }
  }

  return { valid: true, userData, exchange, paperContext }
}

export const replaceVarsInInput = async <T extends CreateDCABotInput>(
  input: T,
  userId: string,
): Promise<T> => {
  try {
    if (input.vars?.paths.length) {
      const readVars = await globalVarsDb.readData(
        {
          userId,
          _id: {
            $in: input.vars.list.map((p) => {
              try {
                return new Types.ObjectId(p)
              } catch {
                return null
              }
            }),
          },
        },
        { name: 1, value: 1 },
        {},
        true,
      )
      if (readVars.status === StatusEnum.ok && readVars.data?.result) {
        for (const path of input.vars.paths) {
          const found = readVars.data.result.find(
            (v) => v._id.toString() === path.variable,
          )
          if (found) {
            if (path.path in input) {
              ;(input as any)[path.path] = found.value
            }
            const split = path.path.split('.')
            if (split.length === 3) {
              const [parent, uuid, subChild] = split
              if (parent in input) {
                ;(input as any)[parent] = (input as any)[parent].map(
                  (c: any) => {
                    if (c.uuid === uuid && subChild in c) {
                      return {
                        ...c,
                        [subChild]: found.value,
                      }
                    }
                    return c
                  },
                )
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore errors related to vars fetching/parsing, we will validate vars properly in the validator function
  }
  return input
}

export const addAditionalFields = (
  input: CreateDCABotInputRaw | CreateGridBotInputRaw,
  exchange: ExchangeInUser,
  terminal = false,
) => {
  return {
    futures: isFutures(exchange.provider),
    coinm: isCoinm(exchange.provider),
    exchange: exchange.provider,
    exchangeUUID: exchange.uuid,
    vars: terminal
      ? { list: [], paths: [] }
      : (input.vars || []).reduce(
          (acc, { path, variable }) => {
            if (!acc.list.includes(variable)) {
              acc.list.push(variable)
            }
            acc.paths.push({ path, variable })
            return acc
          },
          {
            list: [],
            paths: [],
          } as BotVars,
        ),
  }
}

export const applyGridFuturesConstraints = <T extends Partial<BotSettings>>(
  settings: T,
): T => {
  if (!settings.futures) return settings
  return {
    ...settings,
    profitCurrency: 'quote',
    orderFixedIn: settings.coinm ? 'quote' : 'base',
  }
}

export const addIndicatorsDefaults = <T extends Partial<CreateDCABotInput>>(
  settings: T,
): T => {
  if (settings?.indicators?.length) {
    settings.indicators = settings?.indicators?.map((indicator) => ({
      ...(indicatorConfigDefaults[indicator.type] ?? {}),
      ...indicator,
    }))
  }
  return settings
}

export const sortFields = <T extends Record<string, any>>(obj: T): T => {
  const sortedObj: Record<string, any> = {}
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      if (
        typeof obj[key] === 'object' &&
        obj[key] !== null &&
        !Array.isArray(obj[key])
      ) {
        sortedObj[key] = sortFields(obj[key])
      }
      if (Array.isArray(obj[key])) {
        sortedObj[key] = obj[key].map((item: any) => {
          if (typeof item === 'object' && item !== null) {
            return sortFields(item)
          }
          return item
        })
      }
      sortedObj[key] = obj[key]
    })
  return sortedObj as T
}
