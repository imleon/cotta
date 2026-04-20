<script setup lang="ts">
import { computed } from 'vue'
import type { SessionMessageModel } from '../../models/session'
import type { TimelineAssistantFooter } from '../../models/timeline'
import { buildAssistantFooterText, getTranscriptAssistantModel, getTranscriptAssistantUsage, getTranscriptStopReason } from '../../lib/runtime-format'

const props = defineProps<{
  message: SessionMessageModel
  footer?: TimelineAssistantFooter
  indentForTool?: boolean
}>()

const footerText = computed(() => buildAssistantFooterText({
  completedAt: props.footer?.completedAt,
  deltaMs: props.footer?.deltaMs,
  stopReason: props.footer?.stopReason ?? getTranscriptStopReason(props.message),
  usage: props.footer?.usage ?? getTranscriptAssistantUsage(props.message),
  model: props.footer?.model ?? getTranscriptAssistantModel(props.message),
}))
</script>

<template>
  <div :class="['text-[11px] leading-4 text-[var(--tt-text-subtle)]', props.indentForTool ? 'pl-7' : '']">{{ footerText }}</div>
</template>
