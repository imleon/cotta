import { stringifyStructuredValue } from '../../lib/runtime-format'

export function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    const record = getObject(current)
    if (!record) return undefined
    current = record[segment]
  }
  return current
}

export function toDisplayText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return stringifyStructuredValue(item)
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value == null) return ''
  return stringifyStructuredValue(value)
}

export function getToolResultMessageContent(value: unknown): string {
  const directRecord = getObject(value)
  if (directRecord?.type === 'tool_result') {
    return toDisplayText(directRecord.content)
  }

  const messageContent = getNestedValue(value, ['message', 'content'])
  if (!Array.isArray(messageContent)) return ''

  return messageContent
    .map((block) => {
      const record = getObject(block)
      if (!record || record.type !== 'tool_result') return ''
      return toDisplayText(record.content)
    })
    .filter(Boolean)
    .join('\n')
}

export function getSimpleResultContent(raw: unknown, output: unknown): string {
  return getToolResultMessageContent(raw)
    || getToolResultMessageContent(output)
    || toDisplayText(getObject(raw)?.content)
    || toDisplayText(output)
    || toDisplayText(getNestedValue(raw, ['toolUseResult']))
    || toDisplayText(getNestedValue(output, ['toolUseResult']))
}

export function getStringArrayField(value: unknown, field: string): string[] {
  const record = getObject(value)
  const raw = record?.[field]
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}
