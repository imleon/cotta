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
  <div class="flex h-full flex-col bg-slate-950 text-white">
    <div class="m-3 rounded-2xl border border-white/10 bg-white/5 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <button
        @click="handleNewChat"
        class="w-full rounded-xl bg-sky-500 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-sky-400"
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
            ? 'bg-white text-slate-900 shadow-sm ring-1 ring-white/40'
            : 'text-slate-300 hover:bg-white/8 hover:text-white'
        "
      >
        {{ item.title }}
      </button>
    </div>
  </div>
</template>
