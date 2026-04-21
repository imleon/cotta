import { describe, expect, it } from 'vitest'
import {
  buildHistoryTimelineItems,
  buildLivePreviewItems,
  buildRenderableTimeline,
} from './buildTimeline'
import type {
  SessionMessage,
  StreamAnimationCursor,
  StreamRenderedPreviewState,
  StreamPreviewState,
} from '../../contract/runtime'
import type { TimelineAssistantItem, TimelineRenderableItemModel } from '../../models/timeline'

function createAssistantMessage(input: { id: string; timestamp: number }): SessionMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: input.timestamp,
    blocks: [],
    raw: {
      type: 'assistant',
      uuid: `uuid-${input.id}`,
      message: {
        id: input.id,
        content: [],
      },
    },
  }
}

function createUserMessage(input: { timestamp: number; content?: string }): SessionMessage {
  return {
    role: 'user',
    content: input.content ?? 'user',
    timestamp: input.timestamp,
  }
}

function createRenderedPreview(input: {
  phase: 'responding' | 'tool-input'
  text: string
  active?: boolean
  status?: 'active' | 'awaiting-materialization' | 'finalized'
}): StreamRenderedPreviewState {
  return {
    scope: {
      scopeKey: 'scope',
      anchorKind: 'message',
      anchorId: 'anchor',
    },
    phase: input.phase,
    status: input.status ?? 'active',
    active: input.active ?? true,
    blocks: [
      {
        kind: 'text',
        index: 0,
        shownText: input.text,
      },
    ],
  }
}

function expectAssistantItem(item: TimelineRenderableItemModel | undefined): TimelineAssistantItem {
  expect(item?.kind).toBe('assistant')
  return item as TimelineAssistantItem
}

describe('buildRenderableTimeline', () => {
  it('sorts renderable items by timestamp then key', () => {
    const result = buildRenderableTimeline({
      historyTimelineItems: [
        {
          kind: 'assistant',
          id: 'a-2',
          key: 'a-2',
          timestamp: 20,
          atomIds: [],
          messages: [],
          anchorMessage: createAssistantMessage({ id: 'm-2', timestamp: 20 }),
          fragments: [],
          footer: undefined,
        },
      ],
      userTimelineItems: [
        {
          kind: 'user',
          id: 'u-1',
          key: 'u-1',
          timestamp: 10,
          atomIds: [],
          message: createUserMessage({ timestamp: 10 }),
        },
      ],
      liveTimelineItems: [
        {
          kind: 'assistant',
          id: 'a-1',
          key: 'a-1',
          timestamp: 10,
          atomIds: [],
          messages: [],
          anchorMessage: createAssistantMessage({ id: 'm-1', timestamp: 10 }),
          fragments: [],
          footer: undefined,
        },
      ],
      livePreviewItems: [],
    })

    expect(result.map((item) => item.key)).toEqual(['a-1', 'u-1', 'a-2'])
  })

  it('attaches tool overlays to assistant items', () => {
    const result = buildRenderableTimeline({
      historyTimelineItems: [],
      userTimelineItems: [],
      liveTimelineItems: [
        {
          kind: 'assistant',
          id: 'assistant-1',
          key: 'assistant-1',
          timestamp: 100,
          atomIds: ['atom-1'],
          messages: [],
          anchorMessage: createAssistantMessage({ id: 'message-1', timestamp: 100 }),
          fragments: [
            {
              type: 'tool_use',
              name: 'Read',
              toolUseId: 'tool-1',
            },
          ],
          footer: {
            stopReason: 'end_turn',
            model: 'claude-test',
          },
        },
      ],
      livePreviewItems: [
        {
          kind: 'live_preview',
          layer: 'overlay',
          overlayKind: 'streaming_tool_use',
          anchor: {
            scopeKey: 'tool-1',
            anchorKind: 'tool_use',
            anchorId: 'tool-1',
          },
          id: 'overlay-1',
          key: 'overlay-1',
          timestamp: 101,
          preview: createRenderedPreview({ phase: 'tool-input', text: 'reading file' }),
        },
      ],
    })

    const assistant = expectAssistantItem(result[0])
    expect(result).toHaveLength(1)
    expect(assistant.overlays).toHaveLength(1)
    expect(assistant.overlays?.[0]?.id).toBe('overlay-1')
    expect(assistant.footer?.model).toBe('claude-test')
  })

  it('creates a synthetic host for unattached overlays', () => {
    const result = buildRenderableTimeline({
      historyTimelineItems: [],
      userTimelineItems: [],
      liveTimelineItems: [],
      livePreviewItems: [
        {
          kind: 'live_preview',
          layer: 'overlay',
          overlayKind: 'streaming_text',
          anchor: {
            scopeKey: 'scope-1',
            anchorKind: 'message',
            anchorId: 'message-42',
            messageId: 'message-42',
          },
          id: 'overlay-42',
          key: 'overlay-42',
          timestamp: 42,
          preview: createRenderedPreview({ phase: 'responding', text: 'drafting' }),
        },
      ],
    })

    const assistant = expectAssistantItem(result[0])
    expect(result).toHaveLength(1)
    expect(assistant.key).toBe('synthetic-assistant-message:message-42')
    expect(assistant.overlays?.[0]?.id).toBe('overlay-42')
  })

  it('preserves multiple thinking/tool_use/tool_result blocks within one assistant turn', () => {
    const items = buildHistoryTimelineItems([
      createUserMessage({ timestamp: 10, content: 'user ask' }),
      {
        role: 'assistant',
        content: '',
        timestamp: 20,
        blocks: [
          { type: 'thinking', text: 'first thinking' },
          { type: 'tool_use', name: 'Read', toolUseId: 'tool-read', input: { file_path: '/tmp/a.ts' } },
          { type: 'thinking', text: 'second thinking' },
          { type: 'tool_use', name: 'Bash', toolUseId: 'tool-bash', input: { command: 'pwd' } },
        ],
        raw: {
          type: 'assistant',
          uuid: 'uuid-multi-assistant',
          message: {
            id: 'multi-assistant',
            content: [
              { type: 'thinking', thinking: 'first thinking' },
              { type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: '/tmp/a.ts' } },
              { type: 'thinking', thinking: 'second thinking' },
              { type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'pwd' } },
            ],
          },
        },
      },
      {
        role: 'user',
        content: '',
        timestamp: 21,
        blocks: [
          { type: 'tool_result', toolUseId: 'tool-read', output: 'read-result' },
          { type: 'tool_result', toolUseId: 'tool-bash', output: 'bash-result' },
        ],
        raw: {
          type: 'user',
          uuid: 'uuid-multi-result',
          message: {
            id: 'multi-result',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-read', content: 'read-result' },
              { type: 'tool_result', tool_use_id: 'tool-bash', content: 'bash-result' },
            ],
          },
        },
      },
    ])

    const assistant = expectAssistantItem(items[1])
    expect(assistant.fragments.map((fragment) => fragment.type)).toEqual([
      'thinking',
      'tool_use',
      'thinking',
      'tool_use',
      'tool_result',
      'tool_result',
    ])
    expect(assistant.fragments.filter((fragment) => fragment.type === 'thinking')).toHaveLength(2)
    expect(assistant.fragments.filter((fragment) => fragment.type === 'tool_use')).toHaveLength(2)
    expect(assistant.fragments.filter((fragment) => fragment.type === 'tool_result')).toHaveLength(2)
  })
})

describe('buildLivePreviewItems', () => {
  it('filters finalized previews and sorts active previews by receivedAt then sequence', () => {
    const previewStates: Record<string, StreamPreviewState> = {
      a: {
        scope: {
          scopeKey: 'a',
          anchorKind: 'message',
          anchorId: 'message-a',
        },
        phase: 'responding',
        blocks: [{ kind: 'text', index: 0, text: 'A' }],
        receivedAt: 20,
        sequence: 2,
        active: true,
        status: 'active',
      } as StreamPreviewState,
      b: {
        scope: {
          scopeKey: 'b',
          anchorKind: 'message',
          anchorId: 'message-b',
        },
        phase: 'responding',
        blocks: [{ kind: 'text', index: 0, text: 'B' }],
        receivedAt: 20,
        sequence: 1,
        active: true,
        status: 'active',
      } as StreamPreviewState,
      c: {
        scope: {
          scopeKey: 'c',
          anchorKind: 'message',
          anchorId: 'message-c',
        },
        phase: 'responding',
        blocks: [{ kind: 'text', index: 0, text: 'C' }],
        receivedAt: 10,
        sequence: 1,
        active: false,
        status: 'finalized',
      } as StreamPreviewState,
    }

    const animationCursors: Record<string, StreamAnimationCursor> = {}

    const result = buildLivePreviewItems(previewStates, animationCursors)

    expect(result.map((item) => item.anchor.scopeKey)).toEqual(['b', 'a'])
  })
})
