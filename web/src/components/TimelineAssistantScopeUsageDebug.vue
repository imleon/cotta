<script setup lang="ts">
import { computed } from 'vue'
import type { SessionMessage } from '../stores/session'
import {
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptMessageId,
  getTranscriptSemanticKind,
  getTranscriptStopReason,
  isTranscriptRedactedThinkingMessage,
} from '../../../shared/transcript-normalizer.js'

const props = defineProps<{
  messages: SessionMessage[]
}>()

function getCompactModel(model?: string | null): string {
  if (!model) return '-'
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

function formatUsage(message: SessionMessage): string {
  const usage = getTranscriptAssistantUsage(message)
  if (!usage) return 'usage=-'
  return [
    `in=${usage.inputTokens ?? '-'}`,
    `out=${usage.outputTokens ?? '-'}`,
    `read=${usage.cacheReadTokens ?? '-'}`,
    `write=${usage.cacheWriteTokens ?? '-'}`,
  ].join(' ')
}

const usageEntries = computed(() => {
  const entries = props.messages.map((message) => {
    const usage = getTranscriptAssistantUsage(message)
    const stopReason = getTranscriptStopReason(message)
    if (!usage && !stopReason) return null
    const kind = isTranscriptRedactedThinkingMessage(message)
      ? 'redacted_thinking'
      : getTranscriptSemanticKind(message)
    return {
      uuid: getTranscriptMessageId(message) || 'unknown',
      kind,
      stopReason: stopReason || '-',
      model: getCompactModel(getTranscriptAssistantModel(message)),
      usageText: formatUsage(message),
    }
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.uuid}:${entry.kind}:${entry.stopReason}:${entry.usageText}:${entry.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})
</script>

<template>
  <div v-if="usageEntries.length" class="rounded-lg border border-fuchsia-200/80 bg-fuchsia-50/60 px-3 py-2 space-y-1">
    <div class="text-[12px] font-medium text-fuchsia-900">scope usage debug</div>
    <div
      v-for="entry in usageEntries"
      :key="`${entry.uuid}-${entry.kind}-${entry.stopReason}`"
      class="text-[11px] leading-5 text-fuchsia-900/90"
    >
      {{ `uuid=${entry.uuid} · kind=${entry.kind} · stop=${entry.stopReason} · model=${entry.model} · ${entry.usageText}` }}
    </div>
  </div>
</template>
