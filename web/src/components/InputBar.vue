<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const input = ref('')
const debugMetaVisible = computed({
  get: () => session.debugTimelineVisible,
  set: (value: boolean) => session.setDebugTimelineVisible(value),
})

function send() {
  const text = input.value.trim()
  if (!text || session.hasActiveRun || session.isAwaitingInteraction) return
  session.sendMessage(text)
  input.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="border-t border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_92%,var(--tt-surface-soft))] px-3 py-3 backdrop-blur-sm md:px-4 md:py-4">
    <div class="max-w-4xl mx-auto flex flex-col gap-3 sm:flex-row sm:items-start">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="!session.isConnected || session.hasActiveRun || session.isAwaitingInteraction"
        :placeholder="session.isAwaitingInteraction ? 'Waiting for interaction response...' : 'Send SDK-facing input... (Enter to send, Shift+Enter for new line)'"
        rows="1"
        class="flex-1 resize-none rounded-2xl border border-[var(--tt-border)] bg-white/90 px-4 py-3 text-sm text-[var(--tt-text)] shadow-sm transition focus:border-[var(--tt-coral)] focus:outline-none focus:ring-2 focus:ring-[color:color-mix(in_srgb,var(--tt-coral)_28%,white)] disabled:opacity-50"
      />
      <div class="flex items-center justify-end gap-2 sm:flex-col sm:items-end sm:gap-2">
        <button
          @click="send"
          :disabled="!input.trim() || session.hasActiveRun || !session.isConnected || session.isAwaitingInteraction"
          class="rounded-2xl bg-[var(--tt-accent)] px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-[var(--tt-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
        <button
          class="rounded-xl border border-[var(--tt-border)] bg-[var(--tt-card)] px-3 py-2 text-[12px] font-medium text-[var(--tt-text-muted)] shadow-sm transition hover:border-[var(--tt-border-strong)] hover:text-[var(--tt-accent)]"
          @click="debugMetaVisible = !debugMetaVisible"
        >
          {{ debugMetaVisible ? 'Hide debug' : 'Show debug' }}
        </button>
      </div>
    </div>
    <div v-if="session.authRequired && !session.hasAuthToken" class="mt-2 text-center text-xs text-[var(--tt-warning)]">
      Waiting for access token...
    </div>
    <div v-else-if="session.isAwaitingInteraction" class="mt-2 text-center text-xs text-[var(--tt-warning)]">
      Waiting for interaction response...
    </div>
    <div v-else-if="!session.isConnected" class="mt-2 text-center text-xs text-[var(--tt-danger)]">
      Disconnected — reconnecting...
    </div>
  </div>
</template>
