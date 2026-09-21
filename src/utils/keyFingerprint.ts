/**
 * Short, non-reversible id for an API key, for log lines that need to tell
 * accounts apart without writing the key itself down.
 *
 * Byte-identical to `exchange-connector-sh`'s helper (itself the djb2 hash the
 * Kraken adapter uses for its account-scoped caches), so one key fingerprints
 * the same in a main-app line and a connector line and the two can be
 * correlated without either writing the key down. Lossy (32 bits), so it
 * cannot be turned back into the key — only compared against another
 * fingerprint of it.
 */
export const keyFingerprint = (key: string | undefined): string => {
  let h = 5381
  const k = key ?? ''
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
