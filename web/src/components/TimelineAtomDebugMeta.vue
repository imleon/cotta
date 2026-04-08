<script setup lang="ts">
import type { DebugAtomMeta } from '../../../shared/message-types.js'

const props = defineProps<{
  debug?: DebugAtomMeta
}>()

function getCompactModel(model?: string | null): string {
  if (!model) return '-'
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function formatUsage(debug?: DebugAtomMeta): string {
  const usage = debug?.assistant?.usage
  if (!usage) return 'usage=-'
  return [
    `in=${usage.inputTokens ?? '-'}`,
    `out=${usage.outputTokens ?? '-'}`,
    `read=${usage.cacheReadTokens ?? '-'}`,
    `write=${usage.cacheWriteTokens ?? '-'}`,
  ].join(' ')
}

function formatDebug(debug?: DebugAtomMeta): string {
  if (!debug) return ''
  const base = [
    `uuid=${debug.uuid || 'unknown'}`,
    debug.responseId ? `rid=${debug.responseId}` : '',
    `role=${debug.role}`,
    `kind=${debug.semanticKind}`,
    `time=${formatTimestamp(debug.order.timestamp)}`,
    `idx=${debug.order.sourceIndex}`,
    `src=${debug.source}`,
  ]

  if (!debug.assistant?.stopReason) {
    return base.join(' · ')
  }

  return [
    ...base,
    `stop=${debug.assistant.stopReason}`,
    `model=${getCompactModel(debug.assistant?.model)}`,
    formatUsage(debug),
    debug.linkage.toolUseIds.length ? `toolUse=${debug.linkage.toolUseIds.join(',')}` : 'toolUse=-',
    debug.linkage.toolResultForIds.length ? `toolResultFor=${debug.linkage.toolResultForIds.join(',')}` : 'toolResultFor=-',
  ].filter(Boolean).join(' · ')
}
</script>

<template>
  <div v-if="props.debug" class="timeline-cli-meta">{{ formatDebug(props.debug) }}</div>
</template>
