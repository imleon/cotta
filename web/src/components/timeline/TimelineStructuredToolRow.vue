<script setup lang="ts">
import MarkdownContent from './MarkdownContent.vue'
import ToolRowShell from './ToolRowShell.vue'
import ToolSectionBlock from './ToolSectionBlock.vue'

export type ToolSection = {
  label: string
  content: string
  mode?: 'plain' | 'markdown'
}

const props = withDefaults(defineProps<{
  icon: string
  title: string
  subtitle?: string
  sections: ToolSection[]
  maxHeightClass?: string
  expandable?: boolean
}>(), {
  subtitle: '',
  maxHeightClass: 'max-h-72',
  expandable: true,
})
</script>

<template>
  <ToolRowShell :title="title" :subtitle="subtitle" :expandable="expandable">
    <template #icon>{{ icon }}</template>
    <div :class="[maxHeightClass, 'space-y-3 overflow-auto pr-1']">
      <ToolSectionBlock
        v-for="(section, index) in sections"
        :key="`${section.label}-${index}`"
        :label="section.label"
      >
        <MarkdownContent
          v-if="(section.mode || 'plain') === 'markdown' && section.content"
          :content="section.content"
          muted
        />
        <div
          v-else-if="section.content"
          class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
        >{{ section.content }}</div>
        <div v-else class="text-[12px] leading-5 text-slate-500"></div>
      </ToolSectionBlock>
    </div>
  </ToolRowShell>
</template>
