process.env.NODE_ENV = 'testing'

/**
 * A close request for a deal that is no longer open names the state it ended
 * in instead of answering "Deal not found".
 *
 * A dashboard that missed the deal's close event still lists it as open; the
 * user's Close then hit the open-only lookup and got "Deal not found", which
 * reads as a platform fault and gets retried. The client keys its recovery off
 * this reason, so it is pinned here for both the DCA and the combo path.
 *
 * The real methods are driven off the prototype with a fake deals collection:
 * no Mongo, no worker threads.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot from './index'
import { DCADealStatusEnum, StatusEnum } from '../../types'

const USER_ID = 'user-1'
const DEAL_ID = 'deal-1'

/**
 * A deals collection holding one deal in `status`, or none. Honours the
 * open-only `$nin` filter the close lookup uses.
 */
const dealsDb = (status?: DCADealStatusEnum) => ({
  readData: async (search: { status?: { $nin?: string[] } }) => {
    const excluded = search.status?.$nin ?? []
    const result =
      status && !excluded.includes(status)
        ? { _id: DEAL_ID, userId: USER_ID, botId: 'bot-1', status }
        : null
    return { status: StatusEnum.ok, reason: null, data: { result } }
  },
})

const harness = (status?: DCADealStatusEnum) => {
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaDealsDb = dealsDb(status)
  bot.comboDealsDb = dealsDb(status)
  return bot
}

for (const method of ['closeDCADeal', 'closeComboDeal'] as const) {
  describe(`Bot.${method} on a deal that is not open`, () => {
    it('names an already-closed deal', async () => {
      const res = await harness(DCADealStatusEnum.closed)[method](
        USER_ID,
        '',
        DEAL_ID,
      )
      expect(res).to.deep.equal({
        status: StatusEnum.notok,
        reason: 'Deal already closed',
        data: null,
      })
    })

    it('names an already-canceled deal', async () => {
      const res = await harness(DCADealStatusEnum.canceled)[method](
        USER_ID,
        '',
        DEAL_ID,
      )
      expect(res.reason).to.equal('Deal already canceled')
    })

    it('still answers "Deal not found" for a deal that does not exist', async () => {
      const res = await harness()[method](USER_ID, '', DEAL_ID)
      expect(res.reason).to.equal('Deal not found')
    })
  })
}
