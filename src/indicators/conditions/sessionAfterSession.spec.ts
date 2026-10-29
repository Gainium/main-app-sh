process.env.NODE_ENV = 'testing'

/**
 * Session Price levels on the first candle after the session (indicators
 * 1.14.0): with `sessionLevelsActive` outside / always, a crossing of the
 * price with a prev* level fires against the level the newest candle sees;
 * session / missing never fire there, and nor does any other pairing. Pins
 * the appended `SESSION|levels|afterSession|…` characterization cases (the
 * golden records every one), readable.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { evaluateIndicatorCondition } from '.'
import { conditionCases } from './__fixtures__/conditionCases'

const CASES = conditionCases()
const fires = (id: string) => {
  const c = CASES.find((x) => x.id === id)
  if (!c) throw new Error(`no case ${id}`)
  return evaluateIndicatorCondition(c.settings, c.bars(), {
    interval: c.interval,
    symbol: 'BTCUSDT',
    exchange: 'binance',
    showLog: false,
    debug: () => undefined,
    reference: () => undefined,
    setReference: () => undefined,
  }).action
}

describe('indicators/conditions — Session Price levels after the session', () => {
  const crossings = CASES.filter(
    (c) =>
      c.id.startsWith('SESSION|levels|afterSession|') &&
      /\|(cu|cd)\|[^|]+$/.test(c.id),
  )

  it('crossings fire only for price vs a prev* level, outside / always', () => {
    const fired = crossings.filter((c) => fires(c.id)).map((c) => c.id)
    const want: string[] = []
    for (const active of ['outside', 'always'])
      want.push(
        `SESSION|levels|afterSession|active=${active}|price|prevHigh|cu|breakUp`,
        `SESSION|levels|afterSession|active=${active}|prevHigh|price|cd|breakUp`,
        `SESSION|levels|afterSession|active=${active}|price|prevLow|cd|breakDown`,
        `SESSION|levels|afterSession|active=${active}|price|prevMid|cu|crossMid`,
        `SESSION|levels|afterSession|active=${active}|price|prevMid|cu|inside`,
      )
    expect(fired.sort()).to.deep.equal(want.sort())
    expect(crossings.length).to.equal(4 * 7 * 2 * 5)
  })

  it('the Monday-range breakout from the last session candle', () => {
    const id = (active: string) =>
      `SESSION|levels|afterSession|active=${active}|price|prevHigh|cu|breakUp`
    expect(fires(id('outside'))).to.equal(true)
    expect(fires(id('always'))).to.equal(true)
    expect(fires(id('session'))).to.equal(false)
    // sessionLevelsActive missing
    const missing = CASES.filter(
      (c) =>
        c.id.endsWith('|price|prevHigh|cu|breakUp') &&
        c.id.startsWith('SESSION|levels|afterSession|') &&
        c.settings.sessionLevelsActive === undefined,
    )
    expect(missing.length).to.equal(1)
    expect(fires(missing[0].id)).to.equal(false)
  })

  it('never across a session seen only partly, nor on prevClose or two levels', () => {
    for (const active of ['outside', 'always']) {
      const p = `SESSION|levels|afterSession|active=${active}`
      expect(fires(`${p}|price|prevHigh|cu|partialSession`)).to.equal(false)
      for (const label of ['breakUp', 'breakDown', 'crossMid', 'inside']) {
        expect(fires(`${p}|price|prevClose|cu|${label}`)).to.equal(false)
        expect(fires(`${p}|price|prevClose|cd|${label}`)).to.equal(false)
        expect(fires(`${p}|prevHigh|prevLow|cu|${label}`)).to.equal(false)
        expect(fires(`${p}|prevHigh|prevLow|cd|${label}`)).to.equal(false)
      }
    }
  })
})
