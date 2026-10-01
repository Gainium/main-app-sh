process.env.NODE_ENV = 'testing'

/**
 * Secrets must never reach a log line. Run: `npm test` (mocha).
 *
 * The sample values below are built at runtime and are not real credentials.
 */
import { inspect } from 'util'
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { redactSecrets, sanitizeError, REDACTED } from './redactSecrets'
import logger from './logger'

const SECRET = 'AAH' + 'x9Kq_-'.repeat(6) // 39 chars of the token alphabet
const TOKEN = `7012345678:${SECRET}`
const URL = `https://api.telegram.org/bot${TOKEN}/sendMessage`

describe('redactSecrets', () => {
  it('redacts a bot token inside a request URL', () => {
    const out = redactSecrets(`request to ${URL} failed, reason: ETIMEDOUT`)
    expect(out).to.not.include(SECRET)
    expect(out).to.include(
      `https://api.telegram.org/bot${REDACTED}/sendMessage`,
    )
  })

  it('redacts a bare token', () => {
    const out = redactSecrets(`token=${TOKEN}; next`)
    expect(out).to.not.include(SECRET)
    expect(out).to.equal(`token=${REDACTED}; next`)
  })

  it('leaves ordinary text alone', () => {
    const text = 'deal 12345:closed at 2026-10-01T00:00:00Z id 68e9b71c'
    expect(redactSecrets(text)).to.equal(text)
  })

  it('passes non-strings through', () => {
    expect(redactSecrets(undefined as unknown as string)).to.equal(undefined)
  })
})

describe('sanitizeError', () => {
  it('redacts message and stack, and keeps the diagnostic fields', () => {
    const err = Object.assign(new Error(`request to ${URL} failed`), {
      code: 'ETIMEDOUT',
      response: { error_code: 401, description: 'Unauthorized' },
      config: { url: URL, headers: { a: 1 } },
    })
    const safe = sanitizeError(err) as Error & Record<string, unknown>
    const rendered = JSON.stringify({
      m: safe.message,
      s: safe.stack,
      ...safe,
    })
    expect(rendered).to.not.include(SECRET)
    expect(safe.code).to.equal('ETIMEDOUT')
    expect(safe.response).to.deep.equal({
      error_code: 401,
      description: 'Unauthorized',
    })
    expect(safe).to.not.have.property('config')
  })

  it('sanitizes a nested cause', () => {
    const inner = new Error(`request to ${URL} failed`)
    const outer = new Error('send failed', { cause: inner })
    const safe = sanitizeError(outer) as Error & { cause?: Error }
    expect(safe.cause?.message).to.not.include(SECRET)
    expect(safe.cause?.message).to.include(REDACTED)
  })
})

describe('logger', () => {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  }
  let captured: string[] = []
  const capture = (...args: unknown[]) => {
    captured.push(
      // Render exactly as console would.
      args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '),
    )
  }
  afterEach(() => {
    console.log = original.log
    console.error = original.error
    console.warn = original.warn
    captured = []
  })
  const install = () => {
    console.log = capture
    console.error = capture
    console.warn = capture
  }

  it('redacts a token in a string argument', () => {
    install()
    logger.error(`Error on send message: FetchError: request to ${URL}`)
    expect(captured.join('\n').includes(SECRET)).to.equal(false)
    expect(captured.join('\n')).to.include(REDACTED)
  })

  it('redacts a token anywhere in a logged error object', () => {
    install()
    const err = Object.assign(new Error(`request to ${URL} failed`), {
      config: { url: URL },
    })
    const outer = new Error('wrapper', { cause: err })
    logger.error('[pool]', 'Polling error:', outer)
    logger.warn('[pool]', { request: { path: `/bot${TOKEN}/getUpdates` } })
    expect(captured.join('\n').includes(SECRET)).to.equal(false)
  })

  it('leaves a line without secrets unchanged', () => {
    install()
    logger.info('[x]', 'plain', 42)
    expect(captured[0]).to.include('[x] plain 42')
  })
})
