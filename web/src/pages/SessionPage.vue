<script setup lang="ts">
import InputBar from '../components/session/InputBar.vue'
import MessageList from '../components/session/MessageList.vue'
import SessionList from '../components/session/SessionList.vue'

const props = defineProps<{
  sessionDrawerOpen: boolean
}>()

const emit = defineEmits<{
  (event: 'close-session-drawer'): void
}>()

function closeSessionDrawer() {
  emit('close-session-drawer')
}
</script>

<template>
  <div class="flex h-full min-w-0 bg-[color:color-mix(in_srgb,var(--tt-surface)_68%,white)]">
    <div
      v-if="props.sessionDrawerOpen"
      class="fixed inset-0 z-40 bg-[color:color-mix(in_srgb,var(--tt-accent)_32%,transparent)] backdrop-blur-[1px] md:hidden"
      @click="closeSessionDrawer"
    />

    <aside class="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] -translate-x-full border-r border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] text-[var(--tt-text)] shadow-2xl transition-transform md:static md:z-auto md:w-72 md:max-w-none md:translate-x-0 md:flex md:flex-col md:shadow-none"
      :class="props.sessionDrawerOpen ? 'translate-x-0' : ''"
    >
      <div class="flex items-center justify-between border-b border-[var(--tt-border)] px-4 py-3 md:hidden">
        <span class="text-sm font-medium text-[var(--tt-accent)]">Sessions</span>
        <button class="rounded-lg border border-[var(--tt-border)] bg-white/80 px-2 py-1 text-xs text-[var(--tt-text-muted)]" @click="closeSessionDrawer">Close</button>
      </div>
      <SessionList class="flex-1 overflow-y-auto" :on-select="closeSessionDrawer" />
    </aside>

    <section class="flex-1 flex flex-col min-w-0 bg-[color:color-mix(in_srgb,var(--tt-card)_86%,white)] backdrop-blur-[1px] md:border-l md:border-[var(--tt-border)]">
      <MessageList class="flex-1 overflow-y-auto" />
      <InputBar class="border-t border-[var(--tt-border)]" />
    </section>
  </div>
</template>
