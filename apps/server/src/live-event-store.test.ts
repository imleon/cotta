import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteLiveEventStore } from './live-event-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<SqliteLiveEventStore> {
  const root = await mkdtemp(join(tmpdir(), 'cotta-live-events-'))
  roots.push(root)
  return new SqliteLiveEventStore(join(root, 'events.sqlite'))
}

describe('SqliteLiveEventStore', () => {
  it('does not persist content block deltas', async () => {
    const events = await store()
    const delta = { type: 'stream_event', uuid: 'stream-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } }

    events.append('project-1', 'session-1', delta)

    expect(events.listSessionEvents('project-1', 'session-1', 10)).toEqual([])
  })

  it('does not persist thinking token progress', async () => {
    const events = await store()

    events.append('project-1', 'session-1', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 282, estimated_tokens_delta: 1 })

    expect(events.listSessionEvents('project-1', 'session-1', 10)).toEqual([])
  })

  it('returns the newest limited window in ascending order', async () => {
    const events = await store()
    for (let id = 1; id <= 4; id += 1) events.append('project-1', 'session-1', { type: 'status', id })

    expect(events.listSessionEvents('project-1', 'session-1', 2).map((event) => (event.payload as { id: number }).id)).toEqual([3, 4])
  })
})
