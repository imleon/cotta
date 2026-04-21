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
const detailOverlays = computed(() =>
  allOverlays.value.filter((overlay) => overlay.overlayKind !== 'streaming_text')
)
const finalOverlays = computed(() =>
  allOverlays.value.filter((overlay) => overlay.overlayKind === 'streaming_text')
)

const hasFinalOverlay = computed(() => finalOverlays.value.length > 0)

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

function buildOverlayDetailEntries(overlay: TimelineLivePreview): AssistantDetailEntry[] {
  return overlay.preview.blocks.map((block, index) => {
    if (block.kind === 'thinking') {
      return {
        key: `${overlay.id}-thinking-${index}`,
        kind: 'thinking',
        title: THINKING_ROW_TITLE,
        summary: block.redacted ? 'redacted' : compactString(block.shownText || ''),
        content: block.redacted ? 'redacted thinking' : (block.shownText || ''),
        redacted: block.redacted,
      }
    }

    if (block.kind === 'tool_use') {
      const syntheticToolUse = {
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
          title: 'TaskCreate',
          summary: '',
          result: null,
        }
      }
      if (syntheticToolUse.name === 'Write') {
        return {
          key: `${overlay.id}-tool-${index}`,
          kind: 'write',
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
        title: getToolTitle(syntheticToolUse),
        summary: getToolSummary(syntheticToolUse),
        result: null,
      }
    }

    return {
      key: `${overlay.id}-thinking-fallback-${index}`,
      kind: 'thinking',
      title: '处理中',
      summary: compactString(block.shownText || ''),
      content: block.shownText || '',
    }
  })
}

const contentEntries = computed<AssistantDetailEntry[]>(() => {
  const entries: AssistantDetailEntry[] = []

  for (const overlay of detailOverlays.value) {
    entries.push(...buildOverlayDetailEntries(overlay))
  }
  entries.push(...buildAssistantDetailEntries(props.item))
  return entries
})

const hasAnyContent = computed(() => contentEntries.value.length > 0)

</script>

<template>
  <div class="space-y-3">
    <div v-if="hasAnyContent" class="space-y-3">
      <template v-for="entry in contentEntries" :key="entry.key">
        <TimelineToolGroupRow v-if="entry.kind === 'tool_group'" :summary="entry.summary">
          <TimelineAssistantDetailEntry
            v-for="child in entry.entries"
            :key="child.key"
            :entry="child"
          />
        </TimelineToolGroupRow>
        <TimelineAssistantDetailEntry v-else :entry="entry" />
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
