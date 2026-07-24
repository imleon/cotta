import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StrictMode, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTurnResponseSchema,
  type ListVersionsEvent,
  sessionRawMessagesResponseSchema,
  type CreateTurnResponse,
  type PersistedLiveEvent,
  type ProjectSessionsResponse,
  type TurnSummary,
  type SessionRawMessagesResponse,
} from '@cotta/shared'
import { authToken, connectListVersions, ensureSessionRuntime, fetchSessionLiveEvents, fetchSessionTimeline, PaginationCursorStaleError, refreshProjects, withToken } from './api'
import { ProjectSessionRail, useProjectSessionSelection } from './session-history'
import { refreshProjectsWindow, refreshVisibleProjectSessions, sessionQueryKeys } from './session-query-refresh'
import { SessionTimeline } from './timeline'
import './styles.css'

const DASHBOARD_NAV_ITEMS = [
  { key: 'chat', label: 'Chat' },
  { key: 'debug', label: 'Debug' },
  { key: 'automations', label: 'Automations' },
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP' },
  { key: 'settings', label: 'Settings' },
] as const

function DashboardNavIcon({ itemKey }: { itemKey: (typeof DASHBOARD_NAV_ITEMS)[number]['key'] }) {
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

async function fetchSessionRawMessages(projectId: string, sessionId: string): Promise<SessionRawMessagesResponse> {
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/raw-messages`),
  )
  if (!response.ok) throw new Error(`Session raw messages request failed: ${response.status}`)
  return sessionRawMessagesResponseSchema.parse(await response.json())
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

async function createTurn(projectId: string, sessionId: string | null, text: string, userMessageUuid: string): Promise<CreateTurnResponse> {
  const path = sessionId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns`
    : `/api/projects/${encodeURIComponent(projectId)}/sessions`
  const response = await fetch(withToken(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, userMessageUuid }),
  })
  if (!response.ok) throw new CreateTurnHttpError(response.status)
  return createTurnResponseSchema.parse(await response.json())
}

async function interruptTurn(projectId: string, sessionId: string): Promise<void> {
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interrupt`),
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

function containsToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function hasUserTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
}

function isPrimaryUserMessage(value: unknown): boolean {
  const message = rawField(value, 'message')
  const content = isRecord(message) ? message.content : undefined
  return rawStringField(value, 'type') === 'user'
    && isRecord(message)
    && message.role === 'user'
    && !containsToolResult(content)
    && hasUserTextContent(content)
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
      data: { text, status: 'pending' },
    }],
  }
}

function TurnComposer({
  projectId,
  selectedSessionId,
  liveUserMessageUuid,
  setSelectedSessionId,
  setPendingTurn,
  refreshSessionLists,
}: {
  projectId: string
  selectedSessionId: string | null
  liveUserMessageUuid: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  setPendingTurn: Dispatch<SetStateAction<TurnSummary | null>>
  refreshSessionLists: () => void
}) {
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { setSubmitError(null); setInterrupting(false) }, [projectId, selectedSessionId])
  useEffect(() => { if (!liveUserMessageUuid) setInterrupting(false) }, [liveUserMessageUuid])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`
  }, [inputText])

  async function submitTurn() {
    if (submitting || liveUserMessageUuid || interrupting || !inputText.trim()) return
    const text = inputText.trim()
    const userMessageUuid = createUserMessageUuid()
    setSubmitting(true)
    setSubmitError(null)
    try {
      setPendingTurn(pendingUserTurn(text, selectedSessionId, userMessageUuid))
      setInputText('')
      const response = await createTurn(projectId, selectedSessionId, text, userMessageUuid)
      setSelectedSessionId(response.sessionId)
      setPendingTurn((turn) => turn ? { ...turn, sessionId: response.sessionId } : turn)
      await refreshProjects(projectId)
    } catch (error) {
      if (error instanceof CreateTurnHttpError) {
        setPendingTurn(null)
        setInputText(text)
        setSubmitError(error.message)
      } else {
        setSubmitError(`Submission status unknown. Check the timeline or session list before retrying. ${error instanceof Error ? error.message : String(error)}`)
        refreshSessionLists()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function stopLiveTurn() {
    if (!selectedSessionId || !liveUserMessageUuid || interrupting) return
    setInterrupting(true)
    setSubmitError(null)
    try {
      await interruptTurn(projectId, selectedSessionId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
      setInterrupting(false)
    }
  }

  const actionMode = submitting || interrupting ? 'loading' : liveUserMessageUuid ? 'stop' : 'submit'

  return (
    <section className="composer-card composer-card-bottom">
      <form className="turn-form" onSubmit={(event) => { event.preventDefault(); void submitTurn() }}>
        <div
          className="turn-composer"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button, textarea')) return
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
              void submitTurn()
            }}
            placeholder="Chat with Cotta..."
            rows={1}
          />
          <div className="turn-composer-footer">
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
}: {
  projectId: string | null
  detail: ProjectSessionsResponse | undefined
  selectedSessionId: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  refreshSessionLists: (projectIds: string[]) => void
}) {
  const [liveUserMessageUuid, setLiveUserMessageUuid] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<TurnSummary | null>(null)

  useEffect(() => { setLiveUserMessageUuid(null) }, [projectId, selectedSessionId])
  useEffect(() => { setPendingTurn(null) }, [projectId])

  if (!projectId) return <div className="panel muted">Select a project to view its timeline.</div>

  function refreshSessionListsForCurrentProject() {
    if (projectId) refreshSessionLists([projectId])
  }

  function handleLiveTurnChange(userMessageUuid: string | null) {
    setLiveUserMessageUuid(userMessageUuid)
  }

  return (
    <section className="detail-panel workspace-main-panel">
      <div className="workspace-timeline">
        {selectedSessionId || pendingTurn
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
      />
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
  const selection = useProjectSessionSelection()
  const {
    selectedProjectId,
    selectedSessionId,
    clearSelection,
    selectProject,
    setSelectedSessionId,
  } = selection
  const [activeNav, setActiveNav] = useState<(typeof DASHBOARD_NAV_ITEMS)[number]['key']>('chat')
  const [navWidth, setNavWidth] = useState(DASHBOARD_NAV_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const [pendingSessionTarget, setPendingSessionTarget] = useState<{ projectId: string; sessionId: string } | null>(null)
  const [refreshingLists, setRefreshingLists] = useState(false)
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

  function beginSelectionIntent(): number {
    const requestId = pendingSessionRequestRef.current + 1
    pendingSessionRequestRef.current = requestId
    setPendingSessionTarget(null)
    return requestId
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
  const workspaceTitle = detail?.project.name ?? (selection.projectSessions.isLoading ? 'Loading project…' : 'Project')
  const railSelectedProjectId = pendingSessionTarget?.projectId ?? selectedProjectId
  const railSelectedSessionId = pendingSessionTarget?.sessionId ?? selectedSessionId

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

  async function handleSelectSession(projectId: string, sessionId: string) {
    const requestId = beginSelectionIntent()
    if (projectId === selectedProjectId && sessionId === selectedSessionId) return
    setPendingSessionTarget({ projectId, sessionId })
    try {
      await queryClient.fetchQuery({
        queryKey: ['session-timeline', projectId, sessionId],
        queryFn: () => fetchSessionTimeline(projectId, sessionId),
        retry: false,
      })
      if (pendingSessionRequestRef.current !== requestId) return
      selection.selectSession(projectId, sessionId)
      void ensureSessionRuntime(projectId, sessionId).catch(() => {})
      setPendingSessionTarget(null)
    } catch {
      if (pendingSessionRequestRef.current !== requestId) return
      setPendingSessionTarget(null)
    }
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

  if (selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>
  if (selection.items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <div
      className="dashboard-layout"
      data-nav-collapsed={navCollapsed ? 'true' : 'false'}
      data-nav-resizing={isResizing ? 'true' : 'false'}
      style={{ '--dashboard-nav-width': `${navWidth}px` } as CSSProperties}
    >
      <aside className="dashboard-nav-rail" aria-label="Dashboard navigation">
        <nav className="dashboard-nav-links" aria-label="Workspace sections">
          {DASHBOARD_NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`dashboard-nav-link ${activeNav === item.key ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveNav(item.key)}
              aria-current={activeNav === item.key ? 'page' : undefined}
              aria-label={item.label}
            >
              <span className="dashboard-nav-icon" aria-hidden="true"><DashboardNavIcon itemKey={item.key} /></span>
              <span className="dashboard-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
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
            onClick={() => {
              if (!selection.selectedProjectId) return
              beginSelectionIntent()
              selection.startNewSession(selection.selectedProjectId)
            }}
            disabled={!selection.selectedProjectId || refreshingLists}
            aria-label="Create new session"
            title="Create new session"
          >
            +
          </button>
        </header>
        <ProjectSessionRail
          projects={selection.items}
          selectedProjectId={railSelectedProjectId}
          selectedSessionId={railSelectedSessionId}
          pendingProjectId={pendingSessionTarget?.projectId ?? null}
          pendingSessionId={pendingSessionTarget?.sessionId ?? null}
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
          : <WorkspacePanel projectId={selection.selectedProjectId} detail={selection.projectSessions.data} selectedSessionId={selection.selectedSessionId} setSelectedSessionId={selection.setSelectedSessionId} refreshSessionLists={refreshVisibleWindows} />}
      </section>
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

function AccessRequired() {
  return (
    <section className="panel access-required">
      <p className="eyebrow">Token required</p>
      <h2>Open this dashboard with a token.</h2>
      <p className="lede">Add <code>?token=&lt;token&gt;</code> to the URL to load projects and sessions.</p>
    </section>
  )
}

function App() {
  const token = authToken()

  return (
    <main className="shell">
      {token ? <ProjectsDashboard /> : <AccessRequired />}
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
