import { fork } from 'child_process'
import path from 'path'
import { userDb } from '../db/dbInit'
import logger from './logger'
import { isEncryptKeyConfigured } from './crypto'

const logPrefix = '[encryptKeyBackfill]'

/**
 * Re-encrypts values still under the build's fallback key once this
 * installation has an ENCRYPT_KEY of its own, without the operator having to
 * run anything.
 *
 * Setting ENCRYPT_KEY only affects *new* writes; what is already stored stays
 * under the old key until `src/cli/rotateEncryptKey.js` has run. That command
 * is short and safe, but it is a separate step an operator has to know about
 * and remember, and an installation that skips it gets none of the benefit of
 * the key it just generated. So the API runs it itself.
 *
 * Deliberately narrow:
 *   - the API process only. Every main-app-family process shares this build,
 *     and eleven of them racing the same rows is pointless work. The bot
 *     workers must never do this.
 *   - only when a key is configured. With ENCRYPT_KEY unset there is nothing
 *     to migrate *to*, and crypto.ts has already said so at startup.
 *   - only when something is actually left to migrate, so a healthy
 *     installation pays one indexed-less count on boot and nothing more.
 *   - never blocks boot and never fails it. This is housekeeping; the API
 *     serving traffic matters more.
 *
 * Set ENCRYPT_KEY_AUTO_BACKFILL=false to keep the manual command instead.
 */

/** Prefix CryptoJS gives every salted AES ciphertext. */
const AES_PREFIX = 'U2FsdGVkX1'

/** Ciphertext already under ENCRYPT_KEY carries crypto.ts's `g2:` tag, so
 *  "starts with the raw AES prefix" is exactly the un-migrated set. */
const UNMIGRATED = { $regex: `^${AES_PREFIX}` }

let started = false

/**
 * Counts un-migrated credential fields, stopping at the first hit.
 *
 * This is a collection scan — the fields are inside arrays and none of them is
 * indexed. That is affordable here and nowhere else: this runs once per API
 * boot, on self-hosted installations, whose user counts are in the hundreds.
 * Do not lift this query into anything that runs on a timer.
 */
async function hasUnmigratedValues(): Promise<boolean> {
  const res = await userDb.countData(
    {
      $or: [
        { 'exchanges.key': UNMIGRATED },
        { 'exchanges.secret': UNMIGRATED },
        { 'apiKeys.secret': UNMIGRATED },
      ],
      // The DAO's filter type describes schema fields, not Mongo operators.
    } as never,
    1,
  )
  if ('error' in res) {
    logger.warn(
      `${logPrefix} could not check for un-migrated values`,
      res.error,
    )
    return false
  }
  return (res.data?.result ?? 0) > 0
}

/**
 * Runs the backfill as a child process rather than in-process.
 *
 * It is the same file the documented manual command runs, so there is one
 * implementation of the rotation and no second copy to drift. Forking also
 * keeps its cursor and its Mongo connection off the API's event loop, and
 * means a failure is an exit code rather than an exception in the API.
 */
function runBackfill(): void {
  // dist/src/utils → dist/src/cli, and the same relative hop in src/.
  const script = path.join(__dirname, '../cli/rotateEncryptKey.js')
  logger.info(
    `${logPrefix} re-encrypting stored credentials under this installation's ` +
      'ENCRYPT_KEY. Safe to leave running; bots are unaffected.',
  )

  // Inherits env, so the child gets ENCRYPT_KEY and the Mongo settings the
  // API is already using. stdio is inherited so its report lands in the API
  // log, where an operator looking into this will actually find it.
  const child = fork(script, [], { stdio: 'inherit' })

  child.on('exit', (code) => {
    if (code === 0) {
      logger.info(
        `${logPrefix} done. Values written from now on use this ` +
          "installation's key.",
      )
    } else {
      logger.warn(
        `${logPrefix} exited ${code}. Nothing is broken — credentials stay ` +
          'readable under the previous key — but they are not yet under ' +
          'yours. The next restart retries, or run: npm run ' +
          'cli:rotate-encrypt-key',
      )
    }
  })

  child.on('error', (err) => {
    logger.warn(`${logPrefix} could not start`, err)
  })
}

/**
 * Fire-and-forget. Returns as soon as the decision is made; the rotation
 * itself outlives the call.
 */
export async function startEncryptKeyBackfill(): Promise<void> {
  if (started) return
  if (!isEncryptKeyConfigured()) return
  if (process.env.ENCRYPT_KEY_AUTO_BACKFILL === 'false') {
    logger.info(
      `${logPrefix} disabled by ENCRYPT_KEY_AUTO_BACKFILL=false — run npm ` +
        'run cli:rotate-encrypt-key when you want stored credentials moved ' +
        "to this installation's key.",
    )
    return
  }
  started = true

  try {
    if (!(await hasUnmigratedValues())) return
    runBackfill()
  } catch (e) {
    // Housekeeping must not take the API down with it.
    logger.warn(`${logPrefix} skipped`, e)
  }
}
