import { Children, isValidElement, memo, type ComponentPropsWithoutRef, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { codeToHtml } from 'shiki'
import { isPrimaryTimelineUserMessage, isTimelineTaskNotificationMessage, timelineTaskNotificationToolUseId, timelineToolUseId, type PersistedLiveEvent, type SessionInfoResponse, type SessionRunState, type SessionStatus, type SessionTask, type SessionTimelineResponse, type TimelineBlock, type TurnSummary } from '@cotta/shared'
import { fetchSessionInfo, fetchSessionLiveEvents, fetchSessionRawMessages, fetchSessionTimeline } from './api'

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

function textFromReactNode(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textFromReactNode).join('')
  if (isValidElement<{ children?: ReactNode }>(value)) return textFromReactNode(value.props.children)
  return ''
}

function codeLanguage(className?: string): string | null {
  return className?.match(/language-([\w-]+)/)?.[1] ?? null
}

function guessCodeLanguage(code: string): string {
  const trimmed = code.trim()
  if (/^(export\s+\w+=|(?:npm|pnpm|yarn|curl|git|claude)\b|[\w./-]+\s*\\\n)/m.test(trimmed)) return 'bash'
  if (/^[\[{]/.test(trimmed)) return 'json'
  if (/\b(import|export|const|let|function|type|interface)\b/.test(trimmed)) return 'ts'
  return 'text'
}

const highlightedCodeCache = new Map<string, string>()

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  const external = /^https?:\/\//.test(href ?? '')
  return <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} {...props}>{children}</a>
}

function HighlightedCode({ className, children }: { className?: string; children?: ReactNode }) {
  const code = textFromReactNode(children).replace(/\n$/, '')
  const explicitLang = codeLanguage(className)
  const lang = explicitLang ?? guessCodeLanguage(code)
  const cacheKey = `${lang}\0${code}`
  const [html, setHtml] = useState<string | null>(() => highlightedCodeCache.get(cacheKey) ?? null)
  const [wrapped, setWrapped] = useState(true)
  const [copyStatus, setCopyStatus] = useState<'Copy' | 'Copied' | 'Failed'>('Copy')
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current)
  }, [])

  useEffect(() => {
    const cached = highlightedCodeCache.get(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }
    setHtml(null)

    let cancelled = false
    void codeToHtml(code, { lang, theme: 'github-light' })
      .then((value) => {
        highlightedCodeCache.set(cacheKey, value)
        if (highlightedCodeCache.size > 200) {
          const oldest = highlightedCodeCache.keys().next().value
          if (oldest) highlightedCodeCache.delete(oldest)
        }
        if (!cancelled) setHtml(value)
      })
      .catch(() => { if (!cancelled) setHtml(null) })
    return () => { cancelled = true }
  }, [cacheKey, code, lang])

  async function handleCopy() {
    try {
      await writeClipboard(code)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Failed')
    }
    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current)
    copyStatusTimerRef.current = setTimeout(() => setCopyStatus('Copy'), 1400)
  }

  return (
    <div className="markdown-code-block" data-wrap={wrapped ? 'true' : 'false'}>
      <div className="markdown-code-toolbar">
        {explicitLang ? <span className="markdown-code-language">{explicitLang}</span> : null}
        <button type="button" aria-label={wrapped ? 'Disable line wrap' : 'Enable line wrap'} data-tooltip={wrapped ? 'No wrap' : 'Wrap'} onClick={() => setWrapped((value) => !value)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h8a3 3 0 1 1 0 6H9" /><path d="m11 13-2 3 2 3" /></svg></button>
        <button type="button" aria-label="Copy code" data-tooltip={copyStatus} onClick={handleCopy}>{copyStatus === 'Copied' ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.5 4 4L16 6" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M4 13V5a1 1 0 0 1 1-1h8" /></svg>}</button>
      </div>
      {html ? <div className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code className={className}>{children}</code></pre>}
    </div>
  )
}

const MarkdownValue = memo(function MarkdownValue({ value }: { value: string }) {
  return (
    <div className="debug-markdown">
      <ReactMarkdown
        components={{
          a: MarkdownLink,
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children }) {
            const childList = Children.toArray(children)
            const inline = !className && childList.every((child) => typeof child === 'string' && !child.includes('\n'))
            return inline ? <code className={className}>{children}</code> : <HighlightedCode className={className}>{children}</HighlightedCode>
          },
        }}
        remarkPlugins={[remarkGfm]}
      >{value}</ReactMarkdown>
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
  onViewRaw,
  viewRawLabel,
  extraActions,
  source,
}: {
  value?: number
  className?: string
  copyText?: string | null
  copyLabel?: string
  onViewRaw?: () => void
  viewRawLabel?: string
  extraActions?: ReactNode
  source?: 'history' | 'live'
}) {
  const [copyStatus, setCopyStatus] = useState<'Copied' | 'Copy failed' | null>(null)
  const clearStatusRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = formatTimestamp(value)

  useEffect(() => () => {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
  }, [])

  if ((!label || !value) && !copyText && !onViewRaw && !extraActions) return <span className={[timelineMessageClass.timestamp, className, 'invisible'].filter(Boolean).join(' ')} aria-hidden="true">&nbsp;</span>

  function showStatus(status: 'Copied' | 'Copy failed') {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
    setCopyStatus(status)
    clearStatusRef.current = setTimeout(() => setCopyStatus(null), 1600)
  }

  const copyIcon = copyStatus === 'Copied'
    ? <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
    : <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>

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
      {copyText ? <button className="timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)]" style={{ borderRadius: 5 }} type="button" aria-label={copyLabel} data-tooltip={copyStatus === 'Copied' ? 'Copied' : 'Copy' } onClick={handleCopy}>{copyIcon}</button> : null}
      {onViewRaw ? <button className="timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)]" style={{ borderRadius: 5 }} type="button" aria-label={viewRawLabel} data-tooltip="Trace" onClick={onViewRaw}><svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></svg></button> : null}
      {extraActions}
      {label && value ? <time dateTime={new Date(value).toISOString()}>{label}</time> : null}
      {source ? <span className="rounded-full bg-[var(--tl-surface-soft)] px-1.5 py-px text-[var(--text-xs)] font-bold uppercase tracking-[0.04em] text-[var(--tl-muted)]">{source}</span> : null}
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

export type TimelineRenderItem =
  | { type: 'block'; block: TimelineBlock }
  | { type: 'tool-call'; toolUse: TimelineBlock | null; results: TimelineBlock[]; toolUseId: string }

type AssistantResponseFrameItem = { type: 'assistant-response-frame'; id: string; items: TimelineRenderItem[] }

function timelineRenderItemBlocks(item: TimelineRenderItem): TimelineBlock[] {
  return item.type === 'block' ? [item.block] : [...(item.toolUse ? [item.toolUse] : []), ...item.results]
}

export function assistantResponseFrameForkMessageId(item: AssistantResponseFrameItem): string | null {
  return item.items.flatMap(timelineRenderItemBlocks).at(-1)?.sourceEventIds.at(-1) ?? null
}

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
  root: 'group mb-0.5 overflow-hidden rounded-[var(--radius-md)] border border-[var(--tl-border-soft)] bg-[var(--tl-surface)]',
  header: 'flex cursor-pointer list-none items-center justify-between gap-[9px] border-b border-transparent bg-[var(--tl-surface-soft)] px-3 py-1.5 [&::-webkit-details-marker]:hidden group-open:border-[var(--tl-border-soft)]',
  heading: 'flex min-w-0 flex-1 items-center gap-2',
  icon: 'inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--tl-surface)] text-[var(--text-xs)] font-black leading-none text-[var(--tl-muted)]',
  title: 'flex min-w-0 flex-1 flex-nowrap items-center gap-[5px] overflow-hidden',
  name: 'min-w-0 truncate text-xs font-medium leading-[1.2] text-[var(--tl-ink)]',
  summary: 'min-w-0 max-w-[min(46vw,520px)] flex-[1_1_0] truncate text-[var(--text-xs)] font-normal leading-[1.2] text-[var(--tl-muted)]',
  summaryDot: 'mr-[7px] text-[var(--tl-muted)]',
  expand: 'inline-grid h-6 w-6 shrink-0 place-items-center rounded-full leading-none text-[var(--tl-muted)]',
  chevron: 'h-[13px] w-[13px] overflow-visible fill-none stroke-current stroke-[1.8] transition-transform duration-[140ms] [stroke-linecap:round] [stroke-linejoin:round] group-open:rotate-90',
  body: 'grid gap-0 bg-[var(--tl-surface-soft)]',
}

function TimelineDisclosureCard({ ariaLabel, icon, title, summary, badges, bodyClassName, renderBody, deferBody = false }: {
  ariaLabel: string
  icon: ReactNode
  title: ReactNode
  summary?: ReactNode
  badges?: ReactNode
  bodyClassName?: string
  renderBody: () => ReactNode
  deferBody?: boolean
}) {
  const [hasOpened, setHasOpened] = useState(!deferBody)
  return (
    <details className={disclosureCardClass.root} aria-label={ariaLabel} onToggle={deferBody ? (event) => { if (event.currentTarget.open) setHasOpened(true) } : undefined}>
      <summary className={disclosureCardClass.header}>
        <div className={disclosureCardClass.heading}>
          <span className={disclosureCardClass.icon} aria-hidden="true">{icon}</span>
          <div className={disclosureCardClass.title}>
            <strong className={disclosureCardClass.name}>{title}</strong>
            {summary ? <span className={disclosureCardClass.summary}><span aria-hidden="true" className={disclosureCardClass.summaryDot}>·</span>{summary}</span> : null}
            {badges}
          </div>
        </div>
        <span className={disclosureCardClass.expand} aria-hidden="true">
          <svg viewBox="0 0 12 12" className={disclosureCardClass.chevron} focusable="false"><path d="M4 2.5 8 6 4 9.5" /></svg>
        </span>
      </summary>
      {hasOpened ? <div className={[disclosureCardClass.body, bodyClassName].filter(Boolean).join(' ')}>{renderBody()}</div> : null}
    </details>
  )
}

const toolTimelineClass = {
  state: 'shrink-0 rounded-full bg-[var(--tl-surface-soft)] px-1.5 py-px text-[var(--text-xs)] font-extrabold uppercase tracking-[0.04em] text-[var(--tl-muted)]',
  stateError: 'bg-[var(--tl-danger-soft)] text-[var(--tl-danger)]',
  section: 'grid gap-2 px-3.5 py-3 [&+&]:pt-0',
  sectionLabel: 'text-[var(--text-xs)] font-extrabold uppercase tracking-[0.08em] text-[var(--tl-muted)]',
  inputCode: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[var(--radius-md)] border border-[var(--tl-border-soft)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 font-mono text-[var(--text-sm)] leading-[1.6] text-[var(--tl-ink)]',
  resultCode: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[var(--text-sm)] leading-[1.6] text-[var(--tl-ink)]',
  outputText: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit] text-[var(--text-sm)] leading-[1.6] text-[var(--tl-ink)]',
  result: 'rounded-[var(--radius-md)] border border-[var(--tl-border-soft)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 text-[var(--text-sm)] leading-[1.6] text-[var(--tl-ink)]',
  resultError: 'border-[rgb(166_83_75_/_20%)] bg-[var(--tl-danger-soft)] text-[var(--tl-danger)]',
  pending: 'text-[var(--text-xs)] italic text-[var(--color-muted)]',
}

const thinkingTimelineClass = {
  body: 'px-3.5 py-3 text-[15px] leading-[1.65] text-[var(--tl-ink)]',
  code: 'm-0 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[var(--radius-md)] border border-[var(--tl-border-soft)] bg-[var(--tl-code-bg)] px-[11px] py-2.5 font-mono text-[var(--text-sm)] leading-[1.6] text-[var(--tl-ink)]',
}

const timelineMessageClass = {
  rowUser: 'group flex min-w-0 items-end justify-end gap-[9px]',
  userStack: 'grid max-w-[min(76%,720px)] justify-items-end gap-1 max-[720px]:max-w-full max-[560px]:max-w-[min(86%,720px)]',
  userBubble: 'max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[var(--radius-md)] border border-[var(--tl-user-border)] bg-[var(--tl-user-soft)] px-3.5 py-2.5 text-[15px] leading-[1.6] text-[var(--tl-ink)] shadow-[var(--tl-shadow-soft)]',
  timestamp: 'inline-flex items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[13px] leading-[1.6] text-[var(--tl-muted)] opacity-0 transition-opacity duration-150 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.4]',
  timestampUser: 'pr-1 text-right group-hover:opacity-100 focus-within:opacity-100',
  timestampAssistant: 'block group-hover:opacity-100 focus-within:opacity-100',
  assistantFrame: 'group w-full max-w-none justify-self-stretch [&_.timeline-assistant-text]:px-1 [&_.timeline-assistant-text]:py-0.5 [&_.timeline-block]:shadow-none',
  assistantFrameBody: 'grid min-w-0 gap-2.5 [&>.timeline-tool-call:last-child]:mb-2',
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

function isPrimaryInputBlock(block: TimelineBlock): boolean {
  return block.kind.startsWith('user.') && isRecord(block.data) && block.data.primaryTimelineUserMessage === true
}

function isUserMessageBlock(block: TimelineBlock): boolean {
  return ['user.message', 'user.image', 'user.file'].includes(block.kind)
}

function shouldFrameTimelineItem(item: TimelineRenderItem): boolean {
  return item.type === 'tool-call' || !isPrimaryInputBlock(item.block)
}

const hiddenTaskTools = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

function isHiddenTaskTool(item: TimelineRenderItem): boolean {
  return item.type === 'tool-call' && hiddenTaskTools.has(toolDataString(item.toolUse, 'name') ?? '')
}

export function groupAssistantResponseFrames(items: TimelineRenderItem[]): TimelineDisplayItem[] {
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
    if (isHiddenTaskTool(item)) continue
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

export function groupTimelineBlocks(blocks: TimelineBlock[]): TimelineRenderItem[] {
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
    <TimelineDisclosureCard
      ariaLabel={`Tool call ${toolName}`}
      icon={toolIcon(toolName)}
      title={toolName}
      summary={summary}
      badges={<>{!toolUse ? <span className={[toolTimelineClass.state, toolTimelineClass.stateError].join(' ')}>Unmatched</span> : null}{results.length === 0 ? <span className={toolTimelineClass.state}>Pending</span> : null}{hasError ? <span className={[toolTimelineClass.state, toolTimelineClass.stateError].join(' ')}>Error</span> : null}</>}
      renderBody={() => <>
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
      </>}
    />
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
    <TimelineDisclosureCard
      ariaLabel="Assistant thinking"
      icon="✦"
      title="Thinking"
      summary={summary}
      bodyClassName={thinkingTimelineClass.body}
      renderBody={() => typeof value === 'string' ? <MarkdownValue value={value} /> : <pre className={thinkingTimelineClass.code}>{dataPreview(value)}</pre>}
    />
  )
}

function tagText(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))
  return match?.[1]?.trim() || null
}

function taskNotificationData(raw: Record<string, unknown>): Record<string, unknown> {
  const content = isRecord(raw.message) && typeof raw.message.content === 'string' ? raw.message.content.trim() : ''
  const body = content.match(/^<task-notification(?:\s[^>]*)?>([\s\S]*)<\/task-notification>$/)?.[1] ?? ''
  return {
    text: content,
    taskId: tagText(body, 'task-id'),
    toolUseId: tagText(body, 'tool-use-id'),
    outputFile: tagText(body, 'output-file'),
    status: tagText(body, 'status'),
    summary: tagText(body, 'summary'),
    result: tagText(body, 'result'),
    raw: raw.message,
  }
}

function taskNotificationField(block: TimelineBlock, key: string): string | null {
  if (!isRecord(block.data)) return null
  const value = block.data[key]
  return typeof value === 'string' && value ? value : null
}

function taskNotificationOriginalToolUse(block: TimelineBlock): Record<string, unknown> | null {
  if (!isRecord(block.data) || !isRecord(block.data.originalToolUse)) return null
  return block.data.originalToolUse
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

function UserMessageCardView({ block }: { block: TimelineBlock }) {
  return (
    <TimelineDisclosureCard
      ariaLabel="User message"
      icon="U"
      title="User message"
      deferBody
      renderBody={() => (
        <section className={toolTimelineClass.section}>
          <div className={toolTimelineClass.sectionLabel}>Payload</div>
          <pre className={toolTimelineClass.outputText}>{dataPreview(block.data)}</pre>
        </section>
      )}
    />
  )
}

function TaskNotificationBlockView({ block }: { block: TimelineBlock }) {
  const summary = taskNotificationField(block, 'summary')
  const status = taskNotificationField(block, 'status')
  const result = taskNotificationField(block, 'result')
  const text = taskNotificationField(block, 'text')
  const originalToolUse = taskNotificationOriginalToolUse(block)
  const originalToolName = typeof originalToolUse?.name === 'string' ? originalToolUse.name : null
  const originalToolInput = originalToolUse?.input

  return (
    <TimelineDisclosureCard
      ariaLabel="Task notification"
      icon="↯"
      title={originalToolName && status ? `${originalToolName} ${status}` : originalToolName ? originalToolName : 'Task Notification'}
      summary={summary}
      badges={status ? <span className={toolTimelineClass.state}>{status}</span> : null}
      renderBody={() => <>
        {originalToolUse ? (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Input</div>
            <pre className={toolTimelineClass.inputCode}>{dataPreview(originalToolInput)}</pre>
          </section>
        ) : null}
        {result ? (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Result</div>
            <article className={toolTimelineClass.result}>
              <ToolResultValue value={result} />
            </article>
          </section>
        ) : (
          <section className={toolTimelineClass.section}>
            <div className={toolTimelineClass.sectionLabel}>Raw notification</div>
            <pre className={toolTimelineClass.outputText}>{text ?? dataPreview(block.data)}</pre>
          </section>
        )}
      </>}
    />
  )
}

export function TimelineBlockView({ block, timestamp, source, onViewRaw }: { block: TimelineBlock; timestamp?: number; source?: 'history' | 'live'; onViewRaw?: (blocks: TimelineBlock[]) => void }) {
  const text = textFromData(block.data)

  if (block.kind === 'assistant.thinking') return <ThinkingBlockView block={block} />
  if (block.kind === 'assistant.user_message') return <UserMessageCardView block={block} />
  if (block.kind === 'assistant.task_notification') return <TaskNotificationBlockView block={block} />
  if (block.kind === 'user.image' || block.kind === 'user.file') return <AttachmentBlockView block={block} />

  if (block.kind === 'assistant.text' || block.kind === 'assistant.message') {
    return <div className="timeline-assistant-text"><MarkdownValue value={text ?? dataPreview(block.data)} /></div>
  }

  if (block.kind === 'user.message' && isPrimaryInputBlock(block)) {
    return (
      <div className={timelineMessageClass.rowUser}>
        <div className={timelineMessageClass.userStack}>
          <div className={timelineMessageClass.userBubble}>{text ?? dataPreview(block.data)}</div>
          <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampUser} copyText={text ?? dataPreview(block.data)} copyLabel="Copy user message" onViewRaw={onViewRaw ? () => onViewRaw([block]) : undefined} viewRawLabel="View raw user message" source={source} />
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

const TimelineRenderItemView = memo(function TimelineRenderItemView({ item, timestamp, source, onViewRaw }: { item: TimelineRenderItem; timestamp?: number; source?: 'history' | 'live'; onViewRaw?: (blocks: TimelineBlock[]) => void }) {
  if (item.type === 'block') return <TimelineBlockView block={item.block} timestamp={timestamp} source={source} onViewRaw={onViewRaw} />
  return <div className="timeline-tool-call"><ToolCallBlockView toolUse={item.toolUse} results={item.results} /></div>
})

type ToastNotification = { message: string; tone: 'success' | 'error' }

function FooterStatus({ state }: { state: TurnFooterState }) {
  if (!state) return null
  if (state.kind === 'cooking' || state.kind === 'waiting') return <CliCookingIndicator label={state.label} />
  return <span className="text-[13px] leading-[1.6]" role="status" aria-live="polite" aria-label="Turn duration"><span aria-hidden="true">✻ </span>{state.label}</span>
}

export function AssistantResponseFrameSkeleton({ activeLabel, footerState }: { activeLabel?: string; footerState?: TurnFooterState }) {
  const state = footerState ?? { kind: 'cooking' as const, label: activeLabel }
  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response" aria-busy="true">
        <div className={timelineMessageClass.assistantFrameBody}>
          <div className="timeline-skeleton-line timeline-skeleton-line-mid" />
          <div className="timeline-skeleton-line" />
          <div className="timeline-skeleton-line timeline-skeleton-line-short" />
        </div>
      </section>
      <div className="flex items-center px-1 text-[var(--tl-muted)]">
        <FooterStatus state={state} />
      </div>
    </div>
  )
}

const AssistantResponseFrameView = memo(function AssistantResponseFrameView({ item, timestamp, footerState, source, onViewRaw, onForkSession, onNotify }: { item: AssistantResponseFrameItem; timestamp?: number; footerState?: TurnFooterState; source?: 'history' | 'live'; onViewRaw?: (blocks: TimelineBlock[]) => void; onForkSession?: (upToMessageId: string) => Promise<unknown>; onNotify?: (toast: ToastNotification) => void }) {
  const copyText = assistantResponseText(item.items)
  const forkMessageId = assistantResponseFrameForkMessageId(item)
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)

  async function handleFork() {
    if (!forkMessageId || !onForkSession || forking) return
    setForking(true)
    setForkError(null)
    try {
      await onForkSession(forkMessageId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setForkError(message)
    } finally {
      setForking(false)
    }
  }

  const forkAction = source === 'history' && footerState?.kind === 'duration' && forkMessageId && onForkSession ? (
    <button className="timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)] disabled:cursor-default disabled:opacity-50" style={{ borderRadius: 5 }} type="button" aria-label="Fork session from this response" data-tooltip="Fork" onClick={handleFork} disabled={forking}>
      {forking ? <span className="turn-spinner session-age-spinner" aria-hidden="true" /> : <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.9 10h5.4c1.1 0 1.6-.2 2.3-.9l6.2-6.2" /><path d="M10.8 2.8h5v5" /><path d="m10.8 12.9 5 5" /><path d="M10.8 17.2h5v-5" /></svg>}
    </button>
  ) : null

  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response">
        <div className={timelineMessageClass.assistantFrameBody}>
          {item.items.map((child) => <TimelineRenderItemView item={child} key={timelineRenderItemKey(child)} />)}
        </div>
      </section>
      <div className="flex items-center px-1 text-[var(--tl-muted)]">
        {footerState ? <><FooterStatus state={footerState} /><span className="mx-2 h-3 w-px bg-[var(--tl-border-soft)] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" /></> : null}
        <TimelineTimestamp value={timestamp} className={timelineMessageClass.timestampAssistant} copyText={copyText} copyLabel="Copy assistant response" onViewRaw={onViewRaw ? () => onViewRaw(item.items.flatMap(timelineRenderItemBlocks)) : undefined} viewRawLabel="View raw assistant response" extraActions={forkAction} source={source} />
      </div>
      {forkError ? <div className="panel error">Failed to fork session: {forkError}</div> : null}
    </div>
  )
})

export type TimelineTurnIndex = { primaryUserUuids: Set<string>; messageIds: Set<string>; finalizedApiMessageIds: Set<string> }
type ProjectedTimelineTurn = TurnSummary & { blocks: TimelineBlock[] }

type LiveAssistantBlockDraft = {
  id: string
  kind: string
  data: Record<string, unknown>
  sourceEventIds: string[]
  partialJson?: string
}

type LiveAssistantMessageDraft = {
  ordinal: number
  apiMessageId?: string
  assistantMessageUuid?: string
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
    if (eventType === 'message_start') {
      const apiMessageId = isRecord(event.message) && typeof event.message.id === 'string' ? event.message.id : undefined
      const existing = apiMessageId ? this.byApiMessageId.get(apiMessageId) : undefined
      this.current = existing && !existing.finalized ? existing : this.createDraft(apiMessageId, !apiMessageId || Boolean(existing?.finalized))
      return []
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0
      const contentBlock = isRecord(event.content_block) ? event.content_block : { type: 'unknown_block' }
      const blockType = typeof contentBlock.type === 'string' ? contentBlock.type : 'unknown_block'
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId) return []
      const block = this.ensureBlock(draft, index, blockType, contentBlock)
      addUnique(block.sourceEventIds, sourceEventId)
      block.data = { ...contentBlock, streaming: true }
      return this.snapshot(block, draft.apiMessageId)
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = isRecord(event.delta) ? event.delta : { type: 'unknown_delta' }
      const deltaType = typeof delta.type === 'string' ? delta.type : 'unknown_delta'
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId) return []
      const block = this.ensureBlock(draft, index, blockTypeForDelta(deltaType), { type: blockTypeForDelta(deltaType) })
      addUnique(block.sourceEventIds, sourceEventId)
      this.applyDelta(block, deltaType, delta)
      block.data.streaming = true
      return this.snapshot(block, draft.apiMessageId)
    }

    if (eventType === 'content_block_stop') {
      const draft = this.ensureCurrent()
      const index = typeof event.index === 'number' ? event.index : 0
      const block = draft.blocks.get(index)
      if (!block) return []
      if (sourceEventId) addUnique(block.sourceEventIds, sourceEventId)
      delete block.data.streaming
      this.parsePartialJson(block)
      return this.snapshot(block, draft.apiMessageId)
    }

    if (eventType === 'message_stop') {
      const draft = this.current
      this.current = null
      if (!draft) return []
      return [...draft.blocks.values()].flatMap((block) => {
        delete block.data.streaming
        return this.snapshot(block, draft.apiMessageId)
      })
    }
    return []
  }

  finalAssistantBlocks(message: Record<string, unknown>): TimelineBlock[] {
    const uuid = sdkMessageUuid(message)
    const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
    if (!uuid || !apiMessageId) return []
    const draft = this.findDraft(apiMessageId, uuid)
    draft.assistantMessageUuid = uuid
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

  private findDraft(apiMessageId: string, assistantMessageUuid: string): LiveAssistantMessageDraft {
    return this.drafts.find((draft) => draft.assistantMessageUuid === assistantMessageUuid)
      ?? this.drafts.find((draft) => draft.apiMessageId === apiMessageId && !draft.finalized && !draft.invalid)
      ?? this.createDraft(apiMessageId)
  }

  private ensureBlock(draft: LiveAssistantMessageDraft, index: number, blockType: string, data: Record<string, unknown>): LiveAssistantBlockDraft {
    const existing = draft.blocks.get(index)
    if (existing) return existing
    const block = { id: `${this.userMessageUuid}:assistant:${draft.ordinal}:${index}`, kind: `assistant.${blockType}`, data: { ...data }, sourceEventIds: [] }
    draft.blocks.set(index, block)
    return block
  }

  private applyDelta(block: LiveAssistantBlockDraft, deltaType: string, delta: Record<string, unknown>): void {
    if (deltaType === 'text_delta' && typeof delta.text === 'string') block.data.text = `${typeof block.data.text === 'string' ? block.data.text : ''}${delta.text}`
    else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') block.data.thinking = `${typeof block.data.thinking === 'string' ? block.data.thinking : ''}${delta.thinking}`
    else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.partialJson = `${block.partialJson ?? ''}${delta.partial_json}`
      block.data.partial_json = block.partialJson
      this.parsePartialJson(block)
    } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string') block.data.signature = `${typeof block.data.signature === 'string' ? block.data.signature : ''}${delta.signature}`
    else if (deltaType === 'citations_delta' && delta.citation !== undefined) block.data.citations = [...(Array.isArray(block.data.citations) ? block.data.citations : []), delta.citation]
    else if (deltaType === 'compaction_delta') {
      if (typeof delta.content === 'string') block.data.content = `${typeof block.data.content === 'string' ? block.data.content : ''}${delta.content}`
      if (delta.encrypted_content !== undefined) block.data.encrypted_content = delta.encrypted_content
      block.data.stream_deltas = [...(Array.isArray(block.data.stream_deltas) ? block.data.stream_deltas : []), delta]
    } else block.data.stream_deltas = [...(Array.isArray(block.data.stream_deltas) ? block.data.stream_deltas : []), delta]
  }

  private parsePartialJson(block: LiveAssistantBlockDraft): void {
    if (!block.partialJson) return
    try {
      block.data.input = JSON.parse(block.partialJson)
    } catch {
      // Partial tool input is expected to be invalid JSON until its final delta.
    }
  }

  private snapshot(block: LiveAssistantBlockDraft, apiMessageId?: string): TimelineBlock[] {
    return [{
      id: block.id,
      kind: block.kind,
      sourceEventIds: block.sourceEventIds,
      ...(apiMessageId ? { apiMessageId } : {}),
      ...(block.kind === 'assistant.tool_use' && typeof block.data.id === 'string' ? { contentBlockId: block.data.id, toolUseId: block.data.id } : {}),
      data: { ...block.data },
    }]
  }
}

function blockTypeForDelta(deltaType: string): string {
  if (deltaType === 'text_delta' || deltaType === 'citations_delta') return 'text'
  if (deltaType === 'thinking_delta' || deltaType === 'signature_delta') return 'thinking'
  if (deltaType === 'input_json_delta') return 'tool_use'
  if (deltaType === 'compaction_delta') return 'compaction'
  return 'unknown_block'
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

function toolUseMetadata(message: Record<string, unknown>, block: unknown): Pick<TimelineBlock, 'contentBlockId' | 'toolUseId'> {
  if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') return { contentBlockId: block.id, toolUseId: block.id }
  const toolUseId = timelineToolUseId(message, block)
  return toolUseId ? { toolUseId } : {}
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
      ...toolUseMetadata(message, block),
      data: block,
    }
  })
}

function primaryInputData(primary: boolean, data: unknown): unknown {
  if (!primary) return data
  return isRecord(data) ? { ...data, primaryTimelineUserMessage: true } : data
}

function userBlocksFromMessage(message: Record<string, unknown>, uuid: string, primary = false): TimelineBlock[] {
  const content = sdkMessageContent(message)
  if (Array.isArray(content)) {
    return content.flatMap((block, index): TimelineBlock[] => {
      if (!isRecord(block)) return []
      if (block.type === 'tool_result') return [{ id: `${uuid}:tool_result:${index}`, kind: 'tool.result', sourceEventIds: [uuid], ...toolUseMetadata(message, block), data: block }]
      if (block.type === 'text' && typeof block.text === 'string') return [{ id: `${uuid}:user:${index}`, kind: 'user.message', sourceEventIds: [uuid], data: primaryInputData(primary, { text: block.text, status: 'confirmed', raw: block }) }]
      if (block.type === 'image') return [{ id: `${uuid}:image:${index}`, kind: 'user.image', sourceEventIds: [uuid], data: primaryInputData(primary, block) }]
      if (block.type === 'file' || block.type === 'document') return [{ id: `${uuid}:file:${index}`, kind: 'user.file', sourceEventIds: [uuid], data: primaryInputData(primary, block) }]
      return []
    })
  }
  const text = textFromData({ content })
  return text ? [{ id: `${uuid}:user`, kind: 'user.message', sourceEventIds: [uuid], data: primaryInputData(primary, { text, status: 'confirmed', raw: isRecord(message.message) ? message.message : null }) }] : []
}

export const isPrimaryUserMessage = isPrimaryTimelineUserMessage

function isTerminalLiveEvent(value: unknown): boolean {
  return isRecord(value) && (value.type === 'result' || value.type === 'cotta_live_turn_failed')
}

function resultFailureMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (value.type === 'cotta_live_turn_failed') return typeof value.error === 'string' ? value.error : 'Turn failed'
  if (value.type !== 'result') return null
  const failed = value.is_error === true || (typeof value.subtype === 'string' && (value.subtype === 'failed' || value.subtype.startsWith('error')))
  if (!failed) return null
  return Array.isArray(value.errors) && typeof value.errors[0] === 'string' ? value.errors[0] : 'Turn failed'
}

function messageIdentity(message: unknown): string | null {
  if (!isRecord(message)) return null
  if (message.type === 'stream_event' && isRecord(message.event)) {
    const event = message.event
    const apiMessageId = event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string'
      ? event.message.id
      : undefined
    const index = typeof event.index === 'number' ? event.index : ''
    return `stream:${apiMessageId ?? ''}:${String(event.type)}:${index}:${JSON.stringify(event)}`
  }
  const uuid = sdkMessageUuid(message)
  return uuid ? `uuid:${uuid}` : null
}

function finalizedApiMessageId(message: unknown): string | null {
  return isRecord(message) && message.type === 'assistant' && isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : null
}

export function timelineTurnIndex(turns: TurnSummary[]): TimelineTurnIndex {
  const primaryUserUuids = new Set<string>()
  const messageIds = new Set<string>()
  const finalizedApiMessageIds = new Set<string>()
  for (const turn of turns) {
    primaryUserUuids.add(turn.primaryUserUuid)
    for (const message of turn.messages) {
      const id = messageIdentity(message)
      const apiMessageId = finalizedApiMessageId(message)
      if (id) messageIds.add(id)
      if (apiMessageId) finalizedApiMessageIds.add(apiMessageId)
    }
  }
  return { primaryUserUuids, messageIds, finalizedApiMessageIds }
}

function messageIsRepresentedBy(message: unknown, index: TimelineTurnIndex): boolean {
  const id = messageIdentity(message)
  if (id && index.messageIds.has(id)) return true
  if (!isRecord(message) || message.type !== 'stream_event' || !isRecord(message.event)) return false
  const apiMessageId = message.event.type === 'message_start' && isRecord(message.event.message) && typeof message.event.message.id === 'string'
    ? message.event.message.id
    : null
  return Boolean(apiMessageId && index.finalizedApiMessageIds.has(apiMessageId))
}

function turnIsRepresentedBy(turn: TurnSummary, index: TimelineTurnIndex): boolean {
  return index.primaryUserUuids.has(turn.primaryUserUuid)
}

function turnOrderValue(turn: TurnSummary): number | null {
  return turn.primaryUserTimestampMs ?? null
}

export function projectTimelineTurn(turn: TurnSummary): TimelineBlock[] {
  const blocks: TimelineBlock[] = []
  let accumulator: LiveAssistantStreamAccumulator | null = null
  for (const message of turn.messages) {
    if (!isRecord(message) || typeof message.type !== 'string') continue
    if (message.type === 'stream_event') {
      accumulator ??= new LiveAssistantStreamAccumulator(turn.primaryUserUuid)
      for (const block of accumulator.processStreamEvent(message)) {
        const index = blocks.findIndex((item) => item.id === block.id)
        if (index < 0) blocks.push(block)
        else blocks[index] = block
      }
      continue
    }
    if (message.type === 'assistant') {
      const uuid = sdkMessageUuid(message)
      const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
      const replacesStreamPreview = accumulator !== null && Boolean(uuid && apiMessageId)
      const finalized = accumulator !== null && uuid && apiMessageId
        ? accumulator.finalAssistantBlocks(message)
        : uuid && apiMessageId ? assistantBlocksFromMessage(message, uuid, apiMessageId) : [rawMessageBlock(message)]
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if ((replacesStreamPreview && apiMessageId && block?.apiMessageId === apiMessageId) || (uuid && block?.sourceEventIds.includes(uuid))) blocks.splice(index, 1)
      }
      blocks.push(...finalized)
      continue
    }
    if (message.type === 'user') {
      const uuid = sdkMessageUuid(message)
      if (!uuid || message.isSynthetic === true) continue
      if (isTimelineTaskNotificationMessage(message)) {
        const data = taskNotificationData(message)
        const toolUseId = timelineTaskNotificationToolUseId(message)
        if (toolUseId) {
          const original = blocks.find((block) => block.kind === 'assistant.tool_use' && block.toolUseId === toolUseId)
          if (original && isRecord(original.data)) data.originalToolUse = { id: toolUseId, name: original.data.name, input: original.data.input }
        }
        blocks.push({ id: `${uuid}:task_notification`, kind: 'assistant.task_notification', sourceEventIds: [uuid], data })
      } else if (isPrimaryTimelineUserMessage(message)) blocks.push(...userBlocksFromMessage(message, uuid, true))
      else {
        const userBlocks = userBlocksFromMessage(message, uuid)
        blocks.push(...(userBlocks.some((block) => block.kind === 'tool.result') ? userBlocks.filter((block) => block.kind === 'tool.result') : [userMessageCardBlock(message, uuid)]))
      }
      continue
    }
    if (message.type !== 'result' && message.type !== 'system' && message.type !== 'command_lifecycle' && message.type !== 'cotta_live_turn_failed') blocks.push(rawMessageBlock(message))
  }
  return blocks
}

export const CLI_COOKING_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging',
] as const
const TURN_DONE_VERBS = ['Thought', 'Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'] as const

function stableVerb<T extends readonly string[]>(turnId: string, verbs: T): T[number] {
  let hash = 0
  for (const char of turnId) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return verbs[Math.abs(hash) % verbs.length]!
}

function stableTurnVerb(turnId: string): string {
  return stableVerb(turnId, TURN_DONE_VERBS)
}

export function cliCookingLabel(turnId: string): string {
  return `${stableVerb(turnId, CLI_COOKING_VERBS)}…`
}

function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s` : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}

export function turnPendingAgentLabel(turn: Pick<TurnSummary, 'pendingBackgroundAgentCount'>): string | null {
  const pending = turn.pendingBackgroundAgentCount ?? 0
  return pending > 0 ? `Waiting for ${pending} background ${pending === 1 ? 'agent' : 'agents'} to finish` : null
}

export function turnDurationLabel(turn: Pick<TurnSummary, 'primaryUserUuid' | 'durationMs' | 'pendingBackgroundAgentCount'>): string | null {
  return turnPendingAgentLabel(turn) ?? (turn.durationMs === undefined ? null : `${stableTurnVerb(turn.primaryUserUuid)} for ${formatTurnDuration(turn.durationMs)}`)
}

export type TurnFooterState = { kind: 'waiting' | 'duration'; label: string } | { kind: 'cooking'; label?: string } | null

export function turnFooterState(input: { turn: Pick<TurnSummary, 'primaryUserUuid' | 'durationMs' | 'pendingBackgroundAgentCount'>; cooking: boolean; activeLabel?: string }): TurnFooterState {
  const pendingLabel = turnPendingAgentLabel(input.turn)
  if (pendingLabel) return { kind: 'waiting', label: pendingLabel }
  if (input.cooking) return { kind: 'cooking', label: input.activeLabel }
  const durationLabel = turnDurationLabel(input.turn)
  return durationLabel ? { kind: 'duration', label: durationLabel } : null
}

export function cliCookingTurnId(turns: TurnSummary[], cliActive = false): string | null {
  if (!cliActive) return null
  const turn = turns.at(-1)
  return turn && turn.durationMs === undefined && projectTimelineTurn(turn).some(isPrimaryInputBlock) ? turn.primaryUserUuid : null
}

export function activeTimelineTurnId(turns: TurnSummary[], runState?: SessionRunState | null): string | null {
  if (!runState || runState.phase === 'idle') return null
  return turns.some((turn) => turn.primaryUserUuid === runState.activeUserMessageUuid) ? runState.activeUserMessageUuid : null
}

export function shouldShowAssistantResponseSkeleton(input: { turn: TurnSummary; cooking: boolean; lastAssistantFrameId?: string; runState?: SessionRunState | null; fallbackTurnId?: string | null }): boolean {
  if (input.lastAssistantFrameId) return false
  if (input.cooking) return true
  if (input.turn.durationMs !== undefined) return false
  return (input.runState?.phase === 'idle'
    && input.runState.lastTurn?.id === input.turn.primaryUserUuid
    && input.runState.lastTurn.outcome === 'success')
    || input.fallbackTurnId === input.turn.primaryUserUuid
}

function CliCookingIndicator({ label = 'Cooking…' }: { label?: string }) {
  const paceClass = useRef(Math.random() < 0.5 ? 'cli-cooking-medium' : 'cli-cooking-slow').current
  return <span className={`cli-cooking ${paceClass} text-[13px] leading-[1.6]`} role="status" aria-live="polite"><span className="cli-cooking-mark" aria-hidden="true" /> {label}</span>
}

function upsertBlock(blocks: TimelineBlock[], block: TimelineBlock): TimelineBlock[] {
  const index = blocks.findIndex((item) => item.id === block.id)
  if (index === -1) return [...blocks, block]
  const next = [...blocks]
  next[index] = block
  return next
}

type ApplySdkMessageResult = { turns: TurnSummary[]; currentUserMessageUuid: string | null; terminal: boolean }

function rawMessageBlock(message: Record<string, unknown>): TimelineBlock {
  const uuid = sdkMessageUuid(message) ?? String(message.type)
  return { id: `${uuid}:raw`, kind: `raw.${String(message.type)}`, sourceEventIds: sdkMessageUuid(message) ? [uuid] : [], data: message }
}

function userMessageCardBlock(message: Record<string, unknown>, uuid: string): TimelineBlock {
  return { id: `${uuid}:user_message`, kind: 'assistant.user_message', sourceEventIds: [uuid], data: message }
}

function toolUseOwnerTurnId(turns: TurnSummary[], toolUseId: string): string | null {
  return turns.find((turn) => projectTimelineTurn(turn).some((block) => block.kind === 'assistant.tool_use' && block.toolUseId === toolUseId))?.primaryUserUuid ?? null
}

function appendMessageToTurn(turns: TurnSummary[], turnId: string | null, message: unknown): TurnSummary[] {
  if (!turnId) return turns
  return turns.map((turn) => turn.primaryUserUuid === turnId && !messageIsRepresentedBy(message, timelineTurnIndex([turn]))
    ? { ...turn, messages: [...turn.messages, message] }
    : turn)
}

function messageOwnerTurnId(turns: TurnSummary[], activeTurnId: string | null, message: Record<string, unknown>): string | null {
  const linkedToolUseId = timelineTaskNotificationToolUseId(message) ?? messageToolUseIds(message, 'tool_result').find((id) => toolUseOwnerTurnId(turns, id))
  return linkedToolUseId ? toolUseOwnerTurnId(turns, linkedToolUseId) ?? activeTurnId : activeTurnId
}

export function applySdkMessage(
  turns: TurnSummary[],
  raw: unknown,
  historyIndex: TimelineTurnIndex,
  currentUserMessageUuid: string | null,
  _accumulator: LiveAssistantStreamAccumulator | null,
  occurredAt = Date.now(),
  _sessionId = 'pending',
): ApplySdkMessageResult {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { turns, currentUserMessageUuid, terminal: false }
  if (isTerminalLiveEvent(raw) && raw.type !== 'result') return { turns, currentUserMessageUuid, terminal: true }
  if (raw.type === 'user' && raw.isSynthetic === true) return { turns, currentUserMessageUuid, terminal: false }

  if (raw.type === 'user' && isPrimaryTimelineUserMessage(raw) && !isTimelineTaskNotificationMessage(raw)) {
    const uuid = sdkMessageUuid(raw)
    if (!uuid) return { turns, currentUserMessageUuid, terminal: false }
    const existing = turns.find((turn) => turn.primaryUserUuid === uuid)
    if (existing) {
      const next = messageIsRepresentedBy(raw, historyIndex)
        ? turns
        : turns.map((turn) => turn.primaryUserUuid === uuid
          ? { ...turn, primaryUserTimestampMs: rawMessageTimestampMs(raw) ?? turn.primaryUserTimestampMs, messages: [raw, ...turn.messages.filter((message) => messageIdentity(message) !== `uuid:${uuid}`)] }
          : turn)
      return { turns: next, currentUserMessageUuid: uuid, terminal: false }
    }
    const turn: TurnSummary = { primaryUserUuid: uuid, primaryUserTimestampMs: rawMessageTimestampMs(raw) ?? occurredAt, messages: [raw] }
    return { turns: turnIsRepresentedBy(turn, historyIndex) ? turns : [...turns, turn], currentUserMessageUuid: uuid, terminal: false }
  }

  if (!currentUserMessageUuid) return { turns, currentUserMessageUuid, terminal: isTerminalLiveEvent(raw) }
  if (messageIsRepresentedBy(raw, historyIndex)) return { turns, currentUserMessageUuid, terminal: isTerminalLiveEvent(raw) }
  const owner = messageOwnerTurnId(turns, currentUserMessageUuid, raw)
  return { turns: appendMessageToTurn(turns, owner, raw), currentUserMessageUuid, terminal: isTerminalLiveEvent(raw) }
}

function persistedLiveEventPayload(event: PersistedLiveEvent): unknown {
  return isRecord(event.payload) && event.payload.type !== 'result' && !sdkMessageUuid(event.payload)
    ? { ...event.payload, uuid: `live-event:${event.id}`, session_id: event.sessionId }
    : event.payload
}

function messageToolUseIds(raw: unknown, blockType: 'tool_use' | 'tool_result'): string[] {
  if (!isRecord(raw)) return []
  const content = sdkMessageContent(raw)
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => isRecord(block) && block.type === blockType
    ? blockType === 'tool_use' && typeof block.id === 'string'
      ? block.id
      : timelineToolUseId(raw, block) ?? []
    : [])
}

export function liveEventsForTurn(events: PersistedLiveEvent[], turnId: string): PersistedLiveEvent[] {
  let activeTurnId: string | null = null
  const turnsByToolUseId = new Map<string, string>()
  const matching: PersistedLiveEvent[] = []
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const raw = persistedLiveEventPayload(event)
    if (isRecord(raw)) {
      if (isPrimaryTimelineUserMessage(raw)) activeTurnId = sdkMessageUuid(raw) ?? activeTurnId
      if (!activeTurnId) continue
      const notificationToolUseId = timelineTaskNotificationToolUseId(raw)
      const resultOwners = messageToolUseIds(raw, 'tool_result').map((toolUseId) => turnsByToolUseId.get(toolUseId) ?? activeTurnId)
      const notificationOwner = notificationToolUseId ? turnsByToolUseId.get(notificationToolUseId) ?? activeTurnId : null
      const targetTurnIds = new Set(resultOwners.length > 0 ? resultOwners : [notificationOwner ?? activeTurnId])
      if (targetTurnIds.has(turnId)) matching.push(event)
      if (activeTurnId) {
        for (const toolUseId of messageToolUseIds(raw, 'tool_use')) turnsByToolUseId.set(toolUseId, activeTurnId)
      }
    } else if (activeTurnId === turnId) matching.push(event)
  }
  return matching
}

export function reconcileTimelineTurns(current: TurnSummary[], incoming: TurnSummary[]): TurnSummary[] {
  const watermark = incoming.at(-1)
  if (!watermark) return current

  const incomingIndex = timelineTurnIndex(incoming)
  const mergedIncoming = incoming.map((turn) => {
    if (turn.primaryUserUuid !== watermark.primaryUserUuid) return turn
    const liveTurn = current.find((item) => item.primaryUserUuid === turn.primaryUserUuid)
    if (!liveTurn) return turn
    const liveMessages = liveTurn.messages.filter((message) => !messageIsRepresentedBy(message, incomingIndex))
    return liveMessages.length > 0 ? { ...turn, messages: [...turn.messages, ...liveMessages] } : turn
  })
  const unreconciled = current.filter((turn) => !turnIsRepresentedBy(turn, incomingIndex))
  const firstIncomingOrder = turnOrderValue(incoming[0]!)
  const watermarkOrder = turnOrderValue(watermark)
  if (firstIncomingOrder === null || watermarkOrder === null) return [...mergedIncoming, ...unreconciled]
  const older: TurnSummary[] = []
  const newerOrUnknown: TurnSummary[] = []
  for (const turn of unreconciled) {
    const order = turnOrderValue(turn)
    if (order !== null && order < firstIncomingOrder) older.push(turn)
    else if (order === null || order >= watermarkOrder) newerOrUnknown.push(turn)
  }
  return [...older, ...mergedIncoming, ...newerOrUnknown]
}

function prependOlderTimelineTurns(current: TurnSummary[], older: TurnSummary[]): TurnSummary[] {
  const currentIndex = timelineTurnIndex(current)
  return [...older.filter((turn) => !turnIsRepresentedBy(turn, currentIndex)), ...current]
}

export function shouldRefetchTimelineVersion(input: { appliedVersion: string | null; observedVersion: string | null; live: boolean; fetching: boolean }): boolean {
  return Boolean(input.appliedVersion && input.observedVersion && input.appliedVersion !== input.observedVersion && !input.live && !input.fetching)
}

export type SessionTimelineScope = { projectId: string | null; sessionId: string | null; pendingPrimaryTurnUuid: string | null }

export function belongsToTimelineSession(sessionId: string | null, candidateSessionId: string): boolean {
  return sessionId !== null && candidateSessionId === sessionId
}

export function shouldResetSessionTimeline(previous: SessionTimelineScope | null, next: SessionTimelineScope): boolean {
  return !previous || previous.projectId !== next.projectId || previous.sessionId !== next.sessionId
}

function rawStringField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === 'string' ? value[field] : '—'
}

function beijingTimestamp(value: unknown): { date: string; time: string } {
  if (typeof value !== 'string') return { date: '—', time: '' }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: value, time: '' }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
}

function rawMessageContentRows(value: unknown): unknown[] {
  if (!isRecord(value) || !isRecord(value.message)) return [undefined]
  return Array.isArray(value.message.content) ? value.message.content : [value.message.content]
}

function contentBlockType(value: unknown): string {
  return isRecord(value) && typeof value.type === 'string' ? value.type : '—'
}

function contentWithoutType(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { type: _type, ...content } = value
  return content
}

export type RawMessageWaterfallRow = {
  messageIndex: number
  blockType: string
  offsetMs: number
  durationMs: number
}

export function rawMessageTimestampMs(message: unknown): number | null {
  const value = isRecord(message) ? message.timestamp : undefined
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function rawMessageBlockTypeLabel(message: unknown): string {
  const types = rawMessageContentRows(message).map(contentBlockType)
  const unique = [...new Set(types)]
  if (unique.length === 0) return '—'
  if (unique.length <= 2) return unique.join(' + ')
  return `${types.length} blocks`
}

export function rawMessageWaterfallRows(messages: unknown[]): RawMessageWaterfallRow[] {
  const timed = messages
    .map((message, messageIndex) => ({ message, messageIndex, timestampMs: rawMessageTimestampMs(message) }))
    .filter((item): item is { message: unknown; messageIndex: number; timestampMs: number } => item.timestampMs !== null)
  const startMs = timed[0]?.timestampMs
  if (startMs === undefined) return []

  return timed.map((item, index) => ({
    messageIndex: item.messageIndex,
    blockType: rawMessageBlockTypeLabel(item.message),
    offsetMs: item.timestampMs - startMs,
    durationMs: Math.max(0, (timed[index + 1]?.timestampMs ?? item.timestampMs) - item.timestampMs),
  }))
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

function RawMessagesWaterfall({ messages }: { messages: unknown[] }) {
  const rows = rawMessageWaterfallRows(messages)
  if (rows.length === 0) return null
  const unavailable = messages.length - rows.length
  const maxEndMs = Math.max(1, ...rows.map((row) => row.offsetMs + row.durationMs))

  return (
    <section className="raw-message-waterfall" aria-labelledby="raw-message-waterfall-title">
      <div className="raw-message-waterfall-header">
        <h3 id="raw-message-waterfall-title">Timing waterfall</h3>
        {unavailable > 0 ? <span>{unavailable} without timestamp</span> : null}
      </div>
      <div className="raw-message-waterfall-rows">
        {rows.map((row, index) => {
          const left = `${Math.min(99, (row.offsetMs / maxEndMs) * 100)}%`
          const width = row.durationMs === 0 ? '2px' : `${(row.durationMs / maxEndMs) * 100}%`
          return (
            <div className="raw-message-waterfall-row" key={`${row.messageIndex}:${row.offsetMs}`}>
              <div className="raw-message-waterfall-meta">
                <span>{index + 1}/{rows.length}</span>
                <strong>{row.blockType}</strong>
                <span>+{formatDuration(row.offsetMs)}</span>
                <span>{formatDuration(row.durationMs)}</span>
              </div>
              <div className="raw-message-waterfall-track" aria-hidden="true">
                <div className="raw-message-waterfall-bar" style={{ marginLeft: left, width }} />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function LiveEventsTable({ events, loading, error }: {
  events: PersistedLiveEvent[]
  loading: boolean
  error: unknown
}) {
  return (
    <section className="debug-table-section raw-live-events" aria-label="Captured live events">
      <h4>Captured live events</h4>
      {loading ? <p className="debug-empty">Loading captured live events…</p> : error ? (
        <p className="panel error">Failed to load captured live events: {error instanceof Error ? error.message : String(error)}</p>
      ) : events.length === 0 ? <p className="debug-empty">No captured live events for this turn.</p> : (
        <div className="debug-table-wrap">
          <table className="debug-table">
            <thead><tr><th>ID</th><th>Recorded</th><th>Event</th><th>Preview</th><th>Payload</th></tr></thead>
            <tbody>{events.map((event) => (
              <tr key={event.id}>
                <td className="debug-mono">{event.id}</td>
                <td className="debug-mono debug-timestamp-cell">{new Date(event.recordedAtMs).toISOString()}</td>
                <td className="debug-type-cell"><strong>{event.eventType}</strong></td>
                <td className="debug-content-cell">{shortText(dataPreview(event.payload), 220)}</td>
                <td className="debug-content-cell raw-message-json"><pre>{JSON.stringify(event.payload, null, 2) ?? ''}</pre></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function RawMessagesDialog({ messages, loading, error, liveEvents, liveEventsLoading, liveEventsError, onClose }: {
  messages: unknown[]
  loading: boolean
  error: unknown
  liveEvents: PersistedLiveEvent[]
  liveEventsLoading: boolean
  liveEventsError: unknown
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  return (
    <dialog className="raw-messages-dialog" ref={dialogRef} aria-labelledby="raw-messages-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="raw-messages-header">
        <div>
          <h2 id="raw-messages-title">Raw messages</h2>
          <div className="raw-messages-session">Session: <span className="debug-mono">{messages.length > 0 ? rawStringField(messages[0], 'session_id') : '—'}</span></div>
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {loading ? <p className="panel muted">Loading raw messages…</p> : error ? (
        <p className="panel error">Failed to load raw messages: {error instanceof Error ? error.message : String(error)}</p>
      ) : messages.length === 0 ? <p className="panel muted">No matching raw messages are persisted yet.</p> : (
        <>
          <RawMessagesWaterfall messages={messages} />
          <div className="debug-table-wrap">
          <table className="debug-table raw-messages-table">
            <thead><tr><th>Timestamp</th><th>UUID</th><th>Type</th><th>Stop reason</th><th>Block type</th><th>Content</th></tr></thead>
            <tbody>{messages.flatMap((message, messageIndex) => {
              const contentRows = rawMessageContentRows(message)
              const timestamp = beijingTimestamp(isRecord(message) ? message.timestamp : undefined)
              const type = rawStringField(message, 'type')
              return contentRows.map((content, contentIndex) => (
                <tr className={type === 'assistant' ? 'raw-message-assistant' : type === 'user' ? 'raw-message-user' : undefined} key={`${rawStringField(message, 'uuid')}:${messageIndex}:${contentIndex}`}>
                  {contentIndex === 0 ? <td className="debug-mono debug-timestamp-cell" rowSpan={contentRows.length}><div>{timestamp.date}</div><div className="debug-muted">{timestamp.time}</div></td> : null}
                  {contentIndex === 0 ? <td className="debug-mono" rowSpan={contentRows.length}>{rawStringField(message, 'uuid')}</td> : null}
                  {contentIndex === 0 ? <td className="debug-type-cell" rowSpan={contentRows.length}>{type}</td> : null}
                  {contentIndex === 0 ? <td rowSpan={contentRows.length}>{isRecord(message) && isRecord(message.message) ? rawStringField(message.message, 'stop_reason') : '—'}</td> : null}
                  <td>{contentBlockType(content)}</td>
                  <td className="debug-content-cell raw-message-json"><pre>{JSON.stringify(contentWithoutType(content), null, 2) ?? ''}</pre></td>
                </tr>
              ))
            })}</tbody>
          </table>
          </div>
        </>
      )}
      <LiveEventsTable events={liveEvents} loading={liveEventsLoading} error={liveEventsError} />
    </dialog>
  )
}

function useSessionTimelineData(
  projectId: string | null,
  sessionId: string | null,
  historyEnabled: boolean,
  pendingTurn?: TurnSummary | null,
  onLiveTurnChange?: (sessionId: string, userMessageUuid: string | null) => void,
  onPendingTurnReconciled?: (sessionId: string, userMessageUuid: string) => void,
  onTasksChange?: (tasks: SessionTask[]) => void,
  onSessionListStale?: () => void,
  onSessionInfoChange?: (info: SessionInfoResponse) => void,
  onSessionMetaChange?: (meta: SessionTimelineResponse['sessionMeta']) => void,
  isTimelineAtBottom?: () => boolean,
) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [liveConnectionError, setLiveConnectionError] = useState<string | null>(null)
  const [liveActive, setLiveActive] = useState(false)
  const shouldScrollToBottomRef = useRef(false)
  const lastAppliedTimelineVersionRef = useRef<string | null>(null)
  const historyIndexRef = useRef<TimelineTurnIndex>(timelineTurnIndex([]))
  const turnsRef = useRef<TurnSummary[]>([])
  const liveUserMessageUuidRef = useRef<string | null>(null)
  const liveAccumulatorRef = useRef<LiveAssistantStreamAccumulator | null>(null)
  const loadOlderRequestRef = useRef(0)
  const onLiveTurnChangeRef = useRef(onLiveTurnChange)
  const onPendingTurnReconciledRef = useRef(onPendingTurnReconciled)
  const onSessionListStaleRef = useRef(onSessionListStale)
  const onSessionInfoChangeRef = useRef(onSessionInfoChange)
  const onSessionMetaChangeRef = useRef(onSessionMetaChange)
  const isTimelineAtBottomRef = useRef(isTimelineAtBottom)
  const refetchTimelineRef = useRef<() => unknown>(() => undefined)
  const refetchSessionInfoRef = useRef<() => unknown>(() => undefined)
  const previousScopeRef = useRef<SessionTimelineScope | null>(null)
  const pendingPrimaryTurnUuid = pendingTurn?.primaryUserUuid ?? null
  const liveEnabled = Boolean(projectId && sessionId)
  const historyQueryEnabled = liveEnabled && historyEnabled

  const timeline = useQuery({
    queryKey: ['session-timeline', projectId, sessionId],
    queryFn: () => fetchSessionTimeline(projectId!, sessionId!),
    enabled: historyQueryEnabled,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const refetchTimeline = timeline.refetch
  const sessionInfo = useQuery({
    queryKey: ['session-info', projectId, sessionId],
    queryFn: () => fetchSessionInfo(projectId!, sessionId!),
    enabled: historyQueryEnabled,
    retry: false,
    refetchInterval: liveActive ? false : 8000,
    refetchIntervalInBackground: false,
  })
  useEffect(() => {
    onLiveTurnChangeRef.current = onLiveTurnChange
    onPendingTurnReconciledRef.current = onPendingTurnReconciled
    onSessionListStaleRef.current = onSessionListStale
    onSessionInfoChangeRef.current = onSessionInfoChange
    onSessionMetaChangeRef.current = onSessionMetaChange
    isTimelineAtBottomRef.current = isTimelineAtBottom
    refetchTimelineRef.current = refetchTimeline
    refetchSessionInfoRef.current = sessionInfo.refetch
  })

  useLayoutEffect(() => {
    const nextScope = { projectId, sessionId, pendingPrimaryTurnUuid }
    const reset = shouldResetSessionTimeline(previousScopeRef.current, nextScope)
    previousScopeRef.current = nextScope
    if (!reset) return
    loadOlderRequestRef.current += 1
    turnsRef.current = []
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
    setLiveActive(false)
  }, [pendingPrimaryTurnUuid, projectId, sessionId])

  useEffect(() => {
    if (!pendingTurn) return
    if (liveUserMessageUuidRef.current !== pendingTurn.primaryUserUuid) {
      shouldScrollToBottomRef.current = true
      liveUserMessageUuidRef.current = pendingTurn.primaryUserUuid
      liveAccumulatorRef.current = new LiveAssistantStreamAccumulator(pendingTurn.primaryUserUuid)
      setLiveActive(true)
      if (sessionId) onLiveTurnChangeRef.current?.(sessionId, pendingTurn.primaryUserUuid)
    }
    setTurns((current) => {
      const next = current.some((turn) => turn.primaryUserUuid === pendingTurn.primaryUserUuid)
        ? current
        : [...current.filter((turn) => !turn.primaryUserUuid.startsWith('pending:')), pendingTurn]
      turnsRef.current = next
      return next
    })
  }, [pendingTurn, sessionId])

  useEffect(() => {
    if (!timeline.data) return
    const nextVersion = timeline.data.state.version
    shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current?.() ?? true
    historyIndexRef.current = timelineTurnIndex(timeline.data.turns)
    setTurns((current) => {
      const next = reconcileTimelineTurns(current, timeline.data.turns)
      turnsRef.current = next
      return next
    })
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    onSessionMetaChangeRef.current?.(timeline.data.sessionMeta)
    onTasksChange?.(timeline.data.tasks)
    if (sessionId && pendingPrimaryTurnUuid && timeline.data.turns.some((turn) => turn.primaryUserUuid === pendingPrimaryTurnUuid)) {
      onPendingTurnReconciledRef.current?.(sessionId, pendingPrimaryTurnUuid)
    }
    setOlderError(null)
    lastAppliedTimelineVersionRef.current = nextVersion
  }, [pendingPrimaryTurnUuid, sessionId, timeline.data])

  useEffect(() => {
    if (!sessionInfo.data) return
    onSessionInfoChangeRef.current?.(sessionInfo.data)
    if (shouldRefetchTimelineVersion({ appliedVersion: lastAppliedTimelineVersionRef.current, observedVersion: sessionInfo.data.version, live: liveActive, fetching: timeline.isFetching })) void refetchTimeline()
  }, [liveActive, refetchTimeline, sessionInfo.data, sessionInfo.dataUpdatedAt, timeline.isFetching])

  useEffect(() => {
    if (!projectId || !sessionId) return
    let active = true
    const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`)
    events.onmessage = (message) => {
      if (!active) return
      let raw: unknown
      try {
        raw = JSON.parse(message.data)
      } catch (error) {
        console.error('timeline:sse invalid event', error)
        setLiveConnectionError('Live connection sent an invalid event; waiting for history…')
        setLiveActive(false)
        void refetchTimelineRef.current()
        return
      }
      if (isRecord(raw) && typeof raw.session_id === 'string' && !belongsToTimelineSession(sessionId, raw.session_id)) return
      const failure = resultFailureMessage(raw)
      setLiveConnectionError(failure ? `Turn failed: ${failure}` : null)
      if (isRecord(raw) && raw.type === 'user' && isPrimaryUserMessage(raw)) {
        const userMessageUuid = sdkMessageUuid(raw)
        if (userMessageUuid && userMessageUuid !== liveUserMessageUuidRef.current) {
          liveUserMessageUuidRef.current = userMessageUuid
          liveAccumulatorRef.current = new LiveAssistantStreamAccumulator(userMessageUuid)
          setLiveActive(true)
          onLiveTurnChangeRef.current?.(sessionId, userMessageUuid)
        }
      }
      const result = applySdkMessage(turnsRef.current, raw, historyIndexRef.current, liveUserMessageUuidRef.current, liveAccumulatorRef.current, Date.now(), sessionId)
      const terminal = result.terminal
      liveUserMessageUuidRef.current = result.currentUserMessageUuid
      turnsRef.current = result.turns
      setTurns(result.turns)
      if (terminal) {
        liveUserMessageUuidRef.current = null
        liveAccumulatorRef.current = null
        setLiveActive(false)
        onLiveTurnChangeRef.current?.(sessionId, null)
        onSessionListStaleRef.current?.()
        if (historyEnabled) {
          void refetchTimelineRef.current()
          void refetchSessionInfoRef.current()
        }
      }
      shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current?.() ?? true
    }
    events.onopen = () => { if (active) setLiveConnectionError(null) }
    events.onerror = () => {
      if (!active) return
      setLiveConnectionError('Live connection interrupted; waiting for history…')
      setLiveActive(false)
      void refetchTimelineRef.current()
    }
    return () => {
      active = false
      events.close()
    }
  }, [projectId, sessionId])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!historyEnabled || !projectId || !sessionId || !nextCursor || loadingOlder) return false
    const requestId = loadOlderRequestRef.current + 1
    loadOlderRequestRef.current = requestId
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await fetchSessionTimeline(projectId, sessionId, nextCursor)
      if (loadOlderRequestRef.current !== requestId) return false
      setTurns((current) => {
        const next = prependOlderTimelineTurns(current, page.turns)
        turnsRef.current = next
        return next
      })
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
  }, [historyEnabled, loadingOlder, nextCursor, projectId, sessionId])

  return {
    turns,
    hasMore,
    olderError,
    loadingOlder,
    liveConnectionError,
    liveTurnId: liveActive ? liveUserMessageUuidRef.current : null,
    timeline,
    loadOlder,
    shouldScrollToBottomRef,
  }
}

function SessionTimelineSkeleton() {
  return (
    <section className="session-workspace-view" aria-label="Loading session timeline" aria-busy="true">
      <section className="timeline-panel timeline-skeleton-panel">
        {[0, 1, 2].map((item) => (
          <div className="timeline-skeleton-turn" key={item}>
            <div className="timeline-skeleton-line timeline-skeleton-line-short" />
            <div className="timeline-skeleton-line" />
            <div className="timeline-skeleton-line timeline-skeleton-line-mid" />
          </div>
        ))}
      </section>
    </section>
  )
}

export function SessionAwaySummary({ value }: { value: string }) {
  return <p className="session-away-summary" aria-label="Away recap">※ <strong>Recap:</strong> <ReactMarkdown components={{ p: ({ children }) => <>{children}</> }}>{value}</ReactMarkdown></p>
}

export function SessionTaskList({ tasks }: { tasks: SessionTask[] }) {
  if (tasks.length === 0) return null
  const statusLabel = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' }
  return (
    <section className="session-task-list" aria-label="Session tasks">
      <ul>
        {tasks.map((task) => <li className={`session-task-row session-task-row-${task.status}`} key={task.key}>
          <span className={`session-task-status session-task-status-${task.status}`} role="img" aria-label={statusLabel[task.status]}>{task.status === 'completed' ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.2 2.1 2.1 4.9-5" /></svg> : null}</span>
          <span className="session-task-state">{statusLabel[task.status]}</span>
          <span className="session-task-number">#{task.taskId}</span>
          <span className="session-task-subject">{task.subject}</span>
          {task.blockedBy.length > 0 ? <span className="session-task-blocked">› blocked by {task.blockedBy.map((taskId) => `#${taskId}`).join(', ')}</span> : null}
        </li>)}
      </ul>
    </section>
  )
}

export function SessionTimeline({ projectId, projectName, sessionId, historyEnabled = true, pendingTurn, runState, sessionStatus = 'idle', sessionEntrypoint = null, tasks = [], onLiveTurnChange, onPendingTurnReconciled, onTasksChange, onSessionListStale, onSessionInfoChange, onSessionMetaChange, onForkSession, onNotify }: {
  projectId: string
  projectName?: string | null
  sessionId: string | null
  historyEnabled?: boolean
  pendingTurn?: TurnSummary | null
  runState?: SessionRunState | null
  sessionStatus?: SessionStatus
  sessionEntrypoint?: string | null
  tasks?: SessionTask[]
  onLiveTurnChange?: (sessionId: string, userMessageUuid: string | null) => void
  onPendingTurnReconciled?: (sessionId: string, userMessageUuid: string) => void
  onTasksChange?: (tasks: SessionTask[]) => void
  onSessionListStale?: () => void
  onSessionInfoChange?: (info: SessionInfoResponse) => void
  onSessionMetaChange?: (meta: SessionTimelineResponse['sessionMeta']) => void
  onForkSession?: (upToMessageId: string) => Promise<unknown>
  onNotify?: (toast: ToastNotification) => void
}) {
  const timelinePanelRef = useRef<HTMLElement | null>(null)
  const olderScrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const loadingOlderFromScrollRef = useRef(false)
  const previousScopeRef = useRef<SessionTimelineScope | null>(null)
  const pendingPrimaryTurnUuid = pendingTurn?.primaryUserUuid ?? null
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [rawMessageSelection, setRawMessageSelection] = useState<{ turnId: string } | null>(null)
  const responseSkeletonTurnIdRef = useRef<string | null>(null)
  const rawMessages = useQuery({
    queryKey: ['session-raw-messages', projectId, sessionId, rawMessageSelection?.turnId],
    queryFn: () => fetchSessionRawMessages(projectId, sessionId!, rawMessageSelection!.turnId),
    enabled: Boolean(sessionId && rawMessageSelection),
    retry: false,
  })
  const liveEvents = useQuery({
    queryKey: ['session-live-events', projectId, sessionId],
    queryFn: () => fetchSessionLiveEvents(projectId, sessionId!),
    enabled: Boolean(sessionId && rawMessageSelection),
    retry: false,
  })
  const matchingRawMessages = rawMessages.data?.messages ?? []
  const isTimelineAtBottom = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return true
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24
  }, [])
  const { turns, hasMore, olderError, loadingOlder, liveConnectionError, liveTurnId, timeline, loadOlder, shouldScrollToBottomRef } = useSessionTimelineData(projectId, sessionId, historyEnabled, pendingTurn, onLiveTurnChange, onPendingTurnReconciled, onTasksChange, onSessionListStale, onSessionInfoChange, onSessionMetaChange, isTimelineAtBottom)
  const visibleTurns: ProjectedTimelineTurn[] = turns.map((turn) => ({ ...turn, blocks: projectTimelineTurn(turn) }))
  const matchingLiveEvents = rawMessageSelection && liveEvents.data
    ? liveEventsForTurn(liveEvents.data.events, rawMessageSelection.turnId)
    : []
  const openRawMessages = useCallback((turnId: string) => setRawMessageSelection({ turnId }), [])
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
    const nextScope = { projectId, sessionId, pendingPrimaryTurnUuid }
    const reset = shouldResetSessionTimeline(previousScopeRef.current, nextScope)
    previousScopeRef.current = nextScope
    if (!reset) return
    olderScrollAnchorRef.current = null
    loadingOlderFromScrollRef.current = false
    responseSkeletonTurnIdRef.current = null
    shouldScrollToBottomRef.current = true
    setShowScrollToBottom(false)
    setRawMessageSelection(null)
  }, [pendingPrimaryTurnUuid, projectId, sessionId, shouldScrollToBottomRef])

  const cookingTurnId = cliCookingTurnId(visibleTurns, sessionEntrypoint === 'cli' && (sessionStatus === 'busy' || sessionStatus === 'waiting'))
  const activeTurnId = activeTimelineTurnId(visibleTurns, runState)
  if (cookingTurnId || activeTurnId) responseSkeletonTurnIdRef.current = cookingTurnId ?? activeTurnId
  const responseSkeletonScrollKey = visibleTurns.flatMap((turn) => {
    const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(turn.blocks))
    const lastAssistantFrameId = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')?.id
    const cooking = turn.primaryUserUuid === cookingTurnId || turn.primaryUserUuid === activeTurnId
    return shouldShowAssistantResponseSkeleton({ turn, cooking, lastAssistantFrameId, runState, fallbackTurnId: responseSkeletonTurnIdRef.current }) ? [turn.primaryUserUuid] : []
  }).join('|')

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

  useLayoutEffect(() => {
    if (!responseSkeletonScrollKey || showScrollToBottom) return
    const panel = timelinePanelRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [responseSkeletonScrollKey, showScrollToBottom])

  if (timeline.isLoading && visibleTurns.length === 0) return <SessionTimelineSkeleton />
  if (timeline.isError && visibleTurns.length === 0) return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>

  const activeTask = tasks.find((task) => task.status === 'in_progress')
  const activeTaskLabel = activeTask ? `${activeTask.activeForm ?? activeTask.subject}...` : undefined

  return (
    <section className="session-workspace-view" aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline" ref={timelinePanelRef} onScroll={handleTimelineScroll}>
        {hasMore ? <div className="section-heading"><button className="load-older" type="button" onClick={loadOlderKeepingAnchor} disabled={loadingOlder} aria-label={loadingOlder ? 'Loading older turns' : undefined}>{loadingOlder ? <span className="loading-dots" aria-hidden="true"><span /><span /><span /></span> : 'Load older'}</button></div> : null}
        {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
        {liveConnectionError ? <div className="panel muted">{liveConnectionError}</div> : null}
        {visibleTurns.length === 0 && !olderError && !liveConnectionError ? <div className="timeline-empty-state">{projectName ? `What should we work on in ${projectName}?` : 'What should we build?'}</div> : null}
        {visibleTurns.map((turn) => {
          const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(turn.blocks))
          const lastAssistantFrameId = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')?.id
          const source = turn.primaryUserUuid === liveTurnId ? 'live' : 'history'
          const cooking = turn.primaryUserUuid === cookingTurnId || turn.primaryUserUuid === activeTurnId
          const activeLabel = turn.primaryUserUuid === activeTurnId && activeTaskLabel ? activeTaskLabel : turn.primaryUserUuid === cookingTurnId ? cliCookingLabel(turn.primaryUserUuid) : undefined
          const footerState = turnFooterState({ turn, cooking, activeLabel })
          const showResponseSkeleton = shouldShowAssistantResponseSkeleton({ turn, cooking, lastAssistantFrameId, runState, fallbackTurnId: responseSkeletonTurnIdRef.current })
          if (responseSkeletonTurnIdRef.current === turn.primaryUserUuid && (lastAssistantFrameId || turn.durationMs !== undefined)) responseSkeletonTurnIdRef.current = null
          return (
            <article className="turn-card" key={turn.primaryUserUuid}>
              <div className="timeline-blocks">{displayItems.map((item) => item.type === 'assistant-response-frame'
                ? <AssistantResponseFrameView item={item} timestamp={item.id === lastAssistantFrameId && turn.durationMs !== undefined ? turn.durationTimestampMs : undefined} footerState={item.id === lastAssistantFrameId ? footerState : null} source={source} onViewRaw={() => openRawMessages(turn.primaryUserUuid)} onForkSession={runState?.phase === 'idle' ? onForkSession : undefined} onNotify={onNotify} key={item.id} />
                : <TimelineRenderItemView item={item.item} timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.primaryUserTimestampMs : undefined} source={source} onViewRaw={() => openRawMessages(turn.primaryUserUuid)} key={timelineRenderItemKey(item.item)} />,
              )}</div>
              {showResponseSkeleton ? <AssistantResponseFrameSkeleton activeLabel={activeLabel} footerState={footerState} /> : null}
              {turn.awaySummary?.trim() ? <SessionAwaySummary value={turn.awaySummary} /> : null}
            </article>
          )
        })}
      </section>
      {showScrollToBottom ? <button className="timeline-scroll-bottom" type="button" onClick={scrollToTimelineBottom} aria-label="Scroll to latest message"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v12m0 0 5-5m-5 5-5-5" /></svg></button> : null}
      {rawMessageSelection ? <RawMessagesDialog messages={matchingRawMessages} loading={rawMessages.isLoading} error={rawMessages.error} liveEvents={matchingLiveEvents} liveEventsLoading={liveEvents.isFetching} liveEventsError={liveEvents.error} onClose={() => setRawMessageSelection(null)} /> : null}
    </section>
  )
}
