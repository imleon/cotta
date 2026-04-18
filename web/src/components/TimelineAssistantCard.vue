<script setup lang="ts">
import { computed } from 'vue'
import TimelineAssistantDetailRow from './TimelineAssistantDetailRow.vue'
import TimelineAgentRow from './TimelineAgentRow.vue'
import TimelineBashToolRow from './TimelineBashToolRow.vue'
import TimelineEditToolRow from './TimelineEditToolRow.vue'
import TimelineReadToolRow from './TimelineReadToolRow.vue'
import TimelineSkillRow from './TimelineSkillRow.vue'
import TimelineTaskCreateRow from './TimelineTaskCreateRow.vue'
import TimelineThinkingRow from './TimelineThinkingRow.vue'
import TimelineWriteToolRow from './TimelineWriteToolRow.vue'
import TimelineAssistantFooterLine from './TimelineAssistantFooterLine.vue'
import TimelineAssistantSummaryBlock from './TimelineAssistantSummaryBlock.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import type {
  AssistantDisplayItem,
  DisplayFragmentThinking,
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

const detailFragments = computed(() =>
  props.item.fragments.filter((fragment) =>
    fragment.type === 'thinking' || fragment.type === 'tool_use' || fragment.type === 'tool_result'
  )
)

const finalFragments = computed(() => {
  const summaries = props.item.fragments.filter((fragment) => fragment.type === 'summary')
  const texts = props.item.fragments.filter((fragment) => fragment.type === 'text')
  return [...summaries, ...texts]
})

const hasFinalFragments = computed(() => finalFragments.value.length > 0)
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
      kind: 'tool' | 'agent' | 'taskcreate' | 'bash' | 'read' | 'glob' | 'grep' | 'edit' | 'skill' | 'write'
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

function getToolIcon(kind: 'agent' | 'taskcreate' | 'tool'): string {
  if (kind === 'agent') return '🤖'
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

function buildTaskCreateSubtitle(input: unknown, output: unknown): string {
  const taskId = getNestedString(output, ['toolUseResult', 'task', 'id'])
  const subject = getStringField(input, 'subject')
  const description = getStringField(input, 'description')
  const idPart = taskId ? `[#${taskId}]` : ''
  const subjectPart = subject || ''
  const descriptionPart = description ? `(${description})` : ''
  return [idPart, `${subjectPart}${descriptionPart}`.trim()].filter(Boolean).join(' ')
}

function buildTaskCreateSubtitleFromResult(
  input: unknown,
  result: DisplayFragmentToolResult | null,
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
      // Matches "Task #18 ..." and also tolerates "Task#18".
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

const detailEntries = computed<DetailEntry[]>(() => {
  const entries: DetailEntry[] = []

  for (const overlay of detailOverlays.value) {
    entries.push(...buildOverlayDetailEntries(overlay))
  }

  // Tool results are appended after all primary fragments in the display layer,
  // so they are not guaranteed to be adjacent to their tool_use fragment.
  const toolResultsByToolUseId = new Map<string, { fragment: DisplayFragmentToolResult; index: number }>()
  for (let i = 0; i < detailFragments.value.length; i += 1) {
    const frag = detailFragments.value[i]!
    if (frag.type !== 'tool_result') continue
    const toolUseId = (frag as DisplayFragmentToolResult).toolUseId
    if (!toolUseId) continue
    toolResultsByToolUseId.set(toolUseId, { fragment: frag as DisplayFragmentToolResult, index: i })
  }
  const consumedToolResultIndexes = new Set<number>()

  for (let index = 0; index < detailFragments.value.length; index += 1) {
    const fragment = detailFragments.value[index]!

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

    if (fragment.type === 'tool_use') {
      const toolUseFragment = fragment as DisplayFragmentToolUse
      const lookup = toolUseFragment.toolUseId ? toolResultsByToolUseId.get(toolUseFragment.toolUseId) : undefined
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

const hasAnyDetail = computed(() => detailEntries.value.length > 0)
</script>

<template>
  <div class="space-y-3">
    <div v-if="hasAnyDetail" class="space-y-3">
      <template v-for="entry in detailEntries" :key="entry.key">
        <TimelineThinkingRow
          v-if="entry.kind === 'thinking'"
          :text="entry.content"
          :redacted="Boolean(entry.redacted)"
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
        <TimelineTaskCreateRow
          v-else-if="entry.kind === 'taskcreate'"
          :subtitle="entry.subtitle"
          :raw="entry.result?.raw"
          :output="entry.result?.output"
          debug
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
      </template>
    </div>

    <div class="space-y-2">
      <template v-if="!hasFinalFragments && hasFinalOverlay">
        <TimelineLivePreviewCard
          v-for="overlay in finalOverlays"
          :key="`${item.key}-final-overlay-${overlay.id}`"
          :item="overlay"
          compact
        />
      </template>

      <div
        v-for="(fragment, fragmentIndex) in finalFragments"
        :key="`${item.key}-final-fragment-${fragmentIndex}`"
        class="space-y-2"
      >
        <TimelineAssistantTextBlock v-if="fragment.type === 'text'" :fragment="fragment" />
        <TimelineAssistantSummaryBlock v-else :fragment="fragment" />
      </div>

      <div v-if="!hasFinalFragments && !hasFinalOverlay" class="text-[13px] leading-6 text-slate-400">
        (no final output yet)
      </div>
    </div>

    <TimelineAssistantFooterLine :message="item.anchorMessage" :footer="item.footer" />
  </div>
</template>
