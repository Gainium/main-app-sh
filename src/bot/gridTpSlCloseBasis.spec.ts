process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `117.a-neutral-grid-tp-sl-values-the-position-against-the-close-entry`.
 *
 * Since spec `099` a NEUTRAL futures grid books its close leg against the
 * entry of the fills the round-trip ledger left unpaired, but the
 * value-changed TP/SL check (`tpSl()`) still valued the open position against
 * `data.position.price`. The two fixtures are real paper bots (spec §2): their
 * FILLED regular fills and their paired transactions, as read from prod.
 * Fills are folded through the REAL `calculatePosition`, the check is the REAL
 * `tpSl()` and the close is the REAL `profitAfterPositionClosed()`. No Mongo,
 * Redis, venue or bot stack. Harness shape copied from
 * `gridNeutralCloseBasis.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotMarginTypeEnum,
  ExchangeEnum,
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import MainBot from './main'

/** [clientOrderId, side, price, updateTime] */
type Fill = [string, 'BUY' | 'SELL', number, number]

const BR_FILLS: Fill[] = [
  ['GRID-RO-TxbWaz7kxx9m48TXfeo09NXioOh', 'SELL', 0.88711, 1790406919794],
  ['GRID-RO-jBQjgVDf1ESzTVkFHCkXYiBJuJQ', 'SELL', 0.91002, 1790407182816],
  ['GRID-RO-sFGTbNrs3pfUyQADRr8MS5kMa4x', 'SELL', 0.93352, 1790407363839],
  ['GRID-RO-tEhaUNqPHnUcT16LNzspHlU3ErL', 'BUY', 0.90966, 1790407653856],
  ['GRID-RO-z4oz0ZRwWxrpRUG6giVWg7Cf83E', 'SELL', 0.93352, 1790407741006],
  ['GRID-RO-3uHOOmIPOWHyWM7s2Ph96jDafAo', 'SELL', 0.95764, 1790408704972],
  ['GRID-RO-yazRnKfArmeCILHq4NRTmu18YV1', 'BUY', 0.93315, 1790408714984],
  ['GRID-RO-IIuIRFJnNgVKXWXZ3IftsPZkYPY', 'SELL', 0.95764, 1790408785965],
  ['GRID-RO-elRcuzJByHW47ACSP7LpZWgb9ER', 'SELL', 0.98237, 1790414754703],
  ['GRID-RO-5k9dZKaqgq2GNv7mQh5mZpuC8G5', 'BUY', 0.95725, 1790415254797],
  ['GRID-RO-PJayRXEUjyv9DSftLNe2iYtg1BB', 'SELL', 0.98237, 1790416383915],
  ['GRID-RO-w8nIbw97CBOOPmsCKzQRlV4AbYp', 'BUY', 0.95725, 1790419066218],
  ['GRID-RO-VEQoI0BucwWT2P8H9FZqBpTZXdt', 'BUY', 0.93315, 1790419241233],
  ['GRID-RO-LK7ky2oxdmHGMaJxIqm6w8fCADo', 'SELL', 0.95764, 1790419818330],
  ['GRID-RO-fzyRlBAqnL0bmjPgXZ3TLgWD0aZ', 'SELL', 0.98237, 1790420216341],
  ['GRID-RO-cEx5vkS7rW8c9YK6zvAG22FztVJ', 'SELL', 1.00774, 1790420408343],
  ['GRID-RO-SWYOtGU9iunKs2Z8PCY7ssKZikl', 'BUY', 0.98198, 1790423204633],
  ['GRID-RO-G3z3q94rPNH04WLdjy4kR8ELRTv', 'BUY', 0.95725, 1790423402661],
  ['GRID-RO-sjBqKyugVxynsC55KM6iDIkmS33', 'SELL', 0.98237, 1790423847653],
  ['GRID-RO-s49JvEP2yihfR8fCb6bJX08lWX1', 'SELL', 1.00774, 1790426594975],
  ['GRID-RO-vj7ifqLu4GfdnjvQ6QhIQdZUzt2', 'BUY', 0.98198, 1790440098380],
  ['GRID-RO-wFHxKAuZU41xwSEQXSuBSOz699K', 'BUY', 0.95725, 1790440233399],
]
const BR_PAIRS: [string, string][] = [
  [
    'GRID-RO-tEhaUNqPHnUcT16LNzspHlU3ErL',
    'GRID-RO-sFGTbNrs3pfUyQADRr8MS5kMa4x',
  ],
  [
    'GRID-RO-yazRnKfArmeCILHq4NRTmu18YV1',
    'GRID-RO-3uHOOmIPOWHyWM7s2Ph96jDafAo',
  ],
  [
    'GRID-RO-5k9dZKaqgq2GNv7mQh5mZpuC8G5',
    'GRID-RO-elRcuzJByHW47ACSP7LpZWgb9ER',
  ],
  [
    'GRID-RO-w8nIbw97CBOOPmsCKzQRlV4AbYp',
    'GRID-RO-PJayRXEUjyv9DSftLNe2iYtg1BB',
  ],
  [
    'GRID-RO-VEQoI0BucwWT2P8H9FZqBpTZXdt',
    'GRID-RO-IIuIRFJnNgVKXWXZ3IftsPZkYPY',
  ],
  [
    'GRID-RO-SWYOtGU9iunKs2Z8PCY7ssKZikl',
    'GRID-RO-cEx5vkS7rW8c9YK6zvAG22FztVJ',
  ],
  [
    'GRID-RO-G3z3q94rPNH04WLdjy4kR8ELRTv',
    'GRID-RO-fzyRlBAqnL0bmjPgXZ3TLgWD0aZ',
  ],
  [
    'GRID-RO-vj7ifqLu4GfdnjvQ6QhIQdZUzt2',
    'GRID-RO-s49JvEP2yihfR8fCb6bJX08lWX1',
  ],
  [
    'GRID-RO-wFHxKAuZU41xwSEQXSuBSOz699K',
    'GRID-RO-sjBqKyugVxynsC55KM6iDIkmS33',
  ],
]
const NIL_FILLS: Fill[] = [
  ['GRID-RO-mCY5lsIi6ErHcbT1FjElBtMjdNo', 'BUY', 0.11975, 1790326944958],
  ['GRID-RO-LsRSOiWgRCUf5f7V31esbuSQnMY', 'SELL', 0.12287, 1790329158253],
  ['GRID-RO-WFkjh5hDP6RcMWOwzcIFczFKaQD', 'BUY', 0.11975, 1790329666229],
  ['GRID-RO-Fxkb2hCjqY159IHEZYdGvhfY9wl', 'SELL', 0.12287, 1790331860505],
  ['GRID-RO-n5uBODCtTVqr3vWlQyZKSYHoJ6s', 'SELL', 0.12601, 1790333355782],
  ['GRID-RO-q0WYpFOn0GN0kBcouuyNXi56WKD', 'SELL', 0.12924, 1790334998098],
  ['GRID-RO-6Q09LhOiee0bcQ1A8xIcnzLrmsU', 'SELL', 0.13255, 1790336890270],
  ['GRID-RO-EhqMs3dbhvJwgWJPDttXnNHYGUl', 'SELL', 0.13594, 1790337619431],
  ['GRID-RO-Ib3m5gVEmPd75fDlSRD1Wk72h8c', 'SELL', 0.13942, 1790338130434],
  ['GRID-RO-R7gHFlcNRNV3Z7Uz7mjvof2KyIA', 'BUY', 0.13589, 1790338574885],
  ['GRID-RO-LS3pHj2ohJefQ31jRDr1vsrRHcH', 'BUY', 0.13249, 1790338751993],
  ['GRID-RO-NMCWDQFcnmeQ8K9ldIPEuMZEjxh', 'SELL', 0.13594, 1790339008604],
  ['GRID-RO-KmjDTNR64mptyu26kKPli95Q4Qd', 'BUY', 0.13249, 1790339183668],
  ['GRID-RO-WCzHsAev1Hd7etDD8s0bKjQ3LHF', 'BUY', 0.12919, 1790340604865],
  ['GRID-RO-X2CsceNz3HPfGUaGnXczZNqZrJE', 'SELL', 0.13255, 1790343364272],
  ['GRID-RO-odtu9tf1jn7yORip1YkzRY5AYf1', 'BUY', 0.12919, 1790344041811],
  ['GRID-RO-3686T3xeSQeehJLnM5OcFSZucR8', 'SELL', 0.13255, 1790345748057],
  ['GRID-RO-zuCAgPu5HTgN2KnFR3znjkiicts', 'SELL', 0.13594, 1790347322166],
  ['GRID-RO-6YL8C8WfLsqM8O34yPpX8KwG4q0', 'BUY', 0.13249, 1790348402801],
  ['GRID-RO-BTKUjE98GouAEjGfkov4lowFCMI', 'SELL', 0.13594, 1790350329449],
  ['GRID-RO-HcoNOGynTyjHUGAKgDq4mKuj2SW', 'BUY', 0.13249, 1790350735621],
  ['GRID-RO-Swi3LTtLKIcNfM7B7toAR4iCmvA', 'BUY', 0.12919, 1790350871389],
  ['GRID-RO-JJkOcpdlpBdmLyOrNIxLAKAxItZ', 'BUY', 0.12596, 1790351503509],
  ['GRID-RO-eCrYithz8cWKviE9g3RZz7qPNLE', 'SELL', 0.12924, 1790352312601],
  ['GRID-RO-Myqwt2Rt97SVFEqgSPbhu4QIF0K', 'BUY', 0.12596, 1790352722701],
  ['GRID-RO-FrKqLGVuG1j0fINyNNvZLPRoJEZ', 'SELL', 0.12924, 1790353900788],
  ['GRID-RO-RPHtRHJ5VFysM8eP3bsVmiCBt41', 'BUY', 0.12596, 1790357856293],
  ['GRID-RO-wQjliKhpQjEUAAZ84qsnBxTHKmK', 'SELL', 0.12924, 1790358499456],
  ['GRID-RO-qywbDPeVaRmU4iERyCTiMCFNxJi', 'SELL', 0.13255, 1790360822670],
  ['GRID-RO-scDl0Gbk97gMPTZLx7j2qX6sSXn', 'BUY', 0.12919, 1790362880882],
  ['GRID-RO-pJ0o9jSPSYeXkHWvOErl8uNKlnS', 'BUY', 0.12596, 1790363638977],
  ['GRID-RO-nldHrOriwLDB1Rxp3mnRA7AJv2v', 'BUY', 0.12282, 1790364985133],
  ['GRID-RO-G2KMWgLPfjmHFdM7UEcYjmxtbWF', 'BUY', 0.11975, 1790367028972],
  ['GRID-RO-e4JMEbtyol8Gf07ub5J7kuwAqcq', 'BUY', 0.11677, 1790367100353],
  ['GRID-RO-TWX7OrN18MSZpF1LvUp9F3vD1aJ', 'SELL', 0.1198, 1790368240449],
  ['GRID-RO-yZXk3wd08IZSuSDMHJNhz9qyl0l', 'BUY', 0.11677, 1790369666658],
  ['GRID-RO-LgMIzIjGNRZS994BXy5f7D1Ss2t', 'BUY', 0.11385, 1790401574210],
  ['GRID-RO-446UNumcgu20vxkdmw27L57wjme', 'BUY', 0.11101, 1790403365481],
  ['GRID-RO-ttnjg3ff6XjHNgEuy4xjR3IZpih', 'BUY', 0.10824, 1790404318544],
  ['GRID-RO-6vSIni8LA1IJIQLN1nxD9VR5mVa', 'SELL', 0.11105, 1790406338779],
  ['GRID-RO-v5Yyq01VsxI1xdqkUdub5v0qy1d', 'BUY', 0.10824, 1790414018726],
  ['GRID-RO-cWdNaPDIrKobRxCinxmBgWqe6cn', 'BUY', 0.10554, 1790440246422],
  ['GRID-RO-D7AjKbRNq8vNboFNguyxI4Icysd', 'BUY', 0.1029, 1790446629129],
  ['GRID-RO-DvXXHoGfw27LgmxyeoTgYR3Hc5m', 'BUY', 0.10033, 1790454736963],
  ['GRID-RO-nqnRDzI3cWpzMAAILJIJLz9IOxU', 'BUY', 0.09783, 1790462288610],
  ['GRID-RO-quLqTj5yahGukCBMKBA6fkAt5CB', 'SELL', 0.10037, 1790465641144],
  ['GRID-RO-UuamRbeDEO2Algr0Xcg50kvxnHo', 'SELL', 0.10294, 1790466340965],
  ['GRID-RO-espv5VVdjv4nf61EriTDXB4f6wu', 'BUY', 0.10033, 1790470794443],
  ['GRID-RO-xnFSLIqZSAFYaa8IB72Bw8V4T1f', 'BUY', 0.09783, 1790475274944],
  ['GRID-RO-HtHbLrY6ksULQyJe9rdciepOWP5', 'SELL', 0.10037, 1790476032050],
  ['GRID-RO-CMxGTLNlqzpw6qcNI2k3A3lDXMl', 'BUY', 0.09783, 1790479925425],
  ['GRID-RO-WQrsuCIvrU6wlrysqahbn3Z3QFh', 'SELL', 0.10037, 1790488142328],
  ['GRID-RO-H5v4vRKUK7CFsI9rmrpzbQtGu9T', 'BUY', 0.09783, 1790488579356],
  ['GRID-RO-sg8tO85tKqSCj8rfs9AgbY3qUWG', 'SELL', 0.10037, 1790492522781],
  ['GRID-RO-KqMVdWDX2uLhrLKF7EXiuMDOJgu', 'SELL', 0.10294, 1790492734732],
]
const NIL_PAIRS: [string, string][] = [
  [
    'GRID-RO-mCY5lsIi6ErHcbT1FjElBtMjdNo',
    'GRID-RO-LsRSOiWgRCUf5f7V31esbuSQnMY',
  ],
  [
    'GRID-RO-WFkjh5hDP6RcMWOwzcIFczFKaQD',
    'GRID-RO-Fxkb2hCjqY159IHEZYdGvhfY9wl',
  ],
  [
    'GRID-RO-R7gHFlcNRNV3Z7Uz7mjvof2KyIA',
    'GRID-RO-Ib3m5gVEmPd75fDlSRD1Wk72h8c',
  ],
  [
    'GRID-RO-LS3pHj2ohJefQ31jRDr1vsrRHcH',
    'GRID-RO-EhqMs3dbhvJwgWJPDttXnNHYGUl',
  ],
  [
    'GRID-RO-KmjDTNR64mptyu26kKPli95Q4Qd',
    'GRID-RO-NMCWDQFcnmeQ8K9ldIPEuMZEjxh',
  ],
  [
    'GRID-RO-WCzHsAev1Hd7etDD8s0bKjQ3LHF',
    'GRID-RO-6Q09LhOiee0bcQ1A8xIcnzLrmsU',
  ],
  [
    'GRID-RO-odtu9tf1jn7yORip1YkzRY5AYf1',
    'GRID-RO-X2CsceNz3HPfGUaGnXczZNqZrJE',
  ],
  [
    'GRID-RO-6YL8C8WfLsqM8O34yPpX8KwG4q0',
    'GRID-RO-zuCAgPu5HTgN2KnFR3znjkiicts',
  ],
  [
    'GRID-RO-HcoNOGynTyjHUGAKgDq4mKuj2SW',
    'GRID-RO-BTKUjE98GouAEjGfkov4lowFCMI',
  ],
  [
    'GRID-RO-Swi3LTtLKIcNfM7B7toAR4iCmvA',
    'GRID-RO-3686T3xeSQeehJLnM5OcFSZucR8',
  ],
  [
    'GRID-RO-JJkOcpdlpBdmLyOrNIxLAKAxItZ',
    'GRID-RO-q0WYpFOn0GN0kBcouuyNXi56WKD',
  ],
  [
    'GRID-RO-Myqwt2Rt97SVFEqgSPbhu4QIF0K',
    'GRID-RO-eCrYithz8cWKviE9g3RZz7qPNLE',
  ],
  [
    'GRID-RO-RPHtRHJ5VFysM8eP3bsVmiCBt41',
    'GRID-RO-FrKqLGVuG1j0fINyNNvZLPRoJEZ',
  ],
  [
    'GRID-RO-scDl0Gbk97gMPTZLx7j2qX6sSXn',
    'GRID-RO-qywbDPeVaRmU4iERyCTiMCFNxJi',
  ],
  [
    'GRID-RO-pJ0o9jSPSYeXkHWvOErl8uNKlnS',
    'GRID-RO-wQjliKhpQjEUAAZ84qsnBxTHKmK',
  ],
  [
    'GRID-RO-nldHrOriwLDB1Rxp3mnRA7AJv2v',
    'GRID-RO-n5uBODCtTVqr3vWlQyZKSYHoJ6s',
  ],
  [
    'GRID-RO-e4JMEbtyol8Gf07ub5J7kuwAqcq',
    'GRID-RO-TWX7OrN18MSZpF1LvUp9F3vD1aJ',
  ],
  [
    'GRID-RO-ttnjg3ff6XjHNgEuy4xjR3IZpih',
    'GRID-RO-6vSIni8LA1IJIQLN1nxD9VR5mVa',
  ],
  [
    'GRID-RO-nqnRDzI3cWpzMAAILJIJLz9IOxU',
    'GRID-RO-quLqTj5yahGukCBMKBA6fkAt5CB',
  ],
  [
    'GRID-RO-DvXXHoGfw27LgmxyeoTgYR3Hc5m',
    'GRID-RO-UuamRbeDEO2Algr0Xcg50kvxnHo',
  ],
  [
    'GRID-RO-xnFSLIqZSAFYaa8IB72Bw8V4T1f',
    'GRID-RO-HtHbLrY6ksULQyJe9rdciepOWP5',
  ],
  [
    'GRID-RO-CMxGTLNlqzpw6qcNI2k3A3lDXMl',
    'GRID-RO-WQrsuCIvrU6wlrysqahbn3Z3QFh',
  ],
  [
    'GRID-RO-H5v4vRKUK7CFsI9rmrpzbQtGu9T',
    'GRID-RO-sg8tO85tKqSCj8rfs9AgbY3qUWG',
  ],
  [
    'GRID-RO-espv5VVdjv4nf61EriTDXB4f6wu',
    'GRID-RO-KqMVdWDX2uLhrLKF7EXiuMDOJgu',
  ],
]

type Fixture = {
  pair: string
  qty: number
  fills: Fill[]
  pairs: [string, string][]
  /** `profit.total` just before the close: the ledger's last cumulative. */
  realized: number
  initialBalances: { base: number; quote: number }
  initialPrice: number
  /** Price the prod TP fired and the close filled at. */
  closePrice: number
  closeSide: 'BUY' | 'SELL'
  unpairedEntry: number
  positionPrice: number
}

const BR: Fixture = {
  pair: 'BRUSDT',
  qty: 27,
  fills: BR_FILLS,
  pairs: BR_PAIRS,
  realized: 5.6916209393132995,
  initialBalances: { base: 162, quote: 147.72537 },
  initialPrice: 0.86034964,
  closePrice: 0.94742,
  closeSide: 'BUY',
  unpairedEntry: 0.9220725,
  positionPrice: 0.97663,
}

const NIL: Fixture = {
  pair: 'NILUSDT',
  qty: 134.3,
  fills: NIL_FILLS,
  pairs: NIL_PAIRS,
  realized: 9.906396527394605,
  initialBalances: { base: 1208.6999999999998, quote: 131.106346 },
  initialPrice: 0.12412,
  closePrice: 0.10314,
  closeSide: 'SELL',
  unpairedEntry: 0.11115142857142857,
  positionPrice: 0.10412,
}

const initialValue = (f: Fixture) =>
  f.initialBalances.base * f.initialPrice + f.initialBalances.quote

let Helper: any
let TpSlReturn: any

const makeBot = (
  f: Fixture,
  opts: {
    futuresStrategy?: FuturesStrategyEnum
    tpPerc?: number
    slPerc?: number
  } = {},
) => {
  const order = ([clientOrderId, side, price, updateTime]: Fill) => ({
    clientOrderId,
    symbol: f.pair,
    side,
    status: 'FILLED',
    typeOrder: TypeOrderEnum.regular,
    price: `${price}`,
    origQty: `${f.qty}`,
    executedQty: `${f.qty}`,
    updateTime,
  })
  class TestBot extends (Helper as any) {
    public botId = 'bot'
    public userId = 'user'
    public math = new MathHelper()
    public ordersRead = 0
    public persisted: Fill[] = []
    public paired: [string, string][] = []
    public order = order
    public data: any = {
      _id: 'bot',
      userId: 'user',
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      symbol: { symbol: f.pair, baseAsset: 'B', quoteAsset: 'USDT' },
      settings: {
        pair: f.pair,
        futures: true,
        coinm: false,
        futuresStrategy: opts.futuresStrategy ?? FuturesStrategyEnum.neutral,
        marginType: BotMarginTypeEnum.cross,
        leverage: 1,
        profitCurrency: 'quote',
        tpSl: true,
        tpSlCondition: 'valueChanged',
        tpPerc: opts.tpPerc ?? 0.03,
        sl: true,
        slCondition: 'valueChanged',
        slPerc: opts.slPerc ?? -0.04,
      },
      initialBalances: f.initialBalances,
      initialPrice: f.initialPrice,
      position: { side: PositionSide.LONG, qty: 0, price: 0 },
      positionHistory: [],
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public ordersDb: any = {
      readData: () => {
        this.ordersRead += 1
        return Promise.resolve({
          status: StatusEnum.ok,
          data: { result: this.persisted.map(order) },
        })
      },
    }
    public transactionDb: any = {
      readData: () =>
        Promise.resolve({
          status: StatusEnum.ok,
          data: {
            result: this.paired.map(([idBuy, idSell]) => ({ idBuy, idSell })),
          },
        }),
    }
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    get currentLeverage() {
      return 1
    }
    get isShort() {
      return false
    }
    calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
    async getExchangeInfo() {
      return {
        pair: f.pair,
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 0.1, step: 0.1, name: 'B' },
        quoteAsset: { minAmount: 5, step: 0.00001, name: 'USDT' },
      }
    }
    async baseAssetPrecision() {
      return 1
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    saveProfitToDb() {}
    updateData() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

/**
 * The bot as it stood when the prod TP fired: every fill folded into the
 * position, persisted, and its round trip booked.
 */
const atClose = async (
  f: Fixture,
  opts: Parameters<typeof makeBot>[1] = {},
) => {
  const bot = makeBot(f, opts)
  for (const fill of f.fills) {
    await bot.calculatePosition(bot.order(fill))
  }
  bot.persisted = [...f.fills]
  bot.paired = [...f.pairs]
  bot.data.profit.total = f.realized
  return bot
}

/** Let the un-awaited ledger refresh settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

/** The percentage `tpSl()` reports when it fires, e.g. `1.03`. */
const firedPerc = (text: string) => +/unPnL (-?[\d.]+)%/.exec(text)![1]

describe('a neutral grid value-changed TP/SL values the position against the close entry (spec 117)', () => {
  before(function () {
    this.timeout(180000)
    const mod = createRequire(__filename)('./helper')
    TpSlReturn = mod.TpSlReturn
    Helper = mod.default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§2 the fixtures are the reported bots', () => {
    for (const f of [BR, NIL]) {
      it(`${f.pair}: position.price ${f.positionPrice}, unpaired entry ${f.unpairedEntry}`, async () => {
        const bot = await atClose(f)
        expect(bot.data.position.price).to.be.closeTo(f.positionPrice, 1e-9)
        expect(await bot.closeEntryPrice('')).to.be.closeTo(
          f.unpairedEntry,
          1e-9,
        )
      })
    }
  })

  describe('§4.1 a 3% TP does not fire at the reported close price', () => {
    for (const f of [BR, NIL]) {
      it(f.pair, async () => {
        const bot = await atClose(f)
        bot.tpSl(f.closePrice)
        await settle()
        const { value, text } = bot.tpSl(f.closePrice)
        expect(text).to.equal('')
        expect(value).to.equal(TpSlReturn.none)
      })
    }
  })

  describe('§4.2 the trigger measures what the close books', () => {
    for (const f of [BR, NIL]) {
      it(f.pair, async () => {
        const bot = await atClose(f, { tpPerc: 0.001 })
        bot.tpSl(f.closePrice)
        await settle()
        const { value, text } = bot.tpSl(f.closePrice)
        expect(value).to.equal(TpSlReturn.tp)
        const qty = bot.data.position.qty
        await bot.profitAfterPositionClosed({
          clientOrderId: 'GRID-TP-close',
          symbol: f.pair,
          side: f.closeSide,
          status: 'FILLED',
          typeOrder: TypeOrderEnum.stop,
          price: `${f.closePrice}`,
          origQty: `${qty}`,
          executedQty: `${qty}`,
          updateTime: f.fills[f.fills.length - 1][3] + 1,
        })
        const booked = (bot.data.profit.total / initialValue(f)) * 100
        expect(firedPerc(text)).to.be.closeTo(booked, 0.006)
        expect(firedPerc(text)).to.be.lessThan(1.1)
      })
    }
  })

  describe('§4.3 SL fires at the real loss, not later', () => {
    it('BRUSDT short: -4% is reached at 1.09, not only at 1.136', async () => {
      const bot = await atClose(BR)
      bot.tpSl(1.09)
      await settle()
      const { value, text } = bot.tpSl(1.09)
      expect(value).to.equal(TpSlReturn.sl)
      expect(firedPerc(text)).to.be.closeTo(
        ((BR.realized + 108 * (BR.unpairedEntry - 1.09)) / initialValue(BR)) *
          100,
        0.006,
      )
    })
  })

  describe('§4.4 the tick path never reads the ledger itself', () => {
    it('reads the ledger once per position, not per tick', async () => {
      const bot = await atClose(BR)
      for (let i = 0; i < 50; i++) {
        bot.tpSl(BR.closePrice)
      }
      await settle()
      const reads = bot.ordersRead
      expect(reads).to.equal(1)
      for (let i = 0; i < 50; i++) {
        bot.tpSl(BR.closePrice + i * 1e-5)
      }
      await settle()
      expect(bot.ordersRead).to.equal(reads)
    })

    it('a filled order refreshes the entry after its transaction is booked', async () => {
      const bot = makeBot(BR)
      const last = BR.fills[BR.fills.length - 1]
      for (const fill of BR.fills.slice(0, -1)) {
        await bot.calculatePosition(bot.order(fill))
      }
      bot.persisted = BR.fills.slice(0, -1)
      bot.paired = BR.pairs.slice(0, -1)
      bot.data.profit.total = BR.realized
      bot.tpSl(BR.closePrice)
      await settle()
      // Drive the real `processFilledOrder`: the fill is persisted at once,
      // its round trip lands in the ledger only after the booking's awaits.
      Object.assign(bot, {
        loadingComplete: true,
        ordersInProgress: new Set(),
        shouldProceed: () => true,
        isLastOrder: () => false,
        createTransaction: async () => {
          await new Promise((r) => setTimeout(r, 5))
          bot.paired = [...BR.pairs]
        },
      })
      bot.persisted = [...BR.fills]
      await bot.processFilledOrder(bot.order(last), last[3], true)
      await settle()
      expect(bot.ordersRead).to.equal(2)
      const { value } = bot.tpSl(BR.closePrice)
      expect(value).to.equal(TpSlReturn.none)
      expect(bot.ordersRead).to.equal(2)
    })
  })

  describe('spec 135: a cold entry cache never decides a neutral TP/SL', () => {
    it('the first tick after a restart does not fire TP on position.price', async () => {
      // A 3% TP clears on position.price at this price (3.08%) but not on
      // the unpaired entry (≈1.03%): the reported restart case.
      const bot = await atClose(BR)
      const first = bot.tpSl(BR.closePrice)
      expect(first.value).to.equal(TpSlReturn.none)
      expect(first.text).to.equal('')
      await settle()
      expect(bot.tpSl(BR.closePrice).value).to.equal(TpSlReturn.none)
      expect(bot.ordersRead).to.equal(1)
    })

    it('SL waits for the entry too, then fires on it', async () => {
      // BR short at 1.0: +1.1% on position.price, -0.95% on the unpaired entry.
      const bot = await atClose(BR, { slPerc: -0.005 })
      expect(bot.tpSl(1.0).value).to.equal(TpSlReturn.none)
      await settle()
      expect(bot.tpSl(1.0).value).to.equal(TpSlReturn.sl)
    })

    it('a position change is not judged on the previous entry or position.price', async () => {
      const bot = await atClose(BR)
      bot.tpSl(BR.closePrice)
      await settle()
      bot.data.position = { ...bot.data.position, qty: 81 }
      expect(bot.tpSl(0.5).value).to.equal(TpSlReturn.none)
    })
    it('a refresh that throws does not stop later refreshes', async () => {
      const bot = await atClose(BR)
      bot.updateData = () => {
        throw new Error('db down')
      }
      bot.tpSl(BR.closePrice)
      await settle()
      bot.updateData = () => {}
      bot.data.position = { ...bot.data.position, qty: 81 }
      bot.tpSl(BR.closePrice)
      await settle()
      expect(bot.ordersRead).to.equal(2)
    })
  })

  describe('§4.5 fallbacks match closeEntryPrice', () => {
    it('a SHORT-strategy grid keeps position.price and reads nothing', async () => {
      const bot = await atClose(BR, {
        futuresStrategy: FuturesStrategyEnum.short,
      })
      const { value } = bot.tpSl(BR.closePrice)
      await settle()
      expect(value).to.equal(TpSlReturn.tp)
      expect(bot.tpSl(BR.closePrice).value).to.equal(TpSlReturn.tp)
      expect(bot.ordersRead).to.equal(0)
    })

    it('a ledger that does not net to the position keeps position.price', async () => {
      const bot = await atClose(BR)
      bot.persisted = BR.fills.slice(1)
      bot.tpSl(BR.closePrice)
      await settle()
      expect(bot.tpSl(BR.closePrice).value).to.equal(TpSlReturn.tp)
    })
  })
})
