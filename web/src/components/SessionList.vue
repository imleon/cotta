<script setup lang="ts">
import { useSessionStore } from '../stores/session'

const props = defineProps<{
  onSelect?: () => void
}>()

const sessionStore = useSessionStore()

function handleNewChat() {
  sessionStore.newChat()
  props.onSelect?.()
}

function handleSelectSession(id: string) {
  sessionStore.selectSession(id)
  props.onSelect?.()
}
</script>

<template>
  <div class="flex h-full flex-col bg-[var(--tt-accent)] text-white">
    <div class="m-3 rounded-2xl border border-white/10 bg-white/6 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <button
        @click="handleNewChat"
        class="w-full rounded-xl bg-[var(--tt-primary)] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--tt-primary-strong)]"
      >
        + New Chat
      </button>
    </div>

    <div class="px-2 pb-3 space-y-1">
      <button
        v-for="item in sessionStore.sessions"
        :key="item.id"
        @click="handleSelectSession(item.id)"
        class="w-full text-left px-3 py-3 rounded-xl text-sm truncate transition-colors"
        :class="
          sessionStore.currentSessionId === item.id
            ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]'
            : 'text-[color:color-mix(in_srgb,var(--tt-surface)_82%,white)] hover:bg-white/10 hover:text-white'
        "
      >
        {{ item.title }}
      </button>
    </div>
  </div>
</template>
