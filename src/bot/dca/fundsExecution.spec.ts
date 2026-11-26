import { describe, it } from 'mocha'
import { expect } from 'chai'
import { planFundsExecution } from './orderExecution'

const base = { qty: 1, step: 0.001, minQty: 0.001, minNotional: 5, price: 100 }

describe('add funds — planFundsExecution', () => {
  it('no execution, market or limit → the plain add-funds order', () => {
    expect(planFundsExecution({ ...base, execution: undefined })).to.deep.equal(
      { run: false },
    )
    expect(planFundsExecution({ ...base, execution: null })).to.deep.equal({
      run: false,
    })
    expect(
      planFundsExecution({ ...base, execution: { mode: 'market' } }),
    ).to.deep.equal({ run: false })
    expect(
      planFundsExecution({
        ...base,
        execution: { mode: 'limit', timeoutSec: 0 },
      }),
    ).to.deep.equal({ run: false })
  })

  it('GraphQL nulls are dropped before validation', () => {
    const plan = planFundsExecution({
      ...base,
      execution: {
        mode: 'chase',
        repriceSec: 15,
        maxChasePerc: 1,
        timeoutSec: 60,
        slices: null,
        pace: null,
      },
    })
    expect(plan).to.deep.equal({
      run: true,
      execution: {
        mode: 'chase',
        repriceSec: 15,
        maxChasePerc: 1,
        timeoutSec: 60,
      },
      sizes: [1],
    })
  })

  it('chase → one chasing slice of the whole amount', () => {
    const plan = planFundsExecution({ ...base, execution: { mode: 'chase' } })
    expect(plan).to.deep.equal({
      run: true,
      execution: {
        mode: 'chase',
        repriceSec: 10,
        maxChasePerc: 0,
        timeoutSec: 0,
      },
      sizes: [1],
    })
  })

  it('split → slices summing to the amount; limit slices become chase', () => {
    const plan = planFundsExecution({
      ...base,
      execution: {
        mode: 'split',
        slices: 4,
        sliceMode: 'limit',
        pace: 'iceberg',
      },
    })
    if (!('run' in plan) || !plan.run) throw new Error('expected a run')
    expect(plan.sizes).to.deep.equal([0.25, 0.25, 0.25, 0.25])
    expect(plan.execution.sliceMode).to.equal('chase')
  })

  it('split too small to slice → one order: chase, or market almost at once', () => {
    const tiny = { ...base, qty: 0.06 } // 6 USDT: a slice would be under the 5 USDT minimum
    const chase = planFundsExecution({
      ...tiny,
      execution: { mode: 'split', slices: 5 },
    })
    expect(chase).to.deep.include({ run: true, sizes: [0.06] })
    if (!('run' in chase) || !chase.run) throw new Error('expected a run')
    expect(chase.execution).to.include({ mode: 'chase', timeoutSec: 35 })
    const market = planFundsExecution({
      ...tiny,
      execution: { mode: 'split', slices: 5, sliceMode: 'market' },
    })
    if (!('run' in market) || !market.run) throw new Error('expected a run')
    expect(market.execution).to.include({ mode: 'chase', timeoutSec: 1 })
  })

  it('refuses an invalid execution', () => {
    expect(
      planFundsExecution({ ...base, execution: { mode: 'teleport' } }),
    ).to.have.property('error')
    expect(
      planFundsExecution({
        ...base,
        execution: { mode: 'split', slices: 500 },
      }),
    ).to.have.property('error')
    expect(
      planFundsExecution({ ...base, execution: 'chase' }),
    ).to.have.property('error')
  })
})
