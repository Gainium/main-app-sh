process.env.NODE_ENV = 'testing'
// `graphql/handlers/user` refuses to load without one; nothing here signs a token.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoothing-guard-test-secret'

/**
 * Oscillator smoothing on the GraphQL bot mutations. Every mutation that
 * writes bot indicators — create / change for DCA, Combo, Hedge Combo and
 * Hedge DCA — refuses the settings the public API refuses
 * (`smoothingSettingsGaps`) before the bot service is called, and hands the
 * service the stored shape (`normalizeSmoothingFields`). A payload without the
 * smoothing fields reaches the service exactly as it was sent.
 *
 * Driven over the real resolvers with a fake user lookup and a fake bot
 * service that records what it was given. No network, no Mongo, no Redis.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  IndicatorEnum,
  IndicatorStartConditionEnum,
  StatusEnum,
} from '../../../types'
import { normalizeSmoothingFields } from '../../indicators/conditions/smoothing'

const loadModule = createRequire(__filename)
const USER_ID = '000000000000000000000a11'

const SERVICE_METHOD = {
  createDCABot: 'createDCABot',
  createComboBot: 'createComboBot',
  changeDCABot: 'changeDCABot',
  changeComboBot: 'changeComboBot',
  createHedgeComboBot: 'createHedgeComboBot',
  createHedgeDCABot: 'createHedgeDcaBot',
  changeHedgeComboBot: 'changeHedgeComboBot',
  changeHedgeDCABot: 'changeHedgeDcaBot',
} as const
type Mutation = keyof typeof SERVICE_METHOD
const SINGLE: Mutation[] = [
  'createDCABot',
  'createComboBot',
  'changeDCABot',
  'changeComboBot',
]
const HEDGE: Mutation[] = [
  'createHedgeComboBot',
  'createHedgeDCABot',
  'changeHedgeComboBot',
  'changeHedgeDCABot',
]

const harness = () => {
  const calls: { method: string; args: unknown[] }[] = []
  const Bot = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        async (...args: unknown[]) => {
          calls.push({ method, args })
          return { status: StatusEnum.ok, reason: null, data: { ok: true } }
        },
    },
  )
  const resolvers = loadModule('../resolvers').default(
    async () => ({
      status: StatusEnum.ok,
      data: { _id: USER_ID },
      reason: null,
    }),
    {},
    Bot,
  )
  const call = (mutation: Mutation, input: unknown) =>
    resolvers.Mutation[mutation](
      null,
      { input },
      { token: 't', req: { user: { authorized: true } }, paperContext: false },
    )
  // the settings object each mutation hands the service
  const sent = (mutation: Mutation) => {
    const c = calls.find((x) => x.method === SERVICE_METHOD[mutation])
    if (!c) return undefined
    return mutation.startsWith('create') ? c.args[1] : c.args[0]
  }
  return { calls, call, sent }
}

const rsi = (extra: Record<string, unknown> = {}) => ({
  type: IndicatorEnum.rsi,
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorCondition: IndicatorStartConditionEnum.lt,
  indicatorInterval: '1h',
  uuid: 'i1',
  ...extra,
})

const settings = (indicators?: unknown[]) => ({
  id: 'bot1',
  name: 'bot',
  pair: ['BTCUSDT'],
  exchange: 'binance',
  exchangeUUID: 'u1',
  vars: { list: [], paths: [] },
  ...(indicators ? { indicators } : {}),
})

const payload = (mutation: Mutation, indicators?: unknown[]) =>
  HEDGE.includes(mutation)
    ? {
        id: 'hedge1',
        long: settings(indicators),
        short: settings([rsi({ uuid: 'i2' })]),
      }
    : settings(indicators)

const REJECTED: [string, Record<string, unknown>, RegExp][] = [
  [
    'vwma',
    { smoothing: 'vwma', smoothingLength: 14 },
    /smoothing: Choose a smoothing/,
  ],
  [
    'price',
    { smoothing: 'price', smoothingLength: 14 },
    /smoothing: Choose a smoothing/,
  ],
  [
    'unknown type',
    { smoothing: 'kama', smoothingLength: 14 },
    /smoothing: Choose a smoothing/,
  ],
  [
    'length 0',
    { smoothing: 'sma', smoothingLength: 0 },
    /smoothing length: Enter a whole number from 1 to 1000/,
  ],
  [
    'length 1001',
    { smoothing: 'sma', smoothingLength: 1001 },
    /smoothing length/,
  ],
  [
    'fractional length',
    { smoothing: 'sma', smoothingLength: 2.5 },
    /smoothing length/,
  ],
  [
    'negative length',
    { smoothing: 'ema', smoothingLength: -3 },
    /smoothing length/,
  ],
  [
    'compare other',
    { smoothing: 'sma', smoothingLength: 14, smoothingCompare: 'both' },
    /smoothing compare: Choose value or line/,
  ],
  [
    'line + bw',
    {
      smoothing: 'sma',
      smoothingLength: 14,
      smoothingCompare: 'line',
      indicatorCondition: IndicatorStartConditionEnum.bw,
      indicatorValue2: '60',
    },
    /Between is not available when comparing with the smoothed line/,
  ],
]

describe('GraphQL bot mutations — oscillator smoothing', () => {
  for (const mutation of [...SINGLE, ...HEDGE]) {
    describe(mutation, () => {
      for (const [label, extra, reason] of REJECTED) {
        it(`refuses ${label} without calling the bot service`, async () => {
          const h = harness()
          const res = await h.call(mutation, payload(mutation, [rsi(extra)]))
          expect(res.status).to.equal(StatusEnum.notok)
          expect(res.reason).to.match(reason)
          expect(res.reason).to.match(/^(Long bot: )?Indicator 1 \(RSI\)/)
          expect(res.data).to.equal(null)
          expect(h.calls).to.have.length(0)
        })
      }

      it('refuses smoothing on an indicator that cannot be smoothed', async () => {
        const h = harness()
        const res = await h.call(
          mutation,
          payload(mutation, [
            rsi(),
            {
              type: IndicatorEnum.macd,
              indicatorInterval: '1h',
              indicatorCondition: IndicatorStartConditionEnum.cu,
              smoothing: 'sma',
              smoothingLength: 14,
            },
          ]),
        )
        expect(res.status).to.equal(StatusEnum.notok)
        expect(res.reason).to.match(
          /Indicator 2 \(MACD\) smoothing: Smoothing is not available for MACD/,
        )
        expect(h.calls).to.have.length(0)
      })

      it('accepts smoothing on and stores the normalised fields', async () => {
        const h = harness()
        const res = await h.call(
          mutation,
          payload(mutation, [
            rsi({ smoothing: ' HMA ', smoothingLength: 1000 }),
            rsi({
              uuid: 'i3',
              smoothing: 'Ema',
              smoothingLength: 1,
              smoothingCompare: 'LINE',
            }),
          ]),
        )
        expect(res.status).to.equal(StatusEnum.ok)
        const s: any = h.sent(mutation)
        const indicators = HEDGE.includes(mutation)
          ? s.long.indicators
          : s.indicators
        expect(indicators[0]).to.include({
          smoothing: 'hma',
          smoothingLength: 1000,
          smoothingCompare: 'value',
        })
        expect(indicators[1]).to.include({
          smoothing: 'ema',
          smoothingLength: 1,
          smoothingCompare: 'line',
        })
      })

      it('accepts smoothing off (none / null) and drops the fields', async () => {
        const h = harness()
        const res = await h.call(
          mutation,
          payload(mutation, [
            rsi({
              smoothing: 'none',
              smoothingLength: 14,
              smoothingCompare: 'line',
            }),
            rsi({
              uuid: 'i3',
              smoothing: null,
              smoothingLength: null,
              smoothingCompare: null,
            }),
            rsi({ uuid: 'i4', smoothing: 'NONE' }),
          ]),
        )
        expect(res.status).to.equal(StatusEnum.ok)
        const s: any = h.sent(mutation)
        const indicators = HEDGE.includes(mutation)
          ? s.long.indicators
          : s.indicators
        expect(indicators).to.deep.equal([
          rsi(),
          rsi({ uuid: 'i3' }),
          rsi({ uuid: 'i4' }),
        ])
      })

      it('passes a payload without the smoothing fields through unchanged', async () => {
        const h = harness()
        const input = payload(mutation, [
          rsi(),
          { type: IndicatorEnum.macd, indicatorInterval: '1h', uuid: 'm1' },
        ])
        const before = JSON.parse(JSON.stringify(input))
        const res = await h.call(mutation, input)
        expect(res.status).to.equal(StatusEnum.ok)
        expect(h.calls).to.have.length(1)
        // the very object that was sent, not a copy
        expect(h.sent(mutation)).to.equal(input)
        expect(input).to.deep.equal(before)
      })

      it('passes a payload without indicators through unchanged', async () => {
        const h = harness()
        const input = HEDGE.includes(mutation)
          ? { id: 'hedge1', long: settings(), short: settings() }
          : settings()
        const res = await h.call(mutation, input)
        expect(res.status).to.equal(StatusEnum.ok)
        expect(h.sent(mutation)).to.equal(input)
      })
    })
  }

  it('a hedge refusal names the leg', async () => {
    const h = harness()
    const res = await h.call('changeHedgeDCABot', {
      id: 'hedge1',
      long: settings([rsi()]),
      short: settings([rsi({ smoothing: 'vwma', smoothingLength: 14 })]),
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.match(/^Short bot: Indicator 1 \(RSI\) smoothing:/)
    expect(h.calls).to.have.length(0)
  })
})

describe('normalizeSmoothingFields', () => {
  it('returns an entry without the fields as the same object', () => {
    const i = rsi()
    expect(normalizeSmoothingFields(i)).to.equal(i)
  })
  it('drops all three when the length is missing (smoothing off)', () => {
    expect(normalizeSmoothingFields(rsi({ smoothing: 'sma' }))).to.deep.equal(
      rsi(),
    )
  })
  it('percentile reads as value', () => {
    expect(
      normalizeSmoothingFields(
        rsi({
          smoothing: 'sma',
          smoothingLength: 9,
          smoothingCompare: 'line',
          percentile: true,
        }),
      ),
    ).to.deep.include({ smoothingCompare: 'value' })
  })
  it('drops the fields on a type that cannot be smoothed', () => {
    const macd = {
      type: IndicatorEnum.macd,
      smoothing: 'none',
      smoothingLength: 14,
    }
    expect(normalizeSmoothingFields(macd)).to.deep.equal({
      type: IndicatorEnum.macd,
    })
  })
})
