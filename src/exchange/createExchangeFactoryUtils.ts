import { BybitHost, CoinbaseKeysType, OKXSource } from '../../types'
import AbsctractExchange from './index'

export interface BoundExchangeType<T, A extends unknown[]> extends Function {
  new (...args: BoundArgs<A, ExchangeArgs>): T
}
export type BoundArgs<A extends unknown[], B extends unknown[]> = [
  ...args1: A,
  ...args2: B,
]

export type ExchangeArgs = [
  string,
  string,
  string | undefined,
  'live' | 'sandbox' | undefined,
  CoinbaseKeysType | undefined,
  OKXSource | undefined,
  BybitHost | undefined,
  boolean | undefined,
  boolean | undefined,
]

export type ExchangeType<
  T extends AbsctractExchange,
  A extends unknown[],
> = BoundExchangeType<T, A>

export type ExchangeFactory<T extends AbsctractExchange> = (
  key: string,
  secret: string,
  _passphrase?: string,
  _environment?: 'live' | 'sandbox',
  keysType?: CoinbaseKeysType,
  okxSource?: OKXSource,
  bybitHost?: BybitHost,
  subacount?: boolean,
  shouldCheckAffiliate?: boolean,
) => T

export function createExchangeFactory<
  T extends AbsctractExchange,
  A extends unknown[],
>(exchange: ExchangeType<T, A>, ...args: A): ExchangeFactory<T> {
  return bindExchange(exchange, ...args)
}

function bindExchange<T, A extends unknown[]>(
  exchange: BoundExchangeType<T, A>,
  ...bindArgs: A
) {
  return (...args: ExchangeArgs) => new exchange(...bindArgs, ...args)
}
