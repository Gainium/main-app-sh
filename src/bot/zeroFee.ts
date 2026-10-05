import { ExchangeEnum } from '../../types'

/** Venues whose fee handling ignores the Ignore Fees switch. */
const zeroFeeExcluded: ExchangeEnum[] = [
  ExchangeEnum.okx,
  ExchangeEnum.okxInverse,
  ExchangeEnum.okxLinear,
  ExchangeEnum.bybit,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.bybitUsdm,
]

/**
 * Whether a bot on this connection prices its orders at zero fee (spec 131).
 * Decided on load and again whenever the connection changes under a running
 * bot, so both must ask the same question.
 */
export const zeroFeeApplies = (
  connection: { zeroFee?: boolean | null; provider: ExchangeEnum },
  paperContext?: boolean,
) =>
  !!connection.zeroFee &&
  !paperContext &&
  !zeroFeeExcluded.includes(connection.provider)
