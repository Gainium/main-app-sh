process.env.NODE_ENV = 'testing'

/**
 * Core spec 071 §4 — the add-exchange failure line identifies a key by
 * fingerprint, never by value. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { keyFingerprint } from './keyFingerprint'

describe('keyFingerprint (spec 071)', () => {
  it('§4.2 is stable for a key and different for a different key', () => {
    const a = 'yewJMn9vYNaHyXTKUjrEWNGZJF2xSZSbmBC1wl5rgzC4mA0P'
    const b = 'yewJMn9vYNaHyXTKUjrEWNGZJF2xSZSbmBC1wl5rgzC4mA0Q'
    expect(keyFingerprint(a)).to.equal(keyFingerprint(a))
    expect(keyFingerprint(a)).to.not.equal(keyFingerprint(b))
  })

  it('§4.3 never contains any run of the key it describes', () => {
    const key = 'yewJMn9vYNaHyXTKUjrEWNGZJF2xSZSbmBC1wl5rgzC4mA0P'
    const fp = keyFingerprint(key)
    expect(fp).to.match(/^[0-9a-z]{1,7}$/)
    for (let i = 0; i + 4 <= key.length; i++) {
      expect(fp).to.not.contain(key.slice(i, i + 4))
    }
  })

  it('§4.4 answers for a missing or empty key instead of throwing', () => {
    expect(keyFingerprint(undefined)).to.equal(keyFingerprint(''))
    expect(keyFingerprint('')).to.be.a('string').and.not.equal('')
  })

  it('§4.5 matches the exchange-connector fingerprint of the same key', () => {
    // Byte-identical djb2/base36 to `exchange-connector-sh`
    // `src/utils/keyFingerprint.ts`. Recomputed here rather than imported:
    // the point of the spec is that the two implementations agree without a
    // shared dependency between the services.
    const connectorSide = (key: string) => {
      let h = 5381
      for (let i = 0; i < key.length; i++)
        h = ((h << 5) + h + key.charCodeAt(i)) | 0
      return (h >>> 0).toString(36)
    }
    for (const key of ['', 'a', 'BYBIT-KEY-0001', 'x'.repeat(128), '🔑ключ']) {
      expect(keyFingerprint(key)).to.equal(connectorSide(key))
    }
  })
})
