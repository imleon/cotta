import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PersistedLiveEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { fetchSessionLiveEvents, fetchSessionTimeline, fetchSessionTimelineState, withToken } from './api'

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
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const MarkdownValue = memo(function MarkdownValue({ value }: { value: string }) {
  return (
    <div className="debug-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  )
})

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
  source,
}: {
  value?: number
  className?: string
  copyText?: string | null
  copyLabel?: string
  source?: 'history' | 'live'
}) {
  const [copyStatus, setCopyStatus] = useState<'Copied' | 'Copy failed' | null>(null)
  const clearStatusRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = formatTimestamp(value)

  useEffect(() => () => {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
  }, [])

  if (!label || !value) return <span className={[timelineMessageClass.timestamp, className, 'invisible'].filter(Boolean).join(' ')} aria-hidden="true">&nbsp;</span>

  function showStatus(status: 'Copied' | 'Copy failed') {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
    setCopyStatus(status)
    clearStatusRef.current = setTimeout(() => setCopyStatus(null), 1600)
  }

  const copyIcon = copyStatus === 'Copied'
    ? <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
    : <svg viewBox="0 0 24 24" className="h-3 w-3 -scale-x-100" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>

  async function handleCopy() {
    if (!copyText) return
    try {
      await writeClipboard(copyText)
      showStatus('Copied')
    } catch {
      showStatus('Copy failed')
    }
  }

  const contents = (
    <>
      {copyText ? <button className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[rgb(60_60_67_/_12%)]" style={{ borderRadius: 5 }} type="button" aria-label={copyLabel} onClick={handleCopy}>{copyIcon}</button> : null}
      <time dateTime={new Date(value).toISOString()}>{label}</time>
      {source ? <span className="rounded-full bg-[rgb(60_60_67_/_8%)] px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.04em] text-[#636366]">{source}</span> : null}
      <span className="sr-only" aria-live="polite">{copyStatus}</span>
    </>
  )

  return <span className={[timelineMessageClass.timestamp, className].filter(Boolean).join(' ')}>{contents}</span>
}

function blockTitle(kind: string): string {
  if (kind === 'user.message') return 'User'
  if (kind === 'user.image') return 'Image'
  if (kind === 'user.file') return 'File'
  if (kind === 'assistant.text' || kind === 'assistant.message') return 'Assistant'
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
  if (kind === 'user.message' || kind === 'user.image' || kind === 'user.file') return 'user'
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

function toolIcon(toolName: string): string {
  const normalized = toolName.toLowerCase()
  if (/bash|shell|terminal/.test(normalized)) return '$'
  if (/read|write|edit|file|fs/.test(normalized)) return '▣'
  if (/search|grep|glob|find/.test(normalized)) return '⌕'
  if (/web|fetch|browser|http/.test(normalized)) return '◎'
  if (/task|agent|subagent/.test(normalized)) return '⚙'
  if (/git|github|gh/.test(normalized)) return '⑂'
  return '⌘'
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
          <span className={disclosureCardClass.icon} aria-hidden="true">{toolIcon(toolName)}</span>
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

function AttachmentBlockView({ block }: { block: TimelineBlock }) {
  const title = isRecord(block.data) && typeof block.data.name === 'string'
    ? block.data.name
    : isRecord(block.data) && typeof block.data.filename === 'string'
      ? block.data.filename
      : blockTitle(block.kind)
  const meta = isRecord(block.data)
    ? [block.data.media_type, block.data.mime_type, block.data.file_id].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ')
    : null
  return (
    <div className="timeline-block timeline-block-user">
      <div className="timeline-block-header">
        <span className="timeline-kind">{block.kind === 'user.image' ? 'Image' : 'File'}</span>
        <span className="timeline-kind-raw">{title}</span>
      </div>
      {meta ? <div className="timeline-text">{meta}</div> : null}
    </div>
  )
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

function TimelineBlockView({ block, timestamp, source }: { block: TimelineBlock; timestamp?: number; source?: 'history' | 'live' }) {
  const text = textFromData(block.data)

  if (block.kind === 'assistant.thinking') return <ThinkingBlockView block={block} />
  if (block.kind === 'assistant.task_notification') return <TaskNotificationBlockView block={block} />
  if (block.kind === 'user.image' || block.kind === 'user.file') return <AttachmentBlockView block={block} />

  if (block.kind === 'assistant.text' || block.kind === 'assistant.message') {
    return <div className="timeline-assistant-text"><MarkdownValue value={text ?? dataPreview(block.data)} /></div>
  }

  if (block.kind === 'user.message') {
    return (
      <div className={timelineMessageClass.rowUser}>
        <div className={timelineMessageClass.userStack}>
          <div className={timelineMessageClass.userBubble}>{text ?? dataPreview(block.data)}</div>
          <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampUser} copyText={text ?? dataPreview(block.data)} copyLabel="Copy user message" source={source} />
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

const TimelineRenderItemView = memo(function TimelineRenderItemView({ item, timestamp, source }: { item: TimelineRenderItem; timestamp?: number; source?: 'history' | 'live' }) {
  if (item.type === 'block') return <TimelineBlockView block={item.block} timestamp={timestamp} source={source} />
  return <ToolCallBlockView toolUse={item.toolUse} results={item.results} />
})

const AssistantResponseFrameView = memo(function AssistantResponseFrameView({ item, timestamp, source }: { item: AssistantResponseFrameItem; timestamp?: number; source?: 'history' | 'live' }) {
  const copyText = assistantResponseText(item.items)

  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response">
        <div className={timelineMessageClass.assistantFrameBody}>
          {item.items.map((child) => <TimelineRenderItemView item={child} key={timelineRenderItemKey(child)} />)}
        </div>
      </section>
      <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampAssistant} copyText={copyText} copyLabel="Copy assistant response" source={source} />
    </div>
  )
})

function persistedPayloadContent(payload: unknown): unknown {
  return isRecord(payload) && isRecord(payload.message) ? payload.message.content : undefined
}

function protocolAnomalyBlock(event: PersistedLiveEvent, reason: string): TimelineBlock {
  return { id: `live-event:${event.id}:protocol_anomaly`, kind: 'raw.protocol_anomaly', sourceEventIds: [`live-event:${event.id}`], data: { reason, raw: event.payload } }
}

function sdkMessageToTimelineBlocks(event: PersistedLiveEvent): TimelineBlock[] {
  const payload = event.payload
  const uuid = isRecord(payload) && typeof payload.uuid === 'string' ? payload.uuid : null
  const content = persistedPayloadContent(payload)
  if (!isRecord(payload) || payload.type === 'result') return []

  if (payload.type === 'assistant') {
    const apiMessageId = isRecord(payload.message) && typeof payload.message.id === 'string' ? payload.message.id : undefined
    if (!uuid) return [protocolAnomalyBlock(event, 'assistant message missing sdk uuid')]
    if (!apiMessageId) return [protocolAnomalyBlock(event, 'assistant message missing apiMessageId')]
    if (!Array.isArray(content)) return [{ id: `${uuid}:assistant`, kind: 'assistant.message', sourceEventIds: [uuid], apiMessageId, data: payload.message ?? payload }]
    return content.map((block, index): TimelineBlock => {
      const blockType = isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown_block'
      const toolUseId = isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' ? block.id : undefined
      return {
        id: `${uuid}:assistant:${index}`,
        kind: `assistant.${blockType}`,
        sourceEventIds: [uuid],
        ...(apiMessageId ? { apiMessageId } : {}),
        ...(toolUseId ? { contentBlockId: toolUseId, toolUseId } : {}),
        data: block,
      }
    })
  }

  if (payload.type === 'user') {
    if (!uuid) return [protocolAnomalyBlock(event, 'user message missing sdk uuid')]
    if (Array.isArray(content)) {
      return content.flatMap((block, index): TimelineBlock[] => {
        if (!isRecord(block)) return []
        if (block.type === 'tool_result') return [{ id: `${uuid}:tool_result:${index}`, kind: 'tool.result', sourceEventIds: [uuid], ...(typeof block.tool_use_id === 'string' ? { toolUseId: block.tool_use_id } : {}), data: block }]
        if (block.type === 'text' && typeof block.text === 'string') return [{ id: `${uuid}:user:${index}`, kind: 'user.message', sourceEventIds: [uuid], data: { text: block.text, status: 'confirmed', raw: block } }]
        if (block.type === 'image') return [{ id: `${uuid}:image:${index}`, kind: 'user.image', sourceEventIds: [uuid], data: block }]
        if (block.type === 'file' || block.type === 'document') return [{ id: `${uuid}:file:${index}`, kind: 'user.file', sourceEventIds: [uuid], data: block }]
        return []
      })
    }
    const text = textFromData({ content })
    return text ? [{ id: `${uuid}:user`, kind: 'user.message', sourceEventIds: [uuid], data: { text, status: 'confirmed', raw: isRecord(payload.message) ? payload.message : null } }] : []
  }

  return uuid ? [{ id: `${uuid}:raw`, kind: `raw.${String(payload.type)}`, sourceEventIds: [uuid], data: payload }] : [protocolAnomalyBlock(event, 'sdk message missing uuid')]
}

function liveEventsToTurns(sessionId: string, events: PersistedLiveEvent[]): TurnSummary[] {
  const blocks = events.flatMap(sdkMessageToTimelineBlocks)
  return blocks.length === 0 ? [] : [{ id: `live-events:${sessionId}`, sessionId, title: 'SDK events', startedAt: events[0]?.recordedAtMs, completedAt: events.at(-1)?.recordedAtMs, rawStatus: 'complete', displayStatus: 'complete', blocks }]
}

export type TimelineTurnIndex = { userMessageUuids: Set<string>; apiMessageIds: Set<string>; sourceEventIds: Set<string> }

type LiveAssistantBlockDraft = {
  id: string
  index: number
  kind: 'assistant.text' | 'assistant.thinking'
  text: string
  thinking: string
  sourceEventIds: string[]
}

type LiveAssistantMessageDraft = {
  ordinal: number
  apiMessageId?: string
  blocks: Map<number, LiveAssistantBlockDraft>
  finalized?: boolean
  invalid?: boolean
}

export class LiveAssistantStreamAccumulator {
  private nextAssistantOrdinal = 0
  private current: LiveAssistantMessageDraft | null = null
  private readonly byApiMessageId = new Map<string, LiveAssistantMessageDraft>()
  private readonly drafts: LiveAssistantMessageDraft[] = []

  constructor(private readonly userMessageUuid: string) {}

  processStreamEvent(message: Record<string, unknown>): TimelineBlock[] {
    if (!isRecord(message.event)) return []
    const event = message.event
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    const sourceEventId = sdkMessageUuid(message)
    const debugDelta = isRecord(event.delta) ? event.delta : null
    const debugContentBlock = isRecord(event.content_block) ? event.content_block : null
    if (eventType === 'message_start') {
      const apiMessageId = isRecord(event.message) && typeof event.message.id === 'string' ? event.message.id : undefined
      this.current = apiMessageId && this.byApiMessageId.get(apiMessageId) ? this.byApiMessageId.get(apiMessageId)! : this.createDraft(apiMessageId, !apiMessageId)
      return []
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0
      const contentBlock = isRecord(event.content_block) ? event.content_block : null
      const blockType = typeof contentBlock?.type === 'string' ? contentBlock.type : undefined
      if (blockType !== 'text' && blockType !== 'thinking') return []
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId) return []
      const block = this.ensureBlock(draft, index, blockType === 'thinking' ? 'assistant.thinking' : 'assistant.text')
      addUnique(block.sourceEventIds, sourceEventId)
      if (blockType === 'text' && typeof contentBlock?.text === 'string') block.text = contentBlock.text
      if (blockType === 'thinking' && typeof contentBlock?.thinking === 'string') block.thinking = contentBlock.thinking
      return this.snapshotIfVisible(block, draft.apiMessageId)
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = isRecord(event.delta) ? event.delta : null
      const deltaType = typeof delta?.type === 'string' ? delta.type : undefined
      if (deltaType !== 'text_delta' && deltaType !== 'thinking_delta') return []
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId) return []
      const block = this.ensureBlock(draft, index, deltaType === 'thinking_delta' ? 'assistant.thinking' : 'assistant.text')
      addUnique(block.sourceEventIds, sourceEventId)
      if (deltaType === 'text_delta' && typeof delta?.text === 'string') block.text += delta.text
      if (deltaType === 'thinking_delta' && typeof delta?.thinking === 'string') block.thinking += delta.thinking
      return this.snapshotIfVisible(block, draft.apiMessageId)
    }

    if (eventType === 'message_stop') this.current = null
    return []
  }

  finalAssistantBlocks(message: Record<string, unknown>): TimelineBlock[] {
    const uuid = sdkMessageUuid(message)
    const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
    if (!uuid || !apiMessageId) return []
    const draft = this.findDraft(apiMessageId)
    draft.finalized = true
    if (this.current === draft) this.current = null
    return assistantBlocksFromMessage(message, uuid, apiMessageId, `${this.userMessageUuid}:assistant:${draft.ordinal}`)
  }

  private createDraft(apiMessageId?: string, invalid = false): LiveAssistantMessageDraft {
    const draft = { ordinal: this.nextAssistantOrdinal++, apiMessageId, blocks: new Map<number, LiveAssistantBlockDraft>(), ...(invalid ? { invalid } : {}) }
    this.drafts.push(draft)
    if (apiMessageId) this.byApiMessageId.set(apiMessageId, draft)
    return draft
  }

  private ensureCurrent(): LiveAssistantMessageDraft {
    if (!this.current) this.current = this.createDraft(undefined, true)
    return this.current
  }

  private findDraft(apiMessageId: string): LiveAssistantMessageDraft {
    return this.byApiMessageId.get(apiMessageId) ?? this.drafts.find((draft) => !draft.finalized) ?? this.createDraft(apiMessageId)
  }

  private ensureBlock(draft: LiveAssistantMessageDraft, index: number, kind: LiveAssistantBlockDraft['kind']): LiveAssistantBlockDraft {
    const existing = draft.blocks.get(index)
    if (existing) return existing
    const block = { id: `${this.userMessageUuid}:assistant:${draft.ordinal}:${index}`, index, kind, text: '', thinking: '', sourceEventIds: [] }
    draft.blocks.set(index, block)
    return block
  }

  private snapshotIfVisible(block: LiveAssistantBlockDraft, apiMessageId?: string): TimelineBlock[] {
    const value = block.kind === 'assistant.text' ? block.text : block.thinking
    if (!value) return []
    return [{
      id: block.id,
      kind: block.kind,
      sourceEventIds: block.sourceEventIds,
      ...(apiMessageId ? { apiMessageId } : {}),
      data: block.kind === 'assistant.text' ? { type: 'text', text: block.text, streaming: true } : { type: 'thinking', thinking: block.thinking, streaming: true },
    }]
  }
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function sdkMessageUuid(message: Record<string, unknown>): string | undefined {
  return typeof message.uuid === 'string' ? message.uuid : undefined
}

function sdkMessageContent(message: Record<string, unknown>): unknown {
  return isRecord(message.message) ? message.message.content : undefined
}

function toolUseMetadata(block: unknown): Pick<TimelineBlock, 'contentBlockId' | 'toolUseId'> {
  if (!isRecord(block)) return {}
  if (block.type === 'tool_use' && typeof block.id === 'string') return { contentBlockId: block.id, toolUseId: block.id }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') return { toolUseId: block.tool_use_id }
  return {}
}

function assistantBlocksFromMessage(message: Record<string, unknown>, uuid: string, apiMessageId: string, idPrefix = `${uuid}:assistant`): TimelineBlock[] {
  const content = sdkMessageContent(message)
  if (!Array.isArray(content)) return [{ id: idPrefix, kind: 'assistant.message', sourceEventIds: [uuid], apiMessageId, data: isRecord(message.message) ? message.message : message }]
  return content.map((block, index): TimelineBlock => {
    const blockType = isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown_block'
    return {
      id: `${idPrefix}:${index}`,
      kind: `assistant.${blockType}`,
      sourceEventIds: [uuid],
      apiMessageId,
      ...toolUseMetadata(block),
      data: block,
    }
  })
}

function userBlocksFromMessage(message: Record<string, unknown>, uuid: string): TimelineBlock[] {
  const content = sdkMessageContent(message)
  if (Array.isArray(content)) {
    return content.flatMap((block, index): TimelineBlock[] => {
      if (!isRecord(block)) return []
      if (block.type === 'tool_result') return [{ id: `${uuid}:tool_result:${index}`, kind: 'tool.result', sourceEventIds: [uuid], ...toolUseMetadata(block), data: block }]
      if (block.type === 'text' && typeof block.text === 'string') return [{ id: `${uuid}:user:${index}`, kind: 'user.message', sourceEventIds: [uuid], data: { text: block.text, status: 'confirmed', raw: block } }]
      if (block.type === 'image') return [{ id: `${uuid}:image:${index}`, kind: 'user.image', sourceEventIds: [uuid], data: block }]
      if (block.type === 'file' || block.type === 'document') return [{ id: `${uuid}:file:${index}`, kind: 'user.file', sourceEventIds: [uuid], data: block }]
      return []
    })
  }
  const text = textFromData({ content })
  return text ? [{ id: `${uuid}:user`, kind: 'user.message', sourceEventIds: [uuid], data: { text, status: 'confirmed', raw: isRecord(message.message) ? message.message : null } }] : []
}

function turnApiMessageIds(turn: TurnSummary): Set<string> {
  const ids = new Set<string>()
  for (const block of turn.blocks) {
    if (block.apiMessageId) ids.add(block.apiMessageId)
  }
  return ids
}

function turnSourceEventIds(turn: TurnSummary): Set<string> {
  return new Set(turn.blocks.flatMap((block) => block.sourceEventIds))
}

export function timelineTurnIndex(turns: TurnSummary[]): TimelineTurnIndex {
  const userMessageUuids = new Set<string>()
  const apiMessageIds = new Set<string>()
  const sourceEventIds = new Set<string>()
  for (const turn of turns) {
    userMessageUuids.add(turn.id)
    for (const apiMessageId of turnApiMessageIds(turn)) apiMessageIds.add(apiMessageId)
    for (const sourceEventId of turnSourceEventIds(turn)) sourceEventIds.add(sourceEventId)
  }
  return { userMessageUuids, apiMessageIds, sourceEventIds }
}

function blockIsRepresentedBy(block: TimelineBlock, index: TimelineTurnIndex): boolean {
  if (block.apiMessageId && index.apiMessageIds.has(block.apiMessageId)) return true
  return block.sourceEventIds.some((sourceEventId) => index.sourceEventIds.has(sourceEventId))
}

function turnIsRepresentedBy(turn: TurnSummary, index: TimelineTurnIndex): boolean {
  if (index.userMessageUuids.has(turn.id)) return true
  for (const apiMessageId of turnApiMessageIds(turn)) {
    if (index.apiMessageIds.has(apiMessageId)) return true
  }
  for (const sourceEventId of turnSourceEventIds(turn)) {
    if (index.sourceEventIds.has(sourceEventId)) return true
  }
  return false
}

function turnOrderValue(turn: TurnSummary): number | null {
  return turn.startedAt ?? turn.completedAt ?? null
}

function isLiveTurn(turn: TurnSummary): boolean {
  return turn.id.startsWith('pending:') || turn.rawStatus === 'running'
}

function upsertBlock(blocks: TimelineBlock[], block: TimelineBlock): TimelineBlock[] {
  const index = blocks.findIndex((item) => item.id === block.id || item.sourceEventIds.some((sourceEventId) => block.sourceEventIds.includes(sourceEventId)))
  if (index === -1) return [...blocks, block]
  const next = [...blocks]
  next[index] = block
  return next
}

function upsertBlocks(blocks: TimelineBlock[], nextBlocks: TimelineBlock[], historyIndex: TimelineTurnIndex): TimelineBlock[] {
  return nextBlocks.filter((block) => !blockIsRepresentedBy(block, historyIndex)).reduce(upsertBlock, blocks)
}

type ApplySdkMessageResult = { turns: TurnSummary[]; currentUserMessageUuid: string | null; terminal: boolean }

export function applySdkMessage(
  turns: TurnSummary[],
  raw: unknown,
  historyIndex: TimelineTurnIndex,
  currentUserMessageUuid: string | null,
  accumulator: LiveAssistantStreamAccumulator | null,
): ApplySdkMessageResult {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { turns, currentUserMessageUuid, terminal: false }

  if (raw.type === 'user') {
    const uuid = sdkMessageUuid(raw)
    if (!uuid) return { turns, currentUserMessageUuid, terminal: false }
    const blocks = userBlocksFromMessage(raw, uuid)
    const hasUserMessage = blocks.some((block) => block.kind === 'user.message' || block.kind === 'user.image' || block.kind === 'user.file')
    if (!hasUserMessage && currentUserMessageUuid) {
      return {
        turns: turns.map((turn) => turn.id === currentUserMessageUuid ? { ...turn, blocks: upsertBlocks(turn.blocks, blocks, historyIndex) } : turn),
        currentUserMessageUuid,
        terminal: false,
      }
    }
    const turn: TurnSummary = { id: uuid, sessionId: typeof raw.session_id === 'string' ? raw.session_id : 'pending', title: shortText(textFromData({ content: sdkMessageContent(raw) }) ?? uuid, 80), startedAt: Date.now(), rawStatus: 'running', displayStatus: 'running', blocks }
    return { turns: turnIsRepresentedBy(turn, historyIndex) ? turns : [...turns.filter((item) => item.id !== uuid && !turnIsRepresentedBy(item, historyIndex)), turn], currentUserMessageUuid: uuid, terminal: false }
  }

  if (raw.type === 'stream_event' && currentUserMessageUuid && accumulator) {
    const blocks = accumulator.processStreamEvent(raw)
    return { turns: turns.map((turn) => turn.id === currentUserMessageUuid ? { ...turn, blocks: upsertBlocks(turn.blocks, blocks, historyIndex) } : turn), currentUserMessageUuid, terminal: false }
  }

  if (raw.type === 'assistant' && currentUserMessageUuid && accumulator) {
    const blocks = accumulator.finalAssistantBlocks(raw)
    return { turns: turns.map((turn) => turn.id === currentUserMessageUuid ? { ...turn, blocks: upsertBlocks(turn.blocks, blocks, historyIndex) } : turn), currentUserMessageUuid, terminal: false }
  }

  if (raw.type === 'result') return { turns, currentUserMessageUuid: null, terminal: true }
  return { turns, currentUserMessageUuid, terminal: false }
}

export function reconcileTimelineTurns(current: TurnSummary[], incoming: TurnSummary[]): TurnSummary[] {
  const incomingIndex = timelineTurnIndex(incoming)
  const mergedIncoming = incoming.map((turn) => {
    const liveTurn = current.find((item) => item.id === turn.id && isLiveTurn(item))
    if (!liveTurn) return turn
    const liveBlocks = liveTurn.blocks.filter((block) => !blockIsRepresentedBy(block, incomingIndex))
    if (liveBlocks.length === 0) return turn
    return { ...turn, rawStatus: 'running', displayStatus: 'running', blocks: [...turn.blocks, ...liveBlocks] }
  })
  const unreconciled = current.filter((turn) => !turnIsRepresentedBy(turn, incomingIndex))
  const firstIncomingOrder = mergedIncoming[0] ? turnOrderValue(mergedIncoming[0]) : null
  if (firstIncomingOrder === null) return [...mergedIncoming, ...unreconciled]
  const older: TurnSummary[] = []
  const newerOrUnknown: TurnSummary[] = []
  for (const turn of unreconciled) {
    const order = turnOrderValue(turn)
    if (order === null || order < firstIncomingOrder) older.push(turn)
    else newerOrUnknown.push(turn)
  }
  return [...older, ...mergedIncoming, ...newerOrUnknown]
}

function prependOlderTimelineTurns(current: TurnSummary[], older: TurnSummary[]): TurnSummary[] {
  const currentIndex = timelineTurnIndex(current)
  return [...older.filter((turn) => !turnIsRepresentedBy(turn, currentIndex)), ...current]
}

function useSessionTimelineData(
  projectId: string | null,
  sessionId: string | null,
  pendingTurn?: TurnSummary | null,
  onLiveTurnChange?: (userMessageUuid: string | null) => void,
  onSessionListStale?: () => void,
  isTimelineAtBottom?: () => boolean,
) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [liveConnectionError, setLiveConnectionError] = useState<string | null>(null)
  const shouldScrollToBottomRef = useRef(false)
  const lastAppliedTimelineVersionRef = useRef<string | null>(null)
  const historyIndexRef = useRef<TimelineTurnIndex>(timelineTurnIndex([]))
  const liveUserMessageUuidRef = useRef<string | null>(null)
  const liveAccumulatorRef = useRef<LiveAssistantStreamAccumulator | null>(null)
  const loadOlderRequestRef = useRef(0)
  const onLiveTurnChangeRef = useRef(onLiveTurnChange)
  const onSessionListStaleRef = useRef(onSessionListStale)
  const isTimelineAtBottomRef = useRef(isTimelineAtBottom)
  const refetchTimelineRef = useRef<() => unknown>(() => undefined)
  const refetchLiveEventsRef = useRef<() => unknown>(() => undefined)
  const effectiveSessionId = sessionId ?? pendingTurn?.sessionId ?? null
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
  const liveEvents = useQuery({
    queryKey: ['session-live-events', projectId, sessionId],
    queryFn: () => fetchSessionLiveEvents(projectId!, sessionId!),
    enabled,
    retry: false,
  })
  const refetchLiveEvents = liveEvents.refetch

  useEffect(() => {
    onLiveTurnChangeRef.current = onLiveTurnChange
    onSessionListStaleRef.current = onSessionListStale
    isTimelineAtBottomRef.current = isTimelineAtBottom
    refetchTimelineRef.current = refetchTimeline
    refetchLiveEventsRef.current = refetchLiveEvents
  })

  useEffect(() => {
    loadOlderRequestRef.current += 1
    setTurns([])
    setNextCursor(null)
    setHasMore(false)
    setOlderError(null)
    setLoadingOlder(false)
    setLiveConnectionError(null)
    lastAppliedTimelineVersionRef.current = null
    historyIndexRef.current = timelineTurnIndex([])
    liveUserMessageUuidRef.current = null
    liveAccumulatorRef.current = null
  }, [projectId, effectiveSessionId])

  useEffect(() => {
    if (!pendingTurn) return
    if (sessionId && pendingTurn.sessionId !== 'pending' && pendingTurn.sessionId !== sessionId) return
    shouldScrollToBottomRef.current = true
    liveUserMessageUuidRef.current = pendingTurn.id
    liveAccumulatorRef.current ??= new LiveAssistantStreamAccumulator(pendingTurn.id)
    setTurns((current) => {
      if (current.some((turn) => turn.id === pendingTurn.id)) return current
      return [...current.filter((turn) => !turn.id.startsWith('pending:')), pendingTurn]
    })
  }, [pendingTurn, sessionId])

  useEffect(() => {
    if (!timeline.data) return
    const previousVersion = lastAppliedTimelineVersionRef.current
    const nextVersion = timeline.data.state.version
    shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current?.() ?? true
    historyIndexRef.current = timelineTurnIndex(timeline.data.turns)
    setTurns((current) => reconcileTimelineTurns(current, timeline.data.turns))
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    lastAppliedTimelineVersionRef.current = nextVersion
    if (previousVersion && previousVersion !== nextVersion) onSessionListStaleRef.current?.()
  }, [isTimelineAtBottom, onSessionListStale, timeline.data])

  useEffect(() => {
    const version = timelineState.data?.state.version
    if (!version) return
    if (!lastAppliedTimelineVersionRef.current) return
    if (version === lastAppliedTimelineVersionRef.current) return
    if (timeline.isFetching) return
    void refetchTimeline()
  }, [refetchTimeline, timeline.isFetching, timelineState.data?.state.version, timelineState.dataUpdatedAt])

  useEffect(() => {
    if (!projectId || !sessionId) return
    const events = new EventSource(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`))
    events.onmessage = (message) => {
      let raw: unknown
      try {
        raw = JSON.parse(message.data)
      } catch (error) {
        console.error('timeline:sse invalid event', error)
        setLiveConnectionError('Live connection sent an invalid event; waiting for history…')
        void refetchTimelineRef.current()
        void refetchLiveEventsRef.current()
        return
      }
      setLiveConnectionError(null)
      if (isRecord(raw) && raw.type === 'user') {
        const userMessageUuid = sdkMessageUuid(raw)
        if (userMessageUuid && userMessageUuid !== liveUserMessageUuidRef.current) {
          liveUserMessageUuidRef.current = userMessageUuid
          liveAccumulatorRef.current = new LiveAssistantStreamAccumulator(userMessageUuid)
          onLiveTurnChangeRef.current?.(userMessageUuid)
        }
      }
      const terminal = isRecord(raw) && raw.type === 'result'
      if (isRecord(raw) && raw.type === 'stream_event' && liveUserMessageUuidRef.current && liveAccumulatorRef.current) {
        const userMessageUuid = liveUserMessageUuidRef.current
        const blocks = liveAccumulatorRef.current.processStreamEvent(raw)
        setTurns((current) => current.map((turn) => turn.id === userMessageUuid ? { ...turn, blocks: upsertBlocks(turn.blocks, blocks, historyIndexRef.current) } : turn))
      } else if (isRecord(raw) && raw.type === 'assistant' && liveUserMessageUuidRef.current && liveAccumulatorRef.current) {
        const userMessageUuid = liveUserMessageUuidRef.current
        const blocks = liveAccumulatorRef.current.finalAssistantBlocks(raw)
        setTurns((current) => current.map((turn) => turn.id === userMessageUuid ? { ...turn, blocks: upsertBlocks(turn.blocks, blocks, historyIndexRef.current) } : turn))
      } else {
        setTurns((current) => applySdkMessage(current, raw, historyIndexRef.current, liveUserMessageUuidRef.current, liveAccumulatorRef.current).turns)
      }
      if (terminal) {
        liveUserMessageUuidRef.current = null
        liveAccumulatorRef.current = null
        onLiveTurnChangeRef.current?.(null)
        void refetchTimelineRef.current()
        void refetchLiveEventsRef.current()
        onSessionListStaleRef.current?.()
      }
      shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current?.() ?? true
    }
    events.onopen = () => setLiveConnectionError(null)
    events.onerror = () => {
      setLiveConnectionError('Live connection interrupted; waiting for history…')
      void refetchTimelineRef.current()
      void refetchLiveEventsRef.current()
    }
    return () => events.close()
  }, [projectId, sessionId])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!projectId || !sessionId || !nextCursor || loadingOlder) return false
    const requestId = loadOlderRequestRef.current + 1
    loadOlderRequestRef.current = requestId
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await fetchSessionTimeline(projectId, sessionId, nextCursor)
      if (loadOlderRequestRef.current !== requestId) return false
      setTurns((current) => prependOlderTimelineTurns(current, page.turns))
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
      return true
    } catch (error) {
      if (loadOlderRequestRef.current !== requestId) return false
      setOlderError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (loadOlderRequestRef.current === requestId) setLoadingOlder(false)
    }
  }, [loadingOlder, nextCursor, projectId, sessionId])

  return {
    turns,
    hasMore,
    olderError,
    loadingOlder,
    liveConnectionError,
    timeline,
    eventTurns: sessionId && turns.length === 0 && liveEvents.data ? liveEventsToTurns(sessionId, liveEvents.data.events) : [],
    loadOlder,
    shouldScrollToBottomRef,
  }
}

export function SessionTimeline({ projectId, sessionId, pendingTurn, onLiveTurnChange, onSessionListStale }: {
  projectId: string
  sessionId: string | null
  pendingTurn?: TurnSummary | null
  onLiveTurnChange?: (userMessageUuid: string | null) => void
  onSessionListStale?: () => void
}) {
  const timelinePanelRef = useRef<HTMLElement | null>(null)
  const olderScrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const loadingOlderFromScrollRef = useRef(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const isTimelineAtBottom = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return true
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24
  }, [])
  const { turns, eventTurns, hasMore, olderError, loadingOlder, liveConnectionError, timeline, loadOlder, shouldScrollToBottomRef } = useSessionTimelineData(projectId, sessionId, pendingTurn, onLiveTurnChange, onSessionListStale, isTimelineAtBottom)
  const visibleTurns = turns.length > 0 ? turns : eventTurns
  const loadOlderKeepingAnchor = useCallback(async () => {
    const panel = timelinePanelRef.current
    if (!panel || !hasMore || loadingOlder || loadingOlderFromScrollRef.current) return
    loadingOlderFromScrollRef.current = true
    olderScrollAnchorRef.current = { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight }
    const loaded = await loadOlder()
    if (!loaded) olderScrollAnchorRef.current = null
    loadingOlderFromScrollRef.current = false
  }, [hasMore, loadOlder, loadingOlder])
  const handleTimelineScroll = useCallback(() => {
    const panel = timelinePanelRef.current
    setShowScrollToBottom(!isTimelineAtBottom())
    if (panel && panel.scrollTop <= 24) void loadOlderKeepingAnchor()
  }, [isTimelineAtBottom, loadOlderKeepingAnchor])
  const scrollToTimelineBottom = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return
    panel.scrollTop = panel.scrollHeight
    setShowScrollToBottom(false)
  }, [])

  useEffect(() => {
    olderScrollAnchorRef.current = null
    loadingOlderFromScrollRef.current = false
    shouldScrollToBottomRef.current = true
    setShowScrollToBottom(false)
  }, [projectId, sessionId, shouldScrollToBottomRef])

  useLayoutEffect(() => {
    const anchor = olderScrollAnchorRef.current
    if (!anchor) return
    olderScrollAnchorRef.current = null
    const panel = timelinePanelRef.current
    if (panel) panel.scrollTop = anchor.scrollTop + panel.scrollHeight - anchor.scrollHeight
  }, [visibleTurns])

  useLayoutEffect(() => {
    if (!shouldScrollToBottomRef.current) return
    shouldScrollToBottomRef.current = false
    const panel = timelinePanelRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [shouldScrollToBottomRef, visibleTurns])

  useLayoutEffect(() => {
    setShowScrollToBottom(!isTimelineAtBottom())
  }, [isTimelineAtBottom, visibleTurns])

  if (timeline.isLoading && visibleTurns.length === 0) return <div className="panel muted">Loading session timeline…</div>
  if (timeline.isError && visibleTurns.length === 0) return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>

  return (
    <section className="session-workspace-view" aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline" ref={timelinePanelRef} onScroll={handleTimelineScroll}>
        {hasMore ? <div className="section-heading"><button className="load-older" type="button" onClick={loadOlderKeepingAnchor} disabled={loadingOlder} aria-label={loadingOlder ? 'Loading older turns' : undefined}>{loadingOlder ? <span className="loading-dots" aria-hidden="true"><span /><span /><span /></span> : 'Load older'}</button></div> : null}
        {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
        {liveConnectionError ? <div className="panel muted">{liveConnectionError}</div> : null}
        {visibleTurns.length === 0 ? <div className="panel muted">This session has no projected turns yet.</div> : visibleTurns.map((turn) => {
          const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(turn.blocks))
          const lastAssistantFrameId = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')?.id
          const source = isLiveTurn(turn) ? 'live' : 'history'
          return (
            <article className="turn-card" key={turn.id}>
              <div className="timeline-blocks">{displayItems.map((item) => item.type === 'assistant-response-frame'
                ? <AssistantResponseFrameView item={item} timestamp={item.id === lastAssistantFrameId ? turn.completedAt : undefined} source={source} key={item.id} />
                : <TimelineRenderItemView item={item.item} timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.startedAt : undefined} source={source} key={timelineRenderItemKey(item.item)} />,
              )}</div>
            </article>
          )
        })}
      </section>
      {showScrollToBottom ? <button className="timeline-scroll-bottom" type="button" onClick={scrollToTimelineBottom} aria-label="Scroll to latest message"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v12m0 0 5-5m-5 5-5-5" /></svg></button> : null}
    </section>
  )
}
