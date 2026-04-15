<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../stores/session'

const props = defineProps<{
  onSelect?: () => void
}>()

const sessionStore = useSessionStore()
const actionSessionId = ref<string | null>(null)
const actionKind = ref<'stop' | 'rebuild' | null>(null)

function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : ''
}

async function handleStopSession(id: string) {
  actionSessionId.value = id
  actionKind.value = 'stop'
  try {
    await sessionStore.stopSession(id)
  } finally {
    actionSessionId.value = null
    actionKind.value = null
  }
}

async function handleRebuildSession(id: string) {
  actionSessionId.value = id
  actionKind.value = 'rebuild'
  try {
    await sessionStore.rebuildSession(id)
  } finally {
    actionSessionId.value = null
    actionKind.value = null
  }
}

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
      <div
        v-for="item in sessionStore.sessions"
        :key="item.id"
        class="rounded-xl text-sm transition-colors"
        :class="
          sessionStore.currentSessionId === item.id
            ? 'border border-[var(--tt-border)] bg-[var(--tt-card)] font-medium text-[var(--tt-accent)] shadow-sm'
            : 'text-[var(--tt-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_82%,white)] hover:text-[var(--tt-accent)]'
        "
      >
        <button
          @click="handleSelectSession(item.id)"
          class="w-full px-3 py-3 text-left"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate">{{ item.title }}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1 text-[11px] font-normal text-[var(--tt-text-subtle)]">
                <span v-if="item.sessionStatus" class="rounded-full border border-[var(--tt-border)] px-1.5 py-0.5">
                  {{ item.sessionStatus }}
                </span>
                <span
                  v-if="item.sessionStatus === 'running' || item.sessionStatus === 'requires_action'"
                  class="rounded-full bg-[color:color-mix(in_srgb,var(--tt-warning)_18%,white)] px-1.5 py-0.5 text-[var(--tt-warning)]"
                >
                  busy
                </span>
                <span v-if="item.activeRunId">run {{ shortId(item.activeRunId) }}</span>
                <span v-if="item.workerRef">worker {{ shortId(item.workerRef) }}</span>
              </div>
              <div v-if="item.channelId || item.agentId" class="mt-1 truncate text-[11px] font-normal text-[var(--tt-text-subtle)]">
                <span v-if="item.agentId">{{ item.agentId }}</span>
                <span v-if="item.channelId"> · {{ item.channelId }}</span>
              </div>
            </div>
          </div>
        </button>
        <div
          v-if="sessionStore.currentSessionId === item.id"
          class="px-3 pb-3 flex gap-2"
        >
          <button
            class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] transition-colors hover:bg-[var(--tt-surface-soft)]"
            :disabled="actionSessionId === item.id"
            @click.stop="handleStopSession(item.id)"
          >
            {{ actionSessionId === item.id && actionKind === 'stop' ? 'Stopping...' : 'Stop' }}
          </button>
          <button
            class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] transition-colors hover:bg-[var(--tt-surface-soft)]"
            :disabled="actionSessionId === item.id"
            @click.stop="handleRebuildSession(item.id)"
          >
            {{ actionSessionId === item.id && actionKind === 'rebuild' ? 'Rebuilding...' : 'Rebuild' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
