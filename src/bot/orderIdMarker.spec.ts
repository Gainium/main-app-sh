process.env.NODE_ENV = 'testing'

/**
 * A client-order-id marker that is not hexadecimal is a Hyperliquid outage.
 *
 * On Hyperliquid the client order id IS the `cloid` — `MainBot.getOrderId`
 * mints `'0x' + randomBytes(16).toString('hex')` and the connector forwards it
 * verbatim. Hyperliquid deserializes the request body before validating
 * anything, so one non-hex character rejects the WHOLE order with
 * `422 unprocessable entity - failed to deserialize the json body into the
 * target type`, and the take-profit is never placed. That is what the `rf`
 * real-fee marker did before it became `fe`.
 *
 * So this suite guards two things:
 *   1. every marker in {@link ORDER_ID_MARKER} is hex, and marking a
 *      Hyperliquid id leaves a still-valid cloid;
 *   2. no bot file rewrites an id's tail with a literal of its own — the trap
 *      is a NEW marker added next to the old ones without anybody thinking
 *      about the alphabet, which only a source sweep can catch.
 *
 * Run: `npm test` (mocha). No network / DB.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ORDER_ID_MARKER, markOrderId } from './orderIdMarker'

/** What Hyperliquid's info/exchange endpoints accept as a `cloid`. */
const HL_CLOID_RE = /^0x[0-9a-f]{32}$/

const HL_ID = '0xde4a91a2c1d879e1684e8aa680a352ab'

describe('order id markers', () => {
  it('are all hexadecimal', () => {
    for (const [name, marker] of Object.entries(ORDER_ID_MARKER)) {
      expect(marker, `${name} marker "${marker}"`).to.match(/^[0-9a-f]+$/)
    }
  })

  it('leave a Hyperliquid client order id still a valid cloid', () => {
    expect(HL_ID).to.match(HL_CLOID_RE)
    for (const [name, marker] of Object.entries(ORDER_ID_MARKER)) {
      const marked = markOrderId(HL_ID, marker)
      expect(marked, `${name} marked id`).to.match(HL_CLOID_RE)
      expect(marked, `${name} marked id`).to.not.equal(HL_ID)
    }
  })

  it('stay distinct from one another', () => {
    const markers = Object.values(ORDER_ID_MARKER)
    expect(new Set(markers).size).to.equal(markers.length)
  })

  /**
   * Catches `` `${id.slice(0, id.length - 2)}xy` `` written by hand — the exact
   * shape all three markers had before they moved into `ORDER_ID_MARKER`.
   */
  it('are the only way bot code rewrites an id tail', () => {
    const dir = __dirname
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
          const src = readFileSync(p, 'utf8')
          // a template literal closing on `}` + two chars + backtick, i.e. a
          // hand-written tail marker, in the same statement as a `.length - 2`
          // slice of a client order id.
          const re = /\.length - 2,?\s*\)\s*\}([0-9a-z]{2})`/g
          for (const m of src.matchAll(re)) {
            offenders.push(`${p.replace(dir, 'src/bot')}: "${m[1]}"`)
          }
        }
      }
    }
    walk(dir)
    expect(
      offenders,
      `use markOrderId(id, ORDER_ID_MARKER.x) instead of a literal tail:\n${offenders.join('\n')}`,
    ).to.deep.equal([])
  })
})
