import RedisClient, { RedisWrapper } from '../db/redis'
import { KEYS, log, STALE_THRESHOLD_MS } from './utils'
import {
  tick,
  EMPTY_STATE,
  type WatchdogState,
  type WatchdogAction,
} from './stateMachine'

export type ActionDispatcher = (action: WatchdogAction) => Promise<void>

export async function runWatchdogTick(
  dispatch: ActionDispatcher,
): Promise<void> {
  const redis = await RedisClient.getInstance()
  const now = Date.now()

  // 1. Find everything currently past the freshness threshold.
  //    node-redis takes min/max as strings; '(' prefix = exclusive, same as raw Redis syntax.
  const staleIds = await redis.zRangeByScore(
    KEYS.lastEventTime,
    '-inf',
    `(${now - STALE_THRESHOLD_MS}`,
  )

  // 2. Also pull known incidents so we can detect recovery even for accounts
  //    that just dropped off the stale list this tick.
  const incidentIds = await redis.instance?.sMembers(KEYS.activeIncidents)

  const candidateIds = Array.from(
    new Set([...(staleIds ?? []), ...(incidentIds ?? [])]),
  )

  if (candidateIds.length === 0) return
  log(`debug`, `Found ${candidateIds.length} candidates`)
  const staleSet = new Set(staleIds ?? [])

  // 3. Batch-read consumer presence + state hash for every candidate in one round trip.
  //    Cast to `any` here: node-redis's multi() tracks each chained command's
  //    return type, which fights a dynamic-length loop. We parse raw replies
  //    by hand below anyway, so the precise typing buys us nothing here.
  const readMulti = redis.instance?.multi()
  if (!readMulti) return
  for (const id of candidateIds) {
    readMulti.exists(KEYS.hasConsumer(id)).hGetAll(KEYS.watchdogState(id))
  }
  const results = await readMulti.execAsPipeline()
  // results is a flat array, 2 entries per candidate, in the same order queued:
  // [exists0, hgetall0, exists1, hgetall1, ...]

  const writeMulti = redis.instance?.multi()

  if (!writeMulti) return

  for (let i = 0; i < candidateIds.length; i++) {
    const accountId = candidateIds[i]
    const existsResult = results[i * 2] as unknown as number // 1 or 0
    const stateResult = results[i * 2 + 1] as unknown as Record<string, string>

    const hasConsumer = existsResult === 1
    const state = parseState(stateResult)

    const { nextState, actions } = tick({
      accountId,
      now,
      isStale: staleSet.has(accountId),
      hasConsumer,
      state,
    })

    applyStateChange(writeMulti, accountId, state, nextState)

    for (const action of actions) {
      // fire-and-await outside the pipeline — these are side effects
      // (RPC to connector, pub/sub to bots), not Redis writes.
      await dispatch(action)
    }
  }

  await writeMulti.execAsPipeline()
}

function parseState(
  raw: Record<string, string> | null | undefined,
): WatchdogState {
  if (!raw || Object.keys(raw).length === 0) return { ...EMPTY_STATE }
  return {
    failureCount: Number(raw.failureCount ?? 0),
    lastAction: (raw.lastAction as WatchdogState['lastAction']) || null,
    nextCheckAt: Number(raw.nextCheckAt ?? 0),
  }
}

function applyStateChange(
  multi: ReturnType<NonNullable<RedisWrapper['_instance']>['multi']>,
  accountId: string,
  prevState: WatchdogState,
  nextState: WatchdogState | null,
): void {
  const stateKey = KEYS.watchdogState(accountId)

  if (nextState === null) {
    multi.del(stateKey).sRem(KEYS.activeIncidents, accountId)
    return
  }

  multi.hSet(stateKey, {
    failureCount: String(nextState.failureCount),
    lastAction: nextState.lastAction ?? '',
    nextCheckAt: String(nextState.nextCheckAt),
  })

  if (nextState.failureCount > 0 && prevState.failureCount === 0) {
    multi.sAdd(KEYS.activeIncidents, accountId)
  }
}
