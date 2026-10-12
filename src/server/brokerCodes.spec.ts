/**
 * Spec 147 — the self-hosted API serves the broker-codes feed.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 */
import { expect } from 'chai'
import type express from 'express'
import * as dbInit from '../db/dbInit'
import { StatusEnum } from '../../types'
import { brokerCodesHandler } from './brokerCodes'

const rows = [
  { exchange: 'hyperliquid', code: '0xbuilder' },
  { exchange: 'bybit', code: 'plain' },
  { exchange: 'bybit', zone: 'eu', code: 'zoned' },
]

const call = async (query: Record<string, string>) => {
  const out: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      out.status = code
      return this
    },
    send(body: unknown) {
      out.body = body
      return this
    },
  } as unknown as express.Response
  await brokerCodesHandler({ query } as unknown as express.Request, res)
  return out
}

describe('147 — GET /broker-codes', () => {
  let restore: typeof dbInit.brokerCodesDb.readData
  let readArgs: unknown[] = []
  let readResult: unknown

  beforeEach(() => {
    restore = dbInit.brokerCodesDb.readData
    readResult = {
      status: StatusEnum.ok,
      data: { result: rows.map((r) => ({ ...r })) },
      reason: null,
    }
    ;(dbInit.brokerCodesDb as any).readData = async (...args: unknown[]) => {
      readArgs = args
      return readResult
    }
  })

  afterEach(() => {
    dbInit.brokerCodesDb.readData = restore
  })

  it('§1.1.1 drops zoned rows without v=2', async () => {
    const out = await call({})
    expect(out.status).to.equal(200)
    expect(out.body).to.deep.equal(rows.filter((r) => !r.zone))
  })

  it('§1.1.2 returns every row with v=2', async () => {
    const out = await call({ v: '2' })
    expect(out.status).to.equal(200)
    expect(out.body).to.deep.equal(rows)
    expect(
      (out.body as { exchange: string; code: string }[]).find(
        (r) => r.exchange === 'hyperliquid',
      )?.code,
    ).to.equal('0xbuilder')
  })

  it('§1.1 reads all rows without _id', async () => {
    await call({ v: '2' })
    expect(readArgs[0]).to.deep.equal({})
    expect(readArgs[1]).to.deep.equal({ exchange: 1, code: 1, zone: 1, _id: 0 })
    expect(readArgs[3]).to.equal(true)
  })

  it('§1.1.3 answers [] with 400 when the read fails', async () => {
    readResult = { status: StatusEnum.notok, data: null, reason: 'down' }
    const out = await call({ v: '2' })
    expect(out.status).to.equal(400)
    expect(out.body).to.deep.equal([])
  })
})
