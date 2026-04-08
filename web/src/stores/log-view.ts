import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  SessionChannelLogEntry,
  SessionPersistentLogEntry,
  SessionRuntimeLogEntry,
  SessionSummary,
  SessionTransportLogEntry,
} from '../../../shared/message-types.js'
import { createDebugLogger } from '../lib/debug.js'
import { useSessionStore } from './session'

interface TransportLogsResponse {
  items?: SessionTransportLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

interface RuntimeLogsResponse {
  items?: SessionRuntimeLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

interface ChannelLogsResponse {
  items?: SessionChannelLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

interface PersistentLogsResponse {
  items?: SessionPersistentLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

type LogTab = 'transport' | 'runtime' | 'channel' | 'persistent'

const logger = createDebugLogger('log-view-store')
const SESSION_LIST_REFRESH_INTERVAL_MS = 3000
const DEFAULT_LOG_PAGE_SIZE = 100
const FULL_LOG_PAGE_SIZE = 200

function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
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
  const selectedSessionId = ref<string | null>(null)
  const selectedLogTab = ref<LogTab>('transport')
  const transportLog = ref<SessionTransportLogEntry[]>([])
  const transportLogHasMore = ref(false)
  const transportLogCursor = ref<number | null>(null)
  const transportLogLoading = ref(false)
  const transportLogRefreshing = ref(false)
  const transportLogFollowing = ref(false)
  const transportLogLive = ref(true)
  const runtimeLog = ref<SessionRuntimeLogEntry[]>([])
  const runtimeLogHasMore = ref(false)
  const runtimeLogCursor = ref<number | null>(null)
  const runtimeLogLoading = ref(false)
  const runtimeLogRefreshing = ref(false)
  const runtimeLogFollowing = ref(false)
  const channelLog = ref<SessionChannelLogEntry[]>([])
  const channelLogHasMore = ref(false)
  const channelLogCursor = ref<number | null>(null)
  const channelLogLoading = ref(false)
  const channelLogRefreshing = ref(false)
  const channelLogFollowing = ref(false)
  const persistentLog = ref<SessionPersistentLogEntry[]>([])
  const persistentLogHasMore = ref(false)
  const persistentLogCursor = ref<number | null>(null)
  const persistentFollowCursor = ref<number | null>(null)
  const persistentLogLoading = ref(false)
  const persistentLogRefreshing = ref(false)
  const persistentLogFollowing = ref(false)
  let transportFollowTimer: number | null = null
  let runtimeFollowTimer: number | null = null
  let channelFollowTimer: number | null = null
  let persistentFollowTimer: number | null = null
  let sessionListRefreshTimer: number | null = null

  const sessions = computed<SessionSummary[]>(() => sessionStore.sessions)

  function stopTransportFollow() {
    if (transportFollowTimer !== null) {
      window.clearTimeout(transportFollowTimer)
      transportFollowTimer = null
    }
    transportLogFollowing.value = false
  }

  function stopRuntimeFollow() {
    if (runtimeFollowTimer !== null) {
      window.clearTimeout(runtimeFollowTimer)
      runtimeFollowTimer = null
    }
    runtimeLogFollowing.value = false
  }

  function stopChannelFollow() {
    if (channelFollowTimer !== null) {
      window.clearTimeout(channelFollowTimer)
      channelFollowTimer = null
    }
    channelLogFollowing.value = false
  }

  function stopPersistentFollow() {
    if (persistentFollowTimer !== null) {
      window.clearTimeout(persistentFollowTimer)
      persistentFollowTimer = null
    }
    persistentLogFollowing.value = false
  }

  function pauseSelectedLogFollow() {
    if (selectedLogTab.value !== 'persistent') return
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
    if (sessions.value.length === 0) {
      await sessionStore.fetchSessions()
    }
    if (!selectedSessionId.value && sessions.value.length > 0) {
      selectedSessionId.value = sessions.value[0]!.id
    }
  }

  async function refreshSessionList() {
    const loaded = await sessionStore.fetchSessions()
    if (!loaded) return false
    if (!selectedSessionId.value && sessions.value.length > 0) {
      selectedSessionId.value = sessions.value[0]!.id
    }
    return true
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

  async function loadTransportLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || transportLogLoading.value) return false

    transportLogLoading.value = true
    transportLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', String(options.follow ? DEFAULT_LOG_PAGE_SIZE : FULL_LOG_PAGE_SIZE))
      if (!options.follow) params.set('full', '1')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/transport-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('transport:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as TransportLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append) {
        transportLog.value = [...items, ...transportLog.value]
      } else if (options.follow) {
        transportLog.value = [...transportLog.value, ...items]
      } else {
        transportLog.value = items
      }
      transportLogHasMore.value = false
      transportLogCursor.value = null
      logger.info('transport:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: transportLog.value.length,
        hasMore: transportLogHasMore.value,
        cursor: transportLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('transport:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      transportLogLoading.value = false
      transportLogRefreshing.value = false
    }
  }

  async function loadRuntimeLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || runtimeLogLoading.value) return false

    runtimeLogLoading.value = true
    runtimeLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', String(options.follow ? DEFAULT_LOG_PAGE_SIZE : FULL_LOG_PAGE_SIZE))
      if (!options.follow) params.set('full', '1')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/runtime-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('runtime:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as RuntimeLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append) {
        runtimeLog.value = [...items, ...runtimeLog.value]
      } else if (options.follow) {
        runtimeLog.value = [...runtimeLog.value, ...items]
      } else {
        runtimeLog.value = items
      }
      runtimeLogHasMore.value = false
      runtimeLogCursor.value = null
      logger.info('runtime:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: runtimeLog.value.length,
        hasMore: runtimeLogHasMore.value,
        cursor: runtimeLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('runtime:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      runtimeLogLoading.value = false
      runtimeLogRefreshing.value = false
    }
  }

  async function loadChannelLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || channelLogLoading.value) return false

    channelLogLoading.value = true
    channelLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', String(options.follow ? DEFAULT_LOG_PAGE_SIZE : FULL_LOG_PAGE_SIZE))
      if (!options.follow) params.set('full', '1')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/channel-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('channel:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as ChannelLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append) {
        channelLog.value = [...items, ...channelLog.value]
      } else if (options.follow) {
        channelLog.value = [...channelLog.value, ...items]
      } else {
        channelLog.value = items
      }
      channelLogHasMore.value = false
      channelLogCursor.value = null
      logger.info('channel:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: channelLog.value.length,
        hasMore: channelLogHasMore.value,
        cursor: channelLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('channel:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      channelLogLoading.value = false
      channelLogRefreshing.value = false
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

  async function reloadTransportLogs() {
    transportLog.value = []
    transportLogHasMore.value = false
    transportLogCursor.value = null
    stopTransportFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadTransportLogs(selectedSessionId.value)
    if (loaded && transportLogLive.value) {
      scheduleTransportFollow()
    }
    return loaded
  }

  async function reloadRuntimeLogs() {
    runtimeLog.value = []
    runtimeLogHasMore.value = false
    runtimeLogCursor.value = null
    stopRuntimeFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadRuntimeLogs(selectedSessionId.value)
    if (loaded && transportLogLive.value) {
      scheduleRuntimeFollow()
    }
    return loaded
  }

  async function reloadChannelLogs() {
    channelLog.value = []
    channelLogHasMore.value = false
    channelLogCursor.value = null
    stopChannelFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadChannelLogs(selectedSessionId.value)
    if (loaded && transportLogLive.value) {
      scheduleChannelFollow()
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
    if (loaded && transportLogLive.value) {
      schedulePersistentFollow()
    }
    return loaded
  }

  async function refreshTransportLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = transportLog.value.length > 0 ? transportLog.value[transportLog.value.length - 1]?.cursor ?? null : null
    return loadTransportLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function refreshRuntimeLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = runtimeLog.value.length > 0 ? runtimeLog.value[runtimeLog.value.length - 1]?.cursor ?? null : null
    return loadRuntimeLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function refreshChannelLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = channelLog.value.length > 0 ? channelLog.value[channelLog.value.length - 1]?.cursor ?? null : null
    return loadChannelLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function refreshPersistentLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = persistentFollowCursor.value
      ?? (persistentLog.value.length > 0 ? persistentLog.value[persistentLog.value.length - 1]?.cursor ?? null : null)
    return loadPersistentLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function loadOlderTransportLogs() {
    return false
  }

  async function loadOlderRuntimeLogs() {
    return false
  }

  async function loadOlderChannelLogs() {
    return false
  }

  async function loadOlderPersistentLogs() {
    if (!selectedSessionId.value || !persistentLogHasMore.value || persistentLogCursor.value === null) return false
    return loadPersistentLogs(selectedSessionId.value, { cursor: persistentLogCursor.value, append: true })
  }

  function scheduleTransportFollow() {
    stopTransportFollow()
    if (!selectedSessionId.value || !transportLogLive.value) return
    transportLogFollowing.value = true
    transportFollowTimer = window.setTimeout(async () => {
      await refreshTransportLogs()
      scheduleTransportFollow()
    }, 1500)
  }

  function scheduleRuntimeFollow() {
    stopRuntimeFollow()
    if (!selectedSessionId.value || !transportLogLive.value) return
    runtimeLogFollowing.value = true
    runtimeFollowTimer = window.setTimeout(async () => {
      await refreshRuntimeLogs()
      scheduleRuntimeFollow()
    }, 1500)
  }

  function scheduleChannelFollow() {
    stopChannelFollow()
    if (!selectedSessionId.value || !transportLogLive.value) return
    channelLogFollowing.value = true
    channelFollowTimer = window.setTimeout(async () => {
      await refreshChannelLogs()
      scheduleChannelFollow()
    }, 1500)
  }

  function schedulePersistentFollow() {
    stopPersistentFollow()
    if (!selectedSessionId.value || !transportLogLive.value) return
    persistentLogFollowing.value = true
    persistentFollowTimer = window.setTimeout(async () => {
      await refreshPersistentLogs()
      schedulePersistentFollow()
    }, 1500)
  }

  async function setTransportLive(enabled: boolean) {
    transportLogLive.value = enabled
    if (!enabled) {
      stopTransportFollow()
      stopRuntimeFollow()
      stopChannelFollow()
      stopPersistentFollow()
      return false
    }
    if (!selectedSessionId.value) return false
    const [transportLoaded, runtimeLoaded, channelLoaded, persistentLoaded] = await Promise.all([
      refreshTransportLogs(),
      refreshRuntimeLogs(),
      refreshChannelLogs(),
      refreshPersistentLogs(),
    ])
    scheduleTransportFollow()
    scheduleRuntimeFollow()
    scheduleChannelFollow()
    schedulePersistentFollow()
    return transportLoaded || runtimeLoaded || channelLoaded || persistentLoaded
  }

  async function toggleTransportLive() {
    return setTransportLive(!transportLogLive.value)
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || selectedSessionId.value === sessionId) return
    selectedSessionId.value = sessionId
  }

  function selectLogTab(tab: LogTab) {
    selectedLogTab.value = tab
  }

  watch(selectedSessionId, async (next, prev) => {
    if (next && next !== prev) {
      await Promise.all([
        reloadTransportLogs(),
        reloadRuntimeLogs(),
        reloadChannelLogs(),
        reloadPersistentLogs(),
      ])
    }
  })

  return {
    sessions,
    selectedSessionId,
    selectedLogTab,
    transportLog,
    transportLogHasMore,
    transportLogLoading,
    transportLogRefreshing,
    transportLogFollowing,
    transportLogLive,
    runtimeLog,
    runtimeLogHasMore,
    runtimeLogLoading,
    runtimeLogRefreshing,
    runtimeLogFollowing,
    channelLog,
    channelLogHasMore,
    channelLogLoading,
    channelLogRefreshing,
    channelLogFollowing,
    persistentLog,
    persistentLogHasMore,
    persistentLogLoading,
    persistentLogRefreshing,
    persistentLogFollowing,
    ensureSessionsLoaded,
    refreshSessionList,
    startSessionListRefresh,
    stopSessionListRefresh,
    selectSession,
    selectLogTab,
    reloadTransportLogs,
    reloadRuntimeLogs,
    reloadChannelLogs,
    reloadPersistentLogs,
    refreshTransportLogs,
    refreshRuntimeLogs,
    refreshChannelLogs,
    refreshPersistentLogs,
    loadOlderTransportLogs,
    loadOlderRuntimeLogs,
    loadOlderChannelLogs,
    loadOlderPersistentLogs,
    pauseSelectedLogFollow,
    stopTransportFollow,
    stopRuntimeFollow,
    stopChannelFollow,
    stopPersistentFollow,
    setTransportLive,
    toggleTransportLive,
  }
})
