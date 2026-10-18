process.env.NODE_ENV = 'testing'

/**
 * Main-app spec 044 §8.9 — a hedge DCA leg's deal must keep its start
 * `action` through the REAL mongoose schema. `createDeal` writes it, the deal
 * is rebuilt from the saved document, and `placeBaseOrder` routes on it; with
 * no `action` path in the DCA deal schema mongoose dropped it (strict mode)
 * and a hedge DCA leg sent a plain base order instead of funding itself.
 *
 * No database: a document is built with the model and read back.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import models from './model'
import { ActionsEnum } from '../../types'

const fields = {
  botId: 'b',
  userId: 'u',
  exchange: 'binance',
  exchangeUUID: 'x',
  parentBotId: 'hedge',
  action: ActionsEnum.buyDiff,
  botFunding: {
    mode: 'auto',
    virtualEntry: { qty: 1, price: 100, quoteReserved: 0, baseReserved: 1 },
    pendingTrade: { clientOrderId: 'D-FND-1', side: 'BUY', qty: 2, at: 1 },
    lotIds: ['l1'],
    sourcedByBot: false,
  },
  fundingHold: { asset: 'quote', committed: 197, remaining: 97 },
}

describe('deal schema keeps the hedge funding fields (spec 044 §8.9)', () => {
  for (const [name, model] of [
    ['DCA', models.dcaDeal],
    ['combo', models.comboDeal],
  ] as const) {
    it(`${name}: action, parentBotId, botFunding and fundingHold survive the schema`, () => {
      const doc = new (model as any)(fields).toObject()
      expect(doc.action).to.equal(ActionsEnum.buyDiff)
      expect(doc.parentBotId).to.equal('hedge')
      expect(doc.botFunding.virtualEntry.baseReserved).to.equal(1)
      expect(doc.botFunding.pendingTrade).to.deep.include({
        clientOrderId: 'D-FND-1',
        qty: 2,
      })
      expect(doc.fundingHold).to.deep.equal({
        asset: 'quote',
        committed: 197,
        remaining: 97,
      })
    })

    it(`${name}: an unknown action is rejected`, () => {
      const err = new (model as any)({
        ...fields,
        action: 'buyEverything',
      }).validateSync()
      expect(err?.errors?.action).to.not.equal(undefined)
    })
  }
})
