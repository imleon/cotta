// @vitest-environment jsdom
import { pruneShareSnapshot, type TurnSummary } from '@cotta/shared'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnonTurnTimeline } from '../app/anon-turn-page'
import { CollapsedDisclosureContext } from './content'

// Renders the Share page collapsed (every tool/thinking disclosure header only) and returns the visible text.
function renderCollapsed(turn: TurnSummary): string {
  const { container } = render(
    <CollapsedDisclosureContext.Provider value={true}>
      <AnonTurnTimeline turn={turn} imageEndpoint={{ kind: 'share', token: 'tok' }} />
    </CollapsedDisclosureContext.Provider>,
  )
  return container.textContent ?? ''
}

const CWD = '/home/me/proj'

// One assistant tool_use + a user tool_result message, shaped like a transcript line. cwd is on both owning messages.
function toolTurn(name: string, input: Record<string, unknown>, toolUseResult: unknown): TurnSummary {
  return {
    primaryUserUuid: 't',
    userCwd: CWD,
    responseCwd: CWD,
    messages: [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', cwd: CWD, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }] } },
      { type: 'user', cwd: CWD, parent_tool_use_id: 'tu1', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'RAW RESULT BODY' }] } },
    ],
  } as never
}

const cloned = (turn: TurnSummary): TurnSummary => structuredClone(turn)
const pruned = (turn: TurnSummary): TurnSummary => {
  const next = structuredClone(turn)
  pruneShareSnapshot(next)
  return next
}

describe('share snapshot pruning preserves collapsed headers', () => {
  afterEach(cleanup)

  const cases: Array<{ name: string; turn: TurnSummary; secrets: string[] }> = [
    {
      name: 'Read',
      turn: toolTurn('Read', { file_path: `${CWD}/src/a.ts` }, { type: 'text', file: { filePath: `${CWD}/src/a.ts`, content: 'l1\nl2\nl3\n' } }),
      secrets: ['l1', 'l2'],
    },
    {
      name: 'Edit',
      turn: toolTurn(
        'Edit',
        { file_path: `${CWD}/src/a.ts`, old_string: 'SECRET OLD', new_string: 'SECRET NEW' },
        { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-SECRET OLD', '+SECRET NEW', '+extra'] }] },
      ),
      secrets: ['SECRET OLD', 'SECRET NEW'],
    },
    {
      name: 'Write-create',
      turn: toolTurn('Write', { file_path: `${CWD}/new.ts`, content: 'A\nB\nC\n' }, { type: 'create', content: 'A\nB\nC\n' }),
      secrets: ['A\nB\nC'],
    },
    {
      name: 'Bash',
      turn: toolTurn('Bash', { command: 'echo hi' }, { stdout: 'SECRET STDOUT', stderr: '' }),
      secrets: ['SECRET STDOUT'],
    },
    {
      name: 'Agent',
      turn: toolTurn('Agent', { subagent_type: 'Explore', description: 'look', prompt: 'SECRET PROMPT' }, { isAsync: false, content: 'SECRET AGENT OUT' }),
      secrets: ['SECRET PROMPT', 'SECRET AGENT OUT'],
    },
    {
      name: 'WebFetch',
      turn: toolTurn('WebFetch', { url: 'https://x/y', prompt: 'SECRET QUESTION' }, { content: 'SECRET PAGE' }),
      secrets: ['SECRET QUESTION', 'SECRET PAGE'],
    },
  ]

  for (const { name, turn, secrets } of cases) {
    it(`${name}: header identical, bodies and cwd gone`, () => {
      const before = renderCollapsed(cloned(turn))
      cleanup()
      const after = renderCollapsed(pruned(turn))
      expect(after).toBe(before)
      // cwd prefix is relativized in both (the original already renders relative via message cwd), so no absolute path leaks.
      expect(after).not.toContain(CWD)
      for (const secret of secrets) expect(after).not.toContain(secret)
    })

    it(`${name}: pruned snapshot JSON carries no body text`, () => {
      // pruneShareSnapshot keeps message.cwd (headers relativize paths at render); cwd/path stripping is the server step.
      const json = JSON.stringify(pruned(turn))
      expect(json).not.toContain('RAW RESULT BODY')
      for (const secret of secrets) expect(json).not.toContain(secret)
    })
  }

  it('thinking: header stays, text gone', () => {
    const turn = {
      primaryUserUuid: 't',
      messages: [{ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET THOUGHT' }] } }],
    } as never as TurnSummary
    const json = JSON.stringify(pruned(turn))
    expect(json).not.toContain('SECRET THOUGHT')
  })

  it('MCP tool: input dropped entirely (header shows none)', () => {
    const turn = toolTurn('mcp__srv__do', { query: 'SECRET QUERY', config: { token: 'SECRET TOKEN' } }, { content: 'SECRET MCP OUT' })
    const before = renderCollapsed(cloned(turn))
    cleanup()
    const after = renderCollapsed(pruned(turn))
    expect(after).toBe(before)
    const json = JSON.stringify(pruned(turn))
    for (const secret of ['SECRET QUERY', 'SECRET TOKEN', 'SECRET MCP OUT']) expect(json).not.toContain(secret)
  })

  it('generic tool: keeps only the one summary field, drops other args', () => {
    const turn = toolTurn('SomeNewTool', { pattern: 'shown', secretArg: 'SECRET ARG', payload: { k: 'SECRET PAYLOAD' } }, { ok: true })
    const before = renderCollapsed(cloned(turn))
    cleanup()
    const after = renderCollapsed(pruned(turn))
    expect(after).toBe(before)
    const json = JSON.stringify(pruned(turn))
    expect(json).toContain('shown')
    expect(json).not.toContain('SECRET ARG')
    expect(json).not.toContain('SECRET PAYLOAD')
  })

  it('TaskOutput timeout: header parity, no ERROR flip', () => {
    const turn = toolTurn('TaskOutput', { task_id: 'tk1' }, { retrieval_status: 'timeout', task: { prompt: 'SECRET PROMPT', result: 'SECRET RESULT' } })
    const before = renderCollapsed(cloned(turn))
    cleanup()
    const after = renderCollapsed(pruned(turn))
    expect(after).toBe(before)
    expect(after).not.toContain('ERROR')
    const json = JSON.stringify(pruned(turn))
    expect(json).not.toContain('SECRET PROMPT')
    expect(json).not.toContain('SECRET RESULT')
  })

  it('TaskOutput malformed (no valid task): stays unsupported, no ERROR→normal flip', () => {
    const turn = toolTurn('TaskOutput', { task_id: 'tk1' }, { some: 'record', task: 'not-a-record' })
    const before = renderCollapsed(cloned(turn))
    cleanup()
    const after = renderCollapsed(pruned(turn))
    expect(after).toBe(before)
    const output = (pruned(turn).messages[2] as { toolUseResult: unknown }).toolUseResult
    expect(output).toEqual({})
  })

  it('keeps conversational text for the Markdown export', () => {
    const turn = {
      primaryUserUuid: 't',
      messages: [
        { type: 'user', message: { role: 'user', content: 'my question stays' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'my answer stays' }] } },
      ],
    } as never as TurnSummary
    const json = JSON.stringify(pruned(turn))
    expect(json).toContain('my question stays')
    expect(json).toContain('my answer stays')
  })
})
