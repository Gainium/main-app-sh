process.env.NODE_ENV = 'testing'

/**
 * A DCA bot holds ONE Redis listener per indicator room, serving every config
 * of the bot in that room. Unsubscribing one config (a deal moving past its
 * DCA level, a closed deal) must not remove the listener while another config
 * of the bot is still in the room — e.g. a second deal on the same pair whose
 * next level uses the same indicator.
 *
 * Run: `npm test` (mocha). No stack: the real subscribe/unsubscribe methods
 * run off the DCA helper prototype with the rabbit and Redis clients stubbed.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'

const Helper: any = createDCABotHelper(MainBot as any)
const ROOM = 'rsi-14rsi-binance-BTCUSDT-1h'

function makeBot(opts: { unsubscribeFails?: boolean } = {}) {
  const listeners = new Map<string, Set<unknown>>()
  let n = 0
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: 'bot1',
    botType: 'dca',
    indicatorTimeout: 1000,
    indicatorRoomConfigMap: new Map(),
    indicatorConfigIdMap: new Map(),
    indicatorSubscribedRooms: new Set(),
    indicatorRoomCb: new Map(),
    data: { settings: { indicators: [], pair: [] } },
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    rabbitClient: {
      sendWithCallback: async (_q: string, msg: any) =>
        msg.event === 'subscribeIndicator'
          ? { response: { status: true, room: ROOM, id: `sub${++n}` } }
          : opts.unsubscribeFails
            ? null // timed out / no answer from the indicator service
            : { response: true },
    },
    redisSubIndicators: {
      subscribe: (room: string, cb: unknown) => {
        const s = listeners.get(room) ?? new Set()
        s.add(cb)
        listeners.set(room, s)
      },
      unsubscribe: (room: string, cb: unknown) => {
        listeners.get(room)?.delete(cb)
      },
    },
  })
  const subscribe = (uuid: string) =>
    bot.sendIndicatorSubscribeEvent({
      event: 'subscribeIndicator',
      botId: 'bot1',
      data: {},
      responseId: 'r',
      responseParams: { uuid, symbol: 'BTCUSDT' },
      type: 'dca',
    })
  const unsubscribe = (r: { id: string; room: string; cb: unknown }) =>
    bot.sendIndicatorUnsubscribeEvent(r.id, r.room, r.cb)
  return { bot, listeners, subscribe, unsubscribe }
}

describe('DCA bot indicator room listener', () => {
  it('stays while another config of the bot is still in the room', async () => {
    const { bot, listeners, subscribe, unsubscribe } = makeBot()
    const first = await subscribe('level2') // registers the room listener
    await subscribe('level3') // same room, another deal's next level
    await unsubscribe(first) // the first deal moves on
    expect(listeners.get(ROOM)?.size).to.equal(1)
    // …and the config still in the room keeps receiving the room's data.
    const got: string[] = []
    bot.indicatorDataCb = (_id: string, m: any) =>
      got.push(m.responseParams.uuid)
    for (const cb of listeners.get(ROOM) ?? []) {
      ;(cb as (m: string) => void)(JSON.stringify({ data: [], price: 1 }))
    }
    expect(got).to.deep.equal(['level3'])
  })

  it('goes with the last config, and comes back on the next subscribe', async () => {
    const { listeners, subscribe, unsubscribe } = makeBot()
    const a = await subscribe('level2')
    const b = await subscribe('level3')
    await unsubscribe(b)
    await unsubscribe(a)
    expect(listeners.get(ROOM)?.size ?? 0).to.equal(0)
    await subscribe('level4')
    expect(listeners.get(ROOM)?.size).to.equal(1)
  })

  it('a failed unsubscribe still stops the dropped config getting data', async () => {
    const { bot, listeners, subscribe, unsubscribe } = makeBot({
      unsubscribeFails: true,
    })
    const a = await subscribe('level2')
    const b = await subscribe('level3')
    await unsubscribe(a)
    const got: string[] = []
    bot.indicatorDataCb = (_id: string, m: any) =>
      got.push(m.responseParams.uuid)
    for (const cb of listeners.get(ROOM) ?? []) {
      ;(cb as (m: string) => void)(JSON.stringify({ data: [], price: 1 }))
    }
    expect(got).to.deep.equal(['level3'])
    // …and the last one leaving drops the room listener.
    await unsubscribe(b)
    expect(listeners.get(ROOM)?.size ?? 0).to.equal(0)
    expect(bot.indicatorRoomConfigMap.has(ROOM)).to.equal(false)
  })
})
