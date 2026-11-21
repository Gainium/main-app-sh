import { describe, it } from 'mocha'
import { expect } from 'chai'
import { dealSettingsDiffFromBot, sameSettingValue } from './dealSettingsDiff'

describe('spec 250 — deal settings that differ from the bot', () => {
  const bot = {
    useTp: true,
    tpPerc: '3',
    useSl: false,
    slPerc: '-10',
    useDca: true,
    ordersCount: 8,
    useSmartOrders: false,
    activeOrdersCount: 2,
    multiTp: [],
    tpExecution: { mode: 'limit', timeoutSec: 0 },
    dcaIndicatorLevels: [{ orderSize: '1', minPercFromLast: '2' }],
  }

  it('an untouched copy differs in nothing', () => {
    expect(
      dealSettingsDiffFromBot(
        {
          ...bot,
          avgPrice: 100,
          changed: false,
          // Mongo adds ids to sub-documents; they are not settings.
          dcaIndicatorLevels: [
            { _id: 'x1', orderSize: '1', minPercFromLast: '2' },
          ],
          tpExecution: { timeoutSec: 0, mode: 'limit' },
        },
        bot,
      ),
    ).to.deep.equal([])
  })

  it('compares by value: "3" equals 3, equal objects are equal', () => {
    expect(sameSettingValue('3', 3)).to.equal(true)
    expect(sameSettingValue({ a: 1, b: [2] }, { b: [2], a: '1' })).to.equal(
      true,
    )
    expect(sameSettingValue(undefined, false)).to.equal(true)
    expect(sameSettingValue('3', '5')).to.equal(false)
  })

  it('lists exactly the settings the edit changed', () => {
    expect(
      dealSettingsDiffFromBot(
        {
          ...bot,
          tpPerc: '5',
          tpExecution: { mode: 'chase', timeoutSec: 35 },
        },
        bot,
      ),
    ).to.deep.equal(['tpExecution', 'tpPerc'])
  })

  it('ignores stop-loss sub-settings while stop loss is off on both', () => {
    expect(
      dealSettingsDiffFromBot({ ...bot, slPerc: '-20' }, bot),
    ).to.deep.equal([])
    expect(
      dealSettingsDiffFromBot({ ...bot, useSl: true, slPerc: '-20' }, bot),
    ).to.deep.equal(['slPerc', 'useSl'])
  })

  it('ignores the smart-orders count while smart orders are off on both', () => {
    expect(
      dealSettingsDiffFromBot({ ...bot, activeOrdersCount: 5 }, bot),
    ).to.deep.equal([])
  })

  it('ignores the single-target echo while multiple targets are off', () => {
    expect(
      dealSettingsDiffFromBot(
        { ...bot, useMultiTp: false, multiTp: [{ target: '5', amount: '100' }] },
        { ...bot, useMultiTp: false },
      ),
    ).to.deep.equal([])
  })

  it('does not compare deal-side copies the bot does not carry', () => {
    expect(
      dealSettingsDiffFromBot(
        { ...bot, orderSizePercQty: 0, dcaIndicatorLevels: [{ orderSize: '1' }] },
        (({ dcaIndicatorLevels: _omit, ...rest }) => rest)(bot),
      ),
    ).to.deep.equal([])
  })

  it('an execution block is not compared against a bot that has none', () => {
    const legacyBot = { ...bot, tpExecution: null, closeOrderType: 'LIMIT' }
    expect(
      dealSettingsDiffFromBot(
        { ...legacyBot, tpExecution: { mode: 'limit', timeoutSec: 0 } },
        legacyBot,
      ),
    ).to.deep.equal([])
    // The mirrored field still tells a real change apart.
    expect(
      dealSettingsDiffFromBot(
        {
          ...legacyBot,
          tpExecution: { mode: 'market' },
          closeOrderType: 'MARKET',
        },
        legacyBot,
      ),
    ).to.deep.equal(['closeOrderType'])
  })

  it('a deal-only key counts only when it holds a value', () => {
    expect(
      dealSettingsDiffFromBot({ ...bot, dcaLevelsCap: undefined }, bot),
    ).to.deep.equal([])
    expect(
      dealSettingsDiffFromBot({ ...bot, dcaLevelsCap: 3 }, bot),
    ).to.deep.equal(['dcaLevelsCap'])
  })
})
