import {
  formatTurnDuration,
  hasTerminalEvidence,
  isPrimaryTimelineUserMessage,
  isTimelineLocalCommandCaveatMessage,
  isTimelineTaskNotificationMessage,
  parseTimelineTaskNotification,
  type SessionSummary,
  type SessionTimelineResponse,
  stableTurnVerb,
  type TimelineBlock,
  type TurnSummary,
  timelineInterruptMarker,
  timelineLocalCommand,
  timelineLocalCommandFeedback,
  timelineLocalCommandFeedbackIsError,
  timelineLocalCommandFeedbackSummary,
  timelineToolIsHidden,
  timelineToolUseId,
  timelineToolUseResult,
  turnCookingLabel,
  turnDurationLabel,
  turnPendingAgentLabel,
} from '@cotta/shared'

export {
  COOKING_VERBS,
  effectiveActiveTurnId,
  formatTurnDuration,
  hasTerminalEvidence,
  stableTurnVerb,
  stableVerb,
  TURN_DONE_VERBS,
  turnActiveTaskLabel,
  turnCookingLabel,
  turnDurationLabel,
  turnPendingAgentLabel,
} from '@cotta/shared'

import type { StructuredPatchHunk } from 'diff'
import { type BashActivityEvidence, classifyBashActivity } from './bash-activity'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function textFromData(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.text === 'string') return value.text
  if (isRecord(value) && isRecord(value.raw) && typeof value.raw.content === 'string') return value.raw.content
  if (isRecord(value) && typeof value.content === 'string') return value.content
  const content = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.content) ? value.content : null
  if (content) {
    const text = content
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
    return text || null
  }
  return null
}

export function shortText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return '—'
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

export function markdownText(value: string): string {
  return value
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
}

export type OverlayMessageSource = 'OPTIMISTIC' | 'LIVE'
export type PrimaryMessageSource = OverlayMessageSource | 'TRANSCRIPT'
export type ResponseSource = 'LIVE' | 'RECONCILING' | 'TRANSCRIPT'
export type TimelineSource = PrimaryMessageSource | ResponseSource

export type { StructuredPatchHunk } from 'diff'
export type FileMutationResult =
  | { type: 'update' | 'overwrite'; filePath: string; cwd?: string; hunks: StructuredPatchHunk[] }
  | { type: 'create'; filePath: string; cwd?: string; content: string; hunks: StructuredPatchHunk[] }

export type TimelineBlockRenderItem = { type: 'block'; block: TimelineBlock; fileMutation?: FileMutationResult }
export type TimelineToolCallRenderItem = {
  type: 'tool-call'
  toolUse: TimelineBlock | null
  results: TimelineBlock[]
  toolUseId: string
  activityEvidence?: ActivityEvidence | null
  acceptsQuestionInput?: boolean
}
export type TimelineActivityGroupItem = TimelineBlockRenderItem | TimelineToolCallRenderItem
export type TimelineActivityGroupRenderItem = {
  type: 'activity-group'
  id: string
  items: TimelineActivityGroupItem[]
  startedAtMs?: number
  endedAtMs?: number
  active: boolean
  hasThinking: boolean
}

export type TimelineRenderItem = TimelineActivityGroupItem | TimelineActivityGroupRenderItem

export type AssistantResponseFrameItem = { type: 'assistant-response-frame'; id: string; items: TimelineRenderItem[] }
export type PrimaryInputDisplayItem = { type: 'primary-input'; id: string; blocks: TimelineBlock[] }

export function timelineRenderItemBlocks(item: TimelineRenderItem): TimelineBlock[] {
  if (item.type === 'block') return [item.block]
  if (item.type === 'activity-group') return item.items.flatMap(timelineRenderItemBlocks)
  return [...(item.toolUse ? [item.toolUse] : []), ...item.results]
}

export function assistantResponseFrameForkMessageId(item: AssistantResponseFrameItem): string | null {
  return item.items.flatMap(timelineRenderItemBlocks).at(-1)?.sourceEventIds.at(-1) ?? null
}

export function canForkAssistantResponse(input: { transcriptOwned: boolean; phase: TurnPhase; forkMessageId: string | null; enabled: boolean }): boolean {
  return input.transcriptOwned && input.phase === 'settled' && input.forkMessageId !== null && input.enabled
}

export type TimelineDisplayItem = { type: 'item'; item: TimelineRenderItem } | PrimaryInputDisplayItem | AssistantResponseFrameItem

export function primaryInputText(blocks: TimelineBlock[]): string | null {
  const text = blocks.flatMap((block) => (block.kind === 'user.message' ? (textFromData(block.data) ?? []) : [])).join('\n')
  return text || null
}

export function assistantResponseText(items: TimelineRenderItem[]): string | null {
  const text = items
    .flatMap((item) => {
      if (item.type === 'activity-group') return assistantResponseText(item.items) ?? []
      if (item.type !== 'block' || (item.block.kind !== 'assistant.text' && item.block.kind !== 'assistant.message')) return []
      const value = textFromData(item.block.data)
      return value ? [value] : []
    })
    .join('\n')
  return text || null
}

export function thinkingTextFromBlock(block: TimelineBlock): string | null {
  const value = thinkingValue(block)
  return typeof value === 'string' ? value : null
}

export function coalesceAdjacentAssistantThinkingBlocks(blocks: TimelineBlock[]): TimelineBlock[] {
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
    const streamingBlock = pending.find(({ block }) => isRecord(block.data) && block.data.streaming === true)?.block
    const streaming = Boolean(streamingBlock)
    const timestamps = pending.map(({ block }) => timelineBlockTimestampMs(block)).filter((value): value is number => value !== null)
    const streamingStartedAtMs = streamingBlock ? timelineBlockTimestampMs(streamingBlock) : null
    const durations = pending.map(({ block }) => thinkingDurationMs(block))
    const hasDuration = durations.some((value) => value !== null)
    const durationMs = hasDuration ? durations.reduce<number>((total, value) => total + (value ?? 0), 0) : null
    result.push({
      ...first,
      sourceEventIds,
      data: {
        type: 'thinking',
        thinking: pending.map(({ text }) => text).join(''),
        ...(timestamps[0] !== undefined ? { timelineTimestampMs: timestamps[0] } : {}),
        ...(streamingStartedAtMs !== null ? { streamingStartedAtMs } : {}),
        ...(durationMs !== null ? { durationMs } : {}),
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

    if (pending.length > 0 && pending[0]!.block.apiMessageId !== block.apiMessageId) flushPending()
    pending.push({ block, text })
  }

  flushPending()
  return result
}

export function timelineRenderItemKey(item: TimelineRenderItem): string {
  if (item.type === 'block') return item.block.id
  if (item.type === 'activity-group') return item.id
  return `tool-call:${item.toolUseId}:${item.toolUse?.id ?? item.results[0]?.id ?? 'pending'}`
}

export function isPrimaryInputBlock(block: TimelineBlock): boolean {
  return block.kind.startsWith('user.') && isRecord(block.data) && block.data.primaryTimelineUserMessage === true
}

export function isUserMessageBlock(block: TimelineBlock): boolean {
  return ['user.message', 'user.image', 'user.file'].includes(block.kind)
}

export function timelineRenderItemHasVisibleResponse(item: TimelineRenderItem): boolean {
  if (item.type === 'activity-group') return item.items.some(timelineRenderItemHasVisibleResponse)
  if (item.type === 'tool-call') return true
  if (item.block.kind === 'assistant.text' || item.block.kind === 'assistant.message') return Boolean(textFromData(item.block.data)?.trim())
  if (item.block.kind === 'assistant.thinking') return Boolean(thinkingTextFromBlock(item.block)?.trim())
  return !isPrimaryInputBlock(item.block)
}

export function assistantResponseFrameHasVisibleContent(items: TimelineRenderItem[]): boolean {
  return items.some(timelineRenderItemHasVisibleResponse)
}

export function shouldShowResponseSkeleton(input: { phase: TurnPhase; hasVisibleResponse: boolean }): boolean {
  return input.phase === 'submitted' || (input.phase === 'rendering' && !input.hasVisibleResponse)
}

export function shouldHoldResponseSkeleton(input: { awaitingTurnId: string | null; turnId: string; hasVisibleResponse: boolean; terminal: boolean }): boolean {
  return input.awaitingTurnId === input.turnId && !input.hasVisibleResponse && !input.terminal
}

export function shouldFrameTimelineItem(item: TimelineRenderItem): boolean {
  return timelineRenderItemHasVisibleResponse(item)
}

export const hiddenTimelineTools = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ListAgents'])

export function isHiddenTimelineTool(item: TimelineRenderItem): boolean {
  return item.type === 'tool-call' && timelineToolIsHidden(toolDataString(item.toolUse, 'name') ?? '', item.results.some(toolResultIsError))
}

export function groupAssistantResponseFrames(items: TimelineRenderItem[]): TimelineDisplayItem[] {
  const grouped: TimelineDisplayItem[] = []
  let frameItems: TimelineRenderItem[] = []
  let primaryBlocks: TimelineBlock[] = []
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

  function flushPrimaryInput() {
    if (primaryBlocks.length === 0) return
    grouped.push({ type: 'primary-input', id: `primary-input:${primaryBlocks[0]!.id}`, blocks: primaryBlocks })
    primaryBlocks = []
  }

  for (const item of items) {
    if (isHiddenTimelineTool(item)) continue
    if (item.type === 'block' && item.block.kind !== 'user.local_command' && isPrimaryInputBlock(item.block)) {
      flushFrame()
      primaryBlocks.push(item.block)
      continue
    }
    flushPrimaryInput()
    if (shouldFrameTimelineItem(item)) {
      frameItems.push(item)
      continue
    }
    flushFrame()
    grouped.push({ type: 'item', item })
  }

  flushPrimaryInput()
  flushFrame()
  return grouped
}

export function groupAdjacentActivityItems(items: TimelineRenderItem[], activeToolCalls = true, fallbackEndedAtMs?: number): TimelineRenderItem[] {
  const grouped: TimelineRenderItem[] = []
  let pending: TimelineActivityGroupItem[] = []
  let groupIndex = 0

  function flushPending() {
    if (pending.length === 0) return
    if (pending.length === 1) {
      grouped.push(pending[0]!)
      pending = []
      return
    }

    const timestamps = pending.map(timelineRenderItemTimestampMs).filter((value): value is number => value !== null)
    const startedAtMs = timestamps[0]
    const active = activeToolCalls && pending.some(timelineRenderItemIsActive)
    const endedAtMs =
      !active && fallbackEndedAtMs !== undefined
        ? fallbackEndedAtMs
        : ([...pending]
            .reverse()
            .map(timelineRenderItemLastTimestampMs)
            .find((value) => value !== null) ?? undefined)
    grouped.push({
      type: 'activity-group',
      id: `activity-group:${groupIndex++}:${timelineRenderItemKey(pending[0]!)}`,
      items: pending,
      active,
      hasThinking: pending.some((item) => item.type === 'block' && item.block.kind === 'assistant.thinking'),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(endedAtMs !== undefined ? { endedAtMs } : {}),
    })
    pending = []
  }

  for (const item of items) {
    if (isHiddenTimelineTool(item)) continue
    if (isActivityGroupItem(item)) {
      pending.push(item)
      continue
    }
    flushPending()
    grouped.push(item)
  }

  flushPending()
  return grouped
}

function isToolCallResultBlock(block: TimelineBlock): boolean {
  return block.kind === 'tool.result' || block.kind === 'skill.meta'
}

export function groupTimelineBlocks(blocks: TimelineBlock[], activeToolCalls = true, fallbackEndedAtMs?: number): TimelineRenderItem[] {
  const displayBlocks = coalesceAdjacentAssistantThinkingBlocks(blocks)
  const resultsByToolUseId = new Map<string, TimelineBlock[]>()
  const matchedToolUseIds = new Set<string>()
  for (const block of displayBlocks) {
    if (block.kind === 'assistant.tool_use' && block.toolUseId) matchedToolUseIds.add(block.toolUseId)
    if (!isToolCallResultBlock(block) || !block.toolUseId) continue
    resultsByToolUseId.set(block.toolUseId, [...(resultsByToolUseId.get(block.toolUseId) ?? []), block])
  }

  const consumedResults = new Set<string>()
  const detachedResults = new Map<string, FileMutationResult>()
  const latestAskUserQuestion = new Map(
    displayBlocks.flatMap((block, index) => (block.kind === 'assistant.tool_use' && block.toolUseId && toolDataString(block, 'name') === 'AskUserQuestion' ? [[block.toolUseId, index] as const] : [])),
  )
  const items = displayBlocks.flatMap((block, blockIndex): TimelineRenderItem[] => {
    if (block.kind === 'assistant.tool_use' && block.toolUseId) {
      const results = resultsByToolUseId.get(block.toolUseId) ?? []
      const fileMutations = results.map((result) => fileMutationResult(toolDataString(block, 'name'), block, result))
      if (fileMutations.length > 0 && fileMutations.every((result): result is FileMutationResult => result !== null)) {
        for (const [index, result] of results.entries()) detachedResults.set(result.id, fileMutations[index]!)
        return []
      }
      for (const result of results) consumedResults.add(result.id)
      const item: TimelineToolCallRenderItem = {
        type: 'tool-call',
        toolUse: block,
        results,
        toolUseId: block.toolUseId,
        ...(latestAskUserQuestion.get(block.toolUseId) === blockIndex ? { acceptsQuestionInput: true } : {}),
      }
      item.activityEvidence = activityEvidence(item)
      return [item]
    }
    if (isToolCallResultBlock(block) && block.toolUseId) {
      const fileMutation = detachedResults.get(block.id)
      if (fileMutation) return [{ type: 'block', block, fileMutation }]
      if (consumedResults.has(block.id) || matchedToolUseIds.has(block.toolUseId)) return []
      consumedResults.add(block.id)
      return [{ type: 'tool-call', toolUse: null, results: [block], toolUseId: block.toolUseId, activityEvidence: null }]
    }
    return [{ type: 'block', block }]
  })
  return groupAdjacentActivityItems(items, activeToolCalls, fallbackEndedAtMs)
}

export function toolDataField(block: TimelineBlock | null, key: string): unknown {
  return block && isRecord(block.data) ? block.data[key] : undefined
}

export function toolDataString(block: TimelineBlock | null, key: string): string | null {
  const value = toolDataField(block, key)
  return typeof value === 'string' && value ? value : null
}

function toolInputString(block: TimelineBlock | null, key: string): string | null {
  const input = toolDataField(block, 'input')
  if (!isRecord(input)) return null
  const value = input[key]
  return typeof value === 'string' && value ? value : null
}

type ActivityEvidence = BashActivityEvidence & { codegraphCount: number }

const emptyActivityEvidence = (): ActivityEvidence => ({ searchCount: 0, readTargets: [], listTargets: [], inspectionCount: 0, codegraphCount: 0 })

function activityTarget(cwd: string | null, path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || Boolean(cwd && /^[A-Za-z]:[\\/]/.test(cwd))
  const value = windows ? path.replaceAll('\\', '/') : path
  const base = windows ? (cwd?.replaceAll('\\', '/') ?? '') : (cwd ?? '')
  const absolute = value.startsWith('/') || /^[A-Za-z]:\//.test(value)
  const joined = absolute || !base ? value : `${base.replace(/\/$/, '')}/${value}`
  const prefix = joined.startsWith('/') ? '/' : (joined.match(/^[A-Za-z]:\//)?.[0] ?? '')
  const rest = prefix ? joined.slice(prefix.length) : joined
  const segments = rest.split('/').filter((segment) => segment && segment !== '.')
  return `${prefix}${segments.join('/')}` || prefix || '.'
}

function bashActivityEvidence(item: TimelineToolCallRenderItem): ActivityEvidence | null {
  const input = toolDataField(item.toolUse, 'input')
  if (!isRecord(input) || typeof input.command !== 'string' || !input.command) return null
  for (const key of ['run_in_background', 'dangerouslyDisableSandbox']) {
    if (input[key] !== undefined && input[key] !== false) return null
  }
  const evidence = classifyBashActivity(input.command)
  if (!evidence) return null
  const cwd = toolDataString(item.toolUse, 'cwd')
  return {
    ...evidence,
    readTargets: evidence.readTargets.map((path) => activityTarget(cwd, path)),
    listTargets: evidence.listTargets.map((path) => activityTarget(cwd, path)),
    codegraphCount: 0,
  }
}

function activityEvidence(item: TimelineToolCallRenderItem): ActivityEvidence | null {
  if (item.activityEvidence !== undefined) return item.activityEvidence
  const name = toolDataString(item.toolUse, 'name')
  if (name === 'Glob' || name === 'Grep') return { ...emptyActivityEvidence(), searchCount: 1 }
  if (name === 'mcp__codegraph__codegraph_explore') return { ...emptyActivityEvidence(), codegraphCount: 1 }
  if (name === 'Bash') return bashActivityEvidence(item)
  if (name !== 'Read') return null

  const resultFile = item.results
    .flatMap((result) => {
      if (toolResultIsError(result) || !isRecord(result.data) || !isRecord(result.data.toolUseResult) || !isRecord(result.data.toolUseResult.file)) return []
      const filePath = result.data.toolUseResult.file.filePath
      return typeof filePath === 'string' && filePath ? [{ filePath, cwd: typeof result.data.cwd === 'string' ? result.data.cwd : null }] : []
    })
    .at(0)
  const inputFilePath = toolInputString(item.toolUse, 'file_path')
  const evidence = emptyActivityEvidence()
  if (inputFilePath) evidence.readTargets.push(activityTarget(toolDataString(item.toolUse, 'cwd'), inputFilePath))
  else if (resultFile) evidence.readTargets.push(activityTarget(resultFile.cwd, resultFile.filePath))
  return evidence
}

export function isActivityGroupItem(item: TimelineRenderItem): item is TimelineActivityGroupItem {
  if (item.type === 'block') return item.block.kind === 'assistant.thinking'
  return item.type === 'tool-call' && item.toolUse !== null && activityEvidence(item) !== null
}

export function thinkingDurationMs(block: TimelineBlock): number | null {
  if (block.kind !== 'assistant.thinking' || !isRecord(block.data)) return null
  const value = block.data.durationMs
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function timelineBlockTimestampMs(block: TimelineBlock): number | null {
  if (!isRecord(block.data)) return null
  const value = block.data.timelineTimestampMs
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatThinkingDuration(durationMs: number): string {
  return formatTurnDuration(Math.max(1000, durationMs))
}

export function thinkingBlockTitle(block: TimelineBlock, nowMs = Date.now()): string {
  const streaming = isRecord(block.data) && block.data.streaming === true
  const durationMs = thinkingDurationMs(block)
  if (streaming) {
    const startedAtMs = isRecord(block.data) && typeof block.data.streamingStartedAtMs === 'number' ? block.data.streamingStartedAtMs : timelineBlockTimestampMs(block)
    const elapsedMs = startedAtMs !== null && nowMs >= startedAtMs ? nowMs - startedAtMs : 0
    const totalMs = (durationMs ?? 0) + elapsedMs
    return totalMs > 0 ? `Thinking for ${formatThinkingDuration(totalMs)}` : 'Thinking…'
  }
  return durationMs !== null && durationMs > 0 ? `Thought for ${formatThinkingDuration(durationMs)}` : 'Thought'
}

export function timelineRenderItemTimestampMs(item: TimelineActivityGroupItem): number | null {
  const block = item.type === 'block' ? item.block : (item.toolUse ?? item.results[0])
  return block ? timelineBlockTimestampMs(block) : null
}

export function timelineRenderItemLastTimestampMs(item: TimelineActivityGroupItem): number | null {
  const blocks = timelineRenderItemBlocks(item)
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const value = timelineBlockTimestampMs(blocks[index]!)
    if (value !== null) return value
  }
  return null
}

export function timelineRenderItemIsActive(item: TimelineActivityGroupItem): boolean {
  return item.type === 'tool-call'
    ? !item.results.some((result) => result.kind === 'tool.result')
    : item.block.kind === 'assistant.thinking' && isRecord(item.block.data) && item.block.data.streaming === true
}

export function toolResultIsError(block: TimelineBlock): boolean {
  if (!isRecord(block.data)) return false
  return block.data.is_error === true || block.data.is_err === true
}

function structuredPatchHunks(value: unknown): StructuredPatchHunk[] | null {
  if (!Array.isArray(value)) return null
  const hunks = value.filter(
    (hunk): hunk is StructuredPatchHunk =>
      isRecord(hunk) &&
      typeof hunk.oldStart === 'number' &&
      typeof hunk.oldLines === 'number' &&
      typeof hunk.newStart === 'number' &&
      typeof hunk.newLines === 'number' &&
      Array.isArray(hunk.lines) &&
      hunk.lines.every((line) => typeof line === 'string'),
  )
  return hunks.length === value.length ? hunks : null
}

export function fileMutationResult(toolName: string | null, toolUse: TimelineBlock | null, block: TimelineBlock): FileMutationResult | null {
  if ((toolName !== 'Edit' && toolName !== 'Write') || block.kind !== 'tool.result' || toolResultIsError(block) || !isRecord(block.data) || !isRecord(block.data.toolUseResult)) return null
  const output = block.data.toolUseResult
  const filePath = toolInputString(toolUse, 'file_path')
  if (!filePath) return null

  const cwd = toolDataString(toolUse, 'cwd') ?? undefined
  if (toolName === 'Edit') {
    const hunks = structuredPatchHunks(output.structuredPatch)
    return hunks && hunks.length > 0 ? { type: 'update', filePath, cwd, hunks } : null
  }

  if (output.type === 'create') return typeof output.content === 'string' ? { type: 'create', filePath, cwd, content: output.content, hunks: structuredPatchHunks(output.structuredPatch) ?? [] } : null

  const hunks = structuredPatchHunks(output.structuredPatch)
  return hunks && hunks.length > 0 ? { type: 'overwrite', filePath, cwd, hunks } : null
}

export function toolResultValue(block: TimelineBlock): unknown {
  if (!isRecord(block.data)) return block.data
  return block.data.content ?? block.data.result ?? block.data.output ?? block.data
}

export function thinkingValue(block: TimelineBlock): unknown {
  if (!isRecord(block.data)) return block.data
  return block.data.thinking ?? block.data.text ?? block.data.content ?? block.data
}

export function activityGroupSummary(item: TimelineActivityGroupRenderItem, nowMs = Date.now()): string {
  const parts: string[] = []
  let active = item.active
  if (item.hasThinking) {
    const thinkingBlocks = item.items.flatMap(timelineRenderItemBlocks).filter((block) => block.kind === 'assistant.thinking')
    const completedMs = thinkingBlocks.reduce((total, block) => total + (thinkingDurationMs(block) ?? 0), 0)
    const streamingBlock = thinkingBlocks.find((block) => isRecord(block.data) && block.data.streaming === true)
    active ||= Boolean(streamingBlock)
    const streamingStartedAtMs =
      streamingBlock && isRecord(streamingBlock.data) && typeof streamingBlock.data.streamingStartedAtMs === 'number'
        ? streamingBlock.data.streamingStartedAtMs
        : streamingBlock
          ? timelineBlockTimestampMs(streamingBlock)
          : null
    const streamingMs = streamingStartedAtMs !== null && nowMs >= streamingStartedAtMs ? nowMs - streamingStartedAtMs : 0
    const durationMs = completedMs + streamingMs
    parts.push(durationMs > 0 ? `${active ? 'thinking' : 'thought'} for ${formatThinkingDuration(durationMs)}` : active ? 'thinking' : 'thought')
  }

  const readTargets = new Set<string>()
  const listTargets = new Set<string>()
  let searchCount = 0
  let inspectionCount = 0
  let codegraphCount = 0
  let errorCount = 0
  for (const child of item.items) {
    if (child.type !== 'tool-call') continue
    if (child.results.some(toolResultIsError)) errorCount += 1
    const evidence = activityEvidence(child)
    if (!evidence) continue
    searchCount += evidence.searchCount
    inspectionCount += evidence.inspectionCount
    codegraphCount += evidence.codegraphCount
    for (const target of evidence.readTargets) readTargets.add(target)
    for (const target of evidence.listTargets) listTargets.add(target)
  }

  if (searchCount > 0) parts.push(`${active ? 'searching' : 'searched'} for ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`)
  const readCount = readTargets.size
  if (readCount > 0) parts.push(`${active ? 'reading' : 'read'} ${readCount} ${readCount === 1 ? 'file' : 'files'}`)
  if (listTargets.size > 0) parts.push(`${active ? 'listing' : 'listed'} ${listTargets.size} ${listTargets.size === 1 ? 'directory' : 'directories'}`)
  if (inspectionCount > 0) parts.push(`${active ? 'inspecting' : 'inspected'} context with ${inspectionCount} ${inspectionCount === 1 ? 'command' : 'commands'}`)
  if (codegraphCount > 0) parts.push(`${active ? 'calling' : 'called'} MCP Codegraph${codegraphCount > 1 ? ` ${codegraphCount} times` : ''}`)
  if (errorCount > 0) parts.push(`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`)
  const summary = parts.join(', ') || `${item.items.length} activity steps`
  return summary[0]!.toUpperCase() + summary.slice(1)
}

export function taskNotificationData(raw: Record<string, unknown>, parsed = parseTimelineTaskNotification(raw)): Record<string, unknown> {
  if (parsed?.kind === 'valid') return { ...parsed.notification, raw: raw.message }
  return { text: isRecord(raw.message) && typeof raw.message.content === 'string' ? raw.message.content.trim() : '', invalid: true, raw: raw.message }
}

export type TimelineTurnIndex = { primaryUserUuids: Set<string>; messageIds: Set<string> }
export type ProjectedTimelineTurn = TurnSummary & { blocks: TimelineBlock[] }

export type LiveAssistantBlockDraft = {
  id: string
  kind: string
  data: Record<string, unknown>
  sourceEventIds: string[]
  partialJson?: string
  finalized?: boolean
}

export type LiveAssistantMessageDraft = {
  ordinal: number
  apiMessageId?: string
  blocks: Map<number, LiveAssistantBlockDraft>
  openThinkingIndex?: number
  invalid?: boolean
}

export class LiveAssistantStreamAccumulator {
  private nextAssistantOrdinal = 0
  private current: LiveAssistantMessageDraft | null = null
  private readonly byApiMessageId = new Map<string, LiveAssistantMessageDraft>()

  constructor(private readonly userMessageUuid: string) {}

  processStreamEvent(message: Record<string, unknown>): TimelineBlock[] {
    if (!isRecord(message.event)) return []
    const event = message.event
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    const sourceEventId = sdkMessageUuid(message)
    const timestampMs = rawMessageTimestampMs(message)
    if (eventType === 'message_start') {
      const apiMessageId = isRecord(event.message) && typeof event.message.id === 'string' ? event.message.id : undefined
      const abandoned = this.current && (!apiMessageId || this.current.apiMessageId !== apiMessageId) ? this.abandonOpenThinking(this.current) : null
      const existing = apiMessageId ? this.byApiMessageId.get(apiMessageId) : undefined
      this.current = existing ?? this.createDraft(apiMessageId, !apiMessageId)
      return abandoned ?? []
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0
      const contentBlock = isRecord(event.content_block) ? event.content_block : { type: 'unknown_block' }
      const blockType = typeof contentBlock.type === 'string' ? contentBlock.type : 'unknown_block'
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId || draft.blocks.get(index)?.finalized) return []
      const closed = this.closeOpenThinking(draft, timestampMs) ?? this.abandonOpenThinking(draft)
      const block = this.ensureBlock(draft, index, blockType, contentBlock)
      addUnique(block.sourceEventIds, sourceEventId)
      block.data = { ...contentBlock, streaming: true }
      this.setBlockTimestamp(block, timestampMs)
      if (block.kind === 'assistant.thinking') draft.openThinkingIndex = index
      const next = this.snapshot(block, draft.apiMessageId)
      return closed ? [...closed, ...next] : next
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = isRecord(event.delta) ? event.delta : { type: 'unknown_delta' }
      const deltaType = typeof delta.type === 'string' ? delta.type : 'unknown_delta'
      const draft = this.ensureCurrent()
      if (draft.invalid || !sourceEventId) return []
      const block = draft.blocks.get(index)
      if (!block && deltaType === 'input_json_delta') return []
      const target = block ?? this.ensureBlock(draft, index, blockTypeForDelta(deltaType), { type: blockTypeForDelta(deltaType) })
      if (target.finalized) return []
      addUnique(target.sourceEventIds, sourceEventId)
      this.applyDelta(target, deltaType, delta)
      target.data.streaming = true
      this.setBlockTimestamp(target, timestampMs)
      return this.snapshot(target, draft.apiMessageId)
    }

    if (eventType === 'content_block_stop') {
      const draft = this.ensureCurrent()
      const index = typeof event.index === 'number' ? event.index : 0
      const block = draft.blocks.get(index)
      if (!block || block.finalized) return []
      if (sourceEventId) addUnique(block.sourceEventIds, sourceEventId)
      this.setBlockTimestamp(block, timestampMs)
      if (draft.openThinkingIndex === index) return this.snapshot(block, draft.apiMessageId)
      delete block.data.streaming
      this.parsePartialJson(block)
      return this.snapshot(block, draft.apiMessageId)
    }

    if (eventType === 'message_stop') {
      const draft = this.current
      if (!draft) return []
      return [...draft.blocks.entries()].flatMap(([index, block]) => {
        if (block.finalized) return []
        this.setBlockTimestamp(block, timestampMs)
        if (draft.openThinkingIndex !== index) delete block.data.streaming
        return this.snapshot(block, draft.apiMessageId)
      })
    }
    return []
  }

  finalAssistantBlocks(message: Record<string, unknown>): TimelineBlock[] {
    const uuid = sdkMessageUuid(message)
    const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
    if (!uuid || !apiMessageId) return []
    const abandoned = this.current && this.current.apiMessageId !== apiMessageId ? (this.abandonOpenThinking(this.current) ?? []) : []
    const draft = this.findDraft(apiMessageId)
    const incoming = assistantBlocksFromMessage(message, uuid, apiMessageId, `${this.userMessageUuid}:assistant:${draft.ordinal}`)
    const reserved = new Set<LiveAssistantBlockDraft>()
    const targets = incoming.map((block, index) => {
      const target = this.finalizationTarget(draft, block, reserved, incoming.length > 1 ? index : undefined)
      if (target) reserved.add(target)
      return target
    })
    const openThinking = draft.openThinkingIndex === undefined ? null : draft.blocks.get(draft.openThinkingIndex)
    const finalizesOpenThinking = incoming.some((block, index) => block.kind === 'assistant.thinking' && targets[index] === openThinking)
    const closed = finalizesOpenThinking ? [] : (this.closeOpenThinking(draft, rawMessageTimestampMs(message)) ?? [])
    const finalized = incoming.map((block, index) => this.finalizeBlock(draft, block, targets[index]))
    return [...abandoned, ...closed, ...finalized]
  }

  abandonCurrentThinking(): TimelineBlock[] {
    return this.current ? (this.abandonOpenThinking(this.current) ?? []) : []
  }

  private createDraft(apiMessageId?: string, invalid = false): LiveAssistantMessageDraft {
    const draft: LiveAssistantMessageDraft = { ordinal: this.nextAssistantOrdinal++, apiMessageId, blocks: new Map<number, LiveAssistantBlockDraft>(), ...(invalid ? { invalid } : {}) }
    if (apiMessageId) this.byApiMessageId.set(apiMessageId, draft)
    return draft
  }

  private ensureCurrent(): LiveAssistantMessageDraft {
    if (!this.current) this.current = this.createDraft(undefined, true)
    return this.current
  }

  private findDraft(apiMessageId: string): LiveAssistantMessageDraft {
    return this.byApiMessageId.get(apiMessageId) ?? this.createDraft(apiMessageId)
  }

  private ensureBlock(draft: LiveAssistantMessageDraft, index: number, blockType: string, data: Record<string, unknown>): LiveAssistantBlockDraft {
    return draft.blocks.get(index) ?? this.createBlock(draft, index, blockType, data)
  }

  private createBlock(draft: LiveAssistantMessageDraft, index: number, blockType: string, data: Record<string, unknown>): LiveAssistantBlockDraft {
    const block = { id: `${this.userMessageUuid}:assistant:${draft.ordinal}:${index}`, kind: `assistant.${blockType}`, data: { ...data }, sourceEventIds: [] }
    draft.blocks.set(index, block)
    return block
  }

  private nextBlockIndex(draft: LiveAssistantMessageDraft): number {
    return Math.max(-1, ...draft.blocks.keys()) + 1
  }

  private finalizationTarget(draft: LiveAssistantMessageDraft, block: TimelineBlock, reserved: ReadonlySet<LiveAssistantBlockDraft>, contentIndex?: number): LiveAssistantBlockDraft | undefined {
    const candidates = [...draft.blocks.values()].filter((item) => !reserved.has(item))
    const indexed = contentIndex === undefined ? undefined : draft.blocks.get(contentIndex)
    const compatibleIndexed = indexed && !reserved.has(indexed) && !indexed.finalized && indexed.kind === block.kind ? indexed : undefined
    if (block.kind === 'assistant.tool_use') {
      const byToolUseId = block.toolUseId ? candidates.find((item) => item.kind === 'assistant.tool_use' && item.data.id === block.toolUseId) : undefined
      return byToolUseId ?? compatibleIndexed ?? candidates.find((item) => !item.finalized && item.kind === 'assistant.tool_use' && typeof item.data.id !== 'string')
    }
    return compatibleIndexed ?? candidates.find((item) => !item.finalized && item.kind === block.kind)
  }

  private finalizeBlock(draft: LiveAssistantMessageDraft, block: TimelineBlock, target?: LiveAssistantBlockDraft): TimelineBlock {
    const draftBlock = target ?? this.createBlock(draft, this.nextBlockIndex(draft), block.kind.replace(/^assistant\./, ''), isRecord(block.data) ? block.data : {})
    const timelineTimestampMs = timelineBlockTimestampMs(draftBlock)
    const durationMs = thinkingDurationMs(draftBlock)
    const streaming = draftBlock.data.streaming === true
    draftBlock.sourceEventIds = [...block.sourceEventIds]
    draftBlock.data = {
      ...(isRecord(block.data) ? block.data : {}),
      ...(block.kind === 'assistant.thinking' && timelineTimestampMs !== null ? { timelineTimestampMs } : {}),
      ...(block.kind === 'assistant.thinking' && streaming ? { streaming: true } : {}),
      ...(block.kind === 'assistant.thinking' && durationMs !== null ? { durationMs } : {}),
    }
    draftBlock.finalized = true
    return this.snapshotBlock(draftBlock, draft.apiMessageId)
  }

  private closeOpenThinking(draft: LiveAssistantMessageDraft, timestampMs: number | null): TimelineBlock[] | null {
    const index = draft.openThinkingIndex
    if (index === undefined) return null
    const block = draft.blocks.get(index)
    const startMs = block ? timelineBlockTimestampMs({ id: block.id, kind: block.kind, sourceEventIds: block.sourceEventIds, data: block.data }) : null
    if (!block || timestampMs === null || startMs === null || timestampMs < startMs) return this.abandonOpenThinking(draft)
    delete draft.openThinkingIndex
    block.data.durationMs = timestampMs - startMs
    delete block.data.streaming
    return this.snapshot(block, draft.apiMessageId)
  }

  private abandonOpenThinking(draft: LiveAssistantMessageDraft): TimelineBlock[] | null {
    const index = draft.openThinkingIndex
    if (index === undefined) return null
    delete draft.openThinkingIndex
    const block = draft.blocks.get(index)
    if (!block) return null
    delete block.data.streaming
    return this.snapshot(block, draft.apiMessageId)
  }

  private setBlockTimestamp(block: LiveAssistantBlockDraft, timestampMs: number | null): void {
    if (timestampMs !== null && timelineBlockTimestampMs({ id: block.id, kind: block.kind, sourceEventIds: block.sourceEventIds, data: block.data }) === null)
      block.data.timelineTimestampMs = timestampMs
  }

  private applyDelta(block: LiveAssistantBlockDraft, deltaType: string, delta: Record<string, unknown>): void {
    if (deltaType === 'text_delta' && typeof delta.text === 'string') block.data.text = `${typeof block.data.text === 'string' ? block.data.text : ''}${delta.text}`
    else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') block.data.thinking = `${typeof block.data.thinking === 'string' ? block.data.thinking : ''}${delta.thinking}`
    else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.partialJson = `${block.partialJson ?? ''}${delta.partial_json}`
      block.data.partial_json = block.partialJson
      this.parsePartialJson(block)
    } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string')
      block.data.signature = `${typeof block.data.signature === 'string' ? block.data.signature : ''}${delta.signature}`
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
    return [this.snapshotBlock(block, apiMessageId)]
  }

  private snapshotBlock(block: LiveAssistantBlockDraft, apiMessageId?: string): TimelineBlock {
    return {
      id: block.id,
      kind: block.kind,
      sourceEventIds: block.sourceEventIds,
      ...(apiMessageId ? { apiMessageId } : {}),
      ...(block.kind === 'assistant.tool_use' && typeof block.data.id === 'string' ? { contentBlockId: block.data.id, toolUseId: block.data.id } : {}),
      data: { ...block.data },
    }
  }
}

export function blockTypeForDelta(deltaType: string): string {
  if (deltaType === 'text_delta' || deltaType === 'citations_delta') return 'text'
  if (deltaType === 'thinking_delta' || deltaType === 'signature_delta') return 'thinking'
  if (deltaType === 'input_json_delta') return 'tool_use'
  if (deltaType === 'compaction_delta') return 'compaction'
  return 'unknown_block'
}

export function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

export function sdkMessageUuid(message: Record<string, unknown>): string | undefined {
  return typeof message.uuid === 'string' ? message.uuid : undefined
}

export function sdkMessageContent(message: Record<string, unknown>): unknown {
  return isRecord(message.message) ? message.message.content : undefined
}

export function toolUseMetadata(message: Record<string, unknown>, block: unknown): Pick<TimelineBlock, 'contentBlockId' | 'toolUseId'> {
  if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') return { contentBlockId: block.id, toolUseId: block.id }
  const toolUseId = timelineToolUseId(message, block)
  return toolUseId ? { toolUseId } : {}
}

function toolUseData(message: Record<string, unknown>, block: unknown): unknown {
  return isRecord(block) && typeof message.cwd === 'string' ? { ...block, cwd: message.cwd } : block
}

export function withTimelineTimestamp(message: Record<string, unknown>, data: unknown): unknown {
  const timestampMs = rawMessageTimestampMs(message)
  if (timestampMs === null) return data
  return isRecord(data) ? { ...data, timelineTimestampMs: timestampMs } : data
}

export function assistantBlocksFromMessage(message: Record<string, unknown>, uuid: string, apiMessageId: string, idPrefix = `${uuid}:assistant`): TimelineBlock[] {
  const content = sdkMessageContent(message)
  if (!Array.isArray(content))
    return [
      {
        id: idPrefix,
        kind: 'assistant.message',
        sourceEventIds: [uuid],
        apiMessageId,
        data: withTimelineTimestamp(message, { ...(isRecord(message.message) ? message.message : message), originalContentBlockIndex: 0 }),
      },
    ]
  return content.map((block, index): TimelineBlock => {
    const blockType = isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown_block'
    const data = toolUseData(message, block)
    return {
      id: `${idPrefix}:${index}`,
      kind: `assistant.${blockType}`,
      sourceEventIds: [uuid],
      apiMessageId,
      ...toolUseMetadata(message, block),
      data: withTimelineTimestamp(message, { ...(isRecord(data) ? data : {}), originalContentBlockIndex: index }),
    }
  })
}

export function primaryInputData(primary: boolean, data: unknown): unknown {
  if (!primary) return data
  return isRecord(data) ? { ...data, primaryTimelineUserMessage: true } : data
}

type LocalCommandFeedback = { uuid: string; kind: 'stdout' | 'stderr'; text: string }

function localCommandBlock(message: Record<string, unknown>, uuid: string, feedback: LocalCommandFeedback[] = [], command = timelineLocalCommand(message)): TimelineBlock | null {
  const interrupt = timelineInterruptMarker(message)
  if (!interrupt && !command) return null
  const { commandName, commandArgs } = command ?? {}
  const commandText = commandArgs ? `${commandName} ${commandArgs}` : commandName
  const text = feedback
    .map(timelineLocalCommandFeedbackSummary)
    .filter((text): text is string => text !== null)
    .join(' · ')
  return {
    id: `${uuid}:local_command`,
    kind: 'user.local_command',
    sourceEventIds: [uuid, ...feedback.map(({ uuid: feedbackUuid }) => feedbackUuid)],
    data: {
      primaryTimelineUserMessage: true,
      ...(commandName ? { commandName } : {}),
      ...(commandArgs ? { commandArgs } : {}),
      ...(feedback.some(timelineLocalCommandFeedbackIsError) ? { localCommandError: true } : {}),
      text: interrupt?.text ?? (text ? `${commandText} (${text})` : commandText),
    },
  }
}

function sourceToolUseId(message: Record<string, unknown>): string | undefined {
  return typeof message.sourceToolUseID === 'string' ? message.sourceToolUseID : undefined
}

function skillMetaBlock(message: Record<string, unknown>, uuid: string): TimelineBlock | null {
  const toolUseId = sourceToolUseId(message)
  const text = textFromData({ content: sdkMessageContent(message) })
  return toolUseId && text ? { id: `${uuid}:skill_meta`, kind: 'skill.meta', sourceEventIds: [uuid], toolUseId, data: withTimelineTimestamp(message, { text, raw: message }) } : null
}

export function userBlocksFromMessage(message: Record<string, unknown>, uuid: string, primary = false): TimelineBlock[] {
  const content = sdkMessageContent(message)
  const toolUseResult = timelineToolUseResult(message)
  if (Array.isArray(content)) {
    return content.flatMap((block, index): TimelineBlock[] => {
      if (!isRecord(block)) return []
      if (block.type === 'tool_result')
        return [
          {
            id: `${uuid}:tool_result:${index}`,
            kind: 'tool.result',
            sourceEventIds: [uuid],
            ...toolUseMetadata(message, block),
            data: withTimelineTimestamp(message, {
              ...block,
              ...(typeof message.cwd === 'string' ? { cwd: message.cwd } : {}),
              ...(typeof message.toolDenialKind === 'string' ? { toolDenialKind: message.toolDenialKind } : {}),
              ...(toolUseResult === undefined ? {} : { toolUseResult }),
            }),
          },
        ]
      if (block.type === 'text')
        return [
          {
            id: `${uuid}:user:${index}`,
            kind: 'user.message',
            sourceEventIds: [uuid],
            data: primaryInputData(primary, { ...block, status: 'confirmed', raw: block, originalContentBlockIndex: index }),
          },
        ]
      const kind =
        block.type === 'image' || block.type === 'document' || block.type === 'file' || block.type === 'search_result' || block.type === 'tool_reference' ? `user.${block.type}` : 'user.content'
      return [{ id: `${uuid}:${block.type}:${index}`, kind, sourceEventIds: [uuid], data: primaryInputData(primary, { ...block, originalContentBlockIndex: index }) }]
    })
  }
  const text = textFromData({ content })
  return text
    ? [
        {
          id: `${uuid}:user`,
          kind: 'user.message',
          sourceEventIds: [uuid],
          data: primaryInputData(primary, { text, status: 'confirmed', raw: isRecord(message.message) ? message.message : null, originalContentBlockIndex: 0 }),
        },
      ]
    : []
}

export const isPrimaryUserMessage = isPrimaryTimelineUserMessage

export function isTerminalLiveEvent(value: unknown): boolean {
  return isRecord(value) && (value.type === 'result' || value.type === 'cotta_live_turn_failed')
}

export function resultFailureMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (value.type === 'cotta_live_turn_failed') return typeof value.error === 'string' ? value.error : 'Turn failed'
  if (value.type !== 'result') return null
  const failed = value.is_error === true || (typeof value.subtype === 'string' && (value.subtype === 'failed' || value.subtype.startsWith('error')))
  if (!failed) return null
  return Array.isArray(value.errors) && typeof value.errors[0] === 'string' ? value.errors[0] : 'Turn failed'
}

export function messageIdentity(message: unknown): string | null {
  if (!isRecord(message)) return null
  const uuid = sdkMessageUuid(message)
  return uuid ? `uuid:${uuid}` : null
}

function mergeMessageVariantValue(previous: unknown, next: unknown, key?: string): unknown {
  if ((key === 'is_error' || key === 'is_err') && (previous === true || next === true)) return true
  if (next === undefined || next === null || next === '' || (Array.isArray(next) && next.length === 0)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) return previous.length === next.length ? next.map((value, index) => mergeMessageVariantValue(previous[index], value)) : next
  if (isRecord(previous) && isRecord(next)) {
    const merged: Record<string, unknown> = { ...previous }
    for (const [field, value] of Object.entries(next)) merged[field] = mergeMessageVariantValue(previous[field], value, field)
    return merged
  }
  return next
}

export function mergeMessageVariants(previous: unknown, next: unknown): unknown {
  return isRecord(previous) && isRecord(next) ? mergeMessageVariantValue(previous, next) : next
}

function canonicalTimelineMessages(messages: unknown[]): unknown[] {
  const canonical: unknown[] = []
  const positions = new Map<string, number>()
  for (const message of messages) {
    const identity = messageIdentity(message)
    if (!identity) {
      canonical.push(message)
      continue
    }
    const position = positions.get(identity)
    if (position === undefined) {
      positions.set(identity, canonical.length)
      canonical.push(message)
    } else {
      canonical[position] = mergeMessageVariants(canonical[position], message)
    }
  }
  return canonical
}

export function timelineTurnIndex(turns: TurnSummary[]): TimelineTurnIndex {
  const primaryUserUuids = new Set<string>()
  const messageIds = new Set<string>()
  for (const turn of turns) {
    primaryUserUuids.add(turn.primaryUserUuid)
    for (const message of turn.messages) {
      const id = messageIdentity(message)
      if (id) messageIds.add(id)
    }
  }
  return { primaryUserUuids, messageIds }
}

export function messageIsRepresentedBy(message: unknown, index: TimelineTurnIndex): boolean {
  const id = messageIdentity(message)
  return Boolean(id && index.messageIds.has(id))
}

export function timelineBlockHasTranscriptEvidence(block: TimelineBlock, index: TimelineTurnIndex): boolean {
  return block.sourceEventIds.length > 0 && block.sourceEventIds.every((id) => index.messageIds.has(`uuid:${id}`))
}

export function clearOptimisticOverlaySources(sources: Map<string, OverlayMessageSource>, messageIds?: ReadonlySet<string>): void {
  for (const [id, source] of sources) if (source === 'OPTIMISTIC' && (!messageIds || messageIds.has(id))) sources.delete(id)
}

export function primaryMessageSource(block: TimelineBlock, index: TimelineTurnIndex, overlaySources: ReadonlyMap<string, OverlayMessageSource>): PrimaryMessageSource | null {
  if (timelineBlockHasTranscriptEvidence(block, index)) return 'TRANSCRIPT'
  let source: OverlayMessageSource | null = null
  for (const id of block.sourceEventIds) {
    const candidate = overlaySources.get(`uuid:${id}`)
    if (candidate === 'LIVE') return candidate
    if (candidate === 'OPTIMISTIC') source = candidate
  }
  return source
}

export function assistantFrameSource(blocks: TimelineBlock[], index: TimelineTurnIndex, overlaySources: ReadonlyMap<string, OverlayMessageSource>, reconciling: boolean): ResponseSource | null {
  const visible = blocks.filter((block) => block.kind !== 'assistant.thinking' || Boolean(thinkingValue(block)))
  if (visible.length === 0) return null
  if (visible.every((block) => timelineBlockHasTranscriptEvidence(block, index))) return 'TRANSCRIPT'
  const live = visible.some((block) => block.sourceEventIds.some((id) => overlaySources.get(`uuid:${id}`) === 'LIVE'))
  return live ? (reconciling ? 'RECONCILING' : 'LIVE') : null
}

export function turnIsRepresentedBy(turn: TurnSummary, index: TimelineTurnIndex): boolean {
  return index.primaryUserUuids.has(turn.primaryUserUuid) || index.messageIds.has(`uuid:${turn.primaryUserUuid}`)
}

export function turnOrderValue(turn: TurnSummary): number | null {
  return turn.primaryUserTimestampMs ?? null
}

function primaryInputFirst(blocks: TimelineBlock[]): TimelineBlock[] {
  const index = blocks.findIndex(isPrimaryInputBlock)
  return index > 0 ? [...blocks.filter(isPrimaryInputBlock), ...blocks.filter((block) => !isPrimaryInputBlock(block))] : blocks
}

function assistantThinkingDurations(messages: unknown[]): Map<string, number> {
  const durations = new Map<string, number>()
  let pending: { uuid: string; apiMessageId: string; timestampMs: number } | null = null
  for (const message of messages) {
    if (!isRecord(message) || message.type !== 'assistant') continue
    const uuid = sdkMessageUuid(message)
    const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
    const timestampMs = rawMessageTimestampMs(message)
    if (pending) {
      if (apiMessageId === pending.apiMessageId && timestampMs !== null && timestampMs >= pending.timestampMs) durations.set(pending.uuid, timestampMs - pending.timestampMs)
      pending = null
    }
    const content = sdkMessageContent(message)
    if (uuid && apiMessageId && timestampMs !== null && Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'thinking')) pending = { uuid, apiMessageId, timestampMs }
  }
  return durations
}

function replaceTimelineBlocks(blocks: TimelineBlock[], replacements: TimelineBlock[]): TimelineBlock[] {
  if (replacements.length === 0) return blocks
  const ids = new Set(replacements.map((block) => block.id))
  const insertionAt = blocks.findIndex((block) => ids.has(block.id))
  const retained = blocks.filter((block) => !ids.has(block.id))
  const index = insertionAt < 0 ? retained.length : insertionAt
  return [...retained.slice(0, index), ...replacements, ...retained.slice(index)]
}

function localCommandFeedbacks(messages: unknown[], commandUuid: string): LocalCommandFeedback[] {
  return messages.flatMap((message) => {
    if (!isRecord(message) || message.parentUuid !== commandUuid) return []
    const feedback = timelineLocalCommandFeedback(message)
    const uuid = sdkMessageUuid(message)
    return feedback && uuid ? [{ uuid, ...feedback }] : []
  })
}

export function projectTimelineTurn(turn: TurnSummary): TimelineBlock[] {
  let blocks: TimelineBlock[] = []
  let accumulator: LiveAssistantStreamAccumulator | null = null
  const messages = canonicalTimelineMessages(turn.messages)
  const thinkingDurations = assistantThinkingDurations(messages)
  for (const message of messages) {
    if (!isRecord(message) || typeof message.type !== 'string') continue
    if (message.type === 'stream_event') {
      accumulator ??= new LiveAssistantStreamAccumulator(turn.primaryUserUuid)
      for (const block of accumulator.processStreamEvent(message)) blocks = upsertBlock(blocks, block)
      continue
    }
    if (message.type === 'assistant') {
      const uuid = sdkMessageUuid(message)
      const command = uuid ? timelineLocalCommand(message) : null
      if (uuid && command) {
        const block = localCommandBlock(message, uuid, localCommandFeedbacks(messages, uuid), command)
        if (block) blocks.push(block)
        continue
      }
      const apiMessageId = isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
      const finalized =
        accumulator !== null && uuid && apiMessageId
          ? accumulator.finalAssistantBlocks(message)
          : uuid && apiMessageId
            ? assistantBlocksFromMessage(message, uuid, apiMessageId)
            : [rawMessageBlock(message)]
      const durationMs = uuid ? thinkingDurations.get(uuid) : undefined
      if (uuid && durationMs !== undefined) {
        const thinking = finalized.find((block) => block.kind === 'assistant.thinking' && block.sourceEventIds.includes(uuid) && isRecord(block.data))
        if (thinking && isRecord(thinking.data) && thinkingDurationMs(thinking) === null) thinking.data = { ...thinking.data, durationMs, streaming: undefined }
      }
      blocks = replaceTimelineBlocks(blocks, finalized)
      continue
    }
    if (message.type === 'user') {
      const uuid = sdkMessageUuid(message)
      if (!uuid) continue
      const parsed = parseTimelineTaskNotification(message)
      const notification = parsed?.kind === 'invalid' || (parsed?.kind === 'valid' && (parsed.explicit || parsed.structuralFallback))
      if (message.isSynthetic === true && !notification) continue
      const primary = uuid === turn.primaryUserUuid
      const peerOrigin = !primary && isRecord(message.origin) && message.origin.kind === 'peer'
      if (peerOrigin) {
        const peerMessage = peerMessageBlock(message, uuid)
        if (peerMessage) blocks.push(peerMessage)
        continue
      }
      if (notification) {
        const data = taskNotificationData(message, parsed)
        const toolUseId = parsed?.kind === 'valid' ? parsed.notification.toolUseId : null
        if (toolUseId) {
          const original = blocks.find((block) => block.kind === 'assistant.tool_use' && block.toolUseId === toolUseId)
          if (original && isRecord(original.data)) data.originalToolUse = { id: toolUseId, name: original.data.name, input: original.data.input }
        }
        blocks.push({ id: `${uuid}:task_notification`, kind: 'assistant.task_notification', sourceEventIds: [uuid], data })
      } else if (!primary && message.isMeta === true) {
        const skillMeta = skillMetaBlock(message, uuid)
        if (skillMeta) blocks.push(skillMeta)
      } else if (primary) {
        const command = localCommandBlock(message, uuid, localCommandFeedbacks(messages, uuid))
        blocks.push(...(command ? [command] : userBlocksFromMessage(message, uuid, true)))
      } else {
        blocks.push(...userBlocksFromMessage(message, uuid).filter((block) => block.kind === 'tool.result'))
      }
      continue
    }
    if (message.type === 'system') {
      const uuid = sdkMessageUuid(message)
      const command = uuid ? timelineLocalCommand(message) : null
      const block = uuid && command ? localCommandBlock(message, uuid, localCommandFeedbacks(messages, uuid), command) : null
      if (block) blocks.push(block)
      continue
    }
    if (message.type === 'result' || message.type === 'cotta_live_turn_failed') {
      for (const block of accumulator?.abandonCurrentThinking() ?? []) blocks = upsertBlock(blocks, block)
    } else if (message.type !== 'system' && message.type !== 'command_lifecycle') blocks.push(rawMessageBlock(message))
  }
  return primaryInputFirst(blocks)
}

export type TurnPhase = 'submitting' | 'submitted' | 'rendering' | 'settled'
export type SubmitState = 'ready' | 'submitting' | 'stopping' | 'busy'
export type TurnFooterState = { kind: 'waiting' | 'duration'; label: string } | { kind: 'cooking'; label?: string } | null
type SessionControlSource = Pick<SessionSummary, 'occupiedBy'>

export function sessionExternallyOwned(session: SessionControlSource | null | undefined): boolean {
  return session?.occupiedBy === 'external'
}

export function turnPhase(input: { turn: TurnSummary; overlayActive: boolean; activeUserMessageUuid?: string | null; pendingPhase?: TurnPhase; assumeActive?: boolean }): TurnPhase {
  if (hasTerminalEvidence(input.turn)) return 'settled'
  if (input.pendingPhase === 'submitting') return 'submitting'
  if (!input.overlayActive && !input.assumeActive && input.activeUserMessageUuid !== input.turn.primaryUserUuid) return 'settled'
  return projectTimelineTurn(input.turn).some((block) => !isPrimaryInputBlock(block)) ? 'rendering' : 'submitted'
}

export function turnVisibleDataToken(turn: ProjectedTimelineTurn): string {
  return `${turn.primaryUserUuid}\0${turn.blocks.flatMap((block) => [block.id, ...block.sourceEventIds]).join('\0')}`
}

export function authoritativeTurnPhase(pending: TurnPhase | null, observed: TurnPhase | null): TurnPhase | null {
  return observed === 'rendering' || observed === 'settled' ? observed : (pending ?? observed)
}

export function submitStateFor(input: { submitting: boolean; stopping: boolean; latestPhase: TurnPhase | null }): SubmitState {
  if (input.submitting) return 'submitting'
  if (input.stopping) return 'stopping'
  return input.latestPhase === null || input.latestPhase === 'settled' ? 'ready' : 'busy'
}

export function turnFooterState(input: {
  turn: Pick<TurnSummary, 'primaryUserUuid' | 'durationMs' | 'entrypoint' | 'pendingBackgroundAgentCount'>
  phase: TurnPhase
  cooking: boolean
  activeLabel?: string
  primaryOnly?: boolean
  reconciling?: boolean
}): TurnFooterState {
  const pendingLabel = turnPendingAgentLabel(input.turn)
  if (pendingLabel) return { kind: 'waiting', label: pendingLabel }
  if (input.phase !== 'settled') return input.cooking ? { kind: 'cooking', label: input.activeLabel ?? turnCookingLabel(input.turn.primaryUserUuid) } : null
  if (input.primaryOnly) return null
  const durationLabel = turnDurationLabel(input.turn)
  if (durationLabel) return { kind: 'duration', label: durationLabel }
  if (input.reconciling) return { kind: 'cooking', label: input.activeLabel ?? turnCookingLabel(input.turn.primaryUserUuid) }
  return { kind: 'duration', label: stableTurnVerb(input.turn.primaryUserUuid) }
}

export function upsertBlock(blocks: TimelineBlock[], block: TimelineBlock): TimelineBlock[] {
  const index = blocks.findIndex((item) => item.id === block.id)
  if (index === -1) return [...blocks, block]
  const next = [...blocks]
  next[index] = block
  return next
}

export type PendingSubmissionResolution = { kind: 'visible'; turnUuid: string } | { kind: 'terminal-only' } | null

export function localCommandRoot(raw: unknown): { uuid: string; message: Record<string, unknown> } | null {
  return isRecord(raw) && (raw.type === 'system' || raw.type === 'assistant') && typeof raw.uuid === 'string' && timelineLocalCommand(raw) ? { uuid: raw.uuid, message: raw } : null
}

export function localCommandRootForSubmission(raw: unknown, submissionUuid: string): { uuid: string; message: Record<string, unknown> } | null {
  const root = localCommandRoot(raw)
  if (!root || root.message.type !== 'assistant') return null
  const linked = [root.message.user_message_uuid, ...(Array.isArray(root.message.user_message_uuids) ? root.message.user_message_uuids : [])]
  return linked.some((uuid) => uuid === submissionUuid) ? root : null
}

export function resolvePendingSubmission(page: SessionTimelineResponse, submissionUuid: string, allowTerminalOnly = false): PendingSubmissionResolution {
  if (page.turns.some((turn) => turn.primaryUserUuid === submissionUuid)) return { kind: 'visible', turnUuid: submissionUuid }
  const projection = page.runtimeTurnProjection
  if (!projection || projection.submissionUuid !== submissionUuid) return null
  if (projection.kind === 'terminal-only') return allowTerminalOnly ? { kind: 'terminal-only' } : null
  return page.turns.some((turn) => turn.primaryUserUuid === projection.visibleTurnUuid) ? { kind: 'visible', turnUuid: projection.visibleTurnUuid } : null
}

export type ApplySdkMessageResult = { turns: TurnSummary[]; currentUserMessageUuid: string | null; terminal: boolean }

const LIVE_TIMELINE_MESSAGE_TYPES = new Set(['user', 'assistant', 'stream_event', 'result', 'system', 'command_lifecycle', 'cotta_live_turn_failed'])

export function rawMessageBlock(message: Record<string, unknown>): TimelineBlock {
  const uuid = sdkMessageUuid(message) ?? String(message.type)
  return { id: `${uuid}:raw`, kind: `raw.${String(message.type)}`, sourceEventIds: sdkMessageUuid(message) ? [uuid] : [], data: message }
}

function peerMessageBlock(message: Record<string, unknown>, uuid: string): TimelineBlock | null {
  if (!isRecord(message.message) || message.message.role !== 'user' || !isRecord(message.origin) || message.origin.kind !== 'peer') return null
  const name = typeof message.origin.name === 'string' && message.origin.name.trim() ? message.origin.name.trim() : typeof message.origin.from === 'string' ? message.origin.from.trim() : ''
  return name && typeof message.origin.body === 'string' && message.origin.body.trim()
    ? { id: `${uuid}:peer_message`, kind: 'assistant.peer_message', sourceEventIds: [uuid], data: { ...message.origin, name } }
    : null
}

export function toolUseOwnerTurnId(turns: TurnSummary[], toolUseId: string): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!
    if (projectTimelineTurn(turn).some((block) => block.kind === 'assistant.tool_use' && block.toolUseId === toolUseId)) return turn.primaryUserUuid
  }
  return null
}

function messageCwd(message: unknown): string | undefined {
  return isRecord(message) && typeof message.cwd === 'string' && message.cwd.trim() ? message.cwd : undefined
}

export function appendMessageToTurn(turns: TurnSummary[], turnId: string | null, message: unknown): TurnSummary[] {
  if (!turnId) return turns
  const cwd = messageCwd(message)
  const index = turns.findIndex((turn) => turn.primaryUserUuid === turnId)
  if (index < 0) return [...turns, { primaryUserUuid: turnId, ...(cwd ? { responseCwd: cwd } : {}), messages: [message] }]
  return turns.map((turn) => {
    if (turn.primaryUserUuid !== turnId) return turn
    const withCwd = (next: TurnSummary): TurnSummary => (cwd ? { ...next, responseCwd: cwd } : next)
    const identity = messageIdentity(message)
    if (!identity) return messageIsRepresentedBy(message, timelineTurnIndex([turn])) ? withCwd(turn) : withCwd({ ...turn, messages: [...turn.messages, message] })
    const messageIndex = turn.messages.findIndex((item) => messageIdentity(item) === identity)
    if (messageIndex < 0) return withCwd({ ...turn, messages: [...turn.messages, message] })
    const messages = [...turn.messages]
    messages[messageIndex] = mergeMessageVariants(messages[messageIndex], message)
    return withCwd({ ...turn, messages })
  })
}

export function messageOwnerTurnId(turns: TurnSummary[], activeTurnId: string | null, message: Record<string, unknown>): string | null {
  const parentUuid = typeof message.parentUuid === 'string' ? message.parentUuid : null
  if (parentUuid && timelineLocalCommandFeedback(message)) {
    const turn = turns.find(({ primaryUserUuid }) => primaryUserUuid === parentUuid)
    if (turn?.messages.some((candidate) => isRecord(candidate) && sdkMessageUuid(candidate) === parentUuid && timelineLocalCommand(candidate) !== null)) return parentUuid
  }
  const taskNotification = parseTimelineTaskNotification(message)
  const linkedToolUseIds = taskNotification
    ? taskNotification.kind === 'valid' && taskNotification.notification.toolUseId
      ? [taskNotification.notification.toolUseId]
      : []
    : messageToolUseIds(message, 'tool_result')
  if (linkedToolUseIds.length > 1) return null
  const linkedToolUseId = linkedToolUseIds[0]
  if (!linkedToolUseId) return activeTurnId
  return toolUseOwnerTurnId(turns, linkedToolUseId)
}

function splitToolResultMessage(message: Record<string, unknown>): Array<{ toolUseId: string; message: Record<string, unknown> }> {
  const content = sdkMessageContent(message)
  if (!Array.isArray(content)) return []
  const results = content.flatMap((block, index) => {
    const toolUseId = isRecord(block) && block.type === 'tool_result' ? timelineToolUseId(message, block) : undefined
    return toolUseId ? [{ toolUseId, block, index }] : []
  })
  if (results.length <= 1) return []
  const uuid = sdkMessageUuid(message)
  return results.map(({ toolUseId, block, index }) => ({
    toolUseId,
    message: { ...message, ...(uuid ? { uuid: `${uuid}:tool_result:${index}` } : {}), message: { ...(isRecord(message.message) ? message.message : {}), content: [block] } },
  }))
}

export function applySdkMessage(turns: TurnSummary[], raw: unknown, historyIndex: TimelineTurnIndex, currentUserMessageUuid: string | null, occurredAt = Date.now()): ApplySdkMessageResult {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !LIVE_TIMELINE_MESSAGE_TYPES.has(raw.type)) return { turns, currentUserMessageUuid, terminal: false }
  const message = raw.type === 'stream_event' && rawMessageTimestampMs(raw) === null ? { ...raw, timestamp: occurredAt } : raw
  if ((message.type === 'user' && message.isSynthetic === true && !isTimelineTaskNotificationMessage(message)) || isTimelineLocalCommandCaveatMessage(message))
    return { turns, currentUserMessageUuid, terminal: false }

  if (
    (message.type === 'user' && isPrimaryTimelineUserMessage(message) && !isTimelineTaskNotificationMessage(message)) ||
    ((message.type === 'system' || message.type === 'assistant') && timelineLocalCommand(message) !== null)
  ) {
    const uuid = sdkMessageUuid(message)
    if (!uuid) return { turns, currentUserMessageUuid, terminal: false }
    const nextUserMessageUuid = message.type === 'assistant' ? currentUserMessageUuid : uuid
    const cwd = messageCwd(message)
    const existing = turns.find((turn) => turn.primaryUserUuid === uuid)
    if (existing) {
      const next = messageIsRepresentedBy(message, historyIndex)
        ? turns
        : turns.map((turn) =>
            turn.primaryUserUuid === uuid
              ? {
                  ...turn,
                  primaryUserTimestampMs: rawMessageTimestampMs(message) ?? turn.primaryUserTimestampMs,
                  ...(cwd ? { userCwd: cwd } : {}),
                  ...(typeof message.entrypoint === 'string' ? { entrypoint: message.entrypoint } : {}),
                  messages: [message, ...turn.messages.filter((item) => messageIdentity(item) !== `uuid:${uuid}`)],
                }
              : turn,
          )
      return { turns: next, currentUserMessageUuid: nextUserMessageUuid, terminal: false }
    }
    const turn: TurnSummary = {
      primaryUserUuid: uuid,
      primaryUserTimestampMs: rawMessageTimestampMs(message) ?? occurredAt,
      ...(cwd ? { userCwd: cwd } : {}),
      ...(typeof message.entrypoint === 'string' ? { entrypoint: message.entrypoint } : {}),
      messages: [message],
    }
    return { turns: turnIsRepresentedBy(turn, historyIndex) ? turns : [...turns, turn], currentUserMessageUuid: nextUserMessageUuid, terminal: false }
  }

  if (messageIsRepresentedBy(message, historyIndex)) return { turns, currentUserMessageUuid, terminal: isTerminalLiveEvent(message) }
  const localCommandOwner = timelineLocalCommandFeedback(message) ? messageOwnerTurnId(turns, null, message) : null
  if (localCommandOwner) return { turns: appendMessageToTurn(turns, localCommandOwner, message), currentUserMessageUuid, terminal: false }
  if (!currentUserMessageUuid) return { turns, currentUserMessageUuid, terminal: isTerminalLiveEvent(message) }
  const splitResults = splitToolResultMessage(message)
  if (splitResults.length > 0) {
    const nextTurns = splitResults.reduce((next, item) => appendMessageToTurn(next, toolUseOwnerTurnId(next, item.toolUseId), item.message), turns)
    return { turns: nextTurns, currentUserMessageUuid, terminal: isTerminalLiveEvent(message) }
  }
  const owner = messageOwnerTurnId(turns, currentUserMessageUuid, message)
  return { turns: appendMessageToTurn(turns, owner, message), currentUserMessageUuid, terminal: isTerminalLiveEvent(message) }
}

export function messageToolUseIds(raw: unknown, blockType: 'tool_use' | 'tool_result'): string[] {
  if (!isRecord(raw)) return []
  const content = sdkMessageContent(raw)
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => (isRecord(block) && block.type === blockType ? (blockType === 'tool_use' && typeof block.id === 'string' ? block.id : (timelineToolUseId(raw, block) ?? [])) : []))
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
    const merged = {
      ...turn,
      ...(!turn.userCwd && liveTurn.userCwd ? { userCwd: liveTurn.userCwd } : {}),
      ...(!turn.responseCwd && liveTurn.responseCwd ? { responseCwd: liveTurn.responseCwd } : {}),
    }
    return liveMessages.length > 0 ? { ...merged, messages: [...merged.messages, ...liveMessages] } : merged
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

export function prependOlderTimelineTurns(current: TurnSummary[], older: TurnSummary[]): TurnSummary[] {
  const currentIndex = timelineTurnIndex(current)
  const currentFirstOrder = current[0] ? turnOrderValue(current[0]) : null
  return [
    ...older.filter((turn) => {
      const order = turnOrderValue(turn)
      return !turnIsRepresentedBy(turn, currentIndex) && (currentFirstOrder === null || order === null || order < currentFirstOrder)
    }),
    ...current,
  ]
}

type StreamContentSegment = { apiMessageId: string; kind: string; index: number; toolUseId?: string; messageIndexes: number[] }
type AssistantContentDescriptor = Pick<StreamContentSegment, 'apiMessageId' | 'kind' | 'toolUseId'>

function assistantContentDescriptors(message: unknown): AssistantContentDescriptor[] {
  if (!isRecord(message) || message.type !== 'assistant' || !isRecord(message.message) || typeof message.message.id !== 'string' || !Array.isArray(message.message.content)) return []
  const { id, content } = message.message
  return content.flatMap((block) => {
    if (!isRecord(block) || typeof block.type !== 'string') return []
    return [{ apiMessageId: id, kind: `assistant.${block.type}`, ...(block.type === 'tool_use' && typeof block.id === 'string' ? { toolUseId: block.id } : {}) }]
  })
}

function claimStreamSegments(segments: StreamContentSegment[], descriptors: AssistantContentDescriptor[], claimed: Set<StreamContentSegment>, beforeMessageIndex?: number): StreamContentSegment[] {
  return descriptors.flatMap((descriptor) => {
    const candidates = segments.filter(
      (segment) => segment.apiMessageId === descriptor.apiMessageId && segment.kind === descriptor.kind && (beforeMessageIndex === undefined || segment.messageIndexes[0]! < beforeMessageIndex),
    )
    const segment = descriptor.toolUseId ? candidates.find((candidate) => candidate.toolUseId === descriptor.toolUseId) : candidates.find((candidate) => !claimed.has(candidate))
    if (!segment) return []
    claimed.add(segment)
    return [segment]
  })
}

function streamContentSegments(messages: unknown[]): StreamContentSegment[] {
  const segments = new Map<string, StreamContentSegment>()
  let apiMessageId: string | null = null
  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message) || message.type !== 'stream_event' || !isRecord(message.event)) continue
    const event = message.event
    if (event.type === 'message_start') {
      apiMessageId = isRecord(event.message) && typeof event.message.id === 'string' ? event.message.id : null
      continue
    }
    const index = typeof event.index === 'number' ? event.index : null
    if (apiMessageId === null || index === null) continue
    const key = `${apiMessageId}:${index}`
    let segment = segments.get(key)
    if (!segment) {
      const kind =
        event.type === 'content_block_start' && isRecord(event.content_block) && typeof event.content_block.type === 'string'
          ? `assistant.${event.content_block.type}`
          : event.type === 'content_block_delta' && isRecord(event.delta) && typeof event.delta.type === 'string'
            ? `assistant.${blockTypeForDelta(event.delta.type)}`
            : null
      if (!kind) continue
      segment = { apiMessageId, kind, index, messageIndexes: [] }
      segments.set(key, segment)
    }
    if (event.type === 'content_block_start' && isRecord(event.content_block) && event.content_block.type === 'tool_use' && typeof event.content_block.id === 'string')
      segment.toolUseId = event.content_block.id
    segment.messageIndexes.push(messageIndex)
  }
  return [...segments.values()]
}

export function materializeTimelineTurns(
  current: TurnSummary[],
  transcriptTurns: TurnSummary[],
  overlaySources: ReadonlyMap<string, OverlayMessageSource>,
): { turns: TurnSummary[]; transcriptIndex: TimelineTurnIndex } {
  const transcriptIndex = timelineTurnIndex(transcriptTurns)
  const transcriptTurnsById = new Map(transcriptTurns.map((turn) => [turn.primaryUserUuid, turn]))
  const overlays = current.flatMap((turn) => {
    const suppressedStreamIndexes = new Set<number>()
    const segments = streamContentSegments(turn.messages)
    const claimed = new Set<StreamContentSegment>()
    const liveAssistantClaims = new Map<number, StreamContentSegment[]>()
    for (const [messageIndex, message] of turn.messages.entries()) {
      const claims = claimStreamSegments(segments, assistantContentDescriptors(message), claimed, messageIndex)
      if (claims.length > 0) liveAssistantClaims.set(messageIndex, claims)
    }
    for (const message of transcriptTurnsById.get(turn.primaryUserUuid)?.messages ?? []) {
      for (const segment of claimStreamSegments(segments, assistantContentDescriptors(message), claimed)) {
        for (const messageIndex of segment.messageIndexes) suppressedStreamIndexes.add(messageIndex)
        for (const [messageIndex, claims] of liveAssistantClaims) if (claims.includes(segment)) suppressedStreamIndexes.add(messageIndex)
      }
    }
    for (let index = 0; index < turn.messages.length; index += 1) {
      const message = turn.messages[index]
      if (!isRecord(message) || message.type !== 'assistant' || !messageIsRepresentedBy(message, transcriptIndex)) continue
      for (let streamIndex = index - 1; streamIndex >= 0; streamIndex -= 1) {
        const streamMessage = turn.messages[streamIndex]
        if (!isRecord(streamMessage) || streamMessage.type !== 'stream_event') break
        suppressedStreamIndexes.add(streamIndex)
      }
    }
    return turn.messages.flatMap((message, index) => {
      const id = messageIdentity(message)
      const liveFailure = isRecord(message) && message.type === 'cotta_live_turn_failed'
      return !suppressedStreamIndexes.has(index) && (liveFailure || (id && overlaySources.has(id) && !messageIsRepresentedBy(message, transcriptIndex))) ? [{ owner: turn, message }] : []
    })
  })
  const turns = transcriptTurns.map((turn) => ({ ...turn, messages: [...turn.messages] }))

  for (const { owner, message } of overlays) {
    const ownerId = isRecord(message) ? messageOwnerTurnId(turns, owner.primaryUserUuid, message) : owner.primaryUserUuid
    if (!ownerId) continue
    const index = turns.findIndex((turn) => turn.primaryUserUuid === ownerId)
    if (index >= 0) {
      const turn = turns[index]!
      if (!messageIsRepresentedBy(message, timelineTurnIndex([turn]))) turns[index] = { ...turn, messages: [...turn.messages, message] }
      continue
    }
    const overlayTurn = { ...owner, primaryUserUuid: ownerId, messages: [message] }
    const order = turnOrderValue(overlayTurn)
    const insertAt = order === null ? turns.length : turns.findIndex((turn) => (turnOrderValue(turn) ?? Number.POSITIVE_INFINITY) > order)
    turns.splice(insertAt < 0 ? turns.length : insertAt, 0, overlayTurn)
  }

  return { turns, transcriptIndex }
}

export function replaceTimelineTail(current: TurnSummary[], fromTurnId: string, snapshot: TurnSummary[]): TurnSummary[] | null {
  const anchor = current.findIndex((turn) => turn.primaryUserUuid === fromTurnId)
  return anchor < 0 ? null : [...current.slice(0, anchor), ...reconcileTimelineTurns(current.slice(anchor), snapshot)]
}

export type TranscriptSignal = { source: 'change' | 'snapshot'; epoch: string; version: string; reset: boolean; invalidateFromTurnId: string | null }
export type TimelineControlSignal = { epoch: string; version: string }

export function coalesceTranscriptSignal(current: TranscriptSignal | null, incoming: TranscriptSignal, turns: TurnSummary[]): TranscriptSignal | null {
  if (current?.version === incoming.version) return current
  if (!current || incoming.reset) return incoming
  if (current.reset) return { ...current, version: incoming.version }
  const currentIndex = turns.findIndex((turn) => turn.primaryUserUuid === current.invalidateFromTurnId)
  const incomingIndex = turns.findIndex((turn) => turn.primaryUserUuid === incoming.invalidateFromTurnId)
  if (currentIndex < 0 || incomingIndex < 0) return { ...incoming, reset: true, invalidateFromTurnId: null }
  return { ...incoming, invalidateFromTurnId: currentIndex <= incomingIndex ? current.invalidateFromTurnId : incoming.invalidateFromTurnId }
}

export type SessionTimelineScope = { sessionId: string | null; pendingPrimaryTurnUuid: string | null; anchorTurnId?: string | null }

export function belongsToTimelineSession(sessionId: string | null, candidateSessionId: string): boolean {
  return sessionId !== null && candidateSessionId === sessionId
}

export function shouldResetSessionTimeline(previous: SessionTimelineScope | null, next: SessionTimelineScope): boolean {
  return !previous || previous.sessionId !== next.sessionId || previous.anchorTurnId !== next.anchorTurnId
}

export function zonedTimestamp(value: unknown, timeZone: string): { date: string; time: string } {
  if (typeof value !== 'string') return { date: '—', time: '' }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: value, time: '' }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
}

export function rawMessageTimestampMs(message: unknown): number | null {
  const value = isRecord(message) ? message.timestamp : undefined
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
