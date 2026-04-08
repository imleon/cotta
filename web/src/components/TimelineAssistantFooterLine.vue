<script setup lang="ts">
import type { SessionMessage } from '../stores/session'
import type { DisplayAssistantFooter } from '../../../shared/message-types.js'
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

function getCompactModel(model?: string | null): string {
  if (!model) return '-'
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

function formatTimestamp(timestamp?: number | null): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '-'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function formatDelta(deltaMs?: number | null): string {
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) return '-'
  if (deltaMs < 1000) return `Δ 0s`
  const totalSeconds = Math.round(deltaMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `Δ ${minutes}m ${seconds}s`
  return `Δ ${seconds}s`
}

function formatCompactNumber(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (value < 1000) return String(value)
  if (value < 10_000) return `${Math.round((value / 1000) * 10) / 10}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${Math.round((value / 1_000_000) * 10) / 10}m`
}

function formatPair(left?: number | null, right?: number | null, prefix: string = ''): string {
  const l = formatCompactNumber(left)
  const r = formatCompactNumber(right)
  return `${prefix}${l}/${r}`
}

const footerText = (() => {
  const usage = props.footer?.usage ?? getTranscriptAssistantUsage(props.message)
  const stopReason = props.footer?.stopReason ?? getTranscriptStopReason(props.message) ?? '-'
  const model = getCompactModel(props.footer?.model ?? getTranscriptAssistantModel(props.message))
  const time = formatTimestamp(props.footer?.completedAt)
  const delta = formatDelta(props.footer?.deltaMs)
  return [
    time,
    stopReason,
    delta,
    `↑↓ ${formatPair(usage?.inputTokens, usage?.outputTokens)}`,
    `RW ${formatPair(usage?.cacheReadTokens, usage?.cacheWriteTokens)}`,
    model,
  ].join(' · ')
})()
</script>

<template>
  <div :class="['text-[11px] leading-4 text-slate-400', props.indentForTool ? 'pl-7' : '']">{{ footerText }}</div>
</template>
