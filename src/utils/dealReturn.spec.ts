process.env.NODE_ENV = 'testing'

/**
 * Regression test — the Deal Returns series stopped at the newest 500 closed
 * deals, so a bot with more than 500 left the older part of the chart empty.
 *
 * Enforces specs/132 §4.1–§4.3.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DCADealStatusEnum } from '../../types'
import { dealReturnsPipeline } from './dealReturn'

describe('specs/132 — Deal Returns series covers every closed deal', () => {
  const pipeline = dealReturnsPipeline('user-1', 'bot-1')
  const stageNames = pipeline.map((s) => Object.keys(s)[0])

  it('§4.1 has no stage that bounds the number of deals', () => {
    expect(stageNames).to.not.include('$limit')
    expect(stageNames).to.not.include('$sample')
    expect(stageNames).to.not.include('$skip')
  })

  it("§4.2 selects the user's own closed and canceled deals of that bot", () => {
    expect(pipeline[0]).to.deep.equal({
      $match: {
        userId: 'user-1',
        botId: 'bot-1',
        status: {
          $in: [DCADealStatusEnum.closed, DCADealStatusEnum.canceled],
        },
      },
    })
  })

  it('§4.3 orders by close time, newest first', () => {
    expect(pipeline).to.deep.include({ $sort: { closeTime: -1 } })
  })
})
