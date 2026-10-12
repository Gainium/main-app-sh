import type express from 'express'
import { brokerCodesDb } from '../db/dbInit'
import { StatusEnum } from '../../types'
import logger from '../utils/logger'

/**
 * `GET /broker-codes` — the exchange broker/builder codes, same shape as the
 * hosted API's feed. The dashboard's Hyperliquid wallet setup reads the
 * builder address from here before it asks the wallet to approve the builder
 * fee. Rows with a `zone` are only returned for `?v=2`.
 */
export const brokerCodesHandler = async (
  req: express.Request,
  res: express.Response,
) => {
  const data = await brokerCodesDb.readData(
    {},
    { exchange: 1, code: 1, zone: 1, _id: 0 },
    {},
    true,
  )
  if (data.status === StatusEnum.notok) {
    logger.error(`broker-codes | Cannot read broker codes ${data.reason}`)
    res.status(400).send([])
    return
  }
  let result = data.data.result
  if (req.query.v !== '2') {
    result = result.filter((d) => !d.zone)
  }
  res.status(200).send(result)
}
