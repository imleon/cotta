import { stringifyStructuredValue } from '../protocol/transcript-normalizer.js'
import type { AssistantToolEntry } from './assistant-detail-entries.js'

export type AssistantToolSection = {
  label?: string
  content: string
  mode?: 'plain' | 'markdown' | 'bash'
  command?: string
}

export type AssistantToolRenderConfig = {
  iconName: string
  title: string
  subtitle: string
  sections: AssistantToolSection[]
  maxHeightClass: string
  expandable: boolean
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

function getStringField(input: unknown, field: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

function getQuestions(input: unknown): Record<string, unknown>[] {
  const questions = getObject(input)?.questions
  return Array.isArray(questions)
    ? questions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function getFirstQuestion(input: unknown): string {
  for (const question of getQuestions(input)) {
    if (typeof question.question === 'string' && question.question.trim()) {
      return question.question.trim()
    }
  }
  return ''
}

function getAgentResultContent(raw: unknown, output: unknown): string {
  const contextCandidates = [
    getNestedValue(raw, ['toolUseResult', 'context']),
    getNestedValue(output, ['toolUseResult', 'context']),
    getNestedValue(raw, ['context']),
    getNestedValue(output, ['context']),
  ]

  for (const candidate of contextCandidates) {
    if (!Array.isArray(candidate)) continue
    const text = candidate
      .map((item) => getObject(item))
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }

  return getSimpleResultContent(raw, output)
}

function buildTodoSections(input: unknown): AssistantToolSection[] {
  const todos = getObject(input)?.todos
  if (!Array.isArray(todos)) return []
  return todos.map((todo, index) => ({
    label: `todo_${index + 1}`,
    content: stringifyStructuredValue(todo),
    mode: 'plain',
  }))
}

function buildObjectSections(value: unknown, fallbackLabel = 'input'): AssistantToolSection[] {
  const record = getObject(value)
  if (!record) {
    const content = stringifyStructuredValue(value)
    return content ? [{ label: fallbackLabel, content, mode: 'plain' }] : []
  }
  return Object.entries(record).map(([key, entryValue]) => ({
    label: key,
    content: typeof entryValue === 'string' ? entryValue : stringifyStructuredValue(entryValue),
    mode: 'plain',
  }))
}

function removeLabelWhenSingle(sections: AssistantToolSection[]): AssistantToolSection[] {
  if (sections.length !== 1) return sections
  return [{ ...sections[0], label: '' }]
}

export function buildAssistantToolRenderConfig(entry: AssistantToolEntry): AssistantToolRenderConfig {
  const normalizedTitle = entry.title.toLowerCase()

  if (entry.kind === 'bash') {
    return {
      iconName: 'command_outlined',
      title: `调用 ${entry.title}`,
      subtitle: entry.description || '',
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: removeLabelWhenSingle([
        {
          label: '',
          content: entry.resultContent || '',
          mode: 'bash',
          command: entry.command || '',
        },
      ]),
    }
  }

  if (entry.kind === 'agent') {
    return {
      iconName: 'robot_outlined',
      title: `调用 ${entry.title}`,
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: [
        { label: 'prompt', content: entry.prompt || '', mode: 'plain' },
        {
          label: 'tool_result',
          content: getAgentResultContent(entry.result?.raw, entry.result?.output),
          mode: 'markdown',
        },
      ],
    }
  }

  if (entry.kind === 'read' || entry.kind === 'glob' || entry.kind === 'grep') {
    const iconName = entry.kind === 'read'
      ? 'describe_outlined'
      : entry.kind === 'glob'
        ? 'file-link-wiki_outlined'
        : 'card-search_outlined'
    const subtitle = entry.kind === 'read'
      ? getStringField(entry.input, 'file_path') || entry.filePath || ''
      : getStringField(entry.input, 'pattern') || entry.filePath || ''
    return {
      iconName,
      title: `调用 ${entry.title}`,
      subtitle,
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: removeLabelWhenSingle([
        {
          label: '',
          content: getSimpleResultContent(entry.result?.raw, entry.result?.output),
          mode: 'plain',
        },
      ]),
    }
  }

  if (entry.kind === 'edit') {
    return {
      iconName: 'edit_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'file_path') || entry.filePath || '',
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: removeLabelWhenSingle(buildObjectSections(entry.input)),
    }
  }

  if (entry.kind === 'skill') {
    return {
      iconName: 'app-default_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'skill') || entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: [
        {
          label: 'args',
          content: typeof entry.args === 'string' ? entry.args : stringifyStructuredValue(entry.args),
          mode: 'plain',
        },
        {
          label: 'tool_result',
          content: getSimpleResultContent(entry.result?.raw, entry.result?.output),
          mode: 'markdown',
        },
      ],
    }
  }

  if (entry.kind === 'write') {
    return {
      iconName: 'filelink-save_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'file_path') || entry.filePath || '',
      maxHeightClass: 'max-h-56',
      expandable: true,
      sections: removeLabelWhenSingle([
        {
          label: 'content',
          content: typeof entry.contentValue === 'string' ? entry.contentValue : stringifyStructuredValue(entry.contentValue),
          mode: 'plain',
        },
      ]),
    }
  }

  if (entry.kind === 'taskcreate') {
    return {
      iconName: 'take-action_outlined',
      title: `调用 ${entry.title}`,
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      expandable: false,
      sections: [],
    }
  }

  if (normalizedTitle === 'enterplanmode') {
    return {
      iconName: 'whiteboard_outlined',
      title: `调用 ${entry.title}`,
      subtitle: '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'tasklist') {
    return {
      iconName: 'select-down_outlined',
      title: `调用 ${entry.title}`,
      subtitle: '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'exitplanmode') {
    return {
      iconName: 'whiteboard_outlined',
      title: `调用 ${entry.title}`,
      subtitle: '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: 'plan', content: toDisplayText(getObject(entry.input)?.plan), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'taskupdate') {
    return {
      iconName: 'take-action_outlined',
      title: `调用 ${entry.title}`,
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      expandable: false,
      sections: [],
    }
  }

  if (normalizedTitle === 'taskget') {
    return {
      iconName: 'take-action_outlined',
      title: `调用 ${entry.title}`,
      subtitle: entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'websearch') {
    return {
      iconName: 'language_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'query') || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'webfetch') {
    return {
      iconName: 'browser-mac_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'url') || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'askuserquestion') {
    return {
      iconName: 'maybe_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getFirstQuestion(entry.input),
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'toolsearch') {
    return {
      iconName: 'setting-inter_outlined',
      title: `调用 ${entry.title}`,
      subtitle: getStringField(entry.input, 'query') || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle([
        { label: '', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
      ]),
    }
  }

  if (normalizedTitle === 'todowrite') {
    return {
      iconName: 'todo_outlined',
      title: `调用 ${entry.title}`,
      subtitle: '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: removeLabelWhenSingle(buildTodoSections(entry.input)),
    }
  }

  return {
    iconName: 'setting-inter_outlined',
    title: `调用 ${entry.title}`,
    subtitle: '',
    maxHeightClass: 'max-h-80',
    expandable: true,
    sections: removeLabelWhenSingle([
      ...buildObjectSections(entry.input),
      { label: 'tool_result', content: getSimpleResultContent(entry.result?.raw, entry.result?.output), mode: 'markdown' },
    ]),
  }
}
