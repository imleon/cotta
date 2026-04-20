<script setup lang="ts">
import TimelineAssistantDetailRow from './TimelineAssistantDetailRow.vue'
import TimelineAgentRow from './TimelineAgentRow.vue'
import TimelineAskUserQuestionRow from './TimelineAskUserQuestionRow.vue'
import TimelineBashToolRow from './TimelineBashToolRow.vue'
import TimelineEditToolRow from './TimelineEditToolRow.vue'
import TimelineEnterPlanModeRow from './TimelineEnterPlanModeRow.vue'
import TimelineExitPlanModeRow from './TimelineExitPlanModeRow.vue'
import TimelineFallbackToolRow from './TimelineFallbackToolRow.vue'
import TimelineReadToolRow from './TimelineReadToolRow.vue'
import TimelineSkillRow from './TimelineSkillRow.vue'
import TimelineTaskCreateRow from './TimelineTaskCreateRow.vue'
import TimelineTaskListRow from './TimelineTaskListRow.vue'
import TimelineTaskUpdateRow from './TimelineTaskUpdateRow.vue'
import TimelineThinkingRow from './TimelineThinkingRow.vue'
import TimelineWebFetchRow from './TimelineWebFetchRow.vue'
import TimelineWebSearchRow from './TimelineWebSearchRow.vue'
import TimelineWriteToolRow from './TimelineWriteToolRow.vue'
import TimelineAssistantSummaryBlock from './TimelineAssistantSummaryBlock.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

defineProps<{
  entry: any
}>()
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
    <TimelineTaskListRow
      v-else-if="entry.kind === 'tasklist'"
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
    <TimelineFallbackToolRow
      v-else-if="entry.kind === 'tool'"
      :title="entry.title"
      :input="entry.input"
      :output="entry.outputValue"
      :raw="entry.result?.raw"
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
