import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from './database.js'
import { TurnMetaTranscriptStore, type ChangedTranscriptSession } from './turn-meta-transcript.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-turn-meta-'))
  roots.push(root)
  const config = join(root, '.claude')
  const projectDir = join(config, 'projects', 'encoded-project')
  await mkdir(projectDir, { recursive: true })
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  return { root, config, projectDir, db, store: new TurnMetaTranscriptStore(db, { claudeConfigDir: config }) }
}

function changed(sessionId: string, projectPath = '/repo'): ChangedTranscriptSession {
  return {
    projectId: 'project',
    projectPath,
    sessionInfo: { sessionId, cwd: projectPath, lastModified: 0, fileSize: 0 } as SDKSessionInfo,
  }
}

function primary(sessionId: string, uuid: string, content = 'hello') {
  return { type: 'user', uuid, sessionId, cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z', origin: 'human', message: { role: 'user', content } }
}

function duration(sessionId: string, uuid: string, parentUuid: string, durationMs = 42) {
  return { type: 'system', subtype: 'turn_duration', uuid, parentUuid, sessionId, timestamp: '2026-01-01T00:00:01.000Z', durationMs, messageCount: 2, cwd: '/repo' }
}

function child(sessionId: string, uuid: string, parentUuid: string, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', uuid, parentUuid, sessionId, timestamp: '2026-01-01T00:00:00.500Z', message: { role: 'assistant', content: [] }, ...extra }
}

function away(sessionId: string, uuid: string, parentUuid: string, content = '※ recap: done') {
  return { type: 'system', subtype: 'away_summary', uuid, parentUuid, sessionId, timestamp: '2026-01-01T00:00:02.000Z', content }
}

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

function durationMsOnly(metadata: ReadonlyMap<string, { durationMs?: number }>): Map<string, number> {
  return new Map([...metadata].flatMap(([key, value]) => value.durationMs === undefined ? [] : [[key, value.durationMs]]))
}

describe('TurnMetaTranscriptStore', () => {
  it('prefers the transcript in the exact encoded project directory', async () => {
    const { config, store } = await setup()
    const exactDir = join(config, 'projects', '-repo')
    const duplicateDir = join(config, 'projects', 'duplicate-project')
    await mkdir(exactDir, { recursive: true })
    await mkdir(duplicateDir, { recursive: true })
    await writeFile(join(exactDir, 'session.jsonl'), jsonl(primary('session', 'exact'), duration('session', 'exact-duration', 'exact', 42)))
    await writeFile(join(duplicateDir, 'session.jsonl'), jsonl(primary('session', 'duplicate'), duration('session', 'duplicate-duration', 'duplicate', 99)))

    await store.syncSessions([changed('session')])

    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['exact', 42]]))
  })

  it('accepts the exact project transcript when its cwd moved to a worktree', async () => {
    const { config, store } = await setup()
    const exactDir = join(config, 'projects', '-repo')
    await mkdir(exactDir, { recursive: true })
    await writeFile(join(exactDir, 'session.jsonl'), jsonl(
      { ...primary('session', 'user'), cwd: '/repo-worktree' },
      duration('session', 'duration', 'user', 42),
    ))

    await store.syncSessions([changed('session')])

    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
  })

  it('inserts a primary immediately and completes it from appended bytes', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user')))

    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map())
    const first = db.prepare('SELECT primary_user_uuid, duration_uuid, scan_byte_offset FROM turn_meta_transcript').get() as Record<string, unknown>
    expect(first).toMatchObject({ primary_user_uuid: 'user', duration_uuid: null, scan_byte_offset: Buffer.byteLength(jsonl(primary('session', 'user'))) })

    await appendFile(path, jsonl(duration('session', 'duration', 'user')))
    await store.syncSessions([changed('session')])

    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
    expect((db.prepare('SELECT duration_byte_offset FROM turn_meta_transcript').get() as { duration_byte_offset: number }).duration_byte_offset).toBe(Buffer.byteLength(jsonl(primary('session', 'user'))))
  })

  it('stores per-turn permission, model, and effort observed while scanning', async () => {
    const { projectDir, store, db } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      { ...primary('session', 'user'), permissionMode: 'default' },
      { type: 'permission-mode', sessionId: 'session', permissionMode: 'bypassPermissions' },
      child('session', 'assistant', 'user', { effort: 'xhigh', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
      duration('session', 'duration', 'assistant'),
    ))

    await store.syncSessions([changed('session')])

    expect(db.prepare('SELECT permission_mode, model, effort FROM turn_meta_transcript').get()).toEqual({
      permission_mode: 'bypassPermissions',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })
  })

  it('stores away summaries on their owner turn', async () => {
    const { projectDir, store, db } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      primary('session', 'user'),
      child('session', 'assistant', 'user'),
      away('session', 'away-summary', 'assistant'),
      duration('session', 'duration', 'assistant'),
    ))

    await store.syncSessions([changed('session')])

    expect(db.prepare('SELECT away_summary FROM turn_meta_transcript').get()).toEqual({ away_summary: '※ recap: done' })
    expect(store.loadTimelineMetadata('project', 'session').turnMetadata.get('user')).toMatchObject({ awaySummary: '※ recap: done' })
    expect({ sessionMeta: store.loadTimelineMetadata('project', 'session').sessionMeta }).toEqual({ sessionMeta: { permissionMode: null, model: null, effort: null } })
  })

  it('resolves away summaries whose parent is a turn duration in the same scan', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      primary('session', 'user'),
      child('session', 'assistant', 'user'),
      duration('session', 'duration', 'assistant'),
      away('session', 'away-summary', 'duration'),
    ))

    await store.syncSessions([changed('session')])

    expect(store.loadTimelineMetadata('project', 'session').turnMetadata.get('user')).toMatchObject({ durationMs: 42, awaySummary: '※ recap: done' })
  })

  it('rebuilds duration ownership for away summaries appended after restart', async () => {
    const { projectDir, store, db, config } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user'), child('session', 'assistant', 'user'), duration('session', 'duration', 'assistant')))
    await store.syncSessions([changed('session')])
    await appendFile(path, jsonl(away('session', 'away-summary', 'duration')))

    const restarted = new TurnMetaTranscriptStore(db, { claudeConfigDir: config })
    await restarted.syncSessions([changed('session')])

    expect(restarted.loadTimelineMetadata('project', 'session').turnMetadata.get('user')).toMatchObject({ durationMs: 42, awaySummary: '※ recap: done' })
  })

  it('returns no away summary when the latest turn has none', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      primary('session', 'first'),
      child('session', 'first-assistant', 'first'),
      { type: 'system', subtype: 'away_summary', uuid: 'away-summary', parentUuid: 'first-assistant', sessionId: 'session', timestamp: '2026-01-01T00:00:00.800Z', content: '※ recap: old' },
      duration('session', 'first-duration', 'first-assistant'),
      primary('session', 'second'),
      child('session', 'second-assistant', 'second', { effort: 'xhigh', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
      duration('session', 'second-duration', 'second-assistant'),
    ))

    await store.syncSessions([changed('session')])

    expect(store.loadTimelineMetadata('project', 'session').turnMetadata.get('first')).toMatchObject({ awaySummary: '※ recap: old' })
    expect(store.loadTimelineMetadata('project', 'session').turnMetadata.get('second')).toMatchObject({ awaySummary: null })
    expect({ sessionMeta: store.loadTimelineMetadata('project', 'session').sessionMeta }).toEqual({ sessionMeta: { permissionMode: null, model: 'claude-sonnet-5', effort: 'xhigh' } })
  })

  it('loads recent non-null session metadata across turns', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      { ...primary('session', 'first'), permissionMode: 'bypassPermissions' },
      child('session', 'first-assistant', 'first', { effort: 'medium', message: { role: 'assistant', model: 'claude-opus-5', content: [] } }),
      duration('session', 'first-duration', 'first-assistant'),
      primary('session', 'second'),
      child('session', 'second-assistant', 'second', { effort: 'xhigh', message: { role: 'assistant', content: [] } }),
      { type: 'system', subtype: 'away_summary', uuid: 'away-summary', parentUuid: 'second-assistant', sessionId: 'session', timestamp: '2026-01-01T00:00:02.800Z', content: '※ recap: latest' },
      duration('session', 'second-duration', 'second-assistant'),
    ))

    await store.syncSessions([changed('session')])

    expect(store.loadTimelineMetadata('project', 'session').turnMetadata.get('second')).toMatchObject({ awaySummary: '※ recap: latest' })
    expect({ sessionMeta: store.loadTimelineMetadata('project', 'session').sessionMeta }).toEqual({ sessionMeta: { permissionMode: 'bypassPermissions', model: 'claude-opus-5', effort: 'xhigh' } })
  })

  it('isolates timeline metadata by project when session ids match', async () => {
    const { store, db } = await setup()
    const insert = db.prepare(`
      INSERT INTO turn_meta_transcript (
        project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms,
        primary_byte_offset, permission_mode, model, effort, file_mtime_ms, file_size,
        scan_byte_offset, scan_line_no, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'shared-session', ?, ?, 0, ?, ?, ?, 0, 0, 0, 0, 0, 0)
    `)
    insert.run('project-a', '/a.jsonl', 'turn-a', 1, 'plan', null, 'high')
    insert.run('project-b', '/b.jsonl', 'turn-b', 2, null, 'claude-opus-5', 'xhigh')

    expect(store.loadTimelineMetadata('project-a', 'shared-session').sessionMeta).toEqual({ permissionMode: 'plan', model: null, effort: 'high' })
    expect(store.loadTimelineMetadata('project-b', 'shared-session').sessionMeta).toEqual({ permissionMode: null, model: 'claude-opus-5', effort: 'xhigh' })
  })

  it('associates delayed and out-of-order durations by parent ownership', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      primary('session', 'a'), child('session', 'a-child', 'a'),
      primary('session', 'b'), child('session', 'b-child', 'b'),
      primary('session', 'c'), child('session', 'c-middle', 'c'), child('session', 'c-child', 'c-middle'),
      duration('session', 'c-duration', 'c-child', 30),
      duration('session', 'a-duration', 'a-child', 10),
      duration('session', 'b-duration', 'b-child', 20),
    ))

    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['a', 10], ['b', 20], ['c', 30]]))
  })

  it('rejects sidechain, cross-session, parentless, and duplicate duration ownership', async () => {
    const { projectDir, store, db } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(
      primary('session', 'user'),
      child('session', 'side', 'user', { isSidechain: true }),
      child('other', 'cross', 'user'),
      duration('session', 'side-duration', 'side', 1),
      duration('session', 'cross-duration', 'cross', 2),
      { ...duration('session', 'parentless', 'user', 3), parentUuid: undefined },
      duration('session', 'accepted', 'user', 4),
      duration('session', 'duplicate', 'user', 5),
    ))

    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 4]]))
    expect(db.prepare('SELECT duration_uuid FROM turn_meta_transcript').get()).toEqual({ duration_uuid: 'accepted' })
  })

  it('self-heals ownership from the file prefix while replaying only the latest incomplete turn', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'a'), child('session', 'a-child', 'a'), primary('session', 'b')))
    await store.syncSessions([changed('session')])
    await appendFile(path, jsonl(duration('session', 'a-duration', 'a-child', 10)))
    await store.syncSessions([changed('session')])

    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['a', 10]]))
  })

  it('removes stale incomplete rows whose transcript was deleted', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user')))
    await store.syncSessions([changed('session')])
    db.prepare('UPDATE turn_meta_transcript SET scan_byte_offset = 0').run()
    await rm(path)

    await store.repairIncompleteTranscripts()

    expect(db.prepare('SELECT COUNT(*) AS count FROM turn_meta_transcript').get()).toEqual({ count: 0 })
  })

  it('moves a legacy duration from the wrong row to its exact owner', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'true'), child('session', 'true-child', 'true'), primary('session', 'wrong')))
    await store.syncSessions([changed('session')])
    db.prepare(`
      UPDATE turn_meta_transcript SET duration_uuid = 'duration', duration_parent_uuid = 'true-child',
        duration_timestamp_ms = 1, duration_ms = 99, duration_message_count = 1,
        duration_line_no = 1, duration_byte_offset = 0, duration_byte_length = 1,
        duration_is_sidechain = 0, duration_is_meta = 0, duration_payload_json = '{}'
      WHERE primary_user_uuid = 'wrong'
    `).run()
    db.prepare("UPDATE turn_meta_transcript SET scan_byte_offset = 0 WHERE primary_user_uuid = 'true'").run()
    await appendFile(path, jsonl(duration('session', 'duration', 'true-child', 77)))

    await store.repairIncompleteTranscripts()
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['true', 77]]))
    expect(db.prepare(`
      SELECT primary_user_uuid, duration_uuid, duration_ms, duration_payload_json
      FROM turn_meta_transcript ORDER BY primary_byte_offset
    `).all()).toEqual([
      { primary_user_uuid: 'true', duration_uuid: 'duration', duration_ms: 77, duration_payload_json: JSON.stringify(duration('session', 'duration', 'true-child', 77)) },
      { primary_user_uuid: 'wrong', duration_uuid: null, duration_ms: null, duration_payload_json: null },
    ])

    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['true', 77]]))
  })

  it('repairs incomplete marker rows using their direct transcript paths', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user')))
    await store.syncSessions([changed('session')])
    await appendFile(path, jsonl(duration('session', 'duration', 'user', 77)))
    db.prepare('UPDATE turn_meta_transcript SET scan_byte_offset = 0').run()

    const repaired = new TurnMetaTranscriptStore(db, { claudeConfigDir: join(projectDir, 'missing') })
    await repaired.repairIncompleteTranscripts()
    expect(durationMsOnly(repaired.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 77]]))
    const snapshot = repaired.listEntries({ limit: 10, offset: 0 })
    await repaired.repairIncompleteTranscripts()
    expect(repaired.listEntries({ limit: 10, offset: 0 })).toEqual(snapshot)
  })

  it('lists complete rows newest first with exact filtering and pagination', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'first.jsonl'), jsonl(primary('first', 'first-user'), duration('first', 'first-duration', 'first-user', 10)))
    await writeFile(join(projectDir, 'second.jsonl'), jsonl(primary('second', 'second-user'), duration('second', 'second-duration', 'second-user', 20)))
    await store.syncSessions([changed('first'), changed('second')])

    const firstPage = store.listEntries({ limit: 1, offset: 0 })
    expect(firstPage).toMatchObject({ sessionIds: ['first', 'second'], limit: 1, offset: 0, hasMore: true })
    expect(firstPage.entries[0]).toMatchObject({ id: 2, sessionId: 'second', durationMs: 20, durationIsSidechain: false, durationIsMeta: false })
    expect(firstPage.entries[0]).toHaveProperty('durationPayloadJson')
    expect(store.listEntries({ sessionId: 'first', limit: 10, offset: 0 })).toMatchObject({
      entries: [expect.objectContaining({ id: 1, sessionId: 'first', primaryUserUuid: 'first-user' })],
      sessionIds: ['first', 'second'],
      hasMore: false,
    })
    expect(store.listEntries({ sessionId: '', limit: 10, offset: 0 }).entries).toEqual([])
  })

  it('uses UTF-8 byte offsets and waits for a complete final line', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const userLine = jsonl(primary('session', 'user', '你好'))
    const durationLine = JSON.stringify(duration('session', 'duration', 'user'))
    await writeFile(path, userLine + durationLine.slice(0, 20))

    await store.syncSessions([changed('session')])
    expect((db.prepare('SELECT scan_byte_offset FROM turn_meta_transcript').get() as { scan_byte_offset: number }).scan_byte_offset).toBe(Buffer.byteLength(userLine))
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map())

    await appendFile(path, `${durationLine.slice(20)}\n`)
    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
  })

  it('ignores malformed and non-primary messages and replays after truncation', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const ignored = [
      { ...primary('session', 'synthetic'), isSynthetic: true },
      { ...primary('session', 'sidechain'), isSidechain: true },
      { ...primary('session', 'tool'), message: { role: 'user', content: [{ type: 'tool_result' }] } },
      { ...primary('session', 'notification'), origin: 'task-notification' },
    ]
    await writeFile(path, `{bad}\n${jsonl(...ignored, primary('session', 'old'), duration('session', 'old-duration', 'old', 10))}`)
    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['old', 10]]))

    await writeFile(path, jsonl(primary('session', 'new'), duration('session', 'new-duration', 'new', 20)))
    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['new', 20]]))
    expect((db.prepare('SELECT COUNT(*) AS count FROM turn_meta_transcript').get() as { count: number }).count).toBe(1)
  })

  it('requires one exact path and scopes reads and versions by project and session', async () => {
    const { config, projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user'), duration('session', 'duration', 'user')))
    const duplicateDir = join(config, 'projects', 'duplicate')
    await mkdir(duplicateDir)
    await writeFile(join(duplicateDir, 'session.jsonl'), jsonl(primary('session', 'other')))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await store.syncSessions([changed('session')])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('session'), expect.objectContaining({ message: expect.stringContaining('found 2') }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM turn_meta_transcript').get()).toEqual({ count: 0 })

    await rm(join(duplicateDir, 'session.jsonl'))
    await store.syncSessions([changed('session')])
    expect(durationMsOnly(store.loadTimelineMetadata('project', 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
    expect(store.loadTimelineMetadata('other-project', 'session')).toEqual({ turnMetadata: new Map(), sessionMeta: { permissionMode: null, model: null, effort: null } })
    expect(store.timelineVersion('project', 'session', 'base')).toMatch(/^base:turn-meta=\d+:\d+$/)
    expect(store.timelineVersion('other-project', 'session', 'base')).toBe('base:turn-meta=0:0')
  })
})
