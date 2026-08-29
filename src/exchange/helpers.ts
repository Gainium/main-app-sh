import {
  BotMarginTypeEnum,
  ExchangeDomain,
  ExchangeEnum,
  PositionSide_LT,
  TradeTypeEnum,
} from '../../types'

export const getFtxDomain = (domain: ExchangeDomain) => {
  return domain === ExchangeDomain.us ? 'ftxus' : 'ftxcom'
}

export const getBinanceBase = (domain: ExchangeDomain) => {
  return domain === ExchangeDomain.us
    ? 'https://api.binance.us'
    : 'https://api.binance.com'
}

export const getExchangeDomain = (exchange: ExchangeEnum) => {
  if ([ExchangeEnum.ftxUS, ExchangeEnum.binanceUS].includes(exchange)) {
    return ExchangeDomain.us
  }
  return ExchangeDomain.com
}

export const getExchangeTradeType = (exchange: ExchangeEnum) => {
  if (
    [
      ExchangeEnum.binanceCoinm,
      ExchangeEnum.binanceUsdm,
      ExchangeEnum.bybitUsdm,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.okxInverse,
      ExchangeEnum.okxLinear,
      ExchangeEnum.kucoinInverse,
      ExchangeEnum.kucoinLinear,
      ExchangeEnum.bitgetUsdm,
      ExchangeEnum.bitgetCoinm,
      ExchangeEnum.krakenUsdm,
      ExchangeEnum.hyperliquidLinear,
      ExchangeEnum.krakenCoinm,
    ].includes(exchange)
  ) {
    return TradeTypeEnum.futures
  }
  return TradeTypeEnum.spot
}

export const getFuturePositionId = (positionData: {
  exchange: string
  symbol: string
  marginType: BotMarginTypeEnum
  leverage: string
  positionSide: PositionSide_LT
  paper: boolean
}): string => {
  const { symbol, leverage, marginType, positionSide, exchange, paper } =
    positionData
  return (
    `${paper}@${exchange}@${symbol}-${leverage}-${positionSide}` +
    (positionSide === 'BOTH' ? '' : `-${marginType}`)
  )
}

export const removePaperFormExchangeName = (exchange: ExchangeEnum) => {
  return exchange === ExchangeEnum.paperBinance
    ? ExchangeEnum.binance
    : exchange === ExchangeEnum.paperBybit
      ? ExchangeEnum.bybit
      : exchange === ExchangeEnum.paperKucoin
        ? ExchangeEnum.kucoin
        : exchange === ExchangeEnum.paperKucoinInverse
          ? ExchangeEnum.kucoinInverse
          : exchange === ExchangeEnum.paperKucoinLinear
            ? ExchangeEnum.kucoinLinear
            : exchange === ExchangeEnum.paperBinanceCoinm
              ? ExchangeEnum.binanceCoinm
              : exchange === ExchangeEnum.paperBinanceUsdm
                ? ExchangeEnum.binanceUsdm
                : exchange === ExchangeEnum.paperBybitCoinm
                  ? ExchangeEnum.bybitCoinm
                  : exchange === ExchangeEnum.paperBybitUsdm
                    ? ExchangeEnum.bybitUsdm
                    : exchange === ExchangeEnum.paperCoinbase
                      ? ExchangeEnum.coinbase
                      : exchange === ExchangeEnum.paperOkx
                        ? ExchangeEnum.okx
                        : exchange === ExchangeEnum.paperOkxInverse
                          ? ExchangeEnum.okxInverse
                          : exchange === ExchangeEnum.paperOkxLinear
                            ? ExchangeEnum.okxLinear
                            : exchange === ExchangeEnum.paperKraken
                              ? ExchangeEnum.kraken
                              : exchange === ExchangeEnum.paperKrakenUsdm
                                ? ExchangeEnum.krakenUsdm
                                : exchange === ExchangeEnum.paperKrakenCoinm
                                  ? ExchangeEnum.krakenCoinm
                                  : exchange === ExchangeEnum.paperBitgetCoinm
                                    ? ExchangeEnum.bitgetCoinm
                                    : exchange === ExchangeEnum.paperBitgetUsdm
                                      ? ExchangeEnum.bitgetUsdm
                                      : exchange ===
                                          ExchangeEnum.paperHyperliquidLinear
                                        ? ExchangeEnum.hyperliquidLinear
                                        : exchange ===
                                            ExchangeEnum.paperHyperliquid
                                          ? ExchangeEnum.hyperliquid
                                          : exchange === ExchangeEnum.bitget
                                            ? ExchangeEnum.bitget
                                            : exchange
}

/**
 * Whether a real (non-paper) connection on this venue is authenticated with a
 * passphrase alongside the key and secret.
 *
 * Needed on the credential-WRITE paths, which cannot ask the dashboard: the
 * edit form leaves the passphrase blank by design (we never send a stored
 * secret back to a browser), so the resolver has to know for itself whether a
 * blank field is "unchanged" or "missing".
 *
 * Mirrors `requiresPassphrase` in the dashboard's `exchangeConfig.ts`. Prefix
 * matching covers the per-market variants (okxSpot / okxLinear / bitgetUsdm /
 * …); paper providers are excluded because their credentials are minted by
 * paper-trading, not typed by the user.
 */
export const requiresPassphrase = (exchange: ExchangeEnum): boolean => {
  const name = `${exchange}`
  if (name.startsWith('paper')) {
    return false
  }
  return ['okx', 'kucoin', 'bitget'].some((venue) => name.startsWith(venue))
}
