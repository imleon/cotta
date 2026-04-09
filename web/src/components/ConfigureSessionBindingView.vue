<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()

const candidateOptions = computed(() => session.bindingCandidates)
const bindingEntries = computed(() => session.bindingList)

async function handleLoadBinding() {
  await session.fetchBindingStatus()
}

async function handleBind() {
  const ok = await session.bindConversationToSession(session.bindingTargetSessionId)
  if (ok) {
    await session.fetchBindingList()
  }
}

async function handleClear() {
  const ok = await session.clearBindingStatus()
  if (ok) {
    await session.fetchBindingList()
  }
}

async function handleRefreshBindings() {
  await session.fetchBindingList()
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-[var(--tt-surface-soft)]">
    <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 px-4 py-5 md:px-6 xl:px-8">
      <section class="rounded-3xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-5 shadow-sm">
        <div class="flex flex-col gap-4 md:flex-row md:items-end">
          <div class="w-full md:w-40">
            <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--tt-text-subtle)]">Channel</label>
            <select
              :value="session.bindingChannel"
              class="w-full rounded-xl border border-[var(--tt-border-strong)] bg-white/90 px-3 py-2.5 text-sm text-[var(--tt-text)]"
              @change="session.setBindingChannel(($event.target as HTMLSelectElement).value as 'lark' | 'web' | 'discord')"
            >
              <option value="lark">lark</option>
              <option value="web">web</option>
              <option value="discord">discord</option>
            </select>
          </div>

          <div class="flex-1">
            <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--tt-text-subtle)]">Conversation Key</label>
            <input
              :value="session.bindingConversationKey"
              type="text"
              placeholder="例如 chat_id"
              class="w-full rounded-xl border border-[var(--tt-border-strong)] bg-white/90 px-4 py-2.5 text-sm text-[var(--tt-text)]"
              @input="session.setBindingConversationKey(($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="handleLoadBinding"
            />
          </div>

          <button
            class="rounded-xl bg-[var(--tt-accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--tt-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="session.bindingLoading || !session.bindingConversationKey.trim()"
            @click="handleLoadBinding"
          >
            {{ session.bindingLoading ? 'Loading...' : 'Load Binding' }}
          </button>
        </div>

        <p v-if="session.bindingError" class="mt-3 text-sm text-[var(--tt-danger)]">{{ session.bindingError }}</p>
      </section>

      <section class="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <div class="rounded-3xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-5 shadow-sm">
          <div class="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-900">Bindings List</h2>
              <p class="mt-1 text-sm text-slate-500">浏览当前 channel 下所有 conversation 的绑定状态。</p>
            </div>
            <button
              class="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="session.bindingLoading"
              @click="handleRefreshBindings"
            >
              Refresh
            </button>
          </div>

          <div class="max-h-[38rem] space-y-2 overflow-y-auto">
            <button
              v-for="entry in bindingEntries"
              :key="`${entry.ref.channel}:${entry.ref.conversationKey}`"
              class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition-colors hover:border-sky-200 hover:bg-sky-50"
              @click="session.selectBindingEntry(entry)"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium text-slate-900">{{ entry.ref.conversationKey || '—' }}</div>
                  <div class="mt-1 truncate font-mono text-xs text-slate-500">{{ entry.binding?.sessionId || 'unbound' }}</div>
                  <div class="mt-1 truncate text-xs text-slate-500">{{ entry.session?.title || 'Untitled session' }}</div>
                </div>
                <span class="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500">
                  {{ entry.ref.channel }}
                </span>
              </div>
            </button>
            <div v-if="!bindingEntries.length" class="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
              暂无 bindings。
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-6">
          <div class="rounded-3xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-5 shadow-sm">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h2 class="text-lg font-semibold text-slate-900">Session Binding</h2>
                <p class="mt-1 text-sm text-slate-500">查看当前 conversation 绑定到哪个 Claude session。</p>
              </div>
              <span class="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                {{ session.bindingSummary }}
              </span>
            </div>

            <dl class="mt-5 space-y-4 text-sm">
              <div>
                <dt class="text-slate-500">Conversation</dt>
                <dd class="mt-1 font-mono text-slate-900">{{ session.bindingConversationKey || '—' }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Bound Session</dt>
                <dd class="mt-1 font-mono text-slate-900">{{ session.bindingStatus?.binding?.sessionId || '—' }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Session Title</dt>
                <dd class="mt-1 text-slate-900">{{ session.bindingStatus?.session?.title || '—' }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Active Run</dt>
                <dd class="mt-1 text-slate-900">
                  <template v-if="session.bindingStatus?.activeRun">
                    <span class="font-mono">{{ session.bindingStatus.activeRun.runId }}</span>
                    <span class="ml-2 text-slate-500">({{ session.bindingStatus.activeRun.state }})</span>
                  </template>
                  <template v-else>
                    —
                  </template>
                </dd>
              </div>
            </dl>

            <div class="mt-6 flex flex-wrap gap-3">
              <button
                class="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="session.bindingLoading || !session.bindingStatus?.binding?.sessionId"
                @click="session.bindingStatus?.binding?.sessionId && session.selectSession(session.bindingStatus.binding.sessionId)"
              >
                Open Session
              </button>
              <button
                class="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="session.bindingLoading || !session.bindingConversationKey.trim()"
                @click="handleClear"
              >
                Clear Binding
              </button>
            </div>
          </div>

          <div class="rounded-3xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-5 shadow-sm">
            <h2 class="text-lg font-semibold text-slate-900">Configure Binding</h2>
            <p class="mt-1 text-sm text-slate-500">将当前 conversation 绑定到一个已有 session。</p>

            <div class="mt-5 space-y-4">
              <div>
                <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Target Session ID</label>
                <input
                  :value="session.bindingTargetSessionId"
                  type="text"
                  placeholder="输入或从下方选择 session"
                  class="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-mono text-slate-900"
                  @input="session.setBindingTargetSessionId(($event.target as HTMLInputElement).value)"
                />
              </div>

              <div class="flex flex-wrap gap-3">
                <button
                  class="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="session.bindingLoading || !session.bindingConversationKey.trim() || !session.bindingTargetSessionId.trim()"
                  @click="handleBind"
                >
                  Bind Session
                </button>
                <button
                  class="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="session.bindingLoading"
                  @click="session.fetchBindingCandidates()"
                >
                  Refresh Candidates
                </button>
              </div>
            </div>

            <div class="mt-6">
              <div class="mb-3 flex items-center justify-between">
                <h3 class="text-sm font-semibold text-slate-900">Recent Sessions</h3>
                <span class="text-xs text-slate-500">{{ candidateOptions.length }} items</span>
              </div>
              <div class="max-h-[20rem] space-y-2 overflow-y-auto">
                <button
                  v-for="item in candidateOptions"
                  :key="item.id"
                  class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition-colors hover:border-sky-200 hover:bg-sky-50"
                  @click="session.applyBindingCandidate(item.id)"
                >
                  <div class="truncate text-sm font-medium text-slate-900">{{ item.title }}</div>
                  <div class="mt-1 truncate font-mono text-xs text-slate-500">{{ item.id }}</div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
