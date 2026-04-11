import type { DisplayAssistantFooter } from './message-types.js'
import type { TranscriptAssistantUsage } from './transcript-normalizer.js'

export function getCompactModel(model?: string | null): string {
  if (!model) return '-'
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

export function formatTimestamp(timestamp?: number | null): string {
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

export function formatDelta(deltaMs?: number | null): string {
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) return '-'
  if (deltaMs < 1000) return 'Δ 0s'
  const totalSeconds = Math.round(deltaMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `Δ ${minutes}m ${seconds}s`
  return `Δ ${seconds}s`
}

export function formatCompactNumber(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  if (value < 1000) return String(value)
  if (value < 10_000) return `${Math.round((value / 1000) * 10) / 10}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${Math.round((value / 1_000_000) * 10) / 10}m`
}

export function formatPair(left?: number | null, right?: number | null, prefix: string = ''): string {
  const l = formatCompactNumber(left)
  const r = formatCompactNumber(right)
  return `${prefix}${l}/${r}`
}

export function buildAssistantFooterText(footer?: DisplayAssistantFooter | null): string {
  const usage: TranscriptAssistantUsage | null | undefined = footer?.usage
  return [
    formatTimestamp(footer?.completedAt),
    footer?.stopReason ?? '-',
    formatDelta(footer?.deltaMs),
    `↑↓ ${formatPair(usage?.inputTokens, usage?.outputTokens)}`,
    `RW ${formatPair(usage?.cacheReadTokens, usage?.cacheWriteTokens)}`,
    getCompactModel(footer?.model),
  ].join(' · ')
}
