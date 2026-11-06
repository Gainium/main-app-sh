import logger from '../utils/logger'
import ExchangeChooser from '../exchange/exchangeChooser'
import {
  botDb,
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  userDb,
} from '../db/dbInit'
import {
  BaseReturn,
  BotStatusEnum,
  CommonOrder,
  DCABotSchema,
  DCADealStatusEnum,
  ExchangeInUser,
  StatusEnum,
} from '../../types'
import { loadConfig, LOG_PREFIX, RestingOrder } from './types'
import { Registry } from './registry'
import { Types } from 'mongoose'

/**
 * L2 exchange-confirm (spec §3.2). Fetches order status through the SAME
 * machinery bots use: resolve the account on the user doc (creds stay encrypted),
 * build the core exchange client via `ExchangeChooser.chooseExchangeFactory`,
 * and call `getOrder`. This is the exact credential path used by the bot engine
 * (`core/src/bot/main.ts:getExchangeData` → `setExchangeCredentials`) — we never
 * roll our own crypto.
 *
 * Paper accounts route automatically: `chooseExchangeFactory` returns the
 * PaperExchange (→ PAPER_TRADING_API_URL); live returns Exchange (→ the balancer
 * at EXCHANGE_SERVICE_API_URL). No per-context branching here.
 *
 * The returned envelope carries a best-effort `usageRatio` for the load-control
 * usage-backoff (§7.2 (3)); it is 0 when the exchange layer doesn't surface one.
 */

export interface ConfirmResult {
  clientOrderId: string
  order: CommonOrder | null
  ok: boolean
  usageRatio: number
}

/** Cache resolved accounts (encrypted creds) per exchangeUUID for a confirm cycle. */
export type AccountRec = {
  provider: ExchangeInUser['provider']
  key: string
  secret: string
  passphrase: string
  keysType?: ExchangeInUser['keysType']
  okxSource?: ExchangeInUser['okxSource']
  bybitHost?: ExchangeInUser['bybitHost']
  subaccount?: boolean
  /**
   * The connection's stored verification verdict, carried through so a
   * background reader can skip a call the platform already knows is refused.
   * `false` is an affirmative "the venue said these credentials are bad" —
   * `core/src/exchange/verify.ts` keeps the stored value when the venue was
   * merely unreachable. Absent means "never verified", NOT "healthy".
   */
  status?: boolean
}

/**
 * Resolve an account's stored credentials for a userId/exchangeUUID.
 * Credentials stay ENCRYPTED here — AbstractExchange's constructor decrypts
 * them itself (core/src/exchange/index.ts:124). Decrypting before the factory
 * double-decrypts and yields an empty key.
 */
export async function resolveAccount(
  userId: string,
  exchangeUUID: string,
): Promise<AccountRec | null> {
  const res = await userDb.readData({ _id: userId }, { exchanges: 1 })
  if (res.status !== StatusEnum.ok || !res.data?.result) return null
  const exchanges = (res.data.result.exchanges ?? []) as ExchangeInUser[]
  const acct = exchanges.find((e) => e.uuid === exchangeUUID)
  if (!acct) return null
  return {
    provider: acct.provider,
    key: acct.key,
    secret: acct.secret,
    passphrase: acct.passphrase ?? '',
    keysType: acct.keysType,
    okxSource: acct.okxSource,
    bybitHost: acct.bybitHost,
    subaccount: acct.subaccount,
    status: acct.status,
  }
}

/** Best-effort usage ratio out of a BaseReturn/exchange envelope (0 when absent). */
function usageRatioOf(res: unknown): number {
  const tp = (res as { timeProfile?: { usage?: { relative?: number } } })
    ?.timeProfile
  const rel = tp?.usage?.relative
  return typeof rel === 'number' && Number.isFinite(rel) ? rel : 0
}

/**
 * Build the exchange client for an account. Uses the account's stored `provider`
 * (a paper provider stays paper so routing is correct), NOT the registry's
 * realExchange.
 */
export function buildClient(acct: AccountRec) {
  const factory = ExchangeChooser.chooseExchangeFactory(acct.provider)
  return factory(
    acct.key,
    acct.secret,
    acct.passphrase,
    undefined,
    acct.keysType,
    acct.okxSource,
    acct.bybitHost,
    acct.subaccount,
  )
}

/** Confirm one order via `getOrder({symbol, newClientOrderId})`. */
export async function confirmOne(order: RestingOrder): Promise<ConfirmResult> {
  const base: ConfirmResult = {
    clientOrderId: order.clientOrderId,
    order: null,
    ok: false,
    usageRatio: 0,
  }
  try {
    const acct = await resolveAccount(order.userId, order.exchangeUUID)
    if (!acct) {
      logger.warn(
        `${LOG_PREFIX} confirm: no account for uuid ${order.exchangeUUID}`,
      )
      return base
    }
    const client = buildClient(acct)
    const res = (await client.getOrder({
      symbol: order.symbol,
      newClientOrderId: order.clientOrderId,
    })) as BaseReturn<CommonOrder>
    return {
      clientOrderId: order.clientOrderId,
      order: res.status === StatusEnum.ok ? res.data : null,
      ok: res.status === StatusEnum.ok,
      usageRatio: usageRatioOf(res),
    }
  } catch (e) {
    logger.error(`${LOG_PREFIX} confirm error ${order.clientOrderId}: ${e}`)
    return base
  }
}

/**
 * Confirm many orders on one account with a single symbol-scoped
 * `getAllOpenOrders` list call (spec §3.2 list strategy). An order absent from
 * the open-orders list is no longer resting on the exchange (filled/canceled) —
 * we return `order: null, ok: true` for it so the divergence check treats it as
 * "no longer NEW". Orders still present come back with their live state.
 */
export async function confirmList(
  registry: Registry,
  orders: RestingOrder[],
): Promise<RestingOrder[]> {
  if (orders.length === 0) return []
  const config = loadConfig()
  await new Promise((res) => setTimeout(res, config.confirmCoalesceMs / 2))
  const ids = orders.map((o) => o.clientOrderId)
  const batches = ids.reduce((acc, id, i) => {
    const index = Math.floor(i / 500)
    if (!acc[index]) {
      acc[index] = []
    }
    acc[index].push(id)
    return acc
  }, [] as string[][])
  const result: (RestingOrder & { dealId?: string; botId: string })[] = []
  for (const b of batches) {
    const ordersResponse = await registry.getOrdersFromDb(b)
    if (ordersResponse.status !== StatusEnum.ok) {
      logger.error(
        `${LOG_PREFIX} registry get orders failed: ${ordersResponse.reason}`,
      )
      continue
    }
    result.push(...ordersResponse.data)
  }
  const dealIds: Set<string> = new Set()
  const botIds: Set<string> = new Set()
  const closedDeals: Set<string> = new Set()
  const closedBots: Set<string> = new Set()

  for (const r of result) {
    if (r.dealId) {
      dealIds.add(r.dealId)
    }
    botIds.add(r.botId)
  }

  await Promise.all(
    [dcaDealsDb, comboDealsDb].map(async (db) => {
      const data = await (db as typeof dcaDealsDb).readData<{
        status: DCADealStatusEnum
      }>(
        {
          _id: { $in: [...dealIds.values()].map((v) => new Types.ObjectId(v)) },
        },
        { status: 1, _id: 1 },
        {},
        true,
      )
      data.data?.result.map((r) =>
        [DCADealStatusEnum.canceled, DCADealStatusEnum.closed].includes(
          r.status,
        )
          ? closedDeals.add(`${r._id}`)
          : null,
      )
    }),
  )

  await Promise.all(
    [dcaBotDb, comboBotDb, botDb].map(async (db) => {
      const data = await (db as typeof botDb).readData<
        | {
            status: BotStatusEnum
            deals: DCABotSchema['deals']
          }
        | {
            status: BotStatusEnum
          }
      >(
        {
          _id: { $in: [...botIds.values()].map((v) => new Types.ObjectId(v)) },
        },
        { status: 1, deals: 1, _id: 1 },
        {},
        true,
      )
      data.data?.result.map((r) =>
        [BotStatusEnum.archive, BotStatusEnum.closed].includes(r.status) &&
        ('deals' in r ? r.deals.active === 0 : true)
          ? closedBots.add(`${r._id}`)
          : null,
      )
    }),
  )

  return result.filter(
    (r) =>
      !closedBots.has(r.botId) &&
      (r.dealId ? !closedDeals.has(r.dealId) : true),
  )
  /* const first = orders[0]
  try {
    const acct = await resolveAccount(first.userId, first.exchangeUUID)
    if (!acct) {
      return orders.map((o) => ({
        clientOrderId: o.clientOrderId,
        order: null,
        ok: false,
        usageRatio: 0,
      }))
    }
    const client = buildClient(acct)
    const res = (await client.getAllOpenOrders(undefined, true)) as BaseReturn<
      CommonOrder[]
    >
    const usageRatio = usageRatioOf(res)
    if (res.status !== StatusEnum.ok) {
      return orders.map((o) => ({
        clientOrderId: o.clientOrderId,
        order: null,
        ok: false,
        usageRatio,
      }))
    }
    const open = new Map<string, CommonOrder>()
    for (const co of res.data) open.set(co.clientOrderId, co)
    return orders.map((o) => ({
      clientOrderId: o.clientOrderId,
      // Present => live state; absent => no longer open on the exchange.
      order: open.get(o.clientOrderId) ?? null,
      ok: true,
      usageRatio,
    }))
  } catch (e) {
    logger.error(`${LOG_PREFIX} confirmList error ${first.exchangeUUID}: ${e}`)
    return orders.map((o) => ({
      clientOrderId: o.clientOrderId,
      order: null,
      ok: false,
      usageRatio: 0,
    }))
  } */
}
