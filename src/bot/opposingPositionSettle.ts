import { StatusEnum } from '../../types'

/**
 * Spec 041 — a bot started while the opposite bot's position is still closing.
 *
 * On a one-way futures account the venue keeps one net position per symbol, so
 * `MainBot.loadData` refuses to start a bot whose side differs from the open
 * position. A long/short flip (stop one bot with a market close, start the
 * other) reaches that check while the close is still in flight: the position
 * read sees the old side, and the start is refused about a second before the
 * position disappears. One read cannot tell a closing position from a
 * standing one; a few more can.
 */

export type PositionRow = {
  symbol: string
  positionAmt: string | number
}

/** At most 10 s added, and only on a start that would otherwise be refused. */
export const OPPOSING_POSITION_SETTLE = { attempts: 5, intervalMs: 2_000 }

/**
 * No non-zero position on `symbol`. A position on the bot's own side is NOT
 * flat: the margin/leverage checks ran against the old position, not this one.
 */
export const isFlatOn = (
  positions: readonly PositionRow[] | null | undefined,
  symbol: string,
) => !(positions ?? []).some((p) => p.symbol === symbol && +p.positionAmt !== 0)

/**
 * Re-reads positions every `intervalMs`, up to `attempts` times, and returns
 * the first read showing `symbol` flat — or `undefined` if none did, in which
 * case the caller refuses as it did before. Pure but for the injected
 * `fetch`/`sleep`.
 *
 * Sleeps before the first re-read: the read that triggered this is the
 * immediate one. An unreadable read (non-ok, missing, thrown) is not evidence
 * of flat and just spends an attempt; nothing here throws, because
 * `loadData`'s caller awaits it outside its try/catch.
 */
export async function awaitPositionFlat<
  T extends { status: StatusEnum; data?: readonly PositionRow[] | null },
>(
  fetch: () => Promise<T | undefined>,
  symbol: string,
  opts: {
    attempts: number
    intervalMs: number
    sleep: (ms: number) => Promise<void>
  },
): Promise<T | undefined> {
  for (let attempt = 0; attempt < Math.max(1, opts.attempts); attempt++) {
    await opts.sleep(opts.intervalMs)
    let res: T | undefined
    try {
      res = await fetch()
    } catch {
      res = undefined
    }
    if (res?.status === StatusEnum.ok && isFlatOn(res.data, symbol)) {
      return res
    }
  }
  return undefined
}
