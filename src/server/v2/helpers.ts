import type { Response } from 'express'
import {
  StatusEnum,
  UserSchema,
  BotVars,
  CreateDCABotInput,
  ExchangeInUser,
  BotSettings,
} from '../../../types'
import { globalVarsDb } from '../../db/dbInit'
import DB from '../../db'
import { isFutures, isCoinm, isPaper } from '../../utils'
import { indicatorConfigDefaults } from './botDefaults'
import { Types } from 'mongoose'
import { CreateDCABotInputRaw, CreateGridBotInputRaw } from './api'
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
