import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

async function writeClipboard(value: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // Fall back for HTTP origins or denied clipboard permissions.
  }

  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy failed')
}

function TimelineTimestamp({
  value,
  className = '',
  copyText,
  copyLabel,
}: {
  value?: number
  className?: string
  copyText?: string | null
  copyLabel?: string
}) {
  const [copyStatus, setCopyStatus] = useState<'Copied' | 'Copy failed' | null>(null)
  const clearStatusRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = formatTimestamp(value)

  useEffect(() => () => {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
  }, [])

  if (!label || !value) return null

  function showStatus(status: 'Copied' | 'Copy failed') {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
    setCopyStatus(status)
    clearStatusRef.current = setTimeout(() => setCopyStatus(null), 1600)
  }

  const contents = (
    <>
      <svg viewBox="0 0 24 24" className="h-3 w-3 -scale-x-100" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
      <time dateTime={new Date(value).toISOString()}>{label}</time>
      <span className="sr-only" aria-live="polite">{copyStatus}</span>
      {copyStatus ? <span aria-hidden="true">{copyStatus}</span> : null}
    </>
  )

  if (!copyText) return <span className={[timelineMessageClass.timestamp, className].filter(Boolean).join(' ')}>{contents}</span>

  return (
    <button
      type="button"
      className={[timelineMessageClass.timestamp, className].filter(Boolean).join(' ')}
      style={{ fontSize: '0.75rem' }}
      aria-label={copyLabel}
      onClick={async () => {
        try {
          await writeClipboard(copyText)
          showStatus('Copied')
        } catch {
          showStatus('Copy failed')
        }
      }}
    >
      {contents}
    </button>
  )
}

function blockTitle(kind: string): string {
  if (kind === 'user.message') return 'User'
  if (kind === 'assistant.text') return 'Assistant'
  if (kind === 'assistant.task_notification') return 'Task notification'
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
  if (kind === 'assistant.text' || kind === 'assistant.message' || kind === 'assistant.task_notification') return 'assistant'
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

function assistantResponseText(items: TimelineRenderItem[]): string | null {
  const text = items.flatMap((item) => {
    if (item.type !== 'block' || (item.block.kind !== 'assistant.text' && item.block.kind !== 'assistant.message')) return []
    const value = textFromData(item.block.data)
    return value ? [value] : []
  }).join('\n\n')
  return text || null
}

const disclosureCardClass = {
  root: 'group overflow-hidden rounded-[14px] border border-[rgb(60_60_67_/_13%)] bg-[var(--tl-surface)]',
  header: 'flex cursor-pointer list-none items-center justify-between gap-[9px] border-b border-transparent bg-[#f8f9fa] px-3 py-1.5 [&::-webkit-details-marker]:hidden group-open:border-[rgb(60_60_67_/_10%)]',
  heading: 'flex min-w-0 flex-1 items-center gap-2',
  icon: 'inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[rgb(60_60_67_/_8%)] text-[11px] font-black leading-none text-[#636366]',
  title: 'flex min-w-0 flex-1 flex-nowrap items-center gap-[5px] overflow-hidden',
  name: 'min-w-0 truncate text-xs font-medium leading-[1.2] text-[#1d1d1f]',
  summary: 'min-w-0 max-w-[min(46vw,520px)] flex-[1_1_0] truncate text-[11px] font-normal leading-[1.2] text-[var(--tl-muted,var(--color-muted))]',
  summaryDot: 'mr-[7px] text-[rgb(60_60_67_/_55%)]',
  expand: 'inline-grid h-6 w-6 shrink-0 place-items-center rounded-full leading-none text-[rgb(60_60_67_/_78%)]',
  chevron: 'h-[13px] w-[13px] overflow-visible fill-none stroke-current stroke-[1.8] transition-transform duration-[140ms] [stroke-linecap:round] [stroke-linejoin:round] group-open:rotate-90',
  body: 'grid gap-0 bg-[#fbfbfd]',
}

const toolTimelineClass = {
  state: 'shrink-0 rounded-full bg-[rgb(60_60_67_/_8%)] px-1.5 py-px text-[9px] font-extrabold uppercase tracking-[0.04em] text-[#636366]',
  stateError: 'bg-[var(--tl-danger-soft)] text-[var(--tl-danger)]',
  section: 'grid gap-2 px-3.5 py-3 [&+&]:pt-0',
  sectionLabel: 'text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--tl-muted)]',
  inputCode: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[10px] border border-[rgb(60_60_67_/_13%)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 font-mono text-[11px] leading-[1.6] text-[#2c2c2e]',
  resultCode: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-[1.6] text-[#2c2c2e]',
  outputText: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit] text-[11px] leading-[1.6] text-[#334155]',
  result: 'rounded-[10px] border border-[rgb(60_60_67_/_13%)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 text-[11px] leading-[1.6] text-[#1d1d1f]',
  resultError: 'border-[rgb(166_83_75_/_20%)] bg-[var(--tl-danger-soft)] text-[#8f4039]',
  pending: 'text-[11px] italic text-[var(--color-muted)]',
}

const thinkingTimelineClass = {
  body: 'px-3.5 py-3 text-sm leading-[1.65] text-[#1d1d1f]',
  code: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[10px] border border-[rgb(60_60_67_/_13%)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 font-mono text-[11px] leading-[1.6] text-[#2c2c2e]',
}

const timelineMessageClass = {
  rowUser: 'group flex min-w-0 items-end justify-end gap-[9px]',
  userStack: 'grid max-w-[min(76%,720px)] justify-items-end gap-1 max-[720px]:max-w-full max-[560px]:max-w-[min(86%,720px)]',
  userBubble: 'max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[14px] border border-[#cfe3fb] bg-[#e8f2ff] px-3.5 py-2.5 text-sm leading-[1.6] text-[#1d1d1f] shadow-[var(--tl-shadow-soft)]',
  timestamp: 'inline-flex items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-xs leading-4 text-[#76767b] opacity-0 transition-opacity duration-150 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.4]',
  timestampUser: 'pr-1 text-right group-hover:opacity-100 focus-visible:opacity-100',
  timestampAssistant: 'block -mt-[5px] px-1 group-hover:opacity-100 focus-visible:opacity-100',
  assistantFrame: 'group w-full max-w-none justify-self-stretch [&_.timeline-assistant-text]:px-1 [&_.timeline-assistant-text]:py-0.5 [&_.timeline-block]:shadow-none',
  assistantFrameBody: 'grid min-w-0 gap-2.5',
}

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
  return <pre className={toolTimelineClass.outputText}>{value}</pre>
}

function ToolResultValue({ value }: { value: unknown }) {
  if (typeof value === 'string') return <ToolResultTextValue value={value} />
  return <pre className={toolTimelineClass.resultCode}>{dataPreview(value)}</pre>
}

function ToolCallBlockView({ toolUse, results }: { toolUse: TimelineBlock | null; results: TimelineBlock[] }) {
  const toolName = toolDataString(toolUse, 'name') ?? 'Tool result'
  const toolInput = toolDataField(toolUse, 'input')
  const summary = toolInputSummary(toolInput)
  const hasError = results.some(toolResultIsError)
  return (
    <details className={disclosureCardClass.root} aria-label={`Tool call ${toolName}`}>
      <summary className={disclosureCardClass.header}>
        <div className={disclosureCardClass.heading}>
          <span className={disclosureCardClass.icon} aria-hidden="true">⌘</span>
          <div className={disclosureCardClass.title}>
            <strong className={disclosureCardClass.name}>{toolName}</strong>
            {summary ? (
              <span className={disclosureCardClass.summary}>
                <span aria-hidden="true" className={disclosureCardClass.summaryDot}>·</span>
                {summary}
              </span>
            ) : null}
            {!toolUse ? <span className={[toolTimelineClass.state, toolTimelineClass.stateError].join(' ')}>Unmatched</span> : null}
            {results.length === 0 ? <span className={toolTimelineClass.state}>Pending</span> : null}
            {hasError ? <span className={[toolTimelineClass.state, toolTimelineClass.stateError].join(' ')}>Error</span> : null}
          </div>
        </div>
        <span className={disclosureCardClass.expand} aria-hidden="true">
          <svg viewBox="0 0 12 12" className={disclosureCardClass.chevron} focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </summary>
      <div className={disclosureCardClass.body}>
        {toolUse ? (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Input</div>
            <pre className={toolTimelineClass.inputCode}>{dataPreview(toolInput)}</pre>
          </section>
        ) : null}
        <section className={toolTimelineClass.section}>
          <div className={toolTimelineClass.sectionLabel}>Output</div>
          {results.length === 0 ? <div className={toolTimelineClass.pending}>Waiting for tool result…</div> : results.map((result) => (
            <article className={[toolTimelineClass.result, toolResultIsError(result) ? toolTimelineClass.resultError : null].filter(Boolean).join(' ')} key={result.id}>
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
    <details className={disclosureCardClass.root} aria-label="Assistant thinking">
      <summary className={disclosureCardClass.header}>
        <div className={disclosureCardClass.heading}>
          <span className={disclosureCardClass.icon} aria-hidden="true">✦</span>
          <div className={disclosureCardClass.title}>
            <strong className={disclosureCardClass.name}>Thinking</strong>
            {summary ? (
              <span className={disclosureCardClass.summary}>
                <span aria-hidden="true" className={disclosureCardClass.summaryDot}>·</span>
                {summary}
              </span>
            ) : null}
          </div>
        </div>
        <span className={disclosureCardClass.expand} aria-hidden="true">
          <svg viewBox="0 0 12 12" className={disclosureCardClass.chevron} focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </summary>
      <div className={[disclosureCardClass.body, thinkingTimelineClass.body].join(' ')}>
        {typeof value === 'string' ? <MarkdownValue value={value} /> : <pre className={thinkingTimelineClass.code}>{dataPreview(value)}</pre>}
      </div>
    </details>
  )
}

function taskNotificationField(block: TimelineBlock, key: string): string | null {
  if (!isRecord(block.data)) return null
  const value = block.data[key]
  return typeof value === 'string' && value ? value : null
}

function TaskNotificationBlockView({ block }: { block: TimelineBlock }) {
  const summary = taskNotificationField(block, 'summary')
  const status = taskNotificationField(block, 'status')
  const taskId = taskNotificationField(block, 'taskId')
  const toolUseId = taskNotificationField(block, 'toolUseId')
  const outputFile = taskNotificationField(block, 'outputFile')
  const result = taskNotificationField(block, 'result')
  const text = taskNotificationField(block, 'text')
  const fields = [
    ['Task ID', taskId],
    ['Tool use ID', toolUseId],
    ['Output file', outputFile],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)

  return (
    <details className={disclosureCardClass.root} aria-label="Task notification">
      <summary className={disclosureCardClass.header}>
        <div className={disclosureCardClass.heading}>
          <span className={disclosureCardClass.icon} aria-hidden="true">↯</span>
          <div className={disclosureCardClass.title}>
            <strong className={disclosureCardClass.name}>Task Notification</strong>
            {summary ? (
              <span className={disclosureCardClass.summary}>
                <span aria-hidden="true" className={disclosureCardClass.summaryDot}>·</span>
                {summary}
              </span>
            ) : null}
            {status ? <span className={toolTimelineClass.state}>{status}</span> : null}
          </div>
        </div>
        <span className={disclosureCardClass.expand} aria-hidden="true">
          <svg viewBox="0 0 12 12" className={disclosureCardClass.chevron} focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </summary>
      <div className={disclosureCardClass.body}>
        {fields.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3 text-[11px] leading-[1.35] text-[#334155]">
            {fields.map(([label, value]) => (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[rgb(60_60_67_/_10%)] bg-[rgb(60_60_67_/_5%)] px-2 py-1" key={label}>
                <span className="shrink-0 font-semibold text-[var(--tl-muted)]">{label}</span>
                <span className="min-w-0 truncate font-mono text-[10px] text-[#2c2c2e]" title={value}>{value}</span>
              </span>
            ))}
          </div>
        ) : null}
        {result ? (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Result</div>
            <MarkdownValue value={result} />
          </section>
        ) : (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Raw notification</div>
            <pre className={toolTimelineClass.outputText}>{text ?? dataPreview(block.data)}</pre>
          </section>
        )}
      </div>
    </details>
  )
}

function TimelineBlockView({ block, timestamp }: { block: TimelineBlock; timestamp?: number }) {
  const text = textFromData(block.data)

  if (block.kind === 'assistant.thinking') return <ThinkingBlockView block={block} />
  if (block.kind === 'assistant.task_notification') return <TaskNotificationBlockView block={block} />

  if (block.kind === 'assistant.text') {
    return <div className="timeline-assistant-text"><MarkdownValue value={text ?? dataPreview(block.data)} /></div>
  }

  if (block.kind === 'user.message') {
    return (
      <div className={timelineMessageClass.rowUser}>
        <div className={timelineMessageClass.userStack}>
          <div className={timelineMessageClass.userBubble}>{text ?? dataPreview(block.data)}</div>
          <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampUser} copyText={text ?? dataPreview(block.data)} copyLabel="Copy user message" />
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
  const copyText = assistantResponseText(item.items)

  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response">
        <div className={timelineMessageClass.assistantFrameBody}>
          {item.items.map((child) => <TimelineRenderItemView item={child} key={timelineRenderItemKey(child)} />)}
        </div>
      </section>
      <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampAssistant} copyText={copyText} copyLabel="Copy assistant response" />
    </div>
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
    if (order === null || order < firstIncomingOrder) older.push(turn)
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
  isTimelineAtBottom?: () => boolean,
) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [debugEvents, setDebugEvents] = useState<unknown[]>([])
  const shouldScrollToBottomRef = useRef(false)
  const lastAppliedTimelineVersionRef = useRef<string | null>(null)
  const liveTurnIdsRef = useRef(new Set<string>())
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
    liveTurnIdsRef.current.clear()
    pendingStateVersionRef.current = null
  }, [projectId, sessionId])

  useEffect(() => {
    if (!timeline.data) return
    const previousVersion = lastAppliedTimelineVersionRef.current
    const nextVersion = timeline.data.state.version
    shouldScrollToBottomRef.current ||= isTimelineAtBottom?.() ?? true
    setTurns((current) => reconcileTimelineTurns(current, timeline.data.turns))
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    setDebugEvents([])
    lastAppliedTimelineVersionRef.current = nextVersion
    pendingStateVersionRef.current = null
    if (previousVersion && previousVersion !== nextVersion) onSessionListStale?.()
  }, [isTimelineAtBottom, onSessionListStale, timeline.data])

  useEffect(() => {
    const version = timelineState.data?.state.version
    if (!version) return
    if (!lastAppliedTimelineVersionRef.current) return
    if (version === lastAppliedTimelineVersionRef.current) return
    if (liveTurnIdsRef.current.size > 0) {
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
          liveTurnIdsRef.current.add(event.turnId)
          onLiveTurnChange?.(event.turnId)
        }
        if (event.type === 'live.turn.completed' || event.type === 'live.turn.failed' || event.type === 'live.turn.interrupted') {
          liveTurnIdsRef.current.delete(event.turnId)
          if (liveTurnIdsRef.current.size === 0) {
            onLiveTurnChange?.(null)
            void refetchTimeline()
          }
        }
      }
      shouldScrollToBottomRef.current ||= isTimelineAtBottom?.() ?? true
      setTurns((current) => applyLiveEvent(current, event))
    }
    events.onerror = () => events.close()
    return () => events.close()
  }, [isTimelineAtBottom, onLiveTurnChange, projectId, refetchTimeline, sessionId])

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
  const timelinePanelRef = useRef<HTMLElement | null>(null)
  const isTimelineAtBottom = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return true
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24
  }, [])
  const { turns, hasMore, olderError, loadingOlder, timeline, loadOlder, shouldScrollToBottomRef } = useSessionTimelineData(projectId, sessionId, onLiveTurnChange, onSessionListStale, isTimelineAtBottom)

  useLayoutEffect(() => {
    if (!shouldScrollToBottomRef.current) return
    shouldScrollToBottomRef.current = false
    const panel = timelinePanelRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [shouldScrollToBottomRef, turns])

  if (timeline.isLoading) return <div className="panel muted">Loading session timeline…</div>
  if (timeline.isError) return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>

  return (
    <section className="session-workspace-view" aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline" ref={timelinePanelRef}>
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
      </section>
    </section>
  )
}
