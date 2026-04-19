<script setup lang="ts">
import { computed } from 'vue'
import TimelineAssistantDetailRow from './TimelineAssistantDetailRow.vue'
import TimelineAgentRow from './TimelineAgentRow.vue'
import TimelineAskUserQuestionRow from './TimelineAskUserQuestionRow.vue'
import TimelineBashToolRow from './TimelineBashToolRow.vue'
import TimelineEditToolRow from './TimelineEditToolRow.vue'
import TimelineEnterPlanModeRow from './TimelineEnterPlanModeRow.vue'
import TimelineExitPlanModeRow from './TimelineExitPlanModeRow.vue'
import TimelineReadToolRow from './TimelineReadToolRow.vue'
import TimelineSkillRow from './TimelineSkillRow.vue'
import TimelineTaskCreateRow from './TimelineTaskCreateRow.vue'
import TimelineTaskUpdateRow from './TimelineTaskUpdateRow.vue'
import TimelineWebFetchRow from './TimelineWebFetchRow.vue'
import TimelineWebSearchRow from './TimelineWebSearchRow.vue'
import TimelineThinkingRow from './TimelineThinkingRow.vue'
import TimelineWriteToolRow from './TimelineWriteToolRow.vue'
import TimelineAssistantFooterLine from './TimelineAssistantFooterLine.vue'
import TimelineAssistantSummaryBlock from './TimelineAssistantSummaryBlock.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import type {
  AssistantDisplayItem,
  DisplayFragmentThinking,
  DisplayFragmentSummary,
  DisplayFragmentText,
  DisplayFragmentToolResult,
  DisplayFragmentToolUse,
  TimelineLivePreviewItem,
} from '../../../runtime/protocol/message-types.js'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

const props = withDefaults(defineProps<{
  item: AssistantDisplayItem
  hideFooter?: boolean
}>(), {
  hideFooter: false,
})

const allOverlays = computed(() => props.item.overlays || [])
const detailOverlays = computed(() =>
  allOverlays.value.filter((overlay) => overlay.overlayKind !== 'streaming_text')
)
const finalOverlays = computed(() =>
  allOverlays.value.filter((overlay) => overlay.overlayKind === 'streaming_text')
)

const hasFinalOverlay = computed(() => finalOverlays.value.length > 0)
type DetailEntry =
  | {
      key: string
      kind: 'thinking'
      icon: string
      title: string
      summary: string
      content: string
      contentMode: 'markdown'
      redacted?: boolean
    }
  | {
      key: string
      kind: 'text'
      fragment: DisplayFragmentText
    }
  | {
      key: string
      kind: 'summary_block'
      fragment: DisplayFragmentSummary
    }
  | {
      key: string
      kind: 'tool' | 'agent' | 'taskcreate' | 'taskupdate' | 'bash' | 'read' | 'glob' | 'grep' | 'edit' | 'skill' | 'write' | 'websearch' | 'webfetch' | 'askuserquestion' | 'enterplanmode' | 'exitplanmode'
      icon: string
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
      outputValue?: unknown
    }

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

function getToolKind(fragment: DisplayFragmentToolUse): 'agent' | 'taskcreate' | 'taskupdate' | 'tool' {
  const normalizedName = (fragment.name || '').toLowerCase()
  const input = fragment.input && typeof fragment.input === 'object'
    ? fragment.input as Record<string, unknown>
    : null

  if (normalizedName.includes('taskupdate') || normalizedName.includes('task_update')) {
    return 'taskupdate'
  }
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
  if (kind === 'taskupdate') return 'TaskUpdate'
  if (kind === 'taskcreate') return 'TaskCreate'
  return fragment.name || 'Tool'
}

function getToolIcon(kind: 'agent' | 'taskcreate' | 'taskupdate' | 'tool'): string {
  if (kind === 'agent') return '🤖'
  if (kind === 'taskupdate') return '📋'
  if (kind === 'taskcreate') return '📝'
  return '🔧'
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
  const hiddenKeys = new Set(kind === 'taskcreate' || kind === 'taskupdate' ? ['description'] : [])

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

function getWebSearchQuery(input: unknown): string {
  return getStringField(input, 'query')
}

function getWebFetchUrl(input: unknown): string {
  return getStringField(input, 'url')
}

function getAskUserQuestionSubtitle(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return ''
  return questions
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const header = typeof item.header === 'string' ? item.header.trim() : ''
      const question = typeof item.question === 'string' ? item.question.trim() : ''
      if (header && question) return `${header}（${question}）`
      return header || question
    })
    .filter(Boolean)
    .join(' · ')
}

function getExitPlanModePlanFilePath(input: unknown): string {
  return getStringField(input, 'planFilePath') || getStringField(input, 'plan_file_path')
}

function getNestedString(value: unknown, path: string[]): string {
  let current: unknown = value
  for (const segment of path) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : ''
}

function getTaskIdFromResultPayload(value: unknown): string {
  return getNestedString(value, ['toolUseResult', 'taskId'])
    || getNestedString(value, ['tool_use_result', 'task_id'])
    || getNestedString(value, ['toolUseResult', 'task', 'id'])
}

function getTaskIdFromResultMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null
  const content = Array.isArray(message?.content) ? message.content : []

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockRecord = block as Record<string, unknown>
    if (blockRecord.type !== 'tool_result') continue
    const text = typeof blockRecord.content === 'string' ? blockRecord.content : ''
    const match = text.match(/\btask\s*#\s*(\d+)\b/i)
    if (match?.[1]) return match[1]
  }

  return ''
}

function buildTaskCreateSubtitle(input: unknown, output: unknown): string {
  const taskId = getTaskIdFromResultPayload(output)
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const idPart = taskId ? `[#${taskId} 待创建]` : ''
  const subjectPart = subject || ''
  const descriptionPart = description ? `(${description})` : ''
  return [idPart, `${subjectPart}${descriptionPart}`.trim()].filter(Boolean).join(' ')
}

function buildTaskCreateSubtitleFromResult(
  input: unknown,
  result: DisplayFragmentToolResult | null,
): string {
  const taskIdFromRaw = getTaskIdFromResultPayload(result?.raw)
  const taskIdFromOutput = getTaskIdFromResultPayload(result?.output)
  const taskIdFromMessage = getTaskIdFromResultMessage(result?.raw) || getTaskIdFromResultMessage(result?.output)
  const taskIdFromText = (() => {
    const rawRecord = result?.raw && typeof result.raw === 'object' ? result.raw as Record<string, unknown> : null
    const candidates: Array<unknown> = [
      rawRecord?.content,
      rawRecord?.output,
      result?.output,
    ]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      // Matches "Task #18 ..." and also tolerates "Task#18".
      const match = candidate.match(/\bTask\s*#\s*(\d+)\b/i)
      if (match?.[1]) return match[1]
    }
    return ''
  })()
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const taskId = taskIdFromRaw || taskIdFromOutput || taskIdFromMessage || taskIdFromText
  const idPart = taskId ? `[#${taskId} 待创建]` : ''
  const subjectPart = subject || ''
  const descriptionPart = description ? `(${description})` : ''
  return [idPart, `${subjectPart}${descriptionPart}`.trim()].filter(Boolean).join(' ')
}

function getTaskStatusLabel(status: string): string {
  if (status === 'in_progress') return '进行中'
  if (status === 'completed') return '已完成'
  return status
}

function buildTaskUpdateSubtitle(input: unknown, _output: unknown): string {
  const taskId = getStringField(input, 'taskId')
  const status = getStringField(input, 'status')
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const statusLabel = getTaskStatusLabel(status)
  const idPart = taskId && statusLabel ? `[#${taskId} ${statusLabel}]` : taskId ? `[#${taskId}]` : ''
  const subjectPart = subject || ''
  const descriptionPart = description ? `(${description})` : ''
  return [idPart, `${subjectPart}${descriptionPart}`.trim()].filter(Boolean).join(' ')
}

function buildTaskUpdateSubtitleFromResult(
  input: unknown,
  _result: DisplayFragmentToolResult | null,
): string {
  const taskId = getStringField(input, 'taskId')
  const status = getStringField(input, 'status')
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const statusLabel = getTaskStatusLabel(status)
  const idPart = taskId && statusLabel ? `[#${taskId} ${statusLabel}]` : taskId ? `[#${taskId}]` : ''
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
        const b = block as Record<string, unknown>
        if (typeof b.text === 'string') return b.text
        if (typeof b.content === 'string') return b.content
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }

  return stringifyStructuredValue(output)
}

function buildOverlayDetailEntries(overlay: TimelineLivePreviewItem): DetailEntry[] {
  return overlay.preview.blocks.map((block, index) => {
    if (block.kind === 'thinking') {
      return {
        key: `${overlay.id}-thinking-${index}`,
        kind: 'thinking',
        icon: '🧠',
        title: '思考中',
        summary: block.redacted ? 'redacted' : compactString(block.shownText || ''),
        content: block.redacted ? 'redacted thinking' : (block.shownText || ''),
        contentMode: 'markdown' as const,
        redacted: block.redacted,
      }
    }

    if (block.kind === 'tool_use') {
      const syntheticToolUse: DisplayFragmentToolUse = {
        type: 'tool_use',
        name: block.name,
        toolUseId: block.toolUseId,
        input: block.shownInput,
      }
      const toolKind = getToolKind(syntheticToolUse)
      if (syntheticToolUse.name === 'Bash') {
        const command = getStringField(syntheticToolUse.input, 'command')
        const description = getStringField(syntheticToolUse.input, 'description')
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'bash',
          icon: '🖥',
          title: 'Bash',
          summary: '',
          result: null,
          command,
          description,
          resultContent: '',
        }
      }
      if (syntheticToolUse.name === 'Read') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'read',
          icon: '📖',
          title: 'Read',
          summary: '',
          result: null,
          filePath: getStringField(syntheticToolUse.input, 'file_path'),
        }
      }
      if (syntheticToolUse.name === 'Glob') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'glob',
          icon: '🔎',
          title: 'Glob',
          summary: '',
          result: null,
          filePath: buildGlobSubtitle(syntheticToolUse.input),
        }
      }
      if (syntheticToolUse.name === 'Grep') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'grep',
          icon: '🧭',
          title: 'Grep',
          summary: '',
          result: null,
          filePath: buildGlobSubtitle(syntheticToolUse.input),
        }
      }
      if (syntheticToolUse.name === 'Edit') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'edit',
          icon: '📝',
          title: 'Edit',
          summary: '',
          result: null,
          filePath: getStringField(syntheticToolUse.input, 'file_path'),
          input: syntheticToolUse.input,
        }
      }
      if (syntheticToolUse.name === 'Skill') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'skill',
          icon: '🔧',
          title: 'Skill',
          summary: '',
          result: null,
          subtitle: getSkillSubtitle(syntheticToolUse.input),
          args: getSkillArgs(syntheticToolUse.input),
        }
      }
      if (syntheticToolUse.name === 'WebSearch') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'websearch',
          icon: '🔍',
          title: 'WebSearch',
          summary: '',
          result: null,
          subtitle: getWebSearchQuery(syntheticToolUse.input),
          input: syntheticToolUse.input,
        }
      }
      if (syntheticToolUse.name === 'WebFetch') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'webfetch',
          icon: '🔎',
          title: 'WebFetch',
          summary: '',
          result: null,
          subtitle: getWebFetchUrl(syntheticToolUse.input),
          input: syntheticToolUse.input,
        }
      }
      if (syntheticToolUse.name === 'EnterPlanMode') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'enterplanmode',
          icon: '🗺️',
          title: 'EnterPlanMode',
          summary: '',
          result: null,
        }
      }
      if (syntheticToolUse.name === 'ExitPlanMode') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'exitplanmode',
          icon: '🗺️',
          title: 'ExitPlanMode',
          summary: '',
          result: null,
          subtitle: getExitPlanModePlanFilePath(syntheticToolUse.input),
          input: syntheticToolUse.input,
        }
      }
      if (syntheticToolUse.name === 'AskUserQuestion') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'askuserquestion',
          icon: '❓',
          title: 'AskUserQuestion',
          summary: '',
          result: null,
          subtitle: getAskUserQuestionSubtitle(syntheticToolUse.input),
          input: syntheticToolUse.input,
        }
      }
      if (toolKind === 'taskcreate') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'taskcreate',
          icon: '📋',
          title: 'TaskCreate',
          summary: '',
          result: null,
          subtitle: buildTaskCreateSubtitle(syntheticToolUse.input, undefined),
        }
      }
      if (toolKind === 'taskupdate') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'taskupdate',
          icon: '📋',
          title: 'TaskUpdate',
          summary: '',
          result: null,
          subtitle: buildTaskUpdateSubtitle(syntheticToolUse.input, undefined),
        }
      }
      if (syntheticToolUse.name === 'Write') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'write',
          icon: '🖨️',
          title: 'Write',
          summary: '',
          result: null,
          filePath: getStringField(syntheticToolUse.input, 'file_path'),
          contentValue: (syntheticToolUse.input && typeof syntheticToolUse.input === 'object')
            ? (syntheticToolUse.input as Record<string, unknown>).content
            : undefined,
        }
      }
      if (toolKind === 'agent') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'agent',
          icon: '🤖',
          title: 'Agent',
          summary: '',
          result: null,
          subtitle: buildAgentSubtitle(syntheticToolUse.input),
          prompt: getAgentPrompt(syntheticToolUse.input),
        }
      }
      return {
        key: `${overlay.id}-tool-${index}`,
        kind: toolKind,
        icon: getToolIcon(toolKind),
        title: getToolTitle(syntheticToolUse),
        summary: getToolSummary(syntheticToolUse),
        result: null,
      }
    }

    return {
      key: `${overlay.id}-thinking-fallback-${index}`,
      kind: 'thinking',
      icon: '🧠',
      title: '处理中',
      summary: compactString(block.shownText || ''),
      content: block.shownText || '',
      contentMode: 'markdown' as const,
    }
  })
}

const contentEntries = computed<DetailEntry[]>(() => {
  const entries: DetailEntry[] = []

  for (const overlay of detailOverlays.value) {
    entries.push(...buildOverlayDetailEntries(overlay))
  }

  // Tool results are appended after all primary fragments in the display layer,
  // so they are not guaranteed to be adjacent to their tool_use fragment.
  const toolResultsByToolUseId = new Map<string, { fragment: DisplayFragmentToolResult; index: number }>()
  for (let i = 0; i < props.item.fragments.length; i += 1) {
    const frag = props.item.fragments[i]!
    if (frag.type !== 'tool_result') continue
    const toolUseId = (frag as DisplayFragmentToolResult).toolUseId
    if (!toolUseId) continue
    toolResultsByToolUseId.set(toolUseId, { fragment: frag as DisplayFragmentToolResult, index: i })
  }
  const consumedToolResultIndexes = new Set<number>()

  for (let index = 0; index < props.item.fragments.length; index += 1) {
    const fragment = props.item.fragments[index]!

    if (fragment.type === 'thinking') {
      const thinkingFragment = fragment as DisplayFragmentThinking
      entries.push({
        key: `${props.item.key}-thinking-${index}`,
        kind: 'thinking',
        icon: '🧠',
        title: '思考中',
        summary: thinkingFragment.redacted ? 'redacted' : compactString(thinkingFragment.text || ''),
        content: thinkingFragment.redacted ? 'redacted thinking' : (thinkingFragment.text || ''),
        contentMode: 'markdown',
        redacted: thinkingFragment.redacted,
      })
      continue
    }

    if (fragment.type === 'text') {
      entries.push({
        key: `${props.item.key}-text-${index}`,
        kind: 'text',
        fragment: fragment as DisplayFragmentText,
      })
      continue
    }

    if (fragment.type === 'summary') {
      entries.push({
        key: `${props.item.key}-summary-${index}`,
        kind: 'summary_block',
        fragment: fragment as DisplayFragmentSummary,
      })
      continue
    }

    if (fragment.type === 'tool_use') {
      const toolUseFragment = fragment as DisplayFragmentToolUse
      const lookup = toolUseFragment.toolUseId
        ? toolResultsByToolUseId.get(toolUseFragment.toolUseId)
        : undefined
      const toolResult = lookup?.fragment ?? null
      if (lookup) consumedToolResultIndexes.add(lookup.index)
      if (toolUseFragment.name === 'Bash') {
        const command = getStringField(toolUseFragment.input, 'command')
        const description = getStringField(toolUseFragment.input, 'description')
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'bash',
          icon: '🖥',
          title: 'Bash',
          summary: '',
          result: toolResult,
          command,
          description,
          resultContent: extractBashResultContent(toolResult?.output),
        })
        continue
      }
      if (toolUseFragment.name === 'Read') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'read',
          icon: '📖',
          title: 'Read',
          summary: '',
          result: toolResult,
          filePath: getStringField(toolUseFragment.input, 'file_path'),
        })
        continue
      }
      if (toolUseFragment.name === 'Glob') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'glob',
          icon: '🔎',
          title: 'Glob',
          summary: '',
          result: toolResult,
          filePath: buildGlobSubtitle(toolUseFragment.input),
        })
        continue
      }
      if (toolUseFragment.name === 'Grep') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'grep',
          icon: '🧭',
          title: 'Grep',
          summary: '',
          result: toolResult,
          filePath: buildGlobSubtitle(toolUseFragment.input),
        })
        continue
      }
      if (toolUseFragment.name === 'Edit') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'edit',
          icon: '📝',
          title: 'Edit',
          summary: '',
          result: toolResult,
          filePath: getStringField(toolUseFragment.input, 'file_path'),
          input: toolUseFragment.input,
        })
        continue
      }
      if (toolUseFragment.name === 'Skill') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'skill',
          icon: '🔧',
          title: 'Skill',
          summary: '',
          result: toolResult,
          subtitle: getSkillSubtitle(toolUseFragment.input),
          args: getSkillArgs(toolUseFragment.input),
        })
        continue
      }
      if (toolUseFragment.name === 'WebSearch') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'websearch',
          icon: '🔍',
          title: 'WebSearch',
          summary: '',
          result: toolResult,
          subtitle: getWebSearchQuery(toolUseFragment.input),
          input: toolUseFragment.input,
          outputValue: toolResult?.output,
        })
        continue
      }
      if (toolUseFragment.name === 'WebFetch') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'webfetch',
          icon: '🔎',
          title: 'WebFetch',
          summary: '',
          result: toolResult,
          subtitle: getWebFetchUrl(toolUseFragment.input),
          input: toolUseFragment.input,
          outputValue: toolResult?.output,
        })
        continue
      }
      if (toolUseFragment.name === 'EnterPlanMode') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'enterplanmode',
          icon: '🗺️',
          title: 'EnterPlanMode',
          summary: '',
          result: toolResult,
          outputValue: toolResult?.output,
        })
        continue
      }
      if (toolUseFragment.name === 'ExitPlanMode') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'exitplanmode',
          icon: '🗺️',
          title: 'ExitPlanMode',
          summary: '',
          result: toolResult,
          subtitle: getExitPlanModePlanFilePath(toolUseFragment.input),
          input: toolUseFragment.input,
        })
        continue
      }
      if (toolUseFragment.name === 'AskUserQuestion') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'askuserquestion',
          icon: '❓',
          title: 'AskUserQuestion',
          summary: '',
          result: toolResult,
          subtitle: getAskUserQuestionSubtitle(toolUseFragment.input),
          input: toolUseFragment.input,
          outputValue: toolResult?.output,
        })
        continue
      }
      if (getToolKind(toolUseFragment) === 'taskcreate') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'taskcreate',
          icon: '📋',
          title: 'TaskCreate',
          summary: '',
          result: toolResult,
          subtitle: buildTaskCreateSubtitleFromResult(toolUseFragment.input, toolResult),
        })
        continue
      }
      if (getToolKind(toolUseFragment) === 'taskupdate') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'taskupdate',
          icon: '📋',
          title: 'TaskUpdate',
          summary: '',
          result: toolResult,
          subtitle: buildTaskUpdateSubtitleFromResult(toolUseFragment.input, toolResult),
        })
        continue
      }
      if (toolUseFragment.name === 'Write') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'write',
          icon: '🖨️',
          title: 'Write',
          summary: '',
          result: toolResult,
          filePath: getStringField(toolUseFragment.input, 'file_path'),
          contentValue: (toolUseFragment.input && typeof toolUseFragment.input === 'object')
            ? (toolUseFragment.input as Record<string, unknown>).content
            : undefined,
        })
        continue
      }
      if (getToolKind(toolUseFragment) === 'agent') {
        entries.push({
          key: `${props.item.key}-tool-${index}`,
          kind: 'agent',
          icon: '🤖',
          title: 'Agent',
          summary: '',
          result: toolResult,
          subtitle: buildAgentSubtitle(toolUseFragment.input),
          prompt: getAgentPrompt(toolUseFragment.input),
        })
        continue
      }
      const toolKind = getToolKind(toolUseFragment)
      entries.push({
        key: `${props.item.key}-tool-${index}`,
        kind: toolKind,
        icon: getToolIcon(toolKind),
        title: getToolTitle(toolUseFragment),
        summary: getToolSummary(toolUseFragment),
        result: toolResult,
      })
      continue
    }

    if (fragment.type === 'tool_result') {
      if (consumedToolResultIndexes.has(index)) continue
      entries.push({
        key: `${props.item.key}-result-${index}`,
        kind: 'tool',
        icon: '🔧',
        title: 'ToolResult',
        summary: compactString(stringifyStructuredValue(fragment.output)),
        result: fragment,
      })
    }
  }

  return entries
})

const hasAnyContent = computed(() => contentEntries.value.length > 0)

</script>

<template>
  <div class="space-y-3">
    <div v-if="hasAnyContent" class="space-y-3">
      <template v-for="entry in contentEntries" :key="entry.key">
        <div class="space-y-1">
          <TimelineThinkingRow
            v-if="entry.kind === 'thinking'"
            :text="entry.content"
            :redacted="Boolean(entry.redacted)"
          />
          <TimelineAssistantTextBlock
            v-else-if="entry.kind === 'text'"
            :fragment="entry.fragment"
          />
          <TimelineAssistantSummaryBlock
            v-else-if="entry.kind === 'summary_block'"
            :fragment="entry.fragment"
          />
          <TimelineBashToolRow
            v-else-if="entry.kind === 'bash'"
            tool-name="Bash"
            :description="entry.description"
            :command="entry.command || ''"
            :result-content="entry.resultContent || ''"
          />
          <TimelineAgentRow
            v-else-if="entry.kind === 'agent'"
            :subtitle="entry.subtitle"
            :prompt="entry.prompt"
            :result-text="entry.result ? stringifyStructuredValue(entry.result.output) : ''"
          />
          <TimelineReadToolRow
            v-else-if="entry.kind === 'read'"
            :file-path="entry.filePath"
          >
            <div
              v-if="entry.result"
              class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
            >{{ stringifyStructuredValue(entry.result.output) }}</div>
          </TimelineReadToolRow>
          <TimelineReadToolRow
            v-else-if="entry.kind === 'glob'"
            icon="🔎"
            title="Glob"
            :file-path="entry.filePath"
          >
            <div
              v-if="entry.result"
              class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
            >{{ stringifyStructuredValue(entry.result.output) }}</div>
          </TimelineReadToolRow>
          <TimelineReadToolRow
            v-else-if="entry.kind === 'grep'"
            icon="🧭"
            title="Grep"
            :file-path="entry.filePath"
          >
            <div
              v-if="entry.result"
              class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
            >{{ stringifyStructuredValue(entry.result.output) }}</div>
          </TimelineReadToolRow>
          <TimelineEditToolRow
            v-else-if="entry.kind === 'edit'"
            :file-path="entry.filePath"
            :input="entry.input"
          />
          <TimelineSkillRow
            v-else-if="entry.kind === 'skill'"
            :subtitle="entry.subtitle"
            :args="entry.args"
          />
          <TimelineWebSearchRow
            v-else-if="entry.kind === 'websearch'"
            :query="entry.subtitle"
            :input="entry.input"
            :output="entry.outputValue"
            :raw="entry.result?.raw"
          />
          <TimelineWebFetchRow
            v-else-if="entry.kind === 'webfetch'"
            :url="entry.subtitle"
            :input="entry.input"
            :output="entry.outputValue"
            :raw="entry.result?.raw"
          />
          <TimelineEnterPlanModeRow
            v-else-if="entry.kind === 'enterplanmode'"
            :output="entry.outputValue"
            :raw="entry.result?.raw"
          />
          <TimelineExitPlanModeRow
            v-else-if="entry.kind === 'exitplanmode'"
            :plan-file-path="entry.subtitle"
            :input="entry.input"
          />
          <TimelineAskUserQuestionRow
            v-else-if="entry.kind === 'askuserquestion'"
            :subtitle="entry.subtitle"
            :input="entry.input"
            :output="entry.outputValue"
            :raw="entry.result?.raw"
          />
          <TimelineTaskCreateRow
            v-else-if="entry.kind === 'taskcreate'"
            :subtitle="entry.subtitle"
            :raw="entry.result?.raw"
            :output="entry.result?.output"
            debug
          />
          <TimelineTaskUpdateRow
            v-else-if="entry.kind === 'taskupdate'"
            :subtitle="entry.subtitle"
          />
          <TimelineWriteToolRow
            v-else-if="entry.kind === 'write'"
            :file-path="entry.filePath"
            :content="entry.contentValue"
          />
          <TimelineAssistantDetailRow
            v-else
            :icon="entry.icon"
            :title="entry.title"
            :summary="entry.summary"
            :content="''"
            content-mode="plain"
          >
            <TimelineAssistantToolResultBlock
              v-if="entry.kind === 'tool' && entry.result"
              :fragment="entry.result"
              :expanded="true"
              :show-inline-more="false"
              :framed="false"
            />
          </TimelineAssistantDetailRow>

        </div>
      </template>
    </div>

    <div v-if="!hasAnyContent && hasFinalOverlay" class="space-y-2">
      <TimelineLivePreviewCard
        v-for="overlay in finalOverlays"
        :key="`${item.key}-final-overlay-${overlay.id}`"
        :item="overlay"
        compact
      />
    </div>

    <div v-if="!hasAnyContent && !hasFinalOverlay" class="text-[13px] leading-6 text-slate-400">
      (no final output yet)
    </div>

    <TimelineAssistantFooterLine :message="item.anchorMessage" :footer="item.footer" />
  </div>
</template>
