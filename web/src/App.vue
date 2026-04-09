<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionList from './components/SessionList.vue'
import MessageList from './components/MessageList.vue'
import InputBar from './components/InputBar.vue'
import TransportLogView from './components/TransportLogView.vue'
import StaticMetadataView from './components/StaticMetadataView.vue'
import ConfigureSessionBindingView from './components/ConfigureSessionBindingView.vue'
import logoUrl from './lib/logo.png'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const tokenInput = ref(session.authToken)
const activeView = ref<'session' | 'log' | 'metadata' | 'configure'>('session')
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
                  :class="activeView === 'metadata' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'metadata'"
                >
                  Metadata
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'configure' ? 'bg-[var(--tt-card)] text-[var(--tt-accent)] shadow-sm ring-1 ring-[var(--tt-border)]' : 'text-[var(--tt-text-subtle)] hover:text-[var(--tt-accent)]'"
                  @click="activeView = 'configure'"
                >
                  Configure
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
          <div v-if="activeView === 'session'" class="flex h-full min-w-0 bg-[color:color-mix(in_srgb,var(--tt-surface)_68%,white)]">
            <div
              v-if="sessionDrawerOpen"
              class="fixed inset-0 z-40 bg-[color:color-mix(in_srgb,var(--tt-accent)_32%,transparent)] backdrop-blur-[1px] md:hidden"
              @click="closeSessionDrawer"
            />

            <aside class="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] -translate-x-full border-r border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] text-[var(--tt-text)] shadow-2xl transition-transform md:static md:z-auto md:w-72 md:max-w-none md:translate-x-0 md:flex md:flex-col md:shadow-none"
              :class="sessionDrawerOpen ? 'translate-x-0' : ''"
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

          <div v-else-if="activeView === 'log'" class="h-full">
            <TransportLogView class="h-full" />
          </div>

          <div v-else-if="activeView === 'metadata'" class="h-full">
            <StaticMetadataView class="h-full" />
          </div>

          <div v-else class="h-full">
            <ConfigureSessionBindingView class="h-full" />
          </div>
        </main>
      </div>
    </template>
  </div>
</template>
