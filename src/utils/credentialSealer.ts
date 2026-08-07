/**
 * Optional hook that lets the host application own how a credential is turned
 * into its stored form.
 *
 * The mirror of `credentialResolver.ts`. That one lets the host read a format
 * this package does not know; this one lets the host *write* it. Both are
 * registered by the application, both are absent by default, and with neither
 * registered every credential path behaves exactly as it did before either
 * module existed — which is the state a default installation stays in.
 *
 * Kept separate from the resolver rather than folded into it because the two
 * switch on independently and in that order: a format has to be readable
 * everywhere before anything is allowed to write it. Merging them would make
 * "reads understand the new format" and "writes produce it" a single flag, and
 * the gap between those two is exactly where a migration is safe.
 */

/**
 * Which credential is being sealed.
 *
 * The host may bind the stored value to this identity, so it has to be correct
 * rather than merely unique: a value bound to the wrong identity still encrypts
 * and decrypts perfectly, and the error surfaces only when someone tries to
 * work out which credential was exposed.
 *
 * `uuid` rather than the array index, because the index shifts when an earlier
 * connection is deleted and the identity must survive that.
 */
export type ConnectionIdentity = {
  userId: string
  provider: string
  uuid: string
}

/** One API-key secret, identified by its subdocument id. */
export type ApiKeyIdentity = {
  userId: string
  id: string
}

/** The three stored fields of one connection, in plaintext. */
export type ConnectionPlaintext = {
  key: string
  secret: string
  passphrase?: string
}

/**
 * The same three fields, sealed. `passphrase` is `undefined` when the
 * connection has none — the stored shape distinguishes absent from empty, and
 * the write paths this replaces did too.
 */
export type ConnectionSealed = {
  key: string
  secret: string
  passphrase?: string
}

export interface CredentialSealer {
  /**
   * Seal the fields of one connection.
   *
   * Takes all three together rather than one at a time so the host can give
   * them a shared key. Sealing them independently would make reading one
   * connection cost three unwraps instead of one, on every request that
   * touches it.
   */
  sealConnection(
    identity: ConnectionIdentity,
    fields: ConnectionPlaintext,
  ): Promise<ConnectionSealed>

  /** Seal one API-key secret. */
  sealApiSecret(identity: ApiKeyIdentity, plaintext: string): Promise<string>
}

let sealer: CredentialSealer | null = null

/** Register (or with `null`, remove) the host's sealer. */
export const setCredentialSealer = (s: CredentialSealer | null): void => {
  sealer = s
}

export const getCredentialSealer = (): CredentialSealer | null => sealer
