import { userDb } from '../../dbInit'
import logger from '../../../utils/logger'
import { StatusEnum, type MigrationJob } from '../../../../types'

const logPrefix = '[v43]'

// Bybit dropped the curated zone dropdown in favour of a free-text domain
// (compliance: we no longer declare which regional Bybit domains we support).
// Existing accounts stored a zone code (`eu`, `com`, …); convert each to the
// bare frontend host the connector now derives `api.<host>` / `stream.<host>`
// from. Idempotent: migrated values (`bybit.eu`, …) are not keys here, so a
// re-run matches nothing.
const zoneToDomain: Record<string, string> = {
  eu: 'bybit.eu',
  com: 'bybit.com',
  nl: 'bybit.nl',
  kz: 'bybit.kz',
  ge: 'bybitgeorgia.ge',
  tr: 'bybit-tr.com',
  ae: 'bybit.ae',
  id: 'bybit.id',
}

const update: MigrationJob = {
  version: 43,
  job: async () => {
    const name = 'Bybit zone code -> domain'
    logger.info(`${logPrefix} ${name} start`)
    const zones = Object.keys(zoneToDomain)
    const res = await userDb.readData<{
      _id: string
      exchanges?: { uuid?: string; bybitHost?: string }[]
    }>(
      { 'exchanges.bybitHost': { $in: zones } },
      { _id: 1, 'exchanges.uuid': 1, 'exchanges.bybitHost': 1 },
      {},
      true,
    )
    if (res.status === StatusEnum.notok) {
      logger.error(`${logPrefix} ${name} read failed: ${res.reason}`)
      return
    }
    const users = res.data?.result ?? []
    let converted = 0
    for (const user of users) {
      for (const ex of user.exchanges ?? []) {
        const domain = ex.bybitHost ? zoneToDomain[ex.bybitHost] : undefined
        if (!domain || !ex.uuid) {
          continue
        }
        const up = await userDb.updateData(
          { _id: user._id, 'exchanges.uuid': ex.uuid },
          { $set: { 'exchanges.$.bybitHost': domain } },
        )
        if (up.status === StatusEnum.notok) {
          logger.error(
            `${logPrefix} update failed user=${user._id} uuid=${ex.uuid}: ${up.reason}`,
          )
        } else {
          converted++
        }
      }
    }
    logger.info(`${logPrefix} ${name} end — ${converted} account(s) converted`)
  },
}

export default update
