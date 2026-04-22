<script setup lang="ts">
import MarkdownContent from './MarkdownContent.vue'
import ToolRowShell from './ToolRowShell.vue'
import ToolSectionBlock from './ToolSectionBlock.vue'
import Icon from './icons/Icon.vue'
import type { ICON_REGISTRY } from './icons/icon-registry'

export type ToolSection = {
  label?: string
  content: string
  mode?: 'plain' | 'markdown' | 'bash'
  command?: string
}

const props = withDefaults(defineProps<{
  iconName: keyof typeof ICON_REGISTRY
  title: string
  subtitle?: string
  sections: ToolSection[]
  maxHeightClass?: string
  expandable?: boolean
  defaultExpanded?: boolean
}>(), {
  subtitle: '',
  maxHeightClass: 'max-h-72',
  expandable: true,
  defaultExpanded: false,
})
</script>

<template>
  <ToolRowShell :title="title" :subtitle="subtitle" :expandable="expandable" :default-expanded="defaultExpanded">
    <template #icon><Icon :name="iconName" /></template>
    <div :class="[maxHeightClass, 'space-y-3 overflow-auto pr-1']">
      <ToolSectionBlock
        v-for="(section, index) in sections"
        :key="`${section.label || 'content'}-${index}`"
        :label="section.label"
      >
        <MarkdownContent
          v-if="(section.mode || 'plain') === 'markdown' && section.content"
          :content="section.content"
          muted
          compact
        />
        <div
          v-else-if="section.mode === 'bash'"
          class="space-y-2"
        >
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5">
            <span class="text-red-500">$</span>
            <span class="ml-1 text-slate-700">{{ section.command || '' }}</span>
          </div>
          <div
            v-if="section.content"
            class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
          >{{ section.content }}</div>
        </div>
        <div
          v-else-if="section.content"
          class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500"
        >{{ section.content }}</div>
        <div v-else class="text-[12px] leading-5 text-slate-500"></div>
      </ToolSectionBlock>
    </div>
  </ToolRowShell>
</template>
