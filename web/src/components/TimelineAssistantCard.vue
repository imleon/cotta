<script setup lang="ts">
import { computed, ref } from 'vue'
import TimelineAssistantFooterLine from './TimelineAssistantFooterLine.vue'
import TimelineAssistantScopeUsageDebug from './TimelineAssistantScopeUsageDebug.vue'
import TimelineAssistantSummaryBlock from './TimelineAssistantSummaryBlock.vue'
import TimelineAssistantTextBlock from './TimelineAssistantTextBlock.vue'
import TimelineAssistantThinkingBlock from './TimelineAssistantThinkingBlock.vue'
import TimelineAssistantToolResultBlock from './TimelineAssistantToolResultBlock.vue'
import TimelineAssistantToolUseBlock from './TimelineAssistantToolUseBlock.vue'
import TimelineAtomDebugMeta from './TimelineAtomDebugMeta.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import type { AssistantDisplayItem, DisplayFragment, DisplayFragmentToolResult } from '../../../shared/message-types.js'
import {
  isTranscriptRedactedThinkingMessage,
} from '../../../shared/transcript-normalizer.js'

const props = withDefaults(defineProps<{
  item: AssistantDisplayItem
  hideFooter?: boolean
  showDebugMeta?: boolean
}>(), {
  hideFooter: false,
  showDebugMeta: false,
})

function shouldRenderFragment(fragment: DisplayFragment): boolean {
  if (fragment.type === 'thinking') {
    return !fragment.defaultHidden
  }
  if (fragment.type === 'tool_result') {
    return true
  }
  if (fragment.type === 'summary') {
    return !fragment.defaultCollapsed
  }
  return true
}

function getNextToolResult(fragmentIndex: number): DisplayFragmentToolResult | null {
  const nextFragment = visibleFragments.value[fragmentIndex + 1]
  return nextFragment?.type === 'tool_result' ? nextFragment : null
}

function getToolResultExpanded(fragmentIndex: number, toolResult: DisplayFragmentToolResult | null): boolean | undefined {
  if (!toolResult) return undefined
  return toolResultExpanded.value[fragmentIndex + 1] ?? toolResult.display?.defaultExpanded
}

function getToolResultToggleLabel(fragmentIndex: number): string {
  const toolResult = getNextToolResult(fragmentIndex)
  if (!toolResult || (toolResult.display?.defaultExpanded ?? false) === true && toolResultExpanded.value[fragmentIndex + 1] === undefined) {
    return ''
  }
  const expanded = getToolResultExpanded(fragmentIndex, toolResult) ?? false
  const lineCount = toolResult.display?.lineCount ?? 0
  const linePrefix = lineCount > 1 ? `${lineCount} lines ` : ''
  return `${linePrefix}${expanded ? 'less' : 'more'}`
}

function setToolResultExpanded(fragmentIndex: number, value: boolean) {
  toolResultExpanded.value = {
    ...toolResultExpanded.value,
    [fragmentIndex]: value,
  }
}

function toggleToolResult(fragmentIndex: number, toolResult: DisplayFragmentToolResult | null) {
  if (!toolResult) return
  const current = getToolResultExpanded(fragmentIndex - 1, toolResult) ?? false
  setToolResultExpanded(fragmentIndex, !current)
}

const topOverlays = computed(() =>
  (props.item.overlays || []).filter((overlay) => overlay.overlayKind === 'streaming_tool_use' || overlay.overlayKind === 'streaming_progress')
)

const inlineOverlays = computed(() =>
  (props.item.overlays || []).filter((overlay) => overlay.overlayKind === 'streaming_text' || overlay.overlayKind === 'streaming_thinking')
)

const visibleFragments = computed(() => props.item.fragments.filter(shouldRenderFragment))
const toolResultExpanded = ref<Record<number, boolean>>({})
const shouldIndentFooterForTool = computed(() => visibleFragments.value[0]?.type === 'tool_use')
</script>

<template>
  <div class="space-y-2.5">
    <div v-if="topOverlays.length" class="space-y-2">
      <TimelineLivePreviewCard
        v-for="overlay in topOverlays"
        :key="`${item.key}-overlay-${overlay.id}`"
        :item="overlay"
        compact
      />
    </div>
    <template v-else>
      <div
        v-for="(fragment, fragmentIndex) in visibleFragments"
        :key="`${item.key}-fragment-${fragmentIndex}`"
        class="space-y-2"
      >
        <div v-if="fragmentIndex === 0 && inlineOverlays.length" class="space-y-2">
          <TimelineLivePreviewCard
            v-for="overlay in inlineOverlays"
            :key="`${item.key}-inline-overlay-${overlay.id}`"
            :item="overlay"
            compact
          />
        </div>
        <TimelineAssistantTextBlock v-if="fragment.type === 'text'" :fragment="fragment" />
        <TimelineAssistantToolUseBlock
          v-else-if="fragment.type === 'tool_use'"
          :fragment="fragment"
          :trailing-toggle-label="getToolResultToggleLabel(fragmentIndex)"
          @toggle="toggleToolResult(fragmentIndex + 1, getNextToolResult(fragmentIndex))"
        />
        <TimelineAssistantToolResultBlock
          v-else-if="fragment.type === 'tool_result'"
          :fragment="fragment"
          :expanded="getToolResultExpanded(fragmentIndex - 1, fragment)"
          :show-inline-more="false"
          @update:expanded="setToolResultExpanded(fragmentIndex, $event)"
        />
        <TimelineAssistantThinkingBlock v-else-if="fragment.type === 'thinking'" :fragment="fragment" />
        <TimelineAssistantSummaryBlock v-else :fragment="fragment" />
        <TimelineAtomDebugMeta v-if="showDebugMeta" :debug="fragment.debug" />
      </div>
    </template>
    <TimelineAssistantFooterLine :message="item.anchorMessage" :footer="item.footer" :indent-for-tool="shouldIndentFooterForTool" />
    <TimelineAssistantScopeUsageDebug v-if="showDebugMeta" :messages="item.messages" />
  </div>
</template>
