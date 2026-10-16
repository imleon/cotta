import type { SessionTimelineResponse, TimelineBlock, TurnSummary } from '@cotta/shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

import {
  FileToolResultValue,
  fileLanguage,
  TimelineCodeContent,
  TimelineContentStack,
  TimelineDiffContent,
  TimelineKvContent,
  TimelineMarkdownContent,
  TimelineQuestionAnswersContent,
  TimelineQuestionFormContent,
  TimelineTextContent,
  TimelineTimestamp,
} from './content'
import {
  activityGroupSummary,
  applySdkMessage,
  assistantFrameSource,
  assistantResponseFrameForkMessageId,
  assistantResponseFrameHasVisibleContent,
  assistantResponseText,
  authoritativeTurnPhase,
  belongsToTimelineSession,
  COOKING_VERBS,
  canForkAssistantResponse,
  clearOptimisticOverlaySources,
  coalesceTranscriptSignal,
  effectiveActiveTurnId,
  fileMutationResult,
  groupAssistantResponseFrames,
  groupTimelineBlocks,
  isPrimaryUserMessage,
  LiveAssistantStreamAccumulator,
  localCommandRootForSubmission,
  materializeTimelineTurns,
  messageIdentity,
  type PrimaryMessageSource,
  prependOlderTimelineTurns,
  primaryMessageSource,
  projectTimelineTurn,
  type ResponseSource,
  rawMessageBlock,
  reconcileTimelineTurns,
  replaceTimelineTail,
  resolvePendingSubmission,
  sessionExternallyOwned,
  shouldHoldResponseSkeleton,
  shouldResetSessionTimeline,
  shouldShowResponseSkeleton,
  stableTurnVerb,
  submitStateFor,
  textFromData,
  thinkingBlockTitle,
  timelineTurnIndex,
  turnActiveTaskLabel,
  turnCookingLabel,
  turnDurationLabel,
  turnFooterState,
  turnPhase,
  turnVisibleDataToken,
  userBlocksFromMessage,
} from './core'
import { AssistantResponseFrameSkeleton, SessionAwaySummary, SessionTaskList } from './index'
import {
  AssistantResponseFrameView,
  activityGroupHasToolUseId,
  contentImagesFromTurnBlocks,
  PrimaryInputView,
  RawMessagesDialog,
  SubagentsDialog,
  TaskNotificationContent,
  TimelineBlockView,
} from './renderers'
import {
  AgentToolContent,
  AskUserQuestionToolContent,
  BashToolContent,
  EditWriteToolContent,
  EnterPlanModeToolContent,
  ExitPlanModeToolContent,
  McpToolContent,
  ReadToolContent,
  readResultContentImage,
  SendMessageToolContent,
  SkillToolContent,
  TaskOutputToolContent,
  TaskStopToolContent,
  TimelineBashCommandContent,
  ToolCallBlockView,
  UnsupportedFileToolContent,
  WebFetchToolContent,
  WebSearchToolContent,
} from './tools'

describe('timeline text extraction', () => {
  it('extracts strings and text blocks', () => {
    expect(textFromData('hello')).toBe('hello')
    expect(textFromData([{ type: 'text', text: 'hello' }])).toBe('hello')
  })
})

describe('effective active turn', () => {
  const latestTurn = { primaryUserUuid: 'latest', messages: [] }

  it('prefers an explicit id and only infers an unterminated external busy turn', () => {
    expect(effectiveActiveTurnId({ owner: 'cotta', phase: 'waiting', activeTurnId: 'explicit' }, latestTurn)).toBe('explicit')
    expect(effectiveActiveTurnId({ owner: 'external', phase: 'busy', activeTurnId: null }, latestTurn)).toBe('latest')
    expect(effectiveActiveTurnId({ owner: 'external', phase: 'busy', activeTurnId: null }, { ...latestTurn, durationMs: 1 })).toBeNull()
    expect(effectiveActiveTurnId({ owner: 'external', phase: 'busy', activeTurnId: null }, { ...latestTurn, messages: [{ type: 'result' }] })).toBeNull()
    expect(effectiveActiveTurnId({ owner: 'external', phase: 'busy', activeTurnId: null }, { ...latestTurn, messages: [{ type: 'cotta_live_turn_failed' }] })).toBeNull()
  })

  it.each(['waiting', 'background', 'idle'] as const)('does not infer an external %s turn', (phase) => {
    expect(effectiveActiveTurnId({ owner: 'external', phase, activeTurnId: null }, latestTurn)).toBeNull()
  })
})

describe('session task list', () => {
  it('hides empty lists and summarizes task statuses without active form', () => {
    expect(renderToStaticMarkup(createElement(SessionTaskList, { tasks: [] }))).toBe('')
    const html = renderToStaticMarkup(
      createElement(SessionTaskList, {
        tasks: [
          { id: '1', subject: 'Inspect history', status: 'in_progress', blockedBy: ['6'] },
          { id: '2', subject: 'Write summary', status: 'completed', blockedBy: [] },
        ],
      }),
    )

    expect(html).toContain('2 total (1 done, 1 in progress, 0 open)')
    expect(html).not.toContain('Hide done')
    expect(html).toContain('aria-label="Expand tasks"')
    expect(html).not.toContain('Inspect history')
    expect(html).not.toContain('aria-label="IN PROGRESS"')
    expect(html).not.toContain('aria-label="DONE"')
    expect(html).not.toContain('› blocked by #6')
    expect(html).not.toContain('session-task-label')
  })

  it('starts collapsed', () => {
    const html = renderToStaticMarkup(
      createElement(SessionTaskList, {
        tasks: Array.from({ length: 6 }, (_, index) => ({
          id: String(index + 1),
          subject: `Task ${index + 1}`,
          status: index === 0 ? ('in_progress' as const) : ('pending' as const),
          blockedBy: [],
        })),
      }),
    )

    expect(html).toContain('6 total')
    expect(html).toContain('data-expanded="false"')
    expect(html).not.toContain('Task 6')
  })
})

function userMessage(id: string, text = id): unknown {
  return { type: 'user', uuid: id, timestamp: '1970-01-01T00:00:00.001Z', message: { role: 'user', content: text } }
}

function messageFromBlock(block: TimelineBlock): unknown {
  const uuid = block.sourceEventIds[0] ?? block.id
  if (block.kind === 'user.message') return userMessage(uuid, typeof block.data === 'object' && block.data !== null && 'text' in block.data ? String(block.data.text) : uuid)
  if (block.kind === 'tool.result')
    return {
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.toolUseId, ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }] },
    }
  if (block.kind.startsWith('assistant.'))
    return {
      type: 'assistant',
      uuid,
      message: {
        id: block.apiMessageId ?? `msg:${uuid}`,
        role: 'assistant',
        content: [{ type: block.kind.slice('assistant.'.length), ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }],
      },
    }
  return { type: block.kind.replace(/^raw\./, ''), uuid, ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }
}

function userTurn(id: string, blocks: TimelineBlock[] = []): TurnSummary {
  return {
    primaryUserUuid: id,
    primaryUserTimestampMs: 1,
    messages: blocks.length > 0 ? blocks.map(messageFromBlock) : [userMessage(id)],
  }
}

function projected(turn: TurnSummary): TimelineBlock[] {
  return projectTimelineTurn(turn)
}

describe('timeline tool content components', () => {
  it('renders the seven agreed content primitives', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(TimelineDiffContent, { hunks: [hunk], filePath: 'a.ts' }),
        createElement(TimelineTextContent, { value: 'Waiting', tone: 'muted', italic: true }),
        createElement(TimelineMarkdownContent, { value: '**done**' }),
        createElement(TimelineCodeContent, { value: 'const value = 1', language: 'ts', defaultWrapped: false }),
        createElement(TimelineKvContent, { value: { file_path: 'a.ts' } }),
        createElement(TimelineQuestionFormContent, { questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A', description: 'Alpha' }] }] }),
        createElement(TimelineQuestionAnswersContent, { answers: { 'Pick one?': 'A' } }),
        createElement(TimelineBashCommandContent, { command: 'printf done' }),
      ),
    )

    expect(html).toContain('data-timeline-content="diff"')
    expect(html).toContain('data-timeline-content="text" data-tone="muted" data-italic="true"')
    expect(html).toContain('data-timeline-content="markdown"')
    expect(html).toContain('data-timeline-content="code"')
    expect(html).toContain('data-timeline-content="kv"')
    expect(html).toContain('data-timeline-content="question_form"')
    expect(html).toContain('data-timeline-content="question_answers"')
    expect(html).toContain('>1)</span><strong>Choice</strong>')
    expect(html).toContain('>1) </span>Pick one?</dt>')
    expect(html).toContain('data-timeline-content="bash_command"')
  })

  it('ignores no-newline diff metadata without advancing line numbers', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineDiffContent, { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '\\ No newline at end of file', '+new', '+next'] }], filePath: 'a.ts' }),
    )

    expect(html).not.toContain('No newline at end of file')
    expect(html).toContain('>1</span><span class="timeline-file-diff-marker">+</span>')
    expect(html).toContain('>2</span><span class="timeline-file-diff-marker">+</span>')
  })

  it('renders opt-in line numbers without changing the default code view', () => {
    const numbered = renderToStaticMarkup(createElement(TimelineCodeContent, { value: 'first\nsecond', language: 'text', lineNumbers: true }))
    const plain = renderToStaticMarkup(createElement(TimelineCodeContent, { value: 'first\nsecond', language: 'text' }))

    expect(numbered).toContain('timeline-code-line-number')
    expect(numbered).toContain('>1</span>')
    expect(numbered).toContain('>2</span>')
    expect(numbered).toContain('first')
    expect(numbered).toContain('second')
    expect(plain).not.toContain('timeline-code-line-number')
  })

  it('maps common infrastructure filenames to Shiki languages', () => {
    expect(fileLanguage('Dockerfile')).toBe('docker')
    expect(fileLanguage('docker/Dockerfile.dev')).toBe('docker')
    expect(fileLanguage('Makefile')).toBe('make')
    expect(fileLanguage('GNUmakefile')).toBe('make')
    expect(fileLanguage('.env.local')).toBe('dotenv')
    expect(fileLanguage('infra/main.tf')).toBe('terraform')
    expect(fileLanguage('infra/values.tfvars')).toBe('terraform')
    expect(fileLanguage('infra/config.hcl')).toBe('hcl')
    expect(fileLanguage('scripts/setup.ps1')).toBe('powershell')
  })

  it.each(['md', 'markdown'])('unwraps nested %s payload fences before markdown rendering', (language) => {
    const html = renderToStaticMarkup(
      createElement(TimelineMarkdownContent, {
        value: ['Before', '', '```' + language, '**Draft**', '', '```toml', 'command = ["tool"]', '```', '', 'After', '```', '', 'Outside'].join('\n'),
      }),
    )

    expect(html).toContain('Before')
    expect(html).toContain('<strong>Draft</strong>')
    expect(html).toContain('markdown-code-language">toml')
    expect(html).toContain('command = [&quot;tool&quot;]')
    expect(html).toContain('Outside')
    expect(html).not.toContain('language-markdown')
  })

  it('keeps non-nested markdown fences as code', () => {
    const html = renderToStaticMarkup(createElement(TimelineMarkdownContent, { value: ['```md', '# Heading', '```'].join('\n') }))

    expect(html).toContain('markdown-code-language">md')
    expect(html).toContain('# Heading')
  })

  it('unwraps nested markdown payload fences with longer or unlabeled inner fences', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineMarkdownContent, { value: ['```markdown', '**Draft**', '', '````ts', 'const value = 1', '````', '', '```', 'plain code', '```', '```'].join('\n') }),
    )

    expect(html).toContain('<strong>Draft</strong>')
    expect(html).toContain('markdown-code-language">ts')
    expect(html).toContain('const value = 1')
    expect(html).toContain('plain code')
    expect(html).not.toContain('language-markdown')
  })

  it('keeps malformed markdown payload fences as code', () => {
    const value = ['```md', '```toml', 'command = "tool"'].join('\n')
    const html = renderToStaticMarkup(createElement(TimelineMarkdownContent, { value }))

    expect(html).toContain('markdown-code-language">md')
    expect(html).toContain('command = &quot;tool&quot;')
  })

  it('preserves nested object fields in key-value content', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineKvContent, {
        value: {
          message: { text: 'Deployed', metadata: { requestId: 'req-123' } },
        },
      }),
    )

    expect(html).toContain('Deployed')
    expect(html).toContain('requestId')
    expect(html).toContain('req-123')
  })

  it('enables question controls only for an active matching request', () => {
    const questions = [{ header: 'Scope', question: 'Pick one?', options: [{ label: 'A' }], multiSelect: false }]
    const history = renderToStaticMarkup(createElement(TimelineQuestionFormContent, { questions }))
    const active = renderToStaticMarkup(createElement(TimelineQuestionFormContent, { questions, enabled: true }))

    expect(history).toContain('<fieldset disabled=""')
    expect(history).not.toContain('>Submit</button>')
    expect(active).not.toContain('<fieldset disabled=""')
    expect(active).toContain('<span>Other</span>')
    expect(active).toContain('>Submit</button>')
    expect(active).toContain('disabled="">Submit</button>')
    expect(active).toContain('>Cancel</button>')
  })

  it('uses only real options for preview questions and keeps a notes field', () => {
    const html = renderToStaticMarkup(createElement(TimelineQuestionFormContent, { questions: [{ question: 'Choose design', options: [{ label: 'Compact', preview: '# Compact' }] }], enabled: true }))

    expect(html).toContain('<span>Compact</span>')
    expect(html).toContain('aria-label="Notes for Choose design"')
    expect(html).not.toContain('<span>Other</span>')
  })

  it('keeps a model-provided Other distinct from the automatic custom option', () => {
    const html = renderToStaticMarkup(createElement(TimelineQuestionFormContent, { questions: [{ question: 'Choose', options: [{ label: 'Other', description: 'Model choice' }] }], enabled: true }))

    expect(html.match(/<span>Other(?:<small>Model choice<\/small>)?<\/span>/g)).toHaveLength(2)
    expect(html).toContain('Model choice')
  })
})

describe('generic tool fallback', () => {
  const toolUse: TimelineBlock = {
    id: 'report-findings',
    kind: 'assistant.tool_use',
    sourceEventIds: ['report-findings'],
    toolUseId: 'call-report-findings',
    data: { name: 'ReportFindings', input: { level: 'max' } },
  }
  const result = (content: unknown, error = false): TimelineBlock => ({
    id: 'report-findings-result',
    kind: 'tool.result',
    sourceEventIds: ['report-findings-result'],
    toolUseId: 'call-report-findings',
    data: { content, ...(error ? { is_error: true } : {}) },
  })

  it('uses the lightweight disclosure for tools without a specialized renderer', () => {
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('done')] }))

    expect(html).toContain('<details class="timeline-file-result-details" aria-label="Tool call ReportFindings"')
    expect(html).toContain('<strong class="font-medium">ReportFindings</strong>')
    expect(html).toContain('(level: max)')
    expect(html).not.toContain('timeline-disclosure-card')
    const nestedInput = renderToStaticMarkup(
      createElement(ToolCallBlockView, { toolUse: { ...toolUse, data: { name: 'ReportFindings', input: { findings: [{ summary: 'Issue' }] } } }, results: [result('done')], pendingPermission: true }),
    )
    expect(nestedInput).toContain('data-timeline-content="kv"')
    expect(nestedInput).not.toContain('data-timeline-content="input"')
  })

  it('keeps generic pending, error, permission, and unmatched states', () => {
    const pending = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [], pendingPermission: true }))
    const error = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('failed', true)], pendingPermission: true }))
    const unmatched = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: null, results: [result('done')] }))

    expect(pending).toContain('Pending')
    expect(pending).toContain('PermissionRequired')
    expect(pending).toContain(' open=""')
    expect(pending).not.toContain('>Input<')
    expect(pending).not.toContain('>Output<')
    expect(pending).toContain('class="timeline-tool-content-stack"')
    expect(pending).toContain('data-timeline-content="kv"')
    expect(pending).toContain('data-timeline-content="text"')
    expect(error).toContain('timeline-tool-error-label">ERROR')
    expect(error).toContain('data-timeline-content="text" data-tone="error"')
    expect(unmatched).toContain('<strong class="font-medium">Tool result</strong>')
    expect(unmatched).toContain('Unmatched')
  })

  it('marks structured results as unified content', () => {
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result({ status: 'completed' })], pendingPermission: true }))

    expect(html).toContain('data-timeline-content="code"')
    expect(html).toContain('&quot;status&quot;: &quot;completed&quot;')
  })
})

describe('specialized tool content composition', () => {
  const result = (id: string, content: string, error = false): TimelineBlock => ({ id, kind: 'tool.result', sourceEventIds: [id], data: { content, ...(error ? { is_error: true } : {}) } })

  it('disables a stale matching request once its result is present', () => {
    const html = renderToStaticMarkup(
      createElement(AskUserQuestionToolContent, {
        input: { questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }] },
        results: [result('answer', '', false)],
        questionRequest: { requestId: 'request', toolUseID: 'tool', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }] } },
        onAnswerQuestion: () => undefined,
      }),
    )

    expect(html).toContain('<fieldset disabled=""')
    expect(html).not.toContain('>Submit</button>')
  })

  it('composes pending and error content from the shared primitives', () => {
    const bash = renderToStaticMarkup(createElement(BashToolContent, { command: 'sleep 1', results: [] }))
    const edit = renderToStaticMarkup(createElement(EditWriteToolContent, { toolName: 'Edit', input: { file_path: 'a.ts' }, filePath: 'a.ts', results: [result('edit-error', 'failed', true)] }))
    const write = renderToStaticMarkup(createElement(EditWriteToolContent, { toolName: 'Write', input: { file_path: 'a.ts', content: 'value' }, filePath: 'a.ts', results: [] }))
    const read = renderToStaticMarkup(createElement(ReadToolContent, { results: [result('read-error', 'failed', true)] }))

    expect(bash.match(/timeline-tool-content-stack/g) ?? []).toHaveLength(1)
    expect(bash.match(/timeline-tool-content-scroll/g) ?? []).toHaveLength(1)
    expect(bash).toMatch(/timeline-tool-content-scroll[^>]*><div class="timeline-tool-bash-command" data-timeline-content="bash_command"/)
    expect(bash).toContain('data-timeline-content="bash_command"><div data-timeline-content="code"')
    expect(bash).toContain('data-tone="muted" data-italic="true"')
    expect(edit).toContain('data-timeline-content="kv"')
    expect(edit).toContain('data-tone="error"')
    expect(write).toContain('data-timeline-content="code"')
    expect(write).toContain('data-tone="muted" data-italic="true"')
    expect(read).toContain('data-tone="error"')
    expect(read.match(/timeline-tool-content-stack/g) ?? []).toHaveLength(1)
    expect(read.match(/timeline-tool-content-scroll/g) ?? []).toHaveLength(1)
  })
})

describe('MCP tool call', () => {
  const toolUse: TimelineBlock = {
    id: 'mcp',
    kind: 'assistant.tool_use',
    sourceEventIds: ['mcp'],
    toolUseId: 'call-mcp',
    data: { name: 'mcp__github__search_issues', input: { query: 'is:open' } },
  }
  const result = (toolUseResult: unknown, content = 'ignored content', error = false): TimelineBlock => ({
    id: `mcp-result-${String(toolUseResult)}`,
    kind: 'tool.result',
    sourceEventIds: ['mcp-result'],
    toolUseId: 'call-mcp',
    data: { content, toolUseResult, ...(error ? { is_error: true } : {}) },
  })

  it('renders Calling and Called MCP titles without an input summary', () => {
    const pending = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))
    const settled = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('done')] }))

    expect(pending).toContain('Calling MCP Github (search_issues)')
    expect(settled).toContain('Called MCP Github (search_issues)')
    expect(pending).not.toContain('mcp__github__search_issues')
    expect(pending).not.toContain('query: is:open')
  })

  it('renders pending and error content with kv and text primitives', () => {
    const pending = renderToStaticMarkup(createElement(McpToolContent, { input: { query: 'is:open' }, results: [] }))
    const error = renderToStaticMarkup(createElement(McpToolContent, { input: { query: 'is:open' }, results: [result('wire error', 'request failed', true)] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('wire error', 'request failed', true)] }))

    expect(pending).toContain('data-timeline-content="kv"')
    expect(pending).toContain('data-tone="muted" data-italic="true"')
    expect(error).toContain('data-timeline-content="kv"')
    expect(error).toContain('data-tone="error"')
    expect(error).toContain('request failed')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('prefers text toolUseResult values and falls back to result content', () => {
    const html = renderToStaticMarkup(
      createElement(McpToolContent, {
        input: { query: 'is:open' },
        results: [result('done'), result({ type: 'text', text: 'second' }), result({ status: 'completed' }, 'fallback content')],
      }),
    )

    expect(html).toContain('data-timeline-content="kv"')
    expect(html.match(/data-timeline-content="markdown"/g) ?? []).toHaveLength(3)
    expect(html).toContain('>done<')
    expect(html).toContain('>second<')
    expect(html).toContain('fallback content')
    expect(html).not.toContain('completed')
  })

  it('falls back to result content when toolUseResult is absent', () => {
    const html = renderToStaticMarkup(
      createElement(McpToolContent, {
        input: { query: 'is:open' },
        results: [result(undefined, 'live result')],
      }),
    )

    expect(html).toContain('live result')
    expect(html).toContain('data-timeline-content="markdown"')
  })
})

describe('AskUserQuestion tool call', () => {
  const input = {
    questions: [
      { question: 'Pick mode?', header: 'Mode', options: [{ label: 'Fast', description: 'Quick path', preview: 'FAST' }] },
      { question: 'Pick checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Tests', description: 'Run tests' }] },
    ],
  }
  const toolUse: TimelineBlock = { id: 'ask-user', kind: 'assistant.tool_use', sourceEventIds: ['ask-user'], toolUseId: 'call-ask-user', data: { name: 'AskUserQuestion', input } }
  const result: TimelineBlock = {
    id: 'ask-user-result',
    kind: 'tool.result',
    sourceEventIds: ['ask-user-result'],
    toolUseId: 'call-ask-user',
    data: { toolUseResult: { answers: { 'Pick mode?': 'Fast' }, annotations: { 'Pick mode?': { notes: 'ship it', preview: 'FAST' } } } },
  }

  it('preserves duplicate evidence and marks only the latest matching block interactive', () => {
    const items = groupTimelineBlocks([
      { ...toolUse, id: 'ask-user-live', sourceEventIds: ['ask-user-live'] },
      { ...toolUse, id: 'ask-user-transcript', sourceEventIds: ['ask-user-transcript'] },
    ])

    expect(items).toHaveLength(2)
    expect(items[0]).not.toHaveProperty('acceptsQuestionInput')
    expect(items[1]).toMatchObject({ type: 'tool-call', acceptsQuestionInput: true })
  })

  it('renders the question title and pending form', () => {
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))
    const body = renderToStaticMarkup(createElement(AskUserQuestionToolContent, { input, results: [] }))

    expect(card).toContain('<strong class="font-medium">AskingUserQuestion</strong><span class="timeline-file-result-summary-detail"> (Mode, Checks)</span>')
    expect(body).toContain('data-timeline-content="question_form"')
    expect(body).toContain('Pick mode?')
    expect(body).toContain('FAST')
    expect(body).not.toContain('data-timeline-content="question_answers"')
  })

  it('renders answers when result is present', () => {
    const html = renderToStaticMarkup(createElement(AskUserQuestionToolContent, { input, results: [result] }))

    expect(html).toContain('data-timeline-content="question_form"')
    expect(html).toContain('data-timeline-content="question_answers"')
    expect(html).toContain('Fast')
    expect(html).toContain('ship it')
  })

  it('renders error results with the question form and error badge', () => {
    const toolResult: TimelineBlock = {
      id: 'ask-user-error',
      kind: 'tool.result',
      sourceEventIds: ['ask-user-error'],
      toolUseId: 'call-ask-user',
      data: { content: 'question failed', is_error: true },
    }
    const body = renderToStaticMarkup(createElement(AskUserQuestionToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))

    expect(body).toContain('data-timeline-content="question_form"')
    expect(body).toContain('data-tone="error"')
    expect(body).toContain('question failed')
    expect(body).not.toContain('data-timeline-content="question_answers"')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })
})

describe('WebFetch tool call', () => {
  const input = { url: 'https://example.com', prompt: 'Summarize it' }
  const toolUse: TimelineBlock = { id: 'web-fetch', kind: 'assistant.tool_use', sourceEventIds: ['web-fetch'], toolUseId: 'call-web-fetch', data: { name: 'WebFetch', input } }
  const result = (id: string, toolUseResult: unknown, error = false, content = 'fallback **content**'): TimelineBlock => ({
    id,
    kind: 'tool.result',
    sourceEventIds: [id],
    toolUseId: 'call-web-fetch',
    data: { content, toolUseResult, ...(error ? { is_error: true } : {}) },
  })

  it('renders fetching and fetched titles', () => {
    const pending = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))
    const settled = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('web-fetch-result', 'done')] }))

    expect(pending).toContain('Fetching Web</strong><span class="timeline-file-result-summary-detail"> (https://example.com)</span>')
    expect(settled).toContain('Fetched Web</strong><span class="timeline-file-result-summary-detail"> (https://example.com)</span>')
  })

  it('renders pending and error content with kv and text primitives', () => {
    const pending = renderToStaticMarkup(createElement(WebFetchToolContent, { input, results: [] }))
    const error = renderToStaticMarkup(createElement(WebFetchToolContent, { input, results: [result('web-fetch-error', 'ignored', true, 'request failed')] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('web-fetch-card-error', 'ignored', true, 'request failed')] }))

    expect(pending).toContain('data-timeline-content="kv"')
    expect(pending).toContain('data-tone="muted" data-italic="true"')
    expect(error).toContain('data-timeline-content="kv"')
    expect(error).toContain('data-tone="error"')
    expect(error).toContain('request failed')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('renders text results as markdown and falls back to result content', () => {
    const html = renderToStaticMarkup(
      createElement(WebFetchToolContent, {
        input,
        results: [result('web-fetch-string', '**string**'), result('web-fetch-block', { type: 'text', text: '**block**' }), result('web-fetch-fallback', { status: 'ok' }, false, '**fallback**')],
      }),
    )

    expect(html.match(/data-timeline-content="markdown"/g) ?? []).toHaveLength(3)
    expect(html).toContain('<strong>string</strong>')
    expect(html).toContain('<strong>block</strong>')
    expect(html).toContain('<strong>fallback</strong>')
    expect(html).not.toContain('status')
  })
})

describe('WebSearch tool call', () => {
  const input = { query: 'cotta timeline' }
  const toolUse: TimelineBlock = { id: 'web-search', kind: 'assistant.tool_use', sourceEventIds: ['web-search'], toolUseId: 'call-web-search', data: { name: 'WebSearch', input } }
  const result = (id: string, toolUseResult: unknown, error = false, content: unknown = 'fallback content'): TimelineBlock => ({
    id,
    kind: 'tool.result',
    sourceEventIds: [id],
    toolUseId: 'call-web-search',
    data: { content, toolUseResult, ...(error ? { is_error: true } : {}) },
  })

  it('renders searching and searched titles from input query', () => {
    const pending = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))
    const settled = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [result('web-search-result', { results: [{ content: [] }] })] }))

    expect(pending).toContain('Searching Web</strong><span class="timeline-file-result-summary-detail"> (cotta timeline)</span>')
    expect(settled).toContain('Searched Web</strong><span class="timeline-file-result-summary-detail"> (cotta timeline)</span>')
  })

  it('renders search results from toolUseResult.results[].content only', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchToolContent, {
        input,
        results: [
          result(
            'web-search-result',
            {
              results: [{ content: [{ title: 'Right result', url: 'https://example.com', snippet: 'Good snippet' }] }],
            },
            false,
            [{ title: 'Wrong fallback' }],
          ),
        ],
      }),
    )

    expect(html).toContain('data-timeline-content="kv"')
    expect(html).toContain('data-timeline-content="web_search"')
    expect(html).toContain('Right result')
    expect(html).toContain('https://example.com')
    expect(html).toContain('Good snippet')
    expect(html).not.toContain('Wrong fallback')
  })

  it('renders string search result entries', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchToolContent, {
        input,
        results: [
          result('web-search-result-string', {
            results: ['Search capped; continue with existing info'],
          }),
        ],
      }),
    )

    expect(html).toContain('Search capped; continue with existing info')
  })

  it('renders unsupported search results as an error', () => {
    const toolResult = result('web-search-unsupported', { results: { content: [] } })
    const body = renderToStaticMarkup(createElement(WebSearchToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))

    expect(body).toContain('Unsupported WebSearch result')
    expect(body).toContain('data-tone="error"')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('does not mark content-only results as unsupported', () => {
    const toolResult = result('web-search-content-only', undefined, false, 'searched')
    const body = renderToStaticMarkup(createElement(WebSearchToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))

    expect(body).toContain('searched')
    expect(body).not.toContain('Unsupported WebSearch result')
    expect(card).not.toContain('timeline-tool-error-label')
  })
})

describe('SendMessage tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'send-message',
    kind: 'assistant.tool_use',
    sourceEventIds: ['send-message'],
    toolUseId: 'call-send-message',
    data: { name: 'SendMessage', input },
  })
  const result = (toolUseResult: unknown, errorKey?: 'is_error' | 'is_err', content?: string): TimelineBlock => ({
    id: `send-message-result-${errorKey ?? 'settled'}`,
    kind: 'tool.result',
    sourceEventIds: ['send-message-result'],
    toolUseId: 'call-send-message',
    data: { ...(content === undefined ? {} : { content }), toolUseResult, ...(errorKey ? { [errorKey]: true } : {}) },
  })
  const input = { to: 'code-review [c6fdd4]', summary: 'Review changes', message: 'Please review.', notify_when_idle: true }

  it('renders the recipient title verbatim and falls back when it is absent', () => {
    const addressed = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [] }))
    const bare = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse({ message: 'Hello' }), results: [] }))

    expect(addressed).toContain('<strong class="font-medium">SendMessage</strong><span class="timeline-file-result-summary-detail"> (To: @code-review [c6fdd4])</span>')
    expect(bare).toContain('<strong class="font-medium">SendMessage</strong>')
    expect(bare).not.toContain('(To:')
  })

  it('renders pending input as kv with waiting text', () => {
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(1)
    expect(html).toContain('code-review [c6fdd4]')
    expect(html).toContain('data-tone="muted" data-italic="true"')
    expect(html).toContain('Waiting for tool result…')
  })

  it('renders successful input and toolUseResult as kv', () => {
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [result({ success: true, message: 'Delivered' })] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [result({ success: true })] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(2)
    expect(html).toContain('Delivered')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it.each(['is_error', 'is_err'] as const)('renders %s results as errors with both kv blocks', (errorKey) => {
    const toolResult = result({ success: true, message: 'Transport failed' }, errorKey)
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(2)
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('renders transport error text when toolUseResult is absent', () => {
    const toolResult = result(undefined, 'is_error', 'recipient unavailable')
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(1)
    expect(html).toContain('recipient unavailable')
    expect(html).toContain('data-tone="error"')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('renders success false as an error', () => {
    const toolResult = result({ success: false, message: 'Not delivered' })
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(2)
    expect(html).toContain('Not delivered')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('renders unsupported results without exposing their payload', () => {
    const toolResult = result({ success: 'yes', secret: 'do not render' })
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(html.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(1)
    expect(html).toContain('data-tone="error"')
    expect(html).toContain('Unsupported SendMessage result')
    expect(html).not.toContain('do not render')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('does not mark content-only results as unsupported', () => {
    const toolResult = result(undefined, undefined, 'sent')
    const html = renderToStaticMarkup(createElement(SendMessageToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(html).toContain('sent')
    expect(html).not.toContain('Unsupported SendMessage result')
    expect(card).not.toContain('timeline-tool-error-label')
  })
})

describe('TaskOutput tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'task-output',
    kind: 'assistant.tool_use',
    sourceEventIds: ['task-output'],
    toolUseId: 'call-task-output',
    data: { name: 'TaskOutput', input },
  })
  const result = (id: string, toolUseResult: unknown, error = false, content = 'result'): TimelineBlock => ({
    id,
    kind: 'tool.result',
    sourceEventIds: [id],
    toolUseId: 'call-task-output',
    data: { content, toolUseResult, ...(error ? { is_error: true } : {}) },
  })
  const input = { task_id: 'task-1', block: true, timeout: 30000 }

  it('renders pending input with its task id only in the title', () => {
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [] }))
    const body = renderToStaticMarkup(createElement(TaskOutputToolContent, { input, results: [] }))

    expect(card).toContain('<strong class="font-medium">Waiting for task output</strong><span class="timeline-file-result-summary-detail"> (task-1)</span>')
    expect(card).not.toContain('30000')
    expect(body).toContain('data-timeline-content="kv"')
    expect(body).toContain('data-tone="muted" data-italic="true"')
    expect(body).toContain('Waiting for tool result…')
  })

  it('renders every successful prompt and markdown result', () => {
    const results = [result('result-1', { task: { prompt: 'First prompt', result: '**First result**' } }), result('result-2', { task: { prompt: 'Second prompt', result: '_Second result_' } })]
    const body = renderToStaticMarkup(createElement(TaskOutputToolContent, { input, results }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results }))

    expect(body).not.toContain('data-timeline-content="kv"')
    expect(body.match(/data-timeline-content="text"/g) ?? []).toHaveLength(2)
    expect(body.match(/data-timeline-content="markdown"/g) ?? []).toHaveLength(2)
    expect(body).toContain('First prompt')
    expect(body).toContain('<strong>First result</strong>')
    expect(body).toContain('Second prompt')
    expect(body).toContain('<em>Second result</em>')
    expect(card).toContain('<strong class="font-medium">TaskOutput</strong><span class="timeline-file-result-summary-detail"> (task-1)</span>')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('renders timeout TaskOutput results without the task payload', () => {
    const body = renderToStaticMarkup(
      createElement(TaskOutputToolContent, {
        input,
        results: [result('result-1', { retrieval_status: 'timeout', task: { prompt: 'Prompt', result: '**raw transcript**' } }, false, 'bounded content')],
      }),
    )

    expect(body).toContain('&quot;retrieval_status&quot;: &quot;timeout&quot;')
    expect(body).not.toContain('Prompt')
    expect(body).not.toContain('<strong>raw transcript</strong>')
    expect(body).not.toContain('bounded content')
    expect(body.match(/data-timeline-content="text"/g) ?? []).toHaveLength(1)
    expect(body).not.toContain('data-timeline-content="markdown"')
  })

  it('prioritizes errors over unsupported result shapes', () => {
    const results = [
      result('result-1', { task: { prompt: 'Valid prompt', result: 'Valid result' } }, false, 'valid transport'),
      result('result-2', { task: { prompt: 42, result: null } }, true, 'task failed'),
    ]
    const body = renderToStaticMarkup(createElement(TaskOutputToolContent, { input, results }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results }))

    expect(body.match(/data-tone="error"/g) ?? []).toHaveLength(2)
    expect(body).toContain('valid transport')
    expect(body).toContain('task failed')
    expect(body).not.toContain('Unsupported TaskOutput result')
    expect(body).not.toContain('Valid prompt')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('renders one unsupported error without exposing partial results', () => {
    const results = [
      result('result-1', { task: { prompt: 'Do not render prompt', result: 'Do not render result' } }),
      result('result-2', { task: { prompt: 'Malformed prompt', result: 42 }, secret: 'do not expose' }),
    ]
    const body = renderToStaticMarkup(createElement(TaskOutputToolContent, { input, results }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results }))

    expect(body.match(/Unsupported TaskOutput result/g) ?? []).toHaveLength(1)
    expect(body).not.toContain('Do not render prompt')
    expect(body).not.toContain('Do not render result')
    expect(body).not.toContain('do not expose')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('does not infer the task id from results', () => {
    const results = [result('result-1', { task: { task_id: 'result-task', prompt: 'Prompt', result: 'Result' } })]
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse({}), results }))

    expect(card).toContain('<strong class="font-medium">TaskOutput</strong>')
    expect(card).not.toContain('result-task')
  })

  it('does not mark content-only results as unsupported', () => {
    const results = [result('result-1', undefined, false, 'task output')]
    const body = renderToStaticMarkup(createElement(TaskOutputToolContent, { input, results }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results }))

    expect(body).toContain('task output')
    expect(body).not.toContain('Unsupported TaskOutput result')
    expect(card).not.toContain('timeline-tool-error-label')
  })
})

describe('TaskStop tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'task-stop',
    kind: 'assistant.tool_use',
    sourceEventIds: ['task-stop'],
    toolUseId: 'call-task-stop',
    data: { name: 'TaskStop', input },
  })
  const result = (toolUseResult: unknown, error = false, content = 'result'): TimelineBlock => ({
    id: `task-stop-result-${error ? 'error' : 'settled'}`,
    kind: 'tool.result',
    sourceEventIds: ['task-stop-result'],
    toolUseId: 'call-task-stop',
    data: { content, toolUseResult, ...(error ? { is_error: true } : {}) },
  })
  const input = { task_id: 'task-1' }

  it('renders pending input with waiting text', () => {
    const body = renderToStaticMarkup(createElement(TaskStopToolContent, { input, results: [] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [] }))

    expect(body).toContain('data-timeline-content="kv"')
    expect(body).toContain('task-1')
    expect(body).toContain('Waiting for tool result…')
    expect(card).toContain('TaskStopping</strong><span class="timeline-file-result-summary-detail"> (task-1)</span>')
  })

  it('renders successful input and toolUseResult as kv', () => {
    const body = renderToStaticMarkup(createElement(TaskStopToolContent, { input, results: [result({ success: true, message: 'Stopped' })] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [result({ success: true })] }))

    expect(body.match(/data-timeline-content="kv"/g) ?? []).toHaveLength(2)
    expect(body).toContain('task-1')
    expect(body).toContain('Stopped')
    expect(card).toContain('TaskStop</strong><span class="timeline-file-result-summary-detail"> (task-1)</span>')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('renders error and unsupported results as errors', () => {
    const error = result({ success: true }, true, 'stop failed')
    const unsupported = result('done')
    const errorBody = renderToStaticMarkup(createElement(TaskStopToolContent, { input, results: [error] }))
    const unsupportedBody = renderToStaticMarkup(createElement(TaskStopToolContent, { input, results: [unsupported] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [unsupported] }))

    expect(errorBody).toContain('stop failed')
    expect(errorBody).toContain('data-tone="error"')
    expect(unsupportedBody).toContain('Unsupported TaskStop result')
    expect(unsupportedBody).not.toContain('>done<')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('does not mark content-only results as unsupported', () => {
    const toolResult = result(undefined, false, 'stopped')
    const body = renderToStaticMarkup(createElement(TaskStopToolContent, { input, results: [toolResult] }))
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse(input), results: [toolResult] }))

    expect(body).toContain('stopped')
    expect(body).not.toContain('Unsupported TaskStop result')
    expect(card).not.toContain('timeline-tool-error-label')
  })
})

describe('EnterPlanMode tool call', () => {
  const toolUse: TimelineBlock = {
    id: 'enter-plan',
    kind: 'assistant.tool_use',
    sourceEventIds: ['enter-plan'],
    toolUseId: 'call-plan',
    data: { name: 'EnterPlanMode', input: {} },
  }
  const result = (content: unknown, error = false): TimelineBlock => ({
    id: 'enter-plan-result',
    kind: 'tool.result',
    sourceEventIds: ['enter-plan-result'],
    toolUseId: 'call-plan',
    data: { content, ...(error ? { is_error: true } : {}) },
  })

  it('renders pending as a static row', () => {
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))

    expect(html).toContain('Entering plan mode')
    expect(html).not.toContain('<details')
  })

  it('renders successful result content as markdown', () => {
    const toolResult = result('Entered plan mode.\n\n1. **Explore**')
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))
    const body = renderToStaticMarkup(createElement(EnterPlanModeToolContent, { results: [toolResult] }))

    expect(card).toContain('Entered plan mode')
    expect(card).toContain('<details')
    expect(body).toContain('data-timeline-content="markdown"')
    expect(body).toContain('<strong>Explore</strong>')
  })

  it('renders errors with the generic tool name and error text', () => {
    const toolResult = result('Could not enter plan mode', true)
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))
    const body = renderToStaticMarkup(createElement(EnterPlanModeToolContent, { results: [toolResult] }))

    expect(card).toContain('<strong class="font-medium">EnterPlanMode</strong>')
    expect(card).toContain('timeline-tool-error-label')
    expect(body).toContain('Could not enter plan mode')
    expect(body).toContain('data-tone="error"')
  })
})

describe('ExitPlanMode tool call', () => {
  const plan = '# Plan\n\n- Implement it'
  const path = '/home/user/.claude/plans/example.md'
  const toolUse: TimelineBlock = {
    id: 'exit-plan',
    kind: 'assistant.tool_use',
    sourceEventIds: ['exit-plan'],
    toolUseId: 'call-exit-plan',
    data: { name: 'ExitPlanMode', input: { plan, planFilePath: path } },
  }
  const result = (content: string, error = false, toolDenialKind?: string): TimelineBlock => ({
    id: 'exit-plan-result',
    kind: 'tool.result',
    sourceEventIds: ['exit-plan-result'],
    toolUseId: 'call-exit-plan',
    data: { content, ...(error ? { is_error: true } : {}), ...(toolDenialKind ? { toolDenialKind } : {}) },
  })

  it('renders the plan file path and only labels a real pending approval', () => {
    const historicalCard = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [] }))
    const pendingCard = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [], pendingPermission: true }))
    const body = renderToStaticMarkup(createElement(ExitPlanModeToolContent, { plan, results: [] }))

    expect(historicalCard).not.toContain('ApprovalRequired')
    expect(pendingCard).toContain('<details class="timeline-file-result-details" aria-label="Tool call ExitPlanMode" open="">')
    expect(pendingCard).toContain(`<strong class="font-medium">ExitPlanMode</strong><span class="timeline-file-result-summary-detail"> (${path})</span>`)
    expect(pendingCard).toContain('ApprovalRequired')
    expect(pendingCard).not.toContain('PermissionRequired')
    expect(pendingCard).not.toContain('Pending')
    expect(body).toContain('timeline-exit-plan-unbounded-content-stack')
    expect(body).toContain('data-timeline-content="markdown"')
    expect(body).toContain('<h1>Plan</h1>')
  })

  it('renders successful result content without repeating the input plan', () => {
    const toolResult = result('User has **approved** your plan.')
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))
    const body = renderToStaticMarkup(createElement(ExitPlanModeToolContent, { plan, results: [toolResult] }))

    expect(card).toContain(' open=""')
    expect(body).toContain('timeline-exit-plan-unbounded-content-stack')
    expect(body).toContain('<strong>approved</strong>')
    expect(body).not.toContain('Implement it')
  })

  it('renders user feedback as a revision request', () => {
    const toolResult = result('Plan was rejected', true, 'user-rejected')
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))
    const body = renderToStaticMarkup(createElement(ExitPlanModeToolContent, { plan, results: [toolResult] }))

    expect(card).not.toContain(' open=""')
    expect(card).not.toContain('timeline-tool-error-label')
    expect(body).toContain('<h1>Plan</h1>')
    expect(body).toContain('Plan was rejected')
    expect(body).toContain('data-tone="default"')
    expect(body).not.toContain('data-tone="error"')
  })

  it.each([undefined, 'permission-rule'])('renders non-feedback failures as errors (%s)', (toolDenialKind) => {
    const toolResult = result('Tool permission stream closed before response received', true, toolDenialKind)
    const card = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse, results: [toolResult] }))
    const body = renderToStaticMarkup(createElement(ExitPlanModeToolContent, { plan, results: [toolResult] }))

    expect(card).toContain('timeline-tool-error-label')
    expect(body).toContain('data-tone="error"')
  })

  it('preserves the transcript denial kind on projected tool results', () => {
    const [toolResult] = userBlocksFromMessage(
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-exit-plan', content: 'Plan was rejected', is_error: true }] },
        toolDenialKind: 'user-rejected',
      },
      'exit-plan-result',
    )

    expect(toolResult?.data).toMatchObject({ is_error: true, toolDenialKind: 'user-rejected' })
  })
})

describe('Agent tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'agent',
    kind: 'assistant.tool_use',
    sourceEventIds: ['agent'],
    toolUseId: 'call-agent',
    data: { name: 'Agent', input },
  })
  const result = (toolUseResult: unknown, error = false): TimelineBlock => ({
    id: 'agent-result',
    kind: 'tool.result',
    sourceEventIds: ['agent-result'],
    toolUseId: 'call-agent',
    data: { toolUseResult, ...(error ? { is_error: true } : {}) },
  })

  it('renders the Agent title from its configured fields', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ subagent_type: 'Explore', run_in_background: false, description: 'Inspect dependencies', prompt: 'Investigate' }),
        results: [result({ status: 'async_launched', isAsync: true })],
      }),
    )

    expect(html).toContain('<strong class="font-medium">Agent</strong><span class="timeline-file-result-summary-detail"> (Explore · Background · Inspect dependencies)</span>')
    expect(html).not.toContain('<strong class="font-medium">Agent (Explore')
  })

  it('renders pending Agent content as prompt and waiting text', () => {
    const html = renderToStaticMarkup(createElement(AgentToolContent, { input: { prompt: 'Investigate' }, results: [] }))

    expect(html.match(/data-timeline-content="text"/g) ?? []).toHaveLength(2)
    expect(html).toContain('Investigate')
    expect(html).toContain('Waiting for tool result…')
    expect(html).toContain('data-tone="muted" data-italic="true"')
  })

  it('renders prompt and wire error result for failed Agents', () => {
    const html = renderToStaticMarkup(createElement(AgentToolContent, { input: { prompt: 'Show prompt', run_in_background: true }, results: [result('Agent failed', true)] }))

    expect(html.match(/data-timeline-content="text"/g) ?? []).toHaveLength(2)
    expect(html).toContain('Show prompt')
    expect(html).toContain('Agent failed')
    expect(html).toContain('data-tone="error"')
    expect(html).not.toContain('data-timeline-content="kv"')
  })

  it('renders sync Agent prompt and concatenated markdown content', () => {
    const html = renderToStaticMarkup(
      createElement(AgentToolContent, {
        input: { prompt: 'Investigate', run_in_background: true },
        results: [result({ status: 'completed', content: [{ type: 'text', text: '**First**' }, { type: 'image' }, { type: 'text', text: 'Second' }] })],
      }),
    )

    expect(html.match(/data-timeline-content="text"/g) ?? []).toHaveLength(1)
    expect(html).toContain('Investigate')
    expect(html).toContain('data-timeline-content="markdown"')
    expect(html).toContain('<strong>First</strong>')
    expect(html).toContain('Second')
    expect(html).not.toContain('data-timeline-content="kv"')
  })

  it('falls back to result content for sync Agents without wire text', () => {
    const html = renderToStaticMarkup(
      createElement(AgentToolContent, {
        input: { prompt: 'Investigate' },
        results: [{ id: 'agent-result', kind: 'tool.result', sourceEventIds: ['agent-result'], toolUseId: 'call-agent', data: { content: 'Agent done' } }],
      }),
    )

    expect(html).toContain('Investigate')
    expect(html).toContain('Agent done')
    expect(html).toContain('data-timeline-content="markdown"')
  })

  it('renders async Agent wire result as KV only', () => {
    const html = renderToStaticMarkup(
      createElement(AgentToolContent, {
        input: { prompt: 'Investigate', run_in_background: true },
        results: [result({ status: 'async_launched', isAsync: true, agentId: 'agent-1' })],
      }),
    )

    expect(html).not.toContain('data-timeline-content="text"')
    expect(html).not.toContain('Investigate')
    expect(html).toContain('data-timeline-content="kv"')
    expect(html).toContain('async_launched')
    expect(html).toContain('agent-1')
  })
})

describe('Skill tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'skill',
    kind: 'assistant.tool_use',
    sourceEventIds: ['skill'],
    toolUseId: 'call-skill',
    data: { name: 'Skill', input },
  })
  const result = (content: string, error = false): TimelineBlock => ({
    id: 'skill-result',
    kind: 'tool.result',
    sourceEventIds: ['skill-result'],
    toolUseId: 'call-skill',
    data: { content, ...(error ? { is_error: true } : {}) },
  })

  it('keeps a Skill pending when linked isMeta arrives before tool_result', () => {
    const items = groupTimelineBlocks(
      projectTimelineTurn({
        primaryUserUuid: 'user-1',
        messages: [
          userMessage('user-1', 'load skill'),
          {
            type: 'assistant',
            uuid: 'assistant-1',
            message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-skill', name: 'Skill', input: { skill: 'ponytail:ponytail' } }] },
          },
          { type: 'user', uuid: 'meta-1', isMeta: true, sourceToolUseID: 'call-skill', message: { role: 'user', content: [{ type: 'text', text: '**loaded**' }] } },
        ],
      }),
    )

    expect(items).toMatchObject([
      { type: 'block', block: expect.objectContaining({ kind: 'user.message' }) },
      {
        type: 'tool-call',
        toolUse: expect.objectContaining({ kind: 'assistant.tool_use' }),
        results: [expect.objectContaining({ kind: 'skill.meta', data: expect.objectContaining({ text: '**loaded**' }) })],
      },
    ])
    const skill = items.find((item) => item.type === 'tool-call')
    expect(skill?.type === 'tool-call' && skill.results.some((result) => result.kind === 'tool.result')).toBe(false)
    if (!skill || skill.type !== 'tool-call') throw new Error('expected Skill tool call')
    const body = renderToStaticMarkup(createElement(SkillToolContent, { input: { skill: 'ponytail:ponytail' }, results: skill.results }))
    expect(body).toContain('Waiting for skill result…')
  })

  it('renders linked Skill input metadata and meta as markdown', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ skill: 'ponytail', args: 'full' }),
        results: [result('Launching skill: ponytail'), { id: 'meta-1', kind: 'skill.meta', sourceEventIds: ['meta-1'], toolUseId: 'call-skill', data: { text: '**loaded**' } }],
      }),
    )
    const body = renderToStaticMarkup(
      createElement(SkillToolContent, {
        input: { skill: 'ponytail', args: 'full' },
        results: [result('Launching skill: ponytail'), { id: 'meta-1', kind: 'skill.meta', sourceEventIds: ['meta-1'], toolUseId: 'call-skill', data: { text: '**loaded**' } }],
      }),
    )

    expect(html).toContain('<strong class="font-medium">Skill</strong><span class="timeline-file-result-summary-detail"> (ponytail)</span>')
    expect(html).not.toContain('full)</span>')
    expect(html).not.toContain('Pending')
    expect(body).toContain('data-timeline-content="kv"')
    expect(body).toContain('args')
    expect(body).toContain('full')
    expect(body).not.toContain('toolUseResult')
    expect(body).toContain('result')
    expect(body).toContain('Launching skill: ponytail')
    expect(body).toContain('data-timeline-content="markdown"')
    expect(body).toContain('<strong>loaded</strong>')
  })

  it('renders Skill pending state as a full card with input kv and pending text', () => {
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse({ skill: 'find-session', args: 'recent query' }), results: [] }))
    const body = renderToStaticMarkup(createElement(SkillToolContent, { input: { skill: 'find-session', args: 'recent query' }, results: [] }))

    expect(html).toContain('<strong class="font-medium">Skill</strong><span class="timeline-file-result-summary-detail"> (find-session)</span>')
    expect(html).not.toContain('Pending')
    expect(body).toContain('data-timeline-content="kv"')
    expect(body).toContain('recent query')
    expect(body).toContain('Waiting for skill result…')
    expect(body).toContain('data-italic="true"')
  })

  it('renders Skill error state', () => {
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, { toolUse: toolUse({ skill: 'claude-api', args: 'docs' }), results: [result('skill failed', true)] }))
    const body = renderToStaticMarkup(createElement(SkillToolContent, { input: { skill: 'claude-api', args: 'docs' }, results: [result('skill failed', true)] }))

    expect(html).toContain('<strong class="font-medium">Skill</strong><span class="timeline-file-result-summary-detail"> (claude-api)</span>')
    expect(html).toContain('ERROR')
    expect(body).toContain('skill failed')
    expect(body).toContain('data-tone="error"')
  })
})

describe('Bash tool call', () => {
  const toolUse = (input: Record<string, unknown>): TimelineBlock => ({
    id: 'bash',
    kind: 'assistant.tool_use',
    sourceEventIds: ['bash'],
    toolUseId: 'call-bash',
    data: { name: 'Bash', input },
  })
  const result = (id: string, content: string, errorKey?: 'is_error' | 'is_err'): TimelineBlock => ({
    id,
    kind: 'tool.result',
    sourceEventIds: [id],
    toolUseId: 'call-bash',
    data: { content, ...(errorKey ? { [errorKey]: true } : {}) },
  })

  it('renders one complete truncatable summary and the full command as Bash', () => {
    const command = `printf '${'x'.repeat(90)}'`
    const description = `Describe ${'y'.repeat(90)}`
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command, description, timeout: 120000, run_in_background: true, dangerouslyDisableSandbox: true }),
        results: [result('success', 'done')],
      }),
    )

    expect(html).toContain('<details class="timeline-file-result-details"')
    expect(html).not.toContain(' open=""')
    expect(html).toContain('<strong class="font-medium">Bash</strong>')
    expect(html).not.toContain('bg-[var(--tl-surface)]')
    const summary = `Bash (Background · Outside sandbox · ${description})`
    expect(html).toContain(`title="${summary}"`)
    expect(html).toContain(summary)
    expect(html).not.toContain('120000')
    expect(html).not.toContain('2 min')
    expect(html).not.toContain('truncate')
    expect(html).not.toContain('shrink-0')
    expect(html).not.toContain('>Command</strong>')
    expect(html).not.toContain('>Output</strong>')
    expect(html).not.toContain('language-bash')
    expect(html).not.toContain('language-text')
    expect(html).not.toContain(`$ ${command.replaceAll("'", '&#x27;')}`)
  })

  it('defers Bash command body formatting until expanded', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'first\nsecond\n  third' }),
        results: [result('success', 'done')],
      }),
    )

    expect(html).not.toContain('$ first\n  second\n    third')
  })

  it('uses a bounded command summary when description is absent', () => {
    const command = `cat <<'EOF'\n${'x'.repeat(180)}\nEOF`
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command }),
        results: [result('success', 'done')],
      }),
    )

    const summary = `Bash (cat &lt;&lt;&#x27;EOF&#x27; ${'x'.repeat(107)}…)`
    expect(html).toContain(`title="${summary}"`)
    expect(html).toContain(summary)
    expect(html).not.toContain(`${'x'.repeat(180)}`)
  })

  it('renders successful Bash output as unwrapped code', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'printf done', run_in_background: false, dangerouslyDisableSandbox: false }),
        results: [result('success', 'first\nsecond')],
      }),
    )

    expect(html).not.toContain('class="markdown-code-group timeline-result-scroll"')
    expect(html.match(/class="markdown-code-block"/g) ?? []).toHaveLength(0)
    expect(html).not.toContain('data-wrap="false"')
    expect(html).not.toContain('language-bash')
    expect(html).not.toContain('markdown-code-section-muted markdown-code-section-indented')
    expect(html).not.toContain('first\nsecond')
    expect(html).not.toContain('Background')
    expect(html).not.toContain('Outside sandbox')
  })

  it('renders PermissionRequired badge for pending approval tool calls', () => {
    const pending = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'npm test' }),
        results: [],
        pendingPermission: true,
      }),
    )
    const normal = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'npm test' }),
        results: [],
      }),
    )

    expect(pending).toContain('<span class="timeline-tool-permission-label">PermissionRequired</span>')
    expect(pending).toContain(' open=""')
    expect(normal).not.toContain('PermissionRequired')
    expect(normal).not.toContain(' open=""')
  })

  it.each(['is_error', 'is_err'] as const)('renders %s Bash output as error text', (errorKey) => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'exit 1' }),
        results: [result('failure', 'Exit code 1\nfailed', errorKey)],
      }),
    )

    expect(html).not.toContain('markdown-code-section-error markdown-code-section-indented')
    expect(html).not.toContain('timeline-block-danger')
    expect(html).toContain('<span class="timeline-tool-error-label">ERROR</span>')
    expect(html).not.toContain(' · <span class="timeline-tool-error-label">ERROR</span>')
    expect(html).toContain('title="Bash (exit 1) ERROR"')
    expect(html).not.toContain('Exit code 1\nfailed')
    expect(html).not.toContain('class="markdown-code-group timeline-result-scroll"')
    expect(html.match(/class="markdown-code-block"/g) ?? []).toHaveLength(0)
    expect(html).not.toContain('language-bash')
    expect(html).not.toContain('language-text')
    expect(html).not.toContain('markdown-code-section-muted')
  })

  it.each([
    ['Read', 'Reading'],
    ['Edit', 'Editing'],
    ['Write', 'Writing'],
  ] as const)('renders pending %s with progressive title', (toolName, title) => {
    const input = toolName === 'Write' ? { file_path: '/repo/src/a.ts', content: 'export const attempted = true' } : { file_path: '/repo/src/a.ts' }
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: toolName, kind: 'assistant.tool_use', sourceEventIds: [toolName], toolUseId: 'call-file', data: { name: toolName, cwd: '/repo', input } },
        results: [],
      }),
    )

    expect(html).toContain(`title="${title} (src/a.ts)"`)
    expect(html).toContain(`<strong class="font-medium">${title}</strong><span class="timeline-file-result-summary-detail"> (src/a.ts)</span>`)
  })

  it.each([
    ['Edit', 'Update', 'is_error'],
    ['Write', 'Write', 'is_err'],
  ] as const)('renders %s errors with file-style title, input, and result', (toolName, title, errorKey) => {
    const input = toolName === 'Write' ? { file_path: '/repo/src/a.ts', content: 'export const attempted = true' } : { file_path: '/repo/src/a.ts', old_string: 'before', new_string: 'after' }
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: toolName, kind: 'assistant.tool_use', sourceEventIds: [toolName], toolUseId: 'call-file', data: { name: toolName, cwd: '/repo', input } },
        results: [{ id: 'file-error', kind: 'tool.result', sourceEventIds: ['file-error'], toolUseId: 'call-file', data: { [errorKey]: true, cwd: '/repo', content: 'failed to update file' } }],
      }),
    )

    expect(html).toContain('class="timeline-file-result-details"')
    expect(html).not.toContain('class="timeline-result-scroll grid min-w-0"')
    expect(html).not.toContain(' open=""')
    expect(html).toContain(`title="${title} (src/a.ts) ERROR"`)
    expect(html).toContain(
      `<strong class="font-medium">${title}</strong><span class="timeline-file-result-summary-detail"> (src/a.ts)</span></span><span class="timeline-tool-error-label">ERROR</span>`,
    )
    expect(html).not.toContain('>Input<')
    expect(html).not.toContain('markdown-code-block')
    expect(html).not.toContain('language-ts')
    expect(html).not.toContain('export const attempted = true')
    expect(html).not.toContain('<dt')
    expect(html).not.toContain('file_path')
    expect(html).not.toContain('/repo/src/a.ts</dd>')
    expect(html).not.toContain('>Result<')
    expect(html).not.toContain('timeline-file-error-result')
    expect(html).not.toContain('failed to update file')
    expect(html).not.toContain('bg-[var(--tl-danger-soft)]')
  })

  it('keeps transcript cwd for failed Edit results with string toolUseResult', () => {
    const item = groupTimelineBlocks(
      projectTimelineTurn({
        primaryUserUuid: 'u1',
        messages: [
          userMessage('u1'),
          {
            type: 'assistant',
            uuid: 'a1',
            cwd: '/repo',
            message: { id: 'msg-a1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-file', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } }] },
          },
          {
            type: 'user',
            uuid: 'r1',
            cwd: '/repo',
            toolUseResult: 'failed to update file',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-file', is_error: true, content: 'failed to update file' }] },
          },
        ],
      }),
    ).find((value) => value.type === 'tool-call')

    expect(item?.type).toBe('tool-call')
    if (item?.type !== 'tool-call') throw new Error('expected tool call')
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, item))

    expect(html).toContain('title="Update (src/a.ts) ERROR"')
    expect(html).not.toContain('title="Update (/repo/src/a.ts) ERROR"')
  })

  it('defers mixed Edit error result bodies', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Edit', kind: 'assistant.tool_use', sourceEventIds: ['Edit'], toolUseId: 'call-edit', data: { name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } } },
        results: [result('first', 'before-error'), result('second', 'after-error', 'is_error')].map((item) => ({ ...item, toolUseId: 'call-edit' })),
      }),
    )

    expect(html).not.toContain('before-error')
    expect(html).not.toContain('after-error')
    expect(html).not.toContain('timeline-file-error-result')
  })

  it('shows the waiting state before Bash has a result', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'sleep 1' }),
        results: [],
      }),
    )

    expect(html).not.toContain('open=""')
    expect(html).not.toContain('Pending')
    expect(html).not.toContain('class="markdown-code-group timeline-result-scroll"')
    expect(html).not.toContain('markdown-code-group-message')
    expect(html).not.toContain('Waiting for execution result…')
  })

  it('shows the pending state before Read has a result', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' } } },
        results: [],
      }),
    )

    expect(html).toContain('aria-label="Tool call Read"')
    expect(html).not.toContain('Pending')
    expect(html).not.toContain('timeline-file-result-static')
  })

  it('preserves Read text output when no valid image is available', () => {
    const results: TimelineBlock[] = [{ id: 'read-result', kind: 'tool.result', sourceEventIds: ['read-result'], toolUseId: 'call-read', data: { content: 'file text' } }]
    const body = renderToStaticMarkup(createElement(ReadToolContent, { results }))
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' } } },
        results,
      }),
    )

    expect(body).toContain('file text')
    expect(body).not.toContain('Unsupported Read result')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('preserves structured Read file text before image selection', () => {
    const results: TimelineBlock[] = [
      {
        id: 'read-result',
        kind: 'tool.result',
        sourceEventIds: ['read-result'],
        toolUseId: 'call-read',
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          toolUseResult: { type: 'text', file: { filePath: 'image.png', content: 'actual file text' } },
        },
      },
    ]

    const body = renderToStaticMarkup(createElement(ReadToolContent, { results }))

    expect(body).toContain('actual file text')
    expect(body).not.toContain('data-timeline-content="image"')
  })

  it('preserves raw mixed Read content blocks in order instead of synthesizing a wire image', () => {
    const results: TimelineBlock[] = [
      {
        id: 'read-result',
        kind: 'tool.result',
        sourceEventIds: ['read-result'],
        toolUseId: 'call-read',
        data: {
          content: [
            { type: 'text', text: 'before' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            { type: 'text', text: 'after' },
            { type: 'document', source: { type: 'text', data: 'document text' } },
            { type: 'unsupported', value: 'unsupported' },
          ],
          toolUseResult: { type: 'image', file: { type: 'image/gif', base64: gif } },
        },
      },
    ]

    const body = renderToStaticMarkup(createElement(ReadToolContent, { results }))

    expect(body.indexOf('before')).toBeLessThan(body.indexOf('after'))
    expect(body.indexOf('after')).toBeLessThan(body.indexOf('document text'))
    expect(body.indexOf('document text')).toBeLessThan(body.indexOf('unsupported type (unsupported)'))
  })

  it.each([
    [
      'content blocks',
      {
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          { type: 'text', text: 'after' },
        ],
      },
    ],
    ['image content', { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }],
    ['image transport', { toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } }],
    ['image URL', { content: [{ type: 'image', source: { type: 'url', url: 'https://images.example/read.png' } }] }],
    ['image file', { content: [{ type: 'image', source: { type: 'file', file_id: 'file_read' } }] }],
  ])('renders supported Read %s', (_label, data) => {
    const results: TimelineBlock[] = [{ id: 'read-result', kind: 'tool.result', sourceEventIds: ['read-result'], toolUseId: 'call-read', data }]
    const body = renderToStaticMarkup(createElement(ReadToolContent, { results }))
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'image.png' } } },
        results,
      }),
    )

    expect(body).not.toContain(png)
    expect(card).not.toContain('Unsupported Read result')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('marks invalid Read image content as unsupported', () => {
    const results: TimelineBlock[] = [
      {
        id: 'read-result',
        kind: 'tool.result',
        sourceEventIds: ['read-result'],
        toolUseId: 'call-read',
        data: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bm90IGEgcG5n' } }] },
      },
    ]
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'image.png' } } },
        results,
      }),
    )

    expect(card).toContain('title="Read (image.png) ERROR"')
    expect(card).toContain('timeline-tool-error-label')
  })

  it.each([
    ['empty string', ''],
    ['empty text block', { type: 'text', text: '' }],
  ])('falls back to a valid wire image for %s Read content', (_label, content) => {
    const data = { content, toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } }
    const results: TimelineBlock[] = [{ id: 'read-result', kind: 'tool.result', sourceEventIds: ['read-result'], toolUseId: 'call-read', data }]
    const body = renderToStaticMarkup(createElement(ReadToolContent, { results }))
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'image.png' } } },
        results,
      }),
    )

    expect(body).toContain('loading preview')
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('falls back to a valid wire image when Read content image is invalid', () => {
    const data = {
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bm90IGEgcG5n' } }],
      toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } },
    }
    const results: TimelineBlock[] = [{ id: 'read-result', kind: 'tool.result', sourceEventIds: ['read-result'], toolUseId: 'call-read', data }]
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'image.png' } } },
        results,
      }),
    )

    expect(readResultContentImage(data)).toEqual({ mediaType: 'image/png', data: png })
    expect(card).not.toContain('timeline-tool-error-label')
  })

  it('prefers a valid Read content image over the wire image', () => {
    const data = {
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif } }],
      toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } },
    }

    expect(readResultContentImage(data)).toEqual({ mediaType: 'image/gif', data: gif })
  })

  it('marks invalid Read image transport as unsupported', () => {
    const results: TimelineBlock[] = [
      {
        id: 'read-result',
        kind: 'tool.result',
        sourceEventIds: ['read-result'],
        toolUseId: 'call-read',
        data: { toolUseResult: { type: 'image', file: { type: 'image/png', base64: 'bm90IGEgcG5n' } } },
      },
    ]
    const card = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: { id: 'Read', kind: 'assistant.tool_use', sourceEventIds: ['Read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'image.png' } } },
        results,
      }),
    )

    expect(card).toContain('title="Read (image.png) ERROR"')
    expect(card).toContain('timeline-tool-error-label')
  })

  it('defers mixed Bash result bodies', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallBlockView, {
        toolUse: toolUse({ command: 'run checks' }),
        results: [result('success', 'before-error'), result('failure', 'after-error', 'is_error')],
      }),
    )

    expect(html).not.toContain('before-error')
    expect(html).not.toContain('after-error')
  })
})

describe('Write file mutation result', () => {
  const toolUse: TimelineBlock = { id: 'write', kind: 'assistant.tool_use', sourceEventIds: ['write'], toolUseId: 'call-write', data: { cwd: '/input', input: { file_path: '/input/a.ts' } } }
  const block = (toolUseResult: Record<string, unknown>): TimelineBlock => ({
    id: 'write-result',
    kind: 'tool.result',
    sourceEventIds: ['write-result'],
    toolUseId: 'call-write',
    data: { toolUseResult },
  })
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }

  it.each([undefined, 'update', 'overwrite', 'future-protocol'])('treats %s Write patch results as overwrite diffs', (type) => {
    expect(fileMutationResult('Write', toolUse, block({ type, filePath: '/result/a.ts', structuredPatch: [hunk] }))).toEqual({
      type: 'overwrite',
      filePath: '/input/a.ts',
      cwd: '/input',
      hunks: [hunk],
    })
  })

  it('keeps Write create results as create', () => {
    expect(fileMutationResult('Write', toolUse, block({ type: 'create', filePath: '/result/a.ts', content: 'new file', structuredPatch: [] }))).toEqual({
      type: 'create',
      filePath: '/input/a.ts',
      cwd: '/input',
      content: 'new file',
      hunks: [],
    })
  })

  it('leaves errored Write results for the error renderer', () => {
    expect(fileMutationResult('Write', toolUse, { ...block({ type: 'update', filePath: '/repo/a.ts', structuredPatch: [hunk] }), data: { is_error: true } })).toBeNull()
  })
})

describe('away summary recap', () => {
  it('renders recap markdown', () => {
    const html = renderToStaticMarkup(createElement(SessionAwaySummary, { value: '**While away:** done' }))

    expect(html).toContain('aria-label="Away recap"')
    expect(html).toContain('Recap')
    expect(html).toContain('<strong>While away:</strong>')
    expect(html).toContain('session-away-summary')
  })
})

describe('assistant response skeleton', () => {
  it('uses the response frame shape while a primary-only turn is cooking', () => {
    const html = renderToStaticMarkup(createElement(AssistantResponseFrameSkeleton, { activeLabel: 'Cooking...' }))

    expect(html).toContain('assistant-response')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('timeline-skeleton-line')
    expect(html).toContain('Cooking...')
  })

  it('shows pending background agents on primary-only skeletons before cooking', () => {
    const html = renderToStaticMarkup(
      createElement(AssistantResponseFrameSkeleton, { activeLabel: 'Writing tests...', footerState: { kind: 'waiting', label: 'Waiting for 2 background tasks to finish' } }),
    )

    expect(html).toContain('Waiting for 2 background tasks to finish')
    expect(html).not.toContain('Writing tests...')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('keeps Claude Code cooking verb spelling', () => {
    expect(COOKING_VERBS).toContain('Dilly-dallying')
    expect(COOKING_VERBS).toContain('Flambéing')
    expect(COOKING_VERBS).toContain('Sautéing')
    expect(COOKING_VERBS).toContain('Sock-hopping')
    expect(turnCookingLabel('turn-1')).toMatch(/…$/)
  })

  it('uses the active task form for the cooking label', () => {
    expect(turnActiveTaskLabel([{ id: '1', subject: 'Implement footer', activeForm: 'Sharing footer...', status: 'in_progress', blockedBy: [] }])).toBe('Sharing footer…')
    expect(turnActiveTaskLabel([{ id: '1', subject: 'Implement footer', status: 'pending', blockedBy: [] }])).toBeUndefined()
  })

  it('keeps the skeleton until rendering has visible response content', () => {
    const emptyText = { type: 'block' as const, block: { id: 'empty-text', kind: 'assistant.text', sourceEventIds: ['empty-text'], data: { text: '', streaming: true } } }
    const text = { type: 'block' as const, block: { id: 'text', kind: 'assistant.text', sourceEventIds: ['text'], data: { text: 'hello', streaming: true } } }

    expect(shouldShowResponseSkeleton({ phase: 'submitted', hasVisibleResponse: false })).toBe(true)
    expect(shouldShowResponseSkeleton({ phase: 'rendering', hasVisibleResponse: false })).toBe(true)
    expect(shouldShowResponseSkeleton({ phase: 'rendering', hasVisibleResponse: true })).toBe(false)
    expect(assistantResponseFrameHasVisibleContent([emptyText])).toBe(false)
    expect(assistantResponseFrameHasVisibleContent([text])).toBe(true)
  })

  it('uses a stable verb label for ordinary cooking footers', () => {
    const turn = userTurn('turn-1')
    expect(turnFooterState({ turn, phase: 'rendering', cooking: true })).toEqual({ kind: 'cooking', label: turnCookingLabel('turn-1') })
  })
})

describe('timeline scope reset', () => {
  it('accepts timeline writes only for the selected session', () => {
    expect(belongsToTimelineSession('session-1', 'session-1')).toBe(true)
    expect(belongsToTimelineSession('session-2', 'session-1')).toBe(false)
    expect(belongsToTimelineSession(null, 'session-1')).toBe(false)
  })

  it('preserves pending state while history becomes available for the same session id', () => {
    expect(shouldResetSessionTimeline({ sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' }, { sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' })).toBe(false)
  })

  it('resets when switching real sessions', () => {
    expect(shouldResetSessionTimeline({ sessionId: 'session-1', pendingPrimaryTurnUuid: null }, { sessionId: 'session-2', pendingPrimaryTurnUuid: null })).toBe(true)
  })

  it('does not reset when only project context changes', () => {
    expect(shouldResetSessionTimeline({ sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' }, { sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' })).toBe(false)
  })

  it('resets null to real session without a pending anchor', () => {
    expect(shouldResetSessionTimeline({ sessionId: null, pendingPrimaryTurnUuid: null }, { sessionId: 'session-1', pendingPrimaryTurnUuid: null })).toBe(true)
  })
})

describe('raw timeline messages', () => {
  it('renders the raw-message action for a live turn', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: projected(userTurn('turn-1'))[0], timestamp: 1, source: 'LIVE', onViewRaw: () => {} }))

    expect(html).toContain('aria-label="View raw user message"')
    expect(html).toContain('>LIVE</span>')
  })

  it('does not project non-primary user content without a product meaning', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [userMessage('turn-1'), { type: 'user', uuid: 'internal', message: { role: 'user', content: 'deferred-content' } }],
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'user.message', sourceEventIds: ['turn-1'] })
  })

  it('projects peer messages from origin and renders their dedicated title', () => {
    const origin = { kind: 'peer', from: 'Explore', name: 'Explore', body: 'Peer findings', senderTaskId: 'agent-1' }
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [
        userMessage('turn-1'),
        { type: 'user', uuid: 'peer-1', isMeta: true, message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message>duplicate envelope</agent-message>' }, origin },
      ],
    })
    const peer = blocks.find((block) => block.kind === 'assistant.peer_message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: peer }))

    expect(peer).toEqual({ id: 'peer-1:peer_message', kind: 'assistant.peer_message', sourceEventIds: ['peer-1'], data: { ...origin } })
    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @Explore · agent-1)')
    expect(html).toContain('class="timeline-file-result-details"')
    expect(html).toContain('<details')
    expect(html).not.toContain('timeline-disclosure-card')
    expect(html).not.toContain('duplicate envelope')
    expect(html).not.toContain('Peer findings')
  })

  it('renders cross-session peer messages without a sender task id', () => {
    const origin = { kind: 'peer', from: 'uds:/run/user/1001/cc-socks/2474640.sock', name: 'enter-plan-mode-tool-view', body: 'Peer findings' }
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [userMessage('turn-1'), { type: 'user', uuid: 'peer-1', isMeta: true, message: { role: 'user', content: 'Another Claude session sent a message' }, origin }],
    })
    const peer = blocks.find((block) => block.kind === 'assistant.peer_message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: peer }))

    expect(peer.data).toEqual(origin)
    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @enter-plan-mode-tool-view)')
  })

  it('falls back to origin.from for historical peer messages', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [
        userMessage('turn-1'),
        { type: 'user', uuid: 'peer-1', message: { role: 'user', content: 'Another Claude session sent a message' }, origin: { kind: 'peer', from: 'Explore', body: 'Peer findings' } },
      ],
    })
    const peer = blocks.find((block) => block.kind === 'assistant.peer_message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: peer }))

    expect(peer.data).toEqual({ kind: 'peer', from: 'Explore', name: 'Explore', body: 'Peer findings' })
    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @Explore)')
  })

  it('normalizes surrounding whitespace in the peer sender name', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [
        userMessage('turn-1'),
        {
          type: 'user',
          uuid: 'peer-1',
          isMeta: true,
          message: { role: 'user', content: 'Another Claude session sent a message' },
          origin: { kind: 'peer', from: '  Explore  ', name: '  Explore  ', body: 'Peer findings' },
        },
      ],
    })
    const peer = blocks.find((block) => block.kind === 'assistant.peer_message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: peer }))

    expect(peer.data).toEqual({ kind: 'peer', from: '  Explore  ', name: 'Explore', body: 'Peer findings' })
    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @Explore)')
  })

  it('omits the dangling separator when senderTaskId is blank', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineBlockView, {
        timeZone: 'Asia/Shanghai',
        block: {
          id: 'peer-1:peer_message',
          kind: 'assistant.peer_message',
          sourceEventIds: ['peer-1'],
          data: { kind: 'peer', from: 'Explore', name: 'Explore', body: 'Peer findings', senderTaskId: '   ' },
        },
      }),
    )

    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @Explore)')
    expect(html).not.toContain('·')
  })

  it('falls back to origin.from when the peer name is empty', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [
        userMessage('turn-1'),
        { type: 'user', uuid: 'peer-1', message: { role: 'user', content: 'Another Claude session sent a message' }, origin: { kind: 'peer', from: 'Explore', name: '', body: 'Peer findings' } },
      ],
    })
    const peer = blocks.find((block) => block.kind === 'assistant.peer_message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: peer }))

    expect(peer.data).toEqual({ kind: 'peer', from: 'Explore', name: 'Explore', body: 'Peer findings' })
    expect(html).toContain('<strong class="font-medium">PeerMessage</strong> (From @Explore)')
  })

  it('does not let malformed peer messages fall through to other user projections', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [
        userMessage('turn-1'),
        { type: 'user', uuid: 'peer-skill', isMeta: true, sourceToolUseID: 'toolu_skill', message: { role: 'user', content: 'Skill content' }, origin: { kind: 'peer', body: 'Peer findings' } },
        {
          type: 'user',
          uuid: 'peer-task',
          message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>' },
          origin: { kind: 'peer', from: 'Explore' },
        },
        {
          type: 'user',
          uuid: 'peer-result',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'result' }] },
          origin: { kind: 'peer', from: 'Explore', body: '   ' },
        },
      ],
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'user.message', sourceEventIds: ['turn-1'] })
  })

  it('defers thinking card markdown until expanded', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineBlockView, {
        timeZone: 'Asia/Shanghai',
        block: { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['assistant'], data: { thinking: '**Consider** the edge case' } },
      }),
    )

    expect(html).toContain('aria-label="Assistant thinking"')
    expect(html).toContain('<summary')
    expect(html).toContain('Thought')
    expect(html).not.toContain('Consider the edge case')
    expect(html).not.toContain('<strong>Consider</strong>')
    expect(html).not.toContain('**Consider**')
  })

  it('renders thinking duration with the light disclosure style', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineBlockView, {
        timeZone: 'Asia/Shanghai',
        block: { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['assistant'], data: { thinking: 'Inspect', durationMs: 21_000 } },
      }),
    )

    expect(html).toContain('timeline-thinking')
    expect(html).toContain('Thought for 21s')
    expect(html).not.toContain('timeline-disclosure-card')
  })

  it('does not invent a duration for zero-millisecond thinking', () => {
    const settled = { id: 'settled', kind: 'assistant.thinking', sourceEventIds: ['assistant'], data: { thinking: 'Inspect', durationMs: 0 } } satisfies TimelineBlock
    const streaming = {
      id: 'streaming',
      kind: 'assistant.thinking',
      sourceEventIds: ['assistant'],
      data: { thinking: 'Inspect', durationMs: 0, streaming: true, streamingStartedAtMs: 1000 },
    } satisfies TimelineBlock

    expect(thinkingBlockTitle(settled)).toBe('Thought')
    expect(thinkingBlockTitle(streaming, 1000)).toBe('Thinking…')
  })

  it('renders task notification with the new title and no original tool chrome', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineBlockView, {
        timeZone: 'Asia/Shanghai',
        block: {
          id: 'task-1:task_notification',
          kind: 'assistant.task_notification',
          sourceEventIds: ['task-1'],
          data: {
            taskId: 'task-1',
            toolUseId: 'call-agent',
            status: 'completed',
            summary: 'Agent finished',
            result: 'Final answer',
            originalToolUse: { id: 'call-agent', name: 'Agent', input: { prompt: 'Investigate this' } },
          },
        },
      }),
    )

    expect(html).toContain('<strong class="font-medium">TaskNotification</strong> (completed · Agent finished)')
    expect(html).not.toContain('Agent completed')
    expect(html).not.toContain('Input')
    expect(html).not.toContain('Result')
    expect(html).not.toContain('Raw notification')
    expect(html).not.toContain('Investigate this')
    expect(html).not.toContain('Final answer')
    expect(html).not.toContain('Rendered answer')
    expect(html).not.toContain('timeline-tool-error-label')
    expect(html).not.toContain('timeline-disclosure-card')
  })

  it('omits missing task notification title parts', () => {
    const render = (data: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: { id: 'task-1:task_notification', kind: 'assistant.task_notification', sourceEventIds: ['task-1'], data } }),
      )

    expect(render({ status: 'running', text: 'body' })).toContain('<strong class="font-medium">TaskNotification</strong> (running)')
    expect(render({ summary: 'Only summary', text: 'body' })).toContain('<strong class="font-medium">TaskNotification</strong> (Only summary)')
    expect(render({ text: 'body' })).toContain('<strong class="font-medium">TaskNotification</strong>')
  })

  it('renders parsed task notification result markdown', () => {
    const html = renderToStaticMarkup(createElement(TaskNotificationContent, { result: '**Final** answer' }))

    expect(html).toContain('<strong>Final</strong> answer')
    expect(html).not.toContain('task-notification')
  })

  it('renders pre-parsed task notification results', () => {
    const html = renderToStaticMarkup(createElement(TaskNotificationContent, { result: 'A < B' }))

    expect(html).toContain('A &lt; B')
    expect(html).not.toContain('Unsupported TaskNotification result')
  })

  it('renders resultless task notifications as status fallbacks', () => {
    const content =
      '<task-notification><task-id>task-1</task-id><task-id>task-2</task-id><status>stopped</status><summary>Agents stopped</summary><note>Progress is preserved.</note></task-notification>'
    const html = renderToStaticMarkup(createElement(TaskNotificationContent, { status: 'stopped', summary: 'Agents stopped', note: 'Progress is preserved.', taskIds: ['task-1', 'task-2'] }))
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'turn-1',
      messages: [userMessage('turn-1'), { type: 'user', uuid: 'task-notification', origin: { kind: 'task-notification' }, message: { role: 'user', content } }],
    })
    const card = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: blocks[1]! }))

    expect(html).toContain('Status: stopped')
    expect(html).toContain('Summary: Agents stopped')
    expect(html).toContain('Note: Progress is preserved.')
    expect(html).toContain('Task IDs: task-1, task-2')
    expect(html).toContain('data-tone="muted"')
    expect(html).not.toContain('Unsupported TaskNotification result')
    expect(card).not.toContain('timeline-tool-error-label')
    expect(blocks[1]).toMatchObject({ data: { taskId: 'task-1', taskIds: ['task-1', 'task-2'], note: 'Progress is preserved.', result: null } })
  })

  it('marks invalid task notification payloads unsupported', () => {
    const html = renderToStaticMarkup(createElement(TaskNotificationContent, { invalid: true, result: 'must not render' }))
    const card = renderToStaticMarkup(
      createElement(TimelineBlockView, {
        timeZone: 'Asia/Shanghai',
        block: {
          id: 'task-1:task_notification',
          kind: 'assistant.task_notification',
          sourceEventIds: ['task-1'],
          data: { invalid: true, status: 'completed', result: 'must not render' },
        },
      }),
    )

    expect(html).toContain('Unsupported TaskNotification result')
    expect(html).toContain('data-tone="error"')
    expect(card).toContain('timeline-tool-error-label">ERROR')
  })

  it('projects only direct task notification fields', () => {
    const content =
      '<task-notification><task-id>task-1</task-id><task-id>task-2</task-id><tool-use-id>call-1</tool-use-id><note><task-id>nested</task-id><tool-use-id>wrong</tool-use-id></note></task-notification>'
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [userMessage('user-1'), { type: 'user', uuid: 'notification', message: { role: 'user', content } }],
    })

    expect(blocks[1]).toMatchObject({ kind: 'assistant.task_notification', data: { taskId: 'task-1', taskIds: ['task-1', 'task-2'], toolUseId: 'call-1', note: 'nestedwrong' } })
  })

  it('does not project invalid stripped task notification envelopes', () => {
    const content = '<task-notification><task-id> </task-id><tool-use-id>call-1</tool-use-id></task-notification>'
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [userMessage('user-1'), { type: 'user', uuid: 'notification', message: { role: 'user', content } }],
    })

    expect(blocks).toHaveLength(1)
  })

  it('projects explicit invalid task notifications without treating them as user input', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'notification',
      messages: [
        {
          type: 'user',
          uuid: 'notification',
          origin: { kind: 'task-notification' },
          message: { role: 'user', content: '<task-notification><task-id>task-1</task-id>' },
        },
      ],
    })

    expect(blocks).toEqual([expect.objectContaining({ kind: 'assistant.task_notification', data: expect.objectContaining({ invalid: true }) })])
  })

  it('projects whitelisted top-level command envelopes as local commands', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [userMessage('user-1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>bugfix</command-args>')],
    })

    expect(blocks[0]).toMatchObject({
      kind: 'user.local_command',
      sourceEventIds: ['user-1'],
      data: { primaryTimelineUserMessage: true, commandName: '/clear', commandArgs: 'bugfix', text: '/clear bugfix' },
    })

    expect(
      projectTimelineTurn({
        primaryUserUuid: 'user-2',
        messages: [userMessage('user-2', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>default</command-args>')],
      })[0],
    ).toMatchObject({
      kind: 'user.local_command',
      sourceEventIds: ['user-2'],
      data: { primaryTimelineUserMessage: true, commandName: '/model', commandArgs: 'default', text: '/model default' },
    })
  })

  it('merges strictly linked local command feedback into its command row', () => {
    const command = { type: 'system', subtype: 'local_command', uuid: 'command', content: '<command-name>/context</command-name><command-message>context</command-message>' }
    const stdout = { type: 'system', subtype: 'local_command', uuid: 'stdout', parentUuid: 'command', content: '<local-command-stdout>[1mContext Usage[22m\n804.7k / 1m tokens</local-command-stdout>' }
    const block = projectTimelineTurn({ primaryUserUuid: 'command', messages: [command, stdout] })[0]

    expect(block).toMatchObject({
      kind: 'user.local_command',
      sourceEventIds: ['command', 'stdout'],
      data: { primaryTimelineUserMessage: true, text: '/context (Context Usage 804.7k / 1m tokens)' },
    })
  })

  it('renders failed stdout feedback with an error tone', () => {
    const command = userMessage('command', '<command-name>/stickers</command-name><command-message>stickers</command-message>')
    const stdout = { type: 'system', subtype: 'local_command', uuid: 'stdout', parentUuid: 'command', content: '<local-command-stdout>Failed to open browser</local-command-stdout>' }
    const block = projectTimelineTurn({ primaryUserUuid: 'command', messages: [command, stdout] })[0]

    expect(block).toMatchObject({ kind: 'user.local_command', data: { localCommandError: true } })
  })

  it('merges stderr feedback with an error tone', () => {
    const command = userMessage('command', '<command-name>/compact</command-name><command-message>compact</command-message>')
    const stderr = { type: 'system', subtype: 'local_command', uuid: 'stderr', parentUuid: 'command', content: '<local-command-stderr>Error during compaction: API Error</local-command-stderr>' }
    const block = projectTimelineTurn({ primaryUserUuid: 'command', messages: [command, stderr] })[0]

    expect(block).toMatchObject({ kind: 'user.local_command', sourceEventIds: ['command', 'stderr'], data: { text: '/compact (Error during compaction: API Error)', localCommandError: true } })
    expect(renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: block! }))).toContain('text-[var(--tl-danger)]')
  })

  it('does not project unlinked local command feedback', () => {
    const feedback = { type: 'system', subtype: 'local_command', uuid: 'stdout', content: '<local-command-stdout>Set model to Example</local-command-stdout>' }
    const blocks = projectTimelineTurn({ primaryUserUuid: 'user-1', messages: [userMessage('user-1', 'prompt'), feedback] })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'user.message', sourceEventIds: ['user-1'] })
  })

  it('keeps unlinked local command feedback as an ordinary message', () => {
    const stdout = '<local-command-stdout>Set model to `claude-gpt-5-5-max[1m]`</local-command-stdout>'
    const block = projectTimelineTurn({
      primaryUserUuid: 'stdout',
      messages: [{ type: 'user', uuid: 'stdout', userType: 'external', message: { role: 'user', content: stdout } }],
    })[0]

    expect(block).toMatchObject({ kind: 'user.message', data: { primaryTimelineUserMessage: true, text: stdout } })
  })

  it('projects recognized interrupt markers as local-command rows', () => {
    const structured = projectTimelineTurn({
      primaryUserUuid: 'structured',
      messages: [
        {
          type: 'user',
          uuid: 'structured',
          interruptedMessageId: 'msg_interrupted',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        },
      ],
    })[0]
    const fallback = projectTimelineTurn({
      primaryUserUuid: 'fallback',
      messages: [
        {
          type: 'user',
          uuid: 'fallback',
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
        },
      ],
    })[0]
    const ordinary = projectTimelineTurn({
      primaryUserUuid: 'ordinary',
      messages: [
        {
          type: 'user',
          uuid: 'ordinary',
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user] extra' }] },
        },
      ],
    })[0]

    expect(structured).toMatchObject({ kind: 'user.local_command', data: { primaryTimelineUserMessage: true, text: 'Request interrupted by user' } })
    expect(fallback).toMatchObject({ kind: 'user.local_command', data: { primaryTimelineUserMessage: true, text: 'Request interrupted by user for tool use' } })
    expect(ordinary).toMatchObject({ kind: 'user.message', data: { primaryTimelineUserMessage: true, text: '[Request interrupted by user] extra' } })

    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: structured! }))
    expect(html).toContain('justify-center')
    expect(html).not.toContain('Copy user message')
  })

  it('renders /clear local commands without the primary message footer', () => {
    const block = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      primaryUserTimestampMs: Date.UTC(2026, 7, 8, 12, 34),
      entrypoint: 'cli',
      messages: [userMessage('user-1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>bugfix</command-args>')],
    })[0]!
    const html = renderToStaticMarkup(
      createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block, timestamp: Date.UTC(2026, 7, 8, 12, 34), entrypoint: 'cli', source: 'TRANSCRIPT', onViewRaw: () => {} }),
    )

    expect(html).toContain('/clear bugfix')
    expect(html).toContain('justify-center')
    expect(html).not.toContain('Copy user message')
    expect(html).not.toContain('View raw user message')
    expect(html).not.toContain('CLI')
    expect(html).not.toContain('TRANSCRIPT')
  })

  it('projects command envelopes without a command-name whitelist', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [userMessage('user-1', '<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>install x</command-args>')],
    })

    expect(blocks[0]).toMatchObject({ kind: 'user.local_command', data: { primaryTimelineUserMessage: true, text: '/plugin install x' } })
  })

  it.each(['tool_use_result', 'toolUseResult'])('normalizes %s on projected tool results', (field) => {
    const structuredResult = {
      filePath: 'apps/server/src/routes/projects.test.ts',
      originalFile: 'before',
      structuredPatch: [{ oldStart: 1905, oldLines: 6, newStart: 1905, newLines: 7, lines: [' context', '+added'] }],
    }
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1', 'edit file'),
        {
          type: 'user',
          uuid: 'result-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
          [field]: structuredResult,
        },
      ],
    })

    expect(blocks.find((block) => block.kind === 'tool.result')?.data).toMatchObject({
      toolUseResult: {
        filePath: 'apps/server/src/routes/projects.test.ts',
        structuredPatch: [{ lines: [' context', '+added'] }],
      },
    })
  })

  it('prefers tool_use_result when both field names are present', () => {
    const blocks = userBlocksFromMessage(
      {
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        tool_use_result: 'current result',
        toolUseResult: 'legacy result',
      },
      'result-1',
    )

    expect(blocks[0]?.data).toMatchObject({ toolUseResult: 'current result' })
    expect(blocks[0]?.data).not.toHaveProperty('tool_use_result')
  })

  it.each(['tool_use_result', 'toolUseResult'])('normalizes string %s on projected tool results', (field) => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1', 'run agent'),
        {
          type: 'user',
          uuid: 'result-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'failed' }] },
          [field]: 'Agent failed',
        },
      ],
    })

    expect(blocks.find((block) => block.kind === 'tool.result')?.data).toMatchObject({ toolUseResult: 'Agent failed' })
  })

  it.each([
    ['update', 'Update', { type: 'update' as const, filePath: `src/${'nested/'.repeat(20)}file.ts`, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }],
    [
      'overwrite',
      'Overwrite',
      { type: 'overwrite' as const, filePath: `src/${'nested/'.repeat(20)}file.ts`, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] },
    ],
    ['create', 'Create', { type: 'create' as const, filePath: `src/${'nested/'.repeat(20)}file.ts`, content: 'value', hunks: [] }],
  ])('renders the complete %s summary with Git-style counts', (_kind, title, fileMutation) => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], data: {} },
        fileMutation,
      }),
    )
    const summary = `${title} (${fileMutation.filePath} · ${fileMutation.type === 'create' ? '+1' : '+1 -1'})`

    expect(html).toContain(`<span title="${summary}"><span>${title}</span>`)
    expect(html).toContain('<span class="timeline-file-result-summary-add">+1</span>')
    if (fileMutation.type !== 'create') expect(html).toContain('<span class="timeline-file-result-summary-remove">-1</span>')
    expect(html).not.toContain(`<strong class="font-medium">${title}</strong>`)
  })

  it('keeps no textual changes neutral', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], data: {} },
        fileMutation: { type: 'update', filePath: 'src/empty.ts', hunks: [] },
      }),
    )

    expect(html).toContain('No textual changes')
    expect(html).not.toContain('timeline-file-result-summary-add')
    expect(html).not.toContain('timeline-file-result-summary-remove')
  })

  it('renders Edit structured patches as standalone file cards with line numbers', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: {
          id: 'result-1:tool_result:0',
          kind: 'tool.result',
          sourceEventIds: ['result-1'],
          toolUseId: 'tool-1',
          data: {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'ok',
            toolUseResult: {
              filePath: 'apps/server/src/routes/projects.test.ts',
              originalFile: 'before',
              structuredPatch: [
                {
                  oldStart: 1905,
                  oldLines: 6,
                  newStart: 1905,
                  newLines: 7,
                  lines: ['    expect(response.status).toBe(200)', '+    expect(await response.json()).toMatchObject({ initializationResult: null })'],
                },
              ],
            },
          },
        },
        fileMutation: {
          type: 'update',
          filePath: 'apps/server/src/routes/projects.test.ts',
          hunks: [
            {
              oldStart: 1905,
              oldLines: 6,
              newStart: 1905,
              newLines: 7,
              lines: ['    expect(response.status).toBe(200)', '+    expect(await response.json()).toMatchObject({ initializationResult: null })'],
            },
          ],
        },
      }),
    )

    expect(html).toContain('timeline-file-result-details')
    expect(html).not.toContain('timeline-result-scroll')
    expect(html).toContain(
      '<span>Update</span><span class="timeline-file-result-summary-detail"> (apps/server/src/routes/projects.test.ts · <span class="timeline-file-result-summary-add">+1</span>)</span>',
    )
    expect(html).not.toContain('markdown-code-block')
    expect(html).not.toContain('markdown-code-language">ts')
    expect(html).not.toContain('timeline-file-diff-number')
    expect(html).not.toContain('1905')
    expect(html).not.toContain('1906')
    expect(html).not.toContain('timeline-file-diff-line-add')
    expect(html).not.toContain('expect(await response.json()).toMatchObject')
    expect(html).not.toContain('&quot;structuredPatch&quot;')
  })

  it('defers separated inline diff bodies', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: {
          id: 'result-1',
          kind: 'tool.result',
          sourceEventIds: ['result-1'],
          data: { toolUseResult: { filePath: 'a.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha keep omega', '+beta keep theta'] }] } },
        },
        fileMutation: { type: 'update', filePath: 'a.txt', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha keep omega', '+beta keep theta'] }] },
      }),
    )

    expect(html).not.toContain('timeline-file-diff-delta')
    expect(html).not.toContain('alpha keep omega')
    expect(html).not.toContain('beta keep theta')
  })

  it('defers multi-line replacement diff bodies', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: {
          id: 'result-1',
          kind: 'tool.result',
          sourceEventIds: ['result-1'],
          data: {
            toolUseResult: {
              filePath: 'a.ts',
              structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-const first = oldOne', '-const second = oldTwo', '+const first = newOne', '+const second = newTwo'] }],
            },
          },
        },
        fileMutation: {
          type: 'update',
          filePath: 'a.ts',
          hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-const first = oldOne', '-const second = oldTwo', '+const first = newOne', '+const second = newTwo'] }],
        },
      }),
    )

    expect(html).not.toContain('oldOne')
    expect(html).not.toContain('oldTwo')
    expect(html).not.toContain('newOne')
    expect(html).not.toContain('newTwo')
  })

  it('replaces matched successful file tool cards with a standalone timeline block', () => {
    const items = groupTimelineBlocks(
      projectTimelineTurn({
        primaryUserUuid: 'user-1',
        messages: [
          userMessage('user-1', 'edit file'),
          { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'a.ts' } }] } },
          {
            type: 'user',
            uuid: 'result-1',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
            toolUseResult: { type: 'update', filePath: 'a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' const a = 1', '+const b = 2'] }] },
          },
        ],
      }),
    )

    expect(items).toMatchObject([
      { type: 'block', block: expect.objectContaining({ kind: 'user.message' }) },
      { type: 'block', block: expect.objectContaining({ kind: 'tool.result' }), fileMutation: { type: 'update', filePath: 'a.ts' } },
    ])
  })

  it('renders .md Create content with Markdown syntax', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], data: {} },
        fileMutation: { type: 'create', filePath: 'README.md', content: '# Heading', hunks: [] },
      }),
    )

    expect(html).not.toContain('markdown-code-language">markdown')
    expect(html).not.toContain('language-markdown')
  })

  it('renders Write create output as a Create card when patch is empty', () => {
    const html = renderToStaticMarkup(
      createElement(FileToolResultValue, {
        block: {
          id: 'result-1:tool_result:0',
          kind: 'tool.result',
          sourceEventIds: ['result-1'],
          toolUseId: 'tool-1',
          data: {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'ok',
            toolUseResult: {
              type: 'create',
              filePath: 'apps/web/src/new.ts',
              content: 'export const value = 1\n',
              structuredPatch: [],
              originalFile: null,
            },
          },
        },
        fileMutation: { type: 'create', filePath: 'apps/web/src/new.ts', content: 'export const value = 1\n', hunks: [] },
      }),
    )

    expect(html).toContain('timeline-file-result-details')
    expect(html).not.toContain('timeline-result-scroll')
    expect(html).toContain('<span>Create</span><span class="timeline-file-result-summary-detail"> (apps/web/src/new.ts · <span class="timeline-file-result-summary-add">+1</span>)</span>')
    expect(html).not.toContain('markdown-code-block')
    expect(html).not.toContain('export const value = 1')
  })

  it('replaces matched Write create results with Create file cards', () => {
    const items = groupTimelineBlocks([
      { id: 'write', kind: 'assistant.tool_use', sourceEventIds: ['write'], toolUseId: 'tool-1', data: { name: 'Write', input: { file_path: 'a.ts' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'tool-1',
        data: { content: 'ok', toolUseResult: { type: 'create', filePath: 'a.ts', content: 'export const value = 1\n', structuredPatch: [] } },
      },
    ])

    expect(items).toMatchObject([{ type: 'block', block: { id: 'result' }, fileMutation: { type: 'create', filePath: 'a.ts', content: 'export const value = 1\n' } }])
  })

  it('replaces matched Write update results with Overwrite file cards', () => {
    const items = groupTimelineBlocks([
      { id: 'write', kind: 'assistant.tool_use', sourceEventIds: ['write'], toolUseId: 'tool-1', data: { name: 'Write', input: { file_path: 'a.ts' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'tool-1',
        data: {
          content: 'ok',
          toolUseResult: {
            type: 'update',
            filePath: 'a.ts',
            content: 'after',
            originalFile: 'before',
            structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
          },
        },
      },
    ])

    expect(items).toMatchObject([{ type: 'block', block: { id: 'result' }, fileMutation: { type: 'overwrite', filePath: 'a.ts' } }])
  })

  it('derives file tool state from its own results regardless of frame source', () => {
    const props = {
      toolUse: { id: 'edit', kind: 'assistant.tool_use', sourceEventIds: ['edit'], toolUseId: 'tool-1', data: { name: 'Edit', input: { file_path: 'a.ts' } } } satisfies TimelineBlock,
      results: [{ id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'tool-1', data: { content: 'Updated a.ts' } }] satisfies TimelineBlock[],
    }
    const liveHtml = renderToStaticMarkup(createElement(ToolCallBlockView, { ...props, source: 'LIVE' }))
    const transcriptHtml = renderToStaticMarkup(createElement(ToolCallBlockView, { ...props, source: 'TRANSCRIPT' }))

    expect(liveHtml).toBe(transcriptHtml)
    expect(liveHtml).not.toContain('title="Editing (a.ts)"')
    expect(liveHtml).toContain('title="Update (a.ts)"')
    expect(liveHtml).not.toContain('timeline-tool-error-label')
  })

  it.each([
    ['file path only', 'Edit', { filePath: 'a.ts' }],
    ['empty update patch', 'Edit', { filePath: 'a.ts', structuredPatch: [] }],
    ['invalid update patch', 'Edit', { filePath: 'a.ts', structuredPatch: [{ oldStart: 'wrong' }] }],
    ['create from Edit', 'Edit', { type: 'create', filePath: 'a.ts', content: 'value', structuredPatch: [] }],
    ['create without content', 'Write', { type: 'create', filePath: 'a.ts', structuredPatch: [] }],
  ])('renders matched unsupported %s results as full error cards', (_label, toolName, toolUseResult) => {
    const input = toolName === 'Write' ? { file_path: 'a.ts', content: 'attempt' } : toolName === 'Edit' ? { file_path: 'a.ts' } : { file_path: 'a.ts' }
    const items = groupTimelineBlocks([
      { id: 'tool', kind: 'assistant.tool_use', sourceEventIds: ['tool'], toolUseId: 'tool-1', data: { name: toolName, input } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'tool-1', data: { content: 'ok', toolUseResult } },
    ])

    const item = items.find((value) => value.type === 'tool-call') as Extract<(typeof items)[number], { type: 'tool-call' }> | undefined
    expect(item).toBeTruthy()
    const html = renderToStaticMarkup(createElement(ToolCallBlockView, item!))
    expect(html).toContain('timeline-file-result-details')
    expect(html).toContain('timeline-tool-error-label')
    expect(html).not.toContain('timeline-file-result-static')
    const body = renderToStaticMarkup(
      createElement(UnsupportedFileToolContent, { toolName, input, filePath: 'a.ts', results: [{ id: 'result', kind: 'tool.result', sourceEventIds: ['result'], data: { toolUseResult } }] }),
    )
    expect(body).toContain(`Unsupported ${toolName} result`)
  })

  it('keeps errored file results in their tool card', () => {
    const items = groupTimelineBlocks([
      { id: 'edit', kind: 'assistant.tool_use', sourceEventIds: ['edit'], toolUseId: 'tool-1', data: { name: 'Edit', input: { file_path: 'a.ts' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'tool-1',
        data: { is_error: true, content: 'failed', toolUseResult: { filePath: 'a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
      },
    ])

    expect(items).toMatchObject([{ type: 'tool-call', toolUse: { id: 'edit' }, results: [{ id: 'result' }] }])
  })

  it('keeps mixed file results together when one cannot render', () => {
    const items = groupTimelineBlocks([
      { id: 'edit', kind: 'assistant.tool_use', sourceEventIds: ['edit'], toolUseId: 'tool-1', data: { name: 'Edit', input: { file_path: 'a.ts' } } },
      {
        id: 'valid',
        kind: 'tool.result',
        sourceEventIds: ['valid'],
        toolUseId: 'tool-1',
        data: { content: 'ok', toolUseResult: { filePath: 'a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
      },
      { id: 'invalid', kind: 'tool.result', sourceEventIds: ['invalid'], toolUseId: 'tool-1', data: { content: 'still visible', toolUseResult: { filePath: 'b.ts' } } },
    ])

    expect(items).toMatchObject([{ type: 'tool-call', toolUse: { id: 'edit' }, results: [{ id: 'valid' }, { id: 'invalid' }] }])
  })

  it('keeps unmatched file-shaped results in an unmatched tool card', () => {
    const items = groupTimelineBlocks([
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'missing',
        data: { content: 'ok', toolUseResult: { filePath: 'a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
      },
    ])

    expect(items).toMatchObject([{ type: 'tool-call', toolUse: null, toolUseId: 'missing', results: [{ id: 'result' }] }])
  })

  it('renders sqlite raw transcript lines with sqlite field headers', () => {
    const html = renderToStaticMarkup(
      createElement(RawMessagesDialog, {
        timeZone: 'Asia/Shanghai',
        lines: [
          {
            session_id: 'session-1',
            byte_offset: 0,
            byte_length: 42,
            line_no: 1,
            uuid: 'user-1',
            type: 'user',
            timestamp_ms: 1760000000000,
            parent_uuid: null,
            is_sidechain: 0,
            user_type: 'external',
            entrypoint: 'cli',
            cwd: '/repo',
            version: '2.1.222',
            git_branch: 'main',
            owner_turn_id: 'user-1',
            raw_json: '{"type":"user","uuid":"user-1"}',
            created_at_ms: 1760000000001,
          },
          {
            session_id: 'session-1',
            byte_offset: 42,
            byte_length: 44,
            line_no: 2,
            uuid: 'attachment-1',
            type: 'attachment',
            timestamp_ms: 1760000001000,
            parent_uuid: 'user-1',
            is_sidechain: 0,
            user_type: null,
            entrypoint: 'cli',
            cwd: '/repo',
            version: '2.1.222',
            git_branch: 'main',
            owner_turn_id: 'user-1',
            raw_json: '{"type":"attachment","uuid":"attachment-1"}',
            created_at_ms: 1760000001001,
          },
          {
            session_id: 'session-1',
            byte_offset: 86,
            byte_length: 43,
            line_no: 3,
            uuid: 'assistant-1',
            type: 'assistant',
            timestamp_ms: 1760000002500,
            parent_uuid: null,
            is_sidechain: 0,
            user_type: 'external',
            entrypoint: 'cli',
            cwd: '/repo',
            version: '2.1.222',
            git_branch: 'main',
            owner_turn_id: 'user-1',
            raw_json: '{"type":"assistant","uuid":"assistant-1"}',
            created_at_ms: 1760000002501,
          },
        ],
        loading: false,
        error: null,
        onClose: () => {},
      }),
    )

    expect(html).toContain('<h3 id="raw-message-waterfall-title">Timing waterfall</h3>')
    expect(html).toContain('<strong>user</strong>')
    expect(html).toContain('<strong>assistant</strong>')
    expect(html).not.toContain('<strong>attachment</strong>')
    expect(html).not.toContain('attachment-1')
    expect(html).not.toContain('&quot;type&quot;: &quot;attachment&quot;')
    expect(html).toContain('<th>timestamp</th>')
    expect(html).toContain('<th>raw_json</th>')
    expect(html).toContain('2025-10-09')
    expect(html).toContain('16:53:20')
    expect(html).toContain('&quot;type&quot;: &quot;user&quot;')
    expect(html).toContain('&quot;uuid&quot;: &quot;user-1&quot;')
    expect(html).not.toContain('<th>project_key</th>')
    expect(html).not.toContain('<th>session_id</th>')
    expect(html).not.toContain('<th>byte_offset</th>')
    expect(html).not.toContain('<th>byte_length</th>')
    expect(html).not.toContain('<th>line_no</th>')
    expect(html).not.toContain('<th>created_at_ms</th>')
    expect(html).not.toContain('<th>is_sidechain</th>')
    expect(html).not.toContain('<th>user_type</th>')
    expect(html).not.toContain('<th>entrypoint</th>')
    expect(html).not.toContain('<th>cwd</th>')
    expect(html).not.toContain('<th>version</th>')
    expect(html).not.toContain('<th>git_branch</th>')
    expect(html).not.toContain('<th>Stop reason</th>')
    expect(html).not.toContain('<th>Block type</th>')
  })

  it('redacts base64 raw messages and never renders invalid raw JSON', () => {
    const line = {
      session_id: 'session-1',
      byte_offset: 0,
      byte_length: 42,
      line_no: 1,
      uuid: 'user-1',
      type: 'user',
      timestamp_ms: null,
      parent_uuid: null,
      is_sidechain: 0,
      user_type: 'external',
      entrypoint: 'cli',
      cwd: '/repo',
      version: '2.1.222',
      git_branch: 'main',
      owner_turn_id: 'user-1',
      raw_json: JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'secret-image' } }),
      created_at_ms: 1,
    }
    const redacted = renderToStaticMarkup(createElement(RawMessagesDialog, { timeZone: 'Asia/Shanghai', lines: [line], loading: false, error: null, onClose: () => {} }))
    const unavailable = renderToStaticMarkup(
      createElement(RawMessagesDialog, { timeZone: 'Asia/Shanghai', lines: [{ ...line, raw_json: 'not valid raw JSON' }], loading: false, error: null, onClose: () => {} }),
    )

    const legacy = renderToStaticMarkup(
      createElement(RawMessagesDialog, {
        timeZone: 'Asia/Shanghai',
        lines: [{ ...line, raw_json: JSON.stringify({ toolUseResult: { type: 'image', file: { type: 'image/png', base64: 'legacy-secret-image' } } }) }],
        loading: false,
        error: null,
        onClose: () => {},
      }),
    )

    expect(redacted).toContain('&quot;media_type&quot;: &quot;image/png&quot;')
    expect(redacted).toContain('[base64 omitted]')
    expect(redacted).not.toContain('secret-image')
    expect(legacy).toContain('[base64 omitted]')
    expect(legacy).not.toContain('legacy-secret-image')
    expect(unavailable).toContain(`[raw JSON unavailable: ${'not valid raw JSON'.length} chars]`)
    expect(unavailable).not.toContain('not valid raw JSON')
    const customImage = renderToStaticMarkup(
      createElement(RawMessagesDialog, {
        timeZone: 'Asia/Shanghai',
        lines: [{ ...line, raw_json: JSON.stringify({ type: 'image', mimeType: 'image/png', data: 'custom-tool-secret-image' }) }],
        loading: false,
        error: null,
        onClose: () => {},
      }),
    )
    expect(customImage).toContain('[base64 omitted]')
    expect(customImage).not.toContain('custom-tool-secret-image')
  })
})

describe('timeline response frame grouping', () => {
  it('renders streaming assistant text without the trailing dot animation', () => {
    const block: TimelineBlock = { id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['stream-1'], data: { type: 'text', text: 'hello', streaming: true } }
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block }))

    expect(html).toContain('hello')
    expect(html).not.toContain('loading-dots')
    expect(html).not.toContain('Assistant is streaming')
  })

  it('maps only exact same-turn Read paths and lets later results replace earlier ones', () => {
    const blocks: TimelineBlock[] = [
      { id: 'read-a', kind: 'assistant.tool_use', sourceEventIds: ['read-a'], toolUseId: 'call-a', data: { name: 'Read', input: { file_path: '/tmp/a/shot.png' } } },
      { id: 'read-b', kind: 'assistant.tool_use', sourceEventIds: ['read-b'], toolUseId: 'call-b', data: { name: 'Read', input: { file_path: '/tmp/b/shot.png' } } },
      {
        id: 'result-a',
        kind: 'tool.result',
        sourceEventIds: ['result-a'],
        toolUseId: 'call-a',
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          toolUseResult: { type: 'image', file: { type: 'image/gif', base64: gif } },
        },
      },
      {
        id: 'result-b',
        kind: 'tool.result',
        sourceEventIds: ['result-b'],
        toolUseId: 'call-b',
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          toolUseResult: { type: 'image', file: { type: 'image/gif', base64: gif } },
        },
      },
      {
        id: 'result-a-later',
        kind: 'tool.result',
        sourceEventIds: ['result-a-later'],
        toolUseId: 'call-a',
        data: { toolUseResult: { type: 'image', file: { type: 'image/gif', base64: gif } } },
      },
      { id: 'wrong-tool', kind: 'assistant.tool_use', sourceEventIds: ['wrong-tool'], toolUseId: 'call-c', data: { name: 'Bash', input: { file_path: '/tmp/c/shot.png' } } },
      { id: 'wrong-result', kind: 'tool.result', sourceEventIds: ['wrong-result'], toolUseId: 'call-c', data: { toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } } },
    ]

    const images = contentImagesFromTurnBlocks(blocks)
    expect([...images.keys()]).toEqual(['/tmp/a/shot.png', '/tmp/b/shot.png'])
    expect(images.get('/tmp/a/shot.png')).toEqual({ mediaType: 'image/gif', data: gif })
    expect(images.get('/tmp/b/shot.png')).toEqual({ mediaType: 'image/png', data: png })
    expect(images.get('shot.png')).toBeUndefined()
    expect(images.get('/tmp/c/shot.png')).toBeUndefined()
  })

  it('normalizes Read image paths like Markdown image sources', () => {
    const blocks: TimelineBlock[] = [
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: '/tmp/截图 甲.png' } } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } } },
    ]

    expect(contentImagesFromTurnBlocks(blocks).get('/tmp/%E6%88%AA%E5%9B%BE%20%E7%94%B2.png')).toEqual({ mediaType: 'image/png', data: png })
  })

  it('excludes errored Read results from the Markdown image map', () => {
    const blocks: TimelineBlock[] = [
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: '/tmp/shot.png' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'call-read',
        data: { is_error: true, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
      },
    ]

    expect(contentImagesFromTurnBlocks(blocks).get('/tmp/shot.png')).toBeUndefined()
  })

  it('excludes Read text wire results from the Markdown image map', () => {
    const blocks: TimelineBlock[] = [
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: '/tmp/shot.png' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'call-read',
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          toolUseResult: { type: 'text', file: { filePath: '/tmp/shot.png', content: 'image-looking file text' } },
        },
      },
    ]

    expect(contentImagesFromTurnBlocks(blocks).get('/tmp/shot.png')).toBeUndefined()
  })

  it('uses wire image only when content has no renderable blocks', () => {
    const blocks: TimelineBlock[] = [
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: '/tmp/shot.png' } } },
      {
        id: 'result',
        kind: 'tool.result',
        sourceEventIds: ['result'],
        toolUseId: 'call-read',
        data: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bm90IGEgcG5n' } }],
          toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } },
        },
      },
    ]

    expect(contentImagesFromTurnBlocks(blocks).get('/tmp/shot.png')).toEqual({ mediaType: 'image/png', data: png })
  })

  it('passes the full turn image map through an assistant response frame', () => {
    const assistant: TimelineBlock = { id: 'assistant', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: '![preview](/tmp/shot.png)' } }
    const turnBlocks: TimelineBlock[] = [
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: '/tmp/shot.png' } } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } } },
      assistant,
    ]
    const html = renderToStaticMarkup(
      createElement(AssistantResponseFrameView, {
        timeZone: 'Asia/Shanghai',
        item: { type: 'assistant-response-frame', id: 'response', items: [{ type: 'block', block: assistant }] },
        turnBlocks,
        phase: 'settled',
        source: 'TRANSCRIPT',
      }),
    )

    expect(html).toContain('loading preview')
    expect(html).not.toContain('src="/tmp/shot.png"')
  })

  it('anchors and highlights only the selected original content block', () => {
    const block: TimelineBlock = { id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['message-1'], data: { text: 'second', originalContentBlockIndex: 2 } }
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block, highlightedMessage: { uuid: 'message-1', blockIndex: 2 } }))

    expect(html).toContain('data-message-uuid="message-1"')
    expect(html).toContain('data-content-block-index="2"')
    expect(html).toContain('timeline-assistant-message-highlighted')
  })

  it('renders mixed primary input in one bubble and footer without exposing base64', () => {
    const blocks: TimelineBlock[] = [
      { id: 'text-1', kind: 'user.message', sourceEventIds: ['message-1'], data: { type: 'text', text: 'first', primaryTimelineUserMessage: true, originalContentBlockIndex: 0 } },
      {
        id: 'image',
        kind: 'user.image',
        sourceEventIds: ['message-1'],
        data: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'secret-image' }, primaryTimelineUserMessage: true, originalContentBlockIndex: 1 },
      },
      { id: 'text-2', kind: 'user.message', sourceEventIds: ['message-1'], data: { type: 'text', text: 'second', primaryTimelineUserMessage: true, originalContentBlockIndex: 2 } },
    ]
    const html = renderToStaticMarkup(
      createElement(PrimaryInputView, {
        timeZone: 'Asia/Shanghai',
        blocks,
        timestamp: Date.UTC(2026, 7, 8, 12, 34),
        cwd: '/repo',
        sessionId: 'session-1',
        entrypoint: 'cli',
        source: 'TRANSCRIPT',
        onViewRaw: () => {},
        highlightedMessage: { uuid: 'message-1', blockIndex: 1 },
      }),
    )

    expect(html.match(/timeline-user-message-highlighted/g) ?? []).toHaveLength(1)
    expect(html.match(/Copy user message text/g) ?? []).toHaveLength(1)
    expect(html.match(/View raw user message/g) ?? []).toHaveLength(1)
    expect(html.match(/<time/g) ?? []).toHaveLength(1)
    expect(html).toContain('08/08 20:34')
    expect(html).toContain('data-content-block-index="0"')
    expect(html).toContain('data-content-block-index="1"')
    expect(html).toContain('data-content-block-index="2"')
    expect(html).toContain('TRANSCRIPT')
    expect(html).not.toContain('secret-image')
  })

  it('does not offer copy for image-only primary input', () => {
    const block: TimelineBlock = {
      id: 'image',
      kind: 'user.image',
      sourceEventIds: ['message-1'],
      data: { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' }, primaryTimelineUserMessage: true, originalContentBlockIndex: 0 },
    }
    const html = renderToStaticMarkup(createElement(PrimaryInputView, { timeZone: 'Asia/Shanghai', blocks: [block], onViewRaw: () => {} }))
    const standalone = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block, onViewRaw: () => {} }))

    expect(html).not.toContain('Copy user message')
    expect(html).toContain('View raw user message')
    expect(html).toContain('Image link:')
    expect(html).not.toContain('<img')
    expect(standalone).toContain('View raw user message')
  })

  it('keeps non-primary user content filtered from the projection', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'primary',
      messages: [
        userMessage('primary', 'prompt'),
        { type: 'user', uuid: 'non-primary', message: { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] } },
      ],
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'user.message', sourceEventIds: ['primary'] })
  })

  it('omits the primary footer entrypoint when the turn has none', () => {
    const primary = projectTimelineTurn(userTurn('turn-1')).find((block) => block.kind === 'user.message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: primary, timestamp: Date.UTC(2026, 7, 8, 12, 34), source: 'TRANSCRIPT' }))

    expect(html).not.toContain('CLI')
    expect(html).not.toContain('SDK-TS')
    expect(html).toContain('TRANSCRIPT')
  })

  it.each(['OPTIMISTIC', 'LIVE', 'TRANSCRIPT'] satisfies PrimaryMessageSource[])('renders %s as the primary message source', (source) => {
    const primary = projectTimelineTurn(userTurn('turn-1')).find((block) => block.kind === 'user.message')!
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { timeZone: 'Asia/Shanghai', block: primary, source }))

    expect(html).toContain(source)
  })

  it('resolves primary and frame sources from message evidence without transcript fallback', () => {
    const transcript: TurnSummary = {
      primaryUserUuid: 'turn-1',
      messages: [userMessage('turn-1'), messageFromBlock({ id: 'assistant', kind: 'assistant.text', sourceEventIds: ['assistant-1'], apiMessageId: 'msg-1', data: { text: 'done' } })],
    }
    const index = timelineTurnIndex([transcript])
    const blocks = projectTimelineTurn(transcript)
    const primary = blocks.find((block) => block.kind === 'user.message')!
    const assistant = blocks.find((block) => block.kind === 'assistant.text')!
    const live = new Map([
      ['uuid:live-primary', 'LIVE' as const],
      ['uuid:live-assistant', 'LIVE' as const],
    ])
    const optimistic = new Map([['uuid:optimistic-primary', 'OPTIMISTIC' as const]])

    expect(primaryMessageSource(primary!, index, live)).toBe('TRANSCRIPT')
    expect(primaryMessageSource({ ...primary!, sourceEventIds: ['live-primary'] }, timelineTurnIndex([]), live)).toBe('LIVE')
    expect(primaryMessageSource({ ...primary!, sourceEventIds: ['optimistic-primary'] }, timelineTurnIndex([]), optimistic)).toBe('OPTIMISTIC')
    expect(primaryMessageSource({ ...primary!, sourceEventIds: ['unknown'] }, timelineTurnIndex([]), live)).toBeNull()
    expect(assistantFrameSource([assistant!], index, live, false)).toBe('TRANSCRIPT')
    expect(assistantFrameSource([{ ...assistant!, sourceEventIds: ['live-assistant'], apiMessageId: undefined }], timelineTurnIndex([]), live, false)).toBe('LIVE')
    expect(assistantFrameSource([{ ...assistant!, sourceEventIds: ['live-assistant'], apiMessageId: undefined }], timelineTurnIndex([]), live, true)).toBe('RECONCILING')
    expect(assistantFrameSource([{ ...assistant!, sourceEventIds: ['unknown'], apiMessageId: undefined }], timelineTurnIndex([]), live, false)).toBeNull()
  })

  it('formats absolute timestamps in the configured time zone', () => {
    const value = Date.UTC(2026, 7, 8, 12, 34)
    expect(renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'UTC', value }))).toContain('08/08 12:34')
    expect(renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai', value }))).toContain('08/08 20:34')
  })

  it.each(['LIVE', 'RECONCILING', 'TRANSCRIPT'] satisfies ResponseSource[])('renders %s as the response source', (source) => {
    const html = renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai', source }))

    expect(html).toContain(source)
  })

  it('formats stable Claude Code-style turn duration labels', () => {
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000 })).toMatch(/^(Thought|Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sauted|Worked) for 21s$/)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 415_000 })).toBe(`${turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000 })?.split(' for ')[0]} for 6m 55s`)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 1 })).toBe('Waiting for 1 background task to finish')
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 2 })).toBe('Waiting for 2 background tasks to finish')
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 0 })).toMatch(/ for 21s$/)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1' })).toBeNull()
  })

  it('uses active labels while cooking, then shows settled status', () => {
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'sdk-ts' }, phase: 'submitted', cooking: true, activeLabel: 'Cooking...' })).toEqual({
      kind: 'cooking',
      label: 'Cooking...',
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'sdk-ts' }, phase: 'rendering', cooking: true, activeLabel: 'Cooking...' })).toEqual({
      kind: 'cooking',
      label: 'Cooking...',
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'sdk-ts', pendingBackgroundAgentCount: 2 }, phase: 'rendering', cooking: true, activeLabel: 'Cooking...' })).toEqual({
      kind: 'waiting',
      label: 'Waiting for 2 background tasks to finish',
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000, entrypoint: 'cli', pendingBackgroundAgentCount: 2 }, phase: 'settled', cooking: false })).toEqual({
      kind: 'waiting',
      label: 'Waiting for 2 background tasks to finish',
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000, entrypoint: 'cli' }, phase: 'settled', cooking: false })?.label).toMatch(/ for 21s$/)
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'cli' }, phase: 'settled', cooking: false, reconciling: true })).toEqual({
      kind: 'cooking',
      label: turnCookingLabel('turn-1'),
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'cli' }, phase: 'settled', cooking: false })).toEqual({
      kind: 'duration',
      label: stableTurnVerb('turn-1'),
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', entrypoint: 'other' }, phase: 'settled', cooking: false })).toEqual({
      kind: 'duration',
      label: stableTurnVerb('turn-1'),
    })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000 }, phase: 'settled', cooking: false, reconciling: true })?.label).toMatch(/ for 21s$/)
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000, entrypoint: 'cli' }, phase: 'settled', cooking: false, primaryOnly: true })).toBeNull()
  })

  it('allows settled transcript-owned responses to fork without a duration footer', () => {
    expect(canForkAssistantResponse({ transcriptOwned: true, phase: 'settled', forkMessageId: 'assistant', enabled: true })).toBe(true)
    expect(canForkAssistantResponse({ transcriptOwned: true, phase: 'rendering', forkMessageId: 'assistant', enabled: true })).toBe(false)
    expect(canForkAssistantResponse({ transcriptOwned: false, phase: 'settled', forkMessageId: 'assistant', enabled: true })).toBe(false)
    expect(canForkAssistantResponse({ transcriptOwned: true, phase: 'settled', forkMessageId: null, enabled: true })).toBe(false)
    expect(canForkAssistantResponse({ transcriptOwned: true, phase: 'settled', forkMessageId: 'assistant', enabled: false })).toBe(false)
  })

  it('allows response footer metadata to wrap by character while staying hover-revealed', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineTimestamp, {
        timeZone: 'Asia/Shanghai',
        value: Date.UTC(2026, 7, 8, 12, 34),
        className: 'block group-hover:opacity-100 focus-within:opacity-100 !inline !whitespace-normal align-middle [overflow-wrap:anywhere] [&>*]:align-middle [&_button]:align-middle',
        copyText: 'answer',
        source: 'TRANSCRIPT',
      }),
    )

    expect(html).toContain('!inline')
    expect(html).toContain('!whitespace-normal')
    expect(html).toContain('[overflow-wrap:anywhere]')
    expect(html).toContain('[&amp;&gt;*]:align-middle')
    expect(html.match(/inline-block h-3 w-px/g)).toBeNull()
    expect(html).toContain('opacity-0')
    expect(html).toContain('group-hover:opacity-100')
  })

  it.each(['cli', 'sdk-ts'])('orders %s footer timestamp before actions and transcript source in the hover group', (entrypoint) => {
    const html = renderToStaticMarkup(
      createElement(TimelineTimestamp, {
        timeZone: 'Asia/Shanghai',
        value: Date.UTC(2026, 7, 8, 12, 34),
        className: 'group-hover:opacity-100 focus-within:opacity-100',
        cwd: '/repo/cotta',
        sessionId: 'session-1',
        entrypoint,
        copyText: 'answer',
        copyLabel: 'Copy assistant response',
        onViewRaw: () => {},
        viewRawLabel: 'View raw assistant response',
        onViewSubagents: () => {},
        subagentCount: 3,
        midActions: createElement('button', { type: 'button', 'aria-label': 'Fork session from this response' }, 'Fork'),
        extraActions: createElement('button', { type: 'button', 'aria-label': 'Share this turn' }, 'Share'),
        source: 'TRANSCRIPT',
      }),
    )

    const positions = [
      '<time',
      'Copy working directory',
      'Copy session ID',
      'View subagents',
      'Fork session from this response',
      'View raw assistant response',
      'Copy assistant response',
      'Share this turn',
      'TRANSCRIPT',
    ].map((value) => html.indexOf(value))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(html).toContain('><time')
    expect(html).toContain('data-tooltip="CWD:\n/repo/cotta"')
    expect(html).toContain(`data-tooltip="${entrypoint.toUpperCase()} Session:\nsession-1"`)
    expect(html).toContain(`data-icon="${entrypoint === 'cli' ? 'terminal' : 'browser'}"`)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(html).toContain('opacity-0')
    expect(html).toContain('group-hover:opacity-100')
    expect(html).toContain('focus-within:opacity-100')
    expect(html).not.toContain('tracking-')
    expect(html).not.toContain('font-bold')
    expect(html).not.toContain('text-xs')
  })

  it('only renders the reserved subagent action when it has a handler', () => {
    expect(renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai' }))).not.toContain('View subagents')
    expect(renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai', onViewSubagents: () => {}, subagentCount: 0 }))).not.toContain('View subagents')
    expect(renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai', onViewSubagents: () => {}, subagentCount: 3 }))).toContain('data-tooltip="Subagents (3)"')
  })

  it('renders the subagent hierarchy with agent identity titles and description subtitles', () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: 'Investigate subagents',
        tree: [
          {
            metadataReady: true,
            agentId: 'root-agent',
            parentAgentId: null,
            agentType: 'Explore',
            name: 'scanner',
            description: 'Inspect the code',
            model: null,
            transcriptVersion: null,
            transcriptModifiedAtMs: null,
          },
          {
            metadataReady: true,
            agentId: 'child-agent',
            parentAgentId: 'root-agent',
            agentType: 'Plan',
            name: null,
            description: 'Design the change',
            model: null,
            transcriptVersion: null,
            transcriptModifiedAtMs: null,
          },
          {
            metadataReady: true,
            agentId: 'grandchild-agent',
            parentAgentId: 'child-agent',
            agentType: null,
            name: null,
            description: null,
            model: null,
            transcriptVersion: null,
            transcriptModifiedAtMs: null,
          },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: null,
        transcript: undefined,
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )
    expect(html).toContain('<h2 id="subagents-dialog-title">Subagents</h2>')
    expect(html).toContain('<p>Investigate subagents</p>')
    expect(html).not.toContain('Work delegated from this response')
    expect(html).toContain('Explore · scanner')
    expect(html).toContain('Inspect the code')
    expect(html).toContain('aria-label="Expand Explore · scanner"')
    expect(html).not.toContain('>Plan<')
    expect(html).not.toContain('Subagent ld-agent')
    expect(html.match(/<ul>/g)).toHaveLength(1)
    expect(html).toContain('subagents-tree-age')
    expect(html).toContain('>—</span>')
  })

  it('renders metadata-pending roots as disabled placeholders', () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: null,
        tree: [
          {
            metadataReady: false,
            agentId: 'root-agent-12345678',
            parentAgentId: null,
            agentType: null,
            name: null,
            description: null,
            model: null,
            transcriptVersion: null,
            transcriptModifiedAtMs: null,
          },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: null,
        transcript: undefined,
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )

    expect(html).toContain('Subagent 12345678')
    expect(html).toContain('Waiting for subagent metadata')
    expect(html).toContain('disabled=""')
  })

  it('stops traversing cyclic subagent parents', () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: null,
        tree: [
          {
            metadataReady: true,
            agentId: 'agent-a',
            parentAgentId: 'agent-b',
            agentType: 'Explore',
            name: null,
            description: null,
            model: null,
            transcriptVersion: null,
            transcriptModifiedAtMs: null,
          },
          { metadataReady: true, agentId: 'agent-b', parentAgentId: 'agent-a', agentType: 'Plan', name: null, description: null, model: null, transcriptVersion: null, transcriptModifiedAtMs: null },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: 'agent-a',
        transcript: undefined,
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )

    expect(html).toContain('<h2 id="subagents-dialog-title">Subagents</h2>')
  })

  it('passes full subagent turn blocks to assistant Markdown images', () => {
    const path = '/tmp/subagent-shot.png'
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: null,
        tree: [
          { metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: 'v1', transcriptModifiedAtMs: null },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: 'agent-1',
        transcript: {
          version: 'v1',
          turns: [
            userTurn('user-1', [
              { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { id: 'call-read', name: 'Read', input: { file_path: path } } },
              { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { toolUseResult: { type: 'image', file: { type: 'image/png', base64: png } } } },
              { id: 'assistant', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: `![subagent preview](${path})` } },
            ]),
          ],
        },
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )

    expect(html).toContain('loading preview')
    expect(html).not.toContain(`src="${path}"`)
  })

  it('renders subagent transcript turns separately', () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: null,
        tree: [
          { metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: 'v1', transcriptModifiedAtMs: null },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: 'agent-1',
        transcript: {
          version: 'v1',
          turns: [
            userTurn('user-1', [{ id: 'user-1', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'first' } }]),
            userTurn('user-2', [{ id: 'user-2', kind: 'user.message', sourceEventIds: ['user-2'], data: { text: 'second' } }]),
          ],
        },
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )

    expect(html).toContain('first')
    expect(html).toContain('second')
    expect(html).toContain('<section class="session-workspace-view"><section class="timeline-panel">')
    expect(html.match(/turn-card/g)).toHaveLength(2)
  })

  it('renders subagent metadata without duration or main-session actions', () => {
    const turn = {
      ...userTurn('user-1', [
        { id: 'user-1', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'question' } },
        { id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['assistant-1'], data: { text: 'answer' }, apiMessageId: 'message-1' },
      ]),
      primaryUserTimestampMs: 1_000,
      userCwd: '/repo/user',
      responseCwd: '/repo/response',
      durationMs: 2_000,
      durationTimestampMs: 3_000,
      entrypoint: 'sdk-ts',
    }
    const html = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        sessionTitle: null,
        tree: [
          { metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: 'v1', transcriptModifiedAtMs: null },
        ],
        treeLoading: false,
        treeError: null,
        selectedAgentId: 'agent-1',
        transcript: { version: 'v1', turns: [turn] },
        transcriptLoading: false,
        transcriptError: null,
        onSelect: () => {},
        onClose: () => {},
      }),
    )

    expect(html).toContain('dateTime="1970-01-01T00:00:01.000Z"')
    expect(html).not.toContain('dateTime="1970-01-01T00:00:03.000Z"')
    expect(html).toContain('data-tooltip="CWD:\n/repo/user"')
    expect(html).toContain('data-tooltip="CWD:\n/repo/response"')
    expect(html.match(/data-tooltip="Subagent ID:\nagent-1"/g)).toHaveLength(2)
    expect(html.match(/aria-label="Copy Subagent ID"/g)).toHaveLength(2)
    expect(html).not.toContain(' for 2s')
    expect(html).not.toContain('>TRANSCRIPT<')
    expect(html).not.toContain('data-tooltip="Trace"')
    expect(html).not.toContain('Fork session from this response')
    expect(html).not.toContain('View subagents')
  })

  it('renders the main session skeletons while subagents load', () => {
    const defaults = {
      sessionTitle: null,
      treeError: null,
      transcript: undefined,
      transcriptError: null,
      onSelect: () => {},
      onClose: () => {},
    }
    const railHtml = renderToStaticMarkup(createElement(SubagentsDialog, { timeZone: 'Asia/Shanghai', ...defaults, tree: [], treeLoading: true, selectedAgentId: null, transcriptLoading: false }))
    const transcriptHtml = renderToStaticMarkup(
      createElement(SubagentsDialog, {
        timeZone: 'Asia/Shanghai',
        ...defaults,
        tree: [
          { metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: null, transcriptModifiedAtMs: null },
        ],
        treeLoading: false,
        selectedAgentId: 'agent-1',
        transcriptLoading: true,
      }),
    )

    expect(railHtml).toContain('session-list-skeleton')
    expect(railHtml.match(/session-row-skeleton"/g)).toHaveLength(3)
    expect(railHtml).not.toContain('Loading subagents…')
    expect(transcriptHtml).toContain('timeline-skeleton-panel')
    expect(transcriptHtml.match(/timeline-skeleton-turn"/g)).toHaveLength(3)
    expect(transcriptHtml).not.toContain('Loading transcript…')
  })

  it('uses the terminal icon when entrypoint is missing', () => {
    const html = renderToStaticMarkup(createElement(TimelineTimestamp, { timeZone: 'Asia/Shanghai', sessionId: 'session-1' }))
    expect(html).toContain('data-icon="terminal"')
  })

  it('hides response entrypoint and source when debug source is disabled', () => {
    const html = renderToStaticMarkup(
      createElement(AssistantResponseFrameView, {
        timeZone: 'Asia/Shanghai',
        item: {
          type: 'assistant-response-frame',
          id: 'response-1',
          items: [{ type: 'block', block: { id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['assistant-1'], data: { text: 'answer' } } }],
        },
        turnBlocks: [{ id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['assistant-1'], data: { text: 'answer' } }],
        timestamp: Date.UTC(2026, 7, 8, 12, 34),
        phase: 'settled',
        cwd: '/repo/cotta',
        sessionId: 'session-1',
        entrypoint: 'sdk-ts',
        source: 'TRANSCRIPT',
        showSource: false,
        onViewRaw: () => {},
      }),
    )

    expect(html).not.toContain('>SDK-TS<')
    expect(html).not.toContain('>TRANSCRIPT<')
    expect(html).toContain('Copy working directory')
    expect(html).toContain('Copy session ID')
    expect(html).toContain('Copy assistant response')
    expect(html).toContain('View raw assistant response')
    expect(html).toContain('<time')
  })

  it('settles transcript turns and keeps optimistic or live overlays active', () => {
    const submitted = userTurn('turn-1')
    const rendering = userTurn('turn-1', [{ id: 'assistant', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'hello' } }])
    expect(turnPhase({ turn: submitted, overlayActive: true, pendingPhase: 'submitting' })).toBe('submitting')
    expect(turnPhase({ turn: submitted, overlayActive: true })).toBe('submitted')
    expect(turnPhase({ turn: rendering, overlayActive: true })).toBe('rendering')
    expect(turnPhase({ turn: submitted, overlayActive: false, activeUserMessageUuid: 'turn-1' })).toBe('submitted')
    expect(turnPhase({ turn: rendering, overlayActive: false, activeUserMessageUuid: 'turn-1' })).toBe('rendering')
    expect(turnPhase({ turn: rendering, overlayActive: false, activeUserMessageUuid: 'other-turn' })).toBe('settled')
    expect(turnPhase({ turn: rendering, overlayActive: false, activeUserMessageUuid: null, assumeActive: true })).toBe('rendering')
    expect(turnPhase({ turn: { ...rendering, durationMs: 100 }, overlayActive: true, activeUserMessageUuid: 'turn-1', assumeActive: true })).toBe('settled')
  })

  it('tokens only projected visible data and changes for visible notifications', () => {
    const settled = { ...userTurn('turn-1'), durationMs: 100, blocks: projectTimelineTurn(userTurn('turn-1')) }
    const rawOnly = { ...settled, messages: [...settled.messages, { type: 'result' }] }
    const notification = { id: 'notification', kind: 'assistant.task_notification', sourceEventIds: ['notification-1'], data: {} } as TimelineBlock
    expect(turnVisibleDataToken(rawOnly)).toBe(turnVisibleDataToken(settled))
    expect(turnVisibleDataToken({ ...rawOnly, blocks: [...settled.blocks, notification] })).not.toBe(turnVisibleDataToken(settled))
  })

  it('lets observed rendering or settlement supersede an optimistic phase', () => {
    expect(authoritativeTurnPhase('submitted', 'settled')).toBe('settled')
    expect(authoritativeTurnPhase('submitted', 'rendering')).toBe('rendering')
    expect(authoritativeTurnPhase('submitting', null)).toBe('submitting')
    expect(authoritativeTurnPhase('submitting', 'submitted')).toBe('submitting')
  })

  it('derives submit states from requests and latest turn phase', () => {
    expect(submitStateFor({ submitting: true, stopping: false, latestPhase: 'settled' })).toBe('submitting')
    expect(submitStateFor({ submitting: false, stopping: true, latestPhase: 'rendering' })).toBe('stopping')
    expect(submitStateFor({ submitting: false, stopping: false, latestPhase: null })).toBe('ready')
    expect(submitStateFor({ submitting: false, stopping: false, latestPhase: 'settled' })).toBe('ready')
    expect(submitStateFor({ submitting: false, stopping: false, latestPhase: 'submitting' })).toBe('busy')
    expect(submitStateFor({ submitting: false, stopping: false, latestPhase: 'submitted' })).toBe('busy')
    expect(submitStateFor({ submitting: false, stopping: false, latestPhase: 'rendering' })).toBe('busy')
  })

  it('derives external ownership from occupiedBy', () => {
    const session = (overrides: Partial<NonNullable<Parameters<typeof sessionExternallyOwned>[0]>> = {}) => ({ occupiedBy: null, ...overrides })

    expect(sessionExternallyOwned(session({ occupiedBy: 'external' }))).toBe(true)
    expect(sessionExternallyOwned(session({ occupiedBy: 'cotta' }))).toBe(false)
    expect(sessionExternallyOwned(session())).toBe(false)
  })

  it('does not frame empty streaming text or thinking starts', () => {
    const emptyStarts = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'empty-text', kind: 'assistant.text', sourceEventIds: ['empty-text'], data: { text: '', streaming: true } },
        { id: 'empty-thinking', kind: 'assistant.thinking', sourceEventIds: ['empty-thinking'], data: { thinking: '', streaming: true } },
      ]),
    )
    const tool = groupAssistantResponseFrames(
      groupTimelineBlocks([{ id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'apps/web/src/timeline.tsx' } } }]),
    )

    expect(emptyStarts).toEqual([
      { type: 'item', item: { type: 'block', block: { id: 'empty-text', kind: 'assistant.text', sourceEventIds: ['empty-text'], data: { text: '', streaming: true } } } },
      { type: 'item', item: { type: 'block', block: { id: 'empty-thinking', kind: 'assistant.thinking', sourceEventIds: ['empty-thinking'], data: { thinking: '', streaming: true } } } },
    ])
    expect(tool[0]).toMatchObject({ type: 'assistant-response-frame', items: [{ type: 'tool-call', toolUseId: 'call-read' }] })
  })

  it('hides management tool cards without leaving empty response frames', () => {
    const taskOnly = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'task-create', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-task', data: { name: 'TaskCreate', input: { subject: 'Task' } } },
        { id: 'task-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-task', data: { content: 'Task #1 created successfully' } },
      ]),
    )
    const agentsOnly = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'list-agents', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-list-agents', data: { name: 'ListAgents', input: {} } },
        { id: 'list-agents-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-list-agents', data: { content: 'Subagents (0)' } },
      ]),
    )
    const listAgentsError = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'list-agents', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-list-agents', data: { name: 'ListAgents', input: {} } },
        { id: 'list-agents-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-list-agents', data: { is_error: true, content: 'Failed' } },
      ]),
    )
    const mixed = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'Working' } },
        { id: 'task-update', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-update', data: { name: 'TaskUpdate', input: { taskId: '1' } } },
        { id: 'task-update-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-update', data: { content: 'Updated' } },
      ]),
    )
    const taskErrors = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].map((name) =>
      groupAssistantResponseFrames(
        groupTimelineBlocks([
          { id: `${name}-use`, kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: `call-${name}`, data: { name, input: {} } },
          { id: `${name}-result`, kind: 'tool.result', sourceEventIds: ['result'], toolUseId: `call-${name}`, data: { is_error: true, content: 'Failed' } },
        ]),
      ),
    )

    expect(taskOnly).toEqual([])
    expect(taskErrors).toEqual([[], [], [], []])
    expect(agentsOnly).toEqual([])
    expect(listAgentsError).toHaveLength(1)
    expect(listAgentsError[0]).toMatchObject({ type: 'assistant-response-frame', items: [{ type: 'tool-call', toolUseId: 'call-list-agents' }] })
    expect(mixed).toHaveLength(1)
    expect(mixed[0]).toMatchObject({ type: 'assistant-response-frame', items: [{ type: 'block', block: { id: 'assistant:text' } }] })
  })

  it('groups adjacent thinking and whitelisted tool calls with their results', () => {
    const items = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect first' } },
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'apps/web/src/timeline.tsx' } } },
      { id: 'read-result', kind: 'tool.result', sourceEventIds: ['read-result'], toolUseId: 'call-read', data: { content: 'file contents' } },
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'activity-group',
      items: [
        { type: 'block', block: { id: 'thinking' } },
        { type: 'tool-call', toolUseId: 'call-read', results: [{ id: 'read-result' }] },
      ],
    })
  })

  it.each([
    ['Read', { file_path: 'a.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'timeline' }],
    ['mcp__codegraph__codegraph_explore', { query: 'timeline' }],
    ['Bash', { command: 'rg timeline apps/web' }],
    ['Bash', { command: 'cat apps/web/src/timeline.tsx' }],
    ['Bash', { command: 'ls apps/web/src' }],
  ])('groups %s activity with adjacent thinking', (toolName, input) => {
    const toolUseId = `call-${toolName}-${JSON.stringify(input)}`
    const items = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Find context' } },
      { id: toolUseId, kind: 'assistant.tool_use', sourceEventIds: [toolUseId], toolUseId, data: { name: toolName, input } },
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'activity-group', items: [{ type: 'block' }, { type: 'tool-call', toolUseId }] })
  })

  it.each([
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'rg timeline > matches.txt' }],
    ['Bash', { command: 'rg timeline', run_in_background: true }],
    ['Bash', { command: 'rg timeline', dangerouslyDisableSandbox: true }],
    ['Edit', {}],
    ['Write', {}],
    ['WebSearch', {}],
    ['WebFetch', {}],
    ['UnknownTool', {}],
  ])('keeps unsupported %s activity outside adjacent groups', (toolName, input) => {
    const items = groupTimelineBlocks([
      { id: 'thinking-1', kind: 'assistant.thinking', sourceEventIds: ['thinking-1'], data: { thinking: 'First' } },
      { id: 'read-1', kind: 'assistant.tool_use', sourceEventIds: ['read-1'], toolUseId: 'call-read-1', data: { name: 'Read', input: { file_path: 'a.ts' } } },
      { id: 'breaker', kind: 'assistant.tool_use', sourceEventIds: ['breaker'], toolUseId: 'call-breaker', data: { name: toolName, input } },
      { id: 'thinking-2', kind: 'assistant.thinking', sourceEventIds: ['thinking-2'], data: { thinking: 'Second' } },
      { id: 'read-2', kind: 'assistant.tool_use', sourceEventIds: ['read-2'], toolUseId: 'call-read-2', data: { name: 'Read', input: { file_path: 'b.ts' } } },
    ])

    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ type: 'activity-group' })
    expect(items[1]).toMatchObject({ type: 'tool-call', toolUseId: 'call-breaker' })
    expect(items[2]).toMatchObject({ type: 'activity-group' })
  })

  it('keeps foreground Bash grouped when its result includes a background task id', () => {
    const items = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
      { id: 'bash', kind: 'assistant.tool_use', sourceEventIds: ['bash'], toolUseId: 'call-bash', data: { name: 'Bash', input: { command: 'rg timeline' } } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-bash', data: { toolUseResult: { backgroundTaskId: 'task-1' } } },
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'activity-group',
      items: [
        { type: 'block', block: { id: 'thinking' } },
        { type: 'tool-call', toolUseId: 'call-bash', results: [{ id: 'result' }] },
      ],
    })
  })

  it('uses thinking durations for thought summaries without counting tool time', () => {
    const settled = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'A', timelineTimestampMs: 1000, durationMs: 2500 } },
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' }, timelineTimestampMs: 3500 } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { content: 'done', timelineTimestampMs: 9000 } },
    ])
    const active = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'A', durationMs: 2500, timelineTimestampMs: 1000 } },
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' }, timelineTimestampMs: 3500 } },
    ])

    expect(settled[0]).toMatchObject({ type: 'activity-group', startedAtMs: 1000, endedAtMs: 9000, active: false, hasThinking: true })
    expect(settled[0]?.type === 'activity-group' ? activityGroupSummary(settled[0]) : null).toBe('Thought for 3s, read 1 file')
    expect(active[0]).toMatchObject({ type: 'activity-group', startedAtMs: 1000, active: true, hasThinking: true })
    expect(active[0]?.type === 'activity-group' ? activityGroupSummary(active[0], 11_000) : null).toBe('Thinking for 3s, reading 1 file')
  })

  it('keeps coalesced thinking timestamps, known durations, and streaming activity state', () => {
    const items = groupTimelineBlocks([
      { id: 'thinking-1', kind: 'assistant.thinking', sourceEventIds: ['thinking-1'], apiMessageId: 'msg-1', data: { thinking: 'A', timelineTimestampMs: 1000, durationMs: 500 } },
      { id: 'thinking-2', kind: 'assistant.thinking', sourceEventIds: ['thinking-2'], apiMessageId: 'msg-1', data: { thinking: 'B', streaming: true, timelineTimestampMs: 2000 } },
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' }, timelineTimestampMs: 3500 } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { content: 'done', timelineTimestampMs: 7000 } },
    ])

    expect(items[0]).toMatchObject({ type: 'activity-group', startedAtMs: 1000, active: true, hasThinking: true })
    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0], 8000) : null).toBe('Thinking for 7s, reading 1 file')
  })

  it('includes grouped tool errors in the folded summary', () => {
    const items = groupTimelineBlocks([
      { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'A', timelineTimestampMs: 1000, durationMs: 6000 } },
      { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' }, timelineTimestampMs: 3500 } },
      { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { content: 'failed', is_error: true, timelineTimestampMs: 7000 } },
      { id: 'duplicate-result', kind: 'tool.result', sourceEventIds: ['duplicate-result'], toolUseId: 'call-read', data: { content: 'still failed', is_error: true, timelineTimestampMs: 7001 } },
    ])

    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0]) : null).toBe('Thought for 6s, read 1 file, 1 error')
  })

  it('stops unmatched activity groups when the turn has ended', () => {
    const items = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'A', timelineTimestampMs: 1000 } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' }, timelineTimestampMs: 3500 } },
      ],
      false,
      9000,
    )

    expect(items[0]).toMatchObject({ type: 'activity-group', startedAtMs: 1000, endedAtMs: 9000, active: false, hasThinking: true })
    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0], 20_000) : null).toBe('Thought, read 1 file')
  })

  it('uses the last grouped activity source event as fork target', () => {
    const display = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'answer' } },
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: { file_path: 'a.ts' } } },
        { id: 'read-result', kind: 'tool.result', toolUseId: 'call-read', sourceEventIds: ['result-1', 'result-2'], data: { content: 'done' } },
      ]),
    )
    const frame = display.find((item) => item.type === 'assistant-response-frame')

    expect(frame?.type === 'assistant-response-frame' ? assistantResponseFrameForkMessageId(frame) : null).toBe('result-2')
  })

  it('summarizes grouped activity as Claude Code-style text', () => {
    const items = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect', timelineTimestampMs: 1000, durationMs: 6000 } },
        { id: 'read-a', kind: 'assistant.tool_use', sourceEventIds: ['read-a'], toolUseId: 'call-read-a', data: { name: 'Read', input: { file_path: 'a.ts' } } },
        { id: 'read-b', kind: 'assistant.tool_use', sourceEventIds: ['read-b'], toolUseId: 'call-read-b', data: { name: 'Read', input: { file_path: 'a.ts' } } },
        { id: 'grep', kind: 'assistant.tool_use', sourceEventIds: ['grep'], toolUseId: 'call-grep', data: { name: 'Grep', input: { pattern: 'timeline' } } },
        { id: 'search', kind: 'assistant.tool_use', sourceEventIds: ['search'], toolUseId: 'call-search', data: { name: 'Bash', input: { command: 'rg timeline apps/web' } } },
        { id: 'list', kind: 'assistant.tool_use', sourceEventIds: ['list'], toolUseId: 'call-list', data: { name: 'Bash', input: { command: 'ls apps/web' } } },
        {
          id: 'codegraph',
          kind: 'assistant.tool_use',
          sourceEventIds: ['codegraph'],
          toolUseId: 'call-codegraph',
          data: { name: 'mcp__codegraph__codegraph_explore', input: { query: 'timeline' }, timelineTimestampMs: 7100 },
        },
        { id: 'codegraph-result', kind: 'tool.result', sourceEventIds: ['codegraph-result'], toolUseId: 'call-codegraph', data: { is_error: true } },
      ],
      false,
    )

    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0]) : null).toBe('Thought for 6s, searched for 2 patterns, read 1 file, listed 1 directory, called MCP Codegraph, 1 error')
    if (items[0]?.type !== 'activity-group') throw new Error('expected activity group')
    expect(activityGroupSummary({ ...items[0], active: true })).toContain('Thinking for 6s')
    expect(activityGroupSummary({ ...items[0], active: true })).toContain('calling MCP Codegraph')
    expect(activityGroupHasToolUseId(items[0], 'call-search')).toBe(true)
    expect(activityGroupHasToolUseId(items[0], 'missing')).toBe(false)
  })

  it('summarizes Bash inspection evidence without treating stdin filters as reads', () => {
    const items = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'pwd', kind: 'assistant.tool_use', sourceEventIds: ['pwd'], toolUseId: 'call-pwd', data: { name: 'Bash', input: { command: 'pwd | head' } } },
        { id: 'search', kind: 'assistant.tool_use', sourceEventIds: ['search'], toolUseId: 'call-search', data: { name: 'Bash', input: { command: 'rg timeline | sort' } } },
      ],
      false,
    )

    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0]) : null).toBe('Thought, searched for 1 pattern, inspected context with 1 command')
  })

  it('counts grouped Read targets only when the path is known', () => {
    const withResultPath = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: {} } },
        { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { toolUseResult: { type: 'text', file: { filePath: 'a.ts', content: 'A' } } } },
      ],
      false,
    )
    const withoutPath = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: {} } },
      ],
      false,
    )

    expect(withResultPath[0]?.type === 'activity-group' ? activityGroupSummary(withResultPath[0]) : null).toBe('Thought, read 1 file')
    expect(withoutPath[0]?.type === 'activity-group' ? activityGroupSummary(withoutPath[0]) : null).toBe('Thought')
  })

  it('deduplicates known Read and Bash file targets within the same cwd', () => {
    const bashOnly = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'cat', kind: 'assistant.tool_use', sourceEventIds: ['cat'], toolUseId: 'call-cat', data: { name: 'Bash', input: { command: 'cat a.ts' } } },
        { id: 'tail', kind: 'assistant.tool_use', sourceEventIds: ['tail'], toolUseId: 'call-tail', data: { name: 'Bash', input: { command: 'tail b.ts' } } },
      ],
      false,
    )
    const withRead = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', cwd: '/repo', input: { file_path: '/repo/a.ts' } } },
        { id: 'cat', kind: 'assistant.tool_use', sourceEventIds: ['cat'], toolUseId: 'call-cat', data: { name: 'Bash', cwd: '/repo', input: { command: 'cat ./a.ts' } } },
      ],
      false,
    )

    expect(bashOnly[0]?.type === 'activity-group' ? activityGroupSummary(bashOnly[0]) : null).toBe('Thought, read 2 files')
    expect(withRead[0]?.type === 'activity-group' ? activityGroupSummary(withRead[0]) : null).toBe('Thought, read 1 file')
  })

  it('uses result cwd when a Read path comes from the result', () => {
    const items = groupTimelineBlocks(
      [
        { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['thinking'], data: { thinking: 'Inspect' } },
        { id: 'read', kind: 'assistant.tool_use', sourceEventIds: ['read'], toolUseId: 'call-read', data: { name: 'Read', input: {} } },
        { id: 'result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-read', data: { cwd: '/repo', toolUseResult: { type: 'text', file: { filePath: 'a.ts', content: 'A' } } } },
        { id: 'cat', kind: 'assistant.tool_use', sourceEventIds: ['cat'], toolUseId: 'call-cat', data: { name: 'Bash', cwd: '/repo', input: { command: 'cat a.ts' } } },
      ],
      false,
    )

    expect(items[0]?.type === 'activity-group' ? activityGroupSummary(items[0]) : null).toBe('Thought, read 1 file')
  })

  it('groups adjacent primary blocks once while leaving local commands separate', () => {
    const primaryBlocks: TimelineBlock[] = [
      { id: 'primary:text', kind: 'user.message', sourceEventIds: ['primary'], data: { text: 'prompt', primaryTimelineUserMessage: true } },
      { id: 'primary:image', kind: 'user.image', sourceEventIds: ['primary'], data: { type: 'image', primaryTimelineUserMessage: true } },
    ]
    const display = groupAssistantResponseFrames(
      groupTimelineBlocks([
        ...primaryBlocks,
        { id: 'local', kind: 'user.local_command', sourceEventIds: ['local'], data: { text: '/clear', primaryTimelineUserMessage: true } },
        { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'answer' } },
        { id: 'assistant:text:2', kind: 'assistant.text', sourceEventIds: ['assistant-2'], data: { text: 'more' } },
        { id: 'non-primary:user', kind: 'user.message', sourceEventIds: ['non-primary'], data: { text: 'debug user event' } },
      ]),
    )

    expect(display).toHaveLength(3)
    expect(display[0]).toMatchObject({ type: 'primary-input', blocks: [{ id: 'primary:text' }, { id: 'primary:image' }] })
    expect(display[1]).toMatchObject({ type: 'item', item: { type: 'block', block: { id: 'local' } } })
    expect(display[2]).toMatchObject({ type: 'assistant-response-frame' })
    expect(
      display[2]?.type === 'assistant-response-frame' ? display[2].items.map((item) => (item.type === 'block' ? item.block.id : item.type === 'tool-call' ? item.toolUseId : item.id)) : [],
    ).toEqual(['assistant:text', 'assistant:text:2', 'non-primary:user'])
    expect(display[2]?.type === 'assistant-response-frame' ? assistantResponseText(display[2].items) : null).toBe('answer\nmore')
  })

  it('uses the last response frame source event as fork target', () => {
    const display = groupAssistantResponseFrames(
      groupTimelineBlocks([
        { id: 'primary:user', kind: 'user.message', sourceEventIds: ['primary'], data: { text: 'prompt', primaryTimelineUserMessage: true } },
        { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'answer' } },
        { id: 'tool:result', kind: 'tool.result', toolUseId: 'tool-1', sourceEventIds: ['result-1', 'result-2'], data: { content: 'done' } },
      ]),
    )
    const frame = display.find((item) => item.type === 'assistant-response-frame')

    expect(frame?.type === 'assistant-response-frame' ? assistantResponseFrameForkMessageId(frame) : null).toBe('result-2')
  })
})

describe('timeline raw-message protocol', () => {
  it('projects history and live messages through one block pipeline', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      primaryUserTimestampMs: 1,
      messages: [
        userMessage('user-1', 'hello'),
        { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } },
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } },
      ],
    }

    expect(projectTimelineTurn(turn)).toEqual([
      expect.objectContaining({ kind: 'user.message', data: expect.objectContaining({ text: 'hello', primaryTimelineUserMessage: true }) }),
      expect.objectContaining({ kind: 'assistant.text', apiMessageId: 'msg-1', sourceEventIds: ['assistant-1'], data: expect.objectContaining({ text: 'final', originalContentBlockIndex: 0 }) }),
    ])
  })

  it('projects mixed primary content in order with original indexes', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'secret-image' } },
      { type: 'text', text: 'second' },
      { type: 'document', source: { type: 'text', data: 'document' } },
      { type: 'search_result', title: 'result', source: 'https://example.com', content: 'match' },
      { type: 'tool_reference', tool_name: 'Read' },
      { type: 'future_content', data: 'future' },
    ]
    const blocks = userBlocksFromMessage({ message: { role: 'user', content } }, 'user-1', true)

    expect(blocks.map((block) => block.kind)).toEqual(['user.message', 'user.image', 'user.message', 'user.document', 'user.search_result', 'user.tool_reference', 'user.content'])
    expect(blocks.map((block) => (block.data as { originalContentBlockIndex?: number }).originalContentBlockIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(blocks[6]?.data).toMatchObject({ type: 'future_content', primaryTimelineUserMessage: true })
  })

  it('keeps original content block indexes on projected assistant blocks', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        {
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'assistant text' },
            ],
          },
        },
      ],
    })

    expect(blocks.find((block) => block.kind === 'assistant.text')?.data).toMatchObject({ originalContentBlockIndex: 1 })
  })

  it('keeps separate assistant records that share an API message id', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1', 'hello'),
        { type: 'assistant', uuid: 'assistant-text', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Need mark task complete.' }] } },
        { type: 'assistant', uuid: 'assistant-tool', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'TaskUpdate', input: { taskId: '5' } }] } },
      ],
    }

    expect(projectTimelineTurn(turn)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant.text', sourceEventIds: ['assistant-text'], data: expect.objectContaining({ text: 'Need mark task complete.' }) }),
        expect.objectContaining({ kind: 'assistant.tool_use', sourceEventIds: ['assistant-tool'], toolUseId: 'call-1' }),
      ]),
    )
  })

  it('derives segmented transcript thinking durations across intervening tool results', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'assistant', uuid: 'thinking-1', timestamp: 1000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'A' }] } },
        { type: 'user', uuid: 'status', timestamp: 1500, message: { role: 'user', content: 'status' } },
        { type: 'user', uuid: 'tool-result', timestamp: 2000, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } },
        { type: 'assistant', uuid: 'thinking-2', timestamp: 4000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'B' }] } },
        { type: 'assistant', uuid: 'tool-1', timestamp: 9000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'a.ts' } }] } },
      ],
    })

    expect(blocks.filter((block) => block.kind === 'assistant.thinking').map((block) => block.data)).toEqual([
      expect.objectContaining({ thinking: 'A', durationMs: 3000 }),
      expect.objectContaining({ thinking: 'B', durationMs: 5000 }),
    ])
  })

  it('invalidates pending transcript thinking at the next different-id assistant record', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'assistant', uuid: 'thinking-1', timestamp: 1000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'A' }] } },
        { type: 'assistant', uuid: 'other-1', timestamp: 2000, message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'other' }] } },
        { type: 'assistant', uuid: 'text-1', timestamp: 7000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ],
    })

    expect(blocks.find((block) => block.kind === 'assistant.thinking')?.data).not.toMatchObject({ durationMs: expect.any(Number) })
  })

  it('does not attach transcript thinking duration to an abandoned API message', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'start-1', timestamp: 1000, event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'thinking-1', timestamp: 2000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } } },
        { type: 'assistant', uuid: 'thinking-2', timestamp: 4000, message: { id: 'msg-2', role: 'assistant', content: [{ type: 'thinking', thinking: 'B' }] } },
        { type: 'assistant', uuid: 'text-2', timestamp: 9000, message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ],
    })
    const thinking = blocks.filter((block) => block.kind === 'assistant.thinking')

    expect(thinking).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ thinking: 'A' }) }),
      expect.objectContaining({ sourceEventIds: ['thinking-2'], data: expect.objectContaining({ thinking: 'B', durationMs: 5000 }) }),
    ])
    expect(thinking[0]?.data).not.toHaveProperty('durationMs')
    expect(thinking[0]?.data).not.toHaveProperty('streaming')
  })

  it.each([
    ['missing timestamp', undefined, 2000],
    ['invalid timestamp', 'not-a-date', 2000],
    ['reversed timestamp', 2000, 1000],
    ['no next assistant boundary', 1000, undefined],
  ])('leaves transcript thinking duration unknown for %s', (_case, thinkingTimestamp, boundaryTimestamp) => {
    const messages: TurnSummary['messages'] = [
      userMessage('user-1'),
      {
        type: 'assistant',
        uuid: 'thinking-1',
        ...(thinkingTimestamp === undefined ? {} : { timestamp: thinkingTimestamp }),
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'A' }] },
      },
    ]
    if (boundaryTimestamp !== undefined)
      messages.push({ type: 'assistant', uuid: 'text-1', timestamp: boundaryTimestamp, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } })

    expect(projectTimelineTurn({ primaryUserUuid: 'user-1', messages }).find((block) => block.kind === 'assistant.thinking')?.data).not.toMatchObject({ durationMs: expect.any(Number) })
  })

  it('applies a transcript record duration once and keeps it when adjacent thinking coalesces', () => {
    const items = groupTimelineBlocks(
      projectTimelineTurn({
        primaryUserUuid: 'user-1',
        messages: [
          userMessage('user-1'),
          {
            type: 'assistant',
            uuid: 'thinking-1',
            timestamp: 1000,
            message: {
              id: 'msg-1',
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'A' },
                { type: 'thinking', thinking: 'B' },
              ],
            },
          },
          { type: 'assistant', uuid: 'text-1', timestamp: 4000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        ],
      }),
    )
    const thinking = items.find((item) => item.type === 'block' && item.block.kind === 'assistant.thinking')

    expect(thinking).toMatchObject({ type: 'block', block: { data: { thinking: 'AB', durationMs: 3000 } } })
  })

  it('keeps finalized text when later assistant records share its API message id', () => {
    const messages: TurnSummary['messages'] = [
      userMessage('user-1', 'hello'),
      { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } },
      { type: 'assistant', uuid: 'assistant-text', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } },
      { type: 'assistant', uuid: 'assistant-task', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-task', name: 'TaskUpdate', input: { taskId: '5' } }] } },
    ]
    const display = () => groupAssistantResponseFrames(groupTimelineBlocks(projectTimelineTurn({ primaryUserUuid: 'user-1', messages })))

    expect(display()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant-response-frame',
          items: [expect.objectContaining({ type: 'block', block: expect.objectContaining({ sourceEventIds: ['assistant-text'], data: expect.objectContaining({ text: 'final' }) }) })],
        }),
      ]),
    )

    messages.push({
      type: 'assistant',
      uuid: 'assistant-tool',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-visible', name: 'Bash', input: { command: 'pwd' } }] },
    })
    const frame = display().find((item) => item.type === 'assistant-response-frame')
    expect(frame?.type === 'assistant-response-frame' ? assistantResponseText(frame.items) : null).toBe('final')
    expect(frame?.type === 'assistant-response-frame' ? frame.items : []).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool-call', toolUseId: 'call-visible' })]))
  })

  it('keeps local-command caveats out of the live overlay without filtering Skill meta', () => {
    const caveat = {
      type: 'user',
      uuid: 'caveat',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>generated command context</local-command-caveat>' },
    }
    const skillMeta = {
      type: 'user',
      uuid: 'skill-meta',
      isMeta: true,
      sourceToolUseID: 'call-skill',
      message: { role: 'user', content: [{ type: 'text', text: '**loaded**' }] },
    }
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-skill', name: 'Skill', input: {} }] } },
      ],
    }

    const ignored = applySdkMessage([turn], caveat, timelineTurnIndex([]), 'user-1')
    const retained = applySdkMessage(ignored.turns, skillMeta, timelineTurnIndex([]), 'user-1')

    expect(ignored).toEqual({ turns: [turn], currentUserMessageUuid: 'user-1', terminal: false })
    expect(projectTimelineTurn(retained.turns[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill.meta', sourceEventIds: ['skill-meta'] })]))
  })

  it('stores SDK messages canonically and confirms a pending raw user message', () => {
    const pending = userTurn('user-1')
    const raw = { type: 'user', uuid: 'user-1', session_id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', entrypoint: 'sdk-ts', message: { role: 'user', content: 'hello' } }

    const result = applySdkMessage([pending], raw, timelineTurnIndex([]), 'user-1')

    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]).toMatchObject({ entrypoint: 'sdk-ts', messages: [raw] })
    expect(projectTimelineTurn(result.turns[0]!)[0]?.data).toMatchObject({ text: 'hello', primaryTimelineUserMessage: true })
  })

  it('keeps the entrypoint and cwd when a live primary message starts a turn', () => {
    const raw = { type: 'user', uuid: 'user-1', entrypoint: 'sdk-ts', cwd: '/repo/start', message: { role: 'user', content: 'hello' } }

    const result = applySdkMessage([], raw, timelineTurnIndex([]), null)

    expect(result.turns[0]).toMatchObject({ primaryUserUuid: 'user-1', entrypoint: 'sdk-ts', userCwd: '/repo/start', messages: [raw] })
  })

  it('settles live thinking on failure without rendering the control event', () => {
    const streamStart = { type: 'stream_event', uuid: 'start', timestamp: 1000, event: { type: 'message_start', message: { id: 'msg-1' } } }
    const thinkingStart = { type: 'stream_event', uuid: 'thinking', timestamp: 2000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } } }
    const turn: TurnSummary = { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), streamStart, thinkingStart] }
    const failure = { type: 'cotta_live_turn_failed', error: 'boom', session_id: 'session-1' }

    const result = applySdkMessage([turn], failure, timelineTurnIndex([]), 'user-1')
    const materialized = materializeTimelineTurns(
      result.turns,
      [userTurn('user-1')],
      new Map([
        ['uuid:start', 'LIVE'],
        ['uuid:thinking', 'LIVE'],
      ]),
    )

    expect(result.terminal).toBe(true)
    expect(result.turns[0]?.messages).toContain(failure)
    for (const projectedTurn of [result.turns[0]!, materialized.turns[0]!]) {
      const blocks = projectTimelineTurn(projectedTurn)
      const thought = blocks.find((block) => block.kind === 'assistant.thinking')
      expect(thought?.data).not.toHaveProperty('streaming')
      expect(thought?.data).not.toHaveProperty('durationMs')
      expect(blocks).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'raw.cotta_live_turn_failed' })]))
    }
  })

  it('creates a live local command root and attaches its feedback', () => {
    const command = { type: 'system', subtype: 'local_command', uuid: 'command', content: '<command-name>/model</command-name><command-message>model</command-message>' }
    const feedback = { type: 'system', subtype: 'local_command', uuid: 'stdout', parentUuid: 'command', content: '<local-command-stdout>Set model to Example</local-command-stdout>' }
    let turns = applySdkMessage([], command, timelineTurnIndex([]), null).turns

    turns = applySdkMessage(turns, feedback, timelineTurnIndex([]), null).turns

    expect(projectTimelineTurn(turns[0]!)[0]).toMatchObject({ kind: 'user.local_command', sourceEventIds: ['command', 'stdout'], data: { text: '/model (Set model to Example)' } })
  })

  it('does not project live system messages without a product meaning', () => {
    const turn = userTurn('user-1')
    const modelStatus = { type: 'system', subtype: 'status', uuid: 'model-status', model: 'claude-opus-5' }
    const result = applySdkMessage([turn], modelStatus, timelineTurnIndex([]), 'user-1')

    expect(result.turns[0]?.messages).toContain(modelStatus)
    expect(projectTimelineTurn(result.turns[0]!)).toEqual(projectTimelineTurn(turn))
  })

  it('keeps SDK result messages as terminal events and records response cwd', () => {
    const turn = userTurn('user-1')
    const success = applySdkMessage([turn], { type: 'result', subtype: 'success', cwd: '/repo/end' }, timelineTurnIndex([]), 'user-1')
    const failure = applySdkMessage([turn], { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, timelineTurnIndex([]), 'user-1')

    expect(success.terminal).toBe(true)
    expect(success.turns[0]).toMatchObject({ responseCwd: '/repo/end' })
    expect(failure.terminal).toBe(true)
  })

  it('stales live-only messages before the newest history turn and preserves live cwd on the watermark', () => {
    const firstUser = userMessage('user-1', 'first')
    const staleUser = userMessage('stale-user')
    const staleAssistant = { type: 'assistant', uuid: 'stale-assistant', message: { id: 'stale-msg', role: 'assistant', content: [{ type: 'text', text: 'stale' }] } }
    const secondUser = userMessage('user-2', 'second')
    const liveAssistant = { type: 'assistant', uuid: 'live-assistant', message: { id: 'live-msg', role: 'assistant', content: [{ type: 'text', text: 'live' }] } }
    const current: TurnSummary[] = [
      { primaryUserUuid: 'user-1', primaryUserTimestampMs: 1, messages: [firstUser, staleUser, staleAssistant] },
      { primaryUserUuid: 'user-2', primaryUserTimestampMs: 2, userCwd: '/repo/start', responseCwd: '/repo/end', messages: [secondUser, liveAssistant] },
    ]
    const history: TurnSummary[] = [
      { primaryUserUuid: 'user-1', primaryUserTimestampMs: 1, durationMs: 10, messages: [firstUser] },
      { primaryUserUuid: 'user-2', primaryUserTimestampMs: 2, messages: [secondUser] },
    ]

    const merged = reconcileTimelineTurns(current, history)

    expect(merged[0]).toMatchObject({ durationMs: 10, messages: [firstUser] })
    expect(merged[1]).toMatchObject({ userCwd: '/repo/start', responseCwd: '/repo/end', messages: [secondUser, liveAssistant] })
  })

  it('stales live turns inside the history page before the watermark', () => {
    const current: TurnSummary[] = [
      { primaryUserUuid: 'older-page', primaryUserTimestampMs: 5, messages: [] },
      { primaryUserUuid: 'stale-live', primaryUserTimestampMs: 15, messages: [] },
      { primaryUserUuid: 'equal-live', primaryUserTimestampMs: 20, messages: [] },
      { primaryUserUuid: 'newer-live', primaryUserTimestampMs: 25, messages: [] },
    ]
    const history: TurnSummary[] = [
      { primaryUserUuid: 'history-1', primaryUserTimestampMs: 10, messages: [] },
      { primaryUserUuid: 'history-2', primaryUserTimestampMs: 20, messages: [] },
    ]

    expect(reconcileTimelineTurns(current, history).map((turn) => turn.primaryUserUuid)).toEqual(['older-page', 'history-1', 'history-2', 'equal-live', 'newer-live'])
  })

  it('keeps unorderable live data when the history watermark has no timestamp', () => {
    const historyUser = userMessage('user-2')
    const liveAssistant = { type: 'assistant', uuid: 'live-assistant', message: { id: 'live-msg', role: 'assistant', content: [] } }
    const current: TurnSummary[] = [
      { primaryUserUuid: 'unknown-live', messages: [] },
      { primaryUserUuid: 'user-2', messages: [historyUser, liveAssistant] },
    ]
    const history: TurnSummary[] = [{ primaryUserUuid: 'user-2', messages: [historyUser] }]

    const merged = reconcileTimelineTurns(current, history)

    expect(merged[0]?.messages).toEqual([historyUser, liveAssistant])
    expect(merged[1]?.primaryUserUuid).toBe('unknown-live')
  })

  it('routes late tool results and task notifications to the tool-use owner turn', () => {
    const toolUse = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { prompt: 'Investigate' } }] },
    }
    let turns: TurnSummary[] = [
      { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), toolUse] },
      { primaryUserUuid: 'user-2', messages: [userMessage('user-2')] },
    ]
    const result = { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const notification = {
      type: 'user',
      uuid: 'task-1',
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-1</tool-use-id><status>completed</status><result>done</result></task-notification>' },
    }

    turns = applySdkMessage(turns, result, timelineTurnIndex([]), 'user-2').turns
    turns = applySdkMessage(turns, notification, timelineTurnIndex([]), 'user-2').turns

    expect(projectTimelineTurn(turns[0]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool.result', toolUseId: 'call-1' }),
        expect.objectContaining({ kind: 'assistant.task_notification', data: expect.objectContaining({ originalToolUse: { id: 'call-1', name: 'Agent', input: { prompt: 'Investigate' } } }) }),
      ]),
    )
    expect(turns[1]?.messages).toHaveLength(1)
  })

  it('keeps unlinked task notifications on the active turn', () => {
    const notification = {
      type: 'user',
      uuid: 'task-1',
      promptSource: 'sdk',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><status>stopped</status></task-notification>' },
    }
    const turns = applySdkMessage([userTurn('user-1')], notification, timelineTurnIndex([]), 'user-1').turns

    expect(turns).toHaveLength(1)
    expect(turns[0]?.messages).toHaveLength(2)
    expect(projectTimelineTurn(turns[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'assistant.task_notification', sourceEventIds: ['task-1'] })]))
  })

  it('projects tool result timestamps from their owner message', () => {
    const timestamp = Date.UTC(2026, 0, 1, 0, 0, 5)
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [userMessage('user-1'), { type: 'user', uuid: 'result-1', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }],
    }

    expect(projectTimelineTurn(turn)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool.result', data: expect.objectContaining({ timelineTimestampMs: timestamp }) })]))
  })

  it('projects stripped task notifications by their history turn ownership', () => {
    const notification = {
      type: 'user',
      uuid: 'task-1',
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-1</tool-use-id><status>stopped</status></task-notification>' },
    }
    const turn: TurnSummary = { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), notification] }

    expect(projectTimelineTurn(turn)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'assistant.task_notification', sourceEventIds: ['task-1'] })]))
  })

  it('keeps pasted task notification text primary when history says it is primary', () => {
    const pasted = { type: 'user', uuid: 'user-1', message: { role: 'user', content: '<task-notification><task-id>task-1</task-id></task-notification>' } }

    expect(projectTimelineTurn({ primaryUserUuid: 'user-1', messages: [pasted] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'user.message', sourceEventIds: ['user-1'], data: expect.objectContaining({ primaryTimelineUserMessage: true }) })]),
    )
  })

  it('drops a stale pseudo-turn once history owns its primary UUID as a message', () => {
    const notification = { type: 'user', uuid: 'task-1', message: { role: 'user', content: '<task-notification><task-id>task-1</task-id></task-notification>' } }
    const current: TurnSummary[] = [userTurn('user-1'), { primaryUserUuid: 'task-1', primaryUserTimestampMs: 2, messages: [notification] }]
    const incoming: TurnSummary[] = [{ primaryUserUuid: 'user-1', primaryUserTimestampMs: 1, messages: [userMessage('user-1'), notification] }]

    expect(reconcileTimelineTurns(current, incoming).map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
  })

  it('keeps lifecycle stops from closing live thinking', () => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } }, timestamp: 1000 })
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'thinking', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } }, timestamp: 2000 })

    expect(accumulator.processStreamEvent({ type: 'stream_event', uuid: 'block-stop', event: { type: 'content_block_stop', index: 0 }, timestamp: 5000 })).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ streaming: true, timelineTimestampMs: 2000 }) }),
    ])
    expect(accumulator.processStreamEvent({ type: 'stream_event', uuid: 'message-stop', event: { type: 'message_stop' }, timestamp: 6000 })).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ streaming: true, timelineTimestampMs: 2000 }) }),
    ])
  })

  it('preserves live stream drafts until the final assistant message replaces them', () => {
    let turns = [userTurn('user-1')]
    const index = timelineTurnIndex([])
    turns = applySdkMessage(turns, { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } }, index, 'user-1').turns
    turns = applySdkMessage(turns, { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } }, index, 'user-1').turns
    expect(projectTimelineTurn(turns[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'assistant.text', data: expect.objectContaining({ text: 'draft', streaming: true }) })]))

    turns = applySdkMessage(turns, { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } }, index, 'user-1').turns
    const assistantBlocks = projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'assistant.text')
    expect(assistantBlocks).toHaveLength(1)
    expect(assistantBlocks[0]?.data).toMatchObject({ text: 'final' })
  })

  it('closes live thinking at the next same-message content block, including thinking', () => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } }, timestamp: 1000 })
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'think-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } }, timestamp: 2000 })

    expect(
      accumulator.processStreamEvent({ type: 'stream_event', uuid: 'think-2', event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'B' } }, timestamp: 6000 }),
    ).toEqual([expect.objectContaining({ data: expect.objectContaining({ durationMs: 4000 }) }), expect.objectContaining({ data: expect.objectContaining({ thinking: 'B', streaming: true }) })])
    expect(
      accumulator.processStreamEvent({ type: 'stream_event', uuid: 'text', event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'done' } }, timestamp: 9000 }),
    ).toEqual([expect.objectContaining({ data: expect.objectContaining({ thinking: 'B', durationMs: 3000 }) }), expect.objectContaining({ kind: 'assistant.text' })])
  })

  it('keeps tool results transparent to live thinking', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'start', timestamp: 1000, event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'thinking', timestamp: 2000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } } },
        { type: 'user', uuid: 'result-1', timestamp: 5000, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } },
      ],
    }

    expect(projectTimelineTurn(turn).find((block) => block.kind === 'assistant.thinking')?.data).toMatchObject({ streaming: true, timelineTimestampMs: 2000 })
  })

  it('preserves a reconciled thinking stream until a later same-id assistant output closes it', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'start', timestamp: 1000, event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'thinking', timestamp: 2000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } } },
        { type: 'assistant', uuid: 'thinking-final', timestamp: 6000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'A' }] } },
        { type: 'assistant', uuid: 'text-final', timestamp: 9000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ],
    }

    expect(projectTimelineTurn(turn).filter((block) => block.kind === 'assistant.thinking')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ durationMs: 7000, timelineTimestampMs: 2000 }) }),
    ])
  })

  it('abandons live thinking without duration at a different id or terminal boundary', () => {
    const messages = [
      userMessage('user-1'),
      { type: 'stream_event', uuid: 'start', timestamp: 1000, event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', uuid: 'thinking', timestamp: 2000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } } },
    ]
    for (const boundary of [
      { type: 'assistant', uuid: 'other', timestamp: 9000, message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', uuid: 'terminal', timestamp: 9000 },
    ]) {
      const thought = projectTimelineTurn({ primaryUserUuid: 'user-1', messages: [...messages, boundary] }).find((block) => block.kind === 'assistant.thinking')
      expect(thought?.data).not.toMatchObject({ streaming: true })
      expect(thought?.data).not.toHaveProperty('durationMs')
    }
  })

  it('does not invent live thinking duration when final assistant arrives without a stop boundary', () => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } }, timestamp: 1000 })
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'thinking', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } }, timestamp: 2000 })

    expect(
      accumulator.finalAssistantBlocks({ type: 'assistant', uuid: 'assistant-1', timestamp: 10_000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'A' }] } }),
    ).toEqual([expect.objectContaining({ kind: 'assistant.thinking', data: expect.not.objectContaining({ durationMs: expect.any(Number) }) })])
  })

  it.each([
    ['invalid', 'not-a-date'],
    ['reversed', 1000],
  ])('abandons live thinking at an %s timestamp boundary', (_case, timestamp) => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } }, timestamp: 1000 })
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'thinking', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } }, timestamp: 2000 })

    const blocks = accumulator.processStreamEvent({ type: 'stream_event', uuid: 'text', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'done' } }, timestamp })

    expect(blocks[0]).toMatchObject({ kind: 'assistant.thinking', data: { thinking: 'A' } })
    expect(blocks[0]?.data).not.toHaveProperty('streaming')
    expect(blocks[0]?.data).not.toHaveProperty('durationMs')
  })

  it('does not close live thinking across a new assistant API message id', () => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start-1', event: { type: 'message_start', message: { id: 'msg-1' } }, timestamp: 1000 })
    accumulator.processStreamEvent({ type: 'stream_event', uuid: 'think-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } }, timestamp: 2000 })
    const abandoned = accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start-2', event: { type: 'message_start', message: { id: 'msg-2' } }, timestamp: 9000 })

    expect(abandoned).toEqual([expect.objectContaining({ kind: 'assistant.thinking', data: expect.not.objectContaining({ durationMs: expect.any(Number), streaming: true }) })])
  })

  it('stamps timestampless live stream drafts with the receive time', () => {
    let turns = [userTurn('user-1')]
    const index = timelineTurnIndex([])
    turns = applySdkMessage(turns, { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } }, index, 'user-1', 1000).turns
    turns = applySdkMessage(
      turns,
      { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'draft' } } },
      index,
      'user-1',
      2000,
    ).turns
    turns = applySdkMessage(
      turns,
      { type: 'stream_event', uuid: 'delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } } },
      index,
      'user-1',
      3000,
    ).turns

    expect(projectTimelineTurn(turns[0]!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'assistant.thinking', data: expect.objectContaining({ timelineTimestampMs: 2000, streaming: true }) })]),
    )
  })

  it('uses SDK UUID as the uniform message identity without payload fallback', () => {
    expect(messageIdentity({ type: 'stream_event', uuid: 'stream-1', event: { type: 'content_block_delta', delta: { text: 'first' } } })).toBe('uuid:stream-1')
    expect(messageIdentity({ type: 'stream_event', uuid: 'stream-1', event: { type: 'message_stop' } })).toBe('uuid:stream-1')
    expect(messageIdentity({ type: 'stream_event', event: { type: 'message_stop' } })).toBeNull()
  })

  it('deduplicates the current turn by UUID while preserving equal payloads with different UUIDs', () => {
    const first = { type: 'stream_event', uuid: 'stream-1', event: { type: 'message_stop' } }
    const replay = { ...first }
    const distinct = { ...first, uuid: 'stream-2' }
    let turns = applySdkMessage([userTurn('user-1')], first, timelineTurnIndex([]), 'user-1').turns
    turns = applySdkMessage(turns, replay, timelineTurnIndex([]), 'user-1').turns
    turns = applySdkMessage(turns, distinct, timelineTurnIndex([]), 'user-1').turns

    expect(turns[0]?.messages).toEqual([
      userMessage('user-1'),
      expect.objectContaining({ ...first, timestamp: expect.any(Number) }),
      expect.objectContaining({ ...distinct, timestamp: expect.any(Number) }),
    ])
  })

  it('merges same-UUID tool result variants without erasing content', () => {
    const first = {
      type: 'user',
      uuid: 'result-1',
      promptId: 'prompt-1',
      toolUseResult: { type: 'text', file: { filePath: '/repo/a.ts', content: 'full content' } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'full content' }] },
    }
    const update = { ...first, promptId: 'prompt-2', toolUseResult: { type: 'text', file: { filePath: '/repo/a.ts', content: '', numLines: 1 } } }
    const toolUse = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { id: 'message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
    }
    let turns: TurnSummary[] = [{ primaryUserUuid: 'user-1', messages: [userMessage('user-1'), toolUse] }]
    turns = applySdkMessage(turns, first, timelineTurnIndex([]), 'user-1').turns
    turns = applySdkMessage(turns, update, timelineTurnIndex([]), 'user-1').turns

    expect(turns[0]?.messages).toHaveLength(3)
    expect(turns[0]?.messages[2]).toMatchObject({ promptId: 'prompt-2', toolUseResult: { file: { content: 'full content', numLines: 1 } } })
    const results = projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'tool.result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ toolUseResult: { file: { content: 'full content', numLines: 1 } } })
  })

  it('converges transcript variants in first-seen position', () => {
    const first = {
      type: 'user',
      uuid: 'result-1',
      toolUseResult: { file: { content: 'full' } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'full' }] },
    }
    const update = { ...first, toolUseResult: { file: { content: '', totalLines: 4 } } }
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } },
        first,
        update,
      ],
    })

    expect(blocks.filter((block) => block.kind === 'tool.result')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ toolUseResult: { file: { content: 'full', totalLines: 4 } } }) }),
    ])
  })

  it('applies identical deltas with distinct UUIDs once each', () => {
    const index = timelineTurnIndex([])
    const start = { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } }
    const block = { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }
    const delta = { type: 'stream_event', uuid: 'delta-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } } }
    let turns = [userTurn('user-1')]
    for (const message of [start, block, delta, { ...delta, uuid: 'delta-2' }, delta]) turns = applySdkMessage(turns, message, index, 'user-1').turns

    expect(projectTimelineTurn(turns[0]!).find((item) => item.kind === 'assistant.text')?.data).toMatchObject({ text: 'haha' })
  })

  it('indexes canonical message identities rather than projected blocks', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      durationMs: 1,
      messages: [userMessage('user-1'), { type: 'assistant', uuid: 'assistant-1', timestamp: 1000, message: { id: 'msg-1', content: [] } }],
    }
    expect(timelineTurnIndex([turn])).toEqual({
      primaryUserUuids: new Set(['user-1']),
      messageIds: new Set(['uuid:user-1', 'uuid:assistant-1']),
    })
  })

  it('O23: ignores secondary live events before the first primary message', () => {
    const result = { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const notification = {
      type: 'user',
      uuid: 'task-1',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>' },
    }
    const delta = { type: 'stream_event', uuid: 'delta-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } } }

    for (const event of [result, notification, delta]) {
      expect(applySdkMessage([], event, timelineTurnIndex([]), null)).toEqual({ turns: [], currentUserMessageUuid: null, terminal: false })
    }
  })

  it('O24: handles deltas before stream and block starts without duplicate content', () => {
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    const delta = { type: 'stream_event', uuid: 'delta-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } }

    expect(accumulator.processStreamEvent(delta)).toEqual([])
    expect(accumulator.processStreamEvent({ type: 'stream_event', uuid: 'start-1', event: { type: 'message_start', message: { id: 'msg-1' } } })).toEqual([])
    expect(accumulator.processStreamEvent(delta)).toEqual([
      expect.objectContaining({ kind: 'assistant.text', apiMessageId: 'msg-1', data: expect.objectContaining({ text: 'hello', streaming: true }) }),
    ])
    expect(accumulator.processStreamEvent({ type: 'stream_event', uuid: 'block-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })).toEqual([
      expect.objectContaining({ kind: 'assistant.text', apiMessageId: 'msg-1', data: expect.objectContaining({ text: '', streaming: true }) }),
    ])
    expect(accumulator.finalAssistantBlocks({ type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] } })).toEqual([
      expect.objectContaining({ kind: 'assistant.text', apiMessageId: 'msg-1', sourceEventIds: ['assistant-1'], data: expect.objectContaining({ text: 'hello' }) }),
    ])
  })

  it('O25: deduplicates replayed assistant finals and task notifications by UUID', () => {
    const final = { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
    const notification = {
      type: 'user',
      uuid: 'task-1',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>' },
    }
    let turns = [userTurn('user-1')]

    for (const event of [final, final, notification, notification]) turns = applySdkMessage(turns, event, timelineTurnIndex([]), 'user-1').turns

    expect(turns[0]?.messages).toEqual([userMessage('user-1'), final, notification])
    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'assistant.text')).toHaveLength(1)
    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'assistant.task_notification')).toHaveLength(1)
  })

  it('O22: ignores unknown live input and keeps later legal events', () => {
    let turns = [userTurn('user-1')]
    const unknown = { type: 'unknown_event', uuid: 'unknown-1', payload: 'ignored' }
    const final = { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } }

    turns = applySdkMessage(turns, 'not json', timelineTurnIndex([]), 'user-1').turns
    turns = applySdkMessage(turns, unknown, timelineTurnIndex([]), 'user-1').turns
    turns = applySdkMessage(turns, final, timelineTurnIndex([]), 'user-1').turns

    expect(turns[0]?.messages).toEqual([userMessage('user-1'), final])
    expect(rawMessageBlock(unknown).kind).toBe('raw.unknown_event')
    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'raw.unknown_event')).toHaveLength(0)
    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'assistant.text')).toHaveLength(1)
  })

  it('O26: keeps repeated tool_use_id ownership consistent in the live overlay', () => {
    const toolUse = (uuid: string) => ({
      type: 'assistant',
      uuid: `assistant-${uuid}`,
      message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }] },
    })
    const result = { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const turns = [
      { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), toolUse('1')] },
      { primaryUserUuid: 'user-2', messages: [userMessage('user-2'), toolUse('2')] },
    ]
    const liveTurns = applySdkMessage(turns, result, timelineTurnIndex([]), 'user-2').turns

    expect(projectTimelineTurn(liveTurns[0]!).some((block) => block.kind === 'tool.result')).toBe(false)
  })

  it('O27: does not duplicate a multi-result message across tool owners', () => {
    const toolUse = (turn: string, id: string) => ({
      type: 'assistant',
      uuid: `assistant-${turn}`,
      message: { id: `msg-${turn}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
    })
    const result = {
      type: 'user',
      uuid: 'result-both',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'one' },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'two' },
        ],
      },
    }
    const turns = applySdkMessage(
      [
        { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), toolUse('1', 'call-1')] },
        { primaryUserUuid: 'user-2', messages: [userMessage('user-2'), toolUse('2', 'call-2')] },
      ],
      result,
      timelineTurnIndex([]),
      'user-2',
    ).turns

    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'tool.result')).toHaveLength(1)
    expect(projectTimelineTurn(turns[1]!).filter((block) => block.kind === 'tool.result')).toHaveLength(1)
  })

  it('O28: holds late results out of the active turn while the owner is outside the refresh window', () => {
    const lateResult = { type: 'user', uuid: 'late-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const turns = applySdkMessage([userTurn('active')], lateResult, timelineTurnIndex([]), 'active').turns

    expect(projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'tool.result')).toHaveLength(0)
  })

  it('adopts only explicitly bound assistant local-command roots without changing runtime ownership', () => {
    const bound = { type: 'assistant', uuid: 'command', user_message_uuid: 'submission', local_command_source: '/model opus' }
    const unbound = { type: 'assistant', uuid: 'other', local_command_source: '/clear' }

    expect(localCommandRootForSubmission(bound, 'submission')?.uuid).toBe('command')
    expect(localCommandRootForSubmission(unbound, 'submission')).toBeNull()
    const applied = applySdkMessage([], bound, timelineTurnIndex([]), 'submission')
    expect(applied.currentUserMessageUuid).toBe('submission')
    expect(projectTimelineTurn(applied.turns[0]!)[0]).toMatchObject({ kind: 'user.local_command' })
  })

  it('does not invent runtime ownership for an assistant local-command root', () => {
    const command = { type: 'assistant', uuid: 'command', local_command_source: '/clear' }

    const applied = applySdkMessage([], command, timelineTurnIndex([]), null)

    expect(applied.currentUserMessageUuid).toBeNull()
    expect(applied.turns).toHaveLength(1)
  })

  it('adopts full timeline evidence only through U1 or its exact runtime projection', () => {
    const page = (runtimeTurnProjection: SessionTimelineResponse['runtimeTurnProjection']): SessionTimelineResponse =>
      ({ turns: [{ primaryUserUuid: 'command', messages: [] }], runtimeTurnProjection }) as unknown as SessionTimelineResponse

    expect(resolvePendingSubmission(page({ submissionUuid: 'submission', kind: 'visible', visibleTurnUuid: 'command' }), 'submission')).toEqual({ kind: 'visible', turnUuid: 'command' })
    expect(resolvePendingSubmission(page(null), 'submission')).toBeNull()
    expect(resolvePendingSubmission(page({ submissionUuid: 'submission', kind: 'terminal-only' }), 'submission')).toBeNull()
    expect(resolvePendingSubmission(page({ submissionUuid: 'submission', kind: 'terminal-only' }), 'submission', true)).toEqual({ kind: 'terminal-only' })
  })

  it('O34: keeps the primary user anchor before response frames even if assistant evidence arrives first', () => {
    const assistant = { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'draft' }] } }
    const turn: TurnSummary = { primaryUserUuid: 'user-1', messages: [assistant, userMessage('user-1')] }

    expect(groupTimelineBlocks(projectTimelineTurn(turn))[0]).toMatchObject({ type: 'block', block: expect.objectContaining({ kind: 'user.message' }) })
  })
})

describe('transcript tail snapshots', () => {
  it('O16: tolerates a stale older page that overlaps an existing turn without replacing live content', () => {
    const live = { type: 'assistant', uuid: 'live-1', message: { id: 'msg-live', role: 'assistant', content: [{ type: 'text', text: 'still running' }] } }
    const current = [
      { ...userTurn('b'), primaryUserTimestampMs: 2, messages: [userMessage('b'), live] },
      { ...userTurn('c'), primaryUserTimestampMs: 3 },
    ]
    const older = [
      { ...userTurn('a'), primaryUserTimestampMs: 1 },
      { ...userTurn('b'), primaryUserTimestampMs: 2 },
    ]

    const merged = prependOlderTimelineTurns(current, older)

    expect(merged.map((turn) => turn.primaryUserUuid)).toEqual(['a', 'b', 'c'])
    expect(merged[1]?.messages).toEqual([userMessage('b'), live])
  })

  it('materializes only explicitly evidenced overlays and keeps its index transcript-only', () => {
    const liveResponse = { type: 'assistant', uuid: 'live-response', message: { id: 'msg-live', role: 'assistant', content: [{ type: 'text', text: 'streaming' }] } }
    const current: TurnSummary[] = [
      { ...userTurn('a'), primaryUserTimestampMs: 1 },
      { ...userTurn('stale'), primaryUserTimestampMs: 2 },
      { primaryUserUuid: 'live', primaryUserTimestampMs: 3, messages: [userMessage('live'), liveResponse] },
    ]
    const snapshot = [{ ...userTurn('a'), primaryUserTimestampMs: 1, durationMs: 10 }]
    const materialized = materializeTimelineTurns(current, snapshot, new Map([['uuid:live-response', 'LIVE']]))

    expect(materialized.turns.map((turn) => turn.primaryUserUuid)).toEqual(['a', 'live'])
    expect(materialized.turns[1]?.messages).toEqual([liveResponse])
    expect(materialized.transcriptIndex.messageIds).toEqual(new Set(['uuid:a']))
    expect(materialized.transcriptIndex.messageIds.has('uuid:live-response')).toBe(false)
  })

  it('removes only the contiguous stream segment replayed by an exact transcript assistant UUID', () => {
    const earlierStreamStart = { type: 'stream_event', uuid: 'earlier-stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } }
    const earlierStreamBlock = { type: 'stream_event', uuid: 'earlier-stream-block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'earlier draft' } } }
    const sameApiMessage = {
      type: 'assistant',
      uuid: 'assistant-distinct',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pwd' } }] },
    }
    const replayStreamStart = { type: 'stream_event', uuid: 'replay-stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } }
    const replayStreamBlock = { type: 'stream_event', uuid: 'replay-stream-block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'replayed draft' } } }
    const replayed = { type: 'assistant', uuid: 'assistant-replayed', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } }
    const current: TurnSummary[] = [
      { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), earlierStreamStart, earlierStreamBlock, sameApiMessage, replayStreamStart, replayStreamBlock, replayed] },
    ]
    const transcript: TurnSummary[] = [{ primaryUserUuid: 'user-1', messages: [userMessage('user-1'), replayed] }]
    const overlays = new Map([earlierStreamStart, earlierStreamBlock, sameApiMessage, replayStreamStart, replayStreamBlock, replayed].map((message) => [messageIdentity(message)!, 'LIVE' as const]))

    const materialized = materializeTimelineTurns(current, transcript, overlays)

    expect(materialized.turns[0]?.messages).toEqual([userMessage('user-1'), replayed, earlierStreamStart, earlierStreamBlock, sameApiMessage])
    expect(projectTimelineTurn(materialized.turns[0]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant.text', sourceEventIds: ['assistant-replayed'] }),
        expect.objectContaining({ kind: 'assistant.tool_use', sourceEventIds: ['assistant-distinct'], toolUseId: 'call-1' }),
      ]),
    )
  })

  it('does not replay a live tool draft already represented by a transcript assistant', () => {
    const streamStart = { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } }
    const firstStart = { type: 'stream_event', uuid: 'first-start', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'CronList', input: {} } } }
    const secondStart = { type: 'stream_event', uuid: 'second-start', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'Bash', input: {} } } }
    const firstFinal = { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'CronList', input: {} }] } }
    const secondFinal = { type: 'assistant', uuid: 'assistant-2', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Bash', input: { command: 'pwd' } }] } }
    const current: TurnSummary[] = [{ primaryUserUuid: 'user-1', messages: [userMessage('user-1'), streamStart, firstStart, secondStart, firstFinal] }]
    const transcript: TurnSummary[] = [{ primaryUserUuid: 'user-1', messages: [userMessage('user-1'), secondFinal] }]
    const overlays = new Map([streamStart, firstStart, secondStart, firstFinal].map((message) => [messageIdentity(message)!, 'LIVE' as const]))

    const materialized = materializeTimelineTurns(current, transcript, overlays)
    const tools = projectTimelineTurn(materialized.turns[0]!).filter((block) => block.kind === 'assistant.tool_use')
    expect(tools.map((block) => block.toolUseId)).toEqual(['call-2', 'call-1'])
    expect(tools.filter((block) => block.toolUseId === 'call-2')).toHaveLength(1)
  })

  it('keeps a normal live final and lets it replace its stream draft in projection', () => {
    const streamStart = { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-live' } } }
    const streamBlock = { type: 'stream_event', uuid: 'stream-block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } }
    const liveFinal = { type: 'assistant', uuid: 'assistant-live', message: { id: 'msg-live', role: 'assistant', content: [{ type: 'text', text: 'final' }] } }
    const current: TurnSummary[] = [{ primaryUserUuid: 'user-1', messages: [userMessage('user-1'), streamStart, streamBlock, liveFinal] }]
    const transcript: TurnSummary[] = [userTurn('user-1')]
    const overlays = new Map([streamStart, streamBlock, liveFinal].map((message) => [messageIdentity(message)!, 'LIVE' as const]))

    const materialized = materializeTimelineTurns(current, transcript, overlays)

    expect(materialized.turns[0]?.messages).toEqual([userMessage('user-1'), streamStart, streamBlock, liveFinal])
    expect(projectTimelineTurn(materialized.turns[0]!).filter((block) => block.kind === 'assistant.text')).toEqual([
      expect.objectContaining({ sourceEventIds: ['assistant-live'], data: expect.objectContaining({ text: 'final' }) }),
    ])
  })

  it('replaces streamed tools with incremental assistant snapshots sharing one apiMessageId', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'first-start', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'CronList', input: {} } } },
        { type: 'stream_event', uuid: 'second-start', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'Bash', input: {} } } },
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'CronList', input: {} }] } },
        { type: 'stream_event', uuid: 'first-stop', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', uuid: 'assistant-2', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Bash', input: { command: 'pwd' } }] } },
        { type: 'stream_event', uuid: 'second-stop', event: { type: 'content_block_stop', index: 1 } },
      ],
    }

    const toolBlocks = projectTimelineTurn(turn).filter((block) => block.kind === 'assistant.tool_use')
    expect(toolBlocks.map((block) => block.toolUseId)).toEqual(['call-1', 'call-2'])
    expect(toolBlocks.map((block) => block.sourceEventIds)).toEqual([['assistant-1'], ['assistant-2']])
  })

  it('keeps parallel streamed tools in their original order as snapshots arrive', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'first-start', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'CronList', input: {} } } },
        { type: 'stream_event', uuid: 'second-start', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'Bash', input: {} } } },
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'CronList', input: {} }] } },
      ],
    }

    expect(
      projectTimelineTurn(turn)
        .filter((block) => block.kind === 'assistant.tool_use')
        .map((block) => block.toolUseId),
    ).toEqual(['call-1', 'call-2'])
  })

  it('drops orphan tool input deltas until the final snapshot arrives', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'tool-delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } },
        { type: 'assistant', uuid: 'assistant-final', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pwd' } }] } },
      ],
    }

    const tools = projectTimelineTurn(turn).filter((block) => block.kind === 'assistant.tool_use')
    expect(tools).toEqual([expect.objectContaining({ toolUseId: 'call-1', sourceEventIds: ['assistant-final'] })])
    expect(tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ sourceEventIds: ['tool-delta'] })]))
  })

  it.each([
    ['text', { type: 'text', text: 'draft' }, { type: 'text_delta', text: ' late' }, { type: 'text', text: 'final' }, 'assistant.text'],
    ['thinking', { type: 'thinking', thinking: 'draft' }, { type: 'thinking_delta', thinking: ' late' }, { type: 'thinking', thinking: 'final' }, 'assistant.thinking'],
  ])('keeps finalized %s after late stream mutations and terminal events', (_label, streamContent, lateDelta, finalContent, kind) => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'block-start', event: { type: 'content_block_start', index: 0, content_block: streamContent } },
        { type: 'assistant', uuid: 'assistant-final', message: { id: 'msg-1', role: 'assistant', content: [finalContent] } },
        { type: 'stream_event', uuid: 'late-delta', event: { type: 'content_block_delta', index: 0, delta: lateDelta } },
        { type: 'stream_event', uuid: 'block-stop', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', uuid: 'message-stop', event: { type: 'message_stop' } },
        { type: 'result', uuid: 'terminal' },
      ],
    }

    const blocks = projectTimelineTurn(turn).filter((block) => block.kind === kind)
    expect(blocks).toEqual([expect.objectContaining({ sourceEventIds: ['assistant-final'], data: expect.objectContaining(finalContent) })])
    expect(blocks[0]?.data).not.toMatchObject({ streaming: true })
  })

  it('matches multiple same-kind final blocks to distinct stream drafts', () => {
    const text = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'first-text', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft-a' } } },
        { type: 'stream_event', uuid: 'second-text', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'draft-b' } } },
        {
          type: 'assistant',
          uuid: 'assistant-final',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'final-a' },
              { type: 'text', text: 'final-b' },
            ],
          },
        },
      ],
    }).filter((block) => block.kind === 'assistant.text')

    expect(text.map((block) => textFromData(block.data))).toEqual(['final-a', 'final-b'])
  })

  it('restores canonical content order when an earlier stream block is missing', () => {
    const blocks = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'text-start', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'draft' } } },
        {
          type: 'assistant',
          uuid: 'assistant-final',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'reason' },
              { type: 'text', text: 'answer' },
            ],
          },
        },
      ],
    }).filter((block) => block.kind === 'assistant.thinking' || block.kind === 'assistant.text')

    expect(blocks.map((block) => block.kind)).toEqual(['assistant.thinking', 'assistant.text'])
  })

  it('keeps a finalized thinking snapshot open until the next boundary', () => {
    const thinking = projectTimelineTurn({
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'thinking-start', timestamp: 1000, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'draft' } } },
        { type: 'assistant', uuid: 'thinking-final', timestamp: 2000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'final' }] } },
      ],
    }).filter((block) => block.kind === 'assistant.thinking')

    expect(thinking).toEqual([expect.objectContaining({ sourceEventIds: ['thinking-final'], data: expect.objectContaining({ thinking: 'final', streaming: true }) })])
  })

  it('finalizes an incremental thinking snapshot at its stream index without duplicating it', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1'),
        { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'text-start', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } } },
        { type: 'assistant', uuid: 'text-final', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        { type: 'stream_event', uuid: 'thinking-start', timestamp: 1000, event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'draft' } } },
        { type: 'assistant', uuid: 'thinking-final', timestamp: 2000, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'final' }] } },
        { type: 'result', uuid: 'terminal', timestamp: 3000 },
      ],
    }

    const thinking = projectTimelineTurn(turn).filter((block) => block.kind === 'assistant.thinking')
    expect(thinking).toEqual([expect.objectContaining({ sourceEventIds: ['thinking-final'], data: expect.objectContaining({ thinking: 'final' }) })])
    expect(thinking[0]?.data).not.toMatchObject({ streaming: true })
  })

  it('lets transcript replace an optimistic user while retaining an unmatched live response away from the watermark', () => {
    const transcriptUser = userMessage('live', 'persisted')
    const liveResponse = { type: 'assistant', uuid: 'live-response', message: { id: 'msg-live', role: 'assistant', content: [{ type: 'text', text: 'streaming' }] } }
    const current: TurnSummary[] = [{ primaryUserUuid: 'live', primaryUserTimestampMs: 2, messages: [userMessage('live', 'optimistic'), liveResponse] }]
    const snapshot: TurnSummary[] = [userTurn('before'), { primaryUserUuid: 'live', primaryUserTimestampMs: 2, messages: [transcriptUser] }, userTurn('watermark')]
    const materialized = materializeTimelineTurns(
      current,
      snapshot,
      new Map([
        ['uuid:live', 'OPTIMISTIC'],
        ['uuid:live-response', 'LIVE'],
      ]),
    )

    expect(materialized.turns[1]?.messages).toEqual([transcriptUser, liveResponse])
    expect(materialized.transcriptIndex.messageIds).toEqual(new Set(['uuid:before', 'uuid:live', 'uuid:watermark']))
  })

  it('removes optimistic ghosts but preserves the same message after LIVE upgrade', () => {
    const pending = userTurn('pending')
    const optimistic = new Map([['uuid:pending', 'OPTIMISTIC' as const]])
    clearOptimisticOverlaySources(optimistic)
    expect(materializeTimelineTurns([pending], [], optimistic).turns).toEqual([])

    const live = new Map([['uuid:pending', 'LIVE' as const]])
    clearOptimisticOverlaySources(live)
    expect(materializeTimelineTurns([pending], [], live).turns).toEqual([{ ...pending, messages: [pending.messages[0]] }])
  })

  it('reroutes late live results to a tool owner introduced by the transcript baseline', () => {
    const toolUse = { type: 'assistant', uuid: 'tool-owner', message: { id: 'msg-tool', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }] } }
    const lateResult = { type: 'user', uuid: 'late-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const current: TurnSummary[] = [{ ...userTurn('active'), primaryUserTimestampMs: 2, messages: [userMessage('active'), lateResult] }]
    const snapshot: TurnSummary[] = [{ primaryUserUuid: 'owner', primaryUserTimestampMs: 1, messages: [userMessage('owner'), toolUse] }, userTurn('active')]

    const result = materializeTimelineTurns(current, snapshot, new Map([['uuid:late-result', 'LIVE']]))
    expect(result.turns[0]?.messages).toEqual([userMessage('owner'), toolUse, lateResult])
    expect(result.turns[1]?.messages).toEqual([userMessage('active')])
  })

  it('reconciles the replaced tail while preserving loaded history and newer live turns', () => {
    const current = [
      { ...userTurn('a'), primaryUserTimestampMs: 1 },
      { ...userTurn('b'), primaryUserTimestampMs: 2 },
      { ...userTurn('optimistic'), primaryUserTimestampMs: 4 },
    ]
    const snapshot = [
      { ...userTurn('b'), primaryUserTimestampMs: 2, durationMs: 10 },
      { ...userTurn('c'), primaryUserTimestampMs: 3 },
    ]
    expect(replaceTimelineTail(current, 'b', snapshot)?.map((turn) => turn.primaryUserUuid)).toEqual(['a', 'b', 'c', 'optimistic'])
    expect(replaceTimelineTail(current, 'b', snapshot)?.[1]).toMatchObject({ durationMs: 10 })
    expect(replaceTimelineTail([userTurn('a')], 'missing', [userTurn('b')])).toBeNull()
  })

  it('O17: ignores an out-of-order load-older response instead of breaking continuity', () => {
    const current = [
      { ...userTurn('c'), primaryUserTimestampMs: 3 },
      { ...userTurn('d'), primaryUserTimestampMs: 4 },
    ]
    const newerOlderPage = [
      { ...userTurn('x'), primaryUserTimestampMs: 0 },
      { ...userTurn('a'), primaryUserTimestampMs: 1 },
    ]
    const staleOlderPage = [
      { ...userTurn('a'), primaryUserTimestampMs: 1 },
      { ...userTurn('b'), primaryUserTimestampMs: 2 },
      { ...userTurn('c'), primaryUserTimestampMs: 3 },
    ]

    const afterNewer = prependOlderTimelineTurns(current, newerOlderPage)
    const afterStale = prependOlderTimelineTurns(afterNewer, staleOlderPage)

    expect(afterStale.map((turn) => turn.primaryUserUuid)).toEqual(['x', 'a', 'c', 'd'])
  })

  it('O19: lets the latest reset signal win while preserving local live/optimistic turns for the next materialization', () => {
    const turns = [userTurn('a'), userTurn('b'), userTurn('c')]
    const local = { ...userTurn('optimistic'), primaryUserTimestampMs: 4 }
    const first = { source: 'change' as const, epoch: 'e', version: 'v1', reset: false, invalidateFromTurnId: 'c' }
    const earlier = { ...first, version: 'v2', invalidateFromTurnId: 'b' }
    const reset = { ...earlier, version: 'v3', reset: true, invalidateFromTurnId: null }

    expect(coalesceTranscriptSignal(first, earlier, turns)).toEqual(earlier)
    expect(coalesceTranscriptSignal(earlier, reset, turns)).toMatchObject({ version: 'v3', reset: true, invalidateFromTurnId: null })
    expect(materializeTimelineTurns([local], [userTurn('a'), userTurn('b'), userTurn('c')], new Map([['uuid:optimistic', 'LIVE']])).turns.map((turn) => turn.primaryUserUuid)).toEqual([
      'a',
      'b',
      'c',
      'optimistic',
    ])
  })

  it('O35: keeps a new-session skeleton until visible response content takes over', () => {
    const primaryOnly = userTurn('new-session')
    const visible = userTurn('new-session', [{ id: 'assistant', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'hello', streaming: true } }])
    const submitted = turnPhase({ turn: primaryOnly, overlayActive: true, pendingPhase: 'submitted' })
    const rendering = turnPhase({ turn: visible, overlayActive: true })

    expect(shouldShowResponseSkeleton({ phase: submitted, hasVisibleResponse: false })).toBe(true)
    expect(shouldShowResponseSkeleton({ phase: rendering, hasVisibleResponse: true })).toBe(false)
    expect(shouldHoldResponseSkeleton({ awaitingTurnId: 'new-session', turnId: 'new-session', hasVisibleResponse: false, terminal: false })).toBe(true)
    expect(shouldHoldResponseSkeleton({ awaitingTurnId: 'new-session', turnId: 'new-session', hasVisibleResponse: true, terminal: false })).toBe(false)
    expect(shouldHoldResponseSkeleton({ awaitingTurnId: 'new-session', turnId: 'new-session', hasVisibleResponse: false, terminal: true })).toBe(false)
    expect(groupAssistantResponseFrames(groupTimelineBlocks(projectTimelineTurn(visible)))).toHaveLength(1)
  })

  it('coalesces incremental changes at the earliest local turn and lets reset win', () => {
    const turns = [userTurn('a'), userTurn('b'), userTurn('c')]
    const first = { source: 'change' as const, epoch: 'e', version: 'v1', reset: false, invalidateFromTurnId: 'c' }
    const earlier = { ...first, version: 'v2', invalidateFromTurnId: 'b' }
    expect(coalesceTranscriptSignal(first, earlier, turns)).toEqual(earlier)
    expect(coalesceTranscriptSignal(earlier, { ...earlier, version: 'v3', reset: true, invalidateFromTurnId: null }, turns)).toMatchObject({ version: 'v3', reset: true, invalidateFromTurnId: null })
    expect(coalesceTranscriptSignal(first, { ...earlier, invalidateFromTurnId: 'missing' }, turns)).toMatchObject({ reset: true, invalidateFromTurnId: null })
  })
})
