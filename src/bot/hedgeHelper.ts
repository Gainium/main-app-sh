import DB from '../db'
import MetaBot, { MetaBotOptions } from './metaHelper'
import {
  dcaBotDb,
  comboBotDb,
  comboDealsDb,
  dcaDealsDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
} from '../db/dbInit'
import { IdMute, IdMutex } from '../utils/mutex'

import {
  BotType,
  ClearComboBotSchema,
  ClearDCABotSchema,
  StrategyEnum,
  HedgeBotSchema,
  BotStatusEnum,
  CloseDCATypeEnum,
  ActionsEnum,
  DCADealStatusEnum,
  DCACloseTriggerEnum,
  ComboTpBase,
} from '../../types'

const mutex = new IdMutex()

function createHedgeBotHelper<
  Schema extends HedgeBotSchema,
  T extends ClearComboBotSchema | ClearDCABotSchema,
  TBaseClass extends new (...args: any[]) => MetaBot<Schema, T> = new (
    ...args: any[]
  ) => MetaBot<Schema, T>,
>(BaseClass?: TBaseClass) {
  const ActualBaseClass = (BaseClass ||
    MetaBot<Schema, T>) as TBaseClass extends new (...args: any[]) => infer T
    ? new (options: MetaBotOptions, db: DB<Schema>) => T
    : new (options: MetaBotOptions, db: DB<Schema>) => MetaBot<Schema, T>

  class HedgeBot extends ActualBaseClass {
    private checkTpSlTimer: NodeJS.Timeout | null = null
    private checkTpSlInterval = 1000 * 30
    constructor(options: MetaBotOptions) {
      super(
        options,
        (options.botType === BotType.hedgeCombo
          ? hedgeComboBotDb
          : hedgeDCABotDb) as unknown as DB<Schema>,
      )
      this.checkTpSl = this.checkTpSl.bind(this)
    }

    private resetTimers() {
      if (this.checkTpSlTimer) {
        clearInterval(this.checkTpSlTimer)
        this.checkTpSlTimer = null
      }
    }

    get long() {
      return [...this.bots.values()].find(
        (bot) => bot.data?.settings?.strategy === StrategyEnum.long,
      )
    }

    get short() {
      return [...this.bots.values()].find(
        (bot) => bot.data?.settings?.strategy === StrategyEnum.short,
      )
    }

    override async init() {
      await super.init()
      if (!this.long) {
        this.handleError('Long bot not found')
      }
      if (!this.short) {
        this.handleError('Short bot not found')
      }
    }

    private setTpSlTimer() {
      if (
        this.data?.sharedSettings?.useSl ||
        this.data?.sharedSettings?.useTp
      ) {
        this.handleLog(`Set TP/SL timer`)
        if (this.checkTpSlTimer) {
          clearInterval(this.checkTpSlTimer)
        }
        this.checkTpSlTimer = setInterval(() => {
          this.data && this.checkTpSl(this.data?._id)
        }, this.checkTpSlInterval)
      }
    }

    private async getDeals(strategy?: StrategyEnum): Promise<
      {
        id: string
        unrealizedProfit: number
        usage: number
        botId: string
        maxUsage: number
        symbol?: string
      }[]
    > {
      if (!strategy) {
        return [
          ...(await this.getDeals(StrategyEnum.long)),
          ...(await this.getDeals(StrategyEnum.short)),
        ]
      }
      const bot = strategy === StrategyEnum.long ? this.long : this.short
      if (!bot) {
        this.handleError(`${strategy} bot not found`)
        return []
      }
      const db =
        this.options.botType === BotType.hedgeCombo ? comboDealsDb : dcaDealsDb
      return (
        (
          await db.aggregate<{
            deals: {
              id: string
              unrealizedProfit: number
              usage: number
              botId: string
              maxUsage: number
              symbol?: string
            }[]
          }>([
            {
              $match: {
                botId: bot?.data._id,
                status: DCADealStatusEnum.open,
              },
            },
            {
              $group: {
                _id: null,
                deals: {
                  $push: {
                    id: '$_id',
                    unrealizedProfit: '$stats.unrealizedProfit',
                    usage: '$stats.usage',
                    botId: '$botId',
                    maxUsage: '$stats.maxUsage',
                    symbol: '$symbol.symbol',
                  },
                },
              },
            },
          ])
        )?.data?.result?.[0]?.deals ?? []
      )
    }
    @IdMute(mutex, (botId: string) => `checkTpSl${botId}`)
    private async checkTpSl(_botId: string) {
      this.handleDebug(`Check TP/SL`)
      const useTp =
        this.data?.sharedSettings?.useTp && this.data.sharedSettings.tpPerc
      const useSl =
        this.data?.sharedSettings?.useSl && this.data.sharedSettings.slPerc
      if (!useTp && !useSl) {
        this.handleDebug(`TP/SL not used, skip check`)
        return
      }
      // Judged per pair: a pair's long and short deals are one hedge, and
      // only that pair's deals close when it triggers (a pair with one leg
      // open is judged on that leg alone).
      const allDeals = await this.getDeals()
      const byPair = new Map<string, typeof allDeals>()
      for (const deal of allDeals) {
        const key = deal.symbol ?? ''
        byPair.set(key, [...(byPair.get(key) ?? []), deal])
      }
      for (const [pair, deals] of byPair) {
        const totalUnrealized = deals.reduce(
          (acc, v) => acc + v.unrealizedProfit,
          0,
        )

        const usage = deals.reduce((acc, v) => acc + v.usage, 0)
        const maxUsage = deals.reduce((acc, v) => acc + v.maxUsage, 0)
        const totalUsage =
          this.options.botType === BotType.hedgeCombo
            ? !this.data?.sharedSettings?.comboTpBase ||
              this.data?.sharedSettings?.comboTpBase === ComboTpBase.full
              ? maxUsage
              : usage
            : usage

        let total = (totalUnrealized / totalUsage) * 100
        const prevTotal = total
        if (isNaN(total) || !isFinite(total)) {
          total = 0
        }
        const slTrigger =
          this.data?.sharedSettings?.useSl && this.data.sharedSettings.slPerc
            ? total <= +this.data.sharedSettings.slPerc
            : false
        const tpTrigger =
          this.data?.sharedSettings?.useTp && this.data.sharedSettings.tpPerc
            ? total >= +this.data.sharedSettings.tpPerc
            : false
        const msg = `Pair ${pair}: deals ${deals.length}, unrealized ${totalUnrealized}, usage ${totalUsage}, total ${total} (${prevTotal}), slTrigger ${slTrigger}, tpTrigger ${tpTrigger}`
        this.handleDebug(msg)
        if (slTrigger || tpTrigger) {
          this.handleLog(msg)
          deals.forEach((deal) => {
            this.sendMessageToBotService(
              this.options.botType === BotType.hedgeCombo
                ? 'closeComboDeal'
                : 'closeDCADeal',
              this.options.botType === BotType.hedgeCombo
                ? BotType.combo
                : BotType.dca,
              this.data?.userId,
              deal.botId,
              deal.id,
              CloseDCATypeEnum.closeByMarket,
              undefined,
              this.data?.paperContext,
              DCACloseTriggerEnum.combined,
            )
          })
        }
      }
    }

    override async afterSuccessStart() {
      this.setTpSlTimer()
    }

    @IdMute(mutex, (botId: string) => `setStatusBot${botId}`)
    override async setStatus(
      _botId: string,
      status: BotStatusEnum,
      closeType?: CloseDCATypeEnum,
      serverRestart?: boolean,
      _skipCheck?: boolean,
      hedgeConfig?: { [x in StrategyEnum]: ActionsEnum },
    ) {
      if (!this.initDone) {
        this.queueAfterInit.push(() =>
          this.setStatus.bind(this)(
            _botId,
            status,
            closeType,
            serverRestart,
            _skipCheck,
            hedgeConfig,
          ),
        )
        return
      }
      if (status === BotStatusEnum.open && hedgeConfig) {
        if (this.options.botType === BotType.hedgeCombo) {
          await comboBotDb.updateData(
            { _id: this.long?.data._id },
            { $set: { action: hedgeConfig[StrategyEnum.long] } },
          )
          await comboBotDb.updateData(
            { _id: this.short?.data._id },
            { $set: { action: hedgeConfig[StrategyEnum.short] } },
          )
        }
        if (this.options.botType === BotType.hedgeDca) {
          await dcaBotDb.updateData(
            { _id: this.long?.data._id },
            { $set: { action: hedgeConfig[StrategyEnum.long] } },
          )
          await dcaBotDb.updateData(
            { _id: this.short?.data._id },
            { $set: { action: hedgeConfig[StrategyEnum.short] } },
          )
        }
      }
      if (status === BotStatusEnum.closed) {
        this.resetTimers()
      }
      super.setStatus(_botId, status, closeType, serverRestart)
    }

    @IdMute(mutex, (botId: string) => `setStatusBot${botId}`)
    public async reload(_botId: string) {
      this.resetTimers()
      super.reload(_botId)
    }
  }

  return HedgeBot as new (
    options: MetaBotOptions,
  ) => HedgeBot & InstanceType<TBaseClass>
}

export default createHedgeBotHelper
