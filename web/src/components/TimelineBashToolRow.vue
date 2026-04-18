<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  toolName: string
  description?: string
  command: string
  resultContent?: string
}>(), {
  description: '',
  resultContent: '',
})

const expanded = ref(false)

const headerDescription = computed(() => {
  return props.description?.trim() || props.command.trim()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200/70 overflow-hidden">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700 hover:bg-slate-100/60"
      @click="expanded = !expanded"
    >
      <span class="shrink-0 inline-flex h-6 w-6 items-center justify-center text-[15px] leading-6 text-slate-600">
        ⌘
      </span>
      <span class="min-w-0 flex-1 flex items-center">
        <span class="font-medium text-slate-900">{{ toolName }}</span>
        <span v-if="headerDescription" class="ml-2 text-slate-500 truncate">{{ headerDescription }}</span>
        <span
          class="ml-2 inline-flex h-6 w-4 items-center justify-center text-slate-400"
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
    </button>

    <div v-if="expanded" class="min-w-0 border-t border-slate-200/70 bg-white px-3 py-2">
      <div class="max-h-56 overflow-auto pr-1 space-y-2">
        <div class="font-mono text-[12px] leading-5 text-slate-900">
        <span class="text-red-600">$</span>
        <span class="ml-2">{{ command }}</span>
        </div>
      <div v-if="resultContent" class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-400">
        {{ resultContent }}
        </div>
      </div>
    </div>
  </div>
</template>
