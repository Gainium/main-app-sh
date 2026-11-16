process.env.NODE_ENV = 'testing'

/**
 * Spec 246 §4.6: a combo grid order that cannot get onto the book keeps the
 * bot in `error` until it does. `error` is soft: every clean tick calls
 * `restoreFromRangeOrError()`, which on 2026-11-16 cleared the error seconds
 * after a stuck deal raised it, so the bot showed as healthy.
 *
 * Run: `npm test` (mocha). The real methods run off the `MainBot` prototype.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { BotStatusEnum, TypeOrderEnum } from '../../types'

const DEAL = '6a45014d7f4cfd7da4d17a1e'

const gridBuy = (over: Record<string, unknown> = {}): any => ({
  clientOrderId: 'CMB-GR-test',
  typeOrder: TypeOrderEnum.dealGrid,
  dealId: DEAL,
  side: 'BUY',
  price: '64380',
  origPrice: '74834.7',
  ...over,
})

function makeBot(openDeals: string[] = [DEAL]): any {
  const bot: any = Object.create(MainBot.prototype)
  bot.data = {
    status: BotStatusEnum.error,
    previousStatus: BotStatusEnum.open,
    workingShift: [],
  }
  bot.isDealStillOpen = (id: string) => openDeals.includes(id)
  bot.restored = 0
  // Count what the restore would have written instead of touching a DB.
  bot.updateData = () => {
    bot.restored++
  }
  bot.emit = () => true
  bot.trimWorkingShift = (w: unknown) => w
  bot.getWorkingTimeNumber = () => 0
  bot.handleLog = () => undefined
  return bot
}

describe('spec 246 §4.6 — a stuck grid order keeps the bot in error', () => {
  it('does not restore while a grid order on an open deal is stuck', () => {
    const bot = makeBot()
    bot.markGridOrderStuck(gridBuy())
    bot.restoreFromRangeOrError()
    expect(bot.data.status).to.equal(BotStatusEnum.error)
    expect(bot.restored).to.equal(0)
  })

  it('restores once the same grid level is placed, whatever its client id', () => {
    const bot = makeBot()
    bot.markGridOrderStuck(gridBuy())
    // The re-sent order carries a new client id and price, same level.
    bot.clearGridOrderStuck(
      gridBuy({ clientOrderId: 'CMB-GR-other', price: '64500' }),
    )
    expect(bot.hasStuckGridOrder()).to.equal(false)
  })

  it('stops holding the error once the deal is closed', () => {
    const bot = makeBot([])
    bot.markGridOrderStuck(gridBuy())
    expect(bot.hasStuckGridOrder()).to.equal(false)
  })

  it('ignores orders that are not combo grid orders', () => {
    const bot = makeBot()
    bot.markGridOrderStuck(gridBuy({ typeOrder: TypeOrderEnum.dealRegular }))
    bot.markGridOrderStuck(gridBuy({ dealId: undefined }))
    expect(bot.hasStuckGridOrder()).to.equal(false)
  })
})
