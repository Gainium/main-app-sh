import type { MATrendResult } from '@gainium/indicators'
import { IndicatorEnum } from '../../types'

/**
 * The value the indicator service stores in a room's history for one closed
 * candle, from the indicator instance's `result` — the shape the condition
 * decision (`conditions/evaluate.ts`) reads:
 *
 *  - PSAR: `{ psar, price }`;
 *  - Bollinger / Keltner: `{ result, price }`;
 *  - Moving Average: `{ ma, price, maType }`, plus `trend` when the trend
 *    filter is on (the instance is then `MATrendFilter`, whose `value` is the
 *    plain MA bit for bit and `trend` its MAR-style trend code);
 *  - everything else: the result as it is.
 */
export function indicatorHistoryValue(
  type: IndicatorEnum,
  result: unknown,
  close: number,
  maType: string,
): unknown {
  if (type === IndicatorEnum.psar)
    return { psar: result as number, price: close }
  if (type === IndicatorEnum.bb || type === IndicatorEnum.kc)
    return { result, price: close }
  if (type !== IndicatorEnum.ma) return result
  if (typeof result === 'object' && result !== null)
    return {
      ma: (result as MATrendResult).value,
      price: close,
      maType,
      trend: (result as MATrendResult).trend,
    }
  return { ma: result as number, price: close, maType }
}
