import { stringifyStructuredValue } from '../protocol/transcript-normalizer.js'
import type { AssistantToolEntry } from './assistant-detail-entries.js'

export type AssistantToolSection = {
  label: string
  content: string
  mode?: 'plain' | 'markdown'
}

export type AssistantToolRenderConfig = {
  title: string
  subtitle: string
  sections: AssistantToolSection[]
  maxHeightClass: string
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    const record = getObject(current)
    if (!record) return undefined
    current = record[segment]
  }
  return current
}

function toDisplayText(value: unknown): string {
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

function getToolResultMessageContent(value: unknown): string {
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

function getSimpleResultContent(raw: unknown, output: unknown): string {
  return getToolResultMessageContent(raw)
    || getToolResultMessageContent(output)
    || toDisplayText(getObject(raw)?.content)
    || toDisplayText(output)
    || toDisplayText(getNestedValue(raw, ['toolUseResult']))
    || toDisplayText(getNestedValue(output, ['toolUseResult']))
}

export function buildAssistantToolRenderConfig(entry: AssistantToolEntry): AssistantToolRenderConfig {
  if (entry.kind === 'bash') {
    return {
      title: '调用 Bash',
      subtitle: entry.description || entry.command || '',
      maxHeightClass: 'max-h-56',
      sections: [
        { label: 'command', content: entry.command || '', mode: 'plain' },
        { label: 'output', content: entry.resultContent || '', mode: 'plain' },
      ],
    }
  }

  if (entry.kind === 'agent') {
    return {
      title: '调用 Agent',
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      sections: [
        { label: 'prompt', content: entry.prompt || '', mode: 'plain' },
        {
          label: 'result',
          content: entry.result ? stringifyStructuredValue(entry.result.output) : '',
          mode: 'markdown',
        },
      ],
    }
  }

  if (entry.kind === 'read' || entry.kind === 'glob' || entry.kind === 'grep') {
    const title = entry.kind === 'read'
      ? '调用 Read'
      : entry.kind === 'glob'
        ? '调用 Glob'
        : '调用 Grep'
    return {
      title,
      subtitle: entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'result',
          content: entry.result ? stringifyStructuredValue(entry.result.output) : '',
          mode: 'plain',
        },
      ],
    }
  }

  if (entry.kind === 'edit') {
    const inputRecord = getObject(entry.input) ?? {}
    return {
      title: '调用 Edit',
      subtitle: entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: Object.entries(inputRecord).map(([key, value]) => ({
        label: key,
        content: typeof value === 'string' ? value : stringifyStructuredValue(value),
        mode: 'plain',
      })),
    }
  }

  if (entry.kind === 'skill') {
    return {
      title: '调用 Skill',
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'args',
          content: typeof entry.args === 'string' ? entry.args : stringifyStructuredValue(entry.args),
          mode: 'plain',
        },
      ],
    }
  }

  if (entry.kind === 'write') {
    return {
      title: '调用 Write',
      subtitle: entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'content',
          content: typeof entry.contentValue === 'string' ? entry.contentValue : stringifyStructuredValue(entry.contentValue),
          mode: 'plain',
        },
      ],
    }
  }

  return {
    title: `调用 ${entry.title}`,
    subtitle: entry.subtitle || entry.summary || '',
    maxHeightClass: 'max-h-80',
    sections: [
      { label: 'input', content: stringifyStructuredValue(entry.input), mode: 'plain' },
      { label: 'tool_result', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
    ],
  }
}
