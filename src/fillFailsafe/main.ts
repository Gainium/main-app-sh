import logger from '../utils/logger'
import RedisClient from '../db/redis'
import { ExchangeEnum } from '../../types'
import {
  Candidate,
  FailsafeConfig,
  FilterState,
  LOG_PREFIX,
  RestingOrder,
  Tick,
  loadConfig,
} from './types'
import { Registry } from './registry'
import { PriceFeed } from './prices'
import {
  buildThresholds,
  candidateFilter,
  clearCandidate,
  markConfirmedDivergence,
  markFalsePositive,
  pruneDebounce,
} from './filter'
import { coalesce } from './coalesce'
import {
  KillState,
  admitConfirm,
  refreshKillSwitch,
  /* usageCooldownDeadline, */
} from './loadControls'
import { confirmList } from './confirm'
import { SweepPublisher } from './sweep'
import { Counters, CounterField } from './counters'
import { writeHeartbeat } from './heartbeat'
import {
  Prober,
  ProbePort,
  ackKey,
  DEAF_BOTS_KEY,
  DEAF_BOTS_TTL_SEC,
} from './probe'
import RabbitClient from '../db/rabbit'
import { BotServiceQueues } from '../../types'
import { botDb, comboBotDb, dcaBotDb } from '../db/dbInit'
import { BotStatusEnum, StatusEnum } from '../../types'
import { Types } from 'mongoose'

/**
 * Fill-Failsafe detector entry point (spec §3, §7). Single-instance worker:
 *  - Redis leader lock so a second start idles out.
 *  - FF_ENABLED !== 'true' => log + idle (never touches anything).
 *  - Registry refresh loop → price feed sync → tick-driven candidate filter →
 *    coalesced, load-controlled exchange-confirm → shadow-log or publish
 *    RECONCILE VIA SWEEP.
 *  - Graceful SIGINT/SIGTERM.
 *
 * Shadow is the default (§7.3): detect + confirm, never publish, until
 * FF_SHADOW=false AND the runtime kill/shadow keys allow it.
 */

/**
 * Host-specific hooks. The detector itself is edition-agnostic; the cloud
 * entry injects its ops alerting and the catch-rate escalation tier, while
 * self-hosted runs without them (alerts are logged, no escalation).
 */
export interface FillFailsafeHooks {
  alert?: (type: string, message: string) => Promise<void>
  escalation?: { tick(): Promise<void> }
}

const LEADER_KEY = 'gainium:failsafe:leader'
const LEADER_TTL_MS = 90_000
const LEADER_RENEW_MS = 30_000

export class FillFailsafe {
  private cfg: FailsafeConfig
  private registry = new Registry()
  private feed: PriceFeed
  private counters = new Counters()
  private prober: Prober
  private sweeper: SweepPublisher
  private state: FilterState = { debounce: new Map(), thresholds: new Map() }
  private kill: KillState | null = null
  private exchangeKillCache = new Map<string, { off: boolean; at: number }>()
  private usageCooldowns = new Map<string, number>()

  /** Candidates awaiting the next coalesce flush. */
  private pending: Candidate[] = []
  /** Deltas since the last heartbeat write, reset each summary cycle. */
  private sweepsSinceHeartbeat = 0
  private errorsSinceHeartbeat = 0
  private timers: NodeJS.Timeout[] = []
  private leaderTimer: NodeJS.Timeout | null = null
  private stopping = false
  private leaderToken = `${process.pid}:${Date.now()}`

  constructor(
    cfg: FailsafeConfig = loadConfig(),
    private hooks: FillFailsafeHooks = {},
  ) {
    this.cfg = cfg
    this.feed = new PriceFeed((t) => this.onTick(t))
    this.prober = new Prober(this.probePort(), {
      pingMs: cfg.pingMs,
      ackGraceMs: cfg.ackGraceMs,
      deafMisses: cfg.deafMisses,
      alertCooldownMs: cfg.alertCooldownMs,
    })
    this.sweeper = new SweepPublisher((uuid, at, order) =>
      this.prober.trackSweep(uuid, at, order),
    )
  }

  /**
   * Every account that has a bot instance that may be running (spec 001
   * §4.3): the probe must reach every bot that could judge itself deaf, not
   * only accounts holding a registry-eligible resting LIMIT order. Status is
   * NOT a reliable "running" signal — `range`, `error`, `monitoring` and
   * `closed` (stop with `leave`) bots keep their engine and resting orders —
   * so only archived and deleted bots are excluded. Pinging `open` bots only
   * left bots in those statuses looping repair → a false user error every
   * few minutes. One aggregate per bot collection per round.
   */
  private async activeBotAccounts(): Promise<Set<string>> {
    const out = new Set<string>()
    for (const db of [dcaBotDb, comboBotDb, botDb]) {
      const res = await (db as typeof botDb).aggregate<{ _id: string }>([
        {
          $match: {
            status: { $ne: BotStatusEnum.archive },
            isDeleted: { $ne: true },
          },
        },
        { $group: { _id: '$exchangeUUID' } },
      ])
      if (res.status !== StatusEnum.ok) {
        logger.warn(
          `${LOG_PREFIX} open-bot accounts read failed: ${res.reason}`,
        )
        continue
      }
      for (const r of res.data?.result ?? []) if (r._id) out.add(String(r._id))
    }
    return out
  }

  /** The prober's I/O (spec 001): Redis pub/sub + hashes, rabbit, alerts. */
  private probePort(): ProbePort {
    const counters = this.counters
    return {
      publish: async (uuid, msg) => {
        const redis = await RedisClient.getInstance()
        if (!redis.instance) throw new Error('redis not ready')
        return redis.instance.publish(`userStreamInfo${uuid}`, msg)
      },
      readAcks: async (uuid) => {
        const redis = await RedisClient.getInstance()
        return (await redis.instance?.hGetAll(ackKey(uuid))) ?? null
      },
      writeDeaf: async (botId, rec) => {
        const redis = await RedisClient.getInstance()
        await redis.instance?.hSet(DEAF_BOTS_KEY, botId, JSON.stringify(rec))
        await redis.instance?.expire(DEAF_BOTS_KEY, DEAF_BOTS_TTL_SEC)
      },
      clearDeaf: async (botId) => {
        const redis = await RedisClient.getInstance()
        await redis.instance?.hDel(DEAF_BOTS_KEY, botId)
      },
      openBots: async (botIds) => {
        const ids = [...botIds].filter((id) => Types.ObjectId.isValid(id))
        const open = new Set<string>()
        if (!ids.length) return open
        const oids = ids.map((id) => new Types.ObjectId(id))
        for (const db of [dcaBotDb, comboBotDb, botDb]) {
          const res = await (db as typeof botDb).readData<{ _id: unknown }>(
            {
              _id: { $in: oids },
              status: BotStatusEnum.open,
              isDeleted: { $ne: true },
            } as never,
            { _id: 1 },
            {},
            true,
          )
          if (res.status !== StatusEnum.ok) {
            throw new Error(`bot status read failed: ${res.reason}`)
          }
          for (const r of res.data?.result ?? []) open.add(String(r._id))
        }
        return open
      },
      requestResubscribe: async (uuid) => {
        // Plain send, no reply wait: a wedged bot host must not stall the loop.
        const rabbit = new RabbitClient()
        for (const queue of [
          BotServiceQueues.dcaQueue,
          BotServiceQueues.gridQueue,
          BotServiceQueues.comboQueue,
          BotServiceQueues.hedgeDcaQueue,
          BotServiceQueues.hedgeComboQueue,
        ]) {
          await rabbit.send(queue, {
            method: 'resubscribeUserStream',
            params: [uuid],
          })
        }
        logger.info(
          `${LOG_PREFIX} SELF-HEAL resubscribeUserStream requested for uuid=${uuid}`,
        )
      },
      alert: async (type, message) => {
        if (this.hooks.alert) return this.hooks.alert(type, message)
        logger.warn(`${LOG_PREFIX} ALERT ${type}: ${message}`)
      },
      bump: (field, by = 1) => {
        void counters.bump('all', field, by)
      },
    }
  }

  private async acquireLeader(): Promise<boolean> {
    try {
      const redis = await RedisClient.getInstance()
      const client = redis.instance
      if (!client) return false
      const res = await client.set(LEADER_KEY, this.leaderToken, {
        NX: true,
        PX: LEADER_TTL_MS,
      })
      return res === 'OK'
    } catch (e) {
      logger.error(`${LOG_PREFIX} leader acquire error: ${e}`)
      return false
    }
  }

  private async renewLeader(): Promise<void> {
    try {
      const redis = await RedisClient.getInstance()
      const client = redis.instance
      if (!client) return
      const cur = await client.get(LEADER_KEY)
      if (cur === this.leaderToken) {
        await client.pExpire(LEADER_KEY, LEADER_TTL_MS)
      }
    } catch (e) {
      logger.error(`${LOG_PREFIX} leader renew error: ${e}`)
    }
  }

  /** Handle a single tick: run the pure filter, enqueue any new candidates. */
  private onTick(tick: Tick): void {
    const { candidates } = candidateFilter(
      this.registry.getOrders(),
      tick,
      this.state,
      this.cfg,
    )
    for (const c of candidates) {
      this.pending.push(c)
      void this.counters.bump(c.order.realExchange, 'candidates')
    }
  }

  /** Refresh registry from Mongo, rebuild thresholds, reconcile subscriptions. */
  private async refreshRegistry(): Promise<void> {
    const orders = await this.registry.refresh(this.cfg.exchangesSkip)
    this.state.thresholds = buildThresholds(orders)
    pruneDebounce(this.state, orders)
    await this.feed.sync(this.registry.getSymbolExchanges())
  }

  /** Coalesce flush: batch pending candidates and confirm per account. */
  private async flushConfirms(): Promise<void> {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.kill = await refreshKillSwitch(
      await RedisClient.getInstance(),
      this.kill,
    )

    const batches = coalesce(batch, this.cfg)
    for (const b of batches) {
      await this.confirmBatch(b.exchange, b.strategy, b.candidates)
    }
  }

  private async confirmBatch(
    exchange: ExchangeEnum,
    strategy: 'perOrder' | 'list',
    candidates: Candidate[],
  ): Promise<void> {
    const redis = await RedisClient.getInstance()
    const skip = await admitConfirm(redis, exchange, this.cfg, {
      kill: this.kill ?? {
        off: false,
        offExchanges: new Set(),
        shadow: false,
        fetchedAt: 0,
      },
      exchangeKillCache: this.exchangeKillCache,
      usageCooldowns: this.usageCooldowns,
    })
    if (skip) {
      const field: CounterField =
        skip === 'cap'
          ? 'skippedCap'
          : skip === 'congestion'
            ? 'skippedCongestion'
            : skip === 'usage'
              ? 'skippedUsage'
              : 'skippedKill'
      void this.counters.bump(exchange, field, candidates.length)
      // Skipped candidates keep crossed state; clear the active flag so they can
      // re-candidate on the next tick (TTL still bounds re-debounce).
      for (const c of candidates)
        clearCandidate(this.state, c.order.clientOrderId)
      return
    }

    const orders = candidates.map((c) => c.order)
    let results: RestingOrder[] = []
    if (strategy === 'list') {
      results = await confirmList(this.registry, orders)
    } /* else {
      results = await Promise.all(orders.map((o) => confirmOne(o)))
    } */

    // Usage backoff: cooldown the exchange if any response ran hot.
    /* const maxUsage = results.reduce((m, r) => Math.max(m, r.usageRatio), 0) */
    /* const until = usageCooldownDeadline(maxUsage, this.cfg) */
    /* if (until) this.usageCooldowns.set(exchange, until) */

    const shadow = this.cfg.shadow || (this.kill?.shadow ?? false)
    const byId = new Map(orders.map((o) => [o.clientOrderId, o]))
    for (const r of results) {
      const local = byId.get(r.clientOrderId)
      if (!local) continue
      await this.settle(exchange, local, r, shadow)
    }
  }

  private async settle(
    exchange: ExchangeEnum,
    local: RestingOrder,
    result: RestingOrder,
    shadow: boolean,
  ): Promise<void> {
    const outcome = await this.sweeper.handle(
      local,
      result,
      shadow,
      this.cfg.sweepCooldownMs,
      Date.now(),
      this.cfg.dormantMs,
    )
    if (outcome === 'clean') {
      // Confirmed false positive: FP cooldown + counter.
      markFalsePositive(this.state, local.clientOrderId, this.cfg)
      void this.counters.bump(exchange, 'falsePositive')
    } else if (outcome === 'diverged-dormant') {
      // No bot is listening on this account — the divergence is unresolvable
      // by sweeping. Park the ORDER for the full dormancy window too.
      void this.counters.bump(exchange, 'confirmed')
      markConfirmedDivergence(
        this.state,
        local.clientOrderId,
        this.cfg,
        Date.now(),
        this.cfg.dormantMs,
      )
    } else {
      void this.counters.bump(exchange, 'confirmed')
      // Full debounce reset + exponential-backoff cooldown — clearCandidate
      // alone leaves the order "crossed" and it re-candidates next tick.
      markConfirmedDivergence(this.state, local.clientOrderId, this.cfg)
      if (outcome === 'diverged-published') {
        this.sweepsSinceHeartbeat++
        void this.counters.bump(exchange, 'sweepsPublished')
      }
    }
  }

  private async summary(): Promise<void> {
    const exchanges = new Set<string>()
    for (const o of this.registry.getOrders()) exchanges.add(o.realExchange)
    // Probe/ack counters are fleet-wide, not per venue.
    exchanges.add('all')
    await this.counters.logSummary([...exchanges])
    const registry = this.registry.getOrders().length
    const subscribed = this.feed.subscribedCount()
    logger.info(
      `${LOG_PREFIX} registry=${registry} ` +
        `subscribed=${subscribed} pending=${this.pending.length}`,
    )
    // Liveness heartbeat for an external health check (and for the bots,
    // which read `pingMs`). The numbers are already computed above;
    // publishing them is one cheap Redis SET.
    await writeHeartbeat({
      ts: Date.now(),
      registry,
      subscribed,
      sweepsSinceLast: this.sweepsSinceHeartbeat,
      errorsSinceLast: this.errorsSinceHeartbeat,
      // Advertised only once the probe has actually reached the fleet twice
      // (see Prober.advertisedPingMs); bots judge silence only while > 0.
      pingMs: this.kill?.off ? 0 : this.prober.advertisedPingMs(),
    })
    this.sweepsSinceHeartbeat = 0
    this.errorsSinceHeartbeat = 0
  }

  private every(ms: number, fn: () => void | Promise<void>): void {
    const t = setInterval(() => {
      void Promise.resolve(fn()).catch((e) => {
        this.errorsSinceHeartbeat++
        logger.error(`${LOG_PREFIX} loop error: ${e}`)
      })
    }, ms)
    this.timers.push(t)
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) {
      logger.info(`${LOG_PREFIX} FF_ENABLED is not 'true' — detector idle.`)
      // Idle but alive so pm2 doesn't flap-restart; exits cleanly on signal.
      this.installSignals()
      return
    }

    const gotLeader = await this.acquireLeader()
    if (!gotLeader) {
      logger.warn(
        `${LOG_PREFIX} leader lock held elsewhere — this instance will exit.`,
      )
      process.exit(0)
      return
    }
    this.leaderTimer = setInterval(
      () => void this.renewLeader(),
      LEADER_RENEW_MS,
    )

    // L4 catch-rate escalation (spec §3.4), hosted here — see the cloud escalation hook
    // for why it does NOT run in the (never-started, staleness-flawed)
    // stream-watchdog. Respects the global kill switch.
    const escalation = this.hooks.escalation
    if (escalation && process.env.FF_ESCALATE_ENABLED !== 'false') {
      this.every(1_800_000, async () => {
        if (this.kill?.off) return
        await escalation.tick()
      })
    }

    logger.info(
      `${LOG_PREFIX} starting (shadow=${this.cfg.shadow}) — refresh=${this.cfg.ordersRefreshMs}ms ` +
        `debounce=${this.cfg.debounceMs}ms/${this.cfg.minTicks}ticks coalesce=${this.cfg.confirmCoalesceMs}ms ` +
        `skip=[${[...this.cfg.exchangesSkip].join(',')}]`,
    )

    await this.refreshRegistry()
    this.every(this.cfg.ordersRefreshMs, () => this.refreshRegistry())
    this.every(this.cfg.confirmCoalesceMs, () => this.flushConfirms())
    // Publish → receipt loop closure (spec 001): probe every registry account
    // and judge every due sweep/probe against the bots' ack hashes.
    if (this.cfg.pingMs > 0) {
      this.every(this.cfg.pingMs, async () => {
        if (this.kill?.off) return
        await this.prober.probe(
          this.registry.getOrders(),
          Date.now(),
          await this.activeBotAccounts(),
        )
      })
    }
    this.every(this.cfg.confirmCoalesceMs, () =>
      this.prober.checkAcks(this.registry.getOrders()),
    )
    this.every(this.cfg.snapshotMs, () =>
      this.feed.snapshot(this.cfg.snapshotMs),
    )
    this.every(60_000, () => this.summary())

    this.installSignals()
  }

  private installSignals(): void {
    const stop = () => void this.stop()
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    logger.info(`${LOG_PREFIX} stopping...`)
    for (const t of this.timers) clearInterval(t)
    if (this.leaderTimer) clearInterval(this.leaderTimer)
    try {
      const redis = await RedisClient.getInstance()
      const client = redis.instance
      if (client) {
        const cur = await client.get(LEADER_KEY)
        if (cur === this.leaderToken) await client.del(LEADER_KEY)
      }
      this.feed.stop()
    } catch (e) {
      logger.error(`${LOG_PREFIX} stop cleanup error: ${e}`)
    }
    process.exit(0)
  }
}

// Boot when run directly (no host hooks).
if (require.main === module) {
  new FillFailsafe().start().catch((e) => {
    logger.error(`${LOG_PREFIX} fatal: ${e}`)
    process.exit(1)
  })
}
