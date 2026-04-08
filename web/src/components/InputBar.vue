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
  <div class="border-t border-slate-200/80 bg-white/90 px-3 py-3 backdrop-blur-sm md:px-4 md:py-4">
    <div class="max-w-4xl mx-auto flex flex-col gap-3 sm:flex-row sm:items-start">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="!session.isConnected || session.hasActiveRun || session.isAwaitingInteraction"
        :placeholder="session.isAwaitingInteraction ? 'Waiting for interaction response...' : 'Send SDK-facing input... (Enter to send, Shift+Enter for new line)'"
        rows="1"
        class="flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm transition focus:border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-100 disabled:opacity-50"
      />
      <div class="flex items-center justify-end gap-2 sm:flex-col sm:items-end sm:gap-2">
        <button
          @click="send"
          :disabled="!input.trim() || session.hasActiveRun || !session.isConnected || session.isAwaitingInteraction"
          class="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
        <button
          class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-500 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
          @click="debugMetaVisible = !debugMetaVisible"
        >
          {{ debugMetaVisible ? 'Hide debug' : 'Show debug' }}
        </button>
      </div>
    </div>
    <div v-if="session.authRequired && !session.hasAuthToken" class="text-center text-xs text-amber-600 mt-2">
      Waiting for access token...
    </div>
    <div v-else-if="session.isAwaitingInteraction" class="text-center text-xs text-amber-600 mt-2">
      Waiting for interaction response...
    </div>
    <div v-else-if="!session.isConnected" class="text-center text-xs text-red-500 mt-2">
      Disconnected — reconnecting...
    </div>
  </div>
</template>
