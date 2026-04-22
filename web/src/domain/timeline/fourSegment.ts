import type { DisplayItem } from '../../contract/runtime'
import type {
  TimelineAssistantItem,
  TimelineAssistantFooter,
  TimelineLivePreview,
  TimelineFragment,
  TimelineRenderableItemModel,
  TimelineUserItem,
} from '../../models/timeline'
import { buildRenderableTimeline } from './buildTimeline'

export interface FourSegmentTimelineSections {
  historyFromServerItems: TimelineRenderableItemModel[]
  committedTurnsLocalItems: TimelineRenderableItemModel[]
  currentTurnUserItems: TimelineRenderableItemModel[]
  currentTurnAssistantItems: TimelineRenderableItemModel[]
  timeline: TimelineRenderableItemModel[]
}

function renderSingleUserItem(item: DisplayItem): TimelineRenderableItemModel[] {
  return buildRenderableTimeline({
    historyTimelineItems: [],
    userTimelineItems: [item],
    liveTimelineItems: [],
    livePreviewItems: [],
  })
}

function renderSingleAssistantItem(item: DisplayItem): TimelineRenderableItemModel[] {
  return buildRenderableTimeline({
    historyTimelineItems: [],
    userTimelineItems: [],
    liveTimelineItems: [item],
    livePreviewItems: [],
  })
}

function buildCommittedTurnItems(users: DisplayItem[], assistants: DisplayItem[]): TimelineRenderableItemModel[] {
  const items: TimelineRenderableItemModel[] = []
  let assistantIndex = 0
  for (let index = 0; index < users.length; index += 1) {
    const user = users[index]
    if (user) items.push(...renderSingleUserItem(user))
    const turnAssistants: DisplayItem[] = []
    while (assistantIndex < assistants.length) {
      const assistant = assistants[assistantIndex]
      turnAssistants.push(assistant)
      assistantIndex += 1
      if (isTerminalAssistantItem(assistant)) break
    }
    if (turnAssistants.length > 0) {
      items.push(...mergeAssistantTimelineItems(buildRenderableTimeline({
        historyTimelineItems: [],
        userTimelineItems: [],
        liveTimelineItems: turnAssistants,
        livePreviewItems: [],
      })))
    }
  }
  return items
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

function isAssistantTimelineItem(item: TimelineRenderableItemModel): item is TimelineAssistantItem {
  return item.kind === 'assistant'
}

function mergeAssistantTimelineItems(items: TimelineRenderableItemModel[]): TimelineAssistantItem[] {
  const assistantItems = items.filter(isAssistantTimelineItem)
  if (assistantItems.length === 0) return []
  const [first, ...rest] = assistantItems
  const merged = rest.reduce((current, next) => ({
    ...current,
    atomIds: [...current.atomIds, ...next.atomIds],
    messages: [...current.messages, ...next.messages],
    anchorMessage: next.anchorMessage ?? current.anchorMessage,
    fragments: [...current.fragments, ...next.fragments] as TimelineFragment[],
    footer: (next.footer ?? current.footer) as TimelineAssistantFooter | undefined,
    overlays: [...(current.overlays || []), ...(next.overlays || [])],
  }), first)
  return [{
    ...merged,
    overlays: merged.overlays && merged.overlays.length > 0 ? merged.overlays : undefined,
  }]
}

export function buildFourSegmentTimelineSections(params: {
  historyFromServerItems: DisplayItem[]
  userTimelineItems: DisplayItem[]
  liveTimelineItems: DisplayItem[]
  livePreviewItems: TimelineLivePreview[]
  hasActiveRun: boolean
}): FourSegmentTimelineSections {
  const currentTurnUserItem = params.userTimelineItems[params.userTimelineItems.length - 1] ?? null
  const liveAssistantItems = params.liveTimelineItems.filter((item) => item.kind === 'assistant')
  const terminalAssistantItems = liveAssistantItems.filter(isTerminalAssistantItem)
  const committedUserCount = Math.min(terminalAssistantItems.length, params.userTimelineItems.length)
  const committedUsers = params.userTimelineItems.slice(0, committedUserCount)
  const lastCommittedAssistant = terminalAssistantItems[committedUserCount - 1]
  const lastCommittedAssistantIndex = lastCommittedAssistant
    ? liveAssistantItems.findIndex((item) => item.key === lastCommittedAssistant.key)
    : -1
  const committedAssistants = lastCommittedAssistantIndex >= 0
    ? liveAssistantItems.slice(0, lastCommittedAssistantIndex + 1)
    : []
  const committedTurnsLocalItems = buildCommittedTurnItems(committedUsers, committedAssistants)

  const currentUser =
    params.userTimelineItems.length > committedUserCount
      ? params.userTimelineItems[committedUserCount] as TimelineUserItem
      : null
  const currentTurnUserItems = currentUser
    ? renderSingleUserItem(currentUser)
    : []

  const currentLive = liveAssistantItems.slice(lastCommittedAssistantIndex + 1)

  const currentTurnAssistantItems = (() => {
    if (currentTurnUserItems.length === 0 && currentLive.length === 0 && params.livePreviewItems.length === 0) {
      return []
    }
    if (currentLive.length === 0 && params.livePreviewItems.length === 0 && currentTurnUserItems.length > 0) {
      return [buildCurrentTurnAssistantPlaceholder(currentUser!)]
    }
    return mergeAssistantTimelineItems(buildRenderableTimeline({
      historyTimelineItems: [],
      userTimelineItems: [],
      liveTimelineItems: currentLive,
      livePreviewItems: params.livePreviewItems,
    }))
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
