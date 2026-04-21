<script setup lang="ts">
import MarkdownContent from './MarkdownContent.vue'
import ToolRowShell from './ToolRowShell.vue'

const props = withDefaults(defineProps<{
  icon: string
  title: string
  subtitle?: string
  content?: string
  contentMode?: 'plain' | 'markdown'
  expandable?: boolean
}>(), {
  subtitle: '',
  content: '',
  contentMode: 'plain',
  expandable: true,
})
</script>

<template>
  <ToolRowShell :title="title" :subtitle="subtitle" :expandable="expandable">
    <template #icon>{{ icon }}</template>
    <div class="max-h-72 overflow-auto pr-1">
      <MarkdownContent
        v-if="contentMode === 'markdown' && content"
        :content="content"
        muted
        compact
      />
      <div
        v-else-if="content"
        class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
      >{{ content }}</div>
      <div v-else class="text-[12px] leading-5 text-slate-500"></div>
    </div>
  </ToolRowShell>
</template>
