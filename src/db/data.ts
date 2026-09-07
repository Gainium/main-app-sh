import { MongoMemoryServer } from 'mongodb-memory-server'
import {
  MONGO_DB_NAME,
  MONGO_DB_USERNAME,
  MONGO_DB_PASSWORD,
  MONGO_DB_PORT,
  MONGO_DB_HOST,
  MONGO_DB_CONNECTION_STRING,
  MONGO_DB_URI,
} from '../config'

const getMongooseConnect = async () => {
  // Integration tests (tests/processing/**, specs/016) run against an
  // in-memory Mongo instead of a real connection. MONGO_DB_URI still wins
  // when set, so a developer/CI job that wants a real Mongo in test mode can
  // point at one.
  if (process.env.NODE_ENV === 'testing') {
    if (MONGO_DB_URI) return MONGO_DB_URI
    const mongoServer = await MongoMemoryServer.create()
    const uri = mongoServer.getUri()
    process.env.MONGO_DB_URI = uri
    return uri
  }
  return (
    MONGO_DB_CONNECTION_STRING ??
    `mongodb://${MONGO_DB_USERNAME}:${MONGO_DB_PASSWORD}@${
      MONGO_DB_HOST
    }:${MONGO_DB_PORT}/${MONGO_DB_NAME}`
  )
}

const mongo = { connection: getMongooseConnect }

export default mongo
