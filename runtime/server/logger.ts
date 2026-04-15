type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const REDACTED = '[REDACTED]'
const MAX_STRING_LENGTH = 160
const MAX_ARRAY_DEPTH = 3
const MAX_OBJECT_DEPTH = 4

function isDebugEnabled(scope: string): boolean {
  const raw = (process.env.COTTA_DEBUG || process.env.DEBUG || '').trim()
  if (!raw) return false
  if (raw === '1' || raw === 'true' || raw === '*') return true
  return raw.split(',').map((part) => part.trim()).filter(Boolean).includes(scope)
}

function sanitizeString(value: string): string {
  const masked = value
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&]auth=)[^&]+/gi, `$1${REDACTED}`)

  return masked.length > MAX_STRING_LENGTH ? `${masked.slice(0, MAX_STRING_LENGTH)}…` : masked
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized === 'auth'
}

export function sanitizeValue(value: unknown, depth: number = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: sanitizeString(value.message) }
  if (Array.isArray(value)) {
    if (depth >= MAX_ARRAY_DEPTH) return `[array:${value.length}]`
    return value.slice(0, 10).map((item) => sanitizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= MAX_OBJECT_DEPTH) return '[object]'
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : sanitizeValue(entryValue, depth + 1),
      ])
    )
  }
  return String(value)
}

function emit(scope: string, level: LogLevel, event: string, fields?: LogFields): void {
  if (level === 'debug' && !isDebugEnabled(scope)) return

  const prefix = `[${scope}] ${event}`
  const payload = fields && Object.keys(fields).length > 0 ? sanitizeValue(fields) : undefined
  const method = level === 'debug' ? 'log' : level
  if (payload !== undefined) {
    console[method](prefix, payload)
    return
  }
  console[method](prefix)
}

export function createLogger(scope: string) {
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
