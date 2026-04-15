import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  SessionPersistentLogEntry,
  SessionSdkRawLogEntry,
  SessionSummary,
} from '../../../runtime/protocol/message-types.js'
import { createDebugLogger } from '../lib/debug.js'
import { useSessionStore } from './session'

interface SdkRawLogsResponse {
  items?: SessionSdkRawLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

interface PersistentLogsResponse {
  items?: SessionPersistentLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

interface AgentDescriptor {
  agentId: string
  projectDir?: string
}

interface AgentsResponse {
  defaultAgentId?: string
  agents?: AgentDescriptor[]
}

type LogTab = 'messages' | 'control' | 'persistent'

const logger = createDebugLogger('log-view-store')
const SESSION_LIST_REFRESH_INTERVAL_MS = 3000
const DEFAULT_LOG_PAGE_SIZE = 100
const FULL_LOG_PAGE_SIZE = 200

function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

function resolveSelectedAgentId(input: {
  agents: AgentDescriptor[]
  preferredAgentId?: string | null
  defaultAgentId?: string | null
}): string {
  const preferredAgentId = input.preferredAgentId?.trim() || ''
  if (preferredAgentId && input.agents.some((agent) => agent.agentId === preferredAgentId)) {
    return preferredAgentId
  }
  const defaultAgentId = input.defaultAgentId?.trim() || ''
  if (defaultAgentId && input.agents.some((agent) => agent.agentId === defaultAgentId)) {
    return defaultAgentId
  }
  return input.agents[0]?.agentId ?? ''
}

function sortPersistentLogEntries(entries: SessionPersistentLogEntry[]): SessionPersistentLogEntry[] {
  return entries
    .slice()
    .sort((left, right) => {
      const leftLoggedAt = typeof left.loggedAt === 'number' && Number.isFinite(left.loggedAt) ? left.loggedAt : null
      const rightLoggedAt = typeof right.loggedAt === 'number' && Number.isFinite(right.loggedAt) ? right.loggedAt : null
      if (leftLoggedAt !== null && rightLoggedAt !== null && leftLoggedAt !== rightLoggedAt) {
        return leftLoggedAt - rightLoggedAt
      }
      if ((leftLoggedAt !== null) !== (rightLoggedAt !== null)) {
        return leftLoggedAt !== null ? -1 : 1
      }
      return left.cursor - right.cursor
    })
}

function mergePersistentLogEntries(
  existing: SessionPersistentLogEntry[],
  incoming: SessionPersistentLogEntry[],
): SessionPersistentLogEntry[] {
  const byCursor = new Map<number, SessionPersistentLogEntry>()
  for (const entry of existing) byCursor.set(entry.cursor, entry)
  for (const entry of incoming) byCursor.set(entry.cursor, entry)
  return sortPersistentLogEntries([...byCursor.values()])
}

export const useLogViewStore = defineStore('log-view', () => {
  const sessionStore = useSessionStore()
  const agents = ref<AgentDescriptor[]>([])
  const selectedAgentId = ref('')
  const selectedSessionId = ref<string | null>(null)
  const selectedLogTab = ref<LogTab>('messages')
  const logLive = ref(true)

  const sdkRawLog = ref<SessionSdkRawLogEntry[]>([])
  const sdkRawLogHasMore = ref(false)
  const sdkRawLogCursor = ref<number | null>(null)
  const sdkRawLogLoading = ref(false)
  const sdkRawLogRefreshing = ref(false)
  const sdkRawLogFollowing = ref(false)

  const persistentLog = ref<SessionPersistentLogEntry[]>([])
  const persistentLogHasMore = ref(false)
  const persistentLogCursor = ref<number | null>(null)
  const persistentFollowCursor = ref<number | null>(null)
  const persistentLogLoading = ref(false)
  const persistentLogRefreshing = ref(false)
  const persistentLogFollowing = ref(false)

  let sdkRawFollowTimer: number | null = null
  let persistentFollowTimer: number | null = null
  let sessionListRefreshTimer: number | null = null

  const sessions = computed<SessionSummary[]>(() => sessionStore.sessions)
  const filteredSessions = computed<SessionSummary[]>(() => {
    if (!selectedAgentId.value) return []
    return sessions.value.filter((session) => session.agentId === selectedAgentId.value)
  })

  function resetLoadedLogs() {
    sdkRawLog.value = []
    sdkRawLogHasMore.value = false
    sdkRawLogCursor.value = null
    persistentLog.value = []
    persistentLogHasMore.value = false
    persistentLogCursor.value = null
    persistentFollowCursor.value = null
  }

  function syncSelectedSessionToFilter() {
    if (filteredSessions.value.length === 0) {
      selectedSessionId.value = null
      resetLoadedLogs()
      stopSdkRawFollow()
      stopPersistentFollow()
      return
    }
    if (selectedSessionId.value && filteredSessions.value.some((session) => session.id === selectedSessionId.value)) {
      return
    }
    selectedSessionId.value = filteredSessions.value[0]!.id
  }

  function stopSdkRawFollow() {
    if (sdkRawFollowTimer !== null) {
      window.clearTimeout(sdkRawFollowTimer)
      sdkRawFollowTimer = null
    }
    sdkRawLogFollowing.value = false
  }

  function stopPersistentFollow() {
    if (persistentFollowTimer !== null) {
      window.clearTimeout(persistentFollowTimer)
      persistentFollowTimer = null
    }
    persistentLogFollowing.value = false
  }

  function pauseSelectedLogFollow() {
    if (selectedLogTab.value === 'messages' || selectedLogTab.value === 'control') {
      stopSdkRawFollow()
      return
    }
    stopPersistentFollow()
  }

  function stopSessionListRefresh() {
    if (sessionListRefreshTimer !== null) {
      window.clearTimeout(sessionListRefreshTimer)
      sessionListRefreshTimer = null
    }
  }

  async function apiFetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || undefined)
    if (sessionStore.hasAuthToken) {
      headers.set('Authorization', `Bearer ${sessionStore.authToken}`)
    }
    return fetch(input, {
      ...init,
      headers,
    })
  }

  async function ensureSessionsLoaded() {
    await fetchAgents()
    if (sessions.value.length === 0) {
      await sessionStore.fetchSessions()
    }
    syncSelectedSessionToFilter()
  }

  async function refreshSessionList() {
    const [agentsLoaded, sessionsLoaded] = await Promise.all([
      fetchAgents(),
      sessionStore.fetchSessions(),
    ])
    const loaded = agentsLoaded || sessionsLoaded
    if (!loaded) return false
    syncSelectedSessionToFilter()
    return true
  }

  async function fetchAgents() {
    try {
      const res = await apiFetch('/api/agents')
      if (!res.ok) return false
      const data = await res.json() as AgentsResponse
      const nextAgents = Array.isArray(data.agents)
        ? data.agents
          .map((agent) => ({
            agentId: typeof agent?.agentId === 'string' ? agent.agentId.trim() : '',
            ...(typeof agent?.projectDir === 'string' && agent.projectDir.trim()
              ? { projectDir: agent.projectDir.trim() }
              : {}),
          }))
          .filter((agent) => agent.agentId)
        : []
      agents.value = nextAgents
      selectedAgentId.value = resolveSelectedAgentId({
        agents: nextAgents,
        preferredAgentId: selectedAgentId.value,
        defaultAgentId: typeof data.defaultAgentId === 'string' ? data.defaultAgentId : '',
      })
      return true
    } catch (error) {
      logger.warn('agents:load:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function scheduleSessionListRefresh() {
    stopSessionListRefresh()
    sessionListRefreshTimer = window.setTimeout(async () => {
      await refreshSessionList()
      scheduleSessionListRefresh()
    }, SESSION_LIST_REFRESH_INTERVAL_MS)
  }

  function startSessionListRefresh() {
    scheduleSessionListRefresh()
  }

  async function loadSdkRawLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || sdkRawLogLoading.value) return false

    sdkRawLogLoading.value = true
    sdkRawLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', String(options.follow ? DEFAULT_LOG_PAGE_SIZE : FULL_LOG_PAGE_SIZE))
      if (!options.follow) params.set('full', '1')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/sdk-raw-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('sdk-raw:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as SdkRawLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append) {
        sdkRawLog.value = [...items, ...sdkRawLog.value]
      } else if (options.follow) {
        sdkRawLog.value = [...sdkRawLog.value, ...items]
      } else {
        sdkRawLog.value = items
      }
      sdkRawLogHasMore.value = false
      sdkRawLogCursor.value = null
      logger.info('sdk-raw:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: sdkRawLog.value.length,
        hasMore: sdkRawLogHasMore.value,
        cursor: sdkRawLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('sdk-raw:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      sdkRawLogLoading.value = false
      sdkRawLogRefreshing.value = false
    }
  }

  async function loadPersistentLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || persistentLogLoading.value) return false

    persistentLogLoading.value = true
    persistentLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', String(options.follow ? DEFAULT_LOG_PAGE_SIZE : FULL_LOG_PAGE_SIZE))
      if (!options.follow) params.set('full', '1')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/persistent-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('persistent:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as PersistentLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append || options.follow) {
        persistentLog.value = mergePersistentLogEntries(persistentLog.value, items)
      } else {
        persistentLog.value = sortPersistentLogEntries(items)
      }
      const nextCursor = typeof data.nextCursor === 'number' ? data.nextCursor : null
      const tailCursor = persistentLog.value.length > 0 ? persistentLog.value[persistentLog.value.length - 1]?.cursor ?? null : null
      if (options.follow) {
        persistentFollowCursor.value = nextCursor ?? tailCursor
      } else {
        persistentLogHasMore.value = Boolean(data.hasMore)
        persistentLogCursor.value = nextCursor
        persistentFollowCursor.value = tailCursor
      }
      logger.info('persistent:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: persistentLog.value.length,
        hasMore: persistentLogHasMore.value,
        cursor: persistentLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('persistent:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      persistentLogLoading.value = false
      persistentLogRefreshing.value = false
    }
  }

  async function reloadSdkRawLogs() {
    sdkRawLog.value = []
    sdkRawLogHasMore.value = false
    sdkRawLogCursor.value = null
    stopSdkRawFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadSdkRawLogs(selectedSessionId.value)
    if (loaded && logLive.value) {
      scheduleSdkRawFollow()
    }
    return loaded
  }

  async function reloadPersistentLogs() {
    persistentLog.value = []
    persistentLogHasMore.value = false
    persistentLogCursor.value = null
    persistentFollowCursor.value = null
    stopPersistentFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadPersistentLogs(selectedSessionId.value)
    if (loaded && logLive.value) {
      schedulePersistentFollow()
    }
    return loaded
  }

  async function refreshSdkRawLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = sdkRawLog.value.length > 0 ? sdkRawLog.value[sdkRawLog.value.length - 1]?.cursor ?? null : null
    return loadSdkRawLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function refreshPersistentLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = persistentFollowCursor.value
      ?? (persistentLog.value.length > 0 ? persistentLog.value[persistentLog.value.length - 1]?.cursor ?? null : null)
    return loadPersistentLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function loadOlderSdkRawLogs() {
    return false
  }

  async function loadOlderPersistentLogs() {
    if (!selectedSessionId.value || !persistentLogHasMore.value || persistentLogCursor.value === null) return false
    return loadPersistentLogs(selectedSessionId.value, { cursor: persistentLogCursor.value, append: true })
  }

  function scheduleSdkRawFollow() {
    stopSdkRawFollow()
    if (!selectedSessionId.value || !logLive.value) return
    sdkRawLogFollowing.value = true
    sdkRawFollowTimer = window.setTimeout(async () => {
      await refreshSdkRawLogs()
      scheduleSdkRawFollow()
    }, 1500)
  }

  function schedulePersistentFollow() {
    stopPersistentFollow()
    if (!selectedSessionId.value || !logLive.value) return
    persistentLogFollowing.value = true
    persistentFollowTimer = window.setTimeout(async () => {
      await refreshPersistentLogs()
      schedulePersistentFollow()
    }, 1500)
  }

  async function setLogLive(enabled: boolean) {
    logLive.value = enabled
    if (!enabled) {
      stopSdkRawFollow()
      stopPersistentFollow()
      return false
    }
    if (!selectedSessionId.value) return false
    const [sdkRawLoaded, persistentLoaded] = await Promise.all([
      refreshSdkRawLogs(),
      refreshPersistentLogs(),
    ])
    scheduleSdkRawFollow()
    schedulePersistentFollow()
    return sdkRawLoaded || persistentLoaded
  }

  async function toggleLogLive() {
    return setLogLive(!logLive.value)
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || selectedSessionId.value === sessionId) return
    selectedSessionId.value = sessionId
  }

  function selectAgent(agentId: string) {
    const nextAgentId = agentId.trim()
    if (!nextAgentId) return
    if (selectedAgentId.value === nextAgentId) return
    selectedAgentId.value = nextAgentId
  }

  function selectLogTab(tab: LogTab) {
    selectedLogTab.value = tab
  }

  watch([selectedAgentId, sessions], () => {
    syncSelectedSessionToFilter()
  })

  watch(selectedSessionId, async (next, prev) => {
    if (!next) {
      resetLoadedLogs()
      stopSdkRawFollow()
      stopPersistentFollow()
      return
    }
    if (next && next !== prev) {
      await Promise.all([
        reloadSdkRawLogs(),
        reloadPersistentLogs(),
      ])
    }
  })

  return {
    agents,
    sessions,
    filteredSessions,
    selectedAgentId,
    selectedSessionId,
    selectedLogTab,
    logLive,
    sdkRawLog,
    sdkRawLogHasMore,
    sdkRawLogLoading,
    sdkRawLogRefreshing,
    sdkRawLogFollowing,
    persistentLog,
    persistentLogHasMore,
    persistentLogLoading,
    persistentLogRefreshing,
    persistentLogFollowing,
    ensureSessionsLoaded,
    fetchAgents,
    refreshSessionList,
    startSessionListRefresh,
    stopSessionListRefresh,
    selectAgent,
    selectSession,
    selectLogTab,
    reloadSdkRawLogs,
    reloadPersistentLogs,
    refreshSdkRawLogs,
    refreshPersistentLogs,
    loadOlderSdkRawLogs,
    loadOlderPersistentLogs,
    pauseSelectedLogFollow,
    stopSdkRawFollow,
    stopPersistentFollow,
    setLogLive,
    toggleLogLive,
  }
})
