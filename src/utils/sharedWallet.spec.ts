process.env.NODE_ENV = 'testing'

/**
 * Unified accounts: legs that share one wallet are linked to their spot leg,
 * so the wallet is stored and summed once. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import { encrypt } from './crypto'
import {
  groupSharedKeyLegs,
  planSharedWalletLinks,
  walletUuidOf,
} from './sharedWallet'

const leg = (
  uuid: string,
  provider: ExchangeEnum,
  key: string,
  linkedTo?: string | null,
) => ({
  uuid,
  provider,
  key: encrypt(key),
  secret: encrypt(`${key}-secret`),
  linkedTo,
})

describe('shared wallet — grouping legs by key', () => {
  it('groups one key across a family, sourced at the spot leg', async () => {
    const groups = await groupSharedKeyLegs([
      leg('lin', ExchangeEnum.bitgetUsdm, 'A'),
      leg('inv', ExchangeEnum.bitgetCoinm, 'A'),
      leg('spot', ExchangeEnum.bitget, 'A'),
      leg('other', ExchangeEnum.bitget, 'B'),
    ])
    expect(groups).to.have.length(1)
    expect(groups[0].source.uuid).to.equal('spot')
    expect(groups[0].others.map((o) => o.uuid)).to.have.members(['lin', 'inv'])
  })

  it('never groups across families or outside them', async () => {
    const groups = await groupSharedKeyLegs([
      leg('hl', ExchangeEnum.hyperliquid, 'A'),
      leg('bg', ExchangeEnum.bitgetUsdm, 'A'),
      leg('by', ExchangeEnum.bybitUsdm, 'A'),
    ])
    expect(groups).to.have.length(0)
  })

  it('groups Hyperliquid legs by wallet address, whatever the agent or case', async () => {
    const spot = leg('spot', ExchangeEnum.hyperliquid, '0xAbC')
    const lin = {
      ...leg('lin', ExchangeEnum.hyperliquidLinear, '0xabc'),
      secret: encrypt('another-agent'),
    }
    const groups = await groupSharedKeyLegs([spot, lin])
    expect(groups).to.have.length(1)
    expect(groups[0].source.uuid).to.equal('spot')
  })

  it('keeps Bitget legs with different secrets apart', async () => {
    const a = leg('a', ExchangeEnum.bitget, 'A')
    const b = {
      ...leg('b', ExchangeEnum.bitgetUsdm, 'A'),
      secret: encrypt('x'),
    }
    expect(await groupSharedKeyLegs([a, b])).to.have.length(0)
  })

  it('without a spot leg keeps the current link target as source', async () => {
    const groups = await groupSharedKeyLegs([
      leg('lin', ExchangeEnum.bitgetUsdm, 'A', 'inv'),
      leg('inv', ExchangeEnum.bitgetCoinm, 'A'),
    ])
    expect(groups[0].source.uuid).to.equal('inv')
  })
})

describe('shared wallet — link plan', () => {
  const group = {
    source: leg('spot', ExchangeEnum.hyperliquid, 'A'),
    others: [leg('lin', ExchangeEnum.hyperliquidLinear, 'A')],
  }

  it('links the other legs of a unified wallet', () => {
    expect(planSharedWalletLinks(group, true)).to.deep.equal({
      link: [{ uuid: 'lin', to: 'spot' }],
      unlink: [],
    })
  })

  it('is idempotent once linked', () => {
    const linked = {
      ...group,
      others: [leg('lin', ExchangeEnum.hyperliquidLinear, 'A', 'spot')],
    }
    expect(planSharedWalletLinks(linked, true)).to.deep.equal({
      link: [],
      unlink: [],
    })
  })

  it('unlinks legs of an account that left unified mode', () => {
    const linked = {
      ...group,
      others: [leg('lin', ExchangeEnum.hyperliquidLinear, 'A', 'spot')],
    }
    expect(planSharedWalletLinks(linked, false)).to.deep.equal({
      link: [],
      unlink: ['lin'],
    })
  })

  it('changes nothing when the venue could not answer', () => {
    const linked = {
      ...group,
      others: [leg('lin', ExchangeEnum.hyperliquidLinear, 'A', 'spot')],
    }
    expect(planSharedWalletLinks(linked, null)).to.deep.equal({
      link: [],
      unlink: [],
    })
    expect(planSharedWalletLinks(group, null)).to.deep.equal({
      link: [],
      unlink: [],
    })
  })
})

describe("shared wallet — where a leg's balances live", () => {
  const exchanges = [
    { uuid: 'spot' },
    { uuid: 'lin', linkedTo: 'spot' },
    { uuid: 'solo', linkedTo: null },
  ]
  it('a linked leg reads its source', () => {
    expect(walletUuidOf(exchanges, 'lin')).to.equal('spot')
  })
  it('an unlinked or unknown leg reads itself', () => {
    expect(walletUuidOf(exchanges, 'solo')).to.equal('solo')
    expect(walletUuidOf(exchanges, 'spot')).to.equal('spot')
    expect(walletUuidOf(undefined, 'x')).to.equal('x')
  })
})
