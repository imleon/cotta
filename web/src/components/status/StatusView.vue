<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../../api/http'
import { fetchStatusRequest } from '../../api/status'
import type { StatusResponse } from '../../api/types'
import { useSessionStore } from '../../stores/session'

const emit = defineEmits<{
  (e: 'open-session', sessionId: string): void
}>()

const session = useSessionStore()
const data = ref<StatusResponse | null>(null)
const isLoading = ref(false)
const loadError = ref('')

const agents = computed(() => data.value?.agents ?? [])
const runtime = computed(() => data.value?.runtime ?? null)
const refreshedAt = computed(() => {
  const value = data.value?.generatedAt
  return typeof value === 'number' ? new Date(value).toLocaleString() : '—'
})

function toneBadgeClass(tone: 'neutral' | 'ok' | 'warning' | 'danger') {
  if (tone === 'ok') {
    return 'border-[color:color-mix(in_srgb,var(--tt-success)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-success)_90%,var(--tt-text))]'
  }
  if (tone === 'warning') {
    return 'border-[color:color-mix(in_srgb,var(--tt-warning)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_12%,white)] text-[color:color-mix(in_srgb,var(--tt-warning)_88%,var(--tt-text))]'
  }
  if (tone === 'danger') {
    return 'border-[color:color-mix(in_srgb,var(--tt-danger)_26%,white)] bg-[color:color-mix(in_srgb,var(--tt-danger)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-danger)_88%,var(--tt-text))]'
  }
  return 'border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] text-[var(--tt-text-subtle)]'
}

function getSessionSummary(item: { title: string; summary?: string }): string {
  const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  return summary || title || 'No summary'
}

async function loadStatus() {
  isLoading.value = true
  loadError.value = ''
  try {
    const result = await fetchStatusRequest((input, init) => apiFetch(input, init, {
      authToken: session.authToken,
    }))
    if (!result.ok) {
      loadError.value = result.error || `Failed to load status (${result.status})`
      data.value = null
      return
    }
    data.value = result.data
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    data.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  void loadStatus()
})
</script>

<template>
  <div class="h-full overflow-y-auto bg-[color:color-mix(in_srgb,var(--tt-surface)_68%,white)] p-3 md:p-5 xl:p-6">
    <div class="mx-auto w-full max-w-6xl space-y-4">
      <div class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-5 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-lg font-semibold text-[var(--tt-accent)]">Status</h2>
            <p class="mt-1 text-sm text-[var(--tt-text-muted)]">Overview 只展示 Cotta 自身运行状态，不掺杂 Session 业务指标。</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full border px-2 py-1 text-xs font-medium" :class="toneBadgeClass(loadError ? 'danger' : 'ok')">
              {{ loadError ? 'Degraded' : 'Healthy' }}
            </span>
            <button
              class="rounded-xl border border-[var(--tt-border)] bg-[var(--tt-card)] px-3 py-2 text-sm font-medium text-[var(--tt-text-muted)] shadow-sm transition-colors hover:bg-[var(--tt-surface-soft)] hover:text-[var(--tt-accent)] disabled:opacity-50"
              :disabled="isLoading"
              @click="loadStatus"
            >
              Refresh
            </button>
          </div>
        </div>

        <div v-if="loadError" class="mt-4 rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-danger)_8%,white)] p-3 text-sm text-[var(--tt-danger)]">
          {{ loadError }}
        </div>

        <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-4">
            <div class="text-xs font-medium text-[var(--tt-text-subtle)]">Version</div>
            <div class="mt-2 text-xl font-semibold text-[var(--tt-accent)]">{{ runtime?.version || 'unknown' }}</div>
            <div class="mt-1 text-xs text-[var(--tt-text-subtle)]">Cotta package version</div>
          </div>

          <div class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-4">
            <div class="text-xs font-medium text-[var(--tt-text-subtle)]">Started At</div>
            <div class="mt-2 text-sm font-semibold text-[var(--tt-accent)]">
              {{ runtime?.startedAt ? new Date(runtime.startedAt).toLocaleString() : '—' }}
            </div>
            <div class="mt-1 text-xs text-[var(--tt-text-subtle)]">Refreshed {{ refreshedAt }}</div>
          </div>

          <div class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-4">
            <div class="text-xs font-medium text-[var(--tt-text-subtle)]">Runtime</div>
            <div class="mt-2 text-sm font-semibold text-[var(--tt-accent)]">
              {{ runtime ? `${runtime.host}:${runtime.port}` : '—' }}
            </div>
            <div class="mt-1 text-xs text-[var(--tt-text-subtle)]">
              pid {{ runtime?.pid ?? '—' }} · {{ runtime?.platform || '—' }} · {{ runtime?.nodeVersion || '—' }}
            </div>
          </div>

          <div class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-4">
            <div class="text-xs font-medium text-[var(--tt-text-subtle)]">Uptime</div>
            <div class="mt-2 text-xl font-semibold text-[var(--tt-accent)]">
              {{ typeof runtime?.uptimeSec === 'number' ? `${Math.floor(runtime.uptimeSec / 60)}m` : '—' }}
            </div>
          </div>

          <div class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-4">
            <div class="text-xs font-medium text-[var(--tt-text-subtle)]">Auth</div>
            <div class="mt-2">
              <span class="rounded-full border px-2 py-1 text-xs font-medium" :class="toneBadgeClass(runtime?.authEnabled ? 'warning' : 'neutral')">
                {{ runtime?.authEnabled ? 'enabled' : 'disabled' }}
              </span>
            </div>
            <div class="mt-2 text-xs text-[var(--tt-text-subtle)]">server access token protection</div>
          </div>
        </div>
      </div>

      <div class="space-y-3">
        <div class="flex items-center justify-between px-1">
          <div class="text-sm font-semibold text-[var(--tt-accent)]">Agents</div>
          <div class="text-xs text-[var(--tt-text-subtle)]">每个 Agent 一个框，里面列出该 Agent 的 Session</div>
        </div>

        <div v-if="agents.length === 0" class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-6 text-sm text-[var(--tt-text-subtle)]">
          暂无 Agent 状态数据。
        </div>

        <div v-for="agent in agents" :key="agent.agent.agentId" class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm">
          <div class="border-b border-[var(--tt-border)] px-4 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="text-base font-semibold text-[var(--tt-accent)]">{{ agent.agent.agentId }}</h3>
                  <span v-if="agent.agent.model" class="rounded-full border px-2 py-0.5 text-[11px]" :class="toneBadgeClass('neutral')">
                    {{ agent.agent.model }}
                  </span>
                  <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="toneBadgeClass(agent.counts.activeSessions > 0 ? 'warning' : 'ok')">
                    {{ agent.counts.sessions }} sessions
                  </span>
                  <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="toneBadgeClass('neutral')">
                    {{ agent.counts.channels }} channels
                  </span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--tt-text-subtle)]">
                  <span class="font-mono">{{ agent.agent.projectDir }}</span>
                  <span v-if="agent.agent.permissionMode">permission {{ agent.agent.permissionMode }}</span>
                  <span v-if="agent.agent.allowTools?.length">tools {{ agent.agent.allowTools.length }}</span>
                  <span v-if="agent.agent.allowSkills?.length">skills {{ agent.agent.allowSkills.length }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="p-2">
            <div v-if="agent.sessions.length === 0" class="p-3 text-sm text-[var(--tt-text-subtle)]">该 Agent 暂无 Session。</div>
            <div v-else class="space-y-1">
              <button
                v-for="item in agent.sessions"
                :key="item.sessionId"
                class="w-full rounded-lg border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] px-3 py-1.5 text-left transition-colors hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_82%,white)]"
                @click="emit('open-session', item.sessionId)"
              >
                <div class="flex items-center gap-2">
                  <div class="shrink-0 font-mono text-[10px] text-[var(--tt-text-subtle)]">
                    {{ item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—' }}
                  </div>
                  <div class="min-w-0 flex-1 truncate text-[13px] text-[var(--tt-text)]">
                    {{ getSessionSummary(item) }}
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <span v-if="item.channelId" class="rounded-full border px-1.5 py-0.5 text-[10px]" :class="toneBadgeClass('neutral')">
                      channel
                    </span>
                    <span
                      v-if="item.runtime?.sessionStatus === 'running'"
                      class="rounded-full border px-1.5 py-0.5 text-[10px]"
                      :class="toneBadgeClass('warning')"
                    >
                      running
                    </span>
                    <span
                      v-if="item.runtime?.sessionStatus === 'requires_action'"
                      class="rounded-full border px-1.5 py-0.5 text-[10px]"
                      :class="toneBadgeClass('danger')"
                    >
                      require_action
                    </span>
                  </div>
                  <div class="shrink-0 text-[10px] text-[var(--tt-text-subtle)]">
                    Open
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
