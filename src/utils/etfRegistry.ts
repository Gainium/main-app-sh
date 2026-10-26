import logger from './logger'

/**
 * Registry of US-listed ETFs: ticker → fund name, from Nasdaq Trader's symbol
 * directory (every security listed on a US exchange, with an ETF flag). It
 * serves two jobs, both automatic — there is no hand-kept list to maintain:
 *   - naming: funds are absent from the SEC company list (`saveAssetNames`);
 *   - classification: exchanges tag tokenized ETFs as plain stocks (Bitget,
 *     Binance, OKX), so a stock whose underlying is in this registry is an ETF
 *     (`classifyAssetClass`).
 * Only ETF rows are kept: company rows carry a share-class suffix (`Apple Inc.
 * - Common Stock`). Two pipe-delimited files with different column orders, so
 * columns are found by header name. Fetched lazily, cached for a day; on a
 * failed refresh the last good copy is kept, and an empty map means "unknown".
 */
const NASDAQ_SYMBOL_FILES = [
  'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
  'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
]
const TTL_MS = 24 * 60 * 60 * 1000
let cache: { names: Map<string, string>; at: number } | null = null

export const etfTickerNames = async (): Promise<Map<string, string>> => {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.names
  }
  try {
    const names = new Map<string, string>()
    for (const url of NASDAQ_SYMBOL_FILES) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        throw new Error(`${url} HTTP ${res.status}`)
      }
      const [header, ...rows] = (await res.text()).trim().split(/\r?\n/)
      const cols = header.split('|')
      const symbol = cols.findIndex((c) => /symbol$/i.test(c))
      const name = cols.indexOf('Security Name')
      const etf = cols.indexOf('ETF')
      const test = cols.indexOf('Test Issue')
      if (symbol < 0 || name < 0 || etf < 0) {
        throw new Error(`${url} unexpected header: ${header}`)
      }
      // The last line is `File Creation Time: ...`, not a security.
      for (const row of rows) {
        const c = row.split('|')
        if (c[etf] !== 'Y' || c[test] === 'Y') continue
        const ticker = c[symbol]?.toUpperCase()
        const title = c[name]?.trim()
        if (ticker && title && !names.has(ticker)) {
          names.set(ticker, title)
        }
      }
    }
    cache = { names, at: Date.now() }
    return names
  } catch (e) {
    logger.warn(
      `etfRegistry | Nasdaq symbol directory unavailable: ${(e as Error)?.message}`,
    )
    return cache?.names ?? new Map()
  }
}
