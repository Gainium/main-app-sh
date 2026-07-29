import mongoose from 'mongoose'
import { isMainThread, threadId } from 'worker_threads'
import mongo from './data'
import { StatusEnum } from '../../types'
import logger from '../utils/logger'
import utils from '../utils'
import { IdMute, IdMutex } from '../utils/mutex'
import type {
  Model,
  PipelineStage,
  UpdateQuery,
  QueryFilter,
  QueryOptions,
  ProjectionType,
  DeepPartial,
  Require_id,
  ApplyBasicCreateCasting,
} from 'mongoose'
import type { ExcludeDoc } from '../../types'
import { MONGO_DB_MAX_POOL_SIZE } from '../config'
import { syncIndexes } from './model'

const { sleep } = utils

const mutex = new IdMutex()

/** Error respone */
export type ErrorResponse = {
  /** status NOTOK  */
  status: StatusEnum.notok
  /** error message */
  reason: any
  /** data = null */
  data: null
}

/** Message respone */
export type MessageResponse = {
  /** status OK */
  status: StatusEnum.ok
  /** message */
  reason: any
  /** data = null */
  data: null
}

/** Data respone */
export type DataResponse<T> = {
  /** status OK  */
  status: StatusEnum.ok
  /** message = null */
  reason: null
  /** data = T */
  data: T
}

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`}`

export class MongooseConnect {
  public static client?: typeof mongoose
  private static synced = false
  private static connectionFn: () => Promise<string>
  static async newClient() {
    MongooseConnect.client = undefined
    await MongooseConnect.getClient(MongooseConnect.connectionFn)
  }
  @IdMute(mutex, () => 'mongogetclient')
  static async getClient(
    connection: () => Promise<string>,
    syncIndexesFn?: () => Promise<void>,
    forceSync = false,
  ) {
    if (!connection) {
      throw new Error('${loggerPrefix} | MongooseConnect | No connection fn')
    }
    if (!MongooseConnect.client) {
      try {
        if (!MongooseConnect.connectionFn) {
          MongooseConnect.connectionFn = connection
        }
        const connectionString = await connection()
        mongoose.set('strictQuery', true)
        MongooseConnect.client = await mongoose.connect(`${connectionString}`, {
          maxPoolSize: +MONGO_DB_MAX_POOL_SIZE || 100,
        })
        if (!MongooseConnect.synced || forceSync) {
          MongooseConnect.synced = true
          if (syncIndexesFn) {
            await syncIndexesFn()
          }
        }
      } catch (e) {
        logger.error(
          `${loggerPrefix} | MongooseConnect | ${(e as Error)?.message ?? e}`,
        )
      }
    }
    return true
  }
}

const getAllKeys = <T extends Record<string, unknown>>(obj: T): string[] => {
  try {
    return [
      ...new Set(
        Object.entries(obj)
          .map(([key, value]) => {
            if (
              value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              //@ts-ignore
              typeof value?.getMonth !== 'function'
            ) {
              return [key, ...getAllKeys(value as Record<string, unknown>)]
            }
            return key
          })
          .flat(),
      ),
    ]
  } catch (e) {
    return []
  }
}

/**
 * Mongo db operation class
 */
class MongoCrud<T = any> {
  /** Model with schema to use by class */
  private model: Model<T>
  /**
   * Constructor method
   * @param {Model<T>} model model to use
   */
  constructor(model: Model<T>) {
    this.model = model
  }
  /**
   * Get mongoose client
   */
  protected getClient() {
    return MongooseConnect.getClient(mongo.connection, syncIndexes)
  }
  /**
   * Prepare error message
   * @param {any} error error data
   * @returns {ErrorResponse} error object
   */
  private returnError(error: any): ErrorResponse {
    return {
      status: StatusEnum.notok as StatusEnum.notok,
      reason: error,
      data: null,
    }
  }
  /**
   * Prepare response message
   * @param {any} message error data
   * @returns {MessageResponse} message object
   */
  private returnMessage(message: any): MessageResponse {
    return {
      status: StatusEnum.ok as StatusEnum.ok,
      reason: message,
      data: null,
    }
  }
  /**
   * Prepare response message
   * @param {T} data data
   * @returns {DataResponse<T>} data object
   */
  private returnData<DataType>(data: DataType) {
    return {
      status: StatusEnum.ok as StatusEnum.ok,
      reason: null,
      data,
    }
  }
  private handleError<T>(cb: (...args: any[]) => Promise<T>, ...args: any[]) {
    return async (e: Error | string) => {
      const str = (e as Error).message || (e as string)
      let count = args[args.length - 1]
      if (
        new RegExp(/connection[a-zA-Z0-9 .:<>]+closed/g).test(str) ||
        new RegExp(/connection[a-zA-Z0-9 .:<>]+timed out/g).test(str) ||
        new RegExp(/cursor id[0-9 ]+not found$/g).test(str) ||
        str
          .toLowerCase()
          .includes('Cannot use a session that has ended'.toLowerCase()) ||
        str.toLowerCase().includes('interrupted at shutdown'.toLowerCase()) ||
        str.toLowerCase().includes('MongoExpiredSessionError'.toLowerCase()) ||
        str
          .toLowerCase()
          .includes('MongooseServerSelectionError'.toLowerCase()) ||
        str.toLowerCase().includes('getaddrinfo'.toLowerCase()) ||
        str.toLowerCase().includes('Invalid URL'.toLowerCase()) ||
        str.toLowerCase().includes('ECONNREFUSED'.toLowerCase())
      ) {
        if (count <= 5) {
          logger.error(
            `${loggerPrefix} | Mongo | ${str} ${cb.name} ${
              this.model.collection.name
            } ${JSON.stringify([...args])} ${count}`,
          )
          logger.error(
            `${loggerPrefix} | Mongo | Connection closed or corrupted. Reconnecting...`,
          )
          await MongooseConnect.newClient()
          await sleep(3000)
          count++
          args.splice(args.length - 1, 1, count)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnError(
            'Something went wrong, please try again later',
          )
        }
      }
      return this.returnError(e)
    }
  }
  /**
   * Create and returns data
   * @param {T} data data object
   * @returns {Promise<ErrorResponse | DataResponse<T>>} saved data or error
   */

  async createData(
    data: Omit<ExcludeDoc<T>, '_id'>,
    updateTime = true,
    count = 0,
  ): Promise<ErrorResponse | DataResponse<ExcludeDoc<T>>> {
    const dataToAdd = {
      ...data,
      updated: updateTime ? new Date() : data.updated,
    }
    try {
      const result = await this.getClient()
        .then(async () => {
          const savedResult = await this.model.create(
            [{ ...dataToAdd }] as unknown as DeepPartial<
              ApplyBasicCreateCasting<Require_id<T>>
            >[] /*{
          session,
        }*/,
          )
          if (savedResult.length !== 0) {
            return this.returnData({
              ...savedResult[0].toObject(),
              _id: `${savedResult[0]._id}`,
            } as ExcludeDoc<T>)
          }
          return this.returnError('Server error')
        })
        .catch(this.handleError(this.createData, data, updateTime, count))
      return result
    } catch (e) {
      logger.error(`MongoCrud created data | ${(e as Error)?.message ?? e}`)
      return this.handleError(
        this.createData,
        data,
        updateTime,
        count,
      )(e as Error)
    }
  }
  /**
   * Bulk upsert documents by their original `_id`. Used by the cold-store
   * rehydrate (CH→Mongo restore): each doc carries its original `_id`, and
   * `replaceOne … upsert` makes a retried run OVERWRITE rather than
   * duplicate-key — so the restore stays idempotent. Mongoose casts both the
   * filter and the replacement, so the string `_id`s parsed from the CH `raw`
   * column cast back to ObjectId (and Date-ISO strings back to Date).
   * @param {Array<Record<string, any>>} docs documents (each MUST carry `_id`)
   * @returns {Promise<ErrorResponse | DataResponse<{ upserted: number; modified: number }>>}
   */
  async bulkUpsertById(
    docs: Array<Record<string, any>>,
    count = 0,
  ): Promise<
    ErrorResponse | DataResponse<{ upserted: number; modified: number }>
  > {
    if (!docs.length) {
      return this.returnData({ upserted: 0, modified: 0 })
    }
    try {
      const result = await this.getClient()
        .then(async () => {
          const ops = docs.map((d) => ({
            replaceOne: {
              filter: { _id: d._id },
              replacement: d,
              upsert: true,
            },
          }))
          // skipValidation: this is a FAITHFUL RESTORE of docs that were already
          // valid when archived — not new data. Re-validating would reject a
          // legitimately-restored doc if the schema tightened (a required field
          // added) after it was archived, which would break un-archive. Casting
          // (_id string→ObjectId, ISO→Date) still runs.
          const res = await this.model.bulkWrite(
            ops as unknown as Parameters<Model<T>['bulkWrite']>[0],
            { skipValidation: true } as Parameters<Model<T>['bulkWrite']>[1],
          )
          return this.returnData({
            upserted: res.upsertedCount ?? 0,
            modified: res.modifiedCount ?? 0,
          })
        })
        .catch(this.handleError(this.bulkUpsertById, docs, count))
      return result
    } catch (e) {
      logger.error(`MongoCrud bulk upsert | ${(e as Error)?.message ?? e}`)
      return this.handleError(this.bulkUpsertById, docs, count)(e as Error)
    }
  }
  /**
   * Read and returns data
   * @param {object | undefined} [search] search object. Default = {}
   * @param {string | undefined} [fields] fields to return. Default = undefined
   * @param {options | undefined} [options] options for search. Default = {}
   * @param {boolean | undefined} [isArray] set to true to return array, false - to return object. Default = false
   * @param {boolean | undefined} [countNeed] set to true to return count field. Default = false
   * @returns {Promise<ErrorResponse | DataResponse>} data or error
   */
  async readData<R = ExcludeDoc<T>>(
    search?: QueryFilter<ExcludeDoc<T>>,
    fields?: ProjectionType<ExcludeDoc<T>>,
    options?: QueryOptions<ExcludeDoc<T>>,
    isArray?: false,
    countNeed?: false,
  ): Promise<ErrorResponse | DataResponse<{ result: R & { _id: string } }>>
  async readData<R = ExcludeDoc<T>>(
    search?: QueryFilter<ExcludeDoc<T>>,
    fields?: ProjectionType<ExcludeDoc<T>>,
    options?: QueryOptions<ExcludeDoc<T>>,
    isArray?: true,
    countNeed?: false,
  ): Promise<ErrorResponse | DataResponse<{ result: (R & { _id: string })[] }>>
  async readData<R = ExcludeDoc<T>>(
    search?: QueryFilter<ExcludeDoc<T>>,
    fields?: ProjectionType<ExcludeDoc<T>>,
    options?: QueryOptions<ExcludeDoc<T>>,
    isArray?: true,
    countNeed?: true,
  ): Promise<
    | ErrorResponse
    | DataResponse<{ result: (R & { _id: string })[]; count: number }>
  >
  async readData<R = ExcludeDoc<T>>(
    search?: QueryFilter<ExcludeDoc<T>>,
    fields?: ProjectionType<ExcludeDoc<T>>,
    options?: QueryOptions<ExcludeDoc<T>>,
    isArray?: false,
    countNeed?: true,
  ): Promise<
    ErrorResponse | DataResponse<{ result: R & { _id: string }; count: number }>
  >

  async readData<R = ExcludeDoc<T>>(
    search: QueryFilter<ExcludeDoc<T>> = {},
    fields: ProjectionType<ExcludeDoc<T>> | undefined = undefined,
    options: QueryOptions<ExcludeDoc<T>> = {},
    isArray = false,
    countNeed = false,
    count = 0,
  ) {
    try {
      const data = await this.getClient()
        .then(async () => {
          if (isArray) {
            const result = await this.model
              .find(search, fields || null, options)
              .lean({ convertToMap: true })
            const res = result
            if (countNeed) {
              const count = await this.model.countDocuments(search)
              return this.returnData({
                result: res,
                count,
              })
            }
            return this.returnData({
              result: res as R[],
            })
          }
          const result = await this.model
            .findOne(search, fields || null, options)
            .lean({ convertToMap: true })
          const res = result
            ? ({ ...result, _id: `${(result as any)._id}` } as R)
            : undefined
          if (countNeed) {
            const count = await this.model.countDocuments(search)
            return this.returnData({
              result: res,
              count,
            })
          }
          return this.returnData({
            result: res,
          })
        })
        .catch(
          this.handleError(
            this.readData,
            search,
            fields,
            options,
            isArray,
            countNeed,
            count,
          ),
        )
      return data
    } catch (e) {
      logger.error(`MongoCrud read data | ${(e as Error)?.message ?? e}`)
      return this.handleError(
        this.readData,
        search,
        fields,
        options,
        isArray,
        countNeed,
        count,
      )(e as Error)
    }
  }
  /**
   * Count documents
   * @param {object | undefined} [search] search object. Default = {}
   * @param {number | undefined} [limit] stop counting once this many matches are found
   * (0 = count them all). Use it when the caller only needs the count up to a ceiling —
   * counting every match of a broad filter walks the whole matching set, which costs
   * seconds on the big collections (orders). Default = 0
   * @returns {Promise<ErrorResponse | DataResponse>} count or error
   */
  async countData(
    search: QueryFilter<ExcludeDoc<T>> = {},
    limit = 0,
    count = 0,
  ): Promise<ErrorResponse | DataResponse<{ result: number }>> {
    try {
      const data = await this.getClient()
        .then(async () => {
          const result = await this.model.countDocuments(
            search,
            limit > 0 ? { limit } : undefined,
          )
          return this.returnData({
            result,
          })
        })
        .catch(this.handleError(this.countData, search, limit, count))
      return data
    } catch (e) {
      logger.error(`MongoCrud count data | ${(e as Error)?.message ?? e}`)
      return this.handleError(this.countData, search, limit, count)(e as Error)
    }
  }
  /**
   * Run aggregation operation
   * @param {PipelineStage[]} aggregation Aggregation to execute
   * @returns {Promise<ErrorResponse | DataResponse>} data or error
   */

  async aggregate<T = any>(
    aggregation: PipelineStage[],
    count = 0,
  ): Promise<ErrorResponse | DataResponse<{ result: T[] }>> {
    try {
      const data = await this.getClient()
        .then(async () => {
          const result = await this.model.aggregate(aggregation)
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            reason: null,
            data: {
              result: result as unknown as T[],
            },
          }
        })
        .catch(this.handleError(this.aggregate, aggregation, count))
      return data
    } catch (e) {
      logger.error(`MongoCrud aggregate | ${(e as Error)?.message ?? e}`)
      return this.handleError(this.aggregate, aggregation, count)(e as Error)
    }
  }
  /**
   * Update one and returns data
   * @param {object | undefined} [search] search object. Default = {}
   * @param {any} data Data to update
   * @param {boolean | undefined} [returnDoc] set to true to return doc, false - to return message. Default = false
   * @param {boolean | undefined} [updateTimestamp] set to true to update updated date. Default = false
   * @returns {Promise<ErrorResponse | MessageResponse | DataResponse>} data or message or error
   */
  async updateData(
    search: QueryFilter<ExcludeDoc<T>>,
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    returnDoc?: false,
    updateTimestamp?: boolean,
    upsert?: boolean,
  ): Promise<ErrorResponse | MessageResponse>
  async updateData(
    search: QueryFilter<ExcludeDoc<T>>,
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    returnDoc?: true,
    updateTimestamp?: boolean,
    upsert?: boolean,
  ): Promise<DataResponse<T> | ErrorResponse>
  async updateData(
    search: QueryFilter<ExcludeDoc<T>>,
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    returnDoc?: false,
    updateTimestamp?: boolean,
    upsert?: boolean,
  ): Promise<ErrorResponse | MessageResponse>
  async updateData(
    search: QueryFilter<ExcludeDoc<T>>,
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    returnDoc?: true,
    updateTimestamp?: boolean,
    upsert?: boolean,
  ): Promise<DataResponse<T> | ErrorResponse>

  async updateData(
    search: QueryFilter<ExcludeDoc<T>> = {},
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    returnDoc = false,
    updateTimestamp = false,
    upsert = false,
    count = 0,
  ) {
    try {
      if (!getAllKeys(data).includes('updated')) {
        data = { ...data, updated: new Date() }
      }
      const result = await this.getClient()
        .then(async () => {
          if (!returnDoc) {
            const u = await this.model.updateOne(search, data, {
              upsert,
            })
            return this.returnMessage(
              `Data updated. Matched: ${u.matchedCount}, modified: ${u.modifiedCount}, upserted: ${u.upsertedCount}`,
            )
          }
          const update = await this.model.findOneAndUpdate(search, data, {
            new: true,
            lean: true,
            upsert,
          })
          if (update) {
            const res = { ...update, _id: `${(update as any)._id}` } as T
            return this.returnData(res)
          }
          return this.returnMessage('Data updated')
        })
        .catch(
          this.handleError(
            this.updateData,
            search,
            data,
            returnDoc,
            updateTimestamp,
            upsert,
            count,
          ),
        )
      return result
    } catch (e) {
      logger.error(`MongoCrud update data | ${(e as Error)?.message ?? e}`)
      return this.handleError(
        this.updateData,
        search,
        data,
        returnDoc,
        updateTimestamp,
        upsert,
        count,
      )(e as Error)
    }
  }
  /**
   * Delete one data
   * @param {object | undefined} [search] search object. Default = {}
   * @param {boolean | undefined} [returnDoc] set to true to return deleted doc, false - to return message. Default = false
   * @returns {Promise<ErrorResponse | MessageResponse | DataResponse>} deleted data, message or error
   */
  async deleteData(
    search: QueryFilter<ExcludeDoc<T>>,
    returnDoc?: false,
  ): Promise<ErrorResponse | MessageResponse>
  async deleteData(
    search: QueryFilter<ExcludeDoc<T>>,
    returnDoc?: true,
  ): Promise<DataResponse<ExcludeDoc<T>> | ErrorResponse>
  async deleteData(
    search: QueryFilter<ExcludeDoc<T>> = {},
    returnDoc = false,
    count = 0,
  ) {
    try {
      const result = await this.getClient()
        .then(async () => {
          if (!returnDoc) {
            const deleteRecord = await this.model.deleteOne(search)
            if (deleteRecord.deletedCount === 1) {
              return this.returnMessage('Record deleted')
            }
            return this.returnError('Server error')
          }

          const deletedDoc = await this.model.findOneAndDelete(search, {
            lean: true,
          })
          if (deletedDoc) {
            const res = {
              ...deletedDoc,
              _id: `${(deletedDoc as any)._id}`,
            } as T
            return this.returnData(res)
          }
          return this.returnError('No document found to delete')
        })
        .catch(this.handleError(this.deleteData, search, returnDoc, count))
      return result
    } catch (e) {
      logger.error(`MongoCrud delete data | ${(e as Error)?.message ?? e}`)
      return this.handleError(
        this.deleteData,
        search,
        returnDoc,
        count,
      )(e as Error)
    }
  }
  /**
   * Delete many data
   * @param {object | undefined} [search] search object. Default = {}
   * @returns {Promise<ErrorResponse | MessageResponse>} message or error
   */

  async deleteManyData(
    search: QueryFilter<ExcludeDoc<T>> = {},
    count = 0,
  ): Promise<ErrorResponse | MessageResponse> {
    try {
      const result = await this.getClient()
        .then(async () => {
          const deleteRecord = await this.model.deleteMany(
            search /*{ session }*/,
          )
          return this.returnMessage(
            `Deleted: ${deleteRecord.deletedCount} records`,
          )
        })
        .catch(this.handleError(this.deleteManyData, search, count))
      return result
    } catch (e) {
      logger.error(`MongoCrud delete many data | ${(e as Error)?.message ?? e}`)
      return this.handleError(this.deleteManyData, search, count)(e as Error)
    }
  }
  /**
   * Update many and returns data
   * @param {object | undefined} [search] search object. Default = {}
   * @param {any} data Data to update
   * @returns {Promise<ErrorResponse | MessageResponse>} data or error
   */

  async updateManyData(
    search: QueryFilter<ExcludeDoc<T>> = {},
    data: UpdateQuery<Partial<T> & { updated?: Date }>,
    count = 0,
  ): Promise<ErrorResponse | MessageResponse> {
    try {
      const result = await this.getClient()
        .then(async () => {
          const update = await this.model.updateMany(
            search,
            { ...data },
            {
              upsert: false,
            },
          )
          if (update) {
            return this.returnMessage(
              `Data updated. Matched: ${update.matchedCount}, modified: ${update.modifiedCount}`,
            )
          }
          return this.returnError('Server error')
        })
        .catch(this.handleError(this.updateManyData, search, data, count))
      return result
    } catch (e) {
      logger.error(`MongoCrud update many data | ${(e as Error)?.message ?? e}`)
      return this.handleError(
        this.updateManyData,
        search,
        data,
        count,
      )(e as Error)
    }
  }

  syncIndexes() {
    return this.getClient().then(() => this.model.syncIndexes())
  }
}

export default MongoCrud
