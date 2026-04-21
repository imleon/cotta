<script setup lang="ts">
import { computed } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import ToolRowShell from './ToolRowShell.vue'
import Icon from './icons/Icon.vue'
import { extractThinkingSubtitle, THINKING_ROW_TITLE } from '../../domain/timeline/assistantRowSemantics'

const props = withDefaults(defineProps<{
  text: string
  redacted?: boolean
  maxHeightClass?: string
}>(), {
  redacted: false,
  maxHeightClass: 'max-h-56',
})

const subtitle = computed(() => {
  if (props.redacted) return 'redacted'
  return extractThinkingSubtitle(props.text)
})

const thinkingText = computed(() => props.redacted ? 'redacted thinking' : props.text)
</script>

<template>
  <ToolRowShell
    :title="THINKING_ROW_TITLE"
    :subtitle="subtitle"
    subtitle-visibility="collapsed"
    :default-expanded="false"
  >
    <template #icon>
      <Icon name="efficiency_outlined" />
    </template>
    <div :class="[maxHeightClass, 'overflow-auto pr-1']">
      <MarkdownContent :content="thinkingText" muted compact />
    </div>
  </ToolRowShell>
</template>
