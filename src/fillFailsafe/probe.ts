import logger from '../utils/logger'
import { LOG_PREFIX, RestingOrder } from './types'

/**
 * Publish → receipt loop closure for the fill-failsafe (spec 001 §4.2, §4.3).
 *
 * The sweep used to treat `receivers >= 1` on a `RECONCILE VIA SWEEP` publish
 * as "a bot heard me". `receivers` counts Redis connections, and the API
 * process subscribes every account's `userStreamInfo` channel for balance
 * handling, so it is ≥ 1 for every live account — including one whose bot
 * worker silently lost its subscription (core spec 002). Bots now acknowledge
 * every channel message by writing `HSET gainium:userStreamAck:<uuid> <botId>
 * <ms>`; this module reads those acks after a grace period, both for sweeps
 * and for a periodic `PING` probe, and turns a missing ack into a log line, a
 * counter, a self-heal request and — when that does not help — a page.
 *
 * Decision logic is pure (`evaluateAcks`, `nextDeafState`); I/O goes through
 * the injected {@link ProbePort}.
 */

export const ACK_KEY_PREFIX = 'gainium:userStreamAck:'
export const DEAF_BOTS_KEY = 'gainium:failsafe:deafBots'
export const DEAF_BOTS_TTL_SEC = 60 * 60
export const PING_PREFIX = 'PING'

/**
 * How many probe periods may separate two misses of the SAME streak (spec 003
 * §1.1.1). "Consecutive" has to mean consecutive *rounds*: without this, two
 * misses hours apart were reported as "2+ consecutive user-stream probes".
 * Three rounds allows one skipped round plus slack.
 */
export const DEAF_STREAK_MAX_GAP_ROUNDS = 3

/**
 * Fleet-wide miss guard (spec 003 §1.1.3). A bot worker restart silences every
 * bot it hosts until it rehydrates, across unrelated accounts — that is a
 * property of the worker, not of any one bot's subscription, and counting it
 * per bot is a category error.
 *
 * Two independent arms decide a round was such an event:
 *
 * - **Account breadth** (spec 005) — the user stream is subscribed per
 *   exchange account, so one lost subscription explains misses on exactly one
 *   `uuid` however many bots sit on it. Misses spanning `FLEET_MISS_MIN_ACCOUNTS`
 *   unrelated accounts in one round have no per-account explanation left; the
 *   only thing those accounts share is the bot host. This is the arm that
 *   actually fires in production.
 * - **Miss ratio** — at least `FLEET_MISS_RATIO` of at least
 *   `FLEET_MISS_MIN_SAMPLE` judged bots. Kept only for a small (self-hosted)
 *   deployment, where breadth can never reach 3 and this is the sole way to
 *   catch a total outage. On a large fleet it is inert: a worker restart
 *   silences only a small fraction of all judged bots.
 *
 * Either arm drops the round's verdicts and suppresses miss-counting for
 * `FLEET_MISS_WARMUP_ROUNDS` afterwards.
 *
 * Deliberately bounded: a *persistent* fleet-wide miss resumes judging after
 * the warm-up and still pages. The sweep path and the bots' own
 * `assessUserStreamLiveness` repair loop cover that window meanwhile.
 */
export const FLEET_MISS_MIN_SAMPLE = 5
export const FLEET_MISS_RATIO = 0.5
export const FLEET_MISS_MIN_ACCOUNTS = 3
export const FLEET_MISS_WARMUP_ROUNDS = 3

/** Consecutive deaf rounds before the deaf path acts (self-heal, then page). */
const DEAF_ROUNDS_BEFORE_ACTION = 3

export const ackKey = (uuid: string): string => `${ACK_KEY_PREFIX}${uuid}`

/** A publish (sweep or probe) waiting for its acknowledgement window. */
export interface PendingAck {
  uuid: string
  publishedAt: number
  kind: 'sweep' | 'probe'
  /** For sweeps: the order that triggered it (log context). */
  order?: string
}

export interface AckVerdict {
  uuid: string
  /** Registry bots on the account that acked at/after `publishedAt`. */
  acked: string[]
  /** Registry bots on the account that did not. */
  missing: string[]
}

/**
 * Compare one account's ack hash against the bots the registry says hold
 * resting orders there. Bots absent from the registry are ignored (a stopped
 * bot's stale field is not consulted). Pure.
 */
export function evaluateAcks(
  pending: PendingAck,
  registryBots: Iterable<string>,
  acks: Record<string, string> | null | undefined,
): AckVerdict {
  const acked: string[] = []
  const missing: string[] = []
  for (const botId of new Set(registryBots)) {
    const ts = Number(acks?.[botId])
    if (Number.isFinite(ts) && ts >= pending.publishedAt) acked.push(botId)
    else missing.push(botId)
  }
  return { uuid: pending.uuid, acked, missing }
}

/** Per-bot probe-miss bookkeeping. */
export interface DeafRecord {
  uuid: string
  /** ms of the first missed probe in the current streak. */
  since: number
  /** consecutive missed probes. */
  misses: number
  /** ms of the most recent miss in the current streak (streak-decay input). */
  lastMissAt: number
}

export interface DeafTransition {
  /** Bots that just crossed `deafMisses` (log + write). */
  becameDeaf: DeafRecord[]
  /** Bots that were deaf and acked again (clear). */
  recovered: string[]
  /** Bots that were deaf but whose streak decayed — no longer deaf (clear). */
  lapsed: string[]
}

/**
 * Advance the per-bot miss counters with one probe verdict. Mutates `state`
 * (botId → record) and reports the transitions. Pure apart from `state`.
 *
 * `maxGapMs` bounds how far apart two misses of one streak may be (spec 003
 * §1.1.1). A miss that arrives later than that does not extend the streak — it
 * starts a new one — because the bot was demonstrably not judged in between and
 * the two misses are separate incidents, not consecutive probes.
 */
export function nextDeafState(
  state: Map<string, DeafRecord>,
  verdict: AckVerdict,
  now: number,
  deafMisses: number,
  maxGapMs: number,
): DeafTransition {
  const out: DeafTransition = { becameDeaf: [], recovered: [], lapsed: [] }
  for (const botId of verdict.acked) {
    const rec = state.get(botId)
    if (rec) {
      if (rec.misses >= deafMisses) out.recovered.push(botId)
      state.delete(botId)
    }
  }
  for (const botId of verdict.missing) {
    let rec = state.get(botId)
    if (rec && now - rec.lastMissAt > maxGapMs) {
      // Streak decayed: this miss opens a fresh one. If the stale record had
      // it flagged deaf, the caller must clear the published flag too.
      if (rec.misses >= deafMisses) out.lapsed.push(botId)
      rec = undefined
    }
    rec ??= { uuid: verdict.uuid, since: now, misses: 0, lastMissAt: now }
    rec.misses += 1
    rec.lastMissAt = now
    state.set(botId, rec)
    if (rec.misses === deafMisses) out.becameDeaf.push(rec)
  }
  return out
}

/**
 * Drop records for bots the round did not judge (spec 003 §1.1.2). Clearing a
 * record otherwise requires an *ack*, and acks are only read for bots
 * `openBots()` returns — so a bot that leaves `status: open` could never clear
 * and its record latched forever, re-paging every `alertCooldownMs`.
 * A genuinely deaf bot is open and holds resting orders, so it is judged every
 * round and is never pruned. Returns the pruned bots that were flagged deaf,
 * so the caller can clear their published flag. Mutates `state`.
 */
export function pruneDeafState(
  state: Map<string, DeafRecord>,
  judgeable: Set<string>,
  deafMisses: number,
): string[] {
  const dropped: string[] = []
  for (const [botId, rec] of [...state]) {
    if (judgeable.has(botId)) continue
    state.delete(botId)
    if (rec.misses >= deafMisses) dropped.push(botId)
  }
  return dropped
}

/** Was this round's miss pattern a fleet event rather than per-bot deafness? */
export function isFleetWideMiss(
  judged: number,
  missed: number,
  missedAccounts: number,
): boolean {
  if (missedAccounts >= FLEET_MISS_MIN_ACCOUNTS) return true
  return judged >= FLEET_MISS_MIN_SAMPLE && missed / judged >= FLEET_MISS_RATIO
}

/** Bots currently past the deaf threshold. */
export function deafBots(
  state: Map<string, DeafRecord>,
  deafMisses: number,
): Map<string, DeafRecord> {
  const out = new Map<string, DeafRecord>()
  for (const [botId, rec] of state) {
    if (rec.misses >= deafMisses) out.set(botId, rec)
  }
  return out
}

/** Everything the prober does to the outside world. */
export interface ProbePort {
  /** Publish on `userStreamInfo<uuid>`; resolves to the receiver count. */
  publish(uuid: string, msg: string): Promise<number>
  /** HGETALL of the account's ack hash. */
  readAcks(uuid: string): Promise<Record<string, string> | null>
  writeDeaf(botId: string, rec: DeafRecord): Promise<void>
  clearDeaf(botId: string): Promise<void>
  /**
   * Which of these bot ids are OPEN right now. A stopped or deleted bot can
   * leave order rows in the resting statuses (the registry cannot tell), and
   * such a bot never acks — judging it would flag a zombie row as a deaf bot
   * (it produced false `DEAF BOT` flags before this check existed).
   */
  openBots(botIds: Iterable<string>): Promise<Set<string>>
  /** Ask every bot host to resubscribe the account's user stream. */
  requestResubscribe(uuid: string): Promise<void>
  alert(
    type: 'stream_sweep_unacked' | 'stream_deaf_bots',
    message: string,
  ): Promise<void>
  bump(
    field: 'pingsPublished' | 'sweepsUnacked' | 'deafBots' | 'selfHealsSent',
    by?: number,
  ): void
}

export interface ProbeConfig {
  pingMs: number
  ackGraceMs: number
  deafMisses: number
  alertCooldownMs: number
}

export class Prober {
  private pending: PendingAck[] = []
  private state = new Map<string, DeafRecord>()
  /** uuid → ms of the resubscribe request sent after an unacked sweep. */
  private healed = new Map<string, number>()
  private lastAlert = new Map<string, number>()
  /** Consecutive probe rounds that ended with ≥1 deaf bot. */
  private deafRounds = 0
  /** Miss-counting is suppressed until this ms (spec 003 §1.1.3). */
  private fleetWarmupUntil = 0
  /**
   * Bot workers on a core older than 1.57.0 never write acks. Until the first
   * ack hash is seen, every evaluation would read as "nobody heard", so the
   * verdicts are logged at debug and never escalate.
   */
  private ackContractSeen = false
  /** Probe rounds that actually published (drives the heartbeat warm-up). */
  private rounds = 0

  constructor(
    private port: ProbePort,
    private cfg: ProbeConfig,
  ) {}

  /** Remember a published sweep for its ack window (called by the sweeper). */
  trackSweep(uuid: string, publishedAt: number, order: string): void {
    this.pending.push({ uuid, publishedAt, kind: 'sweep', order })
  }

  /**
   * One probe round. Pings every registry account PLUS every account in
   * `alsoUuids` — the accounts of all open bots. A bot decides "I am deaf"
   * from silence while the prober heartbeat is alive, and it counts any NEW
   * order as resting (MARKET rows, venues the registry skips, orders older
   * than the registry window); if such an account were never pinged, every
   * bot on it would repair every window and eventually show the user a false
   * error. Only registry
   * accounts are judged for acks; the extras are pinged so their bots hear.
   */
  async probe(
    orders: RestingOrder[],
    now: number = Date.now(),
    alsoUuids: Iterable<string> = [],
  ): Promise<void> {
    if (this.cfg.pingMs <= 0) return
    const uuids = new Set([...orders.map((o) => o.exchangeUUID), ...alsoUuids])
    let published = 0
    for (const uuid of uuids) {
      try {
        const receivers = await this.port.publish(uuid, `${PING_PREFIX} ${now}`)
        published += 1
        if (receivers > 0) {
          this.pending.push({ uuid, publishedAt: now, kind: 'probe' })
        }
      } catch (e) {
        logger.warn(`${LOG_PREFIX} probe publish ${uuid}: ${e}`)
      }
    }
    if (published) {
      this.port.bump('pingsPublished', published)
      this.rounds += 1
    }
  }

  /**
   * The probe period to advertise in the failsafe heartbeat. Bots treat
   * channel silence as deafness only while this is > 0, so it must not be
   * advertised before the probe has actually reached the fleet: otherwise,
   * on a detector start, every bot that had been quiet for a while repairs at
   * once — each a rabbit `open stream` plus a reconcile pass — before the
   * first round has gone out. Two completed rounds guarantee every account was
   * pinged at least twice before any bot may judge itself.
   */
  advertisedPingMs(): number {
    return this.rounds >= 2 ? this.cfg.pingMs : 0
  }

  get roundsCompleted(): number {
    return this.rounds
  }

  /** Evaluate every pending publish whose grace period has elapsed. */
  async checkAcks(
    orders: RestingOrder[],
    now: number = Date.now(),
  ): Promise<void> {
    const due = this.pending.filter(
      (p) => now - p.publishedAt >= this.cfg.ackGraceMs,
    )
    if (!due.length) return
    this.pending = this.pending.filter(
      (p) => now - p.publishedAt < this.cfg.ackGraceMs,
    )

    const dueUuids = new Set(due.map((p) => p.uuid))
    const candidateBots = new Set<string>()
    for (const o of orders) {
      if (dueUuids.has(o.exchangeUUID)) candidateBots.add(o.botId)
    }
    let open: Set<string>
    try {
      open = await this.port.openBots(candidateBots)
    } catch (e) {
      logger.warn(
        `${LOG_PREFIX} open-bot lookup failed, skipping ack round: ${e}`,
      )
      return
    }
    const botsByUuid = new Map<string, Set<string>>()
    for (const o of orders) {
      if (!open.has(o.botId)) continue
      let set = botsByUuid.get(o.exchangeUUID)
      if (!set) botsByUuid.set(o.exchangeUUID, (set = new Set()))
      set.add(o.botId)
    }

    const probeVerdicts: AckVerdict[] = []
    for (const p of due) {
      const bots = botsByUuid.get(p.uuid)
      if (!bots?.size) continue // account left the registry: nothing to protect
      let acks: Record<string, string> | null = null
      try {
        acks = await this.port.readAcks(p.uuid)
      } catch (e) {
        logger.warn(`${LOG_PREFIX} ack read ${p.uuid}: ${e}`)
        continue
      }
      if (acks && Object.keys(acks).length) this.ackContractSeen = true
      const verdict = evaluateAcks(p, bots, acks)
      if (!this.ackContractSeen) {
        logger.debug(
          `${LOG_PREFIX} ack contract not yet observed — ${p.kind} for uuid=${p.uuid} not judged`,
        )
        continue
      }
      if (p.kind === 'sweep') {
        await this.settleSweep(p, verdict, now)
      } else {
        // Collected, not settled inline: the fleet guard, the state prune and
        // the alert all need this round's totals (spec 003 §1.1.2, §1.1.3).
        probeVerdicts.push(verdict)
      }
    }
    if (probeVerdicts.length) {
      await this.settleProbeRound(probeVerdicts, orders, now)
    }
  }

  /**
   * Settle one probe round as a whole (spec 003). Order matters: decide whether
   * the round is trustworthy at all, only then advance the per-bot counters,
   * then reap records for bots this round could not judge, then consider acting.
   */
  private async settleProbeRound(
    verdicts: AckVerdict[],
    orders: RestingOrder[],
    now: number,
  ) {
    const judgeable = new Set<string>()
    let missed = 0
    let missedAccounts = 0
    for (const v of verdicts) {
      for (const botId of v.acked) judgeable.add(botId)
      for (const botId of v.missing) {
        judgeable.add(botId)
        missed += 1
      }
      // One verdict is one exchange account = one user-stream subscription.
      if (v.missing.length) missedAccounts += 1
    }

    const inWarmup = now < this.fleetWarmupUntil
    const fleetWide = isFleetWideMiss(judgeable.size, missed, missedAccounts)
    if (fleetWide) {
      // Restart the warm-up for as long as the fleet keeps missing.
      this.fleetWarmupUntil =
        now + this.cfg.pingMs * FLEET_MISS_WARMUP_ROUNDS
      logger.warn(
        `${LOG_PREFIX} fleet-wide probe miss (${missed}/${judgeable.size} bots ` +
          `on ${missedAccounts} account(s)) — ` +
          `treating as a bot-worker rehydration window, not per-bot deafness; ` +
          `not judging for ${FLEET_MISS_WARMUP_ROUNDS} rounds`,
      )
    } else if (!inWarmup) {
      for (const v of verdicts) await this.settleProbe(v, now)
    }

    const dropped = pruneDeafState(
      this.state,
      judgeable,
      this.cfg.deafMisses,
    )
    for (const botId of dropped) {
      logger.info(
        `${LOG_PREFIX} deaf bot no longer judgeable, dropping record bot=${botId}`,
      )
      await this.port.clearDeaf(botId).catch(() => undefined)
    }

    // A round we did not judge cannot support a page either.
    if (fleetWide || inWarmup) return
    await this.settleRound(orders, now)
  }

  private async settleSweep(p: PendingAck, v: AckVerdict, now: number) {
    if (v.acked.length) {
      this.healed.delete(p.uuid)
      return
    }
    this.port.bump('sweepsUnacked')
    logger.error(
      `${LOG_PREFIX} SWEEP UNACKED uuid=${p.uuid} order=${p.order ?? '-'} ` +
        `bots=${v.missing.slice(0, 10).join(',')}${v.missing.length > 10 ? ',…' : ''} ` +
        `— no bot on the account acted within ${Math.round(this.cfg.ackGraceMs / 1000)}s`,
    )
    const healedAt = this.healed.get(p.uuid)
    if (healedAt === undefined) {
      this.healed.set(p.uuid, now)
      this.port.bump('selfHealsSent')
      await this.port
        .requestResubscribe(p.uuid)
        .catch((e) =>
          logger.warn(`${LOG_PREFIX} resubscribe request ${p.uuid}: ${e}`),
        )
      return
    }
    // Already asked the hosts to resubscribe and the account is still deaf.
    await this.maybeAlert(
      `sweep:${p.uuid}`,
      'stream_sweep_unacked',
      `Reconcile sweep for account ${p.uuid} was not acknowledged by any of its ${v.missing.length} bot(s) even after a resubscribe request at ${new Date(healedAt).toISOString()} — missed fills on this account are not being recovered`,
      now,
    )
  }

  private async settleProbe(v: AckVerdict, now: number) {
    const t = nextDeafState(
      this.state,
      v,
      now,
      this.cfg.deafMisses,
      this.cfg.pingMs * DEAF_STREAK_MAX_GAP_ROUNDS,
    )
    for (const botId of t.lapsed) {
      logger.info(
        `${LOG_PREFIX} deaf streak lapsed (misses too far apart) bot=${botId}`,
      )
      await this.port.clearDeaf(botId).catch(() => undefined)
    }
    for (const rec of t.becameDeaf) {
      // Which bot this is, is in the log line; the hash is for the admin page.
      const botId =
        [...this.state.entries()].find(([, r]) => r === rec)?.[0] ?? '?'
      logger.warn(
        `${LOG_PREFIX} DEAF BOT uuid=${rec.uuid} bot=${botId} misses=${rec.misses} ` +
          `since=${new Date(rec.since).toISOString()}`,
      )
      this.port.bump('deafBots')
      await this.port.writeDeaf(botId, rec).catch(() => undefined)
    }
    for (const botId of t.recovered) {
      logger.info(`${LOG_PREFIX} deaf bot recovered bot=${botId}`)
      await this.port.clearDeaf(botId).catch(() => undefined)
    }
  }

  /**
   * Act on the bots that are still deaf after a judged round (spec 003 §1.1.4).
   *
   * Both claims the page used to make were false: it said
   * "did not self-heal" while the deaf path never called `requestResubscribe`
   * — only the sweep path did, so `SELF-HEAL` never appeared in the logs once —
   * and it said "trading without seeing fills" without checking the bots still
   * had anything resting. So: self-heal first and page only if that failed, and
   * only ever page about bots that actually hold resting orders.
   */
  private async settleRound(orders: RestingOrder[], now: number) {
    const deaf = deafBots(this.state, this.cfg.deafMisses)
    if (!deaf.size) {
      this.deafRounds = 0
      return
    }
    this.deafRounds += 1
    if (this.deafRounds < DEAF_ROUNDS_BEFORE_ACTION) return

    // Only a bot with something resting can be missing a fill. (The prune in
    // settleProbeRound already implies this; asserting it here keeps the
    // message's claim true locally rather than by a distant invariant.)
    const resting = new Set(orders.map((o) => o.botId))
    const atRisk = [...deaf].filter(([botId]) => resting.has(botId))
    if (!atRisk.length) return
    const accounts = new Set(atRisk.map(([, rec]) => rec.uuid))

    // Self-heal before escalating: ask the bot hosts to resubscribe, and give
    // the repair a round to land. If it works the bots ack, the records clear
    // and no page is ever sent.
    const unhealed = [...accounts].filter((uuid) => !this.healed.has(uuid))
    for (const uuid of unhealed) {
      this.healed.set(uuid, now)
      this.port.bump('selfHealsSent')
      await this.port
        .requestResubscribe(uuid)
        .catch((e) =>
          logger.warn(`${LOG_PREFIX} resubscribe request ${uuid}: ${e}`),
        )
    }
    if (unhealed.length) return

    await this.maybeAlert(
      'deaf',
      'stream_deaf_bots',
      `${atRisk.length} bot(s) on ${accounts.size} account(s) holding resting orders have not acknowledged ${this.cfg.deafMisses}+ consecutive user-stream probes and are still silent after a resubscribe request — fills on those orders may not be booked. Accounts: ${[...accounts].slice(0, 5).join(', ')}${accounts.size > 5 ? ', …' : ''}`,
      now,
    )
  }

  private async maybeAlert(
    key: string,
    type: 'stream_sweep_unacked' | 'stream_deaf_bots',
    message: string,
    now: number,
  ) {
    const last = this.lastAlert.get(key) ?? 0
    if (now - last < this.cfg.alertCooldownMs) return
    this.lastAlert.set(key, now)
    await this.port
      .alert(type, message)
      .catch((e) => logger.warn(`${LOG_PREFIX} alert ${type}: ${e}`))
  }

  /** Test/inspection hooks. */
  get pendingCount(): number {
    return this.pending.length
  }
  get deaf(): Map<string, DeafRecord> {
    return deafBots(this.state, this.cfg.deafMisses)
  }
}
