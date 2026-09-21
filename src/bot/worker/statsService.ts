import { threadId } from 'worker_threads'
import { DealMonitor } from '../dealMonitor'
import { GridMonitor } from '../gridMonitor'
import {
  BotParentProcessStatsEventDto,
  BotParentRemoveStatsEventDto,
  BotType,
} from '../../../types'
import logger from '../../utils/logger'
import { IdMute, IdMutex } from '../../utils/mutex'

const mutex = new IdMutex(300)

export class DealStats {
  static instance: DealStats
  static getInstance() {
    if (!DealStats.instance) {
      DealStats.instance = new DealStats()
    }
    return DealStats.instance
  }

  private dealStats = DealMonitor.getInstance()

  private gridMonitor = GridMonitor.getInstance()

  @IdMute(mutex, () => 'updateStats')
  public updateStats(data: BotParentProcessStatsEventDto) {
    try {
      if (data.botType === BotType.combo || data.botType === BotType.dca) {
        this.dealStats.addDealStats(
          data.payload.combo,
          data.payload.data,
          data.payload.usdRate,
          data.payload.deal,
          data.payload.fee,
        )
      }
      if (data.botType === BotType.grid) {
        this.gridMonitor.addBotStats(data.payload.data, data.payload.bot)
      }
    } catch (e) {
      logger.error(
        `updateStats Rejection at Promise Stats Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  public async removeStats(data: BotParentRemoveStatsEventDto) {
    try {
      if (data.botType === BotType.grid) {
        await this.gridMonitor.removeBotStats(
          data.payload.data,
          data.payload.bot,
        )
      } else {
        await this.dealStats.removeDealStats(
          data.dealId,
          data.botType === BotType.combo,
        )
      }
    } catch (e) {
      logger.error(
        `removeStats Rejection at Promise Stats Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }
}
