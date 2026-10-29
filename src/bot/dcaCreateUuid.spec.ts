process.env.NODE_ENV = 'testing'

/**
 * A DCA bot's `uuid` is the key `/trade_signal` routes a webhook by, so the
 * server mints it on create. A `uuid` that arrives with the settings (an
 * imported settings file, an API client echoing a read) is dropped: it is
 * neither the bot's uuid nor stored inside its settings.
 *
 * Drives the REAL `prepareDCABot` on an `Object.create`-d `Bot`; the user and
 * pair reads are stubbed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum, StrategyEnum } from '../../types'
import Bot from './index'

const SUPPLIED = '11111111-2222-4333-8444-555555555555'

function makeBot() {
  const bot: any = Object.create(Bot.prototype)
  bot.userDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: { _id: 'user-1' } },
    }),
  }
  bot.pairsDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: [] },
    }),
  }
  return bot
}

const settings = (extra: Record<string, unknown> = {}) => ({
  pair: ['BTC_USDT'],
  baseAsset: ['BTC'],
  quoteAsset: ['USDT'],
  strategy: StrategyEnum.long,
  exchange: ExchangeEnum.paperBinance,
  exchangeUUID: 'exchange-1',
  indicators: [],
  indicatorGroups: [],
  ...extra,
})

describe('DCA create mints the bot uuid', () => {
  it('drops a uuid supplied with the settings', async () => {
    const result = await makeBot().prepareDCABot(
      'user-1',
      settings({ uuid: SUPPLIED }),
      true,
    )
    expect(result.status).to.equal(StatusEnum.ok)
    expect(result.data.uuid).to.be.a('string').and.not.equal(SUPPLIED)
    expect(result.data.settings).to.not.have.property('uuid')
  })

  it('mints a distinct uuid per bot', async () => {
    const a = await makeBot().prepareDCABot('user-1', settings(), true)
    const b = await makeBot().prepareDCABot('user-1', settings(), true)
    expect(a.data.uuid).to.be.a('string').with.length(36)
    expect(a.data.uuid).to.not.equal(b.data.uuid)
  })
})
