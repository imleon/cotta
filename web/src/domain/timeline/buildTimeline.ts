import type {
  AssistantDisplayItem,
  DisplayItem,
  DisplayFragmentText,
  DisplayFragmentThinking,
  DisplayFragmentToolResult,
  DisplayFragmentToolUse,
  DisplayAssistantFooter,
  SessionMessage,
  StreamAnimationCursor,
  StreamPreviewState,
  TimelineLivePreviewItem,
  TranscriptAtom,
} from '../../contract/runtime'
import {
  buildDisplayItems,
  buildHistoryDisplayItems,
  getTranscriptResponseId,
  renderStreamPreviewState,
} from '../../contract/runtime'
import type {
  TimelineAssistantFooter,
  TimelineAssistantItem,
  TimelineFragment,
  TimelineLivePreview,
  TimelineRenderableItemModel,
  TimelineTextFragment,
  TimelineThinkingFragment,
  TimelineToolResultFragment,
  TimelineToolUseFragment,
  TimelineUserItem,
} from '../../models/timeline'

function sortByTimestampAndKey<T extends { timestamp: number; key: string }>(items: T[]): T[] {
  return items
    .slice()
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
      return left.key.localeCompare(right.key)
    })
}

function getLivePreviewOverlayKind(preview: StreamPreviewState): TimelineLivePreviewItem['overlayKind'] {
  switch (preview.phase) {
    case 'thinking':
      return 'streaming_thinking'
    case 'tool-input':
      return 'streaming_tool_use'
    case 'responding':
      return 'streaming_text'
    default:
      return preview.status === 'awaiting-materialization' ? 'streaming_text' : 'streaming_progress'
  }
}

function isOverlayHostItem(item: DisplayItem): item is AssistantDisplayItem {
  return item.kind === 'assistant'
}

function getDisplayItemToolUseIds(item: AssistantDisplayItem): string[] {
  return item.fragments.flatMap((fragment) => fragment.type === 'tool_use' && typeof fragment.toolUseId === 'string' ? [fragment.toolUseId] : [])
}

function shouldAttachOverlayToItem(
  item: AssistantDisplayItem,
  overlay: TimelineLivePreviewItem,
): boolean {
  if (overlay.anchor.anchorKind === 'tool_use') {
    return getDisplayItemToolUseIds(item).includes(overlay.anchor.anchorId)
  }

  if (overlay.anchor.anchorKind === 'message') {
    return getTranscriptResponseId(item.anchorMessage) === overlay.anchor.anchorId
  }

  if (overlay.anchor.parentToolUseId) {
    return getDisplayItemToolUseIds(item).includes(overlay.anchor.parentToolUseId)
  }

  if (overlay.anchor.messageId) {
    return getTranscriptResponseId(item.anchorMessage) === overlay.anchor.messageId
  }

  return false
}

function getOverlayHostPriority(
  item: AssistantDisplayItem,
  overlay: TimelineLivePreviewItem,
): number {
  if (!shouldAttachOverlayToItem(item, overlay)) return -1
  if (overlay.anchor.anchorKind === 'tool_use' || overlay.anchor.parentToolUseId) {
    return 1
  }
  if (overlay.anchor.anchorKind === 'message' || overlay.anchor.messageId) {
    return 3
  }
  return 0
}

function attachOverlaysToDisplayItems(
  items: DisplayItem[],
  overlays: TimelineLivePreviewItem[],
): { items: DisplayItem[]; unattachedOverlays: TimelineLivePreviewItem[] } {
  const overlaysByItemId = new Map<string, TimelineLivePreviewItem[]>()
  const attachedOverlayIds = new Set<string>()
  const hosts = items.filter(isOverlayHostItem)

  for (const overlay of overlays) {
    const host = hosts
      .map((item) => ({ item, priority: getOverlayHostPriority(item, overlay) }))
      .filter((entry) => entry.priority >= 0)
      .sort((left, right) => right.priority - left.priority)[0]?.item
    if (!host) continue
    overlaysByItemId.set(host.id, [...(overlaysByItemId.get(host.id) || []), overlay])
    attachedOverlayIds.add(overlay.id)
  }

  return {
    items: items.map((item) => {
      const overlaysForItem = overlaysByItemId.get(item.id)
      if (!overlaysForItem || !isOverlayHostItem(item)) return item
      return {
        ...item,
        overlays: overlaysForItem,
      }
    }),
    unattachedOverlays: overlays.filter((overlay) => !attachedOverlayIds.has(overlay.id)),
  }
}

function buildSyntheticAssistantMessage(anchorId: string, timestamp: number): SessionMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp,
    blocks: [],
    raw: {
      type: 'assistant',
      uuid: `synthetic-${anchorId}`,
      message: {
        id: anchorId,
        content: [],
      },
    },
  }
}

function synthesizeOverlayHosts(unattached: TimelineLivePreviewItem[]): AssistantDisplayItem[] {
  if (!unattached.length) return []

  const byKey = new Map<string, TimelineLivePreviewItem[]>()
  for (const overlay of unattached) {
    const messageId = overlay.anchor.messageId
      ?? (overlay.anchor.anchorKind === 'message' ? overlay.anchor.anchorId : null)
    const key = messageId
      ? `message:${messageId}`
      : overlay.anchor.parentToolUseId
        ? `tool:${overlay.anchor.parentToolUseId}`
        : `scope:${overlay.anchor.scopeKey}`
    byKey.set(key, [...(byKey.get(key) || []), overlay])
  }

  const synthetic: AssistantDisplayItem[] = []
  for (const [groupKey, overlays] of byKey.entries()) {
    const timestamp = overlays.reduce((min, item) => Math.min(min, item.timestamp), overlays[0]!.timestamp)
    const anchorId = (() => {
      const messageId = overlays.find((item) => typeof item.anchor.messageId === 'string' && item.anchor.messageId)?.anchor.messageId
      if (typeof messageId === 'string' && messageId) return messageId
      const messageAnchor = overlays.find((item) => item.anchor.anchorKind === 'message')?.anchor.anchorId
      return messageAnchor ?? groupKey
    })()

    synthetic.push({
      kind: 'assistant',
      id: `synthetic-assistant-${groupKey}`,
      key: `synthetic-assistant-${groupKey}`,
      timestamp,
      atomIds: [],
      messages: [],
      anchorMessage: buildSyntheticAssistantMessage(anchorId, timestamp),
      fragments: [],
      overlays,
      footer: undefined,
    })
  }

  return synthetic
}

function isDetachedToolResultAssistant(item: AssistantDisplayItem): boolean {
  if (item.fragments.length === 0) return false
  return item.fragments.every((fragment) => fragment.type === 'tool_result')
}

function isOverlayOnlyAssistant(item: AssistantDisplayItem): boolean {
  return item.fragments.length === 0 && Boolean(item.overlays?.length)
}

function canMergeAssistantOutputItems(current: AssistantDisplayItem | null, next: AssistantDisplayItem): boolean {
  if (!current) return true
  if (isDetachedToolResultAssistant(current) || isDetachedToolResultAssistant(next)) return false
  if (isOverlayOnlyAssistant(current) || isOverlayOnlyAssistant(next)) return false
  return true
}

function mergeAssistantOutputItems(
  current: AssistantDisplayItem | null,
  next: AssistantDisplayItem,
): AssistantDisplayItem {
  if (!current) return next

  const overlays = sortByTimestampAndKey([...(current.overlays || []), ...(next.overlays || [])])

  return {
    ...current,
    atomIds: [...current.atomIds, ...next.atomIds],
    messages: [...current.messages, ...next.messages],
    anchorMessage: next.anchorMessage,
    fragments: [...current.fragments, ...next.fragments],
    footer: next.footer ?? current.footer,
    overlays: overlays.length > 0 ? overlays : undefined,
  }
}

function mergeTurnOutputItems(items: DisplayItem[]): DisplayItem[] {
  const merged: DisplayItem[] = []
  let pendingOutput: AssistantDisplayItem | null = null

  const flushPending = () => {
    if (!pendingOutput) return
    merged.push(pendingOutput)
    pendingOutput = null
  }

  for (const item of items) {
    if (item.kind === 'user') {
      flushPending()
      merged.push(item)
      continue
    }

    if (!canMergeAssistantOutputItems(pendingOutput, item)) {
      flushPending()
    }

    pendingOutput = mergeAssistantOutputItems(pendingOutput, item)
  }

  flushPending()
  return merged
}

function mapTextFragment(fragment: DisplayFragmentText): TimelineTextFragment {
  return {
    type: 'text',
    text: fragment.text,
  }
}

function mapThinkingFragment(fragment: DisplayFragmentThinking): TimelineThinkingFragment {
  return {
    type: 'thinking',
    ...(fragment.text !== undefined ? { text: fragment.text } : {}),
    ...(fragment.redacted !== undefined ? { redacted: fragment.redacted } : {}),
    defaultHidden: fragment.defaultHidden,
  }
}

function mapToolUseFragment(fragment: DisplayFragmentToolUse): TimelineToolUseFragment {
  return {
    type: 'tool_use',
    name: fragment.name,
    ...(fragment.toolUseId !== undefined ? { toolUseId: fragment.toolUseId } : {}),
    ...(fragment.input !== undefined ? { input: fragment.input } : {}),
    ...(fragment.grouped !== undefined ? { grouped: fragment.grouped } : {}),
  }
}

function mapToolResultFragment(fragment: DisplayFragmentToolResult): TimelineToolResultFragment {
  return {
    type: 'tool_result',
    ...(fragment.toolUseId !== undefined ? { toolUseId: fragment.toolUseId } : {}),
    ...(fragment.output !== undefined ? { output: fragment.output } : {}),
    ...(fragment.raw !== undefined ? { raw: fragment.raw } : {}),
    ...(fragment.attachedToParent !== undefined ? { attachedToParent: fragment.attachedToParent } : {}),
    ...(fragment.defaultCollapsed !== undefined ? { defaultCollapsed: fragment.defaultCollapsed } : {}),
    ...(fragment.display
      ? {
          display: {
            previewText: fragment.display.previewText,
            lineCount: fragment.display.lineCount,
            charCount: fragment.display.charCount,
            defaultExpanded: fragment.display.defaultExpanded,
          },
        }
      : {}),
  }
}

function mapTimelineFragment(fragment: AssistantDisplayItem['fragments'][number]): TimelineFragment {
  switch (fragment.type) {
    case 'text':
      return mapTextFragment(fragment)
    case 'thinking':
      return mapThinkingFragment(fragment)
    case 'tool_use':
      return mapToolUseFragment(fragment)
    case 'tool_result':
      return mapToolResultFragment(fragment)
  }
}

function mapAssistantFooter(footer: DisplayAssistantFooter | undefined): TimelineAssistantFooter | undefined {
  if (!footer) return undefined
  return {
    ...(footer.stopReason !== undefined ? { stopReason: footer.stopReason } : {}),
    ...(footer.model !== undefined ? { model: footer.model } : {}),
    ...(footer.usage !== undefined ? { usage: footer.usage } : {}),
    ...(footer.completedAt !== undefined ? { completedAt: footer.completedAt } : {}),
    ...(footer.deltaMs !== undefined ? { deltaMs: footer.deltaMs } : {}),
  }
}

function mapLivePreviewItem(item: TimelineLivePreviewItem): TimelineLivePreview {
  return {
    kind: 'live_preview',
    layer: 'overlay',
    overlayKind: item.overlayKind,
    anchor: {
      scopeKey: item.anchor.scopeKey,
      anchorKind: item.anchor.anchorKind,
      anchorId: item.anchor.anchorId,
      ...(item.anchor.messageId !== undefined ? { messageId: item.anchor.messageId } : {}),
      ...(item.anchor.parentToolUseId !== undefined ? { parentToolUseId: item.anchor.parentToolUseId } : {}),
    },
    id: item.id,
    key: item.key,
    timestamp: item.timestamp,
    preview: item.preview,
  }
}

function mapUserItem(item: Extract<DisplayItem, { kind: 'user' }>): TimelineUserItem {
  return {
    kind: 'user',
    id: item.id,
    key: item.key,
    timestamp: item.timestamp,
    atomIds: [...item.atomIds],
    message: item.message,
    ...(item.displayKind !== undefined ? { displayKind: item.displayKind } : {}),
  }
}

function mapAssistantItem(item: AssistantDisplayItem): TimelineAssistantItem {
  return {
    kind: 'assistant',
    id: item.id,
    key: item.key,
    timestamp: item.timestamp,
    atomIds: [...item.atomIds],
    messages: [...item.messages],
    anchorMessage: item.anchorMessage,
    fragments: item.fragments.map(mapTimelineFragment),
    ...(item.footer ? { footer: mapAssistantFooter(item.footer) } : {}),
    ...(item.overlays ? { overlays: item.overlays.map(mapLivePreviewItem) } : {}),
  }
}

function mapDisplayItemToTimelineVm(item: DisplayItem): TimelineRenderableItemModel {
  if (item.kind === 'user') return mapUserItem(item)
  return mapAssistantItem(item)
}

export function mapDisplayItemsToTimelineVms(items: DisplayItem[]): TimelineRenderableItemModel[] {
  return items.map(mapDisplayItemToTimelineVm)
}

export function buildHistoryTimelineItems(historyMessages: SessionMessage[]): DisplayItem[] {
  return buildHistoryDisplayItems(historyMessages, {
    mode: 'default',
    includeHiddenAtoms: false,
  })
}

export function buildAtomTimelineItems(atoms: TranscriptAtom[]): DisplayItem[] {
  return buildDisplayItems(atoms, {
    mode: 'default',
    includeHiddenAtoms: false,
  })
}

export function buildLivePreviewItems(
  previewStates: Record<string, StreamPreviewState>,
  animationCursors: Record<string, StreamAnimationCursor>,
): TimelineLivePreviewItem[] {
  return Object.entries(previewStates)
    // Keep finalized previews visible until the turn is materialized/cleared.
    // Otherwise preview-only blocks (e.g. thinking) can briefly disappear before the final message arrives.
    .filter(([, preview]) => preview.blocks.length > 0)
    .slice()
    .sort(([, left], [, right]) => {
      const leftTimestamp = left.receivedAt ?? 0
      const rightTimestamp = right.receivedAt ?? 0
      if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp
      const leftSequence = left.sequence ?? 0
      const rightSequence = right.sequence ?? 0
      return leftSequence - rightSequence
    })
    .map(([scopeKey, preview]) => ({
      kind: 'live_preview',
      layer: 'overlay',
      overlayKind: getLivePreviewOverlayKind(preview),
      anchor: {
        scopeKey: preview.scope.scopeKey || 'unknown',
        anchorKind: preview.scope.anchorKind,
        anchorId: preview.scope.anchorId,
        ...(preview.scope.messageId ? { messageId: preview.scope.messageId } : {}),
        ...(preview.scope.parentToolUseId !== undefined ? { parentToolUseId: preview.scope.parentToolUseId } : {}),
      },
      id: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
      key: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
      timestamp: preview.receivedAt ?? Date.now(),
      preview: renderStreamPreviewState(preview, animationCursors[scopeKey] ?? null),
    }))
}

export function buildRenderableTimeline(params: {
  historyTimelineItems: DisplayItem[]
  userTimelineItems: DisplayItem[]
  liveTimelineItems: DisplayItem[]
  livePreviewItems: TimelineLivePreviewItem[]
}): TimelineRenderableItemModel[] {
  const visibleItems = sortByTimestampAndKey([
    ...params.historyTimelineItems,
    ...params.userTimelineItems,
    ...params.liveTimelineItems,
  ])
  const { items: itemsWithOverlays, unattachedOverlays } = attachOverlaysToDisplayItems(
    visibleItems,
    params.livePreviewItems,
  )
  const syntheticOverlayHosts = synthesizeOverlayHosts(unattachedOverlays)
  return sortByTimestampAndKey(
    mergeTurnOutputItems([...itemsWithOverlays, ...syntheticOverlayHosts]),
  ).map(mapDisplayItemToTimelineVm)
}
