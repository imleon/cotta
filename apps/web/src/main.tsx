import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StrictMode, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTurnResponseSchema,
  type AppSettings,
  type ListVersionsEvent,
  type CreateTurnResponse,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelSelection,
  type PermissionMode,
  type PersistedLiveEvent,
  type ProjectSessionsResponse,
  type SessionRuntimeResponse,
  type TurnSummary,
  isPrimaryTimelineUserMessage,
} from '@cotta/shared'
import { connectListVersions, createProject, ensureSessionRuntime, fetchAuthSession, fetchSessionLiveEvents, fetchSessionRawMessages, fetchSettings, logout, PaginationCursorStaleError, pollGitHubDeviceLogin, refreshModelCatalog, refreshProjects, saveSettings, startGitHubDeviceLogin } from './api'
import { ProjectSessionRail, useProjectSessionSelection } from './session-history'
import { refreshProjectsWindow, refreshVisibleProjectSessions, sessionQueryKeys } from './session-query-refresh'
import { SessionTimeline } from './timeline'
import './styles.css'

const DASHBOARD_NAV_ITEMS = [
  { key: 'chat', label: 'Chat', path: '/chat' },
  { key: 'automations', label: 'Automations', path: '/automations' },
  { key: 'agents', label: 'Agents', path: '/agents' },
  { key: 'skills', label: 'Skills', path: '/skills' },
  { key: 'mcp', label: 'MCP', path: '/mcp' },
  { key: 'settings', label: 'Settings', path: '/settings' },
  { key: 'debug', label: 'Debug', path: '/debug' },
] as const

type DashboardNavKey = (typeof DASHBOARD_NAV_ITEMS)[number]['key']

function routePath(key: DashboardNavKey): string {
  return DASHBOARD_NAV_ITEMS.find((item) => item.key === key)?.path ?? '/chat'
}

function navKeyFromPath(): DashboardNavKey {
  const path = window.location.pathname === '/' ? '/chat' : window.location.pathname
  const pathKey = DASHBOARD_NAV_ITEMS.find((item) => item.path === path)?.key
  if (pathKey) return pathKey
  const hashKey = window.location.pathname === '/' ? window.location.hash.slice(1) : ''
  return DASHBOARD_NAV_ITEMS.some((item) => item.key === hashKey) ? hashKey as DashboardNavKey : 'chat'
}

function DashboardNavIcon({ itemKey }: { itemKey: DashboardNavKey }) {
  if (itemKey === 'chat') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" /></svg>
  }
  if (itemKey === 'debug') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5a2 2 0 0 1 2 2v.8h1.5a1 1 0 0 1 1 1V9h1a1 1 0 1 1 0 2h-1v1.7a1 1 0 0 1-1 1H12v.8a2 2 0 1 1-4 0v-.8H6.5a1 1 0 0 1-1-1V11h-1a1 1 0 1 1 0-2h1V7.3a1 1 0 0 1 1-1H8v-.8a2 2 0 0 1 2-2Zm-2.5 4.8v3.4h5V8.3Z" /></svg>
  }
  if (itemKey === 'automations') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M4.7 4.7l2.1 2.1M13.2 13.2l2.1 2.1M15.3 4.7l-2.1 2.1M6.8 13.2l-2.1 2.1M10 6.5 12.2 8v4L10 13.5 7.8 12V8Z" /></svg>
  }
  if (itemKey === 'agents') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 15.5v-1.2a3.5 3.5 0 0 1 7 0v1.2M10 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 14.5v-.7a2.5 2.5 0 0 1 2.9-2.5M16.5 14.5v-.7a2.5 2.5 0 0 0-2.9-2.5" /></svg>
  }
  if (itemKey === 'skills') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.8 2 4.1 4.5.7-3.2 3.1.8 4.5-4.1-2.2-4.1 2.2.8-4.5-3.2-3.1 4.5-.7Z" /></svg>
  }
  if (itemKey === 'mcp') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.5h12M4 10h12M4 13.5h7M3 4.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /></svg>
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v2M10 14.5v2M4.7 5.3l1.4 1.4M13.9 14.3l1.4 1.4M3.5 10h2M14.5 10h2M4.7 14.7l1.4-1.4M13.9 5.7l1.4-1.4M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /></svg>
}

const DASHBOARD_NAV_MIN_WIDTH = 46
const DASHBOARD_NAV_MAX_WIDTH = 184
const DASHBOARD_NAV_DEFAULT_WIDTH = 216
const DASHBOARD_NAV_COLLAPSE_WIDTH = 96
const DASHBOARD_NAV_WIDTH_STORAGE_KEY = 'cotta:dashboard-nav-width'

function clampDashboardNavWidth(width: number): number {
  return Math.min(DASHBOARD_NAV_MAX_WIDTH, Math.max(DASHBOARD_NAV_MIN_WIDTH, width))
}

class CreateTurnHttpError extends Error {
  constructor(readonly status: number) {
    super(`Create turn failed: ${status}`)
  }
}

function createUserMessageUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function createTurn(projectId: string, sessionId: string | null, text: string, userMessageUuid: string, permissionMode: PermissionMode, model: ModelSelection | DefaultTurnOption, effort: EffortLevel | DefaultTurnOption): Promise<CreateTurnResponse> {
  const path = sessionId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns`
    : `/api/projects/${encodeURIComponent(projectId)}/sessions`
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, userMessageUuid, permissionMode, model, effort }),
  })
  if (!response.ok) throw new CreateTurnHttpError(response.status)
  return createTurnResponseSchema.parse(await response.json())
}

async function interruptTurn(projectId: string, sessionId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(`Interrupt failed: ${response.status}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function dataPreview(value: unknown, space = 2): string {
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text
  return JSON.stringify(value, null, space) ?? ''
}

function textFromData(value: unknown): string | null {
  if (isRecord(value) && typeof value.text === 'string') return value.text
  if (isRecord(value) && isRecord(value.raw) && typeof value.raw.content === 'string') return value.raw.content
  if (isRecord(value) && typeof value.content === 'string') return value.content
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content
      .map((block) => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
    return text || null
  }
  return null
}

function shortText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return '—'
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function debugDataPreview(value: unknown, max = 180): string {
  return shortText(textFromData(value) ?? dataPreview(value), max)
}

function rawField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function rawStringField(value: unknown, key: string): string {
  const field = rawField(value, key)
  return typeof field === 'string' ? field : '—'
}

function rawMessagePreview(value: unknown): string {
  return debugDataPreview(rawField(value, 'message') ?? value)
}

function rawMessageField(value: unknown, key: string): unknown {
  const message = rawField(value, 'message')
  return isRecord(message) ? message[key] : undefined
}

function debugFieldPreview(value: unknown, max = 180): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return shortText(String(value), max)
  return debugDataPreview(value, max)
}

function rawTimestampParts(value: unknown): { date: string; time: string } {
  const timestamp = rawStringField(value, 'timestamp')
  if (timestamp === '—') return { date: '—', time: '—' }
  const [date, timeWithZone] = timestamp.split('T')
  return { date: date || timestamp, time: timeWithZone ?? '—' }
}

function rawStopReason(value: unknown): string | null {
  const stopReason = rawMessageField(value, 'stop_reason')
  return typeof stopReason === 'string' && stopReason ? stopReason : null
}

function isPrimaryUserMessage(value: unknown): boolean {
  return isPrimaryTimelineUserMessage(value)
}

function sourceEventLabel(ids: string[]): string {
  if (ids.length === 0) return '—'
  if (ids.length <= 2) return ids.join(', ')
  return `${ids.slice(0, 2).join(', ')} +${ids.length - 2}`
}

function debugContentClassName(type: string | undefined): string {
  if (type === 'text') return 'debug-content-block-text'
  if (type === 'tool_use') return 'debug-content-block-tool-use'
  if (type === 'tool_result') return 'debug-content-block-tool-result'
  return 'debug-content-block-unknown'
}

function DebugContentField({ label, value, json = false, max = 260 }: { label: string; value: unknown; json?: boolean; max?: number }) {
  if (value === undefined || value === null) return null
  return (
    <div className="debug-content-field">
      <span className="debug-content-label">{label}</span>
      <div className="debug-content-value">
        {json ? <pre className="debug-content-pre">{dataPreview(value)}</pre> : debugFieldPreview(value, max)}
      </div>
    </div>
  )
}

function DebugContentBlock({ block, index }: { block: unknown; index: number }) {
  if (!isRecord(block)) {
    return (
      <div className="debug-content-block debug-content-block-unknown">
        <div className="debug-content-block-header">#{index + 1} value</div>
        <DebugContentField label="value" value={block} />
      </div>
    )
  }

  const type = typeof block.type === 'string' ? block.type : undefined
  const isJsonContent = isRecord(block.content) || Array.isArray(block.content)
  return (
    <div className={`debug-content-block ${debugContentClassName(type)}`}>
      <div className="debug-content-block-header">#{index + 1} {type ?? 'unknown'}</div>
      {type === 'text' ? <DebugContentField label="text" value={block.text} max={520} /> : null}
      {type === 'tool_use' ? (
        <>
          <DebugContentField label="id" value={block.id} />
          <DebugContentField label="name" value={block.name} />
          <DebugContentField label="input" value={block.input} json />
        </>
      ) : null}
      {type === 'tool_result' ? (
        <>
          <DebugContentField label="tool_use_id" value={block.tool_use_id} />
          <DebugContentField label="is_error" value={block.is_error} />
          <DebugContentField label="content" value={block.content} json={isJsonContent} max={520} />
        </>
      ) : null}
      {!type || (type !== 'text' && type !== 'tool_use' && type !== 'tool_result') ? <DebugContentField label="data" value={block} json /> : null}
    </div>
  )
}

function debugContentRows(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.length > 0 ? content : [undefined]
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === undefined || content === null) return [undefined]
  return [content]
}

function contentBlockType(block: unknown): string {
  if (block === undefined || block === null) return '—'
  if (!isRecord(block)) return 'value'
  return typeof block.type === 'string' ? block.type : 'unknown'
}

function contentBlockId(block: unknown): unknown {
  if (!isRecord(block)) return undefined
  return block.id ?? block.tool_use_id
}

function contentBlockName(block: unknown): unknown {
  return isRecord(block) ? block.name : undefined
}

function contentBlockIsErr(block: unknown): unknown {
  if (!isRecord(block)) return undefined
  return block.is_err ?? block.is_error
}

const contentBlockMetadataKeys = new Set(['type', 'id', 'tool_use_id', 'name', 'is_err', 'is_error'])

function contentBlockValue(block: unknown): unknown {
  if (!isRecord(block)) return block
  const entries = Object.entries(block).filter(([key]) => !contentBlockMetadataKeys.has(key))
  if (entries.length === 0) return undefined
  if (entries.length === 1) return entries[0]?.[1]
  return Object.fromEntries(entries)
}

function shouldRenderBlockValueMarkdown(block: unknown, value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!isRecord(block)) return false
  return (block.type === 'text' && typeof block.text === 'string')
    || (block.type === 'tool_result' && typeof block.content === 'string')
}

function DebugMarkdownValue({ value }: { value: string }) {
  return (
    <div className="debug-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  )
}

function DebugContentCellValue({ value, json = false, max = 260, markdown = false }: { value: unknown; json?: boolean; max?: number; markdown?: boolean }) {
  if (value === undefined || value === null) return <span className="debug-content-empty">—</span>
  if (json || isRecord(value) || Array.isArray(value)) return <pre className="debug-content-code">{dataPreview(value)}</pre>
  if (markdown && typeof value === 'string') return <DebugMarkdownValue value={value} />
  return <>{debugFieldPreview(value, max)}</>
}

function DebugContentStackCell({ blocks, valueForBlock, max = 260, markdownForBlock }: { blocks: unknown[]; valueForBlock: (block: unknown) => unknown; max?: number; markdownForBlock?: (block: unknown, value: unknown) => boolean }) {
  return (
    <div className="debug-content-stack">
      {blocks.map((block, index) => {
        const value = valueForBlock(block)
        return (
          <div key={index}>
            <DebugContentCellValue value={value} max={max} markdown={markdownForBlock?.(block, value) ?? false} />
            {index < blocks.length - 1 ? <div className="debug-content-separator">---</div> : null}
          </div>
        )
      })}
    </div>
  )
}

function SessionDebugView({ rawMessages }: { rawMessages: unknown[] }) {
  return (
    <section className="debug-view" aria-label="Session debug">
      <section className="debug-table-section" aria-label="Raw messages">
        <h4>Raw messages</h4>
        {rawMessages.length === 0 ? <p className="debug-empty">No raw messages loaded.</p> : (
          <div className="debug-table-wrap">
            <table className="debug-table">
              <thead><tr><th>Timestamp</th><th>Type</th><th>block.type</th><th>block.id</th><th>block.name</th><th>block.is_err</th><th>block.value</th><th>raw message</th><th>message.model</th><th>message.usage</th></tr></thead>
              <tbody>
                {rawMessages.map((message, index) => {
                  const timestamp = rawTimestampParts(message)
                  const stopReason = rawStopReason(message)
                  const contentRows = debugContentRows(rawMessageField(message, 'content'))
                  const rowClassName = isPrimaryUserMessage(message) ? 'debug-row-user' : undefined
                  return (
                    <tr className={rowClassName} key={`${rawStringField(message, 'uuid')}:${index}`}>
                      <td className="debug-mono debug-timestamp-cell"><div>{timestamp.date}</div><div className="debug-muted">{timestamp.time}</div></td>
                      <td className="debug-type-cell"><strong>{rawStringField(message, 'type')}</strong>{stopReason ? <div className="debug-muted">(stop_reason: {stopReason})</div> : null}</td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockType} /></td>
                      <td className="debug-mono debug-block-id-cell"><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockId} /></td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockName} /></td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockIsErr} /></td>
                      <td className="debug-content-cell"><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockValue} markdownForBlock={shouldRenderBlockValueMarkdown} max={520} /></td>
                      <td className="debug-content-cell debug-raw-message-cell"><DebugContentCellValue value={message} json /></td>
                      <td>{debugFieldPreview(rawMessageField(message, 'model'))}</td>
                      <td className="debug-usage-cell"><pre className="debug-inline-json">{dataPreview(rawMessageField(message, 'usage'), 0)}</pre></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function LiveEventsDebugView({ events }: { events: PersistedLiveEvent[] }) {
  return (
    <section className="debug-table-section" aria-label="Captured live events">
      <h4>Captured live events</h4>
      {events.length === 0 ? <p className="debug-empty">No captured live events yet.</p> : (
        <div className="debug-table-wrap">
          <table className="debug-table">
            <thead><tr><th>ID</th><th>Recorded</th><th>Event</th><th>Preview</th><th>Payload</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="debug-mono">{event.id}</td>
                  <td className="debug-mono debug-timestamp-cell">{new Date(event.recordedAtMs).toISOString()}</td>
                  <td className="debug-type-cell"><strong>{event.eventType}</strong></td>
                  <td className="debug-content-cell">{debugDataPreview(event.payload, 220)}</td>
                  <td className="debug-content-cell debug-raw-message-cell"><DebugContentCellValue value={event.payload} json /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function useSessionRawMessages(projectId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['session-raw-messages', projectId, sessionId],
    queryFn: () => fetchSessionRawMessages(projectId!, sessionId!),
    enabled: Boolean(projectId && sessionId),
    retry: false,
  })
}

function useSessionLiveEvents(projectId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['session-live-events', projectId, sessionId],
    queryFn: () => fetchSessionLiveEvents(projectId!, sessionId!),
    enabled: Boolean(projectId && sessionId),
    retry: false,
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  })
}

function pendingUserTurn(text: string, sessionId: string | null, userMessageUuid: string): TurnSummary {
  const startedAt = Date.now()
  return {
    id: userMessageUuid,
    sessionId: sessionId ?? 'pending',
    title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
    startedAt,
    rawStatus: 'running',
    displayStatus: 'running',
    blocks: [{
      id: `${userMessageUuid}:user`,
      kind: 'user.message',
      sourceEventIds: [userMessageUuid],
      data: { text, status: 'pending', primaryTimelineUserMessage: true },
    }],
  }
}

function effortLabel(value: EffortLevel | DefaultTurnOption): string {
  return value
}

const EFFORT_ORDER: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']
const DEFAULT_TURN_OPTION: DefaultTurnOption = 'default'
const DEFAULT_EFFORT: EffortLevel = 'medium'

function defaultEffort(levels: EffortLevel[]): EffortLevel {
  return levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[0] ?? DEFAULT_EFFORT
}

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; description: string }> = [
  { value: 'plan', description: 'Planning mode, no execution of tools.' },
  { value: 'dontAsk', description: "Don't prompt for permissions, deny if not pre-approved." },
  { value: 'default', description: 'Standard permission behavior, prompts for dangerous operations.' },
  { value: 'acceptEdits', description: 'Auto-accept file edit operations.' },
  { value: 'auto', description: 'Use a model classifier to approve/deny permission prompts.' },
  { value: 'bypassPermissions', description: 'Bypass all permission checks.' },
]

function ComposerIcon({ name }: { name: PermissionMode | 'add' | 'shield' }) {
  if (name === 'add') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
  if (name === 'shield') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2 15 5v4.1c0 3.2-1.8 5.8-5 7.7-3.2-1.9-5-4.5-5-7.7V5Z" /></svg>
  if (name === 'plan') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5h10M5 10h10M5 15h6" /></svg>
  if (name === 'dontAsk') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
  if (name === 'acceptEdits') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 13.5-.5 2 2-.5 8-8-1.5-1.5Z" /><path d="M11.5 5.5 13 4l3 3-1.5 1.5" /></svg>
  if (name === 'auto') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v2M10 14v2M4 10h2M14 10h2M5.8 5.8l1.4 1.4M12.8 12.8l1.4 1.4M14.2 5.8l-1.4 1.4M7.2 12.8l-1.4 1.4" /></svg>
  if (name === 'bypassPermissions') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m11 2-6 9h4l-1 7 7-10h-4Z" /></svg>
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10a5.5 5.5 0 1 0 11 0 5.5 5.5 0 0 0-11 0Z" /></svg>
}

function TurnComposer({
  projectId,
  selectedSessionId,
  liveUserMessageUuid,
  setSelectedSessionId,
  setPendingTurn,
  refreshSessionLists,
  onProjectRequired,
  pendingProjectId,
  pendingProjectRequest,
  onSessionCreated,
  settings,
  sessionRuntime,
}: {
  projectId: string | null
  selectedSessionId: string | null
  liveUserMessageUuid: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  setPendingTurn: Dispatch<SetStateAction<TurnSummary | null>>
  refreshSessionLists: (projectId?: string) => void
  onProjectRequired: (text: string) => void
  pendingProjectId: string | null
  pendingProjectRequest: number
  onSessionCreated: (projectId: string, sessionId: string) => void
  settings: AppSettings
  sessionRuntime: SessionRuntimeResponse | null
}) {
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const handledProjectRequestRef = useRef(0)
  const [retryProjectId, setRetryProjectId] = useState<string | null>(null)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode ?? 'default')
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const [model, setModel] = useState<ModelSelection | DefaultTurnOption>(settings.defaultModel ?? DEFAULT_TURN_OPTION)
  const [effort, setEffort] = useState<EffortLevel | DefaultTurnOption>(settings.defaultEffort ?? DEFAULT_EFFORT)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [menuModelValue, setMenuModelValue] = useState<ModelSelection | DefaultTurnOption>(DEFAULT_TURN_OPTION)
  const [effortMenuPosition, setEffortMenuPosition] = useState<CSSProperties>()
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const runtimeSettings = sessionRuntime?.projectId === projectId && sessionRuntime.sessionId === selectedSessionId ? sessionRuntime.settings : null
  const permissionOptions = sessionRuntime?.projectId === projectId && sessionRuntime.sessionId === selectedSessionId
    ? PERMISSION_MODE_OPTIONS.filter((option) => sessionRuntime.availablePermissionModes.includes(option.value))
    : PERMISSION_MODE_OPTIONS
  const catalogModels = sessionRuntime?.projectId === projectId && sessionRuntime.sessionId === selectedSessionId ? sessionRuntime.availableModels : settings.modelCatalog?.models ?? []
  const selectedModel = model === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === model || item.resolvedModel === model)
  const menuModel = menuModelValue === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === menuModelValue || item.resolvedModel === menuModelValue)
  const triggerModelLabel = selectedModel?.displayName || 'Claude Code default'
  const triggerEffortLabel = model === DEFAULT_TURN_OPTION ? effortLabel(effort) : selectedModel?.supportsEffort && effort !== DEFAULT_TURN_OPTION ? effortLabel(effort) : null

  useEffect(() => { setSubmitError(null); setInterrupting(false) }, [projectId, selectedSessionId])
  useEffect(() => { if (!liveUserMessageUuid) setInterrupting(false) }, [liveUserMessageUuid])
  useEffect(() => {
    setPermissionMode(runtimeSettings?.permissionMode ?? settings.defaultPermissionMode ?? 'default')
    setModel(runtimeSettings ? runtimeSettings.model ?? DEFAULT_TURN_OPTION : settings.defaultModel ?? DEFAULT_TURN_OPTION)
    setEffort(runtimeSettings ? runtimeSettings.effort ?? DEFAULT_EFFORT : settings.defaultEffort ?? DEFAULT_EFFORT)
  }, [runtimeSettings, settings.defaultPermissionMode, settings.defaultModel, settings.defaultEffort])
  useEffect(() => {
    if (model === DEFAULT_TURN_OPTION || selectedModel) return
    setModel(DEFAULT_TURN_OPTION)
    setEffort(DEFAULT_TURN_OPTION)
  }, [model, selectedModel])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`
  }, [inputText])
  useEffect(() => {
    if (!permissionMenuOpen && !modelMenuOpen) return
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target as Node
      if (permissionMenuRef.current?.contains(target) || modelMenuRef.current?.contains(target)) return
      setPermissionMenuOpen(false)
      setModelMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPermissionMenuOpen(false)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionMenuOpen, modelMenuOpen])

  async function submitTurn(targetProjectId = projectId) {
    if (submitting || liveUserMessageUuid || interrupting || !inputText.trim()) return
    const text = inputText.trim()
    if (!targetProjectId) {
      onProjectRequired(text)
      return
    }
    const userMessageUuid = createUserMessageUuid()
    setSubmitting(true)
    setSubmitError(null)
    try {
      const targetSessionId = targetProjectId === projectId ? selectedSessionId : null
      setPendingTurn(pendingUserTurn(text, targetSessionId, userMessageUuid))
      setInputText('')
      const response = await createTurn(targetProjectId, targetSessionId, text, userMessageUuid, permissionMode, model, selectedModel?.supportsEffort ? effort : DEFAULT_TURN_OPTION)
      if (targetProjectId !== projectId) onSessionCreated(response.projectId, response.sessionId)
      else setSelectedSessionId(response.sessionId)
      setPendingTurn((turn) => turn ? { ...turn, sessionId: response.sessionId } : turn)
      await refreshProjects(response.projectId)
      refreshSessionLists(response.projectId)
    } catch (error) {
      if (error instanceof CreateTurnHttpError) {
        setPendingTurn(null)
        setInputText(text)
        if (targetProjectId !== projectId) setRetryProjectId(targetProjectId)
        setSubmitError(error.message)
      } else {
        setSubmitError(`Submission status unknown. Check the timeline or session list before retrying. ${error instanceof Error ? error.message : String(error)}`)
        refreshSessionLists(targetProjectId)
      }
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!pendingProjectId || pendingProjectRequest === handledProjectRequestRef.current || !inputText.trim()) return
    handledProjectRequestRef.current = pendingProjectRequest
    void submitTurn(pendingProjectId)
  }, [pendingProjectId, pendingProjectRequest, inputText])

  async function stopLiveTurn() {
    if (!projectId || !selectedSessionId || !liveUserMessageUuid || interrupting) return
    setInterrupting(true)
    setSubmitError(null)
    try {
      await interruptTurn(projectId, selectedSessionId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
      setInterrupting(false)
    }
  }

  function toggleModelMenu() {
    setMenuModelValue(DEFAULT_TURN_OPTION)
    setModelMenuOpen((open) => !open)
  }

  function showEffortMenu(option: ModelCatalogItem, target: HTMLElement) {
    const menu = modelMenuRef.current?.querySelector('.model-effort-menu')
    if (!(menu instanceof HTMLElement)) return
    const itemRect = target.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const effortCount = option.supportedEffortLevels?.length ?? 0
    const effortMenuHeight = Math.min(220, effortCount * 38 + 16)
    const alignedTop = itemRect.top - menuRect.top
    const clippingBottom = menu.closest('.workspace-main-panel')?.getBoundingClientRect().bottom ?? window.innerHeight
    const maxTop = Math.min(window.innerHeight, clippingBottom) - menuRect.top - effortMenuHeight - 8
    setMenuModelValue(option.value)
    setEffortMenuPosition({ top: Math.max(8, Math.min(alignedTop, maxTop)) })
  }

  function chooseDefaultModel() {
    setModel(DEFAULT_TURN_OPTION)
    setEffort(DEFAULT_EFFORT)
    setModelMenuOpen(false)
  }

  function chooseModelOnly(option: ModelCatalogItem) {
    setModel(option.value)
    setEffort(DEFAULT_TURN_OPTION)
    setModelMenuOpen(false)
  }

  function chooseEffort(option: ModelCatalogItem, nextEffort: EffortLevel) {
    setModel(option.value)
    setEffort(nextEffort)
    setModelMenuOpen(false)
  }

  const actionMode = submitting || interrupting ? 'loading' : liveUserMessageUuid ? 'stop' : 'submit'

  return (
    <section className="composer-card composer-card-bottom">
      <form className="turn-form" onSubmit={(event) => { event.preventDefault(); void submitTurn(retryProjectId ?? projectId) }}>
        <div
          className="turn-composer"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button, textarea, select, .permission-mode-menu, .model-effort-menu')) return
            inputRef.current?.focus()
          }}
        >
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || submitting || liveUserMessageUuid || interrupting || !inputText.trim()) return
              event.preventDefault()
              void submitTurn(retryProjectId ?? projectId)
            }}
            placeholder="随心输入"
            rows={1}
          />
          <div className="turn-composer-footer">
            <div className="turn-composer-left-actions">
              <button type="button" className="turn-tool-button" disabled aria-label="Add attachment" title="Add attachment">
                <ComposerIcon name="add" />
              </button>
              <div className="permission-mode-picker" ref={permissionMenuRef}>
                <button
                  type="button"
                  className="turn-tool-button permission-mode-trigger"
                  aria-haspopup="menu"
                  aria-expanded={permissionMenuOpen}
                  aria-label={`Permission mode: ${permissionMode}`}
                  onClick={() => setPermissionMenuOpen((open) => !open)}
                >
                  <ComposerIcon name="shield" />
                  <span>{permissionMode}</span>
                </button>
                {permissionMenuOpen ? (
                  <div className="permission-mode-menu" role="menu" aria-label="Permission mode">
                    {permissionOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="permission-mode-option"
                        role="menuitemradio"
                        aria-checked={permissionMode === option.value}
                        onClick={() => { setPermissionMode(option.value); setPermissionMenuOpen(false) }}
                      >
                        <span className="permission-mode-option-icon"><ComposerIcon name={option.value} /></span>
                        <span className="permission-mode-option-copy">
                          <span className="permission-mode-option-title">{option.value}</span>
                          <span className="permission-mode-option-description">{option.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="turn-composer-submit-actions">
              <div className="model-effort-picker" ref={modelMenuRef}>
                <button
                  type="button"
                  className="model-effort-trigger"
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  aria-label={`Model ${triggerModelLabel}${triggerEffortLabel ? `, effort ${triggerEffortLabel}` : ''}`}
                  title={`${triggerModelLabel}${triggerEffortLabel ? ` / ${triggerEffortLabel}` : ''}`}
                  onClick={toggleModelMenu}
                >
                  <span className="model-effort-trigger-icon" aria-hidden="true">◉</span>
                  <span className="model-effort-trigger-copy">
                    <span className="model-effort-trigger-model">{triggerModelLabel}</span>
                    {triggerEffortLabel ? <span className="model-effort-trigger-effort">{triggerEffortLabel}</span> : null}
                  </span>
                </button>
                {modelMenuOpen ? (
                  <div className="model-effort-menu" role="menu" aria-label="Model and effort">
                    {!catalogModels.length ? <div className="model-effort-hint">Load models in Settings to choose one.</div> : null}
                    <div className="model-effort-models" role="group" aria-label="Models">
                      <button type="button" className="model-effort-option" role="menuitem" aria-current={model === DEFAULT_TURN_OPTION} onClick={chooseDefaultModel}>
                        <span className="model-effort-option-title">Claude Code default</span>
                        {model === DEFAULT_TURN_OPTION ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                      </button>
                      {catalogModels.length ? catalogModels.map((option) => {
                        const active = menuModel?.value === option.value
                        const selected = selectedModel?.value === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className="model-effort-option"
                            role="menuitem"
                            aria-current={active}
                            onMouseEnter={(event) => showEffortMenu(option, event.currentTarget)}
                            onFocus={(event) => showEffortMenu(option, event.currentTarget)}
                            onClick={(event) => option.supportsEffort && option.supportedEffortLevels?.length ? showEffortMenu(option, event.currentTarget) : chooseModelOnly(option)}
                          >
                            <span className="model-effort-option-title">{option.displayName || option.value}</span>
                            {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                          </button>
                        )
                      }) : null}
                    </div>
                    {menuModel?.supportsEffort && menuModel.supportedEffortLevels?.length ? (
                      <div className="model-effort-efforts" style={effortMenuPosition} role="group" aria-label={`${menuModel.displayName || menuModel.value} efforts`}>
                        {EFFORT_ORDER.filter((level) => menuModel.supportedEffortLevels!.includes(level)).map((level) => {
                          const selected = selectedModel?.value === menuModel.value && effort === level
                          return (
                            <button
                              key={`${menuModel.value}:${level}`}
                              type="button"
                              className="model-effort-option model-effort-option-compact"
                              role="menuitemradio"
                              aria-checked={selected}
                              onClick={() => chooseEffort(menuModel, level)}
                            >
                              <span className="model-effort-option-title">{effortLabel(level)}</span>
                              {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type={actionMode === 'submit' ? 'submit' : 'button'}
                className="turn-action-button"
                onClick={actionMode === 'stop' ? stopLiveTurn : undefined}
                disabled={actionMode === 'loading' || (actionMode === 'submit' && !inputText.trim())}
                aria-label={actionMode === 'loading' ? 'Submitting' : actionMode === 'stop' ? 'Stop generation' : 'Submit'}
              >
                {actionMode === 'loading' ? <span className="turn-spinner" aria-hidden="true" /> : actionMode === 'stop' ? <span className="turn-stop-icon" aria-hidden="true" /> : '↑'}
              </button>
            </div>
          </div>
        </div>
        {submitError ? <div className="panel error">{submitError}</div> : null}
      </form>
    </section>
  )
}

function WorkspacePanel({
  projectId,
  detail,
  selectedSessionId,
  setSelectedSessionId,
  refreshSessionLists,
  onProjectRequired,
  pendingProjectId,
  pendingProjectRequest,
  onSessionCreated,
  settings,
  sessionRuntime,
}: {
  projectId: string | null
  detail: ProjectSessionsResponse | undefined
  selectedSessionId: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  refreshSessionLists: (projectIds: string[]) => void
  onProjectRequired: (text: string) => void
  pendingProjectId: string | null
  pendingProjectRequest: number
  onSessionCreated: (projectId: string, sessionId: string) => void
  settings: AppSettings
  sessionRuntime: SessionRuntimeResponse | null
}) {
  const [liveUserMessageUuid, setLiveUserMessageUuid] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<TurnSummary | null>(null)

  useEffect(() => { setLiveUserMessageUuid(null) }, [projectId, selectedSessionId])
  useEffect(() => { setPendingTurn(null) }, [projectId])

  function refreshSessionListsForCurrentProject(targetProjectId = projectId) {
    if (targetProjectId) refreshSessionLists([targetProjectId])
  }

  function handleLiveTurnChange(userMessageUuid: string | null) {
    setLiveUserMessageUuid(userMessageUuid)
  }

  return (
    <section className="detail-panel workspace-main-panel">
      <div className="workspace-timeline">
        {projectId && (selectedSessionId || pendingTurn)
          ? <SessionTimeline projectId={projectId} sessionId={selectedSessionId} pendingTurn={pendingTurn} onLiveTurnChange={handleLiveTurnChange} onSessionListStale={refreshSessionListsForCurrentProject} />
          : null}
      </div>

      <TurnComposer
        projectId={projectId}
        selectedSessionId={selectedSessionId}
        liveUserMessageUuid={liveUserMessageUuid}
        setSelectedSessionId={setSelectedSessionId}
        setPendingTurn={setPendingTurn}
        refreshSessionLists={refreshSessionListsForCurrentProject}
        onProjectRequired={onProjectRequired}
        pendingProjectId={pendingProjectId}
        pendingProjectRequest={pendingProjectRequest}
        onSessionCreated={onSessionCreated}
        settings={settings}
        sessionRuntime={sessionRuntime}
      />
    </section>
  )
}

function SettingsPanel({ projectId, settings }: { projectId: string | null; settings: AppSettings }) {
  const queryClient = useQueryClient()
  const catalogModels = settings.modelCatalog?.models ?? []
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode ?? 'default')
  const [model, setModel] = useState<ModelSelection | DefaultTurnOption>(settings.defaultModel ?? DEFAULT_TURN_OPTION)
  const [effort, setEffort] = useState<EffortLevel | DefaultTurnOption>(settings.defaultEffort ?? DEFAULT_EFFORT)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [menuModelValue, setMenuModelValue] = useState<ModelSelection | DefaultTurnOption>(DEFAULT_TURN_OPTION)
  const [effortMenuPosition, setEffortMenuPosition] = useState<CSSProperties>()
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const selectedPermission = PERMISSION_MODE_OPTIONS.find((option) => option.value === permissionMode)
  const selectedModel = model === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === model || item.resolvedModel === model)
  const menuModel = menuModelValue === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === menuModelValue || item.resolvedModel === menuModelValue)
  const effortLevels = selectedModel?.supportsEffort ? EFFORT_ORDER.filter((level) => selectedModel.supportedEffortLevels?.includes(level)) : []
  const triggerModelLabel = selectedModel?.displayName || selectedModel?.value || 'Claude Code default'

  useEffect(() => {
    setPermissionMode(settings.defaultPermissionMode ?? 'default')
    setModel(settings.defaultModel ?? DEFAULT_TURN_OPTION)
    setEffort(settings.defaultEffort ?? DEFAULT_EFFORT)
  }, [settings.defaultPermissionMode, settings.defaultModel, settings.defaultEffort])

  useEffect(() => {
    if (model === DEFAULT_TURN_OPTION) { if (effort === DEFAULT_TURN_OPTION) setEffort(DEFAULT_EFFORT); return }
    if (!selectedModel) { setModel(DEFAULT_TURN_OPTION); setEffort(DEFAULT_EFFORT); return }
    if (!effortLevels.length) { setEffort(DEFAULT_EFFORT); return }
    if (effort === DEFAULT_TURN_OPTION || !effortLevels.includes(effort)) setEffort(defaultEffort(effortLevels))
  }, [model, selectedModel, effort, effortLevels])

  useEffect(() => {
    if (!permissionMenuOpen && !modelMenuOpen) return
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target as Node
      if (permissionMenuRef.current?.contains(target) || modelMenuRef.current?.contains(target)) return
      setPermissionMenuOpen(false)
      setModelMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPermissionMenuOpen(false)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionMenuOpen, modelMenuOpen])
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 2200)
    return () => window.clearTimeout(timer)
  }, [status])

  function showEffortMenu(option: ModelCatalogItem, target: HTMLElement) {
    const menu = modelMenuRef.current?.querySelector('.model-effort-menu')
    if (!(menu instanceof HTMLElement)) return
    const itemRect = target.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const effortCount = option.supportedEffortLevels?.length ?? 0
    const effortMenuHeight = Math.min(220, effortCount * 38 + 16)
    const alignedTop = itemRect.top - menuRect.top
    const maxTop = window.innerHeight - menuRect.top - effortMenuHeight - 16
    setMenuModelValue(option.value)
    setEffortMenuPosition({ top: Math.max(8, Math.min(alignedTop, maxTop)) })
  }

  function chooseModelOnly(nextModel: ModelSelection | DefaultTurnOption) {
    void saveModelDefault(nextModel, DEFAULT_TURN_OPTION)
  }

  function chooseEffort(option: ModelCatalogItem, nextEffort: EffortLevel) {
    void saveModelDefault(option.value, nextEffort)
  }

  async function loadCatalog() {
    if (catalogModels.length || catalogLoading) return
    setCatalogLoading(true)
    setStatus(null)
    try {
      const response = await refreshModelCatalog(projectId)
      queryClient.setQueryData(['settings'], response)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setCatalogLoading(false)
    }
  }

  async function savePermissionDefault(nextPermissionMode: PermissionMode) {
    setPermissionMode(nextPermissionMode)
    setPermissionMenuOpen(false)
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, defaultPermissionMode: nextPermissionMode })
      queryClient.setQueryData(['settings'], response)
      setStatus('Saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function saveModelDefault(nextModel: ModelSelection | DefaultTurnOption, nextEffort: EffortLevel | DefaultTurnOption) {
    setModel(nextModel)
    setEffort(nextEffort)
    setModelMenuOpen(false)
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, defaultModel: nextModel === DEFAULT_TURN_OPTION ? null : nextModel, defaultEffort: nextEffort === DEFAULT_TURN_OPTION ? null : nextEffort })
      queryClient.setQueryData(['settings'], response)
      setStatus('Saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function saveShowDebugNav(showDebugNav: boolean) {
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, showDebugNav })
      queryClient.setQueryData(['settings'], response)
      setStatus('Saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="detail-panel settings-panel" aria-label="Settings">
      <div className="settings-section">
        <h2>Settings</h2>
        <p className="muted">These defaults apply to new turns from the composer.</p>
      </div>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Default permission</h3>
          <p className="muted">Pick the permission mode used by new composer turns.</p>
        </div>
        <div className="settings-card-controls">
          <div className="permission-mode-picker settings-picker" ref={permissionMenuRef}>
            <button
              type="button"
              className="turn-tool-button permission-mode-trigger settings-trigger"
              aria-haspopup="menu"
              aria-expanded={permissionMenuOpen}
              onClick={() => setPermissionMenuOpen((open) => !open)}
            >
              <ComposerIcon name={permissionMode} />
              <span>{permissionMode}</span>
            </button>
            {permissionMenuOpen ? (
              <div className="permission-mode-menu settings-menu" role="menu" aria-label="Default permission mode">
                {PERMISSION_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="permission-mode-option"
                    role="menuitemradio"
                    aria-checked={permissionMode === option.value}
                    onClick={() => void savePermissionDefault(option.value)}
                  >
                    <span className="permission-mode-option-icon"><ComposerIcon name={option.value} /></span>
                    <span className="permission-mode-option-copy">
                      <span className="permission-mode-option-title">{option.value}</span>
                      <span className="permission-mode-option-description">{option.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <p className="settings-picked-copy">{selectedPermission?.description}</p>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Default model / effort</h3>
          <p className="muted">Choose what the composer should send by default.</p>
        </div>
        <div className="settings-card-controls">
          <div className="model-effort-picker settings-picker" ref={modelMenuRef}>
            <button
              type="button"
              className="model-effort-trigger settings-model-trigger"
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={() => { setMenuModelValue(DEFAULT_TURN_OPTION); setModelMenuOpen((open) => !open); void loadCatalog() }}
            >
              <span className="model-effort-trigger-icon" aria-hidden="true">◉</span>
              <span className="model-effort-trigger-copy">
                <span className="model-effort-trigger-model">{triggerModelLabel}</span>
                {(model === DEFAULT_TURN_OPTION || selectedModel?.supportsEffort && effort !== DEFAULT_TURN_OPTION) ? <span className="model-effort-trigger-effort">{effortLabel(effort)}</span> : null}
              </span>
            </button>
            {modelMenuOpen ? (
              <div className="model-effort-menu settings-menu" role="menu" aria-label="Default model and effort">
                {catalogLoading ? <div className="model-effort-hint">Loading model catalog…</div> : null}
                {!catalogLoading && !catalogModels.length ? <div className="model-effort-hint">No models found.</div> : null}
                <div className="model-effort-models" role="group" aria-label="Models">
                  <button type="button" className="model-effort-option" role="menuitem" aria-current={model === DEFAULT_TURN_OPTION} onClick={() => chooseModelOnly(DEFAULT_TURN_OPTION)}>
                    <span className="model-effort-option-title">Claude Code default</span>
                    {model === DEFAULT_TURN_OPTION ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                  </button>
                  {catalogModels.map((option) => {
                    const active = menuModel?.value === option.value
                    const selected = selectedModel?.value === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className="model-effort-option"
                        role="menuitem"
                        aria-current={active}
                        onMouseEnter={(event) => showEffortMenu(option, event.currentTarget)}
                        onFocus={(event) => showEffortMenu(option, event.currentTarget)}
                        onClick={(event) => option.supportsEffort && option.supportedEffortLevels?.length ? showEffortMenu(option, event.currentTarget) : chooseModelOnly(option.value)}
                      >
                        <span className="model-effort-option-title">{option.displayName || option.value}</span>
                        {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                      </button>
                    )
                  })}
                </div>
                {menuModel?.supportsEffort && menuModel.supportedEffortLevels?.length ? (
                  <div className="model-effort-efforts" style={effortMenuPosition} role="group" aria-label={`${menuModel.displayName || menuModel.value} efforts`}>
                    {EFFORT_ORDER.filter((level) => menuModel.supportedEffortLevels!.includes(level)).map((level) => {
                      const selected = selectedModel?.value === menuModel.value && effort === level
                      return (
                        <button
                          key={`${menuModel.value}:${level}`}
                          type="button"
                          className="model-effort-option model-effort-option-compact"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => chooseEffort(menuModel, level)}
                        >
                          <span className="model-effort-option-title">{effortLabel(level)}</span>
                          {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Show Debug</h3>
          <p className="muted">Keep the raw message inspector in the sidebar.</p>
        </div>
        <div className="settings-card-controls">
          <button
            type="button"
            className="settings-switch"
            role="switch"
            aria-checked={settings.showDebugNav !== false}
            disabled={saving}
            onClick={() => void saveShowDebugNav(settings.showDebugNav === false)}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </form>

      {status ? <div className="settings-toast" role="status">{status}</div> : null}
    </section>
  )
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="detail-panel settings-panel" aria-label={title}>
      <div className="settings-section">
        <h2>{title}</h2>
        <p className="muted">Coming soon.</p>
      </div>
    </section>
  )
}

function DebugWorkspacePanel({ projectId, sessionId }: { projectId: string | null; sessionId: string | null }) {
  const liveEvents = useSessionLiveEvents(projectId, sessionId)
  const rawMessages = useSessionRawMessages(projectId, sessionId)

  if (!projectId) return <div className="panel muted">Select a project to inspect captured live events.</div>

  return (
    <section className="detail-panel debug-page-panel debug-page-single" aria-label="Debug workspace">
      <div className="debug-page-content debug-workspace-content">
        {!sessionId ? <div className="panel muted">Select a session to inspect captured live events.</div> : null}
        {sessionId && liveEvents.isLoading ? <div className="panel muted">Loading captured live events…</div> : null}
        {sessionId && liveEvents.isError ? <div className="panel error">Failed to load captured live events: {liveEvents.error instanceof Error ? liveEvents.error.message : 'unknown error'}</div> : null}
        {sessionId && liveEvents.data ? <LiveEventsDebugView events={liveEvents.data.events} /> : null}
        {sessionId && rawMessages.isLoading ? <div className="panel muted">Loading raw messages…</div> : null}
        {sessionId && rawMessages.isError ? <div className="panel error">Failed to load raw messages: {rawMessages.error instanceof Error ? rawMessages.error.message : 'unknown error'}</div> : null}
        {sessionId && rawMessages.data ? <SessionDebugView rawMessages={rawMessages.data.messages} /> : null}
      </div>
    </section>
  )
}

function ProjectsDashboard() {
  const queryClient = useQueryClient()
  const [activeNav, setActiveNav] = useState<DashboardNavKey>(navKeyFromPath)
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    retry: false,
  })
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const settings = settingsQuery.data?.settings ?? {}
  const navItems = settings.showDebugNav === false ? DASHBOARD_NAV_ITEMS.filter((item) => item.key !== 'debug') : DASHBOARD_NAV_ITEMS
  const workspaceNavActive = activeNav === 'chat' || (settings.showDebugNav !== false && activeNav === 'debug')
  const selection = useProjectSessionSelection({ selectInitialProject: false, enabled: workspaceNavActive })
  const {
    selectedProjectId,
    selectedSessionId,
    clearSelection,
    selectProject,
    setSelectedSessionId,
  } = selection
  const [navWidth, setNavWidth] = useState(DASHBOARD_NAV_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const [projectChoice, setProjectChoice] = useState<{ text: string; mode: 'choose' | 'create'; error: string | null } | null>(null)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const [pendingProjectRequest, setPendingProjectRequest] = useState(0)
  const [refreshingLists, setRefreshingLists] = useState(false)
  const [selectedSessionRuntime, setSelectedSessionRuntime] = useState<SessionRuntimeResponse | null>(null)
  const [visibleSessionStates, setVisibleSessionStates] = useState<Record<string, { generation: number; loading: boolean; error: boolean }>>({})
  const [visibleProjectIds, setVisibleProjectIds] = useState<string[]>([])
  const navWidthRef = useRef(DASHBOARD_NAV_DEFAULT_WIDTH)
  const pendingSessionRequestRef = useRef(0)
  const listVersionEpochRef = useRef<string | null>(null)
  const desiredProjectsVersionRef = useRef(0)
  const acknowledgedProjectsVersionRef = useRef(-1)
  const desiredProjectVersionsRef = useRef(new Map<string, number>())
  const acknowledgedProjectVersionsRef = useRef(new Map<string, number>())
  const visibleSessionGenerationsRef = useRef(new Map<string, number>())
  const projectLoadMoreInFlightRef = useRef(false)
  useEffect(() => {
    function syncPathNav() { setActiveNav(navKeyFromPath()) }
    window.addEventListener('popstate', syncPathNav)
    return () => window.removeEventListener('popstate', syncPathNav)
  }, [])
  useEffect(() => {
    if (settings.showDebugNav === false && activeNav === 'debug') navigateNav('settings')
  }, [settings.showDebugNav, activeNav])

  function navigateNav(nextNav: DashboardNavKey) {
    if (nextNav === 'chat') beginNewConversation()
    history.pushState(null, '', `${routePath(nextNav)}${window.location.search}`)
    setActiveNav(nextNav)
  }

  async function handleLogout() {
    await logout()
    await authSession.refetch()
  }

  function beginSelectionIntent(): number {
    const requestId = pendingSessionRequestRef.current + 1
    pendingSessionRequestRef.current = requestId
    return requestId
  }

  function beginNewConversation() {
    beginSelectionIntent()
    setPendingProjectId(null)
    setSelectedSessionRuntime(null)
    selection.clearSelection()
  }

  function startPendingProject(projectId: string) {
    const requestId = beginSelectionIntent()
    setProjectChoice(null)
    setSelectedSessionRuntime(null)
    setPendingProjectId(projectId)
    setPendingProjectRequest(requestId)
  }

  function handleSessionCreated(projectId: string, sessionId: string) {
    selection.selectSession(projectId, sessionId)
    setSelectedSessionRuntime(null)
    setPendingProjectId(null)
  }

  async function createProjectForPendingTurn(directoryPath: string) {
    if (!projectChoice || projectChoice.mode !== 'create') return
    try {
      const { project } = await createProject(directoryPath)
      startPendingProject(project.id)
    } catch (error) {
      setProjectChoice((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : current)
    }
  }

  useEffect(() => {
    navWidthRef.current = navWidth
  }, [navWidth])

  useEffect(() => {
    try {
      const storedWidth = window.localStorage.getItem(DASHBOARD_NAV_WIDTH_STORAGE_KEY)
      if (!storedWidth) return
      const parsedWidth = Number(storedWidth)
      if (!Number.isFinite(parsedWidth)) return
      const nextWidth = clampDashboardNavWidth(parsedWidth)
      navWidthRef.current = nextWidth
      setNavWidth(nextWidth)
    } catch {
      // ignore localStorage read errors
    }
  }, [])

  function beginNavResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = navWidthRef.current
    setIsResizing(true)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = clampDashboardNavWidth(startWidth + moveEvent.clientX - startX)
      navWidthRef.current = nextWidth
      setNavWidth(nextWidth)
    }

    function finishResize() {
      setIsResizing(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      try {
        window.localStorage.setItem(DASHBOARD_NAV_WIDTH_STORAGE_KEY, String(navWidthRef.current))
      } catch {
        // ignore localStorage write errors
      }
    }

    function handlePointerUp() {
      finishResize()
    }

    function handlePointerCancel() {
      finishResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  const navCollapsed = navWidth <= DASHBOARD_NAV_COLLAPSE_WIDTH
  const detail = selection.projectSessions.data
  const selectedSession = detail?.sessions.find((session) => session.id === selectedSessionId)
    ?? queryClient.getQueryData<{ pages: Array<{ sessions: ProjectSessionsResponse['sessions'] }> }>(sessionQueryKeys.projectSessionsRail(selectedProjectId ?? ''))?.pages
      .flatMap((page) => page.sessions)
      .find((session) => session.id === selectedSessionId)
  const workspaceTitle = detail?.project.name ?? (selection.projectSessions.isLoading ? 'Loading project…' : selectedProjectId ? 'Project' : 'New conversation')

  const reconcileSelection = useCallback((selectionSnapshot: { intentId: number; projectId: string | null; sessionId: string | null }, outcomes: Map<string, { outcome: string; selectedSessionExists?: boolean }>) => {
    if (pendingSessionRequestRef.current !== selectionSnapshot.intentId || selectedProjectId !== selectionSnapshot.projectId || selectedSessionId !== selectionSnapshot.sessionId) return
    if (!selectionSnapshot.projectId) return
    const selectedProjectOutcome = outcomes.get(selectionSnapshot.projectId)
    if (selectedProjectOutcome?.outcome === 'missing') {
      const projects = queryClient.getQueryData<{ pages: Array<{ projects: Array<{ id: string }> }> }>(sessionQueryKeys.projects)
      const nextProjectId = projects?.pages.flatMap((page) => page.projects).find((project) => project.id !== selectionSnapshot.projectId)?.id
      if (nextProjectId) selectProject(nextProjectId)
      else clearSelection()
      return
    }
    if (selectedSessionId && selectedProjectOutcome?.selectedSessionExists === false) setSelectedSessionId(null)
  }, [clearSelection, queryClient, selectProject, selectedProjectId, selectedSessionId, setSelectedSessionId])

  const refreshVisibleWindows = useCallback(async (projectIds = visibleProjectIds) => {
    const targetProjectIds = [...new Set(projectIds)]
    if (targetProjectIds.length === 0) return new Map<string, { outcome: string; selectedSessionExists?: boolean }>()
    const selectionSnapshot = {
      intentId: pendingSessionRequestRef.current,
      projectId: selectedProjectId,
      sessionId: selectedSessionId,
    }
    const generations = new Map(targetProjectIds.map((projectId) => {
      const generation = (visibleSessionGenerationsRef.current.get(projectId) ?? 0) + 1
      visibleSessionGenerationsRef.current.set(projectId, generation)
      return [projectId, generation]
    }))
    setVisibleSessionStates((current) => ({
      ...current,
      ...Object.fromEntries(targetProjectIds.map((projectId) => [projectId, { generation: generations.get(projectId)!, loading: true, error: false }])),
    }))
    try {
      const outcomes = await refreshVisibleProjectSessions(queryClient, {
        selectedProjectId: selectionSnapshot.projectId,
        selectedSessionId: selectionSnapshot.sessionId,
        visibleProjectIds: targetProjectIds,
      })
      reconcileSelection(selectionSnapshot, outcomes)
      setVisibleSessionStates((current) => {
        const next = { ...current }
        for (const projectId of targetProjectIds) {
          if (next[projectId]?.generation !== generations.get(projectId)) continue
          next[projectId] = { generation: generations.get(projectId)!, loading: false, error: false }
        }
        return next
      })
      return outcomes
    } catch (error) {
      console.error('visible-sessions:refresh failed', error)
      setVisibleSessionStates((current) => {
        const next = { ...current }
        for (const projectId of targetProjectIds) {
          if (next[projectId]?.generation !== generations.get(projectId)) continue
          next[projectId] = { generation: generations.get(projectId)!, loading: false, error: true }
        }
        return next
      })
      return new Map<string, { outcome: string; selectedSessionExists?: boolean }>()
    }
  }, [queryClient, reconcileSelection, selectedProjectId, selectedSessionId, visibleProjectIds])

  const refreshProjectsOnly = useCallback(async () => {
    const desiredVersion = desiredProjectsVersionRef.current
    const epoch = listVersionEpochRef.current
    const outcome = await refreshProjectsWindow(queryClient)
    if (outcome === 'applied' && listVersionEpochRef.current === epoch) acknowledgedProjectsVersionRef.current = desiredVersion
    return outcome
  }, [queryClient])

  function handleSelectSession(projectId: string, sessionId: string) {
    const requestId = beginSelectionIntent()
    setSelectedSessionRuntime(null)
    if (projectId !== selectedProjectId || sessionId !== selectedSessionId) selection.selectSession(projectId, sessionId)
    void ensureSessionRuntime(projectId, sessionId).then((runtime) => {
      if (pendingSessionRequestRef.current === requestId) setSelectedSessionRuntime(runtime)
    }).catch(() => {})
  }

  useEffect(() => {
    const events = connectListVersions((event: ListVersionsEvent) => {
      const epochChanged = listVersionEpochRef.current !== event.epoch
      if (epochChanged) {
        listVersionEpochRef.current = event.epoch
        desiredProjectsVersionRef.current = 0
        acknowledgedProjectsVersionRef.current = -1
        desiredProjectVersionsRef.current.clear()
        acknowledgedProjectVersionsRef.current.clear()
      }
      desiredProjectsVersionRef.current = Math.max(desiredProjectsVersionRef.current, event.projectsVersion)
      for (const { projectId, version } of event.projectVersions) {
        desiredProjectVersionsRef.current.set(projectId, Math.max(desiredProjectVersionsRef.current.get(projectId) ?? 0, version))
      }
      if (epochChanged || desiredProjectsVersionRef.current > acknowledgedProjectsVersionRef.current) void refreshProjectsOnly()
      const projectIds = visibleProjectIds.filter((projectId) => epochChanged || (desiredProjectVersionsRef.current.get(projectId) ?? 0) > (acknowledgedProjectVersionsRef.current.get(projectId) ?? -1))
      if (projectIds.length === 0) return
      void refreshVisibleWindows(projectIds).then((outcomes) => {
        for (const projectId of projectIds) {
          if (outcomes.get(projectId)?.outcome !== 'applied') continue
          const desired = desiredProjectVersionsRef.current.get(projectId)
          if (desired !== undefined) acknowledgedProjectVersionsRef.current.set(projectId, desired)
        }
      })
    })
    return () => events.close()
  }, [refreshProjectsOnly, refreshVisibleWindows, visibleProjectIds])

  useEffect(() => {
    if (visibleProjectIds.length === 0) return
    void refreshVisibleWindows()
  }, [refreshVisibleWindows, visibleProjectIds])

  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === 'hidden') return
      void refreshProjectsOnly()
      if (visibleProjectIds.length > 0) void refreshVisibleWindows()
    }
    const timer = window.setInterval(refreshIfVisible, 60_000)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refreshProjectsOnly, refreshVisibleWindows, visibleProjectIds])

  async function handleRefreshLists() {
    if (refreshingLists) return
    setRefreshingLists(true)
    const epoch = listVersionEpochRef.current
    const desiredVersions = new Map(visibleProjectIds.map((projectId) => [projectId, desiredProjectVersionsRef.current.get(projectId)]))
    try {
      await refreshProjects(selection.selectedProjectId)
      await refreshProjectsOnly()
      const outcomes = await refreshVisibleWindows()
      if (listVersionEpochRef.current !== epoch) return
      for (const [projectId, desiredVersion] of desiredVersions) {
        if (desiredVersion === undefined || outcomes.get(projectId)?.outcome !== 'applied') continue
        acknowledgedProjectVersionsRef.current.set(projectId, Math.max(acknowledgedProjectVersionsRef.current.get(projectId) ?? -1, desiredVersion))
      }
    } finally {
      setRefreshingLists(false)
    }
  }

  if (workspaceNavActive && selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (workspaceNavActive && selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>

  return (
    <div
      className="dashboard-layout"
      data-nav-collapsed={navCollapsed ? 'true' : 'false'}
      data-nav-resizing={isResizing ? 'true' : 'false'}
      style={{ '--dashboard-nav-width': `${navWidth}px` } as CSSProperties}
    >
      <aside className="dashboard-nav-rail" aria-label="Dashboard navigation">
        <nav className="dashboard-nav-links" aria-label="Workspace sections">
          {navItems.map((item) => (
            <a
              key={item.key}
              className={`dashboard-nav-link ${activeNav === item.key ? 'active' : ''}`}
              href={`${item.path}${window.location.search}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                navigateNav(item.key)
              }}
              aria-current={activeNav === item.key ? 'page' : undefined}
              aria-label={item.label}
            >
              <span className="dashboard-nav-icon" aria-hidden="true"><DashboardNavIcon itemKey={item.key} /></span>
              <span className="dashboard-nav-label">{item.label}</span>
            </a>
          ))}
        </nav>
        {authSession.data?.authenticated ? <button className="dashboard-nav-link logout-link" type="button" onClick={() => void handleLogout()}>Logout</button> : null}
      </aside>
      {!workspaceNavActive ? (
        <section className="settings-page-shell">
          {activeNav === 'settings' ? <SettingsPanel projectId={null} settings={settings} /> : <PlaceholderPage title={DASHBOARD_NAV_ITEMS.find((item) => item.key === activeNav)?.label ?? 'Page'} />}
        </section>
      ) : (
        <section className="workspace-panel">
          <div className="dashboard-nav-resize-handle" role="separator" aria-label="Resize navigation sidebar" aria-orientation="vertical" onPointerDown={beginNavResize} />
        <header className="project-rail-header workspace-panel-header">
          <h2 className="project-rail-title" id="projects-sidebar-section-heading">Projects</h2>
          <button
            className="project-rail-header-action"
            type="button"
            onClick={handleRefreshLists}
            disabled={refreshingLists}
            aria-label="Refresh project and session lists"
            title="Refresh project and session lists"
          >
            {refreshingLists ? <span className="turn-spinner session-age-spinner" aria-hidden="true" /> : '↻'}
          </button>
          <button
            className="project-rail-header-action"
            type="button"
            onClick={beginNewConversation}
            disabled={refreshingLists}
            aria-label="Start new conversation"
            title="Start new conversation"
          >
            +
          </button>
        </header>
        <ProjectSessionRail
          projects={selection.items}
          selectedProjectId={selectedProjectId}
          selectedSessionId={selectedSessionId}
          pendingProjectId={null}
          pendingSessionId={null}
          projectsHasMore={selection.projects.hasNextPage}
          projectsLoadingMore={selection.projects.isFetchingNextPage}
          onLoadMoreProjects={() => {
            if (projectLoadMoreInFlightRef.current || !selection.projects.hasNextPage || selection.projects.isFetchingNextPage) return
            projectLoadMoreInFlightRef.current = true
            void selection.projects.fetchNextPage({ throwOnError: true }).catch((error) => {
              if (error instanceof PaginationCursorStaleError) return refreshProjectsWindow(queryClient)
            }).finally(() => {
              projectLoadMoreInFlightRef.current = false
            })
          }}
          visibleSessionStates={visibleSessionStates}
          onVisibleProjectIdsChange={setVisibleProjectIds}
          onSelectProject={(projectId) => {
            beginSelectionIntent()
            setSelectedSessionRuntime(null)
            selection.selectProject(projectId)
          }}
          onSelectSession={handleSelectSession}
          onSessionCursorStale={(projectId) => { void refreshVisibleWindows([projectId]) }}
        />
        <header className="workspace-main-header workspace-panel-header">
          <div className="project-title-block">
            <div className="project-session-title">
              <h2>{workspaceTitle}</h2>
              {selectedSession ? <span>{selectedSession.title}</span> : null}
            </div>
          </div>
          <div className="project-meta-lines">
            {selection.selectedSessionId ? <span className="project-meta-icon" data-tooltip={`Session ID: ${selection.selectedSessionId}`} aria-label={`Session ID: ${selection.selectedSessionId}`}>#</span> : null}
            {detail?.project.path ? <span className="project-meta-icon project-path-icon" data-tooltip={`Project directory: ${detail.project.path}`} aria-label={`Project directory: ${detail.project.path}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5h5l1.5 2h6.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 1.5 12Z" /></svg>
            </span> : null}
          </div>
        </header>
        {selection.projectSessions.isError ? <div className="panel error workspace-panel-error">Failed to load project sessions: {selection.projectSessions.error instanceof Error ? selection.projectSessions.error.message : 'unknown error'}</div> : activeNav === 'debug'
            ? <DebugWorkspacePanel projectId={selection.selectedProjectId} sessionId={selection.selectedSessionId} />
            : <WorkspacePanel
              projectId={selection.selectedProjectId}
              detail={selection.projectSessions.data}
              selectedSessionId={selection.selectedSessionId}
              setSelectedSessionId={selection.setSelectedSessionId}
              refreshSessionLists={refreshVisibleWindows}
              onProjectRequired={(text) => { setNewProjectPath(''); setProjectChoice({ text, mode: 'choose', error: null }) }}
              pendingProjectId={pendingProjectId}
              pendingProjectRequest={pendingProjectRequest}
              onSessionCreated={handleSessionCreated}
              settings={settings}
              sessionRuntime={selectedSessionRuntime}
            />}
        </section>
      )}
      {projectChoice ? (
        <dialog className="project-choice-dialog" open aria-labelledby="project-choice-title">
          <form className="project-choice-form" onSubmit={(event) => {
            event.preventDefault()
            if (projectChoice.mode === 'create') void createProjectForPendingTurn(newProjectPath)
          }}>
            <h2 id="project-choice-title">Choose a project</h2>
            <p>Your first message will start a new session in the selected project.</p>
            {projectChoice.mode === 'choose' ? (
              <>
                {selection.items.length > 0 ? (
                  <div className="project-choice-list">
                    {selection.items.map((project) => <button key={project.id} type="button" onClick={() => startPendingProject(project.id)}>{project.name}</button>)}
                  </div>
                ) : <p className="panel muted">No existing projects found.</p>}
                <button type="button" className="project-choice-link" onClick={() => setProjectChoice((current) => current ? { ...current, mode: 'create', error: null } : current)}>Create new project directory</button>
              </>
            ) : (
              <label className="project-choice-path">
                <span>Project path</span>
                <input value={newProjectPath} onChange={(event) => setNewProjectPath(event.target.value)} placeholder="experiments/demo-project" autoFocus />
              </label>
            )}
            {projectChoice.error ? <div className="panel error">{projectChoice.error}</div> : null}
            <div className="project-choice-actions">
              <button type="button" onClick={() => setProjectChoice(null)}>Cancel</button>
              {projectChoice.mode === 'create' ? <button type="submit" disabled={!newProjectPath.trim()}>Create and start</button> : null}
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  )
}

function DebugDashboard() {
  const selection = useProjectSessionSelection({ sessionLimit: 100 })
  const rawMessages = useSessionRawMessages(selection.selectedProjectId, selection.selectedSessionId)
  const sessions = selection.projectSessions.data?.sessions ?? []

  if (selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>
  if (selection.items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <section className="detail-panel debug-page-panel debug-page-single" aria-label="Debug workspace">
      <div className="debug-filter-bar" aria-label="Debug filters">
        <label className="debug-filter-field">
          <span>Project</span>
          <select value={selection.selectedProjectId ?? ''} onChange={(event) => selection.selectProject(event.target.value)}>
            {selection.items.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="debug-filter-field">
          <span>Session</span>
          <select
            value={selection.selectedSessionId ?? ''}
            onChange={(event) => {
              if (!selection.selectedProjectId || !event.target.value) return
              selection.selectSession(selection.selectedProjectId, event.target.value)
            }}
            disabled={selection.projectSessions.isLoading || sessions.length === 0}
          >
            {selection.projectSessions.isLoading ? <option value="">Loading sessions…</option> : null}
            {!selection.projectSessions.isLoading && sessions.length === 0 ? <option value="">No sessions</option> : null}
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.id} — {session.title}</option>)}
          </select>
        </label>
      </div>
      <div className="debug-page-content">
        {selection.projectSessions.isError ? <div className="panel error">Failed to load project sessions: {selection.projectSessions.error instanceof Error ? selection.projectSessions.error.message : 'unknown error'}</div> : null}
        {selection.projectSessions.isLoading ? <div className="panel muted">Loading project sessions…</div> : null}
        {!selection.projectSessions.isLoading && !selection.selectedSessionId ? <div className="panel muted">Select a session to inspect raw messages.</div> : null}
        {selection.selectedSessionId && rawMessages.isLoading ? <div className="panel muted">Loading raw messages…</div> : null}
        {selection.selectedSessionId && rawMessages.isError ? <div className="panel error">Failed to load raw messages: {rawMessages.error instanceof Error ? rawMessages.error.message : 'unknown error'}</div> : null}
        {selection.selectedSessionId && rawMessages.data ? <SessionDebugView rawMessages={rawMessages.data.messages} /> : null}
      </div>
    </section>
  )
}

function AccessRequired({ session }: { session?: { githubConfigured: boolean } }) {
  const queryClient = useQueryClient()
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!flow) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await pollGitHubDeviceLogin(flow.flowId)
        if (stopped) return
        if (response.status === 'authorized') {
          await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
          return
        }
        window.setTimeout(poll, response.interval * 1000)
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : String(error))
      }
    }
    const timer = window.setTimeout(poll, flow.interval * 1000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [flow, queryClient])

  async function startLogin() {
    setError(null)
    try {
      setFlow(await startGitHubDeviceLogin())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="panel access-required">
      <p className="eyebrow">Sign in</p>
      <h2>Open Cotta with GitHub.</h2>
      <p className="lede">GitHub authorizes your identity; Cotta stores a local HttpOnly session cookie.</p>
      {session?.githubConfigured ? <div className="login-actions"><button type="button" onClick={startLogin}>Sign in with GitHub</button></div> : null}
      {flow ? (
        <div className="panel login-device-flow">
          <p className="muted">Enter this code on GitHub:</p>
          <p className="login-code">{flow.userCode}</p>
          <a href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer">Open GitHub device login</a>
          <p className="muted">Waiting for authorization…</p>
        </div>
      ) : null}
      {error ? <div className="panel error">{error}</div> : null}
    </section>
  )
}

function App() {
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const session = authSession.data
  const authenticated = Boolean(session?.authenticated || (session && !session.githubConfigured))

  return (
    <main className="shell">
      {authSession.isLoading ? <div className="panel muted">Loading authentication…</div> : authenticated ? <ProjectsDashboard /> : <AccessRequired session={session} />}
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
