<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  summary: string
}>()

const expanded = ref(false)
</script>

<template>
  <div class="space-y-2">
    <button
      type="button"
      class="group flex w-full items-center gap-3 rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] px-3 py-2 text-left transition-colors hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_84%,white)]"
      @click="expanded = !expanded"
    >
      <span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--tt-success)_88%,white)] text-[11px] font-semibold text-white">
        ✓
      </span>
      <span class="min-w-0 flex-1 text-[13px] font-medium leading-5 text-[var(--tt-text-muted)]">
        {{ summary }}
      </span>
      <span
        class="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--tt-text-subtle)] transition-transform"
        :class="expanded ? 'rotate-90' : ''"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <div v-if="expanded" class="ml-2 border-l border-[color:color-mix(in_srgb,var(--tt-border)_88%,white)] pl-4">
      <div class="space-y-2">
        <slot />
      </div>
    </div>
  </div>
</template>
