process.env.NODE_ENV = 'testing'

/**
 * Bot Events "Type" filter: a selection of several types is the UNION of
 * them (one `$or` group), so it can be AND-ed with the time / pair / search
 * filters the DataGrid mapping produces. Each type must keep meaning exactly
 * what the single-type filter meant before.
 */
import { expect } from 'chai'
import {
  BOT_EVENT_ORDER_NAMES,
  botEventAlertsCond,
  botEventDealsCond,
  botEventTypesCond,
} from './botEventTypeFilter'

describe('botEventTypesCond', () => {
  it('no or only unknown types → no condition (all types)', () => {
    expect(botEventTypesCond(undefined)).to.equal(null)
    expect(botEventTypesCond([])).to.equal(null)
    expect(botEventTypesCond(['nope', ''])).to.equal(null)
  })

  it('maps each type to the same match the single-type filter used', () => {
    expect(botEventTypesCond(['orders'])).to.deep.equal({
      $or: [{ event: { $in: BOT_EVENT_ORDER_NAMES } }],
    })
    expect(botEventTypesCond(['errors'])).to.deep.equal({
      $or: [{ type: 'error' }],
    })
    expect(botEventTypesCond(['warnings'])).to.deep.equal({
      $or: [{ type: 'warning' }],
    })
    expect(botEventTypesCond(['deals'])).to.deep.equal({
      $or: [botEventDealsCond()],
    })
  })

  it('a mixed selection is one $or group, deduplicated, in a stable order', () => {
    expect(
      botEventTypesCond(['errors', 'orders', 'errors', 'bogus']),
    ).to.deep.equal({
      $or: [{ event: { $in: BOT_EVENT_ORDER_NAMES } }, { type: 'error' }],
    })
  })

  it('deals bucket excludes alerts, same as category "deals"', () => {
    expect(botEventDealsCond()).to.deep.equal({
      $and: [
        { deal: { $exists: true, $nin: [null, ''] } },
        { $nor: [{ type: { $in: ['error', 'warning'] } }] },
      ],
    })
    expect(botEventAlertsCond()).to.deep.equal({
      type: { $in: ['error', 'warning'] },
    })
  })

  it('hands out a fresh condition each call (no shared mutable state)', () => {
    const a = botEventTypesCond(['orders', 'deals']) as any
    a.$or[0].event.$in.push('X')
    a.$or[1].$and[0].deal = 'mutated'
    expect(botEventTypesCond(['orders', 'deals'])).to.deep.equal({
      $or: [{ event: { $in: BOT_EVENT_ORDER_NAMES } }, botEventDealsCond()],
    })
    expect(BOT_EVENT_ORDER_NAMES).to.have.length(4)
  })

  it('matches events the way Mongo would (union semantics)', () => {
    // Tiny evaluator for the shapes this module emits.
    const match = (doc: Record<string, unknown>, q: any): boolean => {
      if (q.$or) return q.$or.some((c: any) => match(doc, c))
      if (q.$and) return q.$and.every((c: any) => match(doc, c))
      if (q.$nor) return !q.$nor.some((c: any) => match(doc, c))
      return Object.entries(q).every(([k, v]: [string, any]) => {
        const val = doc[k]
        if (v && typeof v === 'object') {
          if ('$in' in v && !v.$in.includes(val)) return false
          if ('$exists' in v && (val !== undefined) !== v.$exists) return false
          if ('$nin' in v && v.$nin.includes(val ?? null)) return false
          return true
        }
        return val === v
      })
    }
    const events = [
      { id: 'fill', event: 'Order', type: 'info', deal: 'd1' },
      { id: 'orderErr', event: 'Order error', type: 'error', deal: 'd1' },
      { id: 'warn', event: 'Balance', type: 'warning' },
      { id: 'dealOpen', event: 'Deal open', type: 'info', deal: 'd2' },
      { id: 'started', event: 'Bot started', type: 'info' },
    ]
    const pick = (types: string[]) =>
      events.filter((e) => match(e, botEventTypesCond(types))).map((e) => e.id)

    expect(pick(['orders', 'errors'])).to.deep.equal(['fill', 'orderErr'])
    expect(pick(['warnings', 'errors'])).to.deep.equal(['orderErr', 'warn'])
    expect(pick(['deals', 'warnings'])).to.deep.equal([
      'fill',
      'warn',
      'dealOpen',
    ])
  })
})
