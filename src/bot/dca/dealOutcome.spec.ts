process.env.NODE_ENV = 'testing'

/**
 * Regression tests for how a deal's ending is reported.
 *
 * Replays the deal that produced the bug: a DCA short on Kraken linear futures,
 * deal cancelled while still holding 125 of the base asset, zero realized
 * profit. The event log said `Deal closed, id: …, profit: 0$`. The position was
 * still on the venue with no TP and no SL; it went unwatched for three days and
 * the venue liquidated into it.
 *
 * The defect was a sentence, so a sentence is what these pin. In particular the
 * `leave`-path message must keep the phrase "was left open on the exchange" —
 * `errorDict` maps exactly that substring to the `Position left open` subType,
 * and rewording it without updating the dict silently reclassifies the message.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/bot/dca/dealOutcome.spec.ts
 */
import {
  dealCloseEventDescription,
  dealLeftOpenSize,
  leftOpenPositionMessage,
  type DealOutcome,
} from './dealOutcome'
import { errorDict, getErrorSubType, positionLeftOpen } from '../utils'
import { DCADealStatusEnum } from '../../../types'

let failures = 0

const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected
  if (!ok) {
    failures++
    console.log(`FAIL ${name}\n  expected: ${expected}\n  actual:   ${actual}`)
  } else {
    console.log(`pass ${name}`)
  }
}

const contains = (name: string, haystack: string, needle: string) => {
  const ok = haystack.indexOf(needle) !== -1
  if (!ok) {
    failures++
    console.log(`FAIL ${name}\n  "${needle}" not found in:\n  ${haystack}`)
  } else {
    console.log(`pass ${name}`)
  }
}

// The abandoned deal, as recorded: 125 short, nothing realized.
const abandoned: DealOutcome = {
  _id: '000000000000000000000001',
  status: DCADealStatusEnum.canceled,
  size: 125,
  profit: { totalUsd: 0 },
  symbol: { symbol: 'XRP-USD', baseAsset: 'XRP' },
}

// --- dealLeftOpenSize: only a real, positive size is a position -------------

check('a held position reports its size', dealLeftOpenSize(125), 125)
check('a short recorded negative still counts', dealLeftOpenSize(-125), 125)
check('an empty deal holds nothing', dealLeftOpenSize(0), 0)
check('an absent size holds nothing', dealLeftOpenSize(undefined), 0)
check('NaN holds nothing', dealLeftOpenSize(NaN), 0)

// --- the event text ---------------------------------------------------------

// The regression itself: this exact deal must no longer say "Deal closed".
const abandonedText = dealCloseEventDescription(abandoned)
check(
  'an abandoned deal is not reported as closed',
  abandonedText.indexOf('Deal closed') === -1,
  true,
)
check(
  'an abandoned deal names size, asset and consequence',
  abandonedText,
  'Deal cancelled, id: 000000000000000000000001, position left open on the exchange: 125 XRP. This bot no longer manages it - no take profit and no stop loss will be applied. Close it on the exchange if you do not want to keep it.',
)

// A cancel that left nothing behind is not a warning — say the plain thing.
check(
  'a cancelled deal holding nothing stays terse',
  dealCloseEventDescription({ ...abandoned, size: 0 }),
  'Deal cancelled, id: 000000000000000000000001',
)

// A genuinely closed deal is untouched, including one that closed at a loss.
check(
  'a closed deal still reports profit',
  dealCloseEventDescription({
    ...abandoned,
    status: DCADealStatusEnum.closed,
    profit: { totalUsd: 12.5 },
  }),
  'Deal closed, id: 000000000000000000000001, profit: 12.5$',
)
check(
  'a closed deal that still shows size is not treated as abandoned',
  dealCloseEventDescription({
    ...abandoned,
    status: DCADealStatusEnum.closed,
    profit: { totalUsd: -9.99 },
  }),
  'Deal closed, id: 000000000000000000000001, profit: -9.99$',
)

// --- the leave-path message and its classification --------------------------

const leaveText = leftOpenPositionMessage(abandoned)
contains(
  'the leave message carries the phrase errorDict keys on',
  leaveText,
  'was left open on the exchange',
)
contains('the leave message names the pair', leaveText, 'on XRP-USD')
check(
  'the phrase is still the errorDict key',
  errorDict['was left open on the exchange' as keyof typeof errorDict],
  positionLeftOpen,
)
// The end-to-end guarantee: this message classifies as its own subType and is
// never mistaken for one of the real error families.
check(
  'the leave message classifies as Position left open',
  getErrorSubType(leaveText),
  positionLeftOpen,
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
