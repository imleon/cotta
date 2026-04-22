<script setup lang="ts">
import { computed } from 'vue'
import TimelineAssistantDetailEntry from './TimelineAssistantDetailEntry.vue'
import TimelineAssistantFooterLine from './TimelineAssistantFooterLine.vue'
import TimelineToolGroupRow from './TimelineToolGroupRow.vue'
import type {
  TimelineAssistantItem,
  TimelineLivePreview,
} from '../../models/timeline'
import {
  buildAssistantDetailEntries,
  type AssistantDetailEntry,
} from '../../domain/timeline/assistantDetailEntries'
import { THINKING_ROW_TITLE } from '../../domain/timeline/assistantRowSemantics'

const props = withDefaults(defineProps<{
  item: TimelineAssistantItem
  hideFooter?: boolean
}>(), {
  hideFooter: false,
})

const allOverlays = computed(() => props.item.overlays || [])
const hasPreviewOverlays = computed(() => allOverlays.value.length > 0)
const isPlaceholder = computed(() => props.item.placeholder === true)
const isTerminalAssistant = computed(() => Boolean(props.item.footer?.stopReason))
const shouldRenderUngrouped = computed(() => hasPreviewOverlays.value || !isTerminalAssistant.value)

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

function getToolKind(fragment: { name: string; input?: unknown }): 'agent' | 'taskcreate' | 'tool' {
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

function getToolTitle(fragment: { name: string; input?: unknown }): string {
  const kind = getToolKind(fragment)
  if (kind === 'agent') return 'Agent'
  if (kind === 'taskcreate') return 'TaskCreate'
  return fragment.name || 'Tool'
}

function getToolSummary(fragment: { input?: unknown; name: string }): string {
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

type RenderListEntry = {
  key: string
  entry: AssistantDetailEntry
  defaultExpanded?: boolean
}

function flattenDetailEntries(entries: AssistantDetailEntry[]): AssistantDetailEntry[] {
  return entries.flatMap((entry) => entry.kind === 'tool_group' ? entry.entries : [entry])
}

function isPreviewBlockActive(overlay: TimelineLivePreview, block: TimelineLivePreview['preview']['blocks'][number]): boolean {
  if (!overlay.preview.active) return false
  if (block.kind === 'thinking' && overlay.preview.phase === 'thinking') {
    const latestThinkingIndex = Math.max(
      ...overlay.preview.blocks
        .filter((candidate) => candidate.kind === 'thinking')
        .map((candidate) => candidate.index),
    )
    return block.index === latestThinkingIndex
  }
  if (block.kind === 'tool_use' && overlay.preview.phase === 'tool-input') {
    const latestToolIndex = Math.max(
      ...overlay.preview.blocks
        .filter((candidate) => candidate.kind === 'tool_use')
        .map((candidate) => candidate.index),
    )
    return block.index === latestToolIndex
  }
  return false
}

function getMaterializedToolResultsById(item: TimelineAssistantItem): Map<string, { output?: unknown }> {
  const map = new Map<string, { output?: unknown }>()
  for (const fragment of item.fragments) {
    if (fragment.type !== 'tool_result' || !fragment.toolUseId) continue
    map.set(fragment.toolUseId, { output: fragment.output })
  }
  return map
}

function parsePreviewToolInput(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function buildOverlayDetailEntries(overlay: TimelineLivePreview): RenderListEntry[] {
  const materializedResults = getMaterializedToolResultsById(props.item)
  return overlay.preview.blocks.map((block, index) => {
    if (block.kind === 'thinking') {
      return {
        key: `${overlay.id}-thinking-${index}`,
        defaultExpanded: isPreviewBlockActive(overlay, block),
        entry: {
          key: `${overlay.id}-thinking-${index}`,
          kind: 'thinking',
          title: THINKING_ROW_TITLE,
          summary: block.redacted ? 'redacted' : compactString(block.shownText || ''),
          content: block.redacted ? 'redacted thinking' : (block.shownText || ''),
          redacted: block.redacted,
        },
      }
    }

    if (block.kind === 'tool_use') {
      const parsedInput = parsePreviewToolInput(block.shownInput)
      const materializedResult = block.toolUseId ? materializedResults.get(block.toolUseId) : undefined
      const toolResult = materializedResult
        ? {
            type: 'tool_result' as const,
            toolUseId: block.toolUseId,
            output: materializedResult.output,
          }
        : null
      const syntheticToolUse = {
        name: block.name,
        toolUseId: block.toolUseId,
        input: parsedInput,
      }
      const toolKind = getToolKind(syntheticToolUse)
      if (syntheticToolUse.name === 'Bash') {
        const command = getStringField(syntheticToolUse.input, 'command')
        const description = getStringField(syntheticToolUse.input, 'description')
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'bash',
            title: 'Bash',
            summary: '',
            result: toolResult,
            command: command || (typeof parsedInput === 'string' ? parsedInput : ''),
            description,
            resultContent: materializedResult ? compactValue(materializedResult.output) : '',
            input: parsedInput,
          },
        }
      }
      if (syntheticToolUse.name === 'Read') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'read',
            title: 'Read',
            summary: '',
            result: toolResult,
            input: parsedInput,
            filePath: getStringField(syntheticToolUse.input, 'file_path'),
          },
        }
      }
      if (syntheticToolUse.name === 'Glob') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'glob',
            title: 'Glob',
            summary: '',
            result: toolResult,
            input: parsedInput,
            filePath: buildGlobSubtitle(syntheticToolUse.input),
          },
        }
      }
      if (syntheticToolUse.name === 'Grep') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'grep',
            title: 'Grep',
            summary: '',
            result: toolResult,
            input: parsedInput,
            filePath: buildGlobSubtitle(syntheticToolUse.input),
          },
        }
      }
      if (syntheticToolUse.name === 'Edit') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'edit',
            title: 'Edit',
            summary: '',
            result: toolResult,
            filePath: getStringField(syntheticToolUse.input, 'file_path'),
            input: syntheticToolUse.input,
          },
        }
      }
      if (syntheticToolUse.name === 'Skill') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'skill',
            title: 'Skill',
            summary: '',
            result: toolResult,
            input: parsedInput,
            subtitle: getSkillSubtitle(syntheticToolUse.input),
            args: getSkillArgs(syntheticToolUse.input),
          },
        }
      }
      if (toolKind === 'taskcreate') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'taskcreate',
            title: 'TaskCreate',
            summary: '',
            result: toolResult,
            input: parsedInput,
          },
        }
      }
      if (syntheticToolUse.name === 'Write') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'write',
            title: 'Write',
            summary: '',
            result: toolResult,
            input: parsedInput,
            filePath: getStringField(syntheticToolUse.input, 'file_path'),
            contentValue: (syntheticToolUse.input && typeof syntheticToolUse.input === 'object')
              ? (syntheticToolUse.input as Record<string, unknown>).content
              : undefined,
          },
        }
      }
      if (toolKind === 'agent') {
        return {
          key: `${overlay.id}-tool-${index}`,
          defaultExpanded: isPreviewBlockActive(overlay, block),
          entry: {
            key: `${overlay.id}-tool-${index}`,
            kind: 'agent',
            title: 'Agent',
            summary: '',
            result: toolResult,
            input: parsedInput,
            subtitle: buildAgentSubtitle(syntheticToolUse.input),
            prompt: getAgentPrompt(syntheticToolUse.input),
          },
        }
      }
      return {
        key: `${overlay.id}-tool-${index}`,
        defaultExpanded: isPreviewBlockActive(overlay, block),
        entry: {
          key: `${overlay.id}-tool-${index}`,
          kind: toolKind,
          title: getToolTitle(syntheticToolUse),
          summary: getToolSummary(syntheticToolUse),
          result: toolResult,
          input: parsedInput,
        },
      }
    }

    return {
      key: `${overlay.id}-text-${index}`,
      entry: {
        key: `${overlay.id}-text-${index}`,
        kind: 'text',
        fragment: {
          type: 'text',
          text: block.shownText || '',
        },
      },
    }
  })
}

const contentEntries = computed<RenderListEntry[]>(() => {
  const baseEntries = (shouldRenderUngrouped.value
    ? flattenDetailEntries(buildAssistantDetailEntries(props.item))
    : buildAssistantDetailEntries(props.item)
  ).map((entry) => ({
    key: entry.key,
    entry,
  }))

  if (!hasPreviewOverlays.value) {
    return baseEntries
  }

  const overlayToolUseIds = new Set<string>(
    allOverlays.value.flatMap((overlay) =>
      overlay.preview.blocks.flatMap((block) =>
        block.kind === 'tool_use' && block.toolUseId ? [block.toolUseId] : [],
      ),
    ),
  )
  const materializedEntries = baseEntries.filter((renderItem) => {
    const entry = renderItem.entry
    if (entry.kind === 'thinking') return true
    if (entry.kind === 'text') return true
    if ('result' in entry || 'input' in entry) {
      const toolUseId = 'result' in entry && entry.result?.toolUseId
        ? entry.result.toolUseId
        : undefined
      if (toolUseId && overlayToolUseIds.has(toolUseId)) return false
    }
    return true
  })

  const entries: RenderListEntry[] = [...materializedEntries]
  for (const overlay of allOverlays.value) {
    entries.push(...buildOverlayDetailEntries(overlay))
  }
  return entries
})

const hasAnyContent = computed(() => contentEntries.value.length > 0)

</script>

<template>
  <div class="space-y-3">
    <div v-if="hasAnyContent" class="space-y-3">
      <template v-for="renderItem in contentEntries" :key="renderItem.key">
        <TimelineToolGroupRow v-if="renderItem.entry.kind === 'tool_group' && !shouldRenderUngrouped" :summary="renderItem.entry.summary">
          <TimelineAssistantDetailEntry
            v-for="child in renderItem.entry.entries"
            :key="child.key"
            :entry="child"
          />
        </TimelineToolGroupRow>
        <TimelineAssistantDetailEntry
          v-else-if="renderItem.entry.kind !== 'tool_group'"
          :entry="renderItem.entry"
          :default-expanded-override="renderItem.defaultExpanded"
        />
      </template>
    </div>

    <div v-if="!hasAnyContent && !isPlaceholder" class="text-[13px] leading-6 text-slate-400">
      (no final output yet)
    </div>

    <TimelineAssistantFooterLine
      v-if="isTerminalAssistant && !isPlaceholder && !hideFooter"
      :message="item.anchorMessage"
      :footer="item.footer"
    />
  </div>
</template>
