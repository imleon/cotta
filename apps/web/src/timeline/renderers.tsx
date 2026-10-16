import {
  type AskUserQuestionDecisionRequest,
  normalizeMarkdownUri,
  type SessionRawTranscriptLine,
  type TimelineBlock,
  type ToolApprovalRequest,
  type TurnSubagentNode,
  type TurnSubagentTranscriptResponse,
} from '@cotta/shared'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { formatAge } from '../format-age'
import {
  blockTitle,
  ContentBlockValue,
  type ContentImage,
  DeferredDetails,
  FileToolResultValue,
  type LocalImageContext,
  safeDataPreview,
  TimelineCodeContent,
  TimelineContentStack,
  TimelineMarkdownContent,
  TimelineTextContent,
  TimelineTimestamp,
  timelineMessageClass,
} from './content'
import {
  type AssistantResponseFrameItem,
  activityGroupSummary,
  assistantResponseFrameForkMessageId,
  assistantResponseText,
  canForkAssistantResponse,
  type FileMutationResult,
  groupAssistantResponseFrames,
  groupTimelineBlocks,
  isPrimaryInputBlock,
  isRecord,
  primaryInputText,
  projectTimelineTurn,
  type ResponseSource,
  type TimelineActivityGroupRenderItem,
  type TimelineRenderItem,
  type TimelineSource,
  type TurnFooterState,
  type TurnPhase,
  textFromData,
  thinkingBlockTitle,
  thinkingValue,
  timelineRenderItemBlocks,
  timelineRenderItemKey,
  toolResultIsError,
  zonedTimestamp,
} from './core'
import { readResultContentImage, ToolCallBlockView, toolCallLabels } from './tools'

function ThinkingBlockView({ block }: { block: TimelineBlock }) {
  const value = thinkingValue(block)
  const streaming = isRecord(block.data) && block.data.streaming === true
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])
  const title = thinkingBlockTitle(block, nowMs)
  return (
    <DeferredDetails
      className="timeline-thinking timeline-file-result-details"
      ariaLabel="Assistant thinking"
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong>
            </span>
          </span>
        </summary>
      }
      renderBody={() => (
        <TimelineContentStack>{typeof value === 'string' ? <TimelineMarkdownContent value={value} /> : <TimelineCodeContent value={safeDataPreview(value)} defaultWrapped />}</TimelineContentStack>
      )}
    />
  )
}

export function activityGroupHasToolUseId(item: TimelineActivityGroupRenderItem, toolUseId?: string | null): boolean {
  return Boolean(toolUseId && item.items.some((child) => child.type === 'tool-call' && child.toolUseId === toolUseId))
}

type QuestionResponseProps = {
  pendingQuestion?: ToolApprovalRequest | null
  answeringQuestionId?: string | null
  onAnswerQuestion?: (requestId: string, decision: AskUserQuestionDecisionRequest) => void
}

export function contentImagesFromTurnBlocks(blocks: readonly TimelineBlock[]): ReadonlyMap<string, ContentImage> {
  const readPaths = new Map<string, string>()
  for (const block of blocks) {
    if (block.kind !== 'assistant.tool_use' || !block.toolUseId || !isRecord(block.data) || block.data.name !== 'Read' || !isRecord(block.data.input)) continue
    if (typeof block.data.input.file_path === 'string') readPaths.set(block.toolUseId, normalizeMarkdownUri(block.data.input.file_path))
  }

  const images = new Map<string, ContentImage>()
  for (const block of blocks) {
    if (block.kind !== 'tool.result' || !block.toolUseId || !isRecord(block.data) || toolResultIsError(block)) continue
    const path = readPaths.get(block.toolUseId)
    const image = readResultContentImage(block.data)
    if (path && image) images.set(path, image)
  }
  return images
}

function ActivityGroupView({
  item,
  timeZone,
  source,
  contentImages,
  localImageContext,
  pendingApprovalToolUseId,
  pendingQuestion,
  answeringQuestionId,
  onAnswerQuestion,
  highlightedMessage,
}: {
  item: TimelineActivityGroupRenderItem
  timeZone: string
  source?: TimelineSource
  contentImages?: ReadonlyMap<string, ContentImage>
  localImageContext?: Omit<LocalImageContext, 'messageUuid'>
  pendingApprovalToolUseId?: string | null
  highlightedMessage?: { uuid: string; blockIndex: number } | null
} & QuestionResponseProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!item.active || !item.hasThinking) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [item.active, item.hasThinking])
  const summary = activityGroupSummary(item, nowMs)
  const pendingPermission = activityGroupHasToolUseId(item, pendingApprovalToolUseId)
  return (
    <DeferredDetails
      className="timeline-activity-group timeline-file-result-details"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={summary}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{summary}</strong>
              {item.active ? '...' : null}
            </span>
            {toolCallLabels(false, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => (
        <div className="mt-2 grid gap-2.5 pl-4">
          {item.items.map((child) => (
            <TimelineRenderItemView
              item={child}
              timeZone={timeZone}
              source={source}
              contentImages={contentImages}
              localImageContext={localImageContext}
              pendingApprovalToolUseId={pendingApprovalToolUseId}
              pendingQuestion={pendingQuestion}
              answeringQuestionId={answeringQuestionId}
              onAnswerQuestion={onAnswerQuestion}
              highlightedMessage={highlightedMessage}
              key={timelineRenderItemKey(child)}
            />
          ))}
        </div>
      )}
    />
  )
}

function taskNotificationField(block: TimelineBlock, key: string): string | null {
  if (!isRecord(block.data)) return null
  const value = block.data[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function AttachmentBlockView({ block }: { block: TimelineBlock }) {
  return <ContentBlockValue value={block.data} />
}

export function PrimaryInputView({
  blocks,
  timestamp,
  timeZone,
  cwd,
  sessionId,
  sessionLabel,
  entrypoint,
  source,
  showSource = true,
  onViewRaw,
  onViewSubagents,
  subagentCount = 0,
  highlightedMessage,
}: {
  blocks: TimelineBlock[]
  timestamp?: number
  timeZone: string
  cwd?: string
  sessionId?: string
  sessionLabel?: string
  entrypoint?: string
  source?: TimelineSource
  showSource?: boolean
  onViewRaw?: (blocks: TimelineBlock[]) => void
  onViewSubagents?: () => void
  subagentCount?: number
  highlightedMessage?: { uuid: string; blockIndex: number } | null
}) {
  const copyText = primaryInputText(blocks)
  return (
    <div className={timelineMessageClass.rowUser}>
      <div className={timelineMessageClass.userStack}>
        <div className={timelineMessageClass.userBubble}>
          {blocks.map((block) => {
            const messageUuid = block.sourceEventIds[0] ?? null
            const blockIndex = isRecord(block.data) && typeof block.data.originalContentBlockIndex === 'number' ? block.data.originalContentBlockIndex : 0
            const highlighted = messageUuid === highlightedMessage?.uuid && blockIndex === highlightedMessage.blockIndex
            return (
              <div
                className={highlighted ? 'timeline-user-message-highlighted' : undefined}
                data-message-uuid={messageUuid ?? undefined}
                data-content-block-index={messageUuid ? blockIndex : undefined}
                key={block.id}
              >
                {block.kind === 'user.message' ? (textFromData(block.data) ?? safeDataPreview(block.data)) : <ContentBlockValue value={block.data} />}
              </div>
            )
          })}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-y-1 pr-1 text-right [&>span+span]:before:mx-2 [&>span+span]:before:inline-block [&>span+span]:before:h-2 [&>span+span]:before:w-px [&>span+span]:before:bg-[color-mix(in_srgb,var(--tl-muted)_28%,transparent)] [&>span+span]:before:content-['']">
          <TimelineTimestamp
            value={timestamp}
            timeZone={timeZone}
            className={timelineMessageClass.timestampUser}
            cwd={cwd}
            sessionId={sessionId}
            sessionLabel={sessionLabel}
            entrypoint={entrypoint}
            copyText={copyText}
            copyLabel={blocks.every((block) => block.kind === 'user.message') ? 'Copy user message' : 'Copy user message text'}
            onViewRaw={onViewRaw ? () => onViewRaw(blocks) : undefined}
            viewRawLabel="View raw user message"
            onViewSubagents={onViewSubagents}
            subagentCount={subagentCount}
            source={showSource ? source : undefined}
          />
        </div>
      </div>
    </div>
  )
}

function PeerMessageCardView({ block }: { block: TimelineBlock }) {
  if (!isRecord(block.data) || typeof block.data.name !== 'string' || typeof block.data.body !== 'string') return null
  const { name, body } = block.data
  const senderTaskId = typeof block.data.senderTaskId === 'string' && block.data.senderTaskId.trim() ? ` · ${block.data.senderTaskId.trim()}` : ''
  const title = `PeerMessage (From @${name}${senderTaskId})`
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Peer message"
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">PeerMessage</strong> (From @{name}
              {senderTaskId})
            </span>
          </span>
        </summary>
      }
      renderBody={() => (
        <TimelineContentStack>
          <TimelineMarkdownContent value={body} />
        </TimelineContentStack>
      )}
    />
  )
}

function taskNotificationFallback(status: string | null, summary: string | null, note: string | null, taskIds: string[]): string {
  return [status && `Status: ${status}`, summary && `Summary: ${summary}`, note && `Note: ${note}`, taskIds.length > 0 && `Task IDs: ${taskIds.join(', ')}`].filter(Boolean).join('\n')
}

export function TaskNotificationContent({
  invalid = false,
  result,
  status = null,
  summary = null,
  note = null,
  taskIds = [],
}: {
  invalid?: boolean
  result?: unknown
  status?: string | null
  summary?: string | null
  note?: string | null
  taskIds?: string[]
}) {
  const text = typeof result === 'string' && result.trim() ? result.trim() : null
  const fallback = taskNotificationFallback(status, summary, note, taskIds)
  return (
    <TimelineContentStack>
      {invalid ? (
        <TimelineTextContent value="Unsupported TaskNotification result" tone="error" />
      ) : text ? (
        <TimelineMarkdownContent value={text} />
      ) : (
        <TimelineTextContent value={fallback} tone="muted" />
      )}
    </TimelineContentStack>
  )
}

function TaskNotificationBlockView({ block }: { block: TimelineBlock }) {
  const summary = taskNotificationField(block, 'summary')
  const status = taskNotificationField(block, 'status')
  const note = taskNotificationField(block, 'note')
  const result = isRecord(block.data) ? block.data.result : undefined
  const invalid = isRecord(block.data) && block.data.invalid === true
  const taskIds = isRecord(block.data) && Array.isArray(block.data.taskIds) ? block.data.taskIds.filter((id): id is string => typeof id === 'string') : []
  const detail = [status, summary].filter(Boolean).join(' · ')
  const title = `TaskNotification${detail ? ` (${detail})` : ''}`

  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Task notification"
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">TaskNotification</strong>
              {detail ? ` (${detail})` : ''}
            </span>
            {invalid ? <span className="timeline-tool-error-label">ERROR</span> : null}
          </span>
        </summary>
      }
      renderBody={() => <TaskNotificationContent invalid={invalid} result={result} status={status} summary={summary} note={note} taskIds={taskIds} />}
    />
  )
}

export function LocalCommandRow({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div className={timelineMessageClass.localCommandRow}>
      <div className={error ? `${timelineMessageClass.localCommand} text-[var(--tl-danger)]` : timelineMessageClass.localCommand}>{text}</div>
    </div>
  )
}

export function TimelineBlockView({
  block,
  fileMutation,
  timestamp,
  timeZone,
  cwd,
  sessionId,
  sessionLabel,
  entrypoint,
  source,
  showSource = true,
  contentImages,
  localImageContext,
  onViewRaw,
  onViewSubagents,
  subagentCount = 0,
  highlightedMessage,
}: {
  block: TimelineBlock
  fileMutation?: FileMutationResult
  timestamp?: number
  timeZone: string
  cwd?: string
  sessionId?: string
  sessionLabel?: string
  entrypoint?: string
  source?: TimelineSource
  showSource?: boolean
  contentImages?: ReadonlyMap<string, ContentImage>
  localImageContext?: Omit<LocalImageContext, 'messageUuid'>
  onViewRaw?: (blocks: TimelineBlock[]) => void
  onViewSubagents?: () => void
  subagentCount?: number
  highlightedMessage?: { uuid: string; blockIndex: number } | null
}) {
  const text = textFromData(block.data)
  const messageUuid = block.sourceEventIds[0] ?? null
  const blockIndex = isRecord(block.data) && typeof block.data.originalContentBlockIndex === 'number' ? block.data.originalContentBlockIndex : 0
  const highlighted = messageUuid === highlightedMessage?.uuid && blockIndex === highlightedMessage.blockIndex
  const messageAnchorClass = ['timeline-message-anchor', highlighted ? 'timeline-assistant-message-highlighted' : null].filter(Boolean).join(' ')

  if (block.kind === 'assistant.thinking') return <ThinkingBlockView block={block} />
  if (block.kind === 'assistant.peer_message') return <PeerMessageCardView block={block} />
  if (block.kind === 'assistant.task_notification') return <TaskNotificationBlockView block={block} />
  if (block.kind === 'user.local_command') {
    const error = isRecord(block.data) && block.data.localCommandError === true
    return <LocalCommandRow text={text ?? safeDataPreview(block.data)} error={error} />
  }
  if (isPrimaryInputBlock(block))
    return (
      <PrimaryInputView
        blocks={[block]}
        timestamp={timestamp}
        timeZone={timeZone}
        cwd={cwd}
        sessionId={sessionId}
        sessionLabel={sessionLabel}
        entrypoint={entrypoint}
        source={source}
        showSource={showSource}
        onViewRaw={onViewRaw}
        onViewSubagents={onViewSubagents}
        subagentCount={subagentCount}
        highlightedMessage={highlightedMessage}
      />
    )
  if (block.kind === 'user.image' || block.kind === 'user.file') return <AttachmentBlockView block={block} />
  if (fileMutation)
    return (
      <div className="timeline-file-result">
        <FileToolResultValue block={block} fileMutation={fileMutation} />
      </div>
    )

  if (block.kind === 'assistant.text' || block.kind === 'assistant.message') {
    return (
      <div className={messageAnchorClass} data-message-uuid={messageUuid ?? undefined} data-content-block-index={messageUuid ? blockIndex : undefined}>
        <div className="timeline-assistant-text">
          <TimelineMarkdownContent
            value={text ?? safeDataPreview(block.data)}
            contentImages={contentImages}
            localImageContext={messageUuid && localImageContext ? { ...localImageContext, messageUuid } : undefined}
          />
        </div>
      </div>
    )
  }

  const title = blockTitle(block.kind)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={title}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={`${title} (${block.kind})`}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong> <span className="timeline-file-result-summary-detail">({block.kind})</span>
            </span>
          </span>
        </summary>
      }
      renderBody={() => (
        <TimelineContentStack>
          <TimelineTextContent value={text ?? safeDataPreview(block.data)} />
        </TimelineContentStack>
      )}
    />
  )
}

export const TimelineRenderItemView = memo(function TimelineRenderItemView({
  item,
  timestamp,
  timeZone,
  cwd,
  sessionId,
  sessionLabel,
  entrypoint,
  source,
  showSource = true,
  contentImages,
  localImageContext,
  pendingApprovalToolUseId,
  pendingQuestion,
  answeringQuestionId,
  onAnswerQuestion,
  onViewRaw,
  onViewSubagents,
  subagentCount = 0,
  highlightedMessage,
}: {
  item: TimelineRenderItem
  timestamp?: number
  timeZone: string
  cwd?: string
  sessionId?: string
  sessionLabel?: string
  entrypoint?: string
  source?: TimelineSource
  showSource?: boolean
  contentImages?: ReadonlyMap<string, ContentImage>
  localImageContext?: Omit<LocalImageContext, 'messageUuid'>
  pendingApprovalToolUseId?: string | null
  onViewRaw?: (blocks: TimelineBlock[]) => void
  onViewSubagents?: () => void
  subagentCount?: number
  highlightedMessage?: { uuid: string; blockIndex: number } | null
} & QuestionResponseProps) {
  if (item.type === 'block')
    return (
      <TimelineBlockView
        block={item.block}
        fileMutation={item.fileMutation}
        timestamp={timestamp}
        timeZone={timeZone}
        cwd={cwd}
        sessionId={sessionId}
        sessionLabel={sessionLabel}
        entrypoint={entrypoint}
        source={source}
        showSource={showSource}
        contentImages={contentImages}
        localImageContext={localImageContext}
        onViewRaw={onViewRaw}
        onViewSubagents={onViewSubagents}
        subagentCount={subagentCount}
        highlightedMessage={highlightedMessage}
      />
    )
  if (item.type === 'activity-group')
    return (
      <ActivityGroupView
        item={item}
        timeZone={timeZone}
        source={source}
        contentImages={contentImages}
        localImageContext={localImageContext}
        pendingApprovalToolUseId={pendingApprovalToolUseId}
        pendingQuestion={pendingQuestion}
        answeringQuestionId={answeringQuestionId}
        onAnswerQuestion={onAnswerQuestion}
        highlightedMessage={highlightedMessage}
      />
    )
  const interactiveQuestion = item.acceptsQuestionInput && pendingQuestion?.toolName === 'AskUserQuestion' && pendingQuestion.toolUseID === item.toolUseId ? pendingQuestion : null
  return (
    <div className="timeline-tool-call">
      <ToolCallBlockView
        toolUse={item.toolUse}
        results={item.results}
        source={source}
        pendingPermission={pendingApprovalToolUseId === item.toolUseId}
        questionRequest={interactiveQuestion}
        submittingQuestion={interactiveQuestion?.requestId === answeringQuestionId}
        onAnswerQuestion={onAnswerQuestion}
      />
    </div>
  )
})

export type ToastNotification = { message: string; tone: 'success' | 'error' }

const CLI_STATIC_SPARK_PATH =
  'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z'
const CLI_SPARK_PATH =
  'm19.622 66.499 19.675-11.033.325-.967-.325-.538h-.973l-3.297-.2-11.243-.301-9.73-.401-9.46-.502-2.378-.501L0 49.096l.216-1.454 2-1.354 2.865.251 6.324.451 9.514.652 6.865.402L38 49.097h1.622l.216-.652-.54-.401-.433-.402-9.838-6.67-10.649-7.02-5.567-4.063-2.973-2.056-1.514-1.906-.648-4.212 2.702-3.01 3.676.251.919.251 3.73 2.859 7.946 6.168 10.378 7.623 1.514 1.254.609-.411.093-.291-.703-1.154-5.621-10.18-6-10.381-2.703-4.313-.703-2.558c-.272-1.073-.432-1.961-.432-3.06L26.162.552 27.892 0l4.162.551 1.73 1.505 2.594 5.917 4.163 9.278 6.486 12.638 1.892 3.762 1.027 3.46.378 1.053h.649v-.602l.54-7.121.974-8.726.972-11.234.325-3.16L55.35 3.51l3.136-2.056 2.432 1.153 2 2.859-.27 1.855-1.19 7.724-2.324 12.086-1.513 8.124h.864l1.028-1.053 4.108-5.416 4.139-5.116 3.027-3.41 3.567-3.761 2.27-1.805h4.325l3.135 4.714-1.405 4.864-4.433 5.617-.95 1.254-5.27 7.06-3.27 5.678.293.468.788-.067 2.189-.4 6.433-1.154 7.675-1.304 3.46 1.605.378 1.655-1.351 3.36-8.217 2.006-9.621 1.956-4.625 1.216-.159.127.187.278 6.462.585 2.756.15h3.055l1.945.137 3.784.816 1.561 2.658-.55 2.181-3.75.995-3.882-.45-5.73-1.371-5.46-1.355h-.756v.452l4.54 4.463 4.193 4.174 1.595 2.688-.65 1.325-1.35 1.525-2.112-.635-1.388-.865L66 67.452h-.54v.702l1.837 2.708.753 1.388.49 2.45-1.49 1.8-3.1.882-2.3-.483-.9-.8-3.4-6.05-2.215-3.35-.574.363-2.831 30.23-1.298 1.554L47.405 100l-2.54-1.905-1.352-3.11 1.352-6.168 1.621-8.024 1.298-6.37 1.189-7.923.726-2.647-.064-.177-.58.097-5.974 8.193L34 84.252l-7.19 7.673-1.729.702-2.973-1.554.27-2.758 1.676-2.458L34 73.22l6-7.873 3.95-4.647-.1-.45-.234-.095-26.427 17.228-4.703.602-2.054-1.906.27-3.11.974-1.003zm21.192 52.148 8.753 16.491.408-.05 2.035-10.626 1.018-5.815 2.036-14.987 1.883-2.106 1.323-.351 2.85 1.905.305 1.203-.56 9.324-.865 7.568c-.288 3.793-.916 11.449-1.12 11.73-.203.281-.084 2.155 0 3.057l.866.452 1.374-1.354 2.9-4.461 5.751-7.769 7.888-11.228 3.97-1.053 2.544 1.654.458 1.905L80 123.158l-9.618 18.045-2.036 3.509.305.351 2.494-.351 6.514-1.403 5.649-1.705 4.987-1.253 4.682-1.153H94.5l2.548 1.153.502 1.999-1.2 3.4-2.406 1.017-5.649 1.705-9.974 2.506-8.55 2.306-.509.3 1.12.301 7.939.652h4.987l6.742.451 2.927.412 1.523 1.8-1.523 4.054-2.927.746h-3.2l-6.341-.746-13.079-2.156-2.29-.25-.458.25.458.351 3.817 3.359 6.158 4.26L77.659 169l3.541 3.15v3.15l-2.55 1.893h-2.1l-3.65-2.843-2.518-2.47-4.377-4.16-2.392-2.356-.254.15 4.071 7.469 2.162 3.871v3.996l-3.342 1.669-2.891-1.015-.79-1.341-6.488-9.987-.56-.301-.915.752-.329 3.85-.827 3.773-1.1 2.75-1.65 1.15h-3L46.2 181l-.276-1.898 1.76-12.585-.203-.752-1.425-.15-.458.3-1.653 2.284-.545.451-1.95 2.1-2.1 2.4-1.45 1.6-1.7.85-1.4.29-2.2-1.14v-2l.571-1.79 2.35-3.29 1.07-1.454-.306-.451-.407-.15-.509.15-1.476.752-4.53 2.456-3.765 2.406-6.361 4.21-4.02 2.356h-3.97l-1.476-1.203v-.852l1.018-2.155s1.187-1.103 1.73-1.604l2.29-2.206 1.578-1.554 1.628-1.002 4.53-2.857 7.786-4.562 9.211-5.413.305-.251v-.25l-.305-.151h-7.176l-11.145.151-11.959.25H5.7l-4.224-1.002L0 149.925v-1.704l.916-2.055 2.799-1.053 4.326.401 4.58.301 16.946 2.005 2.036.251 7.074.401v-.401l-.967-.702-14.402-10.025-8.397-6.015-6.565-4.261-1.323-3.709.305-2.306 1.323-1.353 1.527-1.253 1.629-.301 3.104 1.554 7.328 4.712 7.786 5.213 10.331 7.167.458-.2-5.496-8.471-4.427-7.77-5.09-7.719-3.358-6.466v-1.955L25.038 100l4.631.602 2.087 3.008zm-7.743 115.21c2.135 1.197 6.446 3.623 6.614 3.745l-4.147-8.857-2.152-4.908-5.46-9.009-4.986-7.135v-2.227c.453-.855 1.033-1.539 1.612-2.225.569-.671 1.138-1.343 1.59-2.178L27.927 200l4.724 1.873 3.517 4.555 2.1 4.605 3.045 9.362 6.561 14.12 1.313 2.631c.14-.455.44-1.488.525-1.973.083-.486.7-6.141.997-8.907l.787-12.045.683-6.528 2.52-4.049c.404-.318 3.989-1.113 3.989-1.113l2.572 2.131.84 2.474v9.616l-.84 4.149-2.205 10.729-.367 2.126v1.417l.367.607h.63l.893-.607 3.622-5.112 4.304-5.567 5.145-6.933 4.251-6.174 2.625-1.417 3.517-.202 2.31.506 1.522 2.682-1.784 3.796-9.45 14.119-7.558 12.601-.42.759.262.304h.263l2.1-.557 10.236-2.378 9.553-2.278 2.205-.607h4.567l1.26 2.379-1.26 3.137-.945.911-9.029 2.581-13.123 2.935-5.564 2.176-.263.102-.262.202.262.304h1.732l6.3.303h7.979l8.924.608 2.414.354 2.572.962 1.155 2.884-1.417 2.834-2.94 2.075-7.086-1.265-8.767-1.468-7.244-.607h-4.042v.304l.42.607 10.289 9.008 4.882 4.504 2.73 2.429.472 2.278s-1.465 1.601-2.047 2.125l-1.68.354-2.782-1.417-10.919-9.008-4.777-3.745-1.102-.86v.253l1.68 2.53 3.254 4.504 6.8 8.907.917 2.48-.393 1.872-2.82.503-3.479-.503-2.94-3.694-2.81-3.998-5.511-6.781-3.465-4.251-.315-.456-.525-.152c-.07.085-.23.274-.315.355s-.21 1.113-.262 1.619l-.577 10.577-.49 6.255-1.489 1.029-3.15.45-2.4-1.2-1.45-2.55v-1.64l.002-.016 1.05-11.134v-1.012l-.63-.405h-.577l-.63.152-5.932 6.326-.347.434-.336.295-2.4 1.65h-1.6l-1.8-1.65v-1.5l1.88-2.902 5.548-7.056.735-1.417v-1.771l-.473-.253h-.787l-4.567 2.682-4.042 2.025-1.614.972-.23.02h-2.35l-1.05-1.05-.9-2.1v-2l1.14-1.208 10.306-5.97.735-.253.157-.254-.367-.202h-.945l-2.745-.132-3.68-.431-3.35-.5-2.2-.55-1.5-1.3-.3-.85v-2.1l.9-1.7 3.6-1.5 2.995-.402 5.44-.403-9.291-6.984-17.218-11.336L3.99 225l-.315-1.973 1.89-3.188 3.36-1.62 3.254 1.215 10.236 6.427zM38.268 335.9l-4.456-2.448-3.204-2.117-.508-.235h-2.45l-1.6.95-1.55 2.5v1.9l1.6 2.083 6.425 4.659 3.614 2.906-.594.408H19.9l-.992.012-1.259 1.632v2.05l.95 2.3 2 1 7.076 1.115h.84c.197 0 2.97.05 3.217.152.198.082 2.36.102 3.416.102l.396.204v.204l-.396.357-2.327 1.938-1.832 1.173-2.97 2.142-4.06 2.754-1.98 1.325-1.683 1.02-.444.323L19 368.3v1.9l1.05 1.65 2 .35 3.25-.35.626-.219 1.649-1.106 2.128-1.173 1.09-.765 2.277-1.122 2.079-1.071.99-.408 1.436-1.02 1.04-.408 1.138-.459h.198v.102l-.149.204-2.376 2.805-1.535 1.785-2.821 3.111-1.337 1.529-2.03 2.091-2.673 3.621-.122.171-.258 2.132.35 1.9 1.3 1.3 3 .7 2.46-1.41.844-1.071 2.97-3.722 4.209-5.151 2.277-2.855.346-.459.396-.357.446.204.198.153-.198 1.479-.297 5.303-.743 7.853-.495 2.754-.198 2.652v1.784l1.776 2.754 2.828.204 1.832-.867s.759-1.479 1.04-2.091l.594-3.773.841-2.601 1.287-6.986 1.04-6.578.148-2.55.149-.867.346-.153.941.459.248.561 3.811 5.456 2.624 3.672 2.08 3.059 2.772 3.621 2.92 4.437 1.634.917h.792l1.832-.509.94-1.938-1.287-2.601-4.059-6.986-1.881-3.672-2.327-4.793-1.337-2.907 1.337.765 1.93 1.275.743.51 1.238.816 1.535 1.428 3.465 2.6 6.04 5.1c.577.427 1.164.845 1.751 1.265 1.379.984 2.76 1.97 4.04 3.069l1.436-.306c.764-.541 1.213-1.054 1.733-1.836l-.792-2.804-.495-1.071-5.644-4.437-3.168-3.008-4.456-3.825-2.722-2.244-4.703-4.283-1.931-1.683v-.357l1.782.357 9.555.867 7.03.816 6.188.816 5.693.204c.445-.17 1.366-.52 1.485-.561.489-.168.843-.571 1.173-.947l.064-.073.594-3.009-2.128-1.989-3.515-.866-9.258-.714-9.01-.561-5.445-.714-1.188-.255.445-.408 2.525-.561c.957-.374 2.92-1.122 3.119-1.122.198 0 2.624-.612 3.812-.918l6.485-1.632 3.218-.561 2.822-.612 4.802-1.427 1.732-2.142.99-3.621v-1.428l-2.277-1.326-4.109.204-2.376.714-5.1 1.071-6.187 1.326-1.584.408-5.891 1.275-1.98.306h-.298v-.561l.495-.714L75 332.585l3.466-6.272 4.406-7.548 1.633-2.855.545-2.091c0-1.007-.545-2.907-.545-2.907l-2.722-.969-4.01 1.479-4.258 4.233-1.188 1.53-5.05 6.017-2.87 3.723-4.01 4.844-3.812 4.029-.397.204-.148-.816.148-1.938.397-4.743 1.98-13.411.742-6.119.495-4.029v-2.142l-2.227-2.295L55.05 300l-2.673 3.314-.396 2.907-.396 5.609-.149 6.171-.693 6.731-.446 4.079-.396 1.632-.445 3.315-.347 3.212-.247.255-.297-.255-.495-1.529-1.139-3.162-1.04-2.04-2.128-4.079-.545-1.173-.643-1.275-7.327-12.851-5-8.567-2.97-1.173-1.882.867-1.98 5.712.248 2.957.89 1.632 4.704 7.7 2.772 4.743 1.139 1.938 2.425 3.773 1.733 3.009.693 1.326.248.663zm-3.027 97.937-2.39-5.488-.45-3.7 1.15-1.4 4.15-1.4h2l2.1 1.4 2.15 2.2 1.773 2.97 2.107 3.985 3.048 4.799.878-3.87.723-2.941.517-5.16.878-8.566.31-4.283.774-5.676 1.24-2.58 3.822-.98.827.98c.19.998.568 3.035.568 3.2v2.012l-.362 4.18-.62 4.076-.723 3.818-.93 6.399-.67 6.501 1.91-1.909 2.944-4.025 5.476-6.192 4.08-5.521 1.653-2.477 1.24-1.238 3.254-1.135 4.132 1.135 1.24 1.961v2.683l-2.944 6.14-2.118 3.509-4.029 5.624-2.84 3.922-5.476 7.946v.465l.775.155 3.874-.62 6.56-1.238 10.588-2.374 3.513-.825 3.822-.619 3.822 1.444.414.981-.672 3.251-3.564 2.064-2.79.98-6.972 2.27-5.527 1.497-7.438 1.806 1.911.412 2.893.568 3.667.361 9.659 1.548 3.46.516 1.654.361 2.17 1.961 1.135 3.199-1.136 2.477-2.686 1.032-2.48.207-6.87-.826-8.935-1.909-4.907-.981-6.25-.825 3.719 2.838 5.372 5.005 2.84 2.425 10.641 10.114 1.085 3.405-1.55 1.497h-1.394l-4.08-1.497-8.42-6.553-3.978-2.838-7.593-6.553.724 1.909 1.653 2.89 2.066 2.786 1.808 2.477 2.789 3.715 3.409 4.076.878 3.096-.878 3.354-.878.31-3.978-.31-2.22-3.354-2.015-3.508-2.066-3.148-2.325-3.509-2.53-4.231-1.292-1.754-2.118-3.612-1.652-2.632-.465-.309-.362.309-.568 3.87v2.064l-.878 4.489-.465 2.632-.775 5.521-1.653 10.836-.361 1.135-3.048.98H44.37l-1.756-2.631-.568-1.961 1.705-16.976 2.014-10.733.31-1.083-.568-.207-1.136 1.29-1.189 1.29-1.6 2.116-3.1 3.921-1.498 1.909-2.066 2.374-3.512 4.438-3.151 5.005-2.015 1.698-3.409-.202-1.394-2.477.464-.928 2.428-3.974 1.911-3.044 2.015-2.632 2.066-2.786 1.601-2.064 3.358-4.179 3.667-4.799 1.86-2.58-3.565 2.115-4.545 2.477-2.376 1.6-5.165 3.302c-.637.482-1.912 1.466-1.912 1.548 0 .045-.098.103-.53.357-.359.211-.947.556-1.897 1.14l-4.287 2.631-2.118.464-1.756-1.702-.362-2.787.362-.619 4.958-3.147 10.692-6.812 10.176-6.037h-2.79l-5.371-.361-7.541-.671-.126.005-8.903-.388-1.9-1.25-.75-1.9.75-2.55 3.25-1.45h3.862l4.281.258 7.955.413h1.86l1.033-.413-5.527-4.489-3.395-2.544-1.17-1.075-2.9-3.5v-2.7l1.15-1.65 1.75-.85h2.95l2.97 1.825 6.806 4.921.258-.155zm27 93.578 2.41-2.215 3.35-.4 2.45 1 2.25 2.1.45 2.9-1.05 3.35-1.65 4.1-.58 2.027-.07.189v.718c.305.086.968.257 1.184.257s2.493-.513 3.606-.77l3.283-.205 4.844-.924 7.965-1.54c1.5-.468 2.981-.808 4.495-1.154l.565-.13 1.668.976 2.584 2.053v.719l-.377.975-1.292 1.54-2.26.873-1.13.359-1.777.513-11.195 3.08-5.812 1.284-6.782 1.694c.072.085.258.277.43.359.173.082.862.137 1.185.154l1.937.36 1.238.256 1.992.257h.86l2.853.616 3.983.616 8.88 1.54 1.992.308 1.023.205 2.045 1.335v1.437L97.034 561l-1.291.924s-1.768.66-2.584.821h-1.453l-2.853-.308-2.045-.205c-.753-.086-2.4-.267-2.96-.308a174 174 0 0 1-2.745-.257l-5.49-.667-3.283-.308-4.09-.617h-1.453l.484.411.969 1.181 2.745 2.567c.646.684 2.002 2.074 2.26 2.156.259.082 2.045 1.642 2.907 2.412l1.291 1.181 2.745 2.361 5.275 3.953 1.184.976.915 2.104-.215 1.13-.539.616h-2.26c-1.47-.673-6.674-2.978-6.674-2.978s-.61-.53-.861-.718l-2.045-1.848-3.983-2.978-1.615-1.027-5.544-4.312-.484-.308h-.7v.565l.27.77 1.291 2.053.7 1.027.861 1.232 1.507 2.31 3.445 4.466 4.897 6.777.431 1.642-.43 2.516-2.692 1.54-2.206-.77s-1.683-2.017-2.476-3.08l-.969-1.181-2.368-3.132-2.26-2.772-2.046-3.234-.968-1.642-1.4-1.797-3.767-5.236-.377-.719h-.538l-.7.308v1.745l-.538 4.107-.323 2.978-1.13 8.727-.216 1.848-.807 9.548c-.072.325-.226.985-.269 1.027-.148.14-.264.338-.383.54-.112.19-.226.384-.37.538l-1.077.308-4.144-1.9-1.13-1.899v-1.797l.376-6.006.27-4.158.484-3.696 1.022-6.263.377-3.902v-1.334h-.377l-1.022.975-.485.616-.645.77-1.4 1.694-3.121 3.491c-.61.77-1.852 2.341-1.938 2.464s-.682.804-.969 1.129l-2.53 3.08-4.52 5.442c-.904 1.245-1.7 2.281-2.96 3.183-.582.415-1.169.413-1.835.411h-.008l-.06-.001h-.089l-2.045-.41-1.669-.976-.43-2.823.915-1.591.807-1.181.969-1.592 1.453-2.772.646-.77 1.56-2.104 1.077-1.489 1.346-1.643 1.614-1.848 2.046-2.721 1.83-2.053 1.237-1.335 3.068-3.336 1.83-2.567.485-.308.16-.257-.322-.103-.915.36-.861.565-1.13.718-1.615.719-1.076.873-1.938 1.129-2.422 1.437-1.991 1.335-3.122 2.002-6.512 4.312-2.368 1.592-2.96 1.54h-2.261l-1.292-1.797-.43-1.437.43-2.516.538-.873 1.561-1.078 4.413-3.08 2.584-1.95 2.153-1.489 2.637-1.489 1.238-.873 2.045-1.334 7.427-4.877.27-.205-.27-.308H21.415l-3.39.308-6.459.205-4.682-.205H5.323L3.6 551.195l.215-2.054 1.13-1.643 1.669-.718h6.512l3.39.308 4.63.41 3.605.411 6.136 1.078 4.682.616h4.79l-1.184-1.694-1.722-2.002-1.884-1.797-8.826-4.363-8.289-3.953-4.379-2.766-.282-.215-.75-2.3 1.4-2.9h2.1l2.75.35 4.06 1.516 1.775 1.079 5.328 3.593 4.199 1.643-1.238-1.643-1.992-3.593-.272-.475a291 291 0 0 0-2.51-5.52v-4.15l2.85-1.55h4.25l2 1.55 2.996 2.662 7.909 14.157 2.045 2.515v-9.548l-.45-7.356v-1.78l.95-2.75h2.1l2.25.75.6 2v6.9l.417 3.416c.143.189.452.586.538.668s.323.445.43.616l3.876-4.312zm3.813 99.929-2.211 2.764-.827 1.235c-.292.223-.898.72-.98.926-.084.206-1.034 1.39-1.499 1.956l-.723 1.029-.878.824h-.413v-3.242c0-6.68.204-8.63.828-14.593l.153-1.465-.206-1.904-.982-1.596-1.704-.566-1.602.257-1.188 1.699-.775 3.963a752 752 0 0 1-.968 8.164c-.154 1.248-.332 2.695-.581 4.754v3.088l-.103.566-.259.154h-.206l-.103-.103c-.083-.288-4.684-6.879-6.974-10.139l-5.423-8.8-2.738-4.221-3.202-1.955h-.775l-2.273 1.029-1.446 2.162.516 2.985 1.24 1.647 4.08 6.124 6.612 10.808 1.705 2.779.775 1.647-.207.824-.568.36h-.465l-2.325-1.801-7.024-5.456-4.597-3.705-4.236-3.243-3.616-2.882-3.615-2.573a9 9 0 0 1-.41-.223c-.459-.257-.978-.549-1.45-.549-.984 0-1.872.128-2.84.309l-.672.669v2.933c0 1.456 1.653 4.323 1.653 4.323l1.136 1.39 2.583 1.853 5.733 3.963 5.062 3.191c.258.103.827.37 1.033.617.207.247 2.428 1.544 3.513 2.162l2.014 1.338 2.376 1.544 1.188.875v.618l-.206.72-.569.206h-3.409l-7.696-.206h-6.818l-6.199-.412-6.146-.308H.517L0 647.606l1.085 2.78 1.136 1.132s4.79.645 6.922.772c2.13.127 5.423 0 5.423 0h8.058c.33 0 2.927-.137 4.184-.206.74.069 2.262.206 2.427.206s2.136-.137 3.1-.206h5.217l.516.206.362.566v.618l-.62.463-5.734 3.603-3.099 2.058-11.777 7.978-4.493 3.293-2.79 1.956.982 2.831 1.808.926h1.033l3.977-2.11s6.026-3.757 8.884-5.61l1.911-1.081 3.1-2.418 1.394-.978 3.977-2.316 2.635-1.956c.327-.172 1.033-.515 1.24-.515.206 0 .637-.309.826-.463h.465l.206.463-.361.361-3.203 4.168c-.602.721-1.807 2.203-1.807 2.368s-3.1 4.289-4.65 6.33l-2.169 2.831-1.653 2.522c-1.532 2.024-4.803 6.485-4.803 6.485l-1.343 2.161.258 3.14.361.772 1.912.617h1.91l2.428-.617c1.594-2.381 3.323-4.769 5.061-7.168 1.813-2.502 3.635-5.017 5.322-7.552 1.102-1.99 3.337-6.001 3.46-6.124.124-.124 2.841-4.615 4.184-6.845l1.705-2.471.981-1.184h.362v.567l-.362 2.11-1.394 4.426-.93 2.161-.362 1.853-2.117 11.735c-.448 2.127-1.385 6.495-1.55 6.948-.207.566-1.24 6.021-1.24 6.227 0 .165-.24 1.03-.361 1.441l1.601 1.956.672.772 2.272.412h2.015l2.17-1.905.619-.926.981-5.816.569-5.713c.24-1.921.754-5.805.878-5.97.124-.164.43-3.774.568-5.558.183-1.61.31-4.787.31-4.787l.568-3.448.465-.823.361.309.569.823 4.545 7.926 1.653 3.139 5.992 11.529s1.903 1.671 2.582 2.573c.248.33 1.068.995 1.447 1.287l2.014.412 2.376-.824q.123-.465.24-.925c.179-.705.356-1.404.587-2.111v-1.853l-4.288-6.794-2.84-4.529-2.428-4.117-1.447-2.265 1.343 1.03 1.912 1.492 4.235 3.86 4.649 3.912 2.582 2.316 4.236 3.396 2.17 1.081 1.343-.206 1.342-1.132s-.189-2.161-.258-3.139l-2.118-2.316-3.977-4.272-5.01-5.147-5.734-6.124-1.394-1.338-2.066-1.596-.569-.875v-.617c.018-.121.104-.361.31-.361s1.12.24 1.55.361l13.326 2.11 10.228.978h1.653l1.962-.978 1.24-2.471v-.875l-.981-1.441-1.602-.875-4.648-.566-5.217-.514-2.635-.206-9.349-1.184-5.268-.463h-.982l-.258-.618.258-.309 1.601-.257 6.882-1.842 1.499-1.499.75-1.95v-1.9l-.75-1.8-1.7-.85h-2.858l-1.24.371h-2.84l-.93-.823c-.07-.155-.207-.505-.207-.669v-1.184l.153-.225-.028-.02 1.7-3.85 1.8-3.4.7-3v-2.2l-2.5-2.15H68.2zm4.076 98.536a398 398 0 0 1 2.87-2.681l3.1-.9 2.95.9 1.2 2.8v2.6l-1.2 3.1-.573 1.069a73 73 0 0 0-1.463 1.974l-5.439 8.299-1.488 1.701c0 .138.072.485.36.774.287.288.598.12.718 0 .427.017 1.282.041 1.282 0 0-.042 2.634-.533 3.951-.774l4.183-.469 2.469.776.55 2-.55 2.8-1.1 1.35-1.7.95-2.28.797-2.752.508c-1.454.292-4.443.897-4.772.979-.328.083-.889.241-1.128.309l.77.258 2.821.413 3.49.618.763.044.638.174 2.1.9.65 1v.95l-1.8 1.85-2 .9-3.35-.35-3.854-.46-.228-.059-2.514-.31h-.873v.31l1.18.927 1.386 1.289 2.103 2.114 1.847 1.752.578.47.375 1.017-.25 1.6-2.35 2.55h-2l-2.682-1.399-.187-.114c-.256-.275-.852-.876-1.18-1.083s-.376.086-.359.258l.77 1.547.77 1.237.871 2.062.873.979 3.9 5.928 2.257 3.35 1.385 2.423 1.898 2.99v1.546l-.359.825-1.077.773-3.233-.464s-3.167-3.321-4.771-5.103l-1.745-2.629c-1.248-1.529-3.827-4.67-4.156-5s-.923-1.374-1.18-1.855c-.718-.877-2.216-2.66-2.463-2.784s-2.36-2.904-3.386-4.278l-.667-.722-.462-.361-.308 1.083-.256 2.371-.667 2.577c-.394 2.698-1.18 8.145-1.18 8.351v2.68l-1.642 10.825c-.795.399-2.668 1.083-2.668 1.083l-2.976-.464-1.54-2.629v-1.289c.155-1.306.452-4.041.411-4.536-.04-.495.496-2.646.77-3.66l1.334-5.103 2-9.227.924-3.608-.41-.722h-.872c-.137 0-.462.062-.667.309l-.02.025c-.285.342-1.22 1.47-1.52 1.47-.246 0-1.402 2.131-1.95 3.196-.41.481-1.303 1.485-1.59 1.65s-.94 1.168-1.231 1.649l-1.54 2.114-1.693 1.855-2.155 2.938c-.342.361-1.026 1.104-1.026 1.186s-2.257 2.887-3.386 4.278l-1.386 1.65-3.437 2.68h-3.13l-.956-1.708-.275-2.622 5.849-7.113 2.565-3.144 6.465-8.145 1.437-1.546 1.129-1.856.513-.361-.514-.464h-.461l-1.232.464c-.906.498-2.811 1.495-3.18 1.495-.27 0-1.1.563-1.837 1.062-.523.355-.999.678-1.191.742-.37.124-5.285 2.663-7.696 3.918l-6.927 4.02-1.744.413-2.412-.413-.41-2.628 1.231-2.114 6.362-5 8.158-5.361 7.953-5.155.36-.36v-.464l-1.13-.31h-2.616c-2.121-.189-6.475-.567-6.927-.567s-1.864-.206-2.514-.309l-9.954-1.495c-2.172-.257-6.772-.773-6.772-.773l-2.617-.773-2.053-2.474-.41-1.031 1.642-2.114 2.104-1.031h1.077l5.336.619 6.568.412H19.6l4.31.619 14.11 1.082h1.539v-1.082c-.171-.155-.565-.495-.77-.619-.205-.123-.599-.532-.77-.721l-2.565-1.908-1.847-1.34c-.428-.464-1.344-1.474-1.59-1.804-.247-.33-1.061-.962-1.437-1.237l-1.232-.773-15.238-12.423c-1.904-1.363-5.49-4.279-5.49-4.279v-2.835s.678-.914 1.026-1.237h4.464l3.95 2.887 1.54 1.443 7.388 4.846 7.286 5.103 2.052 1.649h.565l.308-.412-.308-1.237-.565-1.598-1.334-3.093-3.745-7.268-2.617-5.619-2.411-4.33v-5.258l1.539-.824h1.847l2.052.824 1.899.928c.24.447.728 1.402.77 1.65.04.247.769 1.546 1.128 2.165l1.437 2.062 3.9 6.082 5.746 9.588 4.669 7.577.256.361.513.567.821-.309V730c.253-3.301.694-6.585 1.135-9.876.332-2.474.664-4.952.918-7.444l1.18-4.175 2.822-1.65h2.822l1.744 2.835-.41 6.083c-1.013 4.859-1.653 9.803-2.292 14.736a572 572 0 0 1-.684 5.161l.308.309.872-.876 2.822-2.526 2.77-2.99z'

export function FooterStatus({ state }: { state: TurnFooterState }) {
  if (!state) return null
  if (state.kind === 'cooking' || state.kind === 'waiting') return <CliCookingIndicator label={state.label} />
  return (
    <span className="cli-cooked min-w-0 [overflow-wrap:anywhere] text-[13px] leading-[1.6]" role="status" aria-live="polite" aria-label="Turn details">
      <CliStaticSparkIcon /> <span>{state.label}</span>
    </span>
  )
}

export const AssistantResponseFrameView = memo(function AssistantResponseFrameView({
  item,
  turnBlocks,
  timestamp,
  timeZone,
  footerState,
  phase,
  cwd,
  sessionId,
  sessionLabel,
  entrypoint,
  source,
  showSource = true,
  localImageContext,
  pendingApprovalToolUseId,
  pendingQuestion,
  answeringQuestionId,
  onAnswerQuestion,
  onViewRaw,
  onViewSubagents,
  subagentCount = 0,
  highlightedMessage,
  onForkSession,
  onNotify,
  onShare,
}: {
  item: AssistantResponseFrameItem
  turnBlocks: readonly TimelineBlock[]
  timestamp?: number
  timeZone: string
  footerState?: TurnFooterState
  phase: TurnPhase
  cwd?: string
  sessionId?: string
  sessionLabel?: string
  entrypoint?: string
  source: ResponseSource | null
  showSource?: boolean
  localImageContext?: Omit<LocalImageContext, 'messageUuid'>
  pendingApprovalToolUseId?: string | null
  onViewRaw?: (blocks: TimelineBlock[]) => void
  onViewSubagents?: () => void
  subagentCount?: number
  highlightedMessage?: { uuid: string; blockIndex: number } | null
  onForkSession?: (upToMessageId: string) => Promise<unknown>
  onNotify?: (toast: ToastNotification) => void
  onShare?: () => void
} & QuestionResponseProps) {
  const copyText = assistantResponseText(item.items)
  const contentImages = useMemo(() => contentImagesFromTurnBlocks(turnBlocks), [turnBlocks])
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

  const forkAction =
    canForkAssistantResponse({ transcriptOwned: source === 'TRANSCRIPT', phase, forkMessageId, enabled: Boolean(onForkSession) }) && forkMessageId && onForkSession ? (
      <button
        className="timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)] disabled:cursor-default disabled:opacity-50"
        style={{ borderRadius: 5 }}
        type="button"
        aria-label="Fork session from this response"
        data-tooltip="Fork"
        onClick={handleFork}
        disabled={forking}
      >
        {forking ? (
          <span className="turn-spinner session-age-spinner" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1.9 10h5.4c1.1 0 1.6-.2 2.3-.9l6.2-6.2" />
            <path d="M10.8 2.8h5v5" />
            <path d="m10.8 12.9 5 5" />
            <path d="M10.8 17.2h5v-5" />
          </svg>
        )}
      </button>
    ) : null

  const shareAction = onShare ? (
    <button
      className="timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)] disabled:cursor-default disabled:opacity-50"
      style={{ borderRadius: 5 }}
      type="button"
      aria-label="Share this turn"
      data-tooltip="Share"
      onClick={onShare}
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="15" cy="4.5" r="2.2" />
        <circle cx="5" cy="10" r="2.2" />
        <circle cx="15" cy="15.5" r="2.2" />
        <path d="m7 8.9 6-3.3M7 11.1l6 3.3" />
      </svg>
    </button>
  ) : null

  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response">
        <div className={timelineMessageClass.assistantFrameBody}>
          {item.items.map((child) => (
            <TimelineRenderItemView
              item={child}
              timeZone={timeZone}
              source={source ?? undefined}
              contentImages={contentImages}
              localImageContext={localImageContext}
              pendingApprovalToolUseId={pendingApprovalToolUseId}
              pendingQuestion={pendingQuestion}
              answeringQuestionId={answeringQuestionId}
              onAnswerQuestion={onAnswerQuestion}
              highlightedMessage={highlightedMessage}
              key={timelineRenderItemKey(child)}
            />
          ))}
        </div>
      </section>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-y-1 px-1 text-[var(--tl-muted)] [overflow-wrap:anywhere] [&>*]:align-middle [&>span+span]:before:mx-2 [&>span+span]:before:inline-block [&>span+span]:before:h-2 [&>span+span]:before:w-px [&>span+span]:before:bg-[color-mix(in_srgb,var(--tl-muted)_28%,transparent)] [&>span+span]:before:content-[''] [&_button]:align-middle">
        {footerState ? <FooterStatus state={footerState} /> : null}
        <TimelineTimestamp
          value={timestamp}
          timeZone={timeZone}
          className={`${timelineMessageClass.timestampAssistant} !inline-flex flex-wrap !whitespace-normal align-middle [overflow-wrap:anywhere] [&>*]:align-middle [&_button]:align-middle`}
          cwd={cwd}
          sessionId={sessionId}
          sessionLabel={sessionLabel}
          entrypoint={entrypoint}
          copyText={copyText}
          copyLabel="Copy assistant response"
          onViewRaw={onViewRaw ? () => onViewRaw(item.items.flatMap(timelineRenderItemBlocks)) : undefined}
          viewRawLabel="View raw assistant response"
          onViewSubagents={onViewSubagents}
          subagentCount={subagentCount}
          midActions={forkAction ?? undefined}
          extraActions={shareAction ?? undefined}
          source={showSource ? (source ?? undefined) : undefined}
        />
      </div>
      {forkError ? <div className="panel error">Failed to fork session: {forkError}</div> : null}
    </div>
  )
})

function CliSparkIcon({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 100 800">
        <path d={CLI_SPARK_PATH} />
      </svg>
    </span>
  )
}

export function CliStaticSparkIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true" className="cli-cooked-mark">
      <path d={CLI_STATIC_SPARK_PATH} />
    </svg>
  )
}

function CliCookingIndicator({ label = 'Cooking…' }: { label?: string }) {
  return (
    <span className="cli-cooking min-w-0 [overflow-wrap:anywhere] text-[13px] leading-[1.6]" role="status" aria-live="polite">
      <CliSparkIcon className="cli-cooking-mark" />
      <span className="cli-cooking-label">{label}</span>
    </span>
  )
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

const rawTranscriptLineColumns = ['uuid', 'type', 'parent_uuid', 'raw_json'] as const

function RawTranscriptLinesWaterfall({ lines }: { lines: SessionRawTranscriptLine[] }) {
  const timed = lines.map((line, index) => ({ line, index })).filter((item): item is { line: SessionRawTranscriptLine & { timestamp_ms: number }; index: number } => item.line.timestamp_ms !== null)
  const startMs = timed[0]?.line.timestamp_ms
  if (startMs === undefined) return null
  const maxEndMs = Math.max(1, ...timed.map((item, index) => item.line.timestamp_ms - startMs + Math.max(0, (timed[index + 1]?.line.timestamp_ms ?? item.line.timestamp_ms) - item.line.timestamp_ms)))
  const unavailable = lines.length - timed.length
  return (
    <section className="raw-message-waterfall" aria-labelledby="raw-message-waterfall-title">
      <div className="raw-message-waterfall-header">
        <h3 id="raw-message-waterfall-title">Timing waterfall</h3>
        {unavailable > 0 ? <span>{unavailable} without timestamp</span> : null}
      </div>
      <div className="raw-message-waterfall-rows">
        {timed.map((item, index) => {
          const offsetMs = item.line.timestamp_ms - startMs
          const durationMs = Math.max(0, (timed[index + 1]?.line.timestamp_ms ?? item.line.timestamp_ms) - item.line.timestamp_ms)
          const left = `${Math.min(99, (offsetMs / maxEndMs) * 100)}%`
          const width = durationMs === 0 ? '2px' : `${(durationMs / maxEndMs) * 100}%`
          return (
            <div className="raw-message-waterfall-row" key={`${item.line.byte_offset}:${item.line.line_no}`}>
              <div className="raw-message-waterfall-meta">
                <span>
                  {index + 1}/{timed.length}
                </span>
                <strong>{item.line.type ?? '—'}</strong>
                <span>+{formatDuration(offsetMs)}</span>
                <span>{formatDuration(durationMs)}</span>
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

function rawTranscriptLinePreview(raw: string): string {
  try {
    return safeDataPreview(JSON.parse(raw))
  } catch {
    return `[raw JSON unavailable: ${raw.length} chars]`
  }
}

function RawTranscriptLinesTable({ lines, timeZone }: { lines: SessionRawTranscriptLine[]; timeZone: string }) {
  return (
    <>
      <RawTranscriptLinesWaterfall lines={lines} />
      <div className="debug-table-wrap">
        <table className="debug-table raw-messages-table">
          <thead>
            <tr>
              <th>timestamp</th>
              {rawTranscriptLineColumns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const timestamp = line.timestamp_ms == null ? null : zonedTimestamp(new Date(line.timestamp_ms).toISOString(), timeZone)
              return (
                <tr className={line.type === 'assistant' ? 'raw-message-assistant' : line.type === 'user' ? 'raw-message-user' : undefined} key={`${line.byte_offset}:${line.line_no}`}>
                  <td className="debug-mono debug-timestamp-cell">
                    {timestamp ? (
                      <>
                        <div>{timestamp.date}</div>
                        <div className="debug-muted">{timestamp.time}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  {rawTranscriptLineColumns.map((column) => (
                    <td className={column === 'raw_json' ? 'debug-content-cell raw-message-json' : column === 'uuid' ? 'debug-mono' : undefined} key={column}>
                      {column === 'raw_json' ? <pre>{rawTranscriptLinePreview(line.raw_json)}</pre> : (line[column] ?? '—')}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function SubagentsDialog({
  sessionTitle,
  sessionId,
  projectPath,
  timeZone,
  tree,
  treeLoading,
  treeError,
  selectedAgentId,
  transcript,
  transcriptLoading,
  transcriptError,
  onSelect,
  onClose,
}: {
  sessionTitle?: string | null
  sessionId?: string
  projectPath?: string
  timeZone: string
  tree: TurnSubagentNode[]
  treeLoading: boolean
  treeError: unknown
  selectedAgentId: string | null
  transcript: TurnSubagentTranscriptResponse['transcript'] | undefined
  transcriptLoading: boolean
  transcriptError: unknown
  onSelect: (agentId: string) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const nodes = tree
  const selected = nodes.find((node) => node.agentId === selectedAgentId) ?? null
  const children = new Map<string | null, typeof nodes>()
  const ids = new Set(nodes.map((node) => node.agentId))
  for (const node of nodes) {
    const parent = node.parentAgentId && ids.has(node.parentAgentId) ? node.parentAgentId : null
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  for (const siblings of children.values()) siblings.sort((left, right) => (right.transcriptModifiedAtMs ?? 0) - (left.transcriptModifiedAtMs ?? 0))
  const selectedAncestorIds = new Set<string>()
  for (let ancestor = selected?.parentAgentId ?? null; ancestor && !selectedAncestorIds.has(ancestor); ancestor = nodes.find((node) => node.agentId === ancestor)?.parentAgentId ?? null)
    selectedAncestorIds.add(ancestor)
  const effectiveExpandedIds = new Set([...expandedIds, ...selectedAncestorIds])
  const toggleExpanded = (agentId: string) => {
    const collapsing = effectiveExpandedIds.has(agentId)
    const containsSelection = selectedAncestorIds.has(agentId)
    setExpandedIds((current) => {
      const next = new Set(current)
      if (collapsing) next.delete(agentId)
      else next.add(agentId)
      return next
    })
    if (collapsing && containsSelection) onSelect(agentId)
  }
  const renderNode = (node: (typeof nodes)[number]) => {
    const title = node.agentType && node.name && node.agentType !== node.name ? `${node.agentType} · ${node.name}` : (node.agentType ?? node.name ?? `Subagent ${node.agentId.slice(-8)}`)
    const nodeChildren = children.get(node.agentId) ?? []
    const expanded = effectiveExpandedIds.has(node.agentId)
    const subtreeId = `subagent-children-${node.agentId}`
    return (
      <li key={node.agentId}>
        <div className="subagents-tree-row">
          {nodeChildren.length > 0 ? (
            <button
              className="subagents-tree-toggle"
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
              aria-expanded={expanded}
              aria-controls={subtreeId}
              onClick={() => toggleExpanded(node.agentId)}
            >
              <svg className="subagents-tree-toggle-icon" viewBox="0 0 12 12" focusable="false" aria-hidden="true">
                <path d="M4 2.5 8 6 4 9.5" />
              </svg>
            </button>
          ) : (
            <span className="subagents-tree-toggle-spacer" aria-hidden="true" />
          )}
          <button
            className="subagents-tree-node"
            data-selected={node.agentId === selectedAgentId}
            type="button"
            aria-pressed={node.agentId === selectedAgentId}
            disabled={!node.metadataReady}
            onClick={() => onSelect(node.agentId)}
          >
            <span className="subagents-tree-copy">
              <span className="subagents-tree-title">{title}</span>
              {node.metadataReady ? (
                node.description ? (
                  <span className="subagents-tree-description">{node.description}</span>
                ) : null
              ) : (
                <span className="subagents-tree-description">Waiting for subagent metadata</span>
              )}
            </span>
            <span className="subagents-tree-age">{formatAge(node.transcriptModifiedAtMs)}</span>
          </button>
        </div>
        {expanded && nodeChildren.length > 0 ? <ul id={subtreeId}>{nodeChildren.map(renderNode)}</ul> : null}
      </li>
    )
  }
  const transcriptTurns = transcript
    ? transcript.turns.map((turn) => {
        const blocks = projectTimelineTurn(turn)
        const items = groupAssistantResponseFrames(groupTimelineBlocks(blocks, false))
        return { ...turn, blocks, items, lastAssistantFrameId: [...items].reverse().find((item) => item.type === 'assistant-response-frame')?.id }
      })
    : []

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  return (
    <dialog
      className="subagents-dialog"
      ref={dialogRef}
      aria-labelledby="subagents-dialog-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <header className="subagents-dialog-header">
        <div>
          <h2 id="subagents-dialog-title">Subagents</h2>
          {sessionTitle ? <p>{sessionTitle}</p> : null}
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="subagents-dialog-body">
        <nav className="subagents-tree" aria-label="Subagent tree" aria-busy={treeLoading}>
          {treeError && nodes.length === 0 ? <p className="panel error">Failed to load subagents: {treeError instanceof Error ? treeError.message : String(treeError)}</p> : null}
          {treeError && nodes.length > 0 ? <p className="panel error">Refresh failed. Showing cached data.</p> : null}
          {nodes.length > 0 ? (
            <ul>{(children.get(null) ?? []).map(renderNode)}</ul>
          ) : treeError ? null : treeLoading ? (
            <ol className="session-list rail-session-list session-list-skeleton" aria-label="Loading subagents">
              {[0, 1, 2].map((item) => (
                <li className="session-row-skeleton" key={item}>
                  <span className="session-row-skeleton-title" />
                  <span className="session-row-skeleton-age" />
                </li>
              ))}
            </ol>
          ) : (
            <p>No subagents are available.</p>
          )}
        </nav>
        <section className="subagents-transcript" aria-label="Subagent transcript" aria-busy={transcriptLoading}>
          {!selected ? (
            <p className="panel muted">Select a subagent to view its transcript.</p>
          ) : transcriptLoading ? (
            <section className="session-workspace-view" aria-label="Loading subagent transcript" aria-busy="true">
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
          ) : transcriptError ? (
            <p className="panel error">Failed to load transcript: {transcriptError instanceof Error ? transcriptError.message : String(transcriptError)}</p>
          ) : transcriptTurns.length === 0 ? (
            <p className="panel muted">No transcript is available yet.</p>
          ) : (
            <section className="session-workspace-view">
              <section className="timeline-panel">
                {transcriptTurns.map((turn) => (
                  <article className="turn-card" key={turn.primaryUserUuid}>
                    <div className="timeline-blocks">
                      {turn.items.map((item) =>
                        item.type === 'assistant-response-frame' ? (
                          <AssistantResponseFrameView
                            item={item}
                            turnBlocks={turn.blocks}
                            timeZone={timeZone}
                            footerState={null}
                            phase="settled"
                            cwd={item.id === turn.lastAssistantFrameId ? turn.responseCwd : undefined}
                            sessionId={item.id === turn.lastAssistantFrameId ? (selectedAgentId ?? undefined) : undefined}
                            sessionLabel="Subagent ID"
                            entrypoint={item.id === turn.lastAssistantFrameId ? turn.entrypoint : undefined}
                            source="TRANSCRIPT"
                            showSource={false}
                            localImageContext={
                              sessionId && selectedAgentId && projectPath && (turn.responseCwd ?? turn.userCwd)
                                ? { sessionId, agentId: selectedAgentId, projectPath, cwd: (turn.responseCwd ?? turn.userCwd) as string }
                                : undefined
                            }
                            key={item.id}
                          />
                        ) : item.type === 'primary-input' ? (
                          <PrimaryInputView
                            blocks={item.blocks}
                            timestamp={turn.primaryUserTimestampMs}
                            timeZone={timeZone}
                            cwd={turn.userCwd}
                            sessionId={selectedAgentId ?? undefined}
                            sessionLabel="Subagent ID"
                            entrypoint={turn.entrypoint}
                            source="TRANSCRIPT"
                            showSource={false}
                            key={item.id}
                          />
                        ) : (
                          <TimelineRenderItemView
                            item={item.item}
                            timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.primaryUserTimestampMs : undefined}
                            timeZone={timeZone}
                            cwd={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.userCwd : undefined}
                            sessionId={item.item.type === 'block' && item.item.block.kind === 'user.message' ? (selectedAgentId ?? undefined) : undefined}
                            sessionLabel="Subagent ID"
                            entrypoint={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.entrypoint : undefined}
                            showSource={false}
                            key={timelineRenderItemKey(item.item)}
                          />
                        ),
                      )}
                    </div>
                  </article>
                ))}
              </section>
            </section>
          )}
        </section>
      </div>
    </dialog>
  )
}

export function RawMessagesDialog({ lines, timeZone, loading, error, onClose }: { lines: SessionRawTranscriptLine[]; timeZone: string; loading: boolean; error: unknown; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const visibleLines = lines.filter((line) => line.type !== 'last-prompt' && line.type !== 'atis-latch' && line.type !== 'attachment')

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  return (
    <dialog
      className="raw-messages-dialog"
      ref={dialogRef}
      aria-labelledby="raw-messages-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="raw-messages-header">
        <div>
          <h2 id="raw-messages-title">Raw messages</h2>
          <div className="raw-messages-session">
            Session: <span className="debug-mono">{visibleLines[0]?.session_id ?? '—'}</span>
          </div>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {loading ? (
        <p className="panel muted">Loading raw messages…</p>
      ) : error ? (
        <p className="panel error">Failed to load raw messages: {error instanceof Error ? error.message : String(error)}</p>
      ) : visibleLines.length === 0 ? (
        <p className="panel muted">No matching raw messages are persisted yet.</p>
      ) : (
        <RawTranscriptLinesTable lines={visibleLines} timeZone={timeZone} />
      )}
    </dialog>
  )
}
