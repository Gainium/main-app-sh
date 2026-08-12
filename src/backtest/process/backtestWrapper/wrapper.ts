import ExchangeChooser from '../../../exchange/exchangeChooser'
import AbstractExchange from '../../../exchange'
import DCABackteser from './dca'
import GridBacktester from './grid'
import logger from '../../../utils/logger'
import { MathHelper } from '../../../utils/math'
import { removePaperFormExchangeName } from '../../../exchange/helpers'
import crypto from 'crypto'
import axios from 'axios'
import http from 'http'
import { updateRequest } from '../../utils/backtestRequest'
import saveFileHelper from '../../../utils/files'
import { internalToken } from '../../utils/token'

import {
  BotType,
  type ServerSideBacktestPayload,
  CleanDCABacktestingResult,
  ComboBacktestingResult,
  StatusEnum,
  BaseReturn,
  BacktestRequestStatus,
  BotStatusEnum,
} from '../../../../types'

import type {
  Prices,
  Symbols,
  GridBacktestingResult,
  DCABacktestingResult,
  DCABotSettings,
  Settings,
} from '@gainium/backtester/dist/types'
import { v4 } from 'uuid'
import { GRAPH_QL_PORT, MAIN_SERVICE_HOST } from '../../../config'
import {
  backtestDb,
  comboBacktestDb,
  filesDb,
  gridBacktestDb,
  pairDb,
} from '../../../db/dbInit'

type ResultType = {
  id: string
  time: number
  shareId: string
  type: BotType
}[]

class BacktestWrapper {
  protected math = new MathHelper()

  private exchange: AbstractExchange

  private symbolsDb = pairDb

  private comboBacktestDb = comboBacktestDb

  private dcaBacktestDb = backtestDb

  private gridBacktestDb = gridBacktestDb

  protected filesDb = filesDb

  private id = ''

  protected ec = ExchangeChooser

  constructor(
    private data: ServerSideBacktestPayload,
    protected userId: string,
    private requestId?: string,
  ) {
    this.exchange = this.ec.chooseExchangeFactory(
      removePaperFormExchangeName(data.data.exchange),
    )('', '', '')
    this.id = crypto
      .createHash('sha1')
      .update(`${JSON.stringify(this.data)}`)
      .digest('hex')
    this.handleBacktestLog = this.handleBacktestLog.bind(this)
  }

  protected handleLog(msg: string, type: 'info' | 'error' | 'debug' = 'info') {
    logger[type](`SSB | ${this.id} | ${msg}`)
  }

  private async loadPrices(): Promise<Prices> {
    const prices = await this.exchange.getAllPrices()
    const exchange = this.data.data.exchange
    return (prices.data ?? []).map((p) => ({
      price: p.price,
      symbol: p.pair,
      exchange,
    }))
  }

  private async getSymbols(): Promise<Symbols[]> {
    const symbolsList = [this.data.data.settings.pair].flat()
    const exchange = this.data.data.exchange
    const symbols = await this.symbolsDb.readData(
      {
        exchange,
        pair: { $in: symbolsList },
      },
      {},
      {},
      true,
    )
    return symbols.data?.result ?? []
  }

  protected async saveFile(
    data: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) {
    const fileResult = await axios<{
      size: number
      name: string
      path: string
    }>({
      url: `http://${MAIN_SERVICE_HOST}:${GRAPH_QL_PORT}/api/serverSideBacktestSaveFile`,
      method: 'post',
      data: {
        data,
        name: `${this.userId}-backtest`,
        resolution: 'json',
        path: 'user-backtests',
        encryptedToken: internalToken(),
      },
      httpAgent: new http.Agent({ keepAlive: true }),
    })
      .then((res) => res.data)
      .catch((err) => {
        this.handleLog(
          `Error saving remote file ${err.message ?? err.response} ${
            data.length
          }`,
          'error',
        )
        try {
          const result = saveFileHelper(
            JSON.stringify(data),
            `${this.userId}-backtest`,
            'json',
            'user-backtests',
          )
          return result
        } catch (e) {
          this.handleLog(
            `Error saving local file ${(e as Error)?.message ?? e}`,
            'error',
          )
        }
        return null
      })
    if (fileResult) {
      await this.filesDb.createData({
        userId: this.userId,
        size: fileResult.size,
        fileName: fileResult.name,
        path: fileResult.path,
        meta,
      })
      return true
    }
    return false
  }

  private async updateRequest(
    status: BacktestRequestStatus,
    backtestId?: string,
  ) {
    await updateRequest(this.data.type, status, this.requestId, backtestId)
  }

  private async saveDCAComboBacktest(
    result: DCABacktestingResult | ComboBacktestingResult,
    symbol: Symbols,
  ) {
    const config = this.data.config
    const _data: Omit<DCABacktestingResult, 'deals'> & {
      deals?: DCABacktestingResult['deals']
    } = { ...result }
    delete _data.deals
    delete _data.profits
    delete _data.indicatorsEvents
    delete _data.buyAndHoldEquity
    delete _data.portfolio
    //@ts-ignore
    delete config.locked
    const backtestSettings = this.data.data.settings as DCABotSettings
    const { indicators } = backtestSettings
    const toSave: Omit<
      CleanDCABacktestingResult | ComboBacktestingResult,
      '_id'
    > = {
      ..._data,
      symbol: symbol.pair,
      baseAsset: symbol.baseAsset.name,
      quoteAsset: symbol.quoteAsset.name,
      userId: this.userId,
      time: new Date().getTime(),
      exchange: this.data.data.exchange,
      exchangeUUID: this.data.data.exchangeUUID,
      settings: {
        ...backtestSettings,
        stopStatus:
          backtestSettings.stopStatus === 'monitoring'
            ? BotStatusEnum.monitoring
            : BotStatusEnum.closed,
        ordersCount: this.math.convertString(`${backtestSettings.ordersCount}`),
        activeOrdersCount: this.math.convertString(
          `${backtestSettings.activeOrdersCount}`,
        ),
        indicators:
          indicators.length > 0
            ? indicators.map((i) => {
                for (const [k, v] of Object.entries(i)) {
                  if (v === null) {
                    // @ts-ignore
                    delete i[k]
                  }
                }
                return i
              })
            : [],
        cooldownAfterDealStart:
          backtestSettings.cooldownAfterDealStart ?? undefined,
        cooldownAfterDealStartUnits:
          backtestSettings.cooldownAfterDealStartUnits ?? undefined,
        cooldownAfterDealStop:
          backtestSettings.cooldownAfterDealStop ?? undefined,
        cooldownAfterDealStopUnits:
          backtestSettings.cooldownAfterDealStopUnits ?? undefined,
        cooldownAfterDealStartInterval:
          backtestSettings.cooldownAfterDealStartInterval
            ? this.math.convertString(
                `${backtestSettings.cooldownAfterDealStartInterval}`,
              )
            : undefined,
        cooldownAfterDealStopInterval:
          backtestSettings.cooldownAfterDealStopInterval
            ? this.math.convertString(
                `${backtestSettings.cooldownAfterDealStopInterval}`,
              )
            : undefined,
        moveSL: backtestSettings.moveSL ?? undefined,
        moveSLTrigger: backtestSettings.moveSLTrigger ?? undefined,
        moveSLValue: backtestSettings.moveSLValue ?? undefined,
        pair: backtestSettings.pair?.[0]
          ? backtestSettings.pair
          : [symbol.pair],
        tpPerc: backtestSettings.tpPerc ?? '10',
        slPerc: backtestSettings.slPerc ?? '-10',
        leverage: backtestSettings.leverage
          ? this.math.convertString(`${backtestSettings.leverage}`)
          : undefined,
        closeByTimerValue: backtestSettings.closeByTimerValue
          ? this.math.convertString(`${backtestSettings.closeByTimerValue}`)
          : undefined,
      },
      savePermanent: false,
      duration: { ..._data.duration, periodName: config.periodName },
      config,
      serverSide: true,
      shareId: v4(),
    }
    Object.keys(toSave.settings).forEach((k) => {
      const key = k as keyof typeof toSave.settings
      if (`${toSave.settings[key]}` === 'null') {
        delete toSave.settings[key]
      }
    })
    let resultSave:
      | BaseReturn<CleanDCABacktestingResult | ComboBacktestingResult>
      | undefined
    if (this.data.type === BotType.dca) {
      this.handleLog(`Save DCA backtest `, 'debug')
      resultSave = await this.dcaBacktestDb.createData(toSave)
    } else if (this.data.type === BotType.combo) {
      this.handleLog(`Save Combo backtest `, 'debug')
      resultSave = await this.comboBacktestDb.createData(
        toSave as ComboBacktestingResult,
      )
    }
    let saved = false
    try {
      if (resultSave && resultSave.data?._id) {
        const saveData = JSON.stringify({ ...result, config })
        const type = this.data.type === BotType.combo ? 'Combo' : 'DCA'
        const id = `${resultSave.data._id}`
        const meta = {
          id: id,
          exchange: toSave.exchange,
          baseAsset: toSave.baseAsset,
          quoteAsset: toSave.quoteAsset,
          symbol: toSave.symbol,
          type,
        }
        const entry = {
          data: saveData,
          ...meta,
        }
        this.handleLog(`${type} backtest saved with id ${id}`, 'debug')
        saved = await this.saveFile(entry, meta)
      }
    } catch (e) {
      this.handleLog(
        `Error saving result file ${this.data.type} ${
          (e as Error)?.message ?? e
        }, deals ${result?.numerical?.all}`,
        'error',
      )
    }
    if (!saved && resultSave?.data?._id) {
      if (this.data.type === BotType.dca) {
        this.handleLog(`Update DCA backtest, remove server side`, 'debug')
        this.dcaBacktestDb.updateData(
          { _id: `${resultSave.data._id}` },
          { $set: { serverSide: false } },
        )
      } else if (this.data.type === BotType.combo) {
        this.handleLog(`Update Combo backtest, remove server side`, 'debug')
        this.comboBacktestDb.updateData(
          { _id: `${resultSave.data._id}` },
          { $set: { serverSide: false } },
        )
      }
    }
    await this.updateRequest(
      BacktestRequestStatus.success,
      resultSave?.data?.shareId ?? '',
    )
    return resultSave
  }

  private async saveGridBacktest(
    result: GridBacktestingResult,
    symbol: Symbols,
  ) {
    const config = this.data.config
    const _data: Omit<GridBacktestingResult, 'orders' | 'transaction'> & {
      orders?: GridBacktestingResult['orders']
      transaction?: GridBacktestingResult['transaction']
    } = { ...result }
    // @ts-ignore
    delete _data.orders
    delete _data.transaction
    delete _data.ordersHistory
    // @ts-ignore
    delete _data.firstUsdRate
    // @ts-ignore
    delete _data.lastUsdRate
    // @ts-ignore
    delete _data.filledOrders
    // @ts-ignore
    delete _data.values
    delete _data.buyAndHoldEquity
    //@ts-ignore
    delete config.locked
    const settings = this.data.data.settings as Settings
    const exchange = this.data.data.exchange
    const exchangeUUID = this.data.data.exchangeUUID
    const formattedSettings = {
      ...settings,
      topPrice: this.math.convertString(settings.topPrice),
      lowPrice: this.math.convertString(settings.lowPrice),
      gridStep: this.math.round(
        this.math.convertString(settings.gridStep) / 100,
        5,
      ),
      budget: this.math.convertString(settings.budget),
      ordersInAdvance: this.math.convertString(settings.ordersInAdvance || ''),
      sellDisplacement: this.math.round(
        this.math.convertString(settings.sellDisplacement) / 100,
        5,
      ),
      tpPerc: this.math.round(
        this.math.convertString(settings.tpPerc || '0') / 100,
        3,
      ),
      slPerc: this.math.round(
        this.math.convertString(settings.slPerc || '0') / 100,
        3,
      ),
      tpTopPrice: this.math.convertString(settings.tpTopPrice || '0'),
      slLowPrice: this.math.convertString(settings.slLowPrice || '0'),
      baseAsset: symbol?.baseAsset.name || '',
      quoteAsset: symbol?.quoteAsset.name || '',
      levels: this.math.convertString(settings.levels),
      exchange,
      exchangeUUID,
      pair: settings.pair ?? symbol.pair,
      leverage: settings.leverage
        ? this.math.convertString(`${settings.leverage}`)
        : undefined,
    }
    delete formattedSettings.updatedBudget
    Object.keys(formattedSettings).forEach((k) => {
      const key = k as keyof typeof formattedSettings
      if (`${formattedSettings[key]}` === 'null') {
        delete formattedSettings[key]
      }
    })
    const toSave = {
      ..._data,
      symbol: symbol.pair,
      baseAsset: symbol.baseAsset.name,
      quoteAsset: symbol.quoteAsset.name,
      userId: this.userId,
      time: new Date().getTime(),
      exchange,
      exchangeUUID,
      settings: formattedSettings,
      savePermanent: false,
      duration: { ..._data.duration, periodName: config.periodName },
      config,
      serverSide: true,
      shareId: v4(),
    }
    this.handleLog(`Save Grid backtest`, 'debug')
    const resultSave = await this.gridBacktestDb.createData(toSave)
    if (resultSave && resultSave.data?._id) {
      const saveData = JSON.stringify({ ...result, config })
      const id = `${resultSave.data._id}`
      const meta = {
        id,
        exchange: toSave.exchange,
        baseAsset: toSave.baseAsset,
        quoteAsset: toSave.quoteAsset,
        symbol: toSave.symbol,
        type: 'Grid',
      }
      const entry = {
        data: saveData,
        ...meta,
      }
      this.handleLog(`Grid backtest saved with id ${id}`, 'debug')
      await this.saveFile(entry, meta)
    }
    await this.updateRequest(
      BacktestRequestStatus.success,
      resultSave?.data?.shareId ?? '',
    )
    return resultSave
  }

  protected handleBacktestLog(value: number, text: string) {
    this.handleLog(`Done ${this.math.round(value * 100, 0)}% ${text}`, 'debug')
  }

  public async run(): Promise<ResultType | null> {
    this.handleLog('Running backtest', 'debug')
    const prices = await this.loadPrices()
    this.handleLog('Prices loaded', 'debug')
    const symbols = await this.getSymbols()
    this.handleLog('Symbols loaded', 'debug')
    const symbolsToUse = this.data.config.multiIdependent
      ? symbols.map((s) => [s])
      : [symbols]
    const total = symbolsToUse.length
    const current = 1
    const results: ResultType = []
    const name = this.data.data.settings.name
    for (const s of symbolsToUse) {
      if (this.data.config.multiIdependent) {
        this.handleLog(
          `Running backtest for ${s[0].pair} ${current}/${total}`,
          'debug',
        )
        this.data.data.settings.pair = s[0].pair
        this.data.data.settings.name = `${name || 'multi'}_${s[0].pair}`
      }
      const instance =
        this.data.type === BotType.dca || this.data.type === BotType.combo
          ? new DCABackteser(
              {
                ...this.data.data,
                prices,
                symbols: s,
                useFile: true,
              },
              this.handleBacktestLog,
            )
          : this.data.type === BotType.grid
            ? new GridBacktester({ ...this.data.data, prices, symbols: s })
            : null
      if (instance) {
        this.handleLog('Instance created', 'debug')
        this.updateRequest(BacktestRequestStatus.loadingData)
        const result = await instance.test(
          undefined,
          this.handleBacktestLog,
          () => this.updateRequest.bind(this)(BacktestRequestStatus.processing),
        )
        if (result) {
          if (
            this.data.type === BotType.dca ||
            this.data.type === BotType.combo
          ) {
            this.handleLog('Prepare to save result DCA/Combo', 'debug')
            const saveResult = await this.saveDCAComboBacktest(
              result as DCABacktestingResult,
              s[0],
            )
            if (saveResult?.status === StatusEnum.ok) {
              results.push({
                id: saveResult.data._id.toString(),
                time: result.duration.processingDataTime,
                shareId: saveResult.data.shareId ?? '',
                type: this.data.type,
              })
            } else {
              this.handleLog(
                `Error saving result DCA/Combo ${saveResult?.reason}`,
                'error',
              )
              continue
            }
          } else if (this.data.type === BotType.grid) {
            this.handleLog('Prepare to save result Grid', 'debug')
            const saveResult = await this.saveGridBacktest(
              result as GridBacktestingResult,
              s[0],
            )
            if (saveResult?.status === StatusEnum.ok) {
              results.push({
                id: saveResult.data._id.toString(),
                time: result.duration.processingDataTime,
                shareId: saveResult.data.shareId ?? '',
                type: this.data.type,
              })
            } else {
              this.handleLog(
                `Error saving result DCA/Combo ${saveResult?.reason}`,
                'error',
              )
              continue
            }
          }
        } else {
          this.handleLog('Result not created', 'error')
          continue
        }
      } else {
        this.handleLog('Instance not created', 'error')
        continue
      }
    }
    return results
  }
}

export default BacktestWrapper
