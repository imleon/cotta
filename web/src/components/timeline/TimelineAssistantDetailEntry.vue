<script setup lang="ts">
import { computed } from 'vue'
import TimelineAssistantDetailRow from './TimelineAssistantDetailRow.vue'
import TimelineSimpleToolRow from './TimelineSimpleToolRow.vue'
import TimelineStructuredToolRow, { type ToolSection } from './TimelineStructuredToolRow.vue'
import TimelineThinkingRow from './TimelineThinkingRow.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import {
  getObject,
  getSimpleResultContent,
  getStringArrayField,
  getToolResultMessageContent,
  toDisplayText,
} from './timeline-tool-utils'
import type {
  AssistantDetailEntry,
  AssistantToolEntry,
} from '../../domain/timeline/assistantDetailEntries'
import {
  buildAssistantToolRenderConfig,
  type AssistantToolRenderConfig,
} from '../../domain/timeline/assistantToolSections'

type LegacySimpleEntryKind = 'enterplanmode' | 'tasklist' | 'exitplanmode' | 'taskupdate'
type LegacyStructuredEntryKind = 'websearch' | 'webfetch' | 'askuserquestion'

type LegacySimpleEntry = {
  key: string
  kind: LegacySimpleEntryKind
  subtitle?: string
  result?: { raw?: unknown; output?: unknown } | null
  outputValue?: unknown
  input?: unknown
}

type LegacyStructuredEntry = {
  key: string
  kind: LegacyStructuredEntryKind
  subtitle?: string
  result?: { raw?: unknown; output?: unknown } | null
  outputValue?: unknown
  input?: unknown
}

type DetailEntry = Exclude<AssistantDetailEntry, { kind: 'tool_group' }>
type DetailToolEntry = Extract<DetailEntry, { kind: AssistantToolEntry['kind'] }>
type RenderableDetailEntry = DetailEntry | LegacySimpleEntry | LegacyStructuredEntry

type SimpleToolConfig = {
  icon: string
  title: string
  subtitle: string
  content: string
  contentMode: 'plain' | 'markdown'
  expandable: boolean
}

type StructuredToolConfig = {
  iconName: AssistantToolRenderConfig['iconName']
  title: string
  subtitle: string
  maxHeightClass: string
  sections: ToolSection[]
  expandable: boolean
}

const props = defineProps<{
  entry: RenderableDetailEntry
}>()

function isToolEntry(entry: RenderableDetailEntry): entry is DetailToolEntry {
  return !['thinking', 'text', 'tool_group', 'enterplanmode', 'tasklist', 'exitplanmode', 'taskupdate', 'websearch', 'webfetch', 'askuserquestion'].includes(entry.kind)
}

function getPlanContent(input: unknown): string {
  return toDisplayText(getObject(input)?.plan)
}

type AskQuestion = {
  header?: string
  question?: string
  multiSelect?: boolean
  options?: Array<{
    label?: string
    description?: string
  }>
}

function getQuestionsFromInput(value: unknown): AskQuestion[] {
  const record = getObject(value)
  const rawQuestions = record?.questions
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      header: typeof item.header === 'string' ? item.header : '',
      question: typeof item.question === 'string' ? item.question : '',
      multiSelect: item.multiSelect === true,
      options: Array.isArray(item.options)
        ? item.options
            .filter((opt): opt is Record<string, unknown> => Boolean(opt) && typeof opt === 'object')
            .map((opt) => ({
              label: typeof opt.label === 'string' ? opt.label : '',
              description: typeof opt.description === 'string' ? opt.description : '',
            }))
        : [],
    }))
}

function getToolUseResult(value: unknown): Record<string, unknown> | null {
  const record = getObject(value)
  const direct = getObject(record?.toolUseResult)
  if (direct) return direct
  return getObject(value)
}

function buildQuestionsText(input: unknown, raw: unknown, output: unknown): string {
  const fromInput = getQuestionsFromInput(input)
  const fromRaw = getQuestionsFromInput(getToolUseResult(raw))
  const fromOutput = getQuestionsFromInput(getToolUseResult(output))
  const questions = fromInput.length > 0 ? fromInput : fromRaw.length > 0 ? fromRaw : fromOutput
  return questions
    .map((item) => {
      const label = item.header ? `${item.header}：` : ''
      const question = item.question || ''
      const suffix = item.multiSelect ? ' [multi]' : ''
      return `${label}${question}${suffix}`.trim()
    })
    .join('\n')
}

function buildOptionsText(input: unknown, raw: unknown, output: unknown): string {
  const fromInput = getQuestionsFromInput(input)
  const fromRaw = getQuestionsFromInput(getToolUseResult(raw))
  const fromOutput = getQuestionsFromInput(getToolUseResult(output))
  const questions = fromInput.length > 0 ? fromInput : fromRaw.length > 0 ? fromRaw : fromOutput
  return questions
    .flatMap((item) =>
      (item.options || []).map((option) => {
        const label = option.label || ''
        const description = option.description ? ` - ${option.description}` : ''
        return `${label}${description}`.trim()
      }))
    .join('\n')
}

const simpleToolConfig = computed<SimpleToolConfig | null>(() => {
  if (props.entry.kind === 'enterplanmode') {
    return {
      icon: '🗺️',
      title: '调用 EnterPlanMode',
      subtitle: '',
      content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue),
      contentMode: 'markdown' as const,
      expandable: true,
    }
  }
  if (props.entry.kind === 'tasklist') {
    return {
      icon: '📋',
      title: '调用 TaskList',
      subtitle: '',
      content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue),
      contentMode: 'markdown' as const,
      expandable: true,
    }
  }
  if (props.entry.kind === 'exitplanmode') {
    return {
      icon: '🗺️',
      title: '调用 ExitPlanMode',
      subtitle: props.entry.subtitle || '',
      content: getPlanContent(props.entry.input),
      contentMode: 'markdown' as const,
      expandable: true,
    }
  }
  if (props.entry.kind === 'taskcreate') {
    return {
      icon: '📋',
      title: '调用 TaskCreate',
      subtitle: props.entry.subtitle || '',
      content: '',
      contentMode: 'plain' as const,
      expandable: false,
    }
  }
  if (props.entry.kind === 'taskupdate') {
    return {
      icon: '📋',
      title: '调用 TaskUpdate',
      subtitle: props.entry.subtitle || '',
      content: '',
      contentMode: 'plain' as const,
      expandable: false,
    }
  }
  return null
})

const structuredToolConfig = computed<StructuredToolConfig | null>(() => {
  if (isToolEntry(props.entry)) {
    const config: AssistantToolRenderConfig = buildAssistantToolRenderConfig(props.entry)
    return {
      iconName: config.iconName,
      title: config.title,
      subtitle: config.subtitle,
      maxHeightClass: config.maxHeightClass,
      sections: config.sections,
      expandable: config.expandable,
    }
  }
  if (props.entry.kind === 'websearch') {
    return {
      iconName: 'language_outlined',
      title: '调用 WebSearch',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: [
        { label: 'allowed_domains', content: getStringArrayField(props.entry.input, 'allowed_domains').join('\n') || '[]', mode: 'plain' as const },
        { label: 'blocked_domains', content: getStringArrayField(props.entry.input, 'blocked_domains').join('\n') || '[]', mode: 'plain' as const },
        { label: 'query', content: props.entry.subtitle || '', mode: 'plain' as const },
        { label: 'tool_result.content', content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  if (props.entry.kind === 'webfetch') {
    return {
      iconName: 'browser-mac_outlined',
      title: '调用 WebFetch',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: [
        { label: 'prompt', content: toDisplayText(getObject(props.entry.input)?.prompt), mode: 'plain' as const },
        { label: 'tool_result.content', content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  if (props.entry.kind === 'askuserquestion') {
    return {
      iconName: 'maybe_outlined',
      title: '调用 AskUserQuestion',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      expandable: true,
      sections: [
        { label: 'questions', content: buildQuestionsText(props.entry.input, props.entry.result?.raw, props.entry.outputValue), mode: 'plain' as const },
        { label: 'options', content: buildOptionsText(props.entry.input, props.entry.result?.raw, props.entry.outputValue), mode: 'plain' as const },
        { label: 'answers', content: getToolResultMessageContent(props.entry.result?.raw) || getToolResultMessageContent(props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  return null
})

function getFallbackEntryIcon(entry: DetailToolEntry): string {
  switch (entry.kind) {
    case 'agent':
      return '🤖'
    case 'taskcreate':
      return '📋'
    case 'bash':
      return '⌘'
    case 'read':
      return '👁️'
    case 'glob':
      return '🔎'
    case 'grep':
      return '🧭'
    case 'edit':
      return '📝'
    case 'skill':
      return '🔧'
    case 'write':
      return '🖨️'
    default:
      return '🔧'
  }
}

const fallbackToolEntry = computed<DetailToolEntry | null>(() => {
  return isToolEntry(props.entry) ? props.entry : null
})
</script>

<template>
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
    <TimelineStructuredToolRow
      v-else-if="structuredToolConfig"
      :icon-name="structuredToolConfig.iconName"
      :title="structuredToolConfig.title"
      :subtitle="structuredToolConfig.subtitle"
      :sections="structuredToolConfig.sections"
      :max-height-class="structuredToolConfig.maxHeightClass"
      :expandable="structuredToolConfig.expandable"
    />
    <TimelineSimpleToolRow
      v-else-if="simpleToolConfig"
      :icon="simpleToolConfig.icon"
      :title="simpleToolConfig.title"
      :subtitle="simpleToolConfig.subtitle"
      :content="simpleToolConfig.content"
      :content-mode="simpleToolConfig.contentMode"
      :expandable="simpleToolConfig.expandable"
    />
    <TimelineAssistantDetailRow
      v-else-if="fallbackToolEntry"
      :icon="getFallbackEntryIcon(fallbackToolEntry)"
      :title="fallbackToolEntry.title"
      :summary="fallbackToolEntry.summary"
      :content="''"
      content-mode="plain"
    >
      <TimelineAssistantToolResultBlock
        v-if="fallbackToolEntry.result"
        :fragment="fallbackToolEntry.result"
        :expanded="true"
        :show-inline-more="false"
        :framed="false"
      />
    </TimelineAssistantDetailRow>
    <div v-else></div>
  </div>
</template>
