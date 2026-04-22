<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../../api/http'
import {
  fetchConfigOverviewRequest,
  saveConfigOverviewRequest,
  type AgentConfig,
  type ChannelConfig,
  type ConnectorConfig,
  type RuntimeConfig,
} from '../../api/config'
import {
  fetchChannelBindingsRequest,
  type ChannelSessionBindingItem,
} from '../../api/channel-bindings'
import { useSessionStore } from '../../stores/session'

const session = useSessionStore()
const isLoading = ref(false)
const isSaving = ref(false)
const loadError = ref('')
const saveError = ref('')
const saveNotice = ref('')
const isBindingOverviewLoading = ref(false)

const config = ref<RuntimeConfig>({ connectors: [], channels: [], agents: [] })
const channelBindingsById = ref<Record<string, ChannelSessionBindingItem>>({})

const statusBadgeClass = computed(() => {
  if (saveError.value) {
    return 'border-[color:color-mix(in_srgb,var(--tt-danger)_26%,white)] bg-[color:color-mix(in_srgb,var(--tt-danger)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-danger)_88%,var(--tt-text))]'
  }
  if (isSaving.value) {
    return 'border-[color:color-mix(in_srgb,var(--tt-warning)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_12%,white)] text-[color:color-mix(in_srgb,var(--tt-warning)_88%,var(--tt-text))]'
  }
  return 'border-[color:color-mix(in_srgb,var(--tt-success)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-success)_90%,var(--tt-text))]'
})

type KvRow = { key: string; value: string }

function recordToRows(record: Record<string, unknown> | undefined): KvRow[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }))
}

function rowsToRecord(rows: KvRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    const raw = row.value.trim()
    if (!raw) {
      out[key] = ''
      continue
    }
    // Try JSON first so numbers/booleans/objects can round-trip.
    try {
      out[key] = JSON.parse(raw)
    } catch {
      out[key] = raw
    }
  }
  return out
}

function rowsToStringRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return out
}

function splitCsv(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function toChannelBindingsMap(items: ChannelSessionBindingItem[]): Record<string, ChannelSessionBindingItem> {
  return Object.fromEntries(items.map((item) => [item.channelId, item]))
}

async function loadChannelBindings() {
  isBindingOverviewLoading.value = true
  try {
    const result = await fetchChannelBindingsRequest((input, init) => apiFetch(input, init, {
      authToken: session.authToken,
    }))
    if (!result.ok) {
      saveError.value = result.error || `Failed to load channel bindings (${result.status})`
      return
    }
    channelBindingsById.value = toChannelBindingsMap(result.data)
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isBindingOverviewLoading.value = false
  }
}

function getChannelBinding(channelId: string): ChannelSessionBindingItem | null {
  return channelBindingsById.value[channelId] ?? null
}

async function loadSettings() {
  isLoading.value = true
  loadError.value = ''
  saveError.value = ''
  saveNotice.value = ''
  try {
    const result = await fetchConfigOverviewRequest((input, init) => apiFetch(input, init, {
      authToken: session.authToken,
    }))
    if (!result.ok) {
      loadError.value = result.error || `Failed to load settings (${result.status})`
      return
    }
    const data = result.data
    if (!data) {
      loadError.value = 'Failed to load settings'
      return
    }
    config.value = data.config
    await loadChannelBindings()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

function validateConfig(nextConfig: RuntimeConfig): string[] {
  const errors: string[] = []
  const connectorIds = new Set(nextConfig.connectors.map((c) => c.connectorId))
  const agentIds = new Set(nextConfig.agents.map((a) => a.agentId))
  const sessionIds = new Set<string>()
  for (const ch of nextConfig.channels) {
    if (!connectorIds.has(ch.connectorId)) errors.push(`Channel ${ch.channelId}: connectorId 不存在 (${ch.connectorId})`)
    if (!agentIds.has(ch.agentId)) errors.push(`Channel ${ch.channelId}: agentId 不存在 (${ch.agentId})`)
    if (!ch.channelKey) errors.push(`Channel ${ch.channelId}: channelKey 不能为空`)
    if (ch.currentSdkSessionId) {
      if (sessionIds.has(ch.currentSdkSessionId)) {
        errors.push(`Channel ${ch.channelId}: currentSdkSessionId 已被其他 Channel 使用 (${ch.currentSdkSessionId})`)
      }
      sessionIds.add(ch.currentSdkSessionId)
    }
  }
  for (const a of nextConfig.agents) {
    if (!a.projectDir) errors.push(`Agent ${a.agentId}: projectDir 不能为空`)
  }
  return errors
}

async function persistConfig(nextConfig: RuntimeConfig, notice: string) {
  saveError.value = ''
  const errors = validateConfig(nextConfig)
  if (errors.length > 0) {
    saveError.value = errors.join('；')
    return false
  }
  isSaving.value = true
  try {
    const result = await saveConfigOverviewRequest((input, init) => apiFetch(input, init, {
      authToken: session.authToken,
    }), nextConfig)
    if (!result.ok) {
      saveError.value = result.error || `Failed to save settings (${result.status})`
      return false
    }
    config.value = nextConfig
    await loadChannelBindings()
    saveNotice.value = notice
    return true
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    isSaving.value = false
  }
}

// Structured editor modal
const editorOpen = ref(false)
const editorKind = ref<'connector' | 'channel' | 'agent'>('channel')
const editorIndex = ref<number>(-1)
const editorTitle = ref('')
const editorError = ref('')

const formConnectorId = ref('')
const formConnectorType = ref('lark')
const formConnectorConfigRows = ref<KvRow[]>([])

const formChannelId = ref('')
const formChannelName = ref('')
const formChannelKey = ref('')
const formChannelConnectorId = ref('')
const formChannelAgentId = ref('')
const formChannelCurrentSdkSessionId = ref('')
const formChannelEnabled = ref(true)

const formAgentId = ref('')
const formAgentName = ref('')
const formAgentProjectDir = ref('')
const formAgentModel = ref('')
const formAgentEffort = ref('')
const formAgentPermissionMode = ref('')
const formAgentAllowToolsCsv = ref('')
const formAgentAllowSkillsCsv = ref('')
const formAgentEnvRows = ref<KvRow[]>([])
const formAgentMcpServersRows = ref<KvRow[]>([])
const formAgentPromptConfigRows = ref<KvRow[]>([])
const formAgentThinkingRows = ref<KvRow[]>([])

const connectorOptions = computed(() => config.value.connectors.map((c) => ({ id: c.connectorId, type: c.connectorType })))
const agentOptions = computed(() => config.value.agents.map((a) => ({ id: a.agentId, name: a.agentName || a.agentId })))
const currentEditingChannelId = computed(() => {
  if (editorKind.value !== 'channel') return ''
  return editorIndex.value >= 0 ? (config.value.channels[editorIndex.value]?.channelId ?? '') : formChannelId.value.trim()
})
const currentEditingChannelBinding = computed(() => {
  const channelId = currentEditingChannelId.value
  return channelId ? getChannelBinding(channelId) : null
})
const currentEditingChannelSessionOptions = computed(() => {
  const currentValue = formChannelCurrentSdkSessionId.value.trim()
  const items = currentEditingChannelBinding.value?.candidateSessions ?? []
  return items.map((candidate) => ({
    value: candidate.sessionId,
    label: candidate.title || candidate.sessionId,
    claimedByChannelId: candidate.claimedByChannelId,
    disabled: Boolean(candidate.claimedByChannelId) && candidate.sessionId !== currentValue,
    isCurrent: candidate.isCurrent,
    updatedAt: candidate.updatedAt,
  }))
})

function resetEditorForms() {
  formConnectorId.value = ''
  formConnectorType.value = 'lark'
  formConnectorConfigRows.value = []

  formChannelId.value = ''
  formChannelName.value = ''
  formChannelKey.value = ''
  formChannelConnectorId.value = ''
  formChannelAgentId.value = ''
  formChannelCurrentSdkSessionId.value = ''
  formChannelEnabled.value = true

  formAgentId.value = ''
  formAgentName.value = ''
  formAgentProjectDir.value = ''
  formAgentModel.value = ''
  formAgentEffort.value = ''
  formAgentPermissionMode.value = ''
  formAgentAllowToolsCsv.value = ''
  formAgentAllowSkillsCsv.value = ''
  formAgentEnvRows.value = []
  formAgentMcpServersRows.value = []
  formAgentPromptConfigRows.value = []
  formAgentThinkingRows.value = []
}

function openConnectorEditor(index: number) {
  editorKind.value = 'connector'
  editorIndex.value = index
  const c = config.value.connectors[index]
  editorTitle.value = c ? `Edit Connector · ${c.connectorId}` : 'New Connector'
  resetEditorForms()
  formConnectorId.value = c?.connectorId ?? ''
  formConnectorType.value = c?.connectorType ?? 'lark'
  formConnectorConfigRows.value = recordToRows(c?.connectorConfig)
  editorError.value = ''
  editorOpen.value = true
}

function openChannelEditor(index: number) {
  editorKind.value = 'channel'
  editorIndex.value = index
  const ch = config.value.channels[index]
  editorTitle.value = ch ? `Edit Channel · ${ch.channelId}` : 'New Channel'
  resetEditorForms()
  formChannelId.value = ch?.channelId ?? ''
  formChannelName.value = ch?.channelName ?? ''
  formChannelKey.value = ch?.channelKey ?? ''
  formChannelConnectorId.value = ch?.connectorId ?? (connectorOptions.value[0]?.id ?? '')
  formChannelAgentId.value = ch?.agentId ?? (agentOptions.value[0]?.id ?? '')
  formChannelCurrentSdkSessionId.value = ch?.currentSdkSessionId ?? ''
  formChannelEnabled.value = ch?.enabled ?? true
  editorError.value = ''
  editorOpen.value = true
}

function openAgentEditor(index: number) {
  editorKind.value = 'agent'
  editorIndex.value = index
  const a = config.value.agents[index]
  editorTitle.value = a ? `Edit Agent · ${a.agentId}` : 'New Agent'
  resetEditorForms()
  formAgentId.value = a?.agentId ?? ''
  formAgentName.value = a?.agentName ?? ''
  formAgentProjectDir.value = a?.projectDir ?? ''
  formAgentModel.value = a?.modelJson?.model ?? ''
  formAgentEffort.value = a?.modelJson?.effort ?? ''
  formAgentPermissionMode.value = a?.permissionMode ?? ''
  formAgentAllowToolsCsv.value = (a?.allowToolsJson ?? []).join(', ')
  formAgentAllowSkillsCsv.value = (a?.allowSkillsJson ?? []).join(', ')
  formAgentEnvRows.value = Object.entries(a?.envJson ?? {}).map(([key, value]) => ({ key, value }))
  formAgentMcpServersRows.value = recordToRows(a?.mcpServersJson)
  formAgentPromptConfigRows.value = recordToRows(a?.promptConfigJson)
  const thinking = a?.modelJson?.thinking
  formAgentThinkingRows.value = thinking && typeof thinking === 'object' && !Array.isArray(thinking)
    ? recordToRows(thinking as Record<string, unknown>)
    : []
  editorError.value = ''
  editorOpen.value = true
}

function addNew(kind: 'connector' | 'channel' | 'agent') {
  if (kind === 'connector') {
    editorKind.value = 'connector'
    editorIndex.value = -1
    editorTitle.value = 'New Connector'
    resetEditorForms()
    formConnectorType.value = 'lark'
    editorError.value = ''
    editorOpen.value = true
    return
  }
  if (kind === 'channel') {
    editorKind.value = 'channel'
    editorIndex.value = -1
    editorTitle.value = 'New Channel'
    resetEditorForms()
    formChannelConnectorId.value = connectorOptions.value[0]?.id ?? ''
    formChannelAgentId.value = agentOptions.value[0]?.id ?? ''
    formChannelEnabled.value = true
    editorError.value = ''
    editorOpen.value = true
    return
  }
  editorKind.value = 'agent'
  editorIndex.value = -1
  editorTitle.value = 'New Agent'
  resetEditorForms()
  editorError.value = ''
  editorOpen.value = true
}

async function removeAt(kind: 'connector' | 'channel' | 'agent', index: number) {
  const nextConfig: RuntimeConfig = {
    connectors: [...config.value.connectors],
    channels: [...config.value.channels],
    agents: [...config.value.agents],
  }
  if (kind === 'connector') nextConfig.connectors.splice(index, 1)
  else if (kind === 'channel') nextConfig.channels.splice(index, 1)
  else nextConfig.agents.splice(index, 1)

  await persistConfig(nextConfig, '已删除并保存到 SQLite。提示：运行时配置通常需要重启服务才能完全生效。')
}

async function saveEditor() {
  editorError.value = ''
  saveNotice.value = ''
  if (editorKind.value === 'connector') {
    const connectorId = formConnectorId.value.trim()
    if (!connectorId) { editorError.value = 'connectorId 不能为空'; return }
    const next: ConnectorConfig = {
      connectorId,
      connectorType: 'lark',
      connectorConfig: rowsToRecord(formConnectorConfigRows.value),
    }
    const nextConfig: RuntimeConfig = {
      ...config.value,
      connectors: editorIndex.value >= 0
        ? config.value.connectors.map((item, index) => (index === editorIndex.value ? next : item))
        : [next, ...config.value.connectors],
    }
    if (await persistConfig(nextConfig, '已保存到 SQLite。提示：运行时配置通常需要重启服务才能完全生效。')) {
      editorOpen.value = false
    }
    return
  }

  if (editorKind.value === 'channel') {
    const channelId = formChannelId.value.trim()
    const channelKey = formChannelKey.value.trim()
    if (!channelId) { editorError.value = 'channelId 不能为空'; return }
    if (!channelKey) { editorError.value = 'channelKey 不能为空'; return }
    const selectedSessionId = formChannelCurrentSdkSessionId.value.trim()
    const conflictingOption = currentEditingChannelSessionOptions.value.find((option) => option.value === selectedSessionId && option.disabled)
    if (conflictingOption) {
      editorError.value = `Session 已被其他 Channel 占用：${conflictingOption.claimedByChannelId}`
      return
    }
    const next: ChannelConfig = {
      channelId,
      channelKey,
      channelName: formChannelName.value.trim() ? formChannelName.value.trim() : undefined,
      connectorId: formChannelConnectorId.value,
      agentId: formChannelAgentId.value,
      enabled: Boolean(formChannelEnabled.value),
      ...(selectedSessionId ? { currentSdkSessionId: selectedSessionId } : {}),
    }
    const nextConfig: RuntimeConfig = {
      ...config.value,
      channels: editorIndex.value >= 0
        ? config.value.channels.map((item, index) => (index === editorIndex.value ? next : item))
        : [next, ...config.value.channels],
    }
    if (await persistConfig(nextConfig, '已保存到 SQLite。提示：运行时配置通常需要重启服务才能完全生效。')) {
      editorOpen.value = false
    }
    return
  }

  const agentId = formAgentId.value.trim()
  if (!agentId) { editorError.value = 'agentId 不能为空'; return }
  const projectDir = formAgentProjectDir.value.trim()
  if (!projectDir) { editorError.value = 'projectDir 不能为空'; return }
  const allowTools = splitCsv(formAgentAllowToolsCsv.value)
  const allowSkills = splitCsv(formAgentAllowSkillsCsv.value)
  const thinking = rowsToRecord(formAgentThinkingRows.value)
  const next: AgentConfig = {
    agentId,
    agentName: formAgentName.value.trim() ? formAgentName.value.trim() : undefined,
    projectDir,
    modelJson: {
      ...(formAgentModel.value.trim() ? { model: formAgentModel.value.trim() } : {}),
      ...(formAgentEffort.value.trim() ? { effort: formAgentEffort.value.trim() } : {}),
      ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
    },
    ...(formAgentPermissionMode.value.trim() ? { permissionMode: formAgentPermissionMode.value.trim() } : {}),
    ...(allowTools.length > 0 ? { allowToolsJson: allowTools } : {}),
    ...(allowSkills.length > 0 ? { allowSkillsJson: allowSkills } : {}),
    ...(formAgentEnvRows.value.length > 0 ? { envJson: rowsToStringRecord(formAgentEnvRows.value) } : {}),
    ...(formAgentMcpServersRows.value.length > 0 ? { mcpServersJson: rowsToRecord(formAgentMcpServersRows.value) } : {}),
    ...(formAgentPromptConfigRows.value.length > 0 ? { promptConfigJson: rowsToRecord(formAgentPromptConfigRows.value) } : {}),
  }
  const nextConfig: RuntimeConfig = {
    ...config.value,
    agents: editorIndex.value >= 0
      ? config.value.agents.map((item, index) => (index === editorIndex.value ? next : item))
      : [next, ...config.value.agents],
  }
  if (await persistConfig(nextConfig, '已保存到 SQLite。提示：运行时配置通常需要重启服务才能完全生效。')) {
    editorOpen.value = false
  }
}

onMounted(() => {
  void loadSettings()
})
</script>

<template>
  <div class="h-full bg-[color:color-mix(in_srgb,var(--tt-surface)_68%,white)]">
    <div class="h-full overflow-y-auto p-3 md:p-5 xl:p-6">
      <div class="mx-auto w-full max-w-6xl">
        <div class="sticky top-0 z-10 -mx-3 mb-4 bg-[color:color-mix(in_srgb,var(--tt-surface-soft)_92%,white)] px-3 pb-3 pt-2 backdrop-blur-sm md:-mx-5 md:px-5 xl:-mx-6 xl:px-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-lg font-semibold text-[var(--tt-accent)]">Settings</h2>
                <span v-if="saveError || isSaving" class="rounded-full border px-2 py-1 text-xs font-medium" :class="statusBadgeClass">
                  {{ saveError ? 'Invalid' : 'Saving' }}
                </span>
              </div>
              <p class="mt-1 text-sm text-[var(--tt-text-muted)]">
                结构化编辑运行时配置：Connector / Channel / Agent。保存会写入 <span class="font-mono">SQLite</span> 配置库。
              </p>
            </div>
          </div>
        </div>

        <div v-if="loadError" class="mb-4 rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-4 text-sm text-[var(--tt-danger)]">
          {{ loadError }}
        </div>

        <div v-if="saveNotice" class="mb-4 rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-4 text-sm text-[var(--tt-text)]">
          {{ saveNotice }}
        </div>

        <div v-if="saveError" class="mb-4 rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] p-4 text-sm text-[var(--tt-danger)]">
          {{ saveError }}
        </div>

        <div class="space-y-4">
        <div class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm">
          <div class="flex items-center justify-between border-b border-[var(--tt-border)] px-4 py-3">
            <div class="text-sm font-semibold text-[var(--tt-accent)]">Agents</div>
            <button class="rounded-xl bg-[var(--tt-primary)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--tt-primary-strong)]" @click="addNew('agent')">
              + Add Agent
            </button>
          </div>
          <div class="p-2">
            <div v-if="config.agents.length === 0" class="p-6 text-sm text-[var(--tt-text-subtle)]">暂无 Agent。</div>
            <div v-else class="space-y-2">
              <div v-for="(a, idx) in config.agents" :key="a.agentId" class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="font-medium text-[var(--tt-accent)]">{{ a.agentName || a.agentId }}</div>
                    <div class="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--tt-text-subtle)]">
                      <span>id: <span class="font-mono">{{ a.agentId }}</span></span>
                      <span>dir: <span class="font-mono">{{ a.projectDir }}</span></span>
                      <span v-if="a.modelJson?.model">model: <span class="font-mono">{{ a.modelJson.model }}</span></span>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="openAgentEditor(idx)">
                      Edit
                    </button>
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="removeAt('agent', idx)">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm">
          <div class="flex items-center justify-between border-b border-[var(--tt-border)] px-4 py-3">
            <div class="text-sm font-semibold text-[var(--tt-accent)]">Connectors</div>
            <button class="rounded-xl bg-[var(--tt-primary)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--tt-primary-strong)]" @click="addNew('connector')">
              + Add Connector
            </button>
          </div>
          <div class="p-2">
            <div v-if="config.connectors.length === 0" class="p-6 text-sm text-[var(--tt-text-subtle)]">暂无 Connector。</div>
            <div v-else class="space-y-2">
              <div v-for="(c, idx) in config.connectors" :key="c.connectorId" class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="font-medium text-[var(--tt-accent)]">{{ c.connectorId }}</div>
                    <div class="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--tt-text-subtle)]">
                      <span>type: <span class="font-mono">{{ c.connectorType }}</span></span>
                      <span>config keys: {{ Object.keys(c.connectorConfig || {}).length }}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="openConnectorEditor(idx)">
                      Edit
                    </button>
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="removeAt('connector', idx)">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm">
          <div class="flex items-center justify-between border-b border-[var(--tt-border)] px-4 py-3">
            <div class="text-sm font-semibold text-[var(--tt-accent)]">Channels</div>
            <button class="rounded-xl bg-[var(--tt-primary)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--tt-primary-strong)]" @click="addNew('channel')">
              + Add Channel
            </button>
          </div>
          <div class="p-2">
            <div v-if="config.channels.length === 0" class="p-6 text-sm text-[var(--tt-text-subtle)]">暂无 Channel。</div>
            <div v-else class="space-y-2">
              <div v-for="(ch, idx) in config.channels" :key="ch.channelId" class="rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-card)_96%,white)] p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <div class="font-medium text-[var(--tt-accent)]">{{ ch.channelName || ch.channelId }}</div>
                      <span class="rounded-full border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_76%,white)] px-2 py-0.5 text-[11px] text-[var(--tt-text-subtle)]">
                        {{ ch.enabled ? 'enabled' : 'disabled' }}
                      </span>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--tt-text-subtle)]">
                      <span class="font-mono">{{ ch.channelKey }}</span>
                      <span>connector: <span class="font-mono">{{ ch.connectorId }}</span></span>
                      <span>agent: <span class="font-mono">{{ ch.agentId }}</span></span>
                    </div>
                    <div class="mt-3 rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] p-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--tt-text-subtle)]">Session</div>
                          <div v-if="getChannelBinding(ch.channelId)?.boundSession" class="mt-1">
                            <div class="text-sm font-medium text-[var(--tt-accent)]">
                              {{ getChannelBinding(ch.channelId)?.boundSession?.title || getChannelBinding(ch.channelId)?.boundSession?.sessionId }}
                            </div>
                            <div class="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--tt-text-subtle)]">
                              <span class="font-mono">{{ getChannelBinding(ch.channelId)?.boundSession?.sessionId }}</span>
                              <span>
                                updated:
                                {{ getChannelBinding(ch.channelId)?.boundSession?.updatedAt ? new Date(getChannelBinding(ch.channelId)!.boundSession!.updatedAt).toLocaleString() : '—' }}
                              </span>
                              <span v-if="getChannelBinding(ch.channelId)?.boundSession?.sessionStatus">
                                status: {{ getChannelBinding(ch.channelId)?.boundSession?.sessionStatus }}
                              </span>
                            </div>
                          </div>
                          <div v-else class="mt-1 text-sm text-[var(--tt-text-subtle)]">
                            {{ isBindingOverviewLoading ? '加载中…' : '当前未绑定 Session' }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="openChannelEditor(idx)">
                      Edit
                    </button>
                    <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="removeAt('channel', idx)">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>

        <div v-if="editorOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-[color:color-mix(in_srgb,var(--tt-accent)_28%,transparent)] backdrop-blur-[1px]" @click="editorOpen = false" />
          <div class="relative z-10 w-full max-w-3xl overflow-hidden rounded-3xl border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-2xl">
            <div class="flex items-center justify-between border-b border-[var(--tt-border)] px-5 py-4">
              <div class="text-sm font-semibold text-[var(--tt-accent)]">{{ editorTitle }}</div>
              <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="editorOpen = false">
                Close
              </button>
            </div>
            <div class="max-h-[min(80vh,900px)] overflow-y-auto p-5">
              <div v-if="editorError" class="mt-3 rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-danger)_8%,white)] p-3 text-sm text-[var(--tt-danger)]">
                {{ editorError }}
              </div>

              <div class="mt-3 space-y-4">
                <template v-if="editorKind === 'channel'">
                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">channelId</div>
                      <input v-model="formChannelId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">channelName (optional)</div>
                      <input v-model="formChannelName" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1 md:col-span-2">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">channelKey</div>
                      <input v-model="formChannelKey" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">connectorId</div>
                      <select v-model="formChannelConnectorId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm">
                        <option v-for="c in connectorOptions" :key="c.id" :value="c.id">{{ c.id }} ({{ c.type }})</option>
                      </select>
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">agentId</div>
                      <select v-model="formChannelAgentId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm">
                        <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name }}</option>
                      </select>
                    </label>
                    <div class="space-y-2 rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] p-3 md:col-span-2">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-xs font-medium text-[var(--tt-text-subtle)]">currentSdkSessionId</div>
                          <div class="mt-1 text-[12px] text-[var(--tt-text-subtle)]">
                            留空表示下次收到 prompt 时自动新建 Session 并绑定。
                          </div>
                        </div>
                        <button
                          class="rounded-lg border border-[var(--tt-border)] bg-white px-3 py-2 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]"
                          type="button"
                          @click="formChannelCurrentSdkSessionId = ''"
                        >
                          设为自动
                        </button>
                      </div>
                      <select v-model="formChannelCurrentSdkSessionId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono">
                        <option value="">(auto-create on next prompt)</option>
                        <option
                          v-for="option in currentEditingChannelSessionOptions"
                          :key="option.value"
                          :value="option.value"
                          :disabled="option.disabled"
                        >
                          {{ option.label }}{{ option.isCurrent ? ' [current]' : '' }}{{ option.claimedByChannelId ? ` [claimed by ${option.claimedByChannelId}]` : '' }}
                        </option>
                      </select>
                      <div v-if="currentEditingChannelSessionOptions.length > 0" class="space-y-1 text-[12px] text-[var(--tt-text-subtle)]">
                        <div v-for="option in currentEditingChannelSessionOptions" :key="`option-${option.value}`">
                          <span class="font-mono">{{ option.value }}</span>
                          <span> · updated: {{ new Date(option.updatedAt).toLocaleString() }}</span>
                          <span v-if="option.claimedByChannelId"> · 已被 <span class="font-mono">{{ option.claimedByChannelId }}</span> 占用</span>
                        </div>
                      </div>
                      <div v-else class="text-[12px] text-[var(--tt-text-subtle)]">
                        当前 Agent 下还没有可选 Session。
                      </div>
                    </div>
                    <label class="flex items-center justify-between rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] px-3 py-2 md:col-span-2">
                      <div class="text-sm text-[var(--tt-text)]">Enabled</div>
                      <input v-model="formChannelEnabled" type="checkbox" class="h-4 w-4 accent-[var(--tt-primary)]" />
                    </label>
                  </div>
                </template>

                <template v-else-if="editorKind === 'connector'">
                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">connectorId</div>
                      <input v-model="formConnectorId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">connectorType</div>
                      <input value="lark" disabled class="w-full rounded-xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_78%,white)] px-3 py-2 text-sm font-mono text-[var(--tt-text-subtle)]" />
                    </label>
                  </div>

                  <div class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] p-3">
                    <div class="flex items-center justify-between">
                      <div class="text-sm font-semibold text-[var(--tt-accent)]">connectorConfig</div>
                      <button
                        class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]"
                        @click="formConnectorConfigRows.push({ key: '', value: '' })"
                      >
                        + Add
                      </button>
                    </div>
                    <div class="mt-2 space-y-2">
                      <div v-for="(row, i) in formConnectorConfigRows" :key="i" class="grid gap-2 md:grid-cols-[180px_1fr_64px]">
                        <input v-model="row.key" placeholder="key" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                        <input v-model="row.value" placeholder="value (JSON or string)" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                        <button class="rounded-xl border border-[var(--tt-border)] bg-white px-3 py-2 text-sm text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="formConnectorConfigRows.splice(i, 1)">
                          Del
                        </button>
                      </div>
                    </div>
                  </div>
                </template>

                <template v-else>
                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">agentId</div>
                      <input v-model="formAgentId" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">agentName (optional)</div>
                      <input v-model="formAgentName" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1 md:col-span-2">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">projectDir</div>
                      <input v-model="formAgentProjectDir" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">model</div>
                      <input v-model="formAgentModel" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" placeholder="gpt-..." />
                    </label>
                    <label class="space-y-1">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">effort (optional)</div>
                      <input v-model="formAgentEffort" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" placeholder="low/medium/high" />
                    </label>
                    <label class="space-y-1 md:col-span-2">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">permissionMode (optional)</div>
                      <input v-model="formAgentPermissionMode" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm" />
                    </label>
                    <label class="space-y-1 md:col-span-2">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">allowTools (comma separated)</div>
                      <input v-model="formAgentAllowToolsCsv" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" placeholder="read, search, bash" />
                    </label>
                    <label class="space-y-1 md:col-span-2">
                      <div class="text-xs font-medium text-[var(--tt-text-subtle)]">allowSkills (comma separated)</div>
                      <input v-model="formAgentAllowSkillsCsv" class="w-full rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                    </label>
                  </div>

                  <div class="grid gap-3 lg:grid-cols-2">
                    <div class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] p-3">
                      <div class="flex items-center justify-between">
                        <div class="text-sm font-semibold text-[var(--tt-accent)]">env</div>
                        <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentEnvRows.push({ key: '', value: '' })">
                          + Add
                        </button>
                      </div>
                      <div class="mt-2 space-y-2">
                        <div v-for="(row, i) in formAgentEnvRows" :key="i" class="grid gap-2 grid-cols-[1fr_1fr_64px]">
                          <input v-model="row.key" placeholder="KEY" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <input v-model="row.value" placeholder="value" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <button class="rounded-xl border border-[var(--tt-border)] bg-white px-3 py-2 text-sm text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentEnvRows.splice(i, 1)">
                            Del
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] p-3">
                      <div class="flex items-center justify-between">
                        <div class="text-sm font-semibold text-[var(--tt-accent)]">mcpServers</div>
                        <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentMcpServersRows.push({ key: '', value: '' })">
                          + Add
                        </button>
                      </div>
                      <div class="mt-2 space-y-2">
                        <div v-for="(row, i) in formAgentMcpServersRows" :key="i" class="grid gap-2 md:grid-cols-[180px_1fr_64px]">
                          <input v-model="row.key" placeholder="serverId" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <input v-model="row.value" placeholder="server config (JSON or string)" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <button class="rounded-xl border border-[var(--tt-border)] bg-white px-3 py-2 text-sm text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentMcpServersRows.splice(i, 1)">
                            Del
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="grid gap-3 lg:grid-cols-2">
                    <div class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] p-3">
                      <div class="flex items-center justify-between">
                        <div class="text-sm font-semibold text-[var(--tt-accent)]">promptConfig</div>
                        <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentPromptConfigRows.push({ key: '', value: '' })">
                          + Add
                        </button>
                      </div>
                      <div class="mt-2 space-y-2">
                        <div v-for="(row, i) in formAgentPromptConfigRows" :key="i" class="grid gap-2 md:grid-cols-[180px_1fr_64px]">
                          <input v-model="row.key" placeholder="key" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <input v-model="row.value" placeholder="value (JSON or string)" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <button class="rounded-xl border border-[var(--tt-border)] bg-white px-3 py-2 text-sm text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentPromptConfigRows.splice(i, 1)">
                            Del
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="rounded-2xl border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] p-3">
                      <div class="flex items-center justify-between">
                        <div class="text-sm font-semibold text-[var(--tt-accent)]">thinking options</div>
                        <button class="rounded-lg border border-[var(--tt-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentThinkingRows.push({ key: '', value: '' })">
                          + Add
                        </button>
                      </div>
                      <div class="mt-2 space-y-2">
                        <div v-for="(row, i) in formAgentThinkingRows" :key="i" class="grid gap-2 md:grid-cols-[180px_1fr_64px]">
                          <input v-model="row.key" placeholder="key" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <input v-model="row.value" placeholder="value (JSON or string)" class="rounded-xl border border-[var(--tt-border)] bg-white/90 px-3 py-2 text-sm font-mono" />
                          <button class="rounded-xl border border-[var(--tt-border)] bg-white px-3 py-2 text-sm text-[var(--tt-danger)] hover:bg-[var(--tt-surface-soft)]" @click="formAgentThinkingRows.splice(i, 1)">
                            Del
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <div class="mt-4 flex items-center justify-end gap-2">
                <button class="rounded-xl border border-[var(--tt-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]" @click="editorOpen = false">
                  Cancel
                </button>
                <button class="rounded-xl bg-[var(--tt-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--tt-primary-strong)] disabled:opacity-50" :disabled="isSaving" @click="saveEditor">
                  <span v-if="isSaving">Applying…</span>
                  <span v-else>Apply</span>
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>
