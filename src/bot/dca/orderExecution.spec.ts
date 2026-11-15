process.env.NODE_ENV = 'testing'

/**
 * Spec `242` — order execution modes. Pure decisions only:
 *  - which execution a stage uses (stored field, else derived from the legacy
 *    fields so existing bots behave exactly as before) — §2, §3, §4.4;
 *  - when a bot-driven limit close is re-priced or sent to market — §4.3;
 *  - the max-chase cap on a close price — §4.3 / §5.2.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  clampChasePrice,
  closeTypeForStage,
  entryChaseCapPerc,
  entryOrderType,
  entrySplitEligible,
  planSplitSizes,
  splitFloorBreached,
  restingTpTimeoutMs,
  triggerFromCloseCondition,
  validateOrderExecution,
  closeTimerPlan,
  resolveExecution,
  stageForClose,
} from './orderExecution'
import {
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  OrderTypeEnum,
} from '../../../types'

describe('spec 242 — resolveExecution legacy derivation (§3)', () => {
  it('entry: MARKET → market', () => {
    expect(
      resolveExecution(
        'entry',
        { startOrderType: OrderTypeEnum.market },
        'start',
      ),
    ).to.deep.include({ mode: 'market' })
  })
  it('entry: LIMIT with repositioning → chase, 10 s, no cap, timeout from Enter Market Timeout', () => {
    expect(
      resolveExecution(
        'entry',
        {
          startOrderType: OrderTypeEnum.limit,
          useLimitTimeout: true,
          limitTimeout: '20',
        },
        'start',
      ),
    ).to.deep.include({
      mode: 'chase',
      repriceSec: 10,
      maxChasePerc: 0,
      timeoutSec: 20,
    })
  })
  it('entry: LIMIT with switch off → chase with no timeout (spec 100 opt-in)', () => {
    expect(
      resolveExecution(
        'entry',
        { startOrderType: OrderTypeEnum.limit },
        'start',
      ),
    ).to.deep.include({ mode: 'chase', timeoutSec: 0 })
  })
  it('entry: LIMIT, repositioning disabled → limit', () => {
    expect(
      resolveExecution(
        'entry',
        { startOrderType: OrderTypeEnum.limit, notUseLimitReposition: true },
        'start',
      ),
    ).to.deep.include({ mode: 'limit', timeoutSec: 0 })
  })
  it('dca: dcaByMarket → market, else resting limit; indicator DCA → market', () => {
    expect(
      resolveExecution('dca', { dcaByMarket: true }, 'level').mode,
    ).to.equal('market')
    expect(
      resolveExecution('dca', { dcaByMarket: false }, 'level'),
    ).to.deep.include({
      mode: 'limit',
      timeoutSec: 0,
    })
    expect(
      resolveExecution('dca', { dcaByMarket: false }, 'indicator').mode,
    ).to.equal('market')
  })
  it('tp, DCA, price level: closeOrderType decides; LIMIT rests with no timeout', () => {
    expect(
      resolveExecution('tp', { closeOrderType: OrderTypeEnum.market }, 'level')
        .mode,
    ).to.equal('market')
    expect(resolveExecution('tp', {}, 'level')).to.deep.include({
      mode: 'limit',
      timeoutSec: 0,
    })
  })
  it('tp, DCA, indicator/webhook: closeDealType closeByLimit → chase with the 35 s fallback', () => {
    expect(
      resolveExecution(
        'tp',
        { closeDealType: CloseDCATypeEnum.closeByLimit },
        'indicator',
      ),
    ).to.deep.include({ mode: 'chase', timeoutSec: 35 })
    expect(
      resolveExecution(
        'tp',
        { closeDealType: CloseDCATypeEnum.closeByMarket },
        'webhook',
      ).mode,
    ).to.equal('market')
  })
  it('tp/sl, combo: comboTpLimit / comboSlLimit → chase', () => {
    expect(
      resolveExecution('tp', { comboTpLimit: true }, 'level', { isCombo: true })
        .mode,
    ).to.equal('chase')
    expect(
      resolveExecution('sl', { comboSlLimit: true }, 'level', { isCombo: true })
        .mode,
    ).to.equal('chase')
    expect(
      resolveExecution('sl', { comboSlLimit: false }, 'level', {
        isCombo: true,
      }).mode,
    ).to.equal('market')
  })
  it('sl, DCA: indicator follows closeDealType; percentage/ATR/webhook are market', () => {
    expect(
      resolveExecution(
        'sl',
        { closeDealType: CloseDCATypeEnum.closeByLimit },
        'indicator',
      ).mode,
    ).to.equal('chase')
    expect(
      resolveExecution(
        'sl',
        { closeDealType: CloseDCATypeEnum.closeByLimit },
        'level',
      ).mode,
    ).to.equal('market')
    expect(
      resolveExecution(
        'sl',
        { closeDealType: CloseDCATypeEnum.closeByLimit },
        'webhook',
      ).mode,
    ).to.equal('market')
  })
  it('close (manual/bot/api): the close type passed decides', () => {
    expect(
      resolveExecution('close', {}, 'manual', {
        closeType: CloseDCATypeEnum.closeByLimit,
      }),
    ).to.deep.include({ mode: 'chase', timeoutSec: 35 })
    expect(
      resolveExecution('close', {}, 'manual', {
        closeType: CloseDCATypeEnum.closeByMarket,
      }).mode,
    ).to.equal('market')
  })
})

describe('spec 242 — stored execution wins, fitted to the trigger (§2.4, §4.4)', () => {
  it('a stored execution is used as is', () => {
    expect(
      resolveExecution(
        'tp',
        {
          closeOrderType: OrderTypeEnum.market,
          tpExecution: { mode: 'limit', timeoutSec: 60 },
        },
        'level',
      ),
    ).to.deep.include({ mode: 'limit', timeoutSec: 60 })
  })
  it('chase on a price-level take profit becomes limit; limit on a signal stays limit', () => {
    expect(
      resolveExecution(
        'tp',
        { tpExecution: { mode: 'chase', timeoutSec: 40 } },
        'level',
      ),
    ).to.deep.include({ mode: 'limit', timeoutSec: 40 })
    expect(
      resolveExecution(
        'tp',
        { tpExecution: { mode: 'limit', timeoutSec: 40 } },
        'indicator',
      ),
    ).to.deep.include({ mode: 'limit', timeoutSec: 40 })
  })
  it('a stop loss never waits on a fixed limit: limit → chase with a timeout', () => {
    expect(
      resolveExecution('sl', { slExecution: { mode: 'limit' } }, 'level'),
    ).to.deep.include({ mode: 'chase', timeoutSec: 35 })
  })
  it('a chasing stop loss always has a timeout (§4.4)', () => {
    expect(
      resolveExecution(
        'sl',
        { slExecution: { mode: 'chase', timeoutSec: 0 } },
        'level',
      ),
    ).to.deep.include({ mode: 'chase', timeoutSec: 35 })
    expect(
      resolveExecution(
        'sl',
        { slExecution: { mode: 'chase', timeoutSec: 5 } },
        'level',
      ),
    ).to.deep.include({ timeoutSec: 5 })
  })
  it('an unknown mode falls back to the legacy derivation', () => {
    expect(
      resolveExecution(
        'tp',
        {
          closeOrderType: OrderTypeEnum.market,
          tpExecution: { mode: 'bogus' } as never,
        },
        'level',
      ).mode,
    ).to.equal('market')
  })
})

describe('spec 242 — stageForClose', () => {
  it('maps close triggers to the stage whose settings apply', () => {
    expect(stageForClose(DCACloseTriggerEnum.sl, false)).to.equal('sl')
    expect(stageForClose(undefined, true)).to.equal('sl')
    expect(stageForClose(DCACloseTriggerEnum.tp, false)).to.equal('tp')
    expect(stageForClose(DCACloseTriggerEnum.trailing, false)).to.equal('tp')
    expect(stageForClose(DCACloseTriggerEnum.indicator, false)).to.equal('tp')
    expect(stageForClose(DCACloseTriggerEnum.webhook, false)).to.equal('tp')
    expect(stageForClose(DCACloseTriggerEnum.webhook, true)).to.equal('sl')
    expect(stageForClose(DCACloseTriggerEnum.manual, false)).to.equal('close')
    expect(stageForClose(DCACloseTriggerEnum.bot, false)).to.equal('close')
    expect(stageForClose(undefined, false)).to.equal('close')
  })
})

describe('spec 242 — closeTimerPlan (§4.3)', () => {
  const chase = { repriceSec: 10, timeoutSec: 35, reprice: true }
  it('first placement: re-price after the interval', () => {
    expect(closeTimerPlan({ ...chase, elapsedMs: 0 })).to.deep.equal({
      action: 'reprice',
      delayMs: 10_000,
    })
  })
  it('does not go to market after one interval (the ~10 s regression)', () => {
    const plan = closeTimerPlan({ ...chase, elapsedMs: 0 })
    expect(plan.action).to.not.equal('market')
  })
  it('within one interval of the timeout: market exactly at the timeout', () => {
    expect(closeTimerPlan({ ...chase, elapsedMs: 30_000 })).to.deep.equal({
      action: 'market',
      delayMs: 5_000,
    })
  })
  it('past the timeout: market now', () => {
    expect(closeTimerPlan({ ...chase, elapsedMs: 40_000 })).to.deep.equal({
      action: 'market',
      delayMs: 0,
    })
  })
  it('no timeout: keeps re-pricing', () => {
    expect(
      closeTimerPlan({ ...chase, timeoutSec: 0, elapsedMs: 500_000 }),
    ).to.deep.equal({ action: 'reprice', delayMs: 10_000 })
  })
  it('limit (no re-pricing) with a timeout: market at the timeout', () => {
    expect(
      closeTimerPlan({
        repriceSec: 10,
        timeoutSec: 35,
        reprice: false,
        elapsedMs: 0,
      }),
    ).to.deep.equal({ action: 'market', delayMs: 35_000 })
  })
  it('limit with no timeout: nothing to arm', () => {
    expect(
      closeTimerPlan({
        repriceSec: 10,
        timeoutSec: 0,
        reprice: false,
        elapsedMs: 0,
      }),
    ).to.deep.equal({ action: 'none', delayMs: 0 })
  })
})

describe('spec 242 — clampChasePrice (§4.3, §5.2)', () => {
  it('a sell close (long) is never placed below trigger × (1 − cap)', () => {
    expect(
      clampChasePrice({
        price: 98,
        triggerPrice: 100,
        maxChasePerc: 1,
        side: 'SELL',
      }),
    ).to.equal(99)
    expect(
      clampChasePrice({
        price: 101,
        triggerPrice: 100,
        maxChasePerc: 1,
        side: 'SELL',
      }),
    ).to.equal(101)
  })
  it('a buy close (short) is never placed above trigger × (1 + cap)', () => {
    expect(
      clampChasePrice({
        price: 102,
        triggerPrice: 100,
        maxChasePerc: 1,
        side: 'BUY',
      }),
    ).to.equal(101)
    expect(
      clampChasePrice({
        price: 99,
        triggerPrice: 100,
        maxChasePerc: 1,
        side: 'BUY',
      }),
    ).to.equal(99)
  })
  it('cap 0 or no trigger price: unchanged', () => {
    expect(
      clampChasePrice({
        price: 50,
        triggerPrice: 100,
        maxChasePerc: 0,
        side: 'SELL',
      }),
    ).to.equal(50)
    expect(
      clampChasePrice({
        price: 50,
        triggerPrice: 0,
        maxChasePerc: 1,
        side: 'SELL',
      }),
    ).to.equal(50)
  })
})

describe('spec 242 — close type per stage for signal closes', () => {
  it('maps take-profit / stop-loss types to triggers', () => {
    expect(triggerFromCloseCondition('techInd')).to.equal('indicator')
    expect(triggerFromCloseCondition('webhook')).to.equal('webhook')
    expect(triggerFromCloseCondition('dynamicAr')).to.equal('level')
    expect(triggerFromCloseCondition(undefined)).to.equal('level')
  })
  it('legacy: follows closeDealType, exactly as before', () => {
    const s = { closeDealType: CloseDCATypeEnum.closeByLimit }
    expect(closeTypeForStage('tp', s, 'indicator')).to.equal(
      CloseDCATypeEnum.closeByLimit,
    )
    expect(closeTypeForStage('sl', s, 'indicator')).to.equal(
      CloseDCATypeEnum.closeByLimit,
    )
    expect(
      closeTypeForStage(
        'tp',
        { closeDealType: CloseDCATypeEnum.closeByMarket },
        'webhook',
      ),
    ).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(closeTypeForStage('sl', s, 'webhook')).to.equal(
      CloseDCATypeEnum.closeByMarket,
    )
  })
  it('stored: each stage uses its own setting, not the shared closeDealType', () => {
    const s = {
      closeDealType: CloseDCATypeEnum.closeByLimit,
      tpExecution: { mode: 'market' as const },
      slExecution: { mode: 'chase' as const, timeoutSec: 20 },
    }
    expect(closeTypeForStage('tp', s, 'indicator')).to.equal(
      CloseDCATypeEnum.closeByMarket,
    )
    expect(closeTypeForStage('sl', s, 'webhook')).to.equal(
      CloseDCATypeEnum.closeByLimit,
    )
  })
  it('a stored split closes at market until phase 3', () => {
    expect(
      closeTypeForStage('tp', { tpExecution: { mode: 'split' } }, 'indicator'),
    ).to.equal(CloseDCATypeEnum.closeByMarket)
  })
})

describe('spec 242 — validateOrderExecution (public API)', () => {
  it('accepts null and well-formed values', () => {
    expect(validateOrderExecution(null)).to.equal(null)
    expect(validateOrderExecution(undefined)).to.equal(null)
    expect(validateOrderExecution({ mode: 'market' })).to.equal(null)
    expect(
      validateOrderExecution({
        mode: 'split',
        slices: 5,
        pace: 'iceberg',
        sliceIntervalSec: 30,
        sliceMode: 'limit',
        floorPerc: 2,
        onFloor: 'pause',
      }),
    ).to.equal(null)
  })
  it('rejects unknown modes, fields and out-of-range numbers', () => {
    expect(validateOrderExecution({ mode: 'twap' })).to.match(/mode/)
    expect(validateOrderExecution({ mode: 'chase', foo: 1 })).to.match(
      /unknown field foo/,
    )
    expect(validateOrderExecution({ mode: 'chase', repriceSec: 1 })).to.match(
      /repriceSec/,
    )
    expect(validateOrderExecution({ mode: 'split', slices: 2.5 })).to.match(
      /integer/,
    )
    expect(validateOrderExecution({ mode: 'split', pace: 'fast' })).to.match(
      /pace/,
    )
    expect(validateOrderExecution('chase')).to.match(/object/)
  })
})

describe('spec 242 phase 2 — base order follows entryExecution (§6.2)', () => {
  it('order type: market → MARKET, limit/chase → LIMIT, else the legacy field', () => {
    expect(
      entryOrderType({
        entryExecution: { mode: 'market' },
        startOrderType: OrderTypeEnum.limit,
      }),
    ).to.equal(OrderTypeEnum.market)
    expect(
      entryOrderType({
        entryExecution: { mode: 'chase' },
        startOrderType: OrderTypeEnum.market,
      }),
    ).to.equal(OrderTypeEnum.limit)
    expect(entryOrderType({ entryExecution: { mode: 'limit' } })).to.equal(
      OrderTypeEnum.limit,
    )
    // Spec §6.5: a split's first slice is the base order (default chasing).
    expect(
      entryOrderType({
        entryExecution: { mode: 'split' },
        startOrderType: OrderTypeEnum.market,
      }),
    ).to.equal(OrderTypeEnum.limit)
    expect(entryOrderType({ startOrderType: OrderTypeEnum.limit })).to.equal(
      OrderTypeEnum.limit,
    )
    expect(entryOrderType({})).to.equal(undefined)
  })
  it('chase cap applies only to a stored chasing base order', () => {
    expect(
      entryChaseCapPerc({ entryExecution: { mode: 'chase', maxChasePerc: 2 } }),
    ).to.equal(2)
    expect(
      entryChaseCapPerc({ entryExecution: { mode: 'limit', maxChasePerc: 2 } }),
    ).to.equal(0)
    expect(entryChaseCapPerc({ startOrderType: OrderTypeEnum.limit })).to.equal(
      0,
    )
  })
})

describe('spec 242 phase 2 — resting take-profit timeout (§4.2, §6.2)', () => {
  const base = {
    dealCloseCondition: 'tp',
    tpExecution: { mode: 'limit' as const, timeoutSec: 30 },
  }
  it('a single resting take profit with a timeout expires after it', () => {
    expect(restingTpTimeoutMs(base, false)).to.equal(30_000)
    expect(
      restingTpTimeoutMs({ ...base, dealCloseCondition: 'dynamicAr' }, false),
    ).to.equal(30_000)
  })
  it('no timeout for multi-target, combo, signal take profits, timeout 0, or legacy bots', () => {
    expect(restingTpTimeoutMs({ ...base, useMultiTp: true }, false)).to.equal(0)
    expect(restingTpTimeoutMs(base, true)).to.equal(0)
    expect(
      restingTpTimeoutMs({ ...base, dealCloseCondition: 'techInd' }, false),
    ).to.equal(0)
    expect(
      restingTpTimeoutMs(
        { ...base, tpExecution: { mode: 'limit', timeoutSec: 0 } },
        false,
      ),
    ).to.equal(0)
    expect(
      restingTpTimeoutMs(
        { dealCloseCondition: 'tp', closeOrderType: OrderTypeEnum.limit },
        false,
      ),
    ).to.equal(0)
  })
})

describe('spec 242 phase 3 — split planning (§4.5)', () => {
  it('equal slices rounded down to the step; the last takes the rest', () => {
    const s = planSplitSizes({
      totalQty: 1,
      slices: 3,
      step: 0.001,
      minQty: 0.001,
    })
    expect(s).to.deep.equal([0.333, 0.333, 0.334])
    expect(s.reduce((a, b) => a + b, 0)).to.be.closeTo(1, 1e-9)
  })
  it('never more than the total, never a slice below the minimum (merged into the previous one)', () => {
    const s = planSplitSizes({
      totalQty: 0.0105,
      slices: 5,
      step: 0.001,
      minQty: 0.003,
    })
    expect(s.every((q) => q >= 0.003)).to.equal(true)
    expect(s.reduce((a, b) => a + b, 0)).to.be.closeTo(0.0105, 1e-9)
    expect(s.length).to.be.lessThan(5)
  })
  it('a total below two minimum slices is a single slice', () => {
    expect(
      planSplitSizes({
        totalQty: 0.004,
        slices: 5,
        step: 0.001,
        minQty: 0.003,
      }),
    ).to.deep.equal([0.004])
  })
  it('a minimum notional is respected at the given price', () => {
    const s = planSplitSizes({
      totalQty: 1,
      slices: 10,
      step: 0.01,
      minQty: 0,
      minNotional: 25,
      price: 100,
    })
    expect(s.every((q) => q * 100 >= 25)).to.equal(true)
    expect(s.reduce((a, b) => a + b, 0)).to.be.closeTo(1, 1e-9)
  })
})

describe('spec 242 phase 3 — split floor (§4.5)', () => {
  it('a SELL close breaches the floor when price falls below trigger × (1 − floor)', () => {
    expect(
      splitFloorBreached({
        side: 'SELL',
        triggerPrice: 100,
        lastPrice: 97.9,
        floorPerc: 2,
      }),
    ).to.equal(true)
    expect(
      splitFloorBreached({
        side: 'SELL',
        triggerPrice: 100,
        lastPrice: 98.1,
        floorPerc: 2,
      }),
    ).to.equal(false)
  })
  it('a BUY close breaches it when price rises above trigger × (1 + floor)', () => {
    expect(
      splitFloorBreached({
        side: 'BUY',
        triggerPrice: 100,
        lastPrice: 102.1,
        floorPerc: 2,
      }),
    ).to.equal(true)
    expect(
      splitFloorBreached({
        side: 'BUY',
        triggerPrice: 100,
        lastPrice: 101,
        floorPerc: 2,
      }),
    ).to.equal(false)
  })
  it('floor 0 never breaches', () => {
    expect(
      splitFloorBreached({
        side: 'SELL',
        triggerPrice: 100,
        lastPrice: 1,
        floorPerc: 0,
      }),
    ).to.equal(false)
  })
})

describe('spec 242 phase 3b — only executable modes (§6.3.1)', () => {
  it('a stored split DCA order falls back to market (§6.3.2)', () => {
    expect(
      resolveExecution('dca', { dcaExecution: { mode: 'split' } }, 'level')
        .mode,
    ).to.equal('market')
  })
  it('indicator DCA orders are market whatever is stored', () => {
    expect(
      resolveExecution('dca', { dcaExecution: { mode: 'limit' } }, 'indicator')
        .mode,
    ).to.equal('market')
  })
  it('a stored chasing base order is kept', () => {
    expect(
      resolveExecution(
        'entry',
        { entryExecution: { mode: 'chase', repriceSec: 15 } },
        'start',
      ),
    ).to.deep.include({ mode: 'chase', repriceSec: 15 })
  })
})

describe('spec 242 — base order split (§6.5)', () => {
  const split = {
    entryExecution: {
      mode: 'split' as const,
      slices: 4,
      sliceMode: 'market' as const,
    },
  }
  const ok = {
    isCombo: false,
    terminal: false,
    riskReward: false,
    compoundReduce: false,
    fixSize: 0,
    spotShort: false,
    singlePosition: false,
  }
  it('eligible only for a plain DCA bot entry', () => {
    expect(entrySplitEligible(split, ok)).to.equal(true)
    for (const k of [
      'isCombo',
      'terminal',
      'riskReward',
      'compoundReduce',
      'spotShort',
      'singlePosition',
    ] as const) {
      expect(entrySplitEligible(split, { ...ok, [k]: true }), k).to.equal(false)
    }
    expect(entrySplitEligible(split, { ...ok, fixSize: 10 })).to.equal(false)
    expect(
      entrySplitEligible({ entryExecution: { mode: 'chase' } }, ok),
    ).to.equal(false)
  })
  it('the first slice goes as MARKET or LIMIT from the slice mode', () => {
    expect(
      entryOrderType({
        entryExecution: { mode: 'split', sliceMode: 'market' },
      }),
    ).to.equal(OrderTypeEnum.market)
    expect(
      entryOrderType({ entryExecution: { mode: 'split', sliceMode: 'chase' } }),
    ).to.equal(OrderTypeEnum.limit)
  })
  it('a stored split base order is kept (not fitted to market)', () => {
    expect(resolveExecution('entry', split, 'start').mode).to.equal('split')
  })
})
