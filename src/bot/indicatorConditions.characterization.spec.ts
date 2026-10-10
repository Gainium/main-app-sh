process.env.NODE_ENV = 'testing'

/**
 * Characterization of the DCA engine's indicator conditions, run through the
 * real engine methods off the DCA helper prototype (no stack):
 *
 *  - `checkIndicatorConditions` — the per-type decision (gt / lt / crossing
 *    up / crossing down / between, MA vs price and MA vs MA, percentile and
 *    trend-filter options, multi-output indicators, reference series) for the
 *    case table in `indicators/conditions/__fixtures__/conditionCases.ts`;
 *  - the keep-condition-bars status a condition holds after each bar;
 *  - `connectSettingsIndicator` — the indicator-service config (and the MA /
 *    oscillator reference configs) the engine subscribes for given settings.
 *
 * The golden file was recorded from the engine BEFORE its condition logic was
 * moved into `indicators/conditions`; it must keep matching after.
 * Re-record (only from a known-good engine):
 *   UPDATE_INDICATOR_GOLDEN=1 npx mocha -r ts-node/register \
 *     src/bot/indicatorConditions.characterization.spec.ts
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import {
  BotStatusEnum,
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  StartConditionEnum,
} from '../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../types'
import {
  conditionCases,
  configCases,
  serialise,
  H,
  T,
  type ConditionCase,
} from '../indicators/conditions/__fixtures__/conditionCases'

const Helper: any = createDCABotHelper(MainBot as any)
const SYMBOL = 'BTCUSDT'
export const GOLDEN_PATH = path.join(
  __dirname,
  '../indicators/conditions/__fixtures__/indicatorConditions.golden.json',
)

function makeBot(settings: SettingsIndicators, interval: ExchangeIntervals) {
  const key = `${settings.uuid}@${SYMBOL}`
  const local: any = {
    uuid: settings.uuid,
    id: 'id',
    room: 'room',
    key,
    symbol: SYMBOL,
    status: false,
    data: false,
    history: [],
    action: settings.indicatorAction,
    maCross: false,
    section: settings.section,
    interval,
    parentIndicator: '',
    childIndicator: '',
    groupId: settings.groupId,
    is1d: false,
  }
  const indicators = new Map<string, any>([[key, local]])
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: 'bot1',
    botType: 'dca',
    data: {
      exchange: 'binance',
      status: BotStatusEnum.open,
      settings: { indicators: [settings], pair: [SYMBOL] },
    },
    indicators,
    pairs: new Set([SYMBOL]),
    lastIndicatorsDataMap: new Map(),
    dcaIndicatorArmedAt: new Map(),
    afterIndicatorsConnected: [],
    scaleAr: false,
    tpAr: false,
    slAr: false,
    getAggregatedSettings: async () => ({ indicators: [settings] }),
    checkIndicatorStatus: () => undefined,
    saveIndicatorsData: () => undefined,
    handleDebug: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleErrors: () => undefined,
  })
  return { bot, local, indicators }
}

/**
 * One case through the engine: `t`/`f` = the condition's status after the
 * bar, upper-case when the reference indicator's data flag was cleared,
 * `E` when the engine threw.
 */
export async function runEngineCase(c: ConditionCase): Promise<string> {
  const { bot, local, indicators } = makeBot(c.settings, c.interval)
  let ref: any = null
  if (c.reference?.bars) {
    ref = {
      uuid: c.reference.uuid,
      key: `${c.reference.uuid}@${SYMBOL}`,
      symbol: SYMBOL,
      interval: c.reference.interval,
      history: c.reference.bars(),
      data: true,
      status: false,
      maCross: true,
      parentIndicator: c.settings.uuid,
      childIndicator: '',
    }
    indicators.set(ref.key, ref)
  }
  try {
    await bot.checkIndicatorConditions(
      'bot1',
      c.settings.uuid,
      c.bars(),
      SYMBOL,
    )
  } catch {
    return 'E'
  }
  const ch = local.status ? 't' : 'f'
  return ref && ref.data === false ? ch.toUpperCase() : ch
}

/** keep-condition-bars: the status a condition holds across a bar sequence */
export const STATUS_PATTERN = [
  true,
  false,
  false,
  false,
  true,
  true,
  false,
  false,
  false,
  false,
]
export const KEEP_BARS = [undefined, '0', '1', '2', '3', '-1', 'x', '']
export const STATUS_BASES = [
  T,
  Date.now() + 30 * 24 * H - ((Date.now() + 30 * 24 * H) % H),
]

export async function runEngineStatusSequence(
  keep: string | undefined,
  start: number,
): Promise<string> {
  const settings = {
    type: IndicatorEnum.rsi,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorLength: 14,
    indicatorValue: '50',
    indicatorCondition: IndicatorStartConditionEnum.gt,
    keepConditionBars: keep,
  } as SettingsIndicators
  const { bot, local } = makeBot(settings, ExchangeIntervals.oneH)
  const steps: string[] = []
  for (let n = 0; n < STATUS_PATTERN.length; n++) {
    const v = STATUS_PATTERN[n] ? 60 : 40
    const bars = [
      {
        time: start + (n - 1) * H,
        type: IndicatorEnum.rsi,
        value: { value: v },
      },
      { time: start + n * H, type: IndicatorEnum.rsi, value: { value: v } },
    ] as IndicatorHistory[]
    await bot.checkIndicatorConditions('bot1', 'cond', bars, SYMBOL)
    const rel = (t: number | undefined) =>
      t === undefined ? 'u' : `${(t - start) / H}`
    steps.push(
      `${local.status ? 1 : 0}:${rel(local.statusSince)}:${rel(local.statusTo)}`,
    )
  }
  return steps.join(' ')
}

/** what the engine subscribes for one settings object */
export async function runEngineConfig(
  settings: SettingsIndicators,
): Promise<string> {
  const sent: any[] = []
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: 'bot1',
    botType: 'dca',
    data: { exchange: 'binance', settings: {} },
    indicators: new Map(),
    indicatorsIntervalActionMap: new Map(),
    dcaIndicatorArmedAt: new Map(),
    scaleAr: false,
    tpAr: false,
    slAr: false,
    showIndicatorLogs: () => false,
    handleDebug: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    sendIndicatorSubscribeEvent: async (dto: any) => {
      sent.push(dto)
      return {
        id: `id${sent.length}`,
        room: 'room',
        data: [],
        cb: () => undefined,
      }
    },
  })
  try {
    await bot.connectSettingsIndicator(settings, SYMBOL, {
      settings: { startCondition: StartConditionEnum.ti },
      filteredIndicators: [settings],
      previous: new Map(),
    })
  } catch (e) {
    return `E:${(e as Error)?.message}`
  }
  if (!sent.length) return 'not subscribed'
  return sent
    .map(
      (d) =>
        `${d.responseParams.uuid}@${d.data.interval}=${serialise(d.data.indicatorConfig)}`,
    )
    .join(' | ')
}

type Golden = {
  conditions: string
  conditionIds: number
  status: Record<string, string>
  configs: Record<string, string>
}

export async function computeEngineGolden(): Promise<Golden> {
  const cases = conditionCases()
  let conditions = ''
  for (const c of cases) conditions += await runEngineCase(c)
  const status: Record<string, string> = {}
  for (const [bi, start] of STATUS_BASES.entries())
    for (const keep of KEEP_BARS)
      status[`${bi ? 'future' : 'past'}|${keep}`] =
        await runEngineStatusSequence(keep, start)
  const configs: Record<string, string> = {}
  for (const { id, settings } of configCases())
    configs[id] = await runEngineConfig(settings)
  return { conditions, conditionIds: cases.length, status, configs }
}

export function readGolden(): Golden {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as Golden
}

export function diffConditions(got: string, want: string, max = 25): string[] {
  const cases = conditionCases()
  const out: string[] = []
  for (let n = 0; n < Math.max(got.length, want.length); n++)
    if (got[n] !== want[n] && out.length < max)
      out.push(`${cases[n]?.id}: got ${got[n]} want ${want[n]}`)
  return out
}

describe('DCA engine indicator conditions (characterization)', function () {
  this.timeout(120_000)

  it('matches the recorded golden for every case', async () => {
    const got = await computeEngineGolden()
    if (process.env.UPDATE_INDICATOR_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(got, null, 1)}\n`)
      return
    }
    const want = readGolden()
    expect(got.conditionIds).to.equal(want.conditionIds)
    expect(diffConditions(got.conditions, want.conditions)).to.deep.equal([])
    expect(got.status).to.deep.equal(want.status)
    expect(got.configs).to.deep.equal(want.configs)
  })

  // A few readable pins of the same behaviour (the golden is the full table).
  const rsi = (
    o: Partial<SettingsIndicators>,
    prev: unknown,
    last: unknown,
    one = false,
  ) =>
    runEngineCase({
      id: 'pin',
      interval: ExchangeIntervals.oneH,
      settings: {
        type: IndicatorEnum.rsi,
        uuid: 'cond',
        groupId: 'g1',
        indicatorAction: IndicatorAction.startDeal,
        indicatorInterval: ExchangeIntervals.oneH,
        indicatorLength: 14,
        indicatorValue: '50',
        indicatorCondition: IndicatorStartConditionEnum.gt,
        ...o,
      } as SettingsIndicators,
      bars: () =>
        (one
          ? [{ time: T + H, type: IndicatorEnum.rsi, value: { value: last } }]
          : [
              { time: T, type: IndicatorEnum.rsi, value: { value: prev } },
              { time: T + H, type: IndicatorEnum.rsi, value: { value: last } },
            ]) as IndicatorHistory[],
    })

  it('gt / lt are strict at the threshold (epsilon 1e-10)', async () => {
    expect(await rsi({}, 10, 50)).to.equal('f')
    expect(await rsi({}, 10, 50 + 1e-11)).to.equal('f')
    expect(await rsi({}, 10, 50.001)).to.equal('t')
    expect(
      await rsi({ indicatorCondition: IndicatorStartConditionEnum.lt }, 10, 50),
    ).to.equal('f')
  })

  it('needs a previous bar even for gt / lt', async () => {
    expect(await rsi({}, 0, 90, true)).to.equal('f')
  })

  it('crossing up counts a previous value equal to the threshold', async () => {
    const cu = { indicatorCondition: IndicatorStartConditionEnum.cu }
    expect(await rsi(cu, 50, 60)).to.equal('t')
    expect(await rsi(cu, 40, 50)).to.equal('f')
    expect(await rsi(cu, 60, 70)).to.equal('f')
  })

  it('between is exclusive and accepts the bounds in either order', async () => {
    const bw = { indicatorCondition: IndicatorStartConditionEnum.bw }
    expect(await rsi({ ...bw, indicatorValue2: '90' }, 0, 70)).to.equal('t')
    expect(
      await rsi({ ...bw, indicatorValue: '90', indicatorValue2: '50' }, 0, 70),
    ).to.equal('t')
    expect(await rsi({ ...bw, indicatorValue2: '90' }, 0, 90)).to.equal('f')
    expect(await rsi({ ...bw, indicatorValue2: '' }, 0, 70)).to.equal('f')
  })

  it('NaN values never satisfy a comparison', async () => {
    expect(await rsi({}, 10, NaN)).to.equal('f')
    expect(
      await rsi(
        { indicatorCondition: IndicatorStartConditionEnum.lt },
        10,
        NaN,
      ),
    ).to.equal('f')
  })
})
