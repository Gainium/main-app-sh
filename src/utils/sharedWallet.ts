import { ExchangeEnum } from '../../types'
import {
  connectionMatches,
  resolveConnection,
  type StoredConnection,
} from './credentials'

/**
 * Unified accounts: one wallet behind several per-market connections.
 *
 * A user connects one API key as up to three legs (spot / USDT-M / COIN-M).
 * On a unified account every leg's `/balance` is the SAME wallet, so storing
 * each leg's answer under its own uuid counts the money once per leg — the
 * portfolio showed a Hyperliquid unified wallet twice and a Bitget UTA three
 * times. Bybit and OKX legs are `linkedTo` their spot leg when they are added;
 * a linked leg is never refreshed and reads the source's rows. This module
 * does the same for the families whose accounts can switch mode after they
 * were connected, so the link is re-derived from the venue instead of being
 * decided once at add time:
 *
 * - Hyperliquid — `userAbstraction` unifiedAccount / portfolioMargin.
 * - Bitget — Unified Trading Account.
 *
 * Classic accounts keep a separate wallet per product line and are unlinked.
 */
export const SHARED_WALLET_FAMILIES: ExchangeEnum[][] = [
  [ExchangeEnum.hyperliquid, ExchangeEnum.hyperliquidLinear],
  [ExchangeEnum.bitget, ExchangeEnum.bitgetUsdm, ExchangeEnum.bitgetCoinm],
]

const familyOf = (provider: string) =>
  SHARED_WALLET_FAMILIES.findIndex((f) => f.includes(provider as ExchangeEnum))

export const isSharedWalletProvider = (provider: string) =>
  familyOf(provider) !== -1

type Leg = StoredConnection & {
  uuid: string
  provider: string
  linkedTo?: string | null
}

export type SharedKeyGroup<T extends Leg> = {
  /** The leg the wallet is stored under: the spot leg when there is one. */
  source: T
  /** The other legs on the same key. */
  others: T[]
}

/**
 * Whether two legs of one family are the same venue account. On Hyperliquid
 * the key IS the wallet address and the secret is only an API agent, so legs
 * added with different agents — or the address in a different case — are
 * still one wallet. Elsewhere the API key identifies the account.
 */
const sameAccount = async (
  provider: string,
  leg: { key: string; secret: string },
  other: Leg,
) => {
  if (provider.startsWith('hyperliquid')) {
    const { key } = await resolveConnection(other)
    return !!key && key.toLowerCase() === leg.key.toLowerCase()
  }
  return connectionMatches(other, leg)
}

/**
 * The user's legs of one family on the same venue account (see
 * `sameAccount`), as groups of two or more. Compares decrypted credentials,
 * so it only unwraps legs of the shared-wallet families.
 */
export const groupSharedKeyLegs = async <T extends Leg>(
  exchanges: readonly T[],
): Promise<SharedKeyGroup<T>[]> => {
  const groups: SharedKeyGroup<T>[] = []
  const taken = new Set<string>()
  const legs = exchanges.filter((e) => isSharedWalletProvider(e.provider))
  for (const leg of legs) {
    if (taken.has(leg.uuid)) continue
    taken.add(leg.uuid)
    const members = [leg]
    const candidates = legs.filter(
      (o) =>
        !taken.has(o.uuid) && familyOf(o.provider) === familyOf(leg.provider),
    )
    if (!candidates.length) continue
    const { key, secret } = await resolveConnection(leg)
    for (const other of candidates) {
      if (await sameAccount(leg.provider, { key, secret }, other)) {
        taken.add(other.uuid)
        members.push(other)
      }
    }
    if (members.length < 2) continue
    const family = SHARED_WALLET_FAMILIES[familyOf(leg.provider)]
    const uuids = new Set(members.map((m) => m.uuid))
    const source =
      members.find((m) => m.provider === family[0]) ??
      members.find((m) => members.some((o) => o.linkedTo === m.uuid)) ??
      members.find((m) => !m.linkedTo || !uuids.has(m.linkedTo)) ??
      members[0]
    groups.push({ source, others: members.filter((m) => m !== source) })
  }
  return groups
}

export type LinkPlan = {
  link: { uuid: string; to: string }[]
  unlink: string[]
}

/**
 * What to change for one group given the venue's answer about the source
 * key. `null` (undetermined) changes nothing: a failed lookup must never
 * split a unified wallet back into double-counted legs, nor merge a classic
 * account's separate wallets.
 */
export const planSharedWalletLinks = (
  group: SharedKeyGroup<Leg>,
  shared: boolean | null,
): LinkPlan => {
  const plan: LinkPlan = { link: [], unlink: [] }
  if (shared === null) return plan
  if (group.source.linkedTo) plan.unlink.push(group.source.uuid)
  for (const leg of group.others) {
    if (shared && leg.linkedTo !== group.source.uuid) {
      plan.link.push({ uuid: leg.uuid, to: group.source.uuid })
    }
    if (!shared && leg.linkedTo) {
      plan.unlink.push(leg.uuid)
    }
  }
  return plan
}
