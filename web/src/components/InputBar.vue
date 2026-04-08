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
  <div class="p-4 bg-white">
    <div class="max-w-4xl mx-auto flex gap-3 items-start">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="!session.isConnected || session.hasActiveRun || session.isAwaitingInteraction"
        :placeholder="session.isAwaitingInteraction ? 'Waiting for interaction response...' : 'Send SDK-facing input... (Enter to send, Shift+Enter for new line)'"
        rows="1"
        class="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
      />
      <div class="flex flex-col items-end gap-2">
        <button
          @click="send"
          :disabled="!input.trim() || session.hasActiveRun || !session.isConnected || session.isAwaitingInteraction"
          class="px-5 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
        <button
          class="timeline-cli-button"
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
