<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionList from './components/SessionList.vue'
import MessageList from './components/MessageList.vue'
import InputBar from './components/InputBar.vue'
import TransportLogView from './components/TransportLogView.vue'
import StaticMetadataView from './components/StaticMetadataView.vue'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const tokenInput = ref(session.authToken)
const activeView = ref<'session' | 'log' | 'metadata'>('session')
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
  <div class="h-screen bg-gray-50">
    <template v-if="!session.authChecked">
      <main class="h-full flex items-center justify-center text-sm text-gray-500">
        Checking server status...
      </main>
    </template>

    <template v-else-if="session.authRequired && !session.hasAuthToken">
      <main class="h-full flex items-center justify-center p-6">
        <div class="w-full max-w-md rounded-2xl bg-white border border-gray-200 shadow-sm p-6">
          <h1 class="text-xl font-semibold text-gray-900">Cotta</h1>
          <p class="mt-2 text-sm text-gray-600">请输入访问令牌以连接运行时。</p>
          <input
            v-model="tokenInput"
            type="password"
            placeholder="Access token"
            class="mt-4 w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            @keydown.enter.prevent="submitToken"
          />
          <button
            class="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            @click="submitToken"
          >
            Connect
          </button>
          <p v-if="session.authError" class="mt-3 text-sm text-red-600">{{ session.authError }}</p>
        </div>
      </main>
    </template>

    <template v-else>
      <div class="flex h-full flex-col">
        <header class="border-b border-slate-200/80 bg-white/90 backdrop-blur-sm">
          <div class="flex items-center justify-between gap-3 px-3 py-3 md:px-5 md:py-4 xl:px-6">
            <div class="flex min-w-0 items-center gap-3 md:gap-5">
              <button
                v-if="activeView === 'session'"
                class="md:hidden rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
                @click="sessionDrawerOpen = true"
              >
                Sessions
              </button>
              <div class="flex min-w-0 items-center gap-3">
                <div class="hidden h-9 w-9 items-center justify-center rounded-2xl bg-slate-900 text-sm font-semibold text-white shadow-sm md:flex">C</div>
                <div class="min-w-0">
                  <h1 class="truncate text-base font-semibold tracking-tight text-slate-900 md:text-lg">Cotta</h1>
                  <p class="hidden text-[11px] text-slate-500 md:block">Inspect SDK-native interactions</p>
                </div>
              </div>
              <div class="flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-slate-100/80 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] overflow-x-auto">
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'session' ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80' : 'text-slate-500 hover:text-slate-900'"
                  @click="activeView = 'session'"
                >
                  Session
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'log' ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80' : 'text-slate-500 hover:text-slate-900'"
                  @click="activeView = 'log'"
                >
                  Log
                </button>
                <button
                  class="rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'metadata' ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80' : 'text-slate-500 hover:text-slate-900'"
                  @click="activeView = 'metadata'"
                >
                  Metadata
                </button>
              </div>
            </div>

            <div class="flex items-center gap-3 text-xs text-slate-500 md:gap-4">
              <p v-if="session.authError" class="max-w-[14rem] truncate text-rose-500 md:max-w-none">{{ session.authError }}</p>
              <button
                v-if="session.authRequired"
                class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900"
                @click="clearToken"
              >
                退出
              </button>
            </div>
          </div>
        </header>

        <main class="flex-1 min-h-0">
          <div v-if="activeView === 'session'" class="flex h-full min-w-0 bg-slate-100/70">
            <div
              v-if="sessionDrawerOpen"
              class="fixed inset-0 z-40 bg-slate-900/35 backdrop-blur-[1px] md:hidden"
              @click="closeSessionDrawer"
            />

            <aside class="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] -translate-x-full border-r border-slate-200/70 bg-slate-950 text-white shadow-2xl transition-transform md:static md:z-auto md:w-72 md:max-w-none md:translate-x-0 md:flex md:flex-col md:shadow-none"
              :class="sessionDrawerOpen ? 'translate-x-0' : ''"
            >
              <div class="flex items-center justify-between border-b border-white/10 px-4 py-3 md:hidden">
                <span class="text-sm font-medium text-slate-100">Sessions</span>
                <button class="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300" @click="closeSessionDrawer">Close</button>
              </div>
              <SessionList class="flex-1 overflow-y-auto" :on-select="closeSessionDrawer" />
            </aside>

            <section class="flex-1 flex flex-col min-w-0 bg-white/75 backdrop-blur-[1px] md:border-l md:border-slate-200/60">
              <MessageList class="flex-1 overflow-y-auto" />
              <InputBar class="border-t border-slate-200/80" />
            </section>
          </div>

          <div v-else-if="activeView === 'log'" class="h-full">
            <TransportLogView class="h-full" />
          </div>

          <div v-else class="h-full">
            <StaticMetadataView class="h-full" />
          </div>
        </main>
      </div>
    </template>
  </div>
</template>
