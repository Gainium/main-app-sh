import type {
  DCABacktestingInput,
  Prices,
  Symbols,
} from '@gainium/backtester/dist/types'

import type { ServerSideBacktestPayload } from '../../../../types'

/**
 * The input a server-side DCA / combo backtest hands the backtester: the
 * request's data as sent — bot settings included verbatim, so settings the
 * backtester reads under their bot names (`singlePosition`,
 * `maxPositionEntries`, spec 139 §8.1) reach it with no mapping — plus the
 * loaded prices and symbols.
 */
export const dcaBacktesterInput = (
  data: ServerSideBacktestPayload['data'],
  prices: Prices,
  symbols: Symbols[],
): DCABacktestingInput =>
  ({
    ...data,
    prices,
    symbols,
    useFile: true,
  }) as DCABacktestingInput
