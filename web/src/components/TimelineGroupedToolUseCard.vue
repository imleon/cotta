<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import TimelineAssistantToolUseBlock from './TimelineAssistantToolUseBlock.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { DisplayFragmentToolUse } from '../../../runtime/protocol/message-types.js'
import type { GroupedToolUseDisplayItem, ToolResultDisplayMeta } from '../../../runtime/protocol/message-types.js'

const props = withDefaults(defineProps<{
  item: GroupedToolUseDisplayItem
  hideFooter?: boolean
}>(), {
  hideFooter: false,
})

const expanded = ref(props.item.status === 'streaming')
const toolResultExpanded = ref<Record<number, boolean>>({})

watch(
  () => props.item.status,
  (status) => {
    if (status === 'streaming') {
      expanded.value = true
    }
  },
)

function getToolResultExpanded(toolIndex: number, resultDisplay?: ToolResultDisplayMeta): boolean {
  return toolResultExpanded.value[toolIndex] ?? resultDisplay?.defaultExpanded ?? false
}

function getToolResultToggleLabel(toolIndex: number, resultDisplay?: ToolResultDisplayMeta): string {
  if (!resultDisplay || (resultDisplay.defaultExpanded ?? false) === true && toolResultExpanded.value[toolIndex] === undefined) {
    return ''
  }
  const expanded = getToolResultExpanded(toolIndex, resultDisplay)
  const linePrefix = resultDisplay.lineCount > 1 ? `${resultDisplay.lineCount} lines ` : ''
  return `${linePrefix}${expanded ? 'less' : 'more'}`
}

function setToolResultExpanded(toolIndex: number, value: boolean) {
  toolResultExpanded.value = {
    ...toolResultExpanded.value,
    [toolIndex]: value,
  }
}

function toggleToolResult(toolIndex: number, resultDisplay?: ToolResultDisplayMeta) {
  setToolResultExpanded(toolIndex, !getToolResultExpanded(toolIndex, resultDisplay))
}

const toggleLabel = computed(() => (expanded.value ? 'collapse' : 'expand'))
</script>

<template>
  <div class="space-y-2">
    <div v-if="item.overlays?.length" class="space-y-2">
      <TimelineLivePreviewCard
        v-for="overlay in item.overlays"
        :key="`${item.key}-overlay-${overlay.id}`"
        :item="overlay"
        compact
      />
    </div>
    <template v-if="expanded">
      <div v-for="(tool, toolIndex) in item.toolUses" :key="`${item.key}-tool-${toolIndex}`" class="space-y-2">
        <TimelineAssistantToolUseBlock
          :fragment="{ type: 'tool_use', name: tool.name, toolUseId: tool.toolUseId, input: tool.input } as DisplayFragmentToolUse"
          :status="tool.result === undefined ? item.status : 'completed'"
          :trailing-toggle-label="getToolResultToggleLabel(toolIndex, tool.resultDisplay)"
          @toggle="toggleToolResult(toolIndex, tool.resultDisplay)"
        />
        <TimelineAssistantToolResultBlock
          v-if="tool.result !== undefined"
          :output="tool.result"
          :display="tool.resultDisplay"
          :expanded="getToolResultExpanded(toolIndex, tool.resultDisplay)"
          :show-inline-more="false"
          attached-to-parent
          @update:expanded="setToolResultExpanded(toolIndex, $event)"
        />
      </div>
    </template>
    <TimelineCliSubrow v-if="item.toolUses.length > 1" muted>
      <div class="flex items-center gap-2">
        <span>{{ item.toolUses.length }} tool calls</span>
        <button class="timeline-cli-button" @click="expanded = !expanded">{{ toggleLabel }}</button>
      </div>
    </TimelineCliSubrow>
  </div>
</template>
