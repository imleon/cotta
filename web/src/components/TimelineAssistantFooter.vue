<script setup lang="ts">
import { computed } from 'vue'
import type { SessionMessage } from '../stores/session'
import type { DisplayAssistantFooter } from '../../../runtime/protocol/message-types.js'
import {
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptStopReason,
} from '../../../runtime/protocol/transcript-normalizer.js'

const props = withDefaults(defineProps<{
  message: SessionMessage
  footer?: DisplayAssistantFooter
  indentForTool?: boolean
}>(), {
  indentForTool: false,
})

function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (value < 1000) return String(value)
  if (value < 10_000) return `${Math.round((value / 1000) * 10) / 10}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${Math.round((value / 1_000_000) * 10) / 10}m`
}

function formatDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const footerSegments = computed(() => {
  const usage = getTranscriptAssistantUsage(props.message)
  const model = getTranscriptAssistantModel(props.message)
  const stopReason = getTranscriptStopReason(props.message) || 'unknown'

  return [
    stopReason,
    formatDuration(props.footer?.executionDurationMs),
    `↑ ${formatCompactNumber(usage?.inputTokens)}`,
    `↓ ${formatCompactNumber(usage?.outputTokens)}`,
    `R ${formatCompactNumber(usage?.cacheReadTokens)}`,
    `W ${formatCompactNumber(usage?.cacheWriteTokens)}`,
    model || 'unknown',
  ]
})
const footerText = computed(() => footerSegments.value.join(' · '))
</script>

<template>
  <div :class="['timeline-cli-footer', { 'timeline-cli-footer-tool': indentForTool }]">{{ footerText }}</div>
</template>
