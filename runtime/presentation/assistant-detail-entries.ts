import type {
  AssistantDisplayItem,
  DisplayFragmentText,
  DisplayFragmentToolResult,
  DisplayFragmentToolUse,
} from '../protocol/message-types.js'
import { stringifyStructuredValue } from '../protocol/transcript-normalizer.js'
import { THINKING_ROW_TITLE } from './assistant-row-semantics.js'

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
  fragment: DisplayFragmentText
}

export type AssistantToolEntry = {
  key: string
  kind: AssistantToolEntryKind
  title: string
  summary: string
  result: DisplayFragmentToolResult | null
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

export type AssistantGroupChildEntry =
  | AssistantThinkingEntry
  | AssistantToolEntry

export type AssistantToolGroupEntry = {
  key: string
  kind: 'tool_group'
  summary: string
  entries: AssistantGroupChildEntry[]
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

function getToolKind(fragment: DisplayFragmentToolUse): 'agent' | 'taskcreate' | 'tool' {
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

function getToolTitle(fragment: DisplayFragmentToolUse): string {
  const kind = getToolKind(fragment)
  if (kind === 'agent') return 'Agent'
  if (kind === 'taskcreate') return 'TaskCreate'
  return fragment.name || 'Tool'
}

function getToolSummary(fragment: DisplayFragmentToolUse): string {
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
  if (subagentType && description) return `${subagentType} ${description}`
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

function getTaskCreateMetadata(
  input: unknown,
  result: DisplayFragmentToolResult | null,
): { taskId: string; subject: string } {
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
  const taskId = taskIdFromRaw || taskIdFromOutput || taskIdFromText
  return { taskId, subject }
}

function buildTaskCreateSubtitleFromResult(
  input: unknown,
  result: DisplayFragmentToolResult | null,
): string {
  const subject = getTaskCreateMetadata(input, result).subject || getStringField(input, 'subject')
  return subject ? `待执行：${subject}` : ''
}

function buildTaskUpdateSubtitle(
  input: unknown,
  taskSubjectsById: Map<string, string>,
): string {
  const taskId = getStringField(input, 'taskId')
  const status = getStringField(input, 'status')
  const subject = taskSubjectsById.get(taskId) || getStringField(input, 'subject')

  const statusLabelMap: Record<string, string> = {
    in_progress: '执行中',
    running: '执行中',
    active: '执行中',
    completed: '已完成',
    done: '已完成',
    success: '已完成',
  }
  const statusLabel = statusLabelMap[status] || status
  const prefix = taskId ? `#${taskId}` : ''
  const suffix = [statusLabel, subject ? `：${subject}` : ''].join('')
  return [prefix, suffix].filter(Boolean).join(' ')
}

function buildTaskGetSubtitle(input: unknown): string {
  const taskId = getStringField(input, 'taskId')
  return taskId ? `#${taskId}` : ''
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

function isThinkingEntry(entry: AssistantDetailEntry): entry is AssistantThinkingEntry {
  return entry.kind === 'thinking'
}

function isGroupableEntry(entry: AssistantDetailEntry): entry is AssistantGroupChildEntry {
  return isThinkingEntry(entry) || isToolEntry(entry)
}

export function buildToolGroupSummary(entries: AssistantGroupChildEntry[]): string {
  const thinkingCount = entries.filter((entry) => entry.kind === 'thinking').length
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'thinking') continue
    const title = entry.title
    if (!counts.has(title)) order.push(title)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const toolSummary = order.map((title) => `${title} ${counts.get(title) ?? 0} 次`).join('、')
  if (thinkingCount > 0 && toolSummary) return `思考 ${thinkingCount} 次并调用工具 ${toolSummary}`
  if (thinkingCount > 0) return `思考 ${thinkingCount} 次`
  return `调用工具 ${toolSummary}`
}

function buildToolEntry(
  itemKey: string,
  index: number,
  fragment: DisplayFragmentToolUse,
  result: DisplayFragmentToolResult | null,
  taskSubjectsById: Map<string, string>,
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
      input: fragment.input,
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
      input: fragment.input,
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
      input: fragment.input,
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
      input: fragment.input,
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

  if (fragment.name === 'TaskUpdate') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'tool',
      title: 'TaskUpdate',
      summary: '',
      result,
      input: fragment.input,
      subtitle: buildTaskUpdateSubtitle(fragment.input, taskSubjectsById),
    }
  }

  if (fragment.name === 'TaskGet') {
    return {
      key: `${itemKey}-tool-${index}`,
      kind: 'tool',
      title: 'TaskGet',
      summary: '',
      result,
      input: fragment.input,
      subtitle: buildTaskGetSubtitle(fragment.input),
    }
  }

  const toolKind = getToolKind(fragment)
  return {
    key: `${itemKey}-tool-${index}`,
    kind: toolKind,
    title: getToolTitle(fragment),
    summary: getToolSummary(fragment),
    result,
    input: fragment.input,
  }
}

export function buildAssistantDetailEntries(item: AssistantDisplayItem): AssistantDetailEntry[] {
  const entries: AssistantDetailEntry[] = []
  const toolResultsByToolUseId = new Map<string, Array<{ fragment: DisplayFragmentToolResult; index: number }>>()

  for (let index = 0; index < item.fragments.length; index += 1) {
    const fragment = item.fragments[index]
    if (fragment?.type !== 'tool_result') continue
    if (!fragment.toolUseId) continue
    const existing = toolResultsByToolUseId.get(fragment.toolUseId) ?? []
    existing.push({ fragment, index })
    toolResultsByToolUseId.set(fragment.toolUseId, existing)
  }

  const taskSubjectsById = new Map<string, string>()
  for (const fragment of item.fragments) {
    if (fragment?.type !== 'tool_use') continue
    if (getToolKind(fragment) !== 'taskcreate') continue
    const lookups = fragment.toolUseId
      ? toolResultsByToolUseId.get(fragment.toolUseId)
      : undefined
    const matchedResult = lookups?.[0]?.fragment ?? null
    const metadata = getTaskCreateMetadata(fragment.input, matchedResult)
    if (metadata.taskId && metadata.subject) {
      taskSubjectsById.set(metadata.taskId, metadata.subject)
    }
  }

  const consumedToolResultIndexes = new Set<number>()

  for (let index = 0; index < item.fragments.length; index += 1) {
    const fragment = item.fragments[index]
    if (!fragment) continue

    if (fragment.type === 'thinking') {
      entries.push({
        key: `${item.key}-thinking-${index}`,
        kind: 'thinking',
        title: THINKING_ROW_TITLE,
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
      const lookups = fragment.toolUseId
        ? toolResultsByToolUseId.get(fragment.toolUseId)
        : undefined
      const lookup = lookups?.find((candidate) => !consumedToolResultIndexes.has(candidate.index))
      const toolResult = lookup?.fragment ?? null
      if (lookup) consumedToolResultIndexes.add(lookup.index)
      entries.push(buildToolEntry(item.key, index, fragment, toolResult, taskSubjectsById))
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
  let pendingGroupEntries: AssistantGroupChildEntry[] = []

  const flushPendingGroupEntries = () => {
    if (pendingGroupEntries.length === 0) return
    const toolCount = pendingGroupEntries.filter((entry) => entry.kind !== 'thinking').length
    if (toolCount === 0) {
      groupedEntries.push(...pendingGroupEntries)
    } else if (pendingGroupEntries.length === 1) {
      groupedEntries.push(pendingGroupEntries[0])
    } else {
      groupedEntries.push({
        key: `${pendingGroupEntries[0].key}-group`,
        kind: 'tool_group',
        summary: buildToolGroupSummary(pendingGroupEntries),
        entries: [...pendingGroupEntries],
      })
    }
    pendingGroupEntries = []
  }

  for (const entry of entries) {
    if (isGroupableEntry(entry)) {
      pendingGroupEntries.push(entry)
      continue
    }
    flushPendingGroupEntries()
    groupedEntries.push(entry)
  }
  flushPendingGroupEntries()

  return groupedEntries
}
