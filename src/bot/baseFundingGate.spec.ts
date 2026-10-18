process.env.NODE_ENV = 'testing'

/**
 * Spec 044 beta gate: who gets base funding — the user role
 * `BaseFundingBeta` in `user.groups`, nothing else. Readers are injected; no
 * database.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRoleReader, resolveGroups } from '../utils/roleGate'
import {
  BASE_FUNDING_BETA_ROLE,
  BaseFundingGate,
  coerceBaseFundingSetting,
} from './baseFundingGate'

const gate = BaseFundingGate.getInstance()
const withGroups = (groups: Record<string, unknown>) =>
  createRoleReader(async (id) => groups[id])

describe('BaseFundingGate (spec 044 beta gate)', () => {
  afterEach(() => gate.setRoleReader(withGroups({})))

  it('allows exactly the users holding BaseFundingBeta', async () => {
    gate.setRoleReader(
      withGroups({
        a: [BASE_FUNDING_BETA_ROLE, 'Alpha'],
        b: ['Alpha'],
        c: ['basefundingbeta'],
        d: 'BaseFundingBeta',
      }),
    )
    expect(await gate.isAllowed('a')).to.equal(true)
    expect(await gate.isAllowed('b')).to.equal(false)
    // Case-sensitive, and only an array of names counts.
    expect(await gate.isAllowed('c')).to.equal(false)
    expect(await gate.isAllowed('d')).to.equal(false)
    expect(await gate.isAllowed('nobody')).to.equal(false)
    expect(await gate.isAllowed(undefined)).to.equal(false)
  })

  it('caches roles ≤ ttl, then reads again', async () => {
    let now = 0
    let groups: unknown = [BASE_FUNDING_BETA_ROLE]
    let reads = 0
    gate.setRoleReader(
      createRoleReader(
        async () => {
          reads++
          return groups
        },
        60_000,
        () => now,
      ),
    )
    expect(await gate.isAllowed('u')).to.equal(true)
    groups = []
    now = 59_000
    expect(await gate.isAllowed('u')).to.equal(true)
    expect(reads).to.equal(1)
    now = 60_001
    expect(await gate.isAllowed('u')).to.equal(false)
    expect(reads).to.equal(2)
  })

  it('a failed read keeps the last answer, or not granted', async () => {
    let now = 0
    let fail = false
    gate.setRoleReader(
      createRoleReader(
        async () => {
          if (fail) throw new Error('db down')
          return [BASE_FUNDING_BETA_ROLE]
        },
        10,
        () => now,
      ),
    )
    expect(await gate.isAllowed('u')).to.equal(true)
    fail = true
    now = 100
    expect(await gate.isAllowed('u')).to.equal(true)
    expect(await gate.isAllowed('never-read')).to.equal(false)
  })

  it('the role cache is bounded', async () => {
    let reads = 0
    const r = createRoleReader(
      async () => {
        reads++
        return []
      },
      60_000,
      () => 0,
      2,
    )
    await r.hasRole('a', 'x')
    await r.hasRole('b', 'x')
    await r.hasRole('c', 'x') // evicts a
    await r.hasRole('a', 'x')
    expect(reads).to.equal(4)
    expect(resolveGroups(['a', 1, null])).to.deep.equal(['a'])
  })

  it('settings writes: a non-beta user’s base-funding mode is stored as require', async () => {
    gate.setRoleReader(withGroups({ beta: [BASE_FUNDING_BETA_ROLE] }))
    expect(
      (await coerceBaseFundingSetting('other', { baseFunding: 'auto' }))
        .baseFunding,
    ).to.equal('require')
    expect(
      (await coerceBaseFundingSetting('beta', { baseFunding: 'botOnly' }))
        .baseFunding,
    ).to.equal('botOnly')
    const untouched = { name: 'x' } as { baseFunding?: string; name: string }
    await coerceBaseFundingSetting('other', untouched)
    expect('baseFunding' in untouched).to.equal(false)
  })
})
