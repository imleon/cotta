import type {
  LiveBackgroundTask,
  ProjectSessionSearchRequest,
  ProjectSessionSearchResponse,
  SessionActivity,
  SessionRawTranscriptLine,
  SessionRunState,
  SessionTimelineResponse,
  SessionTimelineState,
  ToolApprovalRequest,
  TurnSummary,
} from '@cotta/shared'
import type { ClaudeCodeApi } from '../claude-code-api.js'
import { type CliSessionMetadata, isActiveCliSessionMetadata, isBackgroundKind } from '../claude-session-registry.js'
import type { IndexChangeInput, IndexChangeNotifier } from '../index-change-notifier.js'
import type { LiveTurnManager } from '../live-turn-manager.js'
import type { ModelCatalogProvider } from '../model-catalog.js'
import type { SessionContextUsageStore } from '../session-context-usage-store.js'
import type { SessionPinStore } from '../session-pin-store.js'
import type { RawTimelineWindow } from '../session-raw-transcript-cache.js'
import type { SessionSubagentStore } from '../session-subagent-store.js'
import type { SessionWatcherRegistry } from '../session-watcher-registry.js'
import type { SettingsStore } from '../settings-store.js'
import type { ShareStore } from '../share-store.js'
import type { IndexedSession, TranscriptIndexStore } from '../transcript-index-store.js'
import type { TurnOptionsStore } from '../turn-options-store.js'

export type ProjectRoutesLiveTurnManager = Pick<LiveTurnManager, 'acknowledgeCompletedTurn' | 'interrupt' | 'sessionRunState' | 'startTurn' | 'subscribe'> & {
  runtimeTurnProjection(sessionId: string, submissionUuid?: string): ReturnType<LiveTurnManager['runtimeTurnProjection']>
  clearRuntimeTurnProjection(sessionId: string): void
  hasRuntime?(sessionId: string): boolean
  restartRuntime?(input: Parameters<LiveTurnManager['restartRuntime']>[0]): Promise<boolean>
  liveBackgroundTasks?(sessionId: string): readonly LiveBackgroundTask[] | null
  sessionRunStateVersion?(sessionId: string): number
  respondToPermission?(sessionId: string, requestId: string, decision: Parameters<LiveTurnManager['respondToPermission']>[2]): ReturnType<LiveTurnManager['respondToPermission']>
  respondToQuestion?(sessionId: string, requestId: string, decision: Parameters<LiveTurnManager['respondToQuestion']>[2]): ReturnType<LiveTurnManager['respondToQuestion']>
  ensureRuntime(input: Parameters<LiveTurnManager['ensureRuntime']>[0]): unknown | Promise<unknown | null>
  syncExistingRuntimeOptions?(input: Parameters<LiveTurnManager['syncExistingRuntimeOptions']>[0]): ReturnType<LiveTurnManager['syncExistingRuntimeOptions']>
  contextUsage?(sessionId: string, refresh?: boolean): ReturnType<LiveTurnManager['contextUsage']>
  closeForExternalOwner?(sessionId: string, errorMessage?: string, options?: Parameters<LiveTurnManager['closeForExternalOwner']>[2]): Promise<boolean>
}

export type SessionMetadata = CliSessionMetadata

export function sessionActivity(runState: SessionRunState | null, metadata: SessionMetadata | null | undefined, liveBackgroundTasks: readonly LiveBackgroundTask[] | null = null): SessionActivity {
  if (metadata && isActiveCliSessionMetadata(metadata)) {
    if (metadata.status === 'busy' || metadata.status === 'waiting') return { owner: 'external', phase: metadata.status, activeTurnId: null }
    if (isBackgroundKind(metadata.kind)) return { owner: 'external', phase: 'background', activeTurnId: null }
  }
  if (runState?.phase === 'running') return { owner: 'cotta', phase: 'busy', activeTurnId: runState.activeUserMessageUuid }
  if (runState?.phase === 'requires_action') return { owner: 'cotta', phase: 'waiting', activeTurnId: runState.activeUserMessageUuid }
  if (liveBackgroundTasks && liveBackgroundTasks.length > 0) return { owner: 'cotta', phase: 'background', activeTurnId: null }
  if (runState?.lastTurn) return { owner: 'cotta', phase: 'idle', activeTurnId: null }
  if (metadata) return { owner: 'external', phase: 'idle', activeTurnId: null }
  return { owner: null, phase: 'idle', activeTurnId: null }
}

export function sessionActivityVersion(input: { activity: SessionActivity; pendingPermission?: ToolApprovalRequest | null }): string {
  const pending = input.pendingPermission ? `:${input.pendingPermission.requestId}:${input.pendingPermission.toolUseID}` : ''
  return `activity=${input.activity.owner ?? 'none'}:${input.activity.phase}:${input.activity.activeTurnId ?? ''}${pending}`
}

export type TurnMetadataValue = Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'entrypoint' | 'pendingBackgroundAgentCount' | 'awaySummary'>
export type TimelineMetadata = {
  turnMetadata: ReadonlyMap<string, TurnMetadataValue>
  turnOptions: SessionTimelineResponse['turnOptions']
  scanByteOffset?: number | null
  scannedFileSize?: number | null
}
export type ProjectRoutesTimelineMetadataReader = (projectId: string, sessionId: string) => TimelineMetadata | Promise<TimelineMetadata>
export type ProjectRoutesTranscriptSyncer = (projectId: string, sessionId: string, fileSize?: number) => unknown | Promise<unknown>
export type ProjectRoutesRawTranscriptCache = {
  loadTimelineWindow(
    sessionId: string,
    options: { limitTurns: number; cursor: string | null; fromTurnId: string | null; anchorTurnId?: string | null; excludeLocalCommandTurns?: boolean },
  ): RawTimelineWindow
  adjacentTurnIds(
    sessionId: string,
    turnId: string,
    options?: { excludeLocalCommandTurns?: boolean },
  ): { firstTurnId: string; previousTurnId: string | null; nextTurnId: string | null; latestTurnId: string } | null
  loadRawLinesForTurn(sessionId: string, turnId: string): SessionRawTranscriptLine[] | null
  loadRawLinesByUuid(sessionId: string, messageUuid: string): SessionRawTranscriptLine[]
  timelineVersion?(sessionId: string): string | null
  resolveTranscriptPath?(sessionId: string): Promise<string>
}

export type ProjectRoutesSessionSearchStore = {
  search(input: ProjectSessionSearchRequest): ProjectSessionSearchResponse
  updateTitle(sessionId: string, title: string): boolean
}
export type ProjectRoutesSessionSearchReady = () => Promise<unknown>

export type ProjectRoutesInput = {
  claudeCodeApi: ClaudeCodeApi
  liveTurnManager: ProjectRoutesLiveTurnManager
  modelCatalogProvider: ModelCatalogProvider
  settingsStore?: SettingsStore
  turnOptionsStore?: TurnOptionsStore
  sessionContextUsageStore?: SessionContextUsageStore
  sessionPinStore?: SessionPinStore
  indexChangeNotifier?: Pick<IndexChangeNotifier, 'versionSnapshot' | 'subscribe' | 'publishChange'> &
    Partial<Pick<IndexChangeNotifier, 'snapshot' | 'publishProjectListChange' | 'publishSessionVersion' | 'publishSubagentChange'>>
  selectedSessionVersionReader?: (projectId: string, sessionId: string) => string | null
  timelineVersionReader: (projectId: string, sessionId: string) => string
  refreshTaskSnapshot?: (sessionId: string, projectId?: string) => Promise<unknown>
  refreshSubagentIndex?: (sessionId: string) => Promise<boolean>
  subagentStore?: SessionSubagentStore
  sessionWatcherRegistry?: Pick<SessionWatcherRegistry, 'acquireTask' | 'acquireSubagent'>
  syncTranscriptIndex?: (input?: IndexChangeInput) => Promise<void>
  sessionMetadataReader?: (sessionId: string) => SessionMetadata | null
  timelineMetadataReader?: ProjectRoutesTimelineMetadataReader
  transcriptSyncer?: ProjectRoutesTranscriptSyncer
  rawTranscriptCache?: ProjectRoutesRawTranscriptCache
  transcriptIndex: Pick<TranscriptIndexStore, 'getSession'>
  sessionSearchStore?: ProjectRoutesSessionSearchStore
  sessionSearchReady?: ProjectRoutesSessionSearchReady
  detailTokenKey?: Buffer
  shareStore?: ShareStore
}

export function locateSession(input: ProjectRoutesInput, sessionId: string): IndexedSession | null {
  const session = input.transcriptIndex.getSession(sessionId)
  return session?.isValidSessionId && session.currentProjectId ? session : null
}

export function resolveSessionProject(input: ProjectRoutesInput, sessionId: string): IndexedSession | null {
  const session = locateSession(input, sessionId)
  return session?.transcriptPath && session.fileMtimeMs !== null ? session : null
}

export function resolveSessionTimelineState(input: ProjectRoutesInput, session: IndexedSession): SessionTimelineState | null {
  if (!session.currentProjectId) return null
  return {
    sessionId: session.sessionId,
    version: input.timelineVersionReader(session.currentProjectId, session.sessionId),
    fileSize: session.fileSize ?? undefined,
  }
}

export function parseLimit(value: string | undefined, fallback: number, max = 10_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

export function parseCursor(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null
}

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000

export function createSseHeartbeat(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal, ...onCleanup: Array<() => void>) {
  const encoder = new TextEncoder()
  let closed = false
  let timer: ReturnType<typeof setInterval>
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    signal.removeEventListener('abort', cleanup)
    for (const callback of onCleanup)
      try {
        callback()
      } catch {}
    try {
      controller.close()
    } catch {}
  }
  const enqueue = (value: string) => {
    if (closed) return false
    try {
      controller.enqueue(encoder.encode(value))
      return true
    } catch {
      cleanup()
      return false
    }
  }
  timer = setInterval(() => enqueue(': heartbeat\n\n'), SSE_HEARTBEAT_INTERVAL_MS)
  timer.unref()
  signal.addEventListener('abort', cleanup, { once: true })
  if (signal.aborted) cleanup()
  return { enqueue, cleanup }
}
