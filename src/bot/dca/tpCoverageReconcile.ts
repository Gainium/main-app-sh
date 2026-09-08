/**
 * Does the deal's resting take-profit still cover the position it tracks?
 *
 * Spec `specs/013.tp-coverage-drift-after-partial-tp.md` (issue #696),
 * follow-up to #694.
 *
 * #694 fixed the path that *creates* this drift: `placeOrders` looked the
 * resting take-profit up with `status: 'NEW'` only, so a take-profit that had
 * taken a partial fill was invisible to it and the replacement was sent on top
 * of the still-live order. What that fix cannot do is repair the deals already
 * drifted — coverage is only ever re-established as a side effect of
 * `placeOrders`, which runs on a fill, so a deal whose coverage broke while the
 * path was broken stays broken until its next safety order happens to fill.
 * Three production deals were sitting that way on 2026-09-06, across three
 * users: B3-USDC `6a90e161…` with 110,493 B3 carrying no take-profit at all,
 * and CTSIUSDT `6a978104…` / DGBUSDT `691de676…` each resting two take-profits
 * that between them offered more base than the deal owned.
 *
 * Pure on purpose, and for the same reason as `positionReconcile`: the whole
 * decision is one piece of judgement reachable in production only behind a live
 * exchange round trip, and the fail-safe direction matters more than the happy
 * path. Cancelling a take-profit that was in fact covering the position leaves
 * a live position unprotected — strictly worse than the drift being repaired.
 * So every branch here is written to answer "covered" when it cannot prove
 * otherwise.
 */

/** The fields of an order this decision reads. */
export type LiveTpOrder = {
  clientOrderId: string
  /** The status the VENUE last reported — not the DB's copy. See §1.7. */
  status: string
  origQty: string | number
  executedQty: string | number
}

/**
 * What the venue answered about this deal's take-profit orders.
 *
 * `unavailable` is deliberately NOT an empty list, exactly as in
 * `positionReconcile`: a venue that could not be reached and a deal with no
 * resting take-profit are the same array and opposite answers. Reading the
 * first as the second would cancel and re-arm on every failed lookup.
 */
export type TpCoverageProbe =
  | { kind: 'unavailable' }
  | { kind: 'orders'; orders: LiveTpOrder[] }

export type TpCoverageState = 'covered' | 'under' | 'over' | 'unknown'

export type TpCoverageVerdict = {
  state: TpCoverageState
  /** Base the deal still holds. */
  tracked: number
  /** Base the live take-profits can still sell. */
  resting: number
  /** `resting - tracked`. Negative means position with no take-profit. */
  drift: number
  /**
   * The stale `PARTIALLY_FILLED` take-profits to cancel — via the
   * `promotePartialToFilled: false` opt-out, never the default path.
   */
  staleTps: LiveTpOrder[]
  /** Should `placeOrders` be asked to re-arm the take-profit afterwards? */
  rearm: boolean
  /** Short text for the log line. */
  verdict: string
}

/** A status the venue still has resting on the book. */
const isResting = (status: string) =>
  status === 'NEW' || status === 'PARTIALLY_FILLED'

/**
 * A quantity as a human should read it in a log line.
 *
 * `deal.size` carries binary-float noise from summing fills — the B3-USDC deal
 * is stored as `989458.9999999998` — so the drift comes out as
 * `110492.99999999977` and an operator comparing the log against the venue sees
 * two different numbers. 12 significant digits is past any real precision the
 * venues quote and short of where the noise lives. Display only: every decision
 * above is made on the raw value.
 */
const fmtQty = (n: number): string => `${+n.toPrecision(12)}`

/**
 * What this order can still SELL, which is not the size it was created for.
 *
 * The same measure `placeOrders` compares on since #694 (`dcaHelper.ts:12996`):
 * once a take-profit takes a partial fill, `origQty` and the quantity still on
 * the book are two different numbers, and only the second one is coverage.
 */
export const restingTpQty = (o: LiveTpOrder): number =>
  parseFloat(`${o.origQty}`) - (parseFloat(`${o.executedQty}`) || 0)

/**
 * The base this deal still holds.
 *
 * These are the terms `getTPOrder` already uses to size a replacement
 * (`dcaHelper.ts:13232-13262`), not a second opinion about them — a coverage
 * check that measured the position differently from the code that arms the
 * take-profit would report drift on healthy deals forever. `tpHistory` and a
 * filled close order are two records of the same event, so an entry present in
 * both is counted once; counting it twice is what once drove the take-profit
 * quantity negative on deals that closed more than once.
 */
export const trackedPosition = ({
  size,
  tpHistory,
  filledCloseOrders,
  reduceFundsBase = 0,
  pendingReduceFundsBase = 0,
}: {
  size: number
  tpHistory: { id?: string; qty: number }[]
  filledCloseOrders: LiveTpOrder[]
  reduceFundsBase?: number
  pendingReduceFundsBase?: number
}): number => {
  const filledIds = filledCloseOrders.map((o) => o.clientOrderId)
  const soldViaHistory = tpHistory
    .filter((h) => !h.id || !filledIds.includes(h.id))
    .reduce((acc, h) => acc + h.qty, 0)
  const soldViaFilled = filledCloseOrders.reduce(
    (acc, o) => acc + (parseFloat(`${o.executedQty}`) || 0),
    0,
  )
  return (
    Math.abs(size) -
    soldViaHistory -
    soldViaFilled -
    reduceFundsBase -
    pendingReduceFundsBase
  )
}

/**
 * The part of a drift the engine's own fee handling cannot account for.
 *
 * `getTPOrder` does not size the take-profit at the tracked position: on spot
 * it shaves one fee off a long (`dcaHelper.ts:13563`, `_qty * (1 - maxFee)`)
 * because the close sells `gross * (1 - fee)`, and grosses a short up by
 * `1 / (1 - fee)` for the mirror reason. `trackedPosition` measures the
 * position itself, so on a perfectly healthy deal the two differ by exactly
 * that factor — `tracked * fee / (1 - fee)`, the same magnitude in both
 * directions — and the check reported it as drift forever. Issue #700, spec
 * `014`: RUNE-USDC `6a9169e0…` rested `1151.1818 * 0.999 = 1150.0306` and was
 * reported `under` on every pass; APE-USDC `6a9168a9…` rested
 * `32550 / 0.999 = 32582.58` and was reported `over`.
 *
 * Subtracting the factor from `tracked` instead was rejected: which of
 * `getTPOrder`'s fee branches produced a given resting order is not knowable
 * from the deal (the quantity leg is zeroed on futures, zero for a `zeroFee`
 * key, and re-derived from quote profit on a `profitCurrency: base` deal), and
 * on the live fleet most in-scope deals rest a take-profit at exactly the
 * tracked position. A subtraction would have silenced one false family and
 * created another of the same shape in the opposite direction. A tolerance is
 * safe under every branch: it can only ever make this check report LESS.
 *
 * Deliberately one fee wide and no wider. The real population this check exists
 * for starts at 1.25% of the tracked position and runs to 98%, an order of
 * magnitude clear of the ~0.1% a fee can move.
 */
export const unexplainedDrift = (
  drift: number,
  tracked: number,
  feeRate: number,
): number => {
  const fee = feeRate > 0 && feeRate < 1 ? feeRate : 0
  return Math.max(0, Math.abs(drift) - (Math.abs(tracked) * fee) / (1 - fee))
}

/**
 * Could an order be placed for this much base at all?
 *
 * The engine's own placeability test, applied wherever it decides a remainder
 * is too small to arm (`dcaHelper.ts:6583`, `:5563`, `:5946`). Using it here
 * rather than an epsilon is what keeps a deal that has all but closed — the
 * KUBUSDT deal in the spec is 0.01 adrift on a 0.02 position — from being
 * reported as broken forever over a drift no venue would accept an order for.
 */
const isActionable = (
  qty: number,
  {
    baseMinAmount,
    quoteMinAmount,
    price,
  }: { baseMinAmount: number; quoteMinAmount: number; price: number },
): boolean =>
  Math.abs(qty) >= baseMinAmount && Math.abs(qty) * price >= quoteMinAmount

export const reconcileTpCoverage = (
  probe: TpCoverageProbe,
  tracked: number,
  venue: {
    baseMinAmount: number
    quoteMinAmount: number
    price: number
    /**
     * `worstFee` of the bot's own fee for this pair — the one `getTPOrder`
     * sizes with. Optional so the decision still answers without it; 0 is the
     * pre-#700 behaviour. See {@link unexplainedDrift}.
     */
    feeRate?: number
  },
): TpCoverageVerdict => {
  if (probe.kind === 'unavailable') {
    // No answer is not an answer. Do exactly what this pass would have done
    // without the check; the next one may well succeed.
    return {
      state: 'unknown',
      tracked,
      resting: 0,
      drift: 0,
      staleTps: [],
      rearm: false,
      verdict: 'venue take-profit state unknown',
    }
  }
  const live = probe.orders.filter((o) => isResting(o.status))
  const resting = live.reduce((acc, o) => acc + restingTpQty(o), 0)
  const drift = resting - tracked
  const base = { tracked, resting, drift }

  // What a repair would actually have to place: the drift LESS the part the
  // take-profit is sized net of. A residue no venue would accept an order for
  // is not a defect — whether it is too small outright, or is the fee itself.
  const unexplained = unexplainedDrift(drift, tracked, venue.feeRate ?? 0)

  if (!isActionable(unexplained, venue)) {
    return {
      ...base,
      state: 'covered',
      staleTps: [],
      rearm: false,
      verdict:
        drift === 0
          ? `take-profit covers the position (${fmtQty(resting)})`
          : `take-profit is ${fmtQty(drift)} off ${fmtQty(tracked)}, of which ` +
            `${fmtQty(unexplained)} is not the fee it is sized net of — below ` +
            `the venue minimum, not actionable`,
    }
  }

  // Only a take-profit that has taken a partial fill is residue. In both
  // over-covered production deals the `NEW` order is the correctly-sized
  // replacement and the partial is what #694 failed to cancel, so removing the
  // partial both drops the duplicate and restores coverage. Cancelling a
  // healthy `NEW` take-profit is a different decision with a different risk,
  // and this is not the fix that should be making it.
  const staleTps = live.filter((o) => o.status === 'PARTIALLY_FILLED')
  const state: TpCoverageState = drift < 0 ? 'under' : 'over'
  const verdict =
    state === 'under'
      ? `${fmtQty(-drift)} of ${fmtQty(tracked)} has no take-profit covering it ` +
        `(${live.length} live take-profit(s) resting ${fmtQty(resting)})`
      : `take-profits offer ${fmtQty(resting)} against a tracked position of ${fmtQty(
          tracked,
        )} — ${fmtQty(drift)} more base than the deal owns`

  return {
    ...base,
    state,
    staleTps,
    // §1.4.1. Re-arming on top of a healthy order we are leaving in place is
    // precisely how the duplicate take-profit was made, so it is safe only once
    // nothing is left resting: either we cancelled what was there, or there was
    // never anything there. `placeOrders` is idempotent about the rest — it
    // re-sizes only when the resting quantity actually disagrees with the deal.
    //
    // `under` is the third safe case, and without it this whole correction was
    // inert for the population it matters most to (spec `017` §4.1, issue
    // #702): a deal resting ONE undersized `NEW` take-profit has no `staleTps`
    // and one live order, so the rule above answered false and an armed engine
    // logged the drift and did nothing — 61 open deals on 2026-09-08, 92% of
    // the position uncovered on average. `under` means the deal needs a BIGGER
    // take-profit, and that is exactly the branch `placeOrders` already has:
    // it looks the resting order up by `['NEW','PARTIALLY_FILLED']` and, when
    // that order can sell less than the replacement, cancels it (with
    // `promotePartialToFilled: false`) and sends the replacement in the same
    // pass. So this re-arm cannot duplicate — it can only resize upward, and
    // an order too small to close the deal is not one worth protecting.
    // `over` keeps the conservative rule: there, re-arming really would stack.
    rearm: staleTps.length > 0 || live.length === 0 || state === 'under',
    verdict,
  }
}

/**
 * Which deals the CORRECTION is armed for.
 * Spec `specs/016.tp-coverage-repair-per-deal-scope.md`.
 *
 * `invalid` is deliberately not folded into `off`, for the same reason
 * `unavailable` is not an empty order list above: both refuse to act, but one
 * is the operator's intent and the other is a value the engine could not read.
 * Reporting the second as the first is how an operator concludes the flag does
 * not work and reaches for the fleet-wide value instead (§1.3).
 */
export type TpRepairScope =
  | { kind: 'off' }
  | { kind: 'fleet' }
  | { kind: 'deals'; dealIds: Set<string> }
  | { kind: 'invalid'; tokens: string[] }

/**
 * A deal id, and nothing looser. Stricter than mongoose's `isValidObjectId`,
 * which also accepts any 12-character string — under that check a truncated
 * token parses as a legitimate id and the run silently scopes to a deal that
 * does not exist (§4.2). This module is pure by design, so it could not import
 * mongoose in any case.
 */
const DEAL_ID = /^[0-9a-f]{24}$/i

/**
 * Reads `BOT_TP_COVERAGE_REPAIR` (§4.1).
 *
 * Correction cancels and places real orders with real money, so every branch
 * that is not an unambiguous arming instruction answers "do not act".
 */
export const parseTpRepairScope = (
  raw: string | undefined,
): TpRepairScope => {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'off' }
  if (/^(1|true|yes)$/i.test(value)) return { kind: 'fleet' }
  const tokens = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const bad = tokens.filter((t) => !DEAL_ID.test(t))
  if (bad.length || !tokens.length) return { kind: 'invalid', tokens: bad }
  return {
    kind: 'deals',
    dealIds: new Set(tokens.map((t) => t.toLowerCase())),
  }
}

/** May the correction run for this deal? */
export const tpRepairAllows = (
  scope: TpRepairScope,
  dealId: string,
): boolean =>
  scope.kind === 'fleet' ||
  (scope.kind === 'deals' && scope.dealIds.has(dealId.toLowerCase()))

/**
 * The startup line (§4.3). An operator arming a money-moving correction has to
 * be able to confirm from the log that the engine read what he typed.
 */
export const describeTpRepairScope = (scope: TpRepairScope): string => {
  switch (scope.kind) {
    case 'fleet':
      return 'ARMED for every drifted deal (fleet-wide)'
    case 'deals':
      return `ARMED for ${scope.dealIds.size} deal(s): ${[
        ...scope.dealIds,
      ].join(', ')}`
    case 'invalid':
      return (
        `value not understood, so nothing is armed (detect only) — ` +
        `not a deal id: ${scope.tokens.join(', ')}. ` +
        `Expected 1/true/yes for every drifted deal, or a comma-separated ` +
        `list of 24-character deal ids`
      )
    case 'off':
      return 'not armed (detect only)'
  }
}

/**
 * The greppable line the reconcile pass emits for a drifted deal.
 *
 * Named after the deal because that is what an operator has to act on, and
 * carries both quantities so the decision can be audited from the log alone
 * without re-querying the venue.
 */
export const tpCoverageDriftWarn = ({
  dealId,
  symbol,
  verdict,
}: {
  dealId: string
  symbol: string
  verdict: TpCoverageVerdict
}): string =>
  `tp-coverage drift | deal ${dealId} (${symbol}) ${verdict.state}: ` +
  `${verdict.verdict}. ` +
  `Stale take-profit(s): ${
    verdict.staleTps.map((o) => o.clientOrderId).join(', ') || 'none'
  }`
