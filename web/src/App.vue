<script setup lang="ts">
import { onMounted, ref } from 'vue'
import logoUrl from './lib/logo.png'
import LogPage from './pages/LogPage.vue'
import SessionPage from './pages/SessionPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import StatusPage from './pages/StatusPage.vue'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const tokenInput = ref(session.authToken)
const activeView = ref<'session' | 'log' | 'settings' | 'status'>('session')
const sessionDrawerOpen = ref(false)

function submitToken() {
  session.setAuthToken(tokenInput.value)
}

function clearToken() {
  tokenInput.value = ''
  session.clearAuthToken()
}

function closeSessionDrawer() {
  sessionDrawerOpen.value = false
}

function openSessionFromStatus(sessionId: string) {
  activeView.value = 'session'
  session.selectSession(sessionId)
}

onMounted(() => {
  session.initialize()
})
</script>

<template>
  <div class="h-screen bg-[var(--tt-surface-soft)]">
    <template v-if="!session.authChecked">
      <main class="h-full flex items-center justify-center text-sm text-[var(--tt-text-subtle)]">
        Checking server status...
      </main>
    </template>

    <template v-else-if="session.authRequired && !session.hasAuthToken">
      <main class="h-full flex items-center justify-center p-6">
        <div class="w-full max-w-md rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm p-6">
          <h1 class="text-xl font-semibold text-[var(--tt-accent)]">Cotta</h1>
          <p class="mt-2 text-sm text-[var(--tt-text-muted)]">请输入访问令牌以连接运行时。</p>
          <input
            v-model="tokenInput"
            type="password"
            placeholder="Access token"
            class="mt-4 w-full rounded-xl border border-[var(--tt-border-strong)] bg-white/90 px-4 py-3 text-sm text-[var(--tt-text)] focus:outline-none focus:ring-2 focus:ring-[color:var(--tt-coral)] focus:border-transparent"
            @keydown.enter.prevent="submitToken"
          />
          <button
            class="mt-4 w-full rounded-xl bg-[var(--tt-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--tt-primary-strong)] transition-colors"
            @click="submitToken"
          >
            Connect
          </button>
          <p v-if="session.authError" class="mt-3 text-sm text-[var(--tt-danger)]">{{ session.authError }}</p>
        </div>
      </main>
    </template>

    <template v-else>
      <div class="flex h-full flex-col">
        <header class="border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_90%,var(--tt-surface-soft))] backdrop-blur-sm">
          <div class="flex items-center justify-between gap-3 px-3 py-3 md:px-5 md:py-4 xl:px-6">
            <div class="flex min-w-0 items-center gap-3 md:gap-5">
              <button
                v-if="activeView === 'session'"
                class="md:hidden rounded-xl border border-[var(--tt-border)] bg-[var(--tt-card)] px-3 py-2 text-sm font-medium text-[var(--tt-text-muted)] shadow-sm transition-colors hover:bg-[var(--tt-surface-soft)]"
                @click="sessionDrawerOpen = true"
              >
                Sessions
              </button>
              <div class="flex min-w-0 items-center gap-3">
                <div class="min-w-0">
                  <img
                    :src="logoUrl"
                    alt="Cotta"
                    class="hidden h-10 w-auto object-contain md:block"
                  >
                  <div class="md:hidden text-base font-semibold tracking-tight text-[var(--tt-accent)]">Cotta</div>
                  <p class="hidden text-[11px] text-[var(--tt-text-subtle)] md:block">Cotta Grinds with Claude. You Enjoy Your Coffee.</p>
                </div>
              </div>
              <div class="flex items-center gap-2 overflow-x-auto rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_82%,white)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'session' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'session'"
                >
                  Session
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'log' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'log'"
                >
                  Log
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'settings' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'settings'"
                >
                  Settings
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'status' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'status'"
                >
                  Status
                </button>
              </div>
            </div>

            <div class="flex items-center gap-3 text-xs text-[var(--tt-text-subtle)] md:gap-4">
              <p v-if="session.authError" class="max-w-[14rem] truncate text-[var(--tt-danger)] md:max-w-none">{{ session.authError }}</p>
              <button
                v-if="session.authRequired"
                class="rounded-xl border border-[var(--tt-border)] bg-[var(--tt-card)] px-3 py-2 text-xs font-medium text-[var(--tt-text-muted)] shadow-sm transition-colors hover:bg-[var(--tt-surface-soft)] hover:text-[var(--tt-accent)]"
                @click="clearToken"
              >
                退出
              </button>
            </div>
          </div>
        </header>

        <main class="flex-1 min-h-0">
          <SessionPage
            v-if="activeView === 'session'"
            :session-drawer-open="sessionDrawerOpen"
            @close-session-drawer="closeSessionDrawer"
          />
          <LogPage v-else-if="activeView === 'log'" />
          <SettingsPage v-else-if="activeView === 'settings'" />
          <StatusPage v-else-if="activeView === 'status'" @open-session="openSessionFromStatus" />
        </main>
      </div>
    </template>
  </div>
</template>
