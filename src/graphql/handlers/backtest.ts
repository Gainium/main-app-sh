import axios from 'axios'
import http from 'http'
import { ServerSideBacktestPayload } from '../../../types'
import { BACKTEST_PORT, BACKTEST_SERVICE_HOST } from '../../config'

/** Where server-side backtests are dialled — named in "not available" errors. */
export const BACKTEST_SERVICE_TARGET = `${BACKTEST_SERVICE_HOST}:${BACKTEST_PORT}`

export const sendServerSideRequest = async (
  payload: ServerSideBacktestPayload,
  userId: string,
  requestId: string,
) => {
  await axios({
    url: `http://${BACKTEST_SERVICE_TARGET}/api/runServerSideBacktest`,
    method: 'post',
    data: { payload, userId, requestId },
    httpAgent: new http.Agent({ keepAlive: true }),
  })
}
