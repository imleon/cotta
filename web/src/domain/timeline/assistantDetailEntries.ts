import type {
  TimelineAssistantItem,
  TimelineTextFragment,
  TimelineToolResultFragment,
  TimelineToolUseFragment,
} from '../../models/timeline'
import { stringifyStructuredValue } from '../../lib/runtime-format'

export type AssistantToolEntryKind =
  | 'tool'
  | 'agent'
  | 'taskcreate'
  | 'bash'
  | 'read'
  | 'glob'
  | 'grep'
  | 'edit'
  | 'skill'
  | 'write'

export type AssistantThinkingEntry = {
  key: string
  kind: 'thinking'
  title: string
  summary: string
  content: string
  redacted?: boolean
}

export type AssistantTextEntry = {
  key: string
  kind: 'text'
  fragment: TimelineTextFragment
}

export type AssistantToolEntry = {
  key: string
  kind: AssistantToolEntryKind
  title: string
  summary: string
  result: TimelineToolResultFragment | null
  command?: string
  description?: string
  resultContent?: string
  filePath?: string
  input?: unknown
  subtitle?: string
  prompt?: string
  args?: unknown
  contentValue?: unknown
}

export type AssistantToolGroupEntry = {
  key: string
  kind: 'tool_group'
  summary: string
  entries: AssistantToolEntry[]
}

export type AssistantDetailEntry =
  | AssistantThinkingEntry
  | AssistantTextEntry
  | AssistantToolEntry
  | AssistantToolGroupEntry

function compactString(value: string, head = 10, tail = 8): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= head + tail + 3) return normalized
  return `${normalized.slice(0, head)}...${normalized.slice(-tail)}`
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return compactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.slice(0, 3).map((item) => compactValue(item)).filter(Boolean)
    const suffix = value.length > 3 ? ', ...' : ''
    return `[${parts.join(', ')}${suffix}]`
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  const entries = Object.entries(record)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && String(entryValue).trim() !== '')
    .slice(0, 4)
    .map(([key, entryValue]) => `${key}=${compactValue(entryValue)}`)
  return entries.join(', ')
}

function getToolKind(fragment: TimelineToolUseFragment): 'agent' | 'taskcreate' | 'tool' {
  const normalizedName = (fragment.name || '').toLowerCase()
  const input = fragment.input && typeof fragment.input === 'object'
    ? fragment.input as Record<string, unknown>
    : null

  if (normalizedName.includes('taskcreate') || normalizedName.includes('task_create')) {
    return 'taskcreate'
  }
  if (normalizedName === 'task' || normalizedName.includes('agent') || typeof input?.subagent_type === 'string') {
    return 'agent'
  }
  return 'tool'
}

function getToolTitle(fragment: TimelineToolUseFragment): string {
  const kind = getToolKind(fragment)
  if (kind === 'agent') return 'Agent'
  if (kind === 'taskcreate') return 'TaskCreate'
  return fragment.name || 'Tool'
}

function getToolSummary(fragment: TimelineToolUseFragment): string {
  const kind = getToolKind(fragment)
  const input = fragment.input && typeof fragment.input === 'object'
    ? fragment.input as Record<string, unknown>
    : null

  if (!input) {
    return fragment.input ? compactValue(fragment.input) : ''
  }

  const preferredKeys = kind === 'agent'
    ? ['subagent_type', 'query', 'description']
    : ['description', 'query']
  const hiddenKeys = new Set(kind === 'taskcreate' ? ['description'] : [])

  const orderedEntries = [
    ...preferredKeys
      .filter((key) => key in input && !hiddenKeys.has(key))
      .map((key) => [key, input[key]] as const),
    ...Object.entries(input)
      .filter(([key]) => !preferredKeys.includes(key) && !hiddenKeys.has(key)),
  ]

  return orderedEntries
    .slice(0, 4)
    .map(([key, value]) => `${key}=${compactValue(value)}`)
    .join(', ')
}

function getStringField(input: unknown, field: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

function buildGlobSubtitle(input: unknown): string {
  const pattern = getStringField(input, 'pattern')
  const path = getStringField(input, 'path')
  if (pattern && path) return `${pattern} in ${path}`
  return pattern || path
}

function buildAgentSubtitle(input: unknown): string {
  const subagentType = getStringField(input, 'subagent_type')
  const description = getStringField(input, 'description')
  if (subagentType && description) return `${subagentType} (${description})`
  return subagentType || description
}

function getAgentPrompt(input: unknown): string {
  return getStringField(input, 'prompt') || getStringField(input, 'query')
}

function getSkillSubtitle(input: unknown): string {
  return getStringField(input, 'skill') || getStringField(input, 'name')
}

function getSkillArgs(input: unknown): unknown {
  if (!input || typeof input !== 'object') return undefined
  return (input as Record<string, unknown>).args
}

function getNestedString(value: unknown, path: string[]): string {
  let current: unknown = value
  for (const segment of path) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : ''
}

function buildTaskCreateSubtitleFromResult(
  input: unknown,
  result: TimelineToolResultFragment | null,
): string {
  const taskIdFromRaw = getNestedString(result?.raw, ['toolUseResult', 'task', 'id'])
  const taskIdFromOutput = getNestedString(result?.output, ['toolUseResult', 'task', 'id'])
  const taskIdFromText = (() => {
    const rawRecord = result?.raw && typeof result.raw === 'object' ? result.raw as Record<string, unknown> : null
    const candidates: Array<unknown> = [
      rawRecord?.content,
      rawRecord?.output,
      result?.output,
    ]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const match = candidate.match(/\bTask\s*#\s*(\d+)\b/i)
      if (match?.[1]) return match[1]
    }
    return ''
  })()
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const taskId = taskIdFromRaw || taskIdFromOutput || taskIdFromText
  const idPart = taskId ? `[#${taskId}]` : ''
  const subjectPart = subject || ''
  const descriptionPart = description ? `(${description})` : ''
  return [idPart, `${subjectPart}${descriptionPart}`.trim()].filter(Boolean).join(' ')
}

function extractBashResultContent(output: unknown): string {
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return stringifyStructuredValue(output)

  const record = output as Record<string, unknown>
  const content = record.content
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (typeof block === 'string') return block
        if (!block || typeof block !== 'object') return ''
        const candidate = block as Record<string, unknown>
        if (typeof candidate.text === 'string') return candidate.text
        if (typeof candidate.content === 'string') return candidate.content
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }

  return stringifyStructuredValue(output)
}

function isToolEntry(entry: AssistantDetailEntry): entry is AssistantToolEntry {
  return [
    'tool',
    'agent',
    'taskcreate',
    'bash',
    'read',
    'glob',
    'grep',
    'edit',
    'skill',
    'write',
  ].includes(entry.kind)
}

export function buildToolGroupSummary(entries: AssistantToolEntry[]): string {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const entry of entries) {
    const title = entry.title
    if (!counts.has(title)) order.push(title)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return order.map((title) => `${counts.get(title) ?? 0} 次 ${title}`).join('、')
}

function buildToolEntry(
  itemKey: string,
  index: number,
  fragment: TimelineToolUseFragment,
  result: TimelineToolResultFragment | null,
): AssistantToolEntry {
  if (fragment.name === 'Bash') {
    const command = getStringField(fragment.input, 'command')
    const description = getStringField(fragment.input, 'description')
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'bash',
      title: 'Bash',
      summary: '',
      result,
      command,
      description,
      resultContent: extractBashResultContent(result?.output),
    }
  }

  if (fragment.name === 'Read') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'read',
      title: 'Read',
      summary: '',
      result,
      filePath: getStringField(fragment.input, 'file_path'),
    }
  }

  if (fragment.name === 'Glob') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'glob',
      title: 'Glob',
      summary: '',
      result,
      filePath: buildGlobSubtitle(fragment.input),
    }
  }

  if (fragment.name === 'Grep') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'grep',
      title: 'Grep',
      summary: '',
      result,
      filePath: buildGlobSubtitle(fragment.input),
    }
  }

  if (fragment.name === 'Edit') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'edit',
      title: 'Edit',
      summary: '',
      result,
      filePath: getStringField(fragment.input, 'file_path'),
      input: fragment.input,
    }
  }

  if (fragment.name === 'Skill') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'skill',
      title: 'Skill',
      summary: '',
      result,
      subtitle: getSkillSubtitle(fragment.input),
      args: getSkillArgs(fragment.input),
    }
  }

  if (getToolKind(fragment) === 'taskcreate') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'taskcreate',
      title: 'TaskCreate',
      summary: '',
      result,
      subtitle: buildTaskCreateSubtitleFromResult(fragment.input, result),
    }
  }

  if (fragment.name === 'Write') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'write',
      title: 'Write',
      summary: '',
      result,
      filePath: getStringField(fragment.input, 'file_path'),
      contentValue: (fragment.input && typeof fragment.input === 'object')
        ? (fragment.input as Record<string, unknown>).content
        : undefined,
    }
  }

  if (getToolKind(fragment) === 'agent') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'agent',
      title: 'Agent',
      summary: '',
      result,
      subtitle: buildAgentSubtitle(fragment.input),
      prompt: getAgentPrompt(fragment.input),
    }
  }

  const toolKind = getToolKind(fragment)
  return {
    key: `${itemKey}-tool-${index}`,
    kind: toolKind,
    title: getToolTitle(fragment),
    summary: getToolSummary(fragment),
    result,
  }
}

export function buildAssistantDetailEntries(item: TimelineAssistantItem): AssistantDetailEntry[] {
  const entries: AssistantDetailEntry[] = []
  const toolResultsByToolUseId = new Map<string, { fragment: TimelineToolResultFragment; index: number }>()

  for (let index = 0; index < item.fragments.length; index += 1) {
    const fragment = item.fragments[index]
    if (fragment?.type !== 'tool_result') continue
    if (!fragment.toolUseId) continue
    toolResultsByToolUseId.set(fragment.toolUseId, { fragment, index })
  }

  const consumedToolResultIndexes = new Set<number>()

  for (let index = 0; index < item.fragments.length; index += 1) {
    const fragment = item.fragments[index]
    if (!fragment) continue

    if (fragment.type === 'thinking') {
      entries.push({
        key: `${item.key}-thinking-${index}`,
        kind: 'thinking',
        title: '思考中',
        summary: fragment.redacted ? 'redacted' : compactString(fragment.text || ''),
        content: fragment.redacted ? 'redacted thinking' : (fragment.text || ''),
        redacted: fragment.redacted,
      })
      continue
    }

    if (fragment.type === 'text') {
      entries.push({
        key: `${item.key}-text-${index}`,
        kind: 'text',
        fragment,
      })
      continue
    }

    if (fragment.type === 'tool_use') {
      const lookup = fragment.toolUseId
        ? toolResultsByToolUseId.get(fragment.toolUseId)
        : undefined
      const toolResult = lookup?.fragment ?? null
      if (lookup) consumedToolResultIndexes.add(lookup.index)
      entries.push(buildToolEntry(item.key, index, fragment, toolResult))
      continue
    }

    if (fragment.type === 'tool_result') {
      if (consumedToolResultIndexes.has(index)) continue
      entries.push({
        key: `${item.key}-result-${index}`,
        kind: 'tool',
        title: 'ToolResult',
        summary: compactString(stringifyStructuredValue(fragment.output)),
        result: fragment,
      })
    }
  }

  const groupedEntries: AssistantDetailEntry[] = []
  let pendingTools: AssistantToolEntry[] = []

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return
    if (pendingTools.length === 1) {
      groupedEntries.push(pendingTools[0])
    } else {
      groupedEntries.push({
        key: `${pendingTools[0].key}-group`,
        kind: 'tool_group',
        summary: buildToolGroupSummary(pendingTools),
        entries: [...pendingTools],
      })
    }
    pendingTools = []
  }

  for (const entry of entries) {
    if (isToolEntry(entry)) {
      pendingTools.push(entry)
      continue
    }
    flushPendingTools()
    groupedEntries.push(entry)
  }
  flushPendingTools()

  return groupedEntries
}
