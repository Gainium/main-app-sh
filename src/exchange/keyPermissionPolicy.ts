import { ExchangeKeyPermissions } from '../../types'

/**
 * Policy for exchange API keys that carry withdrawal permission.
 *
 * The connector reports facts (`KeyPermissions`); this module decides what to
 * do about them. The split matters because only main-app knows whether a
 * connection is brand new or already live and trading.
 *
 * Background: Gainium needs read + trade and nothing else. Withdrawal is never
 * required by any feature, but nothing used to verify that a stored key was
 * actually limited that way, so it was an assumption rather than a property.
 *
 * THE RULE
 * --------
 *   New credentials  → hard reject. The user is at the form, can read why, and
 *                      nothing of theirs is running yet.
 *   Existing         → record and flag only. NEVER reject.
 *
 * That asymmetry is the whole safety argument for shipping this. Rejecting on
 * re-verification would take a user whose keys work today, fail their
 * connection, and stop their live bots — punishing them for a rule that did
 * not exist when they connected. Every re-verify path must therefore call
 * `recordOnly`, and only the add/replace-credentials paths may call
 * `shouldRejectNewConnection`.
 */

/** True only when the exchange positively says the key can withdraw.
 *  `unknown` is not a rejection — we do not fail users over a lookup we could
 *  not complete. */
export const hasWithdrawalPermission = (
  permissions?: ExchangeKeyPermissions,
): boolean => permissions?.withdraw === 'yes'

/**
 * True when the key can move funds *between accounts* — Bybit's
 * AccountTransfer/SubMemberTransfer, Binance's internal/universal transfer.
 *
 * This is not a lesser version of withdrawal — it is a distinct capability
 * that needs no withdrawal scope at all. `universal-transfer` can sweep a
 * user's sub-accounts into their master account, and while the funds stay
 * inside the user's own tree, anyone holding the key can move them.
 *
 * Gainium calls no transfer endpoint on any exchange, so this permission buys
 * a user nothing and hands whoever holds the key that capability.
 */
export const hasTransferPermission = (
  permissions?: ExchangeKeyPermissions,
): boolean => permissions?.transfer === 'yes'

/**
 * Whether to refuse a *newly supplied* credential. Also used when an existing
 * connection is edited with new credentials: rejecting there is safe because
 * the stored key is left untouched, so nothing that is running stops.
 *
 * Note this is deliberately WIDER than "can withdraw" — see
 * `hasTransferPermission`. Existing connections are still only ever flagged,
 * so no live bot stops because of the widening.
 */
export const shouldRejectNewConnection = (
  permissions?: ExchangeKeyPermissions,
): boolean =>
  hasWithdrawalPermission(permissions) || hasTransferPermission(permissions)

/**
 * User-facing rejection text. Names the capability actually found and the fix,
 * not just the refusal — a user told only "rejected" will retry the same key.
 */
export const withdrawalRejectionReason = (
  exchange?: string,
  permissions?: ExchangeKeyPermissions,
): string => {
  const withdraw = hasWithdrawalPermission(permissions)
  const transfer = hasTransferPermission(permissions)
  // Never infer the capability from the absence of the other one. Callers must
  // pass `permissions`; when they do not, say something true but unspecific
  // rather than naming a capability we were not actually told about. A caller
  // that omitted the argument previously produced the transfer wording — and
  // the Bybit hint below — for keys rejected on withdrawal, on any exchange.
  const found = withdraw
    ? 'withdrawal permission'
    : transfer
      ? 'permission to transfer funds between accounts'
      : 'permission to move your funds'
  const on = exchange ? ` on ${exchange}` : ''
  // The hint names a Bybit-specific control, so only offer it on Bybit.
  const hint =
    transfer && !withdraw && /bybit/i.test(exchange ?? '')
      ? ` On Bybit that is Assets → Wallet (“Account Transfer” / “Subaccount ` +
        `Transfer”); leave the whole Wallet group unchecked.`
      : ''
  return (
    `This API key has ${found} enabled. Gainium never needs it — it only ` +
    `reads your account and places trades, and it never moves your funds. ` +
    `Please recreate the key${on} with read and trade access only, then add ` +
    `it again.${hint}`
  )
}

/**
 * What to persist for an existing connection: the observation, never a verdict.
 *
 * Returns `undefined` when there is nothing worth writing, so callers can skip
 * the `$set` entirely rather than overwriting a previous good reading with an
 * `unknown` produced by a transient lookup failure — an outage must not erase
 * the fact that a key was withdrawal-enabled last time we looked.
 */
export const recordOnly = (
  permissions: ExchangeKeyPermissions | undefined,
  previous?: ExchangeKeyPermissions,
): ExchangeKeyPermissions | undefined => {
  if (!permissions) {
    return undefined
  }
  const learnedNothing =
    permissions.withdraw === 'unknown' &&
    permissions.transfer === 'unknown' &&
    permissions.ipRestricted === 'unknown'
  if (learnedNothing && previous) {
    return undefined
  }
  return permissions
}

/**
 * Connections an admin should look at, worst first. Used by the periodic
 * re-check and by admin reporting.
 */
export const isRiskyConnection = (
  permissions?: ExchangeKeyPermissions,
): boolean =>
  permissions?.withdraw === 'yes' ||
  permissions?.transfer === 'yes' ||
  permissions?.ipRestricted === 'no'
