<script setup lang="ts">
import { computed } from 'vue'

type ContextUsageCategory = {
  name?: string
  tokens?: number
  color?: string
}

type ContextUsageGridCell = {
  color?: string
  isFilled?: boolean
  categoryName?: string
  squareFullness?: number
}

type ContextUsageResult = {
  totalTokens?: number
  maxTokens?: number
  percentage?: number
  model?: string
  autocompactSource?: string
  categories?: ContextUsageCategory[]
  gridRows?: ContextUsageGridCell[][]
}

const props = defineProps<{
  payload: unknown
}>()

const contextUsage = computed<ContextUsageResult | null>(() => {
  const payload = props.payload
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (record.subtype !== 'get_context_usage') return null
  const result = record.result
  if (!result || typeof result !== 'object') return null
  return result as ContextUsageResult
})

const categories = computed(() => contextUsage.value?.categories ?? [])
const gridRows = computed(() => contextUsage.value?.gridRows ?? [])

function formatNumber(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('en-US').format(value)
}

function formatPercent(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${value}%`
}

function resolveSwatchColor(color?: string): string {
  switch (color) {
    case 'promptBorder':
      return 'color-mix(in srgb, var(--tt-coral) 78%, white)'
    case 'inactive':
      return 'color-mix(in srgb, var(--tt-border-strong) 88%, white)'
    case 'claude':
      return 'color-mix(in srgb, #5b8def 84%, white)'
    case 'warning':
      return 'color-mix(in srgb, var(--tt-warning) 84%, white)'
    case 'purple_FOR_SUBAGENTS_ONLY':
      return 'color-mix(in srgb, #8b5cf6 82%, white)'
    default:
      return 'color-mix(in srgb, var(--tt-accent) 18%, white)'
  }
}

function getCellStyle(cell: ContextUsageGridCell) {
  const fullness = typeof cell.squareFullness === 'number'
    ? Math.max(0.12, Math.min(1, cell.squareFullness))
    : 0.16
  const background = cell.isFilled
    ? resolveSwatchColor(cell.color)
    : 'color-mix(in srgb, var(--tt-surface) 80%, white)'
  return {
    background,
    opacity: cell.isFilled ? String(fullness) : '1',
  }
}

function getCategoryPercent(tokens?: number): string {
  const total = contextUsage.value?.totalTokens
  if (typeof tokens !== 'number' || typeof total !== 'number' || total <= 0) return '-'
  return `${Math.round((tokens / total) * 100)}%`
}
</script>

<template>
  <div v-if="contextUsage" class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_94%,white)] p-4 shadow-sm">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="text-sm font-medium text-[var(--tt-text)]">Context Usage</div>
        <div class="mt-1 text-xs text-[var(--tt-text-subtle)]">
          {{ formatNumber(contextUsage.totalTokens) }} / {{ formatNumber(contextUsage.maxTokens) }} tokens
          · {{ formatPercent(contextUsage.percentage) }}
        </div>
      </div>
      <div class="text-right text-xs text-[var(--tt-text-subtle)]">
        <div>{{ contextUsage.model || 'unknown model' }}</div>
        <div v-if="contextUsage.autocompactSource">autocompact: {{ contextUsage.autocompactSource }}</div>
      </div>
    </div>

    <div class="mt-3 h-2 overflow-hidden rounded-full bg-[color:color-mix(in_srgb,var(--tt-surface)_80%,white)]">
      <div
        class="h-full rounded-full bg-[var(--tt-coral)] transition-all"
        :style="{ width: `${Math.max(0, Math.min(100, contextUsage.percentage ?? 0))}%` }"
      />
    </div>

    <div v-if="gridRows.length > 0" class="mt-4 space-y-1.5">
      <div
        v-for="(row, rowIndex) in gridRows"
        :key="`ctx-row-${rowIndex}`"
        class="grid grid-cols-10 gap-1"
      >
        <div
          v-for="(cell, cellIndex) in row"
          :key="`ctx-cell-${rowIndex}-${cellIndex}`"
          class="h-3 rounded-[4px] border border-white/50"
          :style="getCellStyle(cell)"
          :title="cell.categoryName || 'Unknown'"
        />
      </div>
    </div>

    <div v-if="categories.length > 0" class="mt-4 space-y-2">
      <div
        v-for="category in categories"
        :key="category.name || 'unknown-category'"
        class="flex items-center gap-3 text-xs"
      >
        <span
          class="h-2.5 w-2.5 shrink-0 rounded-full"
          :style="{ background: resolveSwatchColor(category.color) }"
        />
        <div class="min-w-0 flex-1 truncate text-[var(--tt-text)]">{{ category.name || 'Unknown' }}</div>
        <div class="shrink-0 text-[var(--tt-text-subtle)]">
          {{ formatNumber(category.tokens) }} · {{ getCategoryPercent(category.tokens) }}
        </div>
      </div>
    </div>
  </div>
</template>
