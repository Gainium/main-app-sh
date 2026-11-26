import { expect } from 'chai'
import v2API from './api'

// A global variable can feed every bot of the account, real and paper, so a
// key restricted to one bot or one trading context must not write it.
describe('v2 global variables: restricted API keys', () => {
  const api = v2API()
  const writes: [string, any][] = [
    ['POST /api/v2/user/global-vars', api.post.get('/api/v2/user/global-vars')],
    ['PUT /api/v2/user/global-vars/:id', api.put.get('/api/v2/user/global-vars/:id')],
    ['DELETE /api/v2/user/global-vars/:id', api.delete.get('/api/v2/user/global-vars/:id')],
  ]

  const runMiddlewares = async (route: any, userData: any) => {
    let status = 0
    let reached = false
    const req: any = { userData, params: { id: 'v1' }, query: {}, body: {} }
    const res: any = {
      status(s: number) {
        status = s
        return this
      },
      json() {
        return this
      },
    }
    let i = 0
    const next = async (): Promise<void> => {
      const mw = route.middlewares[i++]
      if (!mw) {
        reached = true
        return
      }
      await mw(req, res, next)
    }
    await next()
    return { status, reached }
  }

  for (const [name, route] of writes) {
    describe(name, () => {
      it('exists', () => expect(route).to.not.equal(undefined))
      it('refuses a key restricted to one bot', async () => {
        const r = await runMiddlewares(route, { id: 'u1', keyBotId: 'b1' })
        expect(r.reached).to.equal(false)
        expect(r.status).to.equal(403)
      })
      it('refuses a paper-only key', async () => {
        const r = await runMiddlewares(route, { id: 'u1', keyPaperContext: true })
        expect(r.reached).to.equal(false)
        expect(r.status).to.equal(403)
      })
      it('refuses a real-only key', async () => {
        const r = await runMiddlewares(route, { id: 'u1', keyPaperContext: false })
        expect(r.reached).to.equal(false)
        expect(r.status).to.equal(403)
      })
      it('lets an unrestricted key through', async () => {
        const r = await runMiddlewares(route, { id: 'u1' })
        expect(r.reached).to.equal(true)
      })
    })
  }
})
