import type { DisplayItem } from '../../contract/runtime'
import type {
  TimelineAssistantItem,
  TimelineLivePreview,
  TimelineRenderableItemModel,
  TimelineUserItem,
} from '../../models/timeline'
import { mapDisplayItemsToTimelineVms } from './buildTimeline'

export interface FourSegmentTimelineSections {
  historyFromServerItems: TimelineRenderableItemModel[]
  committedTurnsLocalItems: TimelineRenderableItemModel[]
  currentTurnUserItems: TimelineRenderableItemModel[]
  currentTurnAssistantItems: TimelineRenderableItemModel[]
  timeline: TimelineRenderableItemModel[]
}

function renderSingleUserItem(item: DisplayItem): TimelineRenderableItemModel[] {
  return mapDisplayItemsToTimelineVms([item])
}

function isTerminalAssistantItem(item: DisplayItem): boolean {
  return item.kind === 'assistant' && typeof item.footer?.stopReason === 'string' && item.footer.stopReason.length > 0
}

function buildCurrentTurnAssistantPlaceholder(userItem: TimelineUserItem): TimelineAssistantItem {
  return {
    kind: 'assistant',
    id: `current-turn-assistant-${userItem.id}`,
    key: `current-turn-assistant-${userItem.key}`,
    timestamp: userItem.timestamp,
    atomIds: [],
    messages: [],
    anchorMessage: {
      role: 'assistant',
      content: '',
      timestamp: userItem.timestamp,
      blocks: [],
      raw: {
        type: 'assistant',
        uuid: `placeholder-${userItem.id}`,
        message: {
          id: `placeholder-${userItem.id}`,
          content: [],
        },
      },
    },
    fragments: [],
    placeholder: true,
  }
}

function sortPreviewOverlays(overlays: TimelineLivePreview[]): TimelineLivePreview[] {
  return overlays
    .slice()
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
      return left.key.localeCompare(right.key)
    })
}

export function buildFourSegmentTimelineSections(params: {
  historyFromServerItems: DisplayItem[]
  localTurnItems: DisplayItem[]
  livePreviewItems: TimelineLivePreview[]
  hasActiveRun: boolean
}): FourSegmentTimelineSections {
  const items = params.localTurnItems
  const lastCommittedAssistantIndex = (() => {
    let last = -1
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'assistant' && isTerminalAssistantItem(item)) last = i
    }
    return last
  })()

  const committedSlice = lastCommittedAssistantIndex >= 0 ? items.slice(0, lastCommittedAssistantIndex + 1) : []
  const committedTurnsLocalItems = mapDisplayItemsToTimelineVms(committedSlice)

  const currentSlice = items.slice(lastCommittedAssistantIndex + 1)
  const currentUser = currentSlice.find((item) => item.kind === 'user') as DisplayItem | undefined
  const currentAssistant = currentSlice.find((item) => item.kind === 'assistant') as DisplayItem | undefined

  const shouldShowCurrent = Boolean(
    params.hasActiveRun
    || params.livePreviewItems.length > 0
    || (currentAssistant && !isTerminalAssistantItem(currentAssistant)),
  )

  const currentTurnUserItems = shouldShowCurrent && currentUser
    ? renderSingleUserItem(currentUser as TimelineUserItem)
    : []

  const currentLive = (shouldShowCurrent && currentAssistant && !isTerminalAssistantItem(currentAssistant))
    ? [currentAssistant]
    : []

  const currentTurnAssistantItems = (() => {
    if (currentTurnUserItems.length === 0 && currentLive.length === 0 && params.livePreviewItems.length === 0) {
      return []
    }
    const materializedAssistant = currentLive.length > 0
      ? mapDisplayItemsToTimelineVms(currentLive).find((item): item is TimelineAssistantItem => item.kind === 'assistant') ?? null
      : null
    const host = materializedAssistant
      ?? (currentTurnUserItems.length > 0 ? buildCurrentTurnAssistantPlaceholder((currentUser as TimelineUserItem)!) : null)
    if (!host) return []
    const overlays = sortPreviewOverlays(params.livePreviewItems)
    return [{
      ...host,
      ...(overlays.length > 0 ? { overlays } : {}),
    }]
  })()

  const timeline = [
    ...params.historyFromServerItems,
    ...committedTurnsLocalItems,
    ...currentTurnUserItems,
    ...currentTurnAssistantItems,
  ]

  return {
    historyFromServerItems: params.historyFromServerItems,
    committedTurnsLocalItems,
    currentTurnUserItems,
    currentTurnAssistantItems,
    timeline,
  }
}
