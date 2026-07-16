import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionStreamEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { fetchSessionTimeline, fetchSessionTimelineState, withToken } from './api'

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

function formatTimestamp(value?: number): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function MarkdownValue({ value }: { value: string }) {
  return (
    <div className="debug-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  )
}

function timelineDebugPayload(turns: TurnSummary[], rawLiveEvents: unknown[]) {
  return {
    loadedTurns: turns.length,
    loadedBlocks: turns.reduce((count, turn) => count + turn.blocks.length, 0),
    timeline: turns,
    rawLiveEvents,
  }
}

function TimelineTimestamp({ value, className = '' }: { value?: number; className?: string }) {
  const label = formatTimestamp(value)
  if (!label || !value) return null
  return <time className={`timeline-timestamp ${className}`} dateTime={new Date(value).toISOString()} title={new Date(value).toISOString()}>{label}</time>
}

function blockTitle(kind: string): string {
  if (kind === 'user.message') return 'User'
  if (kind === 'assistant.text') return 'Assistant'
  if (kind === 'assistant.tool_use') return 'Tool use'
  if (kind === 'tool.result') return 'Tool result'
  if (kind === 'error') return 'Error'
  if (kind.startsWith('stream.')) return 'Stream event'
  if (kind.startsWith('system.')) return 'System event'
  if (kind.startsWith('raw.')) return 'Raw event'
  return kind
}

function blockTone(kind: string): string {
  if (kind === 'user.message') return 'user'
  if (kind === 'assistant.text' || kind === 'assistant.message') return 'assistant'
  if (kind === 'assistant.tool_use' || kind === 'tool.result') return 'tool'
  if (kind === 'error') return 'danger'
  return 'muted'
}

function shouldCollapseBlock(kind: string): boolean {
  return kind.startsWith('stream.')
    || kind.startsWith('raw.')
    || kind.startsWith('system.')
    || kind === 'assistant.tool_use'
    || kind === 'tool.result'
}

type TimelineRenderItem =
  | { type: 'block'; block: TimelineBlock }
  | { type: 'tool-call'; toolUse: TimelineBlock | null; results: TimelineBlock[]; toolUseId: string }

type AssistantResponseFrameItem = { type: 'assistant-response-frame'; id: string; items: TimelineRenderItem[] }

type TimelineDisplayItem =
  | { type: 'item'; item: TimelineRenderItem }
  | AssistantResponseFrameItem

function thinkingTextFromBlock(block: TimelineBlock): string | null {
  const value = thinkingValue(block)
  return typeof value === 'string' ? value : null
}

function coalesceAdjacentAssistantThinkingBlocks(blocks: TimelineBlock[]): TimelineBlock[] {
  const result: TimelineBlock[] = []
  let pending: { block: TimelineBlock; text: string }[] = []

  function flushPending() {
    if (pending.length === 0) return
    if (pending.length === 1) {
      result.push(pending[0]!.block)
      pending = []
      return
    }

    const first = pending[0]!.block
    const sourceEventIds = Array.from(new Set(pending.flatMap(({ block }) => block.sourceEventIds)))
    const streaming = pending.some(({ block }) => isRecord(block.data) && block.data.streaming === true)
    result.push({
      ...first,
      sourceEventIds,
      data: {
        type: 'thinking',
        thinking: pending.map(({ text }) => text).join(''),
        ...(streaming ? { streaming: true } : {}),
      },
    })
    pending = []
  }

  for (const block of blocks) {
    if (block.kind !== 'assistant.thinking') {
      flushPending()
      result.push(block)
      continue
    }

    const text = thinkingTextFromBlock(block)
    if (text === null) {
      flushPending()
      result.push(block)
      continue
    }

    pending.push({ block, text })
  }

  flushPending()
  return result
}

function timelineRenderItemKey(item: TimelineRenderItem): string {
  if (item.type === 'block') return item.block.id
  return `tool-call:${item.toolUseId}:${item.toolUse?.id ?? item.results[0]?.id ?? 'pending'}`
}

function shouldFrameTimelineItem(item: TimelineRenderItem): boolean {
  if (item.type === 'tool-call') return true
  const kind = item.block.kind
  return kind.startsWith('assistant.') || kind.startsWith('system.') || kind === 'error'
}

function groupAssistantResponseFrames(items: TimelineRenderItem[]): TimelineDisplayItem[] {
  const grouped: TimelineDisplayItem[] = []
  let frameItems: TimelineRenderItem[] = []
  let frameIndex = 0

  function flushFrame() {
    if (frameItems.length === 0) return
    grouped.push({
      type: 'assistant-response-frame',
      id: `assistant-response:${frameIndex++}:${timelineRenderItemKey(frameItems[0]!)}`,
      items: frameItems,
    })
    frameItems = []
  }

  for (const item of items) {
    if (shouldFrameTimelineItem(item)) {
      frameItems.push(item)
      continue
    }
    flushFrame()
    grouped.push({ type: 'item', item })
  }

  flushFrame()
  return grouped
}

function groupTimelineBlocks(blocks: TimelineBlock[]): TimelineRenderItem[] {
  const displayBlocks = coalesceAdjacentAssistantThinkingBlocks(blocks)
  const resultsByToolUseId = new Map<string, TimelineBlock[]>()
  const matchedToolUseIds = new Set<string>()
  for (const block of displayBlocks) {
    if (block.kind === 'assistant.tool_use' && block.toolUseId) matchedToolUseIds.add(block.toolUseId)
    if (block.kind !== 'tool.result' || !block.toolUseId) continue
    resultsByToolUseId.set(block.toolUseId, [...(resultsByToolUseId.get(block.toolUseId) ?? []), block])
  }

  const consumedResults = new Set<string>()
  return displayBlocks.flatMap((block): TimelineRenderItem[] => {
    if (block.kind === 'assistant.tool_use' && block.toolUseId) {
      const results = resultsByToolUseId.get(block.toolUseId) ?? []
      for (const result of results) consumedResults.add(result.id)
      return [{ type: 'tool-call', toolUse: block, results, toolUseId: block.toolUseId }]
    }
    if (block.kind === 'tool.result' && block.toolUseId) {
      if (consumedResults.has(block.id) || matchedToolUseIds.has(block.toolUseId)) return []
      consumedResults.add(block.id)
      return [{ type: 'tool-call', toolUse: null, results: [block], toolUseId: block.toolUseId }]
    }
    return [{ type: 'block', block }]
  })
}

function toolDataField(block: TimelineBlock | null, key: string): unknown {
  return block && isRecord(block.data) ? block.data[key] : undefined
}

function toolDataString(block: TimelineBlock | null, key: string): string | null {
  const value = toolDataField(block, key)
  return typeof value === 'string' && value ? value : null
}

function toolResultIsError(block: TimelineBlock): boolean {
  if (!isRecord(block.data)) return false
  return block.data.is_error === true || block.data.is_err === true
}

function toolResultValue(block: TimelineBlock): unknown {
  if (!isRecord(block.data)) return block.data
  return block.data.content ?? block.data.result ?? block.data.output ?? block.data
}

function primitiveSummary(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return shortText(String(value), 72)
  return null
}

function keyValueSummary(value: unknown): string | null {
  if (!isRecord(value)) return primitiveSummary(value)
  const priorityKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']
  for (const key of priorityKeys) {
    const summary = primitiveSummary(value[key])
    if (summary) return `${key}: ${summary}`
  }
  for (const [key, field] of Object.entries(value)) {
    const summary = primitiveSummary(field)
    if (summary) return `${key}: ${summary}`
  }
  return shortText(dataPreview(value, 0), 72)
}

function toolInputSummary(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return shortText(dataPreview(value, 0), 72)
  return keyValueSummary(value)
}

function thinkingSummary(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return shortText(value, 88)
  return shortText(dataPreview(value, 0), 88)
}

function ToolResultTextValue({ value }: { value: string }) {
  return <pre className="timeline-tool-output-text">{value}</pre>
}

function ToolResultValue({ value }: { value: unknown }) {
  if (typeof value === 'string') return <ToolResultTextValue value={value} />
  return <pre className="timeline-tool-code">{dataPreview(value)}</pre>
}

function ToolCallBlockView({ toolUse, results }: { toolUse: TimelineBlock | null; results: TimelineBlock[] }) {
  const toolName = toolDataString(toolUse, 'name') ?? 'Tool result'
  const toolInput = toolDataField(toolUse, 'input')
  const summary = toolInputSummary(toolInput)
  const hasError = results.some(toolResultIsError)
  return (
    <details className="toolcard" aria-label={`Tool call ${toolName}`}>
      <summary className="toolcard-header">
        <div className="toolcard-heading">
          <span className="toolcard-icon" aria-hidden="true">⌘</span>
          <div className="toolcard-title">
            <strong className="toolcard-name">{toolName}</strong>
            {summary ? <span className="toolcard-summary">{summary}</span> : null}
            {!toolUse ? <span className="timeline-tool-unmatched">Unmatched</span> : null}
            {results.length === 0 ? <span className="timeline-tool-state">Pending</span> : null}
            {hasError ? <span className="timeline-tool-state timeline-tool-state-error">Error</span> : null}
          </div>
        </div>
        <span className="toolcard-expand" aria-hidden="true">
          <svg viewBox="0 0 12 12" className="toolcard-chevron" focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </summary>
      <div className="toolcard-body">
        {toolUse ? (
          <section className="timeline-tool-section">
            <div className="timeline-tool-section-label">Input</div>
            <pre className="timeline-tool-code">{dataPreview(toolInput)}</pre>
          </section>
        ) : null}
        <section className="timeline-tool-section">
          <div className="timeline-tool-section-label">Output</div>
          {results.length === 0 ? <div className="timeline-tool-pending">Waiting for tool result…</div> : results.map((result) => (
            <article className={`timeline-tool-result ${toolResultIsError(result) ? 'timeline-tool-result-error' : ''}`} key={result.id}>
              <ToolResultValue value={toolResultValue(result)} />
            </article>
          ))}
        </section>
      </div>
    </details>
  )
}

function thinkingValue(block: TimelineBlock): unknown {
  if (!isRecord(block.data)) return block.data
  return block.data.thinking ?? block.data.text ?? block.data.content ?? block.data
}

function ThinkingBlockView({ block }: { block: TimelineBlock }) {
  const value = thinkingValue(block)
  const summary = thinkingSummary(value)
  return (
    <details className="toolcard" aria-label="Assistant thinking">
      <summary className="toolcard-header">
        <div className="toolcard-heading">
          <span className="toolcard-icon" aria-hidden="true">✦</span>
          <div className="toolcard-title">
            <strong className="toolcard-name">Thinking</strong>
            {summary ? <span className="toolcard-summary">{summary}</span> : null}
          </div>
        </div>
        <span className="toolcard-expand" aria-hidden="true">
          <svg viewBox="0 0 12 12" className="toolcard-chevron" focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </summary>
      <div className="toolcard-body timeline-thinking-body">
        {typeof value === 'string' ? <MarkdownValue value={value} /> : <pre className="timeline-thinking-code">{dataPreview(value)}</pre>}
      </div>
    </details>
  )
}

function TimelineBlockView({ block, timestamp }: { block: TimelineBlock; timestamp?: number }) {
  const text = textFromData(block.data)

  if (block.kind === 'assistant.thinking') return <ThinkingBlockView block={block} />

  if (block.kind === 'assistant.text') {
    return <div className="timeline-assistant-text"><MarkdownValue value={text ?? dataPreview(block.data)} /></div>
  }

  if (block.kind === 'user.message') {
    return (
      <div className="timeline-message-row timeline-message-row-user">
        <div className="timeline-user-stack">
          <div className="timeline-user-bubble">{text ?? dataPreview(block.data)}</div>
          <TimelineTimestamp value={timestamp} className="timeline-timestamp-user" />
        </div>
      </div>
    )
  }

  const collapsible = shouldCollapseBlock(block.kind)
  return (
    <div className={`timeline-block timeline-block-${blockTone(block.kind)} ${block.kind.replaceAll('.', '-')}`}>
      <div className="timeline-block-header">
        <span className="timeline-kind">{blockTitle(block.kind)}</span>
        <span className="timeline-kind-raw">{block.kind}</span>
      </div>
      {text && !collapsible ? (
        <div className="timeline-text">{text}</div>
      ) : collapsible ? (
        <details className="timeline-raw">
          <summary>{text ? text.slice(0, 120) : 'View raw payload'}</summary>
          <pre>{dataPreview(block.data)}</pre>
        </details>
      ) : (
        <pre className="timeline-json">{dataPreview(block.data)}</pre>
      )}
    </div>
  )
}

function TimelineRenderItemView({ item, timestamp }: { item: TimelineRenderItem; timestamp?: number }) {
  if (item.type === 'block') return <TimelineBlockView block={item.block} timestamp={timestamp} />
  return <ToolCallBlockView toolUse={item.toolUse} results={item.results} />
}

function AssistantResponseFrameView({ item, timestamp }: { item: AssistantResponseFrameItem; timestamp?: number }) {
  return (
    <>
      <section className="timeline-assistant-response-frame" aria-label="Turn response">
        <div className="timeline-assistant-response-frame-body">
          {item.items.map((child) => <TimelineRenderItemView item={child} key={timelineRenderItemKey(child)} />)}
        </div>
      </section>
      <TimelineTimestamp value={timestamp} className="timeline-timestamp-assistant" />
    </>
  )
}

function upsertBlock(blocks: TimelineBlock[], next: TimelineBlock): TimelineBlock[] {
  const index = blocks.findIndex((block) => block.id === next.id)
  if (index === -1) return [...blocks, next]
  return blocks.map((block, currentIndex) => currentIndex === index ? next : block)
}

type TimelineTurnIndex = { turnIds: Set<string>; apiMessageIds: Set<string> }

function turnApiMessageIds(turn: TurnSummary): Set<string> {
  const ids = new Set<string>()
  for (const block of turn.blocks) {
    if (block.apiMessageId) ids.add(block.apiMessageId)
  }
  return ids
}

function timelineTurnIndex(turns: TurnSummary[]): TimelineTurnIndex {
  const turnIds = new Set<string>()
  const apiMessageIds = new Set<string>()
  for (const turn of turns) {
    turnIds.add(turn.id)
    for (const apiMessageId of turnApiMessageIds(turn)) apiMessageIds.add(apiMessageId)
  }
  return { turnIds, apiMessageIds }
}

function turnIsRepresentedBy(turn: TurnSummary, index: TimelineTurnIndex): boolean {
  if (index.turnIds.has(turn.id)) return true
  for (const apiMessageId of turnApiMessageIds(turn)) {
    if (index.apiMessageIds.has(apiMessageId)) return true
  }
  return false
}

function turnOrderValue(turn: TurnSummary): number | null {
  return turn.startedAt ?? turn.completedAt ?? null
}

function reconcileTimelineTurns(current: TurnSummary[], incoming: TurnSummary[]): TurnSummary[] {
  const incomingIndex = timelineTurnIndex(incoming)
  const unreconciled = current.filter((turn) => !turnIsRepresentedBy(turn, incomingIndex))
  const firstIncomingOrder = incoming[0] ? turnOrderValue(incoming[0]) : null
  if (firstIncomingOrder === null) return [...incoming, ...unreconciled]
  const older: TurnSummary[] = []
  const newerOrUnknown: TurnSummary[] = []
  for (const turn of unreconciled) {
    const order = turnOrderValue(turn)
    if (order !== null && order < firstIncomingOrder) older.push(turn)
    else newerOrUnknown.push(turn)
  }
  return [...older, ...incoming, ...newerOrUnknown]
}

function prependOlderTimelineTurns(current: TurnSummary[], older: TurnSummary[]): TurnSummary[] {
  const currentIndex = timelineTurnIndex(current)
  return [...older.filter((turn) => !turnIsRepresentedBy(turn, currentIndex)), ...current]
}

function applyLiveEvent(turns: TurnSummary[], event: SessionStreamEvent): TurnSummary[] {
  if (event.type === 'live.turn.started') return [...turns.filter((turn) => turn.id !== event.turnId), event.turn]
  if (event.type === 'live.timeline.block') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, blocks: upsertBlock(turn.blocks, event.block) }
      : turn)
  }
  if (event.type === 'live.turn.completed' || event.type === 'live.turn.interrupted') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, rawStatus: event.type === 'live.turn.interrupted' ? 'interrupted' : 'completed', displayStatus: event.type === 'live.turn.interrupted' ? 'interrupted' : 'complete', completedAt: event.completedAt }
      : turn)
  }
  if (event.type === 'live.turn.failed') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, rawStatus: 'failed', displayStatus: 'failed', completedAt: event.completedAt, blocks: [...turn.blocks, { id: `${event.turnId}:error`, kind: 'error', sourceEventIds: [event.turnId], data: { error: event.error } }] }
      : turn)
  }
  return turns
}

function useSessionTimelineData(
  projectId: string | null,
  sessionId: string | null,
  onLiveTurnChange?: (turnId: string | null) => void,
  onSessionListStale?: () => void,
) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [debugEvents, setDebugEvents] = useState<unknown[]>([])
  const shouldScrollToBottomRef = useRef(false)
  const lastAppliedTimelineVersionRef = useRef<string | null>(null)
  const liveTurnIdRef = useRef<string | null>(null)
  const pendingStateVersionRef = useRef<string | null>(null)
  const enabled = Boolean(projectId && sessionId)

  const timeline = useQuery({
    queryKey: ['session-timeline', projectId, sessionId],
    queryFn: () => fetchSessionTimeline(projectId!, sessionId!),
    enabled,
    retry: false,
  })
  const refetchTimeline = timeline.refetch
  const timelineState = useQuery({
    queryKey: ['session-timeline-state', projectId, sessionId],
    queryFn: () => fetchSessionTimelineState(projectId!, sessionId!),
    enabled,
    retry: false,
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
  })

  useEffect(() => {
    setTurns([])
    setNextCursor(null)
    setHasMore(false)
    setOlderError(null)
    setDebugEvents([])
    lastAppliedTimelineVersionRef.current = null
    liveTurnIdRef.current = null
    pendingStateVersionRef.current = null
  }, [projectId, sessionId])

  useEffect(() => {
    if (!timeline.data) return
    const previousVersion = lastAppliedTimelineVersionRef.current
    const nextVersion = timeline.data.state.version
    shouldScrollToBottomRef.current = true
    setTurns((current) => reconcileTimelineTurns(current, timeline.data.turns))
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    setDebugEvents([])
    lastAppliedTimelineVersionRef.current = nextVersion
    pendingStateVersionRef.current = null
    if (previousVersion && previousVersion !== nextVersion) onSessionListStale?.()
  }, [onSessionListStale, timeline.data])

  useEffect(() => {
    const version = timelineState.data?.state.version
    if (!version) return
    if (!lastAppliedTimelineVersionRef.current) return
    if (version === lastAppliedTimelineVersionRef.current) return
    if (liveTurnIdRef.current) {
      pendingStateVersionRef.current = version
      return
    }
    if (timeline.isFetching) return
    pendingStateVersionRef.current = version
    void refetchTimeline()
  }, [refetchTimeline, timeline.isFetching, timelineState.data?.state.version, timelineState.dataUpdatedAt])

  useEffect(() => {
    if (!projectId || !sessionId) return
    const events = new EventSource(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`))
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionStreamEvent
      if (event.type === 'live.raw') setDebugEvents((current) => [...current.slice(-49), event.raw])
      if ('turnId' in event) {
        if (event.type === 'live.turn.started') {
          liveTurnIdRef.current = event.turnId
          onLiveTurnChange?.(event.turnId)
        }
        if (event.type === 'live.turn.completed' || event.type === 'live.turn.failed' || event.type === 'live.turn.interrupted') {
          liveTurnIdRef.current = null
          onLiveTurnChange?.(null)
          void refetchTimeline()
        }
      }
      setTurns((current) => applyLiveEvent(current, event))
    }
    events.onerror = () => events.close()
    return () => events.close()
  }, [onLiveTurnChange, projectId, refetchTimeline, sessionId])

  async function loadOlder() {
    if (!projectId || !sessionId || !nextCursor || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await fetchSessionTimeline(projectId, sessionId, nextCursor)
      setTurns((current) => prependOlderTimelineTurns(current, page.turns))
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOlder(false)
    }
  }

  return {
    turns,
    hasMore,
    olderError,
    loadingOlder,
    debugEvents,
    debugPayload: timelineDebugPayload(turns, debugEvents),
    timeline,
    loadOlder,
    shouldScrollToBottomRef,
  }
}

export function SessionTimeline({ projectId, sessionId, onLiveTurnChange, onSessionListStale }: {
  projectId: string
  sessionId: string
  onLiveTurnChange?: (turnId: string | null) => void
  onSessionListStale?: () => void
}) {
  const timelineEndRef = useRef<HTMLDivElement | null>(null)
  const { turns, hasMore, olderError, loadingOlder, timeline, loadOlder, shouldScrollToBottomRef } = useSessionTimelineData(projectId, sessionId, onLiveTurnChange, onSessionListStale)

  useEffect(() => {
    if (!shouldScrollToBottomRef.current) return
    shouldScrollToBottomRef.current = false
    timelineEndRef.current?.scrollIntoView({ block: 'end' })
  }, [shouldScrollToBottomRef, turns])

  if (timeline.isLoading) return <div className="panel muted">Loading session timeline…</div>
  if (timeline.isError) return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>

  return (
    <section className="session-workspace-view" aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline">
        {hasMore ? <div className="section-heading"><button className="load-older" type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older'}</button></div> : null}
        {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
        {turns.length === 0 ? <div className="panel muted">This session has no projected turns yet.</div> : turns.map((turn) => {
          const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(turn.blocks))
          const lastAssistantFrameId = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')?.id
          return (
            <article className="turn-card" key={turn.id}>
              <div className="timeline-blocks">{displayItems.map((item) => item.type === 'assistant-response-frame'
                ? <AssistantResponseFrameView item={item} timestamp={item.id === lastAssistantFrameId ? turn.completedAt : undefined} key={item.id} />
                : <TimelineRenderItemView item={item.item} timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.startedAt : undefined} key={timelineRenderItemKey(item.item)} />,
              )}</div>
            </article>
          )
        })}
        <div ref={timelineEndRef} />
      </section>
    </section>
  )
}
