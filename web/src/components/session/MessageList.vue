<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import TimelineCliSubrow from '../timeline/TimelineCliSubrow.vue'
import TimelineCanUseToolInteractionBlock from '../timeline/TimelineCanUseToolInteractionBlock.vue'
import TimelineElicitationInteractionBlock from '../timeline/TimelineElicitationInteractionBlock.vue'
import TimelineRow from '../timeline/TimelineRow.vue'
import { useSessionStore } from '../../stores/session'
import type { TimelineElicitationInteraction, TimelinePermissionInteraction } from '../../models/interaction'
import type { TimelineItemModel } from '../../models/session'

const session = useSessionStore()
const container = ref<HTMLElement>()
const preservingOlderScroll = ref(false)
const initialHistoryAutoScrollPending = ref(true)
const pendingAutoScrollFrame = ref<number | null>(null)
const visibleTimelineItems = computed(() => session.timeline)
const pendingPermissionInteraction = computed<TimelinePermissionInteraction | null>(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction : null
)
const pendingElicitationInteraction = computed<TimelineElicitationInteraction | null>(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction : null
)
function itemHasToolUseId(item: TimelineItemModel, toolUseId: string): boolean {
  if (item.kind === 'assistant') {
    return item.fragments.some((fragment) => fragment.type === 'tool_use' && fragment.toolUseId === toolUseId)
  }
  return false
}

const isPendingPermissionAttached = computed(() => {
  const toolUseId = pendingPermissionInteraction.value?.toolUseId
  if (!toolUseId) return false
  return visibleTimelineItems.value.some((item) => itemHasToolUseId(item, toolUseId))
})

const isPendingElicitationAttached = computed(() => {
  const toolUseId = pendingElicitationInteraction.value?.toolUseId
  if (!toolUseId) return false
  return visibleTimelineItems.value.some((item) => itemHasToolUseId(item, toolUseId))
})

function isNearBottom(): boolean {
  const el = container.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 120
}

async function scrollToBottom() {
  await nextTick()
  if (!container.value) return
  container.value.scrollTop = container.value.scrollHeight
}

function scheduleAutoScroll() {
  if (pendingAutoScrollFrame.value !== null) {
    cancelAnimationFrame(pendingAutoScrollFrame.value)
  }

  pendingAutoScrollFrame.value = requestAnimationFrame(() => {
    pendingAutoScrollFrame.value = null
    void scrollToBottom()
  })
}

async function maybeLoadOlderHistory() {
  const el = container.value
  if (!el || el.scrollTop > 120) return
  if (!session.historyMessagesHasMore || session.historyMessagesLoading) return

  preservingOlderScroll.value = true
  const previousHeight = el.scrollHeight
  const previousTop = el.scrollTop
  const loaded = await session.loadOlderSessionMessages()
  if (!loaded) {
    preservingOlderScroll.value = false
    return
  }

  await nextTick()
  const nextHeight = el.scrollHeight
  el.scrollTop = nextHeight - previousHeight + previousTop
  preservingOlderScroll.value = false
}

function handleScroll() {
  void maybeLoadOlderHistory()
}

watch(
  () => session.currentSessionId,
  () => {
    initialHistoryAutoScrollPending.value = true
  },
)

watch(
  () => session.historyTimelineItems.length,
  async (next, prev) => {
    if (next === 0 || next === prev || preservingOlderScroll.value) return
    if (!initialHistoryAutoScrollPending.value) return
    if (session.historyMessagesLoadingOlder) return
    initialHistoryAutoScrollPending.value = false
    await scrollToBottom()
  },
)

watch(
  () => [session.timeline.length, session.pendingInteraction?.id],
  async () => {
    if (preservingOlderScroll.value || session.historyMessagesLoadingOlder) return
    if (!isNearBottom()) return
    scheduleAutoScroll()
  },
  { deep: true },
)
</script>

<template>
  <div ref="container" class="flex-1 overflow-y-auto bg-slate-50/70 px-3 py-4 md:px-6 md:py-6 space-y-3" @scroll="handleScroll">
    <div
      v-if="session.historyMessagesLoadingOlder"
      class="flex justify-center text-xs text-gray-400"
    >
      正在加载更早消息…
    </div>

    <div
      v-if="visibleTimelineItems.length === 0"
      class="flex items-center justify-center h-full text-gray-400"
    >
      <div class="text-center">
        <p class="text-4xl mb-4">C</p>
        <p class="text-lg">Inspect SDK-native interactions in Cotta</p>
      </div>
    </div>


    <TimelineRow
      v-for="item in visibleTimelineItems"
      :key="item.key"
      :item="item"
    />

    <div v-if="pendingPermissionInteraction && !isPendingPermissionAttached" class="pl-7">
      <TimelineCanUseToolInteractionBlock :interaction="pendingPermissionInteraction" />
    </div>

    <div v-if="pendingElicitationInteraction && !isPendingElicitationAttached" class="pl-7">
      <TimelineElicitationInteractionBlock :interaction="pendingElicitationInteraction" />
    </div>
    <TimelineCliSubrow v-if="session.isLoading" muted>
      <div class="flex space-x-1.5 pt-0.5">
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 0ms" />
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 150ms" />
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 300ms" />
      </div>
    </TimelineCliSubrow>
  </div>
</template>
