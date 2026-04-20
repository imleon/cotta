<script setup lang="ts">
import { computed, ref, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  subtitle?: string
  subtitleVisibility?: 'always' | 'collapsed' | 'expanded'
  expandable?: boolean
  defaultExpanded?: boolean
}>(), {
  subtitle: '',
  subtitleVisibility: 'always',
  expandable: true,
  defaultExpanded: false,
})

const slots = useSlots()
const expanded = ref(props.defaultExpanded)

const hasExpandedContent = computed(() => props.expandable && Boolean(slots.default))
const shouldShowSubtitle = computed(() => {
  if (!props.subtitle) return false
  if (!props.expandable) return true
  if (props.subtitleVisibility === 'always') return true
  if (props.subtitleVisibility === 'collapsed') return !expanded.value
  return expanded.value
})

function toggleExpanded() {
  if (!props.expandable) return
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="space-y-2">
    <component
      :is="props.expandable ? 'button' : 'div'"
      :type="props.expandable ? 'button' : undefined"
      class="group flex w-full items-center gap-1 px-0 py-0 text-left text-[13px] leading-6 text-[var(--tt-text-muted)]"
      :class="props.expandable ? 'cursor-pointer' : ''"
      @click="toggleExpanded"
    >
      <span class="shrink-0 inline-flex h-6 w-6 items-center justify-center text-[15px] leading-6 text-slate-400">
        <slot name="icon" />
      </span>
      <span class="min-w-0 flex-1 flex items-center">
        <span class="text-[var(--tt-text-muted)]">{{ title }}</span>
        <span v-if="shouldShowSubtitle" class="ml-2 truncate text-[var(--tt-text-muted)]">{{ subtitle }}</span>
        <span
          v-if="props.expandable"
          class="ml-2 inline-flex h-6 w-4 items-center justify-center text-slate-300"
          :class="expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        >
          <svg v-if="expanded" class="block" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else class="block" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </span>
    </component>

    <div v-if="hasExpandedContent && expanded" class="ml-2 min-w-0 border-l border-[color:color-mix(in_srgb,var(--tt-border)_88%,white)] pl-4">
      <slot />
    </div>
  </div>
</template>
