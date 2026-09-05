process.env.NODE_ENV = 'testing'

/**
 * Kraken spot client order ids must be short enough for Kraken to carry them.
 *
 * Kraken accepts a native `cl_ord_id` in exactly three forms: long UUID
 * (8-4-4-4-12 hex), short UUID (32 hex, no dashes), or FREE ASCII TEXT of at
 * most 18 characters. `getOrderId()` had no Kraken arm, so a Kraken spot bot
 * fell through to the 36-char default and emitted 35 characters — 17 over the
 * ceiling — which the connector then had to hash to the short-UUID form before
 * it could send it. The hash works, but it means the id in our database is not
 * the id the venue knows the order by, and every call site has to re-derive it.
 *
 * Spec: `specs/010.kraken-spot-client-order-id-length.md`.
 * Connector half: `exchange-connector core/specs/003.kraken-spot-native-cl-ord-id.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB needed — `getOrderId` is driven off the prototype.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import MainBot from './main'
import { ExchangeEnum } from '../../types'

/** Kraken's free-text `cl_ord_id` ceiling. */
const KRAKEN_FREE_TEXT_MAX = 18

/**
 * Every prefix the codebase actually passes to `getOrderId`, read out of the
 * source rather than hardcoded — §4.4's entropy bound is only a real bound if
 * adding a longer prefix makes this suite fail instead of silently shortening
 * the random tail.
 */
function prefixesInUse(): string[] {
  const dir = __dirname
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
        files.push(p)
    }
  }
  walk(dir)
  const found = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/getOrderId\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      found.add(m[1])
    }
  }
  return [...found].sort()
}

function botOn(exchange: ExchangeEnum, brokerCode = '') {
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange }
  bot.brokerCode = brokerCode
  return bot as { getOrderId(prefix: string): string }
}

describe('getOrderId on Kraken spot (spec 010)', () => {
  const prefixes = prefixesInUse()

  it('finds the prefixes it is meant to bound', () => {
    // A refactor that stops matching the call sites would make every bound
    // below vacuously true.
    expect(prefixes.length).to.be.greaterThan(10)
    expect(prefixes).to.include('GRID-STAB')
    expect(prefixes).to.include('D-RO')
  })

  it('§4.1 never exceeds Kraken free-text length, for any prefix in use', () => {
    const bot = botOn(ExchangeEnum.kraken)
    for (const p of prefixes) {
      const generated = bot.getOrderId(p)
      expect(
        generated.length,
        `${p} -> ${generated} (${generated.length} chars)`,
      ).to.be.at.most(KRAKEN_FREE_TEXT_MAX)
    }
  })

  it('§4.2 keeps the whole prefix, so existing readers still match it', () => {
    const bot = botOn(ExchangeEnum.kraken)
    for (const p of prefixes) {
      expect(bot.getOrderId(p)).to.match(new RegExp(`^${p}-`))
    }
  })

  it('§4.3 emits only characters Kraken free text accepts', () => {
    const bot = botOn(ExchangeEnum.kraken)
    for (const p of prefixes) {
      expect(bot.getOrderId(p)).to.match(/^[A-Za-z0-9-]+$/)
    }
  })

  it('§4.4 leaves at least 8 random characters for the longest prefix', () => {
    const bot = botOn(ExchangeEnum.kraken)
    const longest = prefixes.reduce((a, b) => (b.length > a.length ? b : a))
    const tail = bot.getOrderId(longest).slice(longest.length + 1)
    // 62^8 ~= 2.18e14. A bot holds tens of concurrent orders; a shorter tail
    // than this means a new prefix has eaten the entropy and needs a decision,
    // not a silent truncation.
    expect(tail.length, `longest prefix ${longest}`).to.be.at.least(8)
  })

  it('§4.4 does not repeat itself across a bot-sized population', () => {
    const bot = botOn(ExchangeEnum.kraken)
    const longest = prefixes.reduce((a, b) => (b.length > a.length ? b : a))
    const seen = new Set<string>()
    for (let i = 0; i < 20000; i++) seen.add(bot.getOrderId(longest))
    expect(seen.size).to.equal(20000)
  })

  it('§4.1 applies to Kraken SPOT only, not futures or paper', () => {
    for (const e of [
      ExchangeEnum.krakenUsdm,
      ExchangeEnum.krakenCoinm,
      ExchangeEnum.paperKraken,
    ]) {
      expect(botOn(e).getOrderId('D-RO').length, e).to.equal(35)
    }
  })
})

describe('getOrderId on every other venue is untouched (spec 010 §4.5)', () => {
  it('keeps the 35-char default', () => {
    for (const e of [
      ExchangeEnum.bybit,
      ExchangeEnum.coinbase,
      ExchangeEnum.kucoin,
      ExchangeEnum.bitget,
    ]) {
      expect(botOn(e).getOrderId('D-RO').length, e).to.equal(35)
    }
  })

  it('keeps the Binance broker-code prefix inside the 36-char budget', () => {
    const generated = botOn(ExchangeEnum.binance, 'x-ABCDEF').getOrderId('D-RO')
    expect(generated.startsWith('x-ABCDEFD-RO-')).to.be.true
    expect(generated.length).to.equal(35)
  })

  it('keeps OKX at 32 chars with no dashes', () => {
    const generated = botOn(ExchangeEnum.okx).getOrderId('D-RO')
    expect(generated.length).to.equal(32)
    expect(generated).to.not.include('-')
  })

  it('keeps MEXC inside its 32-char budget', () => {
    // 31, not 32: only the OKX arm pads back up to `maxLength`. Asserted as it
    // is, not as it "should" be — this suite is here to prove the Kraken arm
    // changed nothing else.
    expect(botOn(ExchangeEnum.mexc).getOrderId('D-RO').length).to.equal(31)
  })

  it('keeps Hyperliquid on its 0x + 32 hex form', () => {
    expect(botOn(ExchangeEnum.hyperliquid).getOrderId('D-RO')).to.match(
      /^0x[0-9a-f]{32}$/,
    )
  })
})
