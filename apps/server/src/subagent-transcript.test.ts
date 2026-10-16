import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectSubagentTranscript } from './subagent-transcript.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

function user(uuid: string, content: unknown, parentUuid?: string, timestamp = '2026-01-01T00:00:00.000Z'): Record<string, unknown> {
  return { type: 'user', uuid, parentUuid, isSidechain: true, timestamp, message: { role: 'user', content } }
}

function assistant(uuid: string, content: unknown, parentUuid: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant', uuid, parentUuid, isSidechain: true, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', id: `msg-${uuid}`, content }, ...extra }
}

function uuidOf(message: unknown): unknown {
  return typeof message === 'object' && message !== null && 'uuid' in message ? message.uuid : null
}

describe('projectSubagentTranscript', () => {
  it('splits sidechain transcript by primary user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(
      path,
      jsonl(
        user('user-1', 'first'),
        assistant('assistant-1', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], 'user-1'),
        user('tool-result-1', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }], 'assistant-1'),
        user('user-2', 'second', 'assistant-1'),
        assistant('assistant-2', [{ type: 'text', text: 'done' }], 'user-2'),
      ),
    )

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result?.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'user-2'])
    expect(result?.turns[0]?.messages.map((message) => uuidOf(message))).toEqual(['user-1', 'assistant-1', 'tool-result-1'])
    expect(result?.turns[1]?.messages.map((message) => uuidOf(message))).toEqual(['user-2', 'assistant-2'])
  })

  it('deduplicates replayed primary user records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(path, jsonl(user('user-1', 'hello'), user('user-1', 'hello'), assistant('assistant-1', [{ type: 'text', text: 'done' }], 'user-1')))

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result?.turns).toHaveLength(1)
    expect(result?.turns[0]?.primaryUserUuid).toBe('user-1')
    expect(result?.turns[0]?.messages.map((message) => uuidOf(message))).toEqual(['user-1', 'user-1', 'assistant-1'])
  })

  it('projects cwd and entrypoint metadata without duration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(path, jsonl({ ...user('user-1', 'hello'), cwd: '/repo/start', entrypoint: 'sdk-ts' }, assistant('assistant-1', [{ type: 'text', text: 'done' }], 'user-1', { cwd: '/repo/end' })))

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result?.turns[0]).toMatchObject({ userCwd: '/repo/start', responseCwd: '/repo/end', entrypoint: 'sdk-ts' })
    expect(result?.turns[0]).not.toHaveProperty('durationMs')
    expect(result?.turns[0]).not.toHaveProperty('durationTimestampMs')
  })

  it('omits an invalid primary user timestamp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(path, jsonl(user('user-1', 'hello', undefined, 'invalid')))

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result?.turns[0]?.primaryUserTimestampMs).toBeUndefined()
  })

  it('groups orphan subagent messages into a synthetic display turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(
      path,
      jsonl(
        { ...user('meta-user', 'review this'), isMeta: true },
        assistant('assistant-1', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], 'meta-user'),
        user('tool-result-1', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }], 'assistant-1'),
        assistant('assistant-2', [{ type: 'text', text: 'done' }], 'tool-result-1'),
      ),
    )

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result?.turns).toHaveLength(1)
    expect(result?.turns[0]?.primaryUserUuid).toBe('subagent:agent-1:root')
    expect(result?.turns[0]?.messages.map((message) => uuidOf(message))).toEqual(['meta-user', 'assistant-1', 'tool-result-1', 'assistant-2'])
  })

  it('does not create a synthetic display turn for attachment-only transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-transcript-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    await writeFile(path, jsonl({ type: 'attachment', uuid: 'attachment-1', attachment: { type: 'environment' } }))

    const result = await projectSubagentTranscript('agent-1', path)

    expect(result).toBeNull()
  })
})
