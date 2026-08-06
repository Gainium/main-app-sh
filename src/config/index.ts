const defaultHost = 'localhost'

export const {
  GRAPH_QL_PORT = '7503',
  WS_PORT = '7502',
  BACKTEST_PORT = '7515',
  MAIN_SERVICE_HOST = defaultHost,
  DATA_PATH = 'loaded-data-candles',
  BotServiceType,
  BOTS_PER_WORKER = '100',
  COMBO_PER_WORKER,
  DCA_PER_WORKER,
  GRID_PER_WORKER,
  HEDGE_COMBO_PER_WORKER,
  HEDGE_PER_WORKER,
  HEDGE_DCA_PER_WORKER,
  FULL_RESTART = 'false',
  FULL_GRID_RESTAT = 'false',
  SKIP_REDIS,
  MONGO_DB_MAX_POOL_SIZE = '100',
  MONGO_DB_NAME,
  MONGO_DB_USERNAME,
  MONGO_DB_PASSWORD,
  MONGO_DB_PORT,
  SERVICETYPE,
  MONGO_DB_CONNECTION_STRING,
  MONGO_DB_HOST = defaultHost,
  RABBIT_USER,
  RABBIT_PASSWORD,
  RABBIT_HOST = defaultHost,
  REDIS_PASSWORD,
  REDIS_PORT = 6379,
  REDIS_HOST = defaultHost,
  PAPER_TRADING_API_URL,
  EXCHANGE_SERVICE_API_URL,
  BACKTEST_SERVICE_HOST = defaultHost,
  JWT_SECRET = '',
  INIDCATORS_PER_WORKER = '5000',
  SERVER_HOST,
  CORS_ORIGIN,
  SYNC_USER = 'true',
  CANDLES_OFFSET = '../../../../',
  // Command-listener arming fallback (see CoreBot.beginRestartWindow). The bot
  // service only starts consuming its command queue once every bot has been
  // re-hydrated; without a fallback a re-hydration that never completes leaves
  // the service permanently deaf to user commands.
  BOT_RESTART_ARM_FALLBACK = 'true',
  // No re-hydration progress for this long => the restart is stuck, not slow.
  BOT_RESTART_ARM_STALL_MS = '120000',
  // Absolute ceiling on a restart window, however slowly it is progressing.
  BOT_RESTART_ARM_CAP_MS = '1800000',
  // How long the API waits for a bot-service RPC reply. The default is the
  // long-standing hardcoded 5 minutes; a bot-type restart routinely outlasts it,
  // which is why a command issued mid-restart looks failed and then applies.
  BOT_SERVICE_RPC_TIMEOUT_MS = '300000',
  // How long after arming to judge which bots never reported back. Must exceed
  // the slowest type's re-hydration — observed 2026-08-05: combo 7m28s, DCA
  // 4m24s — or healthy-but-slow bots are reported as missing.
  BOT_RESTART_STRAGGLER_DELAY_MS = '600000',
} = process.env
