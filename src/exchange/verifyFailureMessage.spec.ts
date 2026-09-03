process.env.NODE_ENV = 'testing'

/**
 * Tests for the Coinbase rules in the verify-failure interpreter — above all
 * the Ed25519 rule, which exists because the portal now issues Ed25519 keys BY
 * DEFAULT and our SDK signs ES256 only. The property these tests protect: an
 * Ed25519-shaped secret must ALWAYS get the recreate-with-ECDSA guidance,
 * whatever Key Type is selected and whatever the venue said — and must never
 * fall through to the key-type-mismatch rules, whose "switch to Legacy Keys"
 * advice is the one change that cannot help.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  buildVerifyFailureReason,
  interpretVerifyFailure,
} from './verifyFailureMessage'
import { CoinbaseKeysType, ExchangeEnum, TradeTypeEnum } from '../../types'

// 88 chars of base64 with '==' padding — the shape of a CDP Ed25519 export.
const ED25519_SECRET = `${'A'.repeat(43)}${'b'.repeat(43)}==`
const EC_PEM_SECRET =
  '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBs=\n-----END EC PRIVATE KEY-----'
const ES256_REASON =
  'Coinbase catch {"status":"NOTOK","reason":"secretOrPrivateKey must be an asymmetric key when using ES256","data":null}'

const coinbaseCtx = (over: {
  reason?: string
  key?: string
  secret?: string
  keysType?: CoinbaseKeysType
}) => ({
  provider: ExchangeEnum.coinbase,
  tradeType: TradeTypeEnum.spot,
  ...over,
})

const isEd25519Guidance = (s?: string) => !!s && /Ed25519/.test(s)

describe('verifyFailureMessage', () => {
  // The rule fires on the secret's shape alone, under either Key Type.
  it('ed25519 shape, cloud selected → ECDSA guidance', () => {
    expect(
      isEd25519Guidance(
        interpretVerifyFailure(
          coinbaseCtx({
            reason: ES256_REASON,
            key: 'a1b2c3d4-0000-0000-0000-000000000000',
            secret: ED25519_SECRET,
            keysType: CoinbaseKeysType.cloud,
          }),
        ),
      ),
    ).to.equal(true)
  })
  it('ed25519 shape, legacy default, opaque 401 → ECDSA guidance', () => {
    expect(
      isEd25519Guidance(
        interpretVerifyFailure(
          coinbaseCtx({
            reason: 'Coinbase catch {"status":"NOTOK","reason":"401","data":null}',
            key: 'a1b2c3d4-0000-0000-0000-000000000000',
            secret: ED25519_SECRET,
            keysType: CoinbaseKeysType.legacy,
          }),
        ),
      ),
    ).to.equal(true)
  })
  it('unpadded 86-char base64 and surrounding whitespace still match', () => {
    expect(
      isEd25519Guidance(
        interpretVerifyFailure(
          coinbaseCtx({ secret: ` ${ED25519_SECRET.slice(0, 86)}\n` }),
        ),
      ),
    ).to.equal(true)
  })

  // Belt and braces: the ES256 signing error alone triggers it, so the guidance
  // survives Coinbase reshaping its key export.
  it('ES256 error without the shape → ECDSA guidance', () => {
    expect(
      isEd25519Guidance(
        interpretVerifyFailure(coinbaseCtx({ reason: ES256_REASON, secret: 'short' })),
      ),
    ).to.equal(true)
  })

  // Non-Ed25519 shapes must keep today's answers.
  it('EC PEM secret with legacy selected → key-type mismatch, not Ed25519', () => {
    expect(
      interpretVerifyFailure(
        coinbaseCtx({
          key: 'organizations/x/apiKeys/y',
          secret: EC_PEM_SECRET,
          keysType: CoinbaseKeysType.legacy,
        }),
      )?.includes('Cloud Trading Keys'),
    ).to.equal(true)
  })
  it('short legacy secret with cloud selected → not-a-CDP-key advice', () => {
    expect(
      interpretVerifyFailure(
        coinbaseCtx({
          key: 'a1b2c3d4e5f6',
          secret: 'abc123DEF456ghi789JKL012',
          keysType: CoinbaseKeysType.cloud,
        }),
      )?.includes('does not look like a Coinbase Developer Platform key'),
    ).to.equal(true)
  })
  it('ordinary 64-char secret does not look Ed25519', () => {
    expect(
      isEd25519Guidance(
        interpretVerifyFailure(coinbaseCtx({ secret: 'a'.repeat(64) })),
      ),
    ).to.equal(false)
  })

  describe('the full reason', () => {
    // The full reason keeps the venue's own words underneath the guidance.
    const full = buildVerifyFailureReason(
      coinbaseCtx({
        reason: ES256_REASON,
        key: 'a1b2c3d4-0000-0000-0000-000000000000',
        secret: ED25519_SECRET,
        keysType: CoinbaseKeysType.cloud,
      }),
    )
    it('leads with the guidance', () => {
      expect(/^This is an Ed25519/.test(full)).to.equal(true)
    })
    it('keeps the ES256 evidence', () => {
      expect(full.includes('asymmetric key when using ES256')).to.equal(true)
    })
  })
})
