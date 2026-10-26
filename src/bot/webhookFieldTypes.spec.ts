process.env.NODE_ENV = 'testing'

/**
 * A webhook's `uuid`, `action` and `signalId` are plain text. A JSON body can
 * carry an object, an array or a number in those fields instead; such a signal
 * is answered 400 with the reason, before any bot lookup and before any
 * notice, and a plain text signal is handled exactly as before.
 *
 * The real methods are driven off the prototype with fake state: no Mongo, no
 * worker threads, no rabbit. Fixture ids are synthetic — this file is public.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot from './index'
import {
  malformedWebhookFields,
  malformedWebhookFieldsReason,
  WEBHOOK_TEXT_FIELD_MAX_CHARS,
} from '../server/tradeSignalContract'
import { StatusEnum } from '../../types'

const UUID = '00000000-0000-4000-8000-000000000001'
const BOT_ID = 'bot-field-types-1'

const harness = (useBots: boolean) => {
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = useBots
  bot.dcaBots = []
  bot.comboBots = []
  bot.hedgeComboBots = []
  bot.hedgeDcaBots = []
  bot.restartBotIdByUuid = new Map()
  bot.restartFinishedIds = new Set()
  bot.restartWindowOpen = false
  bot.warnings = [] as string[]
  bot.handleWarn = (m: string) => bot.warnings.push(m)
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.filters = [] as unknown[]
  bot.notices = [] as unknown[]
  bot.sent = [] as unknown[]
  // Any filter at all resolves to the bot, as an operator filter would in Mongo.
  const db = {
    readData: async (filter: unknown) => {
      bot.filters.push(filter)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: {
          result: { _id: BOT_ID, status: 'closed', userId: 'someone-else' },
        },
      }
    },
  }
  bot.dcaBotDb = db
  bot.comboBotDb = db
  bot.noticeWebhookSignal = (n: unknown) => bot.notices.push(n)
  bot.claimWebhookSignal = async () => true
  bot.sendWebhookToService = async (...args: unknown[]) => {
    bot.sent.push(args)
    return StatusEnum.ok
  }
  return bot
}

const crafted: [string, unknown][] = [
  ['a $regex object', { $regex: '.*' }],
  ['a $ne object', { $ne: null }],
  ['an array', [UUID]],
]

describe('malformedWebhookFields', () => {
  it('accepts a plain text signal', () => {
    expect(
      malformedWebhookFields({ action: 'startBot', uuid: UUID, signalId: UUID }),
    ).to.deep.equal([])
  })
  it('leaves absent and empty fields to missingWebhookFields', () => {
    expect(malformedWebhookFields({})).to.deep.equal([])
    expect(malformedWebhookFields({ action: '', uuid: null })).to.deep.equal([])
    expect(malformedWebhookFields(undefined)).to.deep.equal([])
  })
  it('names every field that is not text, or is too long', () => {
    expect(
      malformedWebhookFields({
        action: ['startBot'],
        uuid: { $ne: null },
        signalId: 'x'.repeat(WEBHOOK_TEXT_FIELD_MAX_CHARS + 1),
      }),
    ).to.deep.equal(['action', 'uuid', 'signalId'])
    expect(malformedWebhookFields({ action: 'startBot', uuid: 42 })).to.deep.equal(
      ['uuid'],
    )
  })
  it('accepts a field of exactly the maximum length', () => {
    expect(
      malformedWebhookFields({
        action: 'startBot',
        uuid: 'x'.repeat(WEBHOOK_TEXT_FIELD_MAX_CHARS),
      }),
    ).to.deep.equal([])
  })
})

describe('API intake (webhookProcess, no bots)', () => {
  for (const [name, uuid] of crafted) {
    it(`answers 400 for ${name} as uuid, with no bot lookup and no notice`, async () => {
      const bot = harness(false)
      const res = await bot.webhookProcess({ action: 'startBot', uuid })
      expect(res).to.deep.equal({
        status: StatusEnum.notok,
        reason: malformedWebhookFieldsReason(['uuid']),
        data: null,
      })
      expect(bot.filters).to.deep.equal([])
      expect(bot.sent).to.deep.equal([])
      expect(bot.notices).to.deep.equal([])
    })
  }
  it('refuses the whole batch when one item is malformed', async () => {
    const bot = harness(false)
    const res = await bot.webhookProcess([
      { action: 'closeDeal', uuid: UUID },
      { action: 'startDeal', uuid: { $ne: null } },
    ])
    expect(res.status).to.equal(StatusEnum.notok)
    expect(bot.filters).to.deep.equal([])
    expect(bot.sent).to.deep.equal([])
  })
  it('still routes a plain text signal', async () => {
    const bot = harness(false)
    const res = await bot.webhookProcess({ action: 'startBot', uuid: UUID })
    expect(res).to.equal(StatusEnum.ok)
    expect(bot.filters).to.deep.equal([{ uuid: UUID }])
    expect(bot.sent).to.have.length(1)
  })
})

describe('bot service (singleWebhookProcess)', () => {
  for (const action of ['startBot', 'changePairs', 'stopBot']) {
    for (const [name, uuid] of crafted) {
      it(`answers 400 for ${action} with ${name} as uuid, with no bot lookup and no notice`, async () => {
        const bot = harness(true)
        const res = await bot.singleWebhookProcess({
          action,
          uuid,
          pairsToSet: ['BTC_USDT'],
          receivedAt: Date.now(),
        })
        expect(res).to.deep.equal({
          status: StatusEnum.notok,
          reason: malformedWebhookFieldsReason(['uuid']),
          data: null,
        })
        expect(bot.filters).to.deep.equal([])
        expect(bot.notices).to.deep.equal([])
      })
    }
  }
  it('answers 400 for an object action or signalId', async () => {
    const bot = harness(true)
    const res = await bot.singleWebhookProcess({
      action: { $ne: null },
      uuid: UUID,
      signalId: ['x'],
    })
    expect(res.reason).to.equal(
      malformedWebhookFieldsReason(['action', 'signalId']),
    )
    expect(bot.filters).to.deep.equal([])
  })
  it('still looks up a stopped bot for a plain text uuid', async () => {
    const bot = harness(true)
    const res = await bot.singleWebhookProcess({
      action: 'stopBot',
      uuid: UUID,
      receivedAt: Date.now(),
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.match(/Bot is stopped/)
    expect(bot.filters[0]).to.deep.equal({ uuid: UUID, isDeleted: { $ne: true } })
    expect(bot.notices).to.have.length(1)
  })
})

describe('lookups refuse a non-text uuid on their own', () => {
  it('webhookBotType and webhookBotStatus query nothing', async () => {
    const bot = harness(true)
    expect(await bot.webhookBotType({ $ne: null })).to.equal(undefined)
    expect(await bot.webhookBotStatus({ $regex: '.*' })).to.equal(undefined)
    expect(bot.filters).to.deep.equal([])
  })
})
