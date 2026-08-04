/* eslint-disable */
/**
 * Re-encrypts every ENCRYPT_KEY-protected value at rest under this
 * installation's own key.
 *
 * Until ENCRYPT_KEY is set, `src/utils/crypto.ts` encrypts under the key
 * compiled into the build (its `FALLBACK_KEY`), which is the same for every
 * installation. Setting ENCRYPT_KEY makes *new* writes use your key; this
 * script is what moves the values already in the database.
 *
 * Setting ENCRYPT_KEY without running this is safe — the crypto util
 * dual-reads, so values written under either key stay readable — but nothing
 * already stored is protected by your key until this has run.
 *
 * Fields covered:
 *   users.exchanges[].key / .secret / .passphrase   → re-encrypt
 *   users.apiKeys[].secret                          → re-encrypt
 *   users.password (legacy AES only)                → bcrypt hash  [opt-in]
 *
 * Order of operations — do not deviate:
 *   1. Upgrade to an image whose crypto util dual-reads. ENCRYPT_KEY may
 *      still be unset at this point.
 *   2. Set ENCRYPT_KEY in the host .env (`./setupEncryptKey.sh`) and restart
 *      the stack. Reads keep working via the fallback; new writes use it.
 *   3. Run this with --dry-run, then for real. Safe with bots running: each
 *      value is read-then-written individually and both keys stay readable.
 *   4. Re-run with --verify until `underFallback` is 0.
 *
 * Idempotent. A value already under the new key is skipped, so a re-run after
 * an interruption resumes rather than double-encrypting. AES here is salted,
 * so "is it already migrated?" cannot be answered by comparing ciphertext —
 * it is answered by the `g2:` tag the crypto util writes, not by trial
 * decryption, which is wrong ~0.46% of the time (see KEY_TAG below).
 *
 * Usage (docker-sh, from the directory holding docker-compose.yml):
 *
 *   docker compose run --rm cli-runner npm run cli:rotate-encrypt-key -- --dry-run
 *   docker compose run --rm cli-runner npm run cli:rotate-encrypt-key
 *   docker compose run --rm cli-runner npm run cli:rotate-encrypt-key -- --verify
 *
 * Flags:
 *   --dry-run           report what would change, write nothing
 *   --verify            report which key each value currently reads under
 *   --only=a,b          subset of: exchanges, apikeys, passwords
 *                       (default: exchanges,apikeys — see PASSWORDS below)
 *   --batch=N           users per batch (default 500)
 *   --bcrypt-cost=N     cost factor for password conversion (default 12)
 *   --limit=N           stop after N users (for a staged first pass)
 *
 * PASSWORDS are deliberately NOT in the default scope. Stored passwords are
 * a separate concern from the exchange-credential rotation this script exists
 * for, and login already upgrades each account from the legacy reversible
 * format to bcrypt the next time that user signs in — so the conversion
 * happens on its own, with no window in which anything can go wrong.
 * `--only=passwords` forces it in one pass. One-way: a bcrypt hash cannot be
 * read back, so an installation that later rolls back to an image predating
 * bcrypt login would lock out every converted account.
 */
const mongoose = require('mongoose')
const CryptoJs = require('crypto-js')
// bcryptjs, not the native `bcrypt`: the production image installs with
// --ignore-scripts, so a native module would ship without its compiled
// binary. The two are hash-compatible (see core src/utils/password.ts).
const bcrypt = require('bcryptjs')

// Must match src/utils/crypto.ts FALLBACK_KEY.
const FALLBACK_KEY = '4d01d0f4-af0c-4f60-b7f7-6396ad7823f4'
const NEW_KEY = process.env.ENCRYPT_KEY

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const a = argv.find((x) => x.startsWith(`${f}=`))
  return a ? a.slice(f.length + 1) : d
}

const DRY = has('--dry-run')
const VERIFY = has('--verify')
const BATCH = parseInt(val('--batch', '500'), 10)
const COST = parseInt(val('--bcrypt-cost', '12'), 10)
const LIMIT = parseInt(val('--limit', '0'), 10) || Infinity
const ONLY = val('--only', 'exchanges,apikeys')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const BCRYPT_HASH_RE = /^\$2[aby]?\$\d{2}\$.{53}$/
const AES_PREFIX = 'U2FsdGVkX1'
// Must match KEY_TAG in core/src/utils/crypto.ts. A tagged value is already
// under the new key. This is a prefix check, not a trial decryption: CryptoJS
// returns a short non-empty string for ~0.46% of wrong-key attempts, so
// "it decrypted to something" would wrongly mark ~1 value in 200 as migrated
// and leave it under the old key forever.
const KEY_TAG = 'g2:'

const conn =
  process.env.MONGO_DB_CONNECTION_STRING ||
  (process.env.MONGO_DB_USERNAME &&
    `mongodb://${process.env.MONGO_DB_USERNAME}:${encodeURIComponent(
      process.env.MONGO_DB_PASSWORD,
    )}@${process.env.MONGO_DB_HOST}:${process.env.MONGO_DB_PORT}/${
      process.env.MONGO_DB_NAME
    }`)

/**
 * CryptoJS does not reliably throw on a wrong key — it returns bytes that
 * aren't valid UTF-8 and toString(Utf8) yields ''. So success means
 * "non-empty", not "did not throw".
 */
const tryDecrypt = (str, k) => {
  try {
    const v = CryptoJs.AES.decrypt(str, k).toString(CryptoJs.enc.Utf8)
    return v === '' ? null : v
  } catch {
    return null
  }
}

const encryptNew = (str) =>
  KEY_TAG + CryptoJs.AES.encrypt(str, NEW_KEY).toString()

/**
 * Guard for the one-way password conversion. Re-encryption is reversible if it
 * goes wrong; bcrypt is not — hashing the wrong string locks that user out of
 * their account until they do an email reset.
 *
 * A value that is not valid ciphertext under the key we try still decrypts to
 * a short non-empty string a fraction of the time rather than to ''. Real
 * passwords are printable and have length; that garbage is one or two control
 * characters. Anything failing this is reported as unreadable and left as-is,
 * which costs nothing — the AES login path still reads it.
 */
const isPlausiblePassword = (s) =>
  typeof s === 'string' &&
  s.length >= 4 &&
  !/[\x00-\x1F\x7F]/.test(s)

const stats = {
  usersScanned: 0,
  exchangeFields: { alreadyNew: 0, migrated: 0, unreadable: 0, skipped: 0 },
  apiKeyFields: { alreadyNew: 0, migrated: 0, unreadable: 0, skipped: 0 },
  passwords: { alreadyBcrypt: 0, migrated: 0, unreadable: 0, skipped: 0 },
  usersWritten: 0,
  raced: 0,
  unreadableSamples: [],
}

/**
 * Classify one ciphertext field and return the replacement, or null to leave
 * it alone. Never returns a value unless the plaintext was recovered — an
 * unreadable field is reported and left untouched rather than overwritten.
 */
const rotateField = (value, bucket, where) => {
  if (typeof value !== 'string' || value === '') {
    bucket.skipped++
    return null
  }
  if (value.startsWith(KEY_TAG)) {
    bucket.alreadyNew++
    return null
  }
  if (!value.startsWith(AES_PREFIX)) {
    // Not an AES blob at all — plaintext or something else. Do not touch.
    bucket.skipped++
    return null
  }
  const plain = tryDecrypt(value, FALLBACK_KEY)
  if (plain === null) {
    bucket.unreadable++
    if (stats.unreadableSamples.length < 20) {
      stats.unreadableSamples.push(where)
    }
    return null
  }
  bucket.migrated++
  return VERIFY ? null : encryptNew(plain)
}

async function main() {
  if (!conn) throw new Error('No Mongo connection string in env')

  // Passwords become bcrypt hashes, so that scope reads under the fallback key
  // and writes something that is not encrypted at all — it needs no new key and
  // can run on its own, before any ENCRYPT_KEY rotation is planned. Every other
  // scope re-encrypts and does require the new key.
  const needsNewKey = ONLY.some((s) => s !== 'passwords')
  if (needsNewKey && !NEW_KEY) {
    throw new Error(
      'ENCRYPT_KEY is not set. Generate one for this installation with ' +
        './setupEncryptKey.sh, restart the stack so every service has it, ' +
        'then run this again.',
    )
  }
  if (needsNewKey && NEW_KEY === FALLBACK_KEY) {
    throw new Error('ENCRYPT_KEY equals the fallback key — nothing to rotate.')
  }

  await mongoose.connect(conn)
  // Native driver, not a mongoose model: the model would silently drop any
  // subdocument field the schema does not declare.
  const users = mongoose.connection.db.collection('users')

  const mode = VERIFY ? 'VERIFY' : DRY ? 'DRY RUN' : 'LIVE'
  console.log(
    `[rotateEncryptKey] ${mode} | scopes=${ONLY.join(',')} | batch=${BATCH}` +
      (ONLY.includes('passwords') ? ` | bcryptCost=${COST}` : ''),
  )

  const cursor = users
    .find(
      {},
      { projection: { exchanges: 1, apiKeys: 1, password: 1 }, batchSize: BATCH },
    )
    .sort({ _id: 1 })

  const started = Date.now()
  for await (const doc of cursor) {
    if (stats.usersScanned >= LIMIT) break
    stats.usersScanned++
    const set = {}
    const expect = {}

    if (ONLY.includes('exchanges') && Array.isArray(doc.exchanges)) {
      doc.exchanges.forEach((ex, i) => {
        for (const f of ['key', 'secret', 'passphrase']) {
          const next = rotateField(
            ex?.[f],
            stats.exchangeFields,
            `${doc._id}.exchanges.${i}.${f}`,
          )
          if (next) {
            set[`exchanges.${i}.${f}`] = next
            expect[`exchanges.${i}.${f}`] = ex[f]
          }
        }
      })
    }

    if (ONLY.includes('apikeys') && Array.isArray(doc.apiKeys)) {
      doc.apiKeys.forEach((ak, i) => {
        const next = rotateField(
          ak?.secret,
          stats.apiKeyFields,
          `${doc._id}.apiKeys.${i}.secret`,
        )
        if (next) set[`apiKeys.${i}.secret`] = next
      })
    }

    if (ONLY.includes('passwords')) {
      const p = doc.password
      if (typeof p !== 'string' || p === '') {
        stats.passwords.skipped++
      } else if (BCRYPT_HASH_RE.test(p)) {
        stats.passwords.alreadyBcrypt++
      } else if (!p.startsWith(AES_PREFIX) && !p.startsWith(KEY_TAG)) {
        stats.passwords.skipped++
      } else {
        // Passwords become bcrypt hashes rather than being re-encrypted, so
        // there is no "already rotated" state — a tagged value just means a
        // reset landed after ENCRYPT_KEY was set but before this ran.
        const plain = p.startsWith(KEY_TAG)
          ? NEW_KEY
            ? tryDecrypt(p.slice(KEY_TAG.length), NEW_KEY)
            : null // tagged but no key supplied — report, never guess
          : tryDecrypt(p, FALLBACK_KEY)
        if (plain === null || !isPlausiblePassword(plain)) {
          stats.passwords.unreadable++
          if (stats.unreadableSamples.length < 20) {
            stats.unreadableSamples.push(`${doc._id}.password`)
          }
        } else {
          stats.passwords.migrated++
          if (!VERIFY && !DRY) {
            set.password = await bcrypt.hash(plain, COST)
            expect.password = p
          }
        }
      }
    }

    if (!DRY && !VERIFY && Object.keys(set).length) {
      // Compare-and-swap. The cursor reads in batches, so a value can be read
      // up to a batch-time before it is written; if the user changed their
      // password or edited a connection in that window, an unconditional write
      // would silently revert it. Matching on the values we read means a raced
      // document is left alone and reported instead.
      const res = await users.updateOne(
        { _id: doc._id, ...expect },
        { $set: set },
      )
      if (res.matchedCount === 0) {
        stats.raced++
      } else {
        stats.usersWritten++
      }
    }

    if (stats.usersScanned % 5000 === 0) {
      console.log(
        `  …${stats.usersScanned} users, ${stats.usersWritten} written, ` +
          `${Math.round((Date.now() - started) / 1000)}s`,
      )
    }
  }

  await mongoose.disconnect()

  console.log('\n[rotateEncryptKey] result')
  console.log(`  users scanned      : ${stats.usersScanned}`)
  console.log(`  users written      : ${stats.usersWritten}${DRY || VERIFY ? ' (none — read-only mode)' : ''}`)
  console.log(`  exchange fields    : ${JSON.stringify(stats.exchangeFields)}`)
  console.log(`  apiKey fields      : ${JSON.stringify(stats.apiKeyFields)}`)
  console.log(`  passwords          : ${JSON.stringify(stats.passwords)}`)
  console.log(`  raced (left alone) : ${stats.raced}`)
  console.log(`  elapsed            : ${Math.round((Date.now() - started) / 1000)}s`)
  if (stats.unreadableSamples.length) {
    console.log(
      `\n  ⚠ ${stats.unreadableSamples.length}+ values decrypt under NEITHER key ` +
        `and were left untouched:`,
    )
    stats.unreadableSamples.forEach((s) => console.log(`    ${s}`))
  }
  const remaining =
    stats.exchangeFields.migrated +
    stats.apiKeyFields.migrated +
    stats.passwords.migrated
  if (VERIFY) {
    console.log(
      `\n  underFallback (still to migrate): ${remaining} — ` +
        `${remaining === 0 ? 'safe to drop the fallback' : 'do NOT drop the fallback yet'}`,
    )
  }
}

main().catch((e) => {
  console.error('[rotateEncryptKey] FAILED', e)
  process.exit(1)
})
