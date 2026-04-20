<script setup lang="ts">
import { computed } from 'vue'
import TimelineAssistantDetailRow from './TimelineAssistantDetailRow.vue'
import TimelineSimpleToolRow from './TimelineSimpleToolRow.vue'
import TimelineStructuredToolRow from './TimelineStructuredToolRow.vue'
import TimelineThinkingRow from './TimelineThinkingRow.vue'
import TimelineAssistantSummaryBlock from './TimelineAssistantSummaryBlock.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import {
  getObject,
  getSimpleResultContent,
  getStringArrayField,
  getToolResultMessageContent,
  toDisplayText,
} from './timeline-tool-utils'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

const props = defineProps<{
  entry: any
}>()

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

const simpleToolConfig = computed(() => {
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

const structuredToolConfig = computed(() => {
  if (props.entry.kind === 'bash') {
    return {
      icon: '⌘',
      title: '调用 Bash',
      subtitle: props.entry.description || props.entry.command || '',
      maxHeightClass: 'max-h-56',
      sections: [
        { label: 'command', content: props.entry.command || '', mode: 'plain' as const },
        { label: 'output', content: props.entry.resultContent || '', mode: 'plain' as const },
      ],
    }
  }
  if (props.entry.kind === 'agent') {
    return {
      icon: '🤖',
      title: '调用 Agent',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      sections: [
        { label: 'prompt', content: props.entry.prompt || '', mode: 'plain' as const },
        { label: 'result', content: props.entry.result ? stringifyStructuredValue(props.entry.result.output) : '', mode: 'markdown' as const },
      ],
    }
  }
  if (props.entry.kind === 'read' || props.entry.kind === 'glob' || props.entry.kind === 'grep') {
    const icon = props.entry.kind === 'read' ? '👁️' : props.entry.kind === 'glob' ? '🔎' : '🧭'
    const title = props.entry.kind === 'read' ? '调用 Read' : props.entry.kind === 'glob' ? '调用 Glob' : '调用 Grep'
    return {
      icon,
      title,
      subtitle: props.entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'result',
          content: props.entry.result ? stringifyStructuredValue(props.entry.result.output) : '',
          mode: 'plain' as const,
        },
      ],
    }
  }
  if (props.entry.kind === 'edit') {
    return {
      icon: '📝',
      title: '调用 Edit',
      subtitle: props.entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: Object.entries((props.entry.input && typeof props.entry.input === 'object') ? props.entry.input as Record<string, unknown> : {})
        .map(([key, value]) => ({
          label: key,
          content: typeof value === 'string' ? value : stringifyStructuredValue(value),
          mode: 'plain' as const,
        })),
    }
  }
  if (props.entry.kind === 'skill') {
    return {
      icon: '🔧',
      title: '调用 Skill',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'args',
          content: typeof props.entry.args === 'string' ? props.entry.args : stringifyStructuredValue(props.entry.args),
          mode: 'plain' as const,
        },
      ],
    }
  }
  if (props.entry.kind === 'websearch') {
    return {
      icon: '🔍',
      title: '调用 WebSearch',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
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
      icon: '🔎',
      title: '调用 WebFetch',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      sections: [
        { label: 'prompt', content: toDisplayText(getObject(props.entry.input)?.prompt), mode: 'plain' as const },
        { label: 'tool_result.content', content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  if (props.entry.kind === 'askuserquestion') {
    return {
      icon: '❓',
      title: '调用 AskUserQuestion',
      subtitle: props.entry.subtitle || '',
      maxHeightClass: 'max-h-72',
      sections: [
        { label: 'questions', content: buildQuestionsText(props.entry.input, props.entry.result?.raw, props.entry.outputValue), mode: 'plain' as const },
        { label: 'options', content: buildOptionsText(props.entry.input, props.entry.result?.raw, props.entry.outputValue), mode: 'plain' as const },
        { label: 'answers', content: getToolResultMessageContent(props.entry.result?.raw) || getToolResultMessageContent(props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  if (props.entry.kind === 'write') {
    return {
      icon: '🖨️',
      title: '调用 Write',
      subtitle: props.entry.filePath || '',
      maxHeightClass: 'max-h-56',
      sections: [
        {
          label: 'content',
          content: typeof props.entry.contentValue === 'string' ? props.entry.contentValue : stringifyStructuredValue(props.entry.contentValue),
          mode: 'plain' as const,
        },
      ],
    }
  }
  if (props.entry.kind === 'tool') {
    return {
      icon: '🔧',
      title: `调用 ${props.entry.title}`,
      subtitle: '',
      maxHeightClass: 'max-h-80',
      sections: [
        { label: 'input', content: stringifyStructuredValue(props.entry.input), mode: 'plain' as const },
        { label: 'tool_result', content: getSimpleResultContent(props.entry.result?.raw, props.entry.outputValue), mode: 'markdown' as const },
      ],
    }
  }
  return null
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
    <TimelineAssistantSummaryBlock
      v-else-if="entry.kind === 'summary_block'"
      :fragment="entry.fragment"
    />
    <TimelineStructuredToolRow
      v-else-if="structuredToolConfig"
      :icon="structuredToolConfig.icon"
      :title="structuredToolConfig.title"
      :subtitle="structuredToolConfig.subtitle"
      :sections="structuredToolConfig.sections"
      :max-height-class="structuredToolConfig.maxHeightClass"
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
      v-else
      :icon="entry.icon"
      :title="entry.title"
      :summary="entry.summary"
      :content="''"
      content-mode="plain"
    >
      <TimelineAssistantToolResultBlock
        v-if="entry.result"
        :fragment="entry.result"
        :expanded="true"
        :show-inline-more="false"
        :framed="false"
      />
    </TimelineAssistantDetailRow>
  </div>
</template>
