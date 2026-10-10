process.env.NODE_ENV = 'testing'

/**
 * A price-connector restart makes every indicator in a worker re-request its
 * candle stream in the same tick. The batcher must send each distinct stream
 * once per burst — and never swallow a request made after a batch went out.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { CandlesRequestBatcher, type CandlesRequest } from './candlesRequests'

const req = (symbol: string, interval = '1h'): CandlesRequest => ({
  symbol,
  exchange: 'binance',
  interval,
})

describe('CandlesRequestBatcher', () => {
  it('sends identical requests in one burst once', async () => {
    const sent: CandlesRequest[] = []
    const b = new CandlesRequestBatcher((p) => {
      sent.push(p)
    }, 10_000)
    for (let i = 0; i < 50; i++) {
      b.request(req('BTCUSDT'))
      b.request(req('ETHUSDT'))
      b.request(req('BTCUSDT', '4h'))
    }
    expect(sent).to.have.length(0)
    await b.flush()
    expect(sent).to.deep.equal([
      req('BTCUSDT'),
      req('ETHUSDT'),
      req('BTCUSDT', '4h'),
    ])
  })

  it('flushes by itself after the window', async () => {
    const sent: CandlesRequest[] = []
    const b = new CandlesRequestBatcher((p) => {
      sent.push(p)
    }, 5)
    b.request(req('BTCUSDT'))
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).to.deep.equal([req('BTCUSDT')])
    expect(b.pendingCount).to.equal(0)
  })

  it('never merges a request with one that was already sent', async () => {
    // e.g. a connector restart right after an indicator was armed: the
    // re-request must go out even though the same stream was just requested
    const sent: CandlesRequest[] = []
    const b = new CandlesRequestBatcher((p) => {
      sent.push(p)
    }, 10_000)
    b.request(req('BTCUSDT'))
    await b.flush()
    b.request(req('BTCUSDT'))
    await b.flush()
    expect(sent).to.have.length(2)
  })

  it('a request added while a batch is sending lands in the next batch', async () => {
    const sent: CandlesRequest[] = []
    const b: CandlesRequestBatcher = new CandlesRequestBatcher(async (p) => {
      sent.push(p)
      if (p.symbol === 'BTCUSDT') b.request(req('BTCUSDT'))
    }, 10_000)
    b.request(req('BTCUSDT'))
    await b.flush()
    expect(b.pendingCount).to.equal(1)
    await b.flush()
    expect(sent).to.have.length(2)
  })

  it('one failing send does not drop the rest of the batch', async () => {
    const sent: string[] = []
    const b = new CandlesRequestBatcher((p) => {
      if (p.symbol === 'BAD') throw new Error('boom')
      sent.push(p.symbol)
    }, 10_000)
    b.request(req('BAD'))
    b.request(req('ETHUSDT'))
    await b.flush()
    expect(sent).to.deep.equal(['ETHUSDT'])
  })
})
