import bcrypt from 'bcryptjs'

import { decrypt } from './crypto'

// User password storage. Historically passwords were stored with the
// reversible AES helper in ./crypto — a single shared key, decrypt-and-compare
// on every login — which means anyone who obtains the database also obtains
// every plaintext password. Passwords are now stored as bcrypt hashes.
//
// The move is dual-read so it needs no flag day: existing AES values are still
// accepted at login and are silently rehashed to bcrypt on the next successful
// sign-in, while every new write (sign-up, password change, CLI reset) is
// bcrypt from the start. An installation therefore converts itself as its users
// log in, with no downtime and no forced reset.
//
// `bcryptjs` (pure JavaScript) is deliberate rather than the native `bcrypt`
// binding: the container image installs production dependencies with
// `--ignore-scripts`, which would skip the native module's postinstall and
// leave it without its compiled binary at runtime. The two produce and accept
// the same `$2a$`/`$2b$` hashes, so values written by either are readable by
// the other.

const BCRYPT_COST = 12

// Strict shape match for the bcrypt prefix. Matches $2a$, $2b$, $2y$ (and
// bare $2$) followed by a two-digit cost and a 53-char salt+hash. Anything
// else is treated as legacy AES ciphertext.
const BCRYPT_HASH_RE = /^\$2[aby]?\$\d{2}\$.{53}$/

// Hashes a plaintext password with bcrypt at the canonical cost factor.
// Used by sign-up, password change, CLI reset, and the rehash-on-login path.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

// Returns true iff the stored value looks like a bcrypt hash. Used both as
// a router (which verification branch to take) and as a "needs migration?"
// signal after a successful login.
export function isBcryptHash(stored: unknown): stored is string {
  if (typeof stored !== 'string') return false
  return BCRYPT_HASH_RE.test(stored)
}

// Dual-read password check. If `stored` is a bcrypt hash, defers to
// bcrypt.compare. Otherwise treats `stored` as legacy AES ciphertext,
// decrypts, and does a plaintext compare — the fallback for accounts that
// haven't logged in since the change. Any thrown error (malformed input,
// decrypt failure, bcrypt edge case) resolves to false rather than
// propagating, so callers map it to the same "wrong password" response and
// don't leak which accounts are still on the legacy path.
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false
  try {
    if (isBcryptHash(stored)) {
      return await bcrypt.compare(plain, stored)
    }
    const decrypted = decrypt(stored)
    if (!decrypted) return false
    return decrypted === plain
  } catch {
    return false
  }
}
