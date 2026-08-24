import fs from 'fs'
import path from 'path'
import express from 'express'
import compression from 'compression'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import bodyParser from 'body-parser'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@as-integrations/express5'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import BotInstance from '../bot'
import { Resolvers, Schema } from '../graphql'
import userUtils from '../utils/user'
import { liveupdate, StatusEnum } from '../../types'
import methods from '../exchange/additionalAPIs'
import _API, { middleware as _middleware, bodyMiddleware } from './api'
import { v2API } from './v2'
import swaggerUi from 'swagger-ui-express'
import { apiReference } from '@scalar/express-api-reference'
import cookieParser from 'cookie-parser'
import logger from '../utils/logger'
import saveFileHelper, { isInsideUserFiles } from '../utils/files'
import { checkToken } from '../backtest/utils/token'
import { ExchangeEnum } from '../../types'
import RedisClient from '../db/redis'
import { filesDb, userDb } from '../db/dbInit'
import { CORS_ORIGIN, GRAPH_QL_PORT, JWT_SECRET, SERVER_HOST } from '../config'
import { addHealthEndpoint } from '../utils/healthServer'
import swaggerDoc from './swagger.json'
import { startAdminConfigSync } from '../utils/adminConfig'
import { startEncryptKeyBackfill } from '../utils/encryptKeyBackfill'

swaggerDoc.servers = [{ url: `${SERVER_HOST}` }]

const cors_origin = CORS_ORIGIN?.split(' ')

const Bot = BotInstance.getInstance()

interface UserRequest {
  username: string
  authorized: boolean
}

declare global {
  // eslint-disable-next-line
  namespace Express {
    interface Request {
      user?: UserRequest
    }
  }
}

/**
 * SECURITY (GHSA-whmj-5f67-9f3w): `apiLimiter` below covers only the `/api`
 * REST routes. The GraphQL endpoint is mounted at `/` with no limiter at all,
 * so the `token` login mutation could be brute-forced or credential-stuffed
 * without any throttling, lockout or backoff.
 *
 * Rate-limiting ALL of GraphQL would throttle the dashboard, which issues many
 * queries per page view, so this limiter throttles only documents that carry a
 * credential-bearing operation. Everything else skips it untouched.
 */
const AUTH_OPERATION_RE =
  /\b(?:mutation\s+)?(?:token|register|changePassword|setNewPassword|resetPassword|requestPasswordReset)\s*[({]/

const isAuthOperation = (req: express.Request): boolean => {
  const body = req.body as
    | { query?: unknown; operationName?: unknown }
    | undefined
  if (!body) return false
  const name = typeof body.operationName === 'string' ? body.operationName : ''
  if (
    /^(token|register|changePassword|setNewPassword|resetPassword|requestPasswordReset)$/.test(
      name,
    )
  ) {
    return true
  }
  const query = typeof body.query === 'string' ? body.query : ''
  // Cheap bound: a real auth document is short. Skipping the regex on a huge
  // document keeps this off the hot path for dashboard batch queries.
  if (!query || query.length > 4000) return false
  return AUTH_OPERATION_RE.test(query)
}

/**
 * Deliberately much tighter than `apiLimiter` (50/min): ten credential
 * attempts a minute from one address is already far more than a person does,
 * and anything above it is a script. Override with `AUTH_RATE_LIMIT_MAX`.
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:
    Number(process.env.AUTH_RATE_LIMIT_MAX) > 0
      ? Number(process.env.AUTH_RATE_LIMIT_MAX)
      : 10,
  standardHeaders: false,
  legacyHeaders: true,
  skip: (req) => !isAuthOperation(req as express.Request),
  keyGenerator: (req) => {
    return ipKeyGenerator(
      (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        req.ip ||
        'unknown',
    )
  },
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: false,
  legacyHeaders: true,
  keyGenerator: (req) => {
    return ipKeyGenerator(
      (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        req.ip ||
        'unknown',
    )
  },
})

type ApolloContext = {
  token: string
  userAgent?: string
  paperContext: boolean
  ip?: string
  req: express.Request
}

async function start() {
  userUtils.connectUserBalance()
  await startAdminConfigSync()
  // Not awaited: it re-encrypts stored credentials in the background when this
  // installation has its own ENCRYPT_KEY and values are still under the
  // build's. Boot does not wait for it.
  void startEncryptKeyBackfill()
  const port = GRAPH_QL_PORT

  const app = express()

  if (!SERVER_HOST) {
    throw 'Missed server host'
  }

  // gzip/deflate all compressible responses (notably the ~3.4MB getAllPairs
  // JSON, which is highly repetitive and shrinks ~10x). Registered before any
  // route so it wraps every response, including the Apollo GraphQL middleware.
  app.use(compression())

  app.use(
    '/api/docs/v2',
    apiReference({
      spec: {
        url: '/api/v2/openapi.yaml',
      },
      persistAuth: true,
      defaultOpenAllTags: true,
      expandAllResponses: true,
      favicon: 'https://app.gainium.io/gainium-icon-192x192.png',
      onLoaded: () => {
        // Load crypto-js from CDN
        if (typeof window !== 'undefined' && !window.CryptoJS) {
          const script = document.createElement('script')
          script.src =
            'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js'
          script.async = false
          script.onload = () => {
            console.log('✅ CryptoJS loaded successfully')
          }
          script.onerror = () => {
            console.error('❌ Failed to load CryptoJS')
          }
          document.head.appendChild(script)
        }
      },
      onBeforeRequest: async ({
        requestBuilder,
        request,
      }: {
        requestBuilder: Request
        request: Request
      }) => {
        const token = request.headers.get('token') ?? ''
        const secret = request.headers.get('secret') ?? ''
        if (
          token &&
          secret &&
          typeof window !== 'undefined' &&
          window.CryptoJS
        ) {
          const time = Date.now().toString()
          const url = new URL(request.url)
          const endpoint = url.pathname + url.search
          const method = request.method || 'GET'

          // Get request body text
          let bodyText = ''
          if (request.body) {
            try {
              // Clone the request to read body without consuming the original
              const clonedRequest = request.clone()
              bodyText = await clonedRequest.text()
              bodyText = JSON.stringify(JSON.parse(bodyText)) // Normalize JSON body to remove whitespace
              if (bodyText === '{}' || bodyText === '') bodyText = ''
            } catch {
              bodyText = ''
            }
          }

          // Generate signature using crypto-js
          const signatureData = bodyText + method + endpoint + time
          const signature = window.CryptoJS.HmacSHA256(
            signatureData,
            secret,
          ).toString(window.CryptoJS.enc.Base64)
          request.headers.delete('secret') // Remove secret from headers
          // Add time and signature headers (token already exists from auth)
          requestBuilder.headers.set('time', time)
          requestBuilder.headers.set('signature', signature)
        }
      },
      metaData: {
        title: 'Gainium API v2.0 Documentation',
        description:
          'Modern API documentation. Enter token and secret for automatic signature generation.',
      },
      configuration: {
        theme: 'default',
        layout: 'classic',
        defaultHttpClient: {
          targetKey: 'javascript',
          clientKey: 'fetch',
        },
        customCss: `
          .scalar-api-reference {
            --scalar-color-accent: #0066cc;
          }
        `,
        authentication: {
          // Show ApiKeyAuth and SecretAuth panels; suppress the auto-generated ones
          preferredSecurityScheme: ['ApiKeyAuth', 'SecretAuth'],
          securitySchemes: {
            ApiKeyAuth: {
              name: 'token',
              in: 'header',
              value: '', // user fills this in
            },
            SecretAuth: {
              name: 'secret',
              in: 'header',
              value: '', // user fills this in — intercepted before send
            },
          },
        },
      },
    }),
  )

  app.use(
    '/api/docs',
    //@ts-ignore
    swaggerUi.serve,
    swaggerUi.setup(swaggerDoc, {
      customJs:
        'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.0.0/crypto-js.min.js',
      swaggerOptions: {
        requestInterceptor: (request: any) => {
          const secret = request.headers.secret
          if (secret) {
            const time = new Date().getTime()
            const endpoint = request.url.replace(window.location.origin, '')
            let body = ''
            try {
              body = request.body
                ? JSON.stringify(JSON.parse(request.body))
                : ''
              if (body.length === 2) {
                body = ''
              }
            } catch {
              body = ''
            }
            const signatureResult = window.CryptoJS.HmacSHA256(
              body + request.method + endpoint + time,
              secret,
            ).toString(CryptoJS.enc.Base64)
            delete request.headers.secret
            request.headers.time = time
            request.headers.signature = signatureResult
          }
          return request
        },
      },
    }),
  )

  // Serve OpenAPI v2.0 YAML spec
  app.get('/api/v2/openapi.yaml', (req, res) => {
    const viewInBrowser = req.query.view === 'true'

    if (viewInBrowser) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    } else {
      res.setHeader('Content-Type', 'application/yaml')
    }

    try {
      const specPath = path.join(
        __dirname,
        '../../../src/server/v2/openapi-v2.yaml',
      )
      const spec = fs.readFileSync(specPath, 'utf8')
      res.send(spec)
    } catch (error) {
      console.error('Failed to load OpenAPI spec:', error)
      res.status(404).json({
        error: 'OpenAPI spec not found',
        attempted_path: path.join(
          __dirname,
          '../../../src/server/v2/openapi-v2.yaml',
        ),
      })
    }
  })

  app.use(cors({ origin: cors_origin, credentials: true }))

  app.use('/api/serverSideBacktestSaveFile', bodyParser.json({ limit: '2gb' }))

  app.use('/', bodyParser.json({ limit: '512kb' }))

  // Add health endpoint
  addHealthEndpoint(app)

  const API = _API()
  const middleware = _middleware()

  API.get.forEach((fn, r) =>
    app.get(r, apiLimiter, bodyMiddleware, middleware, fn),
  )

  API.put.forEach((fn, r) =>
    app.put(r, apiLimiter, bodyMiddleware, middleware, fn),
  )

  API.getPublic.forEach((fn, r) => app.get(r, apiLimiter, bodyMiddleware, fn))

  API.post.forEach((fn, r) =>
    app.post(r, apiLimiter, bodyMiddleware, middleware, fn),
  )

  API.delete.forEach((fn, r) =>
    app.delete(r, apiLimiter, bodyMiddleware, middleware, fn),
  )

  const v2 = v2API()

  v2.get.forEach((fn, r) =>
    app.get(
      r,
      apiLimiter,
      bodyMiddleware,
      middleware,
      ...fn.middlewares,
      fn.handler,
    ),
  )

  v2.post.forEach((fn, r) =>
    app.post(
      r,
      apiLimiter,
      bodyMiddleware,
      middleware,
      ...fn.middlewares,
      fn.handler,
    ),
  )

  v2.put.forEach((fn, r) =>
    app.put(
      r,
      apiLimiter,
      bodyMiddleware,
      middleware,
      ...fn.middlewares,
      fn.handler,
    ),
  )

  v2.delete.forEach((fn, r) =>
    app.delete(
      r,
      apiLimiter,
      bodyMiddleware,
      middleware,
      ...fn.middlewares,
      fn.handler,
    ),
  )

  v2.getPublic.forEach((fn, r) =>
    app.get(r, apiLimiter, bodyMiddleware, ...fn.middlewares, fn.handler),
  )

  app.get('/datafeed_ws', async (_req, res) => {
    const result = await methods.getWSKucoin()
    res.send(result)
  })
  app.get('/tickers', async (req, res) => {
    const exchange = req.query.exchange as ExchangeEnum | undefined
    if (!exchange) {
      res.send({
        data: null,
        reason: `Exchange is required`,
        status: StatusEnum.notok,
      })
      return
    }
    res.send(await methods.getPrices(exchange))
  })
  app.get('/candles', async (req, res) => {
    const exchange = req.query.exchange as ExchangeEnum | undefined
    const type = req.query.type as string
    const startAt = req.query.startAt as string
    const endAt = req.query.endAt as string
    const symbol = req.query.symbol as string
    const limit = req.query.limit as string
    if (!exchange || !type || !startAt || !endAt || !symbol) {
      res.send({
        data: null,
        reason: `Missing required param`,
        status: StatusEnum.notok,
      })
      return
    }
    res.send(
      await methods.getCandles({
        type,
        startAt,
        endAt,
        symbol,
        exchange,
        limit,
      }),
    )
  })
  app.post('/trade_signal', async (req, res) => {
    const result = (await Bot.webhookProcess(req.body)) as {
      status?: StatusEnum
    }
    if (result && result.status && result.status === StatusEnum.notok) {
      res.status(400)
    }
    res.send(result)
  })

  app.post('/api/serverSideBacktest', async (req, res) => {
    const { userId, backtestData, encryptedToken } = req.body
    if (!checkToken(encryptedToken)) {
      res.sendStatus(403)
      return
    }
    if (backtestData.shareId) {
      const data = {
        shareId: backtestData.shareId,
        botType: backtestData.type,
      }

      const redis = await RedisClient.getInstance()
      redis?.publish(
        `${liveupdate}${userId}`,
        JSON.stringify({ data: { data }, event: 'serverBacktest' }),
      )
    }
    res.sendStatus(200)
  })

  app.post('/api/serverSideBacktestSaveFile', async (req, res) => {
    const { data, name, resolution, path, encryptedToken } = req.body
    if (!checkToken(encryptedToken)) {
      res.sendStatus(403)
      return
    }

    try {
      const fileResult = saveFileHelper(
        JSON.stringify(data),
        name,
        resolution,
        path,
      )
      res.send(fileResult)
    } catch (e) {
      logger.error(`Cannot save file ${e}`)
      res.sendStatus(400)
    }
  })

  app.get('/api/loadBacktestDetails/:backtestId', async (req, res) => {
    const token = req.headers.token as string
    if (!token) {
      res.status(403).send('Not authorized to load backtest')
      return
    }
    const { backtestId } = req.params
    if (!backtestId) {
      res.status(400).send('Backtest id is required')
      return
    }
    const userFind = await userDb.readData({
      tokens: { $elemMatch: { token } },
    })
    if (userFind.status === StatusEnum.notok) {
      res.status(400).send(`User read error ${userFind.reason}`)
      return
    }
    if (!userFind.data?.result) {
      res.status(400).send('User not found')
      return
    }
    const file = await filesDb.readData({
      userId: `${userFind.data.result._id}`,
      'meta.id': backtestId,
    })
    if (file.status === StatusEnum.notok) {
      res.status(400).send(`File read error ${file.reason}`)
      return
    }
    if (!file.data?.result) {
      res.status(400).send('File not found')
      return
    }
    // SECURITY: `path` is read back from the database and handed straight to
    // sendFile. saveFile bounds what it writes today, but rows stored before
    // that guard existed are still here, and the shadowed local `path` above
    // masks the imported `path` module — the exact footgun reported in
    // main-app-sh PR #12. Re-check containment at the point of serving.
    const storedPath = file.data.result.path
    if (!isInsideUserFiles(storedPath)) {
      logger.error(
        `Refusing to serve a backtest file outside user-files: ${storedPath}`,
      )
      res.status(400).send('File not found')
      return
    }
    const exist = fs.existsSync(storedPath)
    if (!exist) {
      res.status(400).send('File not found')
      return
    }
    res.status(200).sendFile(storedPath)
  })

  if (!JWT_SECRET) {
    throw Error('Missing jwt secret')
  }

  const authenticateJWT = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const token = req.headers.token as string

    if (token) {
      jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
          return res.json({
            errors: [
              {
                message: 'Session is expired, please login again',
              },
            ],
          })
        }
        req.user = user as UserRequest
        next()
      })
    } else {
      next()
    }
  }
  app.all('/api{/*path}', (_, res) => {
    res.status(404).send('Not found')
  })
  app.use(authenticateJWT)
  app.use(cookieParser())

  const apolloServer = new ApolloServer<ApolloContext>({
    typeDefs: Schema,
    resolvers: Resolvers(),
    plugins: [ApolloServerPluginLandingPageDisabled()],
  })

  await apolloServer.start()

  app.use(
    '/',
    cors<cors.CorsRequest>({
      origin: cors_origin,
      credentials: true,
    }),
    (req, _res, next) => {
      if (!req.body) {
        req.body = {}
      }
      next()
    },
    // Runs after the body is parsed (bodyParser is mounted on '/' above) so it
    // can tell an auth document from ordinary dashboard traffic, and before
    // Apollo so a throttled attempt never reaches the resolver.
    authLimiter,
    expressMiddleware(apolloServer, {
      context: async ({ req }) => {
        return {
          token: (req.headers.token as string) || '',
          userAgent: req.headers['user-agent'],
          paperContext: req.headers['paper-context'] === 'true',
          ip:
            (req.headers['x-forwarded-for'] as string) ||
            req.socket.remoteAddress,
          req: req as unknown as express.Request,
        } as ApolloContext
      },
    }) as unknown as express.RequestHandler,
  )

  app.listen(port, () => {
    logger.info(`>🚀 GraphQl ready on http://localhost:${port}`)
  })
}

process
  .on('unhandledRejection', (reason, p) => {
    logger.error(reason, 'Unhandled Rejection at Promise', p)
  })
  .on('uncaughtException', (err) => {
    logger.error(err, 'Uncaught Exception thrown')
  })

start()
