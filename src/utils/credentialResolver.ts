/**
 * Optional hook that lets the host application own how a stored credential is
 * turned back into plaintext.
 *
 * `crypto.ts` handles the value formats this package knows about. Anything else
 * is only understood by the application embedding it, so rather than teach this
 * package every format an installation might use, the application may register
 * a resolver and keep that knowledge on its own side.
 *
 * Nothing is registered by default. With no resolver, every code path behaves
 * exactly as it did before this module existed.
 */
export interface CredentialResolver {
  /**
   * Whether this resolver owns `value`.
   *
   * Must be a deterministic check on the value's own shape — a prefix or
   * similar — and must never be implemented as "try to decrypt and see if it
   * worked". Trial decryption is not reliable enough to classify with: the AES
   * path in `crypto.ts` returns a short non-empty string for a small fraction
   * of wrong-key attempts rather than failing, which is the same reason values
   * written under a rotated key carry an explicit tag.
   */
  canResolve(value: string): boolean

  /** Recover the plaintext. Rejects rather than returning a wrong value. */
  resolve(value: string): Promise<string>
}

let resolver: CredentialResolver | null = null

/** Register (or with `null`, remove) the host's resolver. */
export const setCredentialResolver = (r: CredentialResolver | null): void => {
  resolver = r
}

export const getCredentialResolver = (): CredentialResolver | null => resolver

/**
 * True when `value` is a format only the host understands. False whenever no
 * resolver is registered, which is what keeps the default build unchanged.
 */
export const isResolverManaged = (value: unknown): boolean =>
  typeof value === 'string' && value !== '' && !!resolver?.canResolve(value)
