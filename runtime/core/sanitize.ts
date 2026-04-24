export const REDACTED = '[REDACTED]'

export type SanitizeOptions = {
  maxStringLength?: number
  maxArrayDepth?: number
  maxObjectDepth?: number
  maxArrayItems?: number
}

function maskSensitiveString(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&]auth=)[^&]+/gi, `$1${REDACTED}`)
}

function truncateString(value: string, maxStringLength?: number): string {
  if (typeof maxStringLength !== 'number' || value.length <= maxStringLength) {
    return value
  }
  return `${value.slice(0, maxStringLength)}…`
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized === 'auth'
}

export function sanitizeValue(value: unknown, options: SanitizeOptions = {}, depth: number = 0): unknown {
  if (value == null) return value

  if (typeof value === 'string') {
    return truncateString(maskSensitiveString(value), options.maxStringLength)
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(maskSensitiveString(value.message), options.maxStringLength),
    }
  }

  if (Array.isArray(value)) {
    if (typeof options.maxArrayDepth === 'number' && depth >= options.maxArrayDepth) {
      return `[array:${value.length}]`
    }
    const items = typeof options.maxArrayItems === 'number'
      ? value.slice(0, options.maxArrayItems)
      : value
    return items.map((item) => sanitizeValue(item, options, depth + 1))
  }

  if (typeof value === 'object') {
    if (typeof options.maxObjectDepth === 'number' && depth >= options.maxObjectDepth) {
      return '[object]'
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : sanitizeValue(entryValue, options, depth + 1),
      ]),
    )
  }

  return String(value)
}
