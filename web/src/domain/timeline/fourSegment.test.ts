import { describe, expect, it } from 'vitest'
import type {
  TimelineAssistantItem,
  TimelineLivePreview,
  TimelineUserItem,
} from '../../models/timeline'
import { buildFourSegmentTimelineSections } from './fourSegment'

function createUserItem(key: string, timestamp: number): TimelineUserItem {
  return {
    kind: 'user',
    id: key,
    key,
    timestamp,
    atomIds: [],
    message: {
      role: 'user',
      content: key,
      timestamp,
    },
  }
}

function createAssistantItem(
  key: string,
  timestamp: number,
  fragments: TimelineAssistantItem['fragments'] = [],
  options?: { stopReason?: string },
): TimelineAssistantItem {
  return {
    kind: 'assistant',
    id: key,
    key,
    timestamp,
    atomIds: [],
    messages: [],
    anchorMessage: {
      role: 'assistant',
      content: '',
      timestamp,
      blocks: [],
      raw: {
        type: 'assistant',
        uuid: `uuid-${key}`,
        message: {
          id: key,
          content: [],
        },
      },
    },
    fragments,
    ...(options?.stopReason ? { footer: { stopReason: options.stopReason } } : {}),
  }
}

function createPreview(timestamp: number): TimelineLivePreview {
  return {
    kind: 'live_preview',
    layer: 'overlay',
    overlayKind: 'streaming_text',
    anchor: {
      scopeKey: 'scope',
      anchorKind: 'message',
      anchorId: 'resp-1',
    },
    id: 'preview-1',
    key: 'preview-1',
    timestamp,
    preview: {
      scope: {
        scopeKey: 'scope',
        anchorKind: 'message',
        anchorId: 'resp-1',
      },
      phase: 'responding',
      status: 'active',
      active: true,
      blocks: [
        {
          kind: 'text',
          index: 0,
          shownText: 'drafting',
        },
      ],
    },
  }
}

describe('buildFourSegmentTimelineSections', () => {
  it('creates an empty current assistant placeholder immediately after a prompt', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [createUserItem('user-a', 100)],
      livePreviewItems: [],
      hasActiveRun: true,
    })

    expect(sections.currentTurnUserItems.map((item) => item.key)).toEqual(['user-a'])
    expect(sections.currentTurnAssistantItems).toHaveLength(1)
    const assistant = sections.currentTurnAssistantItems[0] as TimelineAssistantItem
    expect(assistant.kind).toBe('assistant')
    expect(assistant.placeholder).toBe(true)
  })

  it('moves a finalized turn into committed local items immediately', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-b', 110, [{ type: 'text', text: 'B' }], { stopReason: 'end_turn' }),
      ],
      livePreviewItems: [],
      hasActiveRun: false,
    })

    expect(sections.committedTurnsLocalItems.map((item) => item.key)).toEqual(['user-a', 'assistant-b'])
    expect(sections.currentTurnUserItems).toHaveLength(0)
    expect(sections.currentTurnAssistantItems).toHaveLength(0)
  })

  it('moves the previous finalized turn into committed local items when a new prompt starts', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-b', 110, [{ type: 'text', text: 'B' }], { stopReason: 'end_turn' }),
        createUserItem('user-c', 200),
      ],
      livePreviewItems: [],
      hasActiveRun: true,
    })

    expect(sections.committedTurnsLocalItems.map((item) => item.key)).toEqual(['user-a', 'assistant-b'])
    expect(sections.currentTurnUserItems.map((item) => item.key)).toEqual(['user-c'])
    expect(sections.currentTurnAssistantItems).toHaveLength(1)
    const currentAssistant = sections.currentTurnAssistantItems[0] as TimelineAssistantItem
    expect(currentAssistant.placeholder).toBe(true)
  })

  it('does not keep finalized assistant content inside currentTurnAssistant', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-c', 200),
        createAssistantItem('assistant-d', 210, [{ type: 'text', text: 'D' }], { stopReason: 'end_turn' }),
      ],
      livePreviewItems: [],
      hasActiveRun: false,
    })

    expect(sections.currentTurnAssistantItems).toHaveLength(0)
    expect(sections.committedTurnsLocalItems.map((item) => item.key)).toEqual(['user-c', 'assistant-d'])
  })

  it('renders live preview in the current assistant section', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [createUserItem('user-a', 100)],
      livePreviewItems: [createPreview(101)],
      hasActiveRun: true,
    })

    expect(sections.currentTurnAssistantItems).toHaveLength(1)
    const assistant = sections.currentTurnAssistantItems[0] as TimelineAssistantItem
    expect(assistant.kind).toBe('assistant')
    expect(assistant.overlays?.[0]?.id).toBe('preview-1')
  })

  it('does not move a non-terminal tool assistant card into committed turns', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-tool', 110, [{ type: 'tool_use', name: 'WebSearch' }]),
      ],
      livePreviewItems: [],
      hasActiveRun: true,
    })

    expect(sections.committedTurnsLocalItems).toHaveLength(0)
    expect(sections.currentTurnUserItems.map((item) => item.key)).toEqual(['user-a'])
    expect(sections.currentTurnAssistantItems.map((item) => item.key)).toEqual(['assistant-tool'])
  })

  it('keeps pre-final thinking blocks when a turn moves into committed turns', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-turn', 110, [
          { type: 'thinking', text: 'pondering', defaultHidden: false },
          { type: 'text', text: '归来已百年' },
        ], { stopReason: 'end_turn' }),
      ],
      livePreviewItems: [],
      hasActiveRun: false,
    })

    expect(sections.currentTurnAssistantItems).toHaveLength(0)
    expect(sections.committedTurnsLocalItems.map((item) => item.key)).toEqual(['user-a', 'assistant-turn'])
    const committedAssistant = sections.committedTurnsLocalItems[1] as TimelineAssistantItem
    expect(committedAssistant.fragments.map((fragment) => fragment.type)).toEqual(['thinking', 'text'])
  })

  it('keeps current-turn tool and text in a single assistant card', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-a', 110, [
          { type: 'tool_use', name: 'WebSearch', toolUseId: 'tool-1' },
          { type: 'text', text: 'latest answer' },
        ]),
      ],
      livePreviewItems: [],
      hasActiveRun: true,
    })

    expect(sections.currentTurnAssistantItems).toHaveLength(1)
    const currentAssistant = sections.currentTurnAssistantItems[0] as TimelineAssistantItem
    expect(currentAssistant.fragments.map((fragment) => fragment.type)).toEqual(['tool_use', 'text'])
  })

  it('keeps tool_result visible in committed turns (no refresh needed)', () => {
    const sections = buildFourSegmentTimelineSections({
      historyFromServerItems: [],
      localTurnItems: [
        createUserItem('user-a', 100),
        createAssistantItem('assistant-final', 110, [
          { type: 'tool_use', name: 'WebSearch', toolUseId: 'tool-1' },
          { type: 'tool_result', toolUseId: 'tool-1', output: 'ok' },
          { type: 'text', text: 'done' },
        ], { stopReason: 'end_turn' }),
      ],
      livePreviewItems: [],
      hasActiveRun: false,
    })

    expect(sections.currentTurnAssistantItems).toHaveLength(0)
    const committedAssistant = sections.committedTurnsLocalItems[1] as TimelineAssistantItem
    expect(committedAssistant.fragments.map((fragment) => fragment.type)).toEqual(['tool_use', 'tool_result', 'text'])
  })
})
