import { expect } from 'chai'
import { webhookBotNotRunningReason } from './tradeSignalContract'

describe('webhookBotNotRunningReason', () => {
  it('says not found only when no bot holds the uuid', () => {
    expect(webhookBotNotRunningReason(undefined, 'addFunds')).to.equal(
      'Bot not found',
    )
  })
  it('says stopped for a closed bot', () => {
    expect(webhookBotNotRunningReason('closed', 'closeDeal')).to.match(
      /^Bot is stopped, so "closeDeal" was not executed/,
    )
  })
  it('says archived for an archived bot', () => {
    expect(webhookBotNotRunningReason('archive', 'startDeal')).to.match(
      /^Bot is archived/,
    )
  })
  it('says restarting for an active bot that is not loaded', () => {
    for (const s of ['open', 'range', 'error', 'monitoring']) {
      expect(webhookBotNotRunningReason(s, 'addFunds')).to.match(
        /^Bot is restarting on our side, so "addFunds" was not executed/,
      )
    }
  })
})
