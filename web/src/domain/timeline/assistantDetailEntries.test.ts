import { describe, expect, it } from 'vitest'
import {
  buildAssistantDetailEntries,
  buildToolGroupSummary,
  type AssistantDetailEntry,
} from './assistantDetailEntries'
import type { TimelineAssistantItem } from '../../models/timeline'

function createAssistantMessage(input: { id: string; timestamp: number }) {
  return {
    role: 'assistant' as const,
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

function createAssistantItem(fragments: TimelineAssistantItem['fragments']): TimelineAssistantItem {
  return {
    kind: 'assistant',
    id: 'assistant-1',
    key: 'assistant-1',
    timestamp: 100,
    atomIds: [],
    messages: [],
    anchorMessage: createAssistantMessage({ id: 'message-1', timestamp: 100 }),
    fragments,
    footer: {
      stopReason: 'end_turn',
      model: 'claude-test',
    },
  }
}

function expectToolGroup(entry: AssistantDetailEntry | undefined) {
  expect(entry?.kind).toBe('tool_group')
  return entry as Extract<AssistantDetailEntry, { kind: 'tool_group' }>
}

describe('buildToolGroupSummary', () => {
  it('summarizes mixed thinking and tool rows in natural order', () => {
    const item = createAssistantItem([
      { type: 'thinking', text: 'first plan', defaultHidden: false },
      {
        type: 'tool_use',
        name: 'Read',
        toolUseId: 'tool-read',
        input: { file_path: '/tmp/demo.ts' },
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-read',
        output: 'done',
      },
      { type: 'thinking', text: 'second plan', defaultHidden: false },
      {
        type: 'tool_use',
        name: 'Bash',
        toolUseId: 'tool-bash',
        input: { command: 'pwd' },
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-bash',
        output: 'ok',
      },
      { type: 'text', text: 'final answer' },
    ])

    const entries = buildAssistantDetailEntries(item)
    const group = expectToolGroup(entries[0])

    expect(group.summary).toBe('思考 2 次并调用工具 Read 1 次、Bash 1 次')
    expect(group.entries.map((entry) => entry.kind)).toEqual([
      'thinking',
      'read',
      'thinking',
      'bash',
    ])
    expect(entries[1]).toMatchObject({
      kind: 'text',
      fragment: { text: 'final answer' },
    })
  })

  it('keeps pure thinking sequences as standalone rows', () => {
    const item = createAssistantItem([
      { type: 'thinking', text: 'first plan', defaultHidden: false },
      { type: 'thinking', text: 'second plan', defaultHidden: false },
      { type: 'text', text: 'final answer' },
    ])

    const entries = buildAssistantDetailEntries(item)

    expect(entries.map((entry) => entry.kind)).toEqual(['thinking', 'thinking', 'text'])
  })
})
