process.env.NODE_ENV = 'testing'

/**
 * Moving a deal or grid to the terminal adopts its coins into a new terminal
 * deal. A repeat of the same move must not adopt them a second time.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, after, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../../types'

const load = createRequire(__filename)
const dbInit = load('../../db/dbInit')
const {
  withTerminalMoveGuard,
  terminalMoveRefusalReason,
  TERMINAL_MOVE_ALREADY_MOVED,
  TERMINAL_MOVE_IN_PROGRESS,
  TERMINAL_MOVE_SOURCE_ENDED,
} = load('./terminalMove')

const origRead = dbInit.dcaBotDb.readData
let liveImport: any = null
let readFilters: any[] = []
dbInit.dcaBotDb.readData = async (filter: any) => {
  readFilters.push(filter)
  return { status: StatusEnum.ok, data: { result: liveImport } }
}

describe('terminal move guard', () => {
  afterEach(() => {
    liveImport = null
    readFilters = []
  })
  after(() => {
    dbInit.dcaBotDb.readData = origRead
  })

  it('reason precedence', () => {
    const r = (o: any) =>
      terminalMoveRefusalReason({
        sourceEnded: false,
        inFlight: false,
        existingImport: false,
        ...o,
      })
    expect(r({})).to.equal(null)
    expect(r({ sourceEnded: true })).to.equal(TERMINAL_MOVE_SOURCE_ENDED)
    expect(r({ existingImport: true, sourceEnded: true })).to.equal(
      TERMINAL_MOVE_ALREADY_MOVED,
    )
    expect(r({ inFlight: true, existingImport: true })).to.equal(
      TERMINAL_MOVE_IN_PROGRESS,
    )
  })

  it('runs the move for an open source with no live import', async () => {
    let ran = 0
    const res = await withTerminalMoveGuard('u1', 'd1', false, async () => {
      ran++
      return { status: StatusEnum.ok }
    })
    expect(ran).to.equal(1)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(readFilters[0]).to.include({
      userId: 'u1',
      'settings.importFrom': 'd1',
    })
  })

  it('refuses a repeat move while the first terminal bot is live', async () => {
    liveImport = { _id: 'tb1' }
    let ran = 0
    const res = await withTerminalMoveGuard('u1', 'd1', false, async () => {
      ran++
    })
    expect(ran).to.equal(0)
    expect(res).to.deep.equal({
      status: StatusEnum.notok,
      reason: TERMINAL_MOVE_ALREADY_MOVED,
      data: null,
    })
  })

  it('refuses a source that has already ended', async () => {
    let ran = 0
    const res = await withTerminalMoveGuard('u1', 'd1', true, async () => {
      ran++
    })
    expect(ran).to.equal(0)
    expect(res.reason).to.equal(TERMINAL_MOVE_SOURCE_ENDED)
  })

  it('refuses a concurrent move of the same source (double submit)', async () => {
    let release!: () => void
    let ran = 0
    const first = withTerminalMoveGuard('u1', 'd1', false, () => {
      ran++
      return new Promise<any>((r) => (release = () => r({ status: 'OK' })))
    })
    await new Promise((r) => setImmediate(r))
    const second = await withTerminalMoveGuard('u1', 'd1', false, async () => {
      ran++
    })
    expect(second.reason).to.equal(TERMINAL_MOVE_IN_PROGRESS)
    release()
    await first
    expect(ran).to.equal(1)
    // claim released: a later move is judged on the DB again
    const third = await withTerminalMoveGuard('u1', 'd1', false, async () => ({
      status: 'OK',
    }))
    expect(third.status).to.equal('OK')
  })

  it('does not block a different source', async () => {
    let release!: () => void
    const first = withTerminalMoveGuard('u1', 'd1', false, () => {
      return new Promise<any>((r) => (release = () => r({ status: 'OK' })))
    })
    await new Promise((r) => setImmediate(r))
    const other = await withTerminalMoveGuard('u1', 'd2', false, async () => ({
      status: 'OK',
    }))
    expect(other.status).to.equal('OK')
    release()
    await first
  })
})
