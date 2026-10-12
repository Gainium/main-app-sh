process.env.NODE_ENV = 'testing'

/**
 * Conditional cooldown after deal stop. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  cooldownTriggersForClose,
  lastCloseForCooldown,
  recordCooldownTriggers,
} from './cooldownStopTrigger'
import {
  CooldownOptionsEnum,
  CooldownStopTriggerEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
} from '../../../types'

const closed = DCADealStatusEnum.closed
const SL = CooldownStopTriggerEnum.sl
const LOSS = CooldownStopTriggerEnum.loss

describe('cooldownStopTrigger', () => {
  describe('cooldownTriggersForClose', () => {
    it('a stop-loss close at a loss matches both sl and loss', () => {
      expect(
        cooldownTriggersForClose({
          status: closed,
          closeTrigger: DCACloseTriggerEnum.sl,
          profit: { total: -5 },
        }),
      ).to.deep.equal(['sl', 'loss'])
    })

    it('a stop loss moved into profit is sl but not loss', () => {
      expect(
        cooldownTriggersForClose({
          status: closed,
          closeTrigger: DCACloseTriggerEnum.sl,
          profit: { total: 2 },
        }),
      ).to.deep.equal(['sl'])
    })

    it('a liquidation is a stop loss', () => {
      expect(
        cooldownTriggersForClose({
          status: closed,
          closeTrigger: DCACloseTriggerEnum.liquidation,
          profit: { total: -100 },
        }),
      ).to.deep.equal(['sl', 'loss'])
    })

    it('a manual close at a loss is loss only', () => {
      expect(
        cooldownTriggersForClose({
          status: closed,
          closeTrigger: DCACloseTriggerEnum.manual,
          profit: { total: -1 },
        }),
      ).to.deep.equal(['loss'])
    })

    it('a take profit and a trailing take profit match nothing', () => {
      for (const closeTrigger of [
        DCACloseTriggerEnum.tp,
        DCACloseTriggerEnum.trailing,
      ]) {
        expect(
          cooldownTriggersForClose({
            status: closed,
            closeTrigger,
            profit: { total: 3 },
          }),
        ).to.deep.equal([])
      }
    })

    it('a cancelled deal matches nothing', () => {
      expect(
        cooldownTriggersForClose({
          status: DCADealStatusEnum.canceled,
          closeTrigger: DCACloseTriggerEnum.sl,
          profit: { total: -1 },
        }),
      ).to.deep.equal([])
    })
  })

  describe('lastCloseForCooldown', () => {
    const data = {
      lastClosedDeal: 300,
      lastClosedDealPerSymbol: [
        { symbol: 'A', time: 300 },
        { symbol: 'B', time: 250 },
      ],
      ...recordCooldownTriggers(
        recordCooldownTriggers({}, [SL, LOSS], 100, 'A'),
        [LOSS],
        200,
        'B',
      ),
    }

    it('any (and missing) measures from the last close of any kind', () => {
      for (const trigger of [undefined, CooldownStopTriggerEnum.any]) {
        expect(
          lastCloseForCooldown(data, trigger, CooldownOptionsEnum.bot, 'A'),
        ).to.equal(300)
        expect(
          lastCloseForCooldown(data, trigger, CooldownOptionsEnum.symbol, 'B'),
        ).to.equal(250)
      }
    })

    it('a later winning close does not move a conditional cooldown', () => {
      expect(
        lastCloseForCooldown(
          data,
          CooldownStopTriggerEnum.loss,
          CooldownOptionsEnum.bot,
          'A',
        ),
      ).to.equal(200)
      expect(
        lastCloseForCooldown(
          data,
          CooldownStopTriggerEnum.sl,
          CooldownOptionsEnum.bot,
          'B',
        ),
      ).to.equal(100)
    })

    it('per symbol reads that symbol only', () => {
      expect(
        lastCloseForCooldown(
          data,
          CooldownStopTriggerEnum.loss,
          CooldownOptionsEnum.symbol,
          'A',
        ),
      ).to.equal(100)
      expect(
        lastCloseForCooldown(
          data,
          CooldownStopTriggerEnum.sl,
          CooldownOptionsEnum.symbol,
          'B',
        ),
      ).to.equal(0)
    })

    it('a bot with no recorded conditional close has no cooldown', () => {
      expect(
        lastCloseForCooldown(
          { lastClosedDeal: 300 },
          CooldownStopTriggerEnum.loss,
          CooldownOptionsEnum.bot,
          'A',
        ),
      ).to.equal(0)
    })
  })

  describe('recordCooldownTriggers', () => {
    it('keeps the other trigger and symbols untouched', () => {
      const before = recordCooldownTriggers({}, [SL, LOSS], 100, 'A')
      const after = recordCooldownTriggers(before, [LOSS], 200, 'A')
      expect(after.lastClosedDealByTrigger).to.deep.equal({
        sl: 100,
        loss: 200,
      })
      expect(after.lastClosedDealByTriggerPerSymbol).to.deep.equal([
        { symbol: 'A', sl: 100, loss: 200 },
      ])
      // input not mutated
      expect(before.lastClosedDealByTrigger).to.deep.equal({
        sl: 100,
        loss: 100,
      })
    })
  })
})
