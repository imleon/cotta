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
  <div class="flex h-full flex-col bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] text-[var(--tt-text)]">
    <div class="m-3 rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_88%,var(--tt-surface-soft))] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
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
        class="w-full truncate rounded-xl px-3 py-3 text-left text-sm transition-colors"
        :class="
          sessionStore.currentSessionId === item.id
            ? 'border border-[var(--tt-border)] bg-[var(--tt-card)] font-medium text-[var(--tt-accent)] shadow-sm'
            : 'text-[var(--tt-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_82%,white)] hover:text-[var(--tt-accent)]'
        "
      >
        {{ item.title }}
      </button>
    </div>
  </div>
</template>
