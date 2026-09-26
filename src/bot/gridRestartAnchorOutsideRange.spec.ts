process.env.NODE_ENV = 'testing'

/**
 * A grid restarted after a range edit anchors its new orders on the last
 * filled order. When the range has moved away from that fill, the anchor
 * splits the new grid around a stale price: with a last fill at 1708.49 and a
 * new range of 2100-2700, every level became a SELL (two of them below the
 * market) and the restart asked for base the bot did not hold.
 *
 * `isPriceOnCurrentGrid` is the guard `swapAssets` uses to drop such an
 * anchor. It must still accept every price the current grid can fill at,
 * including the top level's displaced sell, so an unchanged grid keeps its
 * anchor.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'

let Helper: any

const makeBot = (settings: Record<string, number>) => {
  class TestBot extends Helper {
    public data: any = { settings }
  }
  return new (TestBot as any)()
}

describe('grid restart anchor outside the edited range', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('drops a fill from the range the user moved away from', () => {
    const bot = makeBot({ lowPrice: 2100, topPrice: 2700, sellDisplacement: 0.005 })
    expect(bot.isPriceOnCurrentGrid(1708.49)).to.equal(false)
    expect(bot.isPriceOnCurrentGrid(3000)).to.equal(false)
  })

  it('keeps fills at the edges of the current grid, incl. the displaced top sell', () => {
    const bot = makeBot({ lowPrice: 2100, topPrice: 2700, sellDisplacement: 0.005 })
    expect(bot.isPriceOnCurrentGrid(2100)).to.equal(true)
    expect(bot.isPriceOnCurrentGrid(2713.5)).to.equal(true)
    expect(bot.isPriceOnCurrentGrid(2362.15)).to.equal(true)
  })

  it('keeps the anchor of an unchanged grid whose top sell filled', () => {
    const bot = makeBot({ lowPrice: 1550, topPrice: 1700, sellDisplacement: 0.005 })
    expect(bot.isPriceOnCurrentGrid(1708.49)).to.equal(true)
    expect(bot.isPriceOnCurrentGrid(1550)).to.equal(true)
  })

  it('treats a missing price as off-grid', () => {
    const bot = makeBot({ lowPrice: 2100, topPrice: 2700, sellDisplacement: 0.005 })
    expect(bot.isPriceOnCurrentGrid(NaN)).to.equal(false)
  })
})
