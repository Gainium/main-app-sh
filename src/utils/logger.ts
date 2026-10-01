import { isMainThread } from 'worker_threads'
import { LogLevel } from '../../types'
import { redactLogArg } from './redactSecrets'

const weight: Record<LogLevel, number> = {
  error: 3,
  warn: 2,
  info: 1,
  debug: 0,
}

const log = (type: LogLevel, ...msg: any[]) => {
  const currentWeight = weight[type] ?? 0
  const logLevelWeight =
    weight[(process.env.LOG_LEVEL || 'info') as LogLevel] ?? 3
  if (currentWeight < logLevelWeight) {
    return
  }
  const pid = isMainThread ? process.pid : process.ppid
  const time = new Date()
  const separator = ` |${type === 'debug' ? ' [DEBUG]' : type === 'warn' ? ' [WARN]' : ''}`
  const fn =
    type === 'error'
      ? console.error
      : type === 'warn'
        ? console.warn
        : type === 'debug'
          ? console.debug
          : console.log
  // Every line passes through the secret redactor: HTTP clients put bearer
  // tokens in error messages, stacks and request configs, and call sites log
  // those objects whole.
  fn(`[${pid}] -`, time, separator, ...msg.map(redactLogArg))
}

const logger = {
  warn: (...msg: any[]) => log('warn', ...msg),
  error: (...msg: any[]) => log('error', ...msg),
  info: (...msg: any[]) => log('info', ...msg),
  debug: (...msg: any[]) => log('debug', ...msg),
}

export default logger
