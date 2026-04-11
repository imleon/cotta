<script setup lang="ts">
import { computed } from 'vue'
import type { SessionMessage } from '../stores/session'
import type { DisplayAssistantFooter } from '../../../shared/message-types.js'
import { buildAssistantFooterText } from '../../../shared/assistant-footer-format.js'
import {
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptStopReason,
} from '../../../shared/transcript-normalizer.js'

const props = defineProps<{
  message: SessionMessage
  footer?: DisplayAssistantFooter
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
