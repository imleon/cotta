import { sanitizeValue } from './sanitize.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const LOGGER_SANITIZE_OPTIONS = {
  maxStringLength: 160,
  maxArrayDepth: 3,
  maxObjectDepth: 4,
  maxArrayItems: 10,
} as const

function isDebugEnabled(scope: string): boolean {
  const raw = (process.env.COTTA_DEBUG || process.env.DEBUG || '').trim()
  if (!raw) return false
  if (raw === '1' || raw === 'true' || raw === '*') return true
  return raw.split(',').map((part) => part.trim()).filter(Boolean).includes(scope)
}

function emit(scope: string, level: LogLevel, event: string, fields?: LogFields): void {
  if (level === 'debug' && !isDebugEnabled(scope)) return

  const prefix = `[${scope}] ${event}`
  const payload = fields && Object.keys(fields).length > 0
    ? sanitizeValue(fields, LOGGER_SANITIZE_OPTIONS)
    : undefined
  const method = level === 'debug' ? 'log' : level
  if (payload !== undefined) {
    console[method](prefix, payload)
    return
  }
  console[method](prefix)
}

export type Logger = {
  debug: (event: string, fields?: LogFields) => void
  info: (event: string, fields?: LogFields) => void
  warn: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
}

export function createLogger(scope: string): Logger {
  return {
    debug(event: string, fields?: LogFields) {
      emit(scope, 'debug', event, fields)
    },
    info(event: string, fields?: LogFields) {
      emit(scope, 'info', event, fields)
    },
    warn(event: string, fields?: LogFields) {
      emit(scope, 'warn', event, fields)
    },
    error(event: string, fields?: LogFields) {
      emit(scope, 'error', event, fields)
    },
  }
}

export function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

export { sanitizeValue }
