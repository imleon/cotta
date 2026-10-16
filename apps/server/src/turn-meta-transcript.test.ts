import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectIdFromPath } from './claude-code-api.js'
import { createCottaDatabase } from './database.js'
import { SessionRawTranscriptCacheStore } from './session-raw-transcript-cache.js'
import { TranscriptIndexStore } from './transcript-index-store.js'
import { TurnMetaTranscriptStore } from './turn-meta-transcript.js'

const roots: string[] = []

afterEach(async () => {
  activeRaw = null
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
  const store = new TurnMetaTranscriptStore(db)
  const raw = new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config, turnMetaStore: store })
  activeRaw = raw
  return { root, config, projectDir, db, raw, store }
}

let activeRaw: SessionRawTranscriptCacheStore | null = null

async function sync(sessionId = 'session'): Promise<void> {
  if (!activeRaw) throw new Error('raw cache not initialized')
  await activeRaw.ensureSessionCached(sessionId)
}

function primary(sessionId: string, uuid: string, content = 'hello') {
  return { type: 'user', uuid, sessionId, cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z', origin: 'human', message: { role: 'user', content } }
}

function duration(sessionId: string, uuid: string, parentUuid: string, durationMs = 42, extra: Record<string, unknown> = {}) {
  return { type: 'system', subtype: 'turn_duration', uuid, parentUuid, sessionId, timestamp: '2026-01-01T00:00:01.000Z', durationMs, messageCount: 2, cwd: '/repo', ...extra }
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
  return new Map([...metadata].flatMap(([key, value]) => (value.durationMs === undefined ? [] : [[key, value.durationMs]])))
}

describe('TurnMetaTranscriptStore', () => {
  it('catches up on request and exposes scan coverage', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const content = jsonl(primary('session', 'user'))
    await writeFile(path, content)

    await sync()

    const metadata = store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session')
    expect([...metadata.turnMetadata.keys()]).toEqual(['user'])
    expect(metadata.scanByteOffset).toBe(Buffer.byteLength(content))
    expect(metadata.scannedFileSize).toBe(Buffer.byteLength(content))
  })

  it('scopes session activity to the canonical transcript path', async () => {
    const { projectDir, db } = await setup()
    db.prepare(`
      INSERT INTO turn_meta_transcript (
        project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms,
        primary_byte_offset, file_mtime_ms, file_size, scan_byte_offset, scan_line_no, created_at_ms, updated_at_ms
      ) VALUES (?, '/old.jsonl', 'session', 'old', ?, 0, 0, 0, 0, 0, 0, 0)
    `).run(projectIdFromPath('/repo'), Date.UTC(2030, 0, 1))
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(primary('session', 'current')))

    await sync()

    expect((db.prepare('SELECT last_visible_message_at_ms FROM session_index WHERE session_id = ?').get('session') as { last_visible_message_at_ms: number }).last_visible_message_at_ms).toBe(
      Date.UTC(2026, 0, 1),
    )
  })

  it('keeps session and project activity when an append has no new rows', async () => {
    const { projectDir, db, raw } = await setup()
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const projectId = projectIdFromPath('/repo')
    const index = new TranscriptIndexStore(db)
    await writeFile(join(projectDir, `${sessionId}.jsonl`), jsonl(primary(sessionId, 'user'), duration(sessionId, 'duration', 'user')))
    await raw.ensureSessionCached(sessionId)
    const activityAtMs = Date.UTC(2026, 0, 1, 0, 0, 1)
    expect(index.getSession(sessionId)?.lastVisibleMessageAtMs).toBe(activityAtMs)
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(activityAtMs)

    expect(await raw.ensureSessionCached(sessionId)).toEqual({ changed: false })

    expect(index.getSession(sessionId)?.lastVisibleMessageAtMs).toBe(activityAtMs)
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(activityAtMs)
  })

  it('restores project activity from file mtime after activity becomes null', async () => {
    const { projectDir, db, raw } = await setup()
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const projectId = projectIdFromPath('/repo')
    const index = new TranscriptIndexStore(db)
    const path = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(path, jsonl(primary(sessionId, 'user'), duration(sessionId, 'duration', 'user')))
    await raw.ensureSessionCached(sessionId)
    const fileMtimeMs = index.getSession(sessionId)?.fileMtimeMs
    expect(fileMtimeMs).not.toBeNull()

    index.updateSessionActivity(sessionId, null)

    expect(index.getSession(sessionId)?.lastVisibleMessageAtMs).toBeNull()
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(fileMtimeMs)

    index.updateSessionActivity(sessionId, Date.UTC(2026, 0, 1, 0, 0, 1))
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(Date.UTC(2026, 0, 1, 0, 0, 1))
  })

  it('clears session activity and recomputes project activity after an empty truncate', async () => {
    const { projectDir, db, raw, store } = await setup()
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const projectId = projectIdFromPath('/repo')
    const index = new TranscriptIndexStore(db)
    const path = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(path, jsonl(primary(sessionId, 'user'), duration(sessionId, 'duration', 'user')))
    await raw.ensureSessionCached(sessionId)
    const activityAtMs = Date.UTC(2026, 0, 1, 0, 0, 1)
    expect(index.getSession(sessionId)?.lastVisibleMessageAtMs).toBe(activityAtMs)
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(activityAtMs)

    await writeFile(path, '')
    expect(await raw.ensureSessionCached(sessionId)).toMatchObject({ changed: true, reset: true })

    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines WHERE session_id = ?').get(sessionId)).toEqual({ count: 0 })
    expect(store.loadTimelineMetadata(projectId, sessionId).turnMetadata.size).toBe(0)
    const session = index.getSession(sessionId)
    expect(session?.fileSize).toBe(0)
    expect(session?.lastVisibleMessageAtMs).toBeNull()
    expect(session?.fileMtimeMs).not.toBeNull()
    expect(session?.fileMtimeMs).not.toBe(activityAtMs)
    expect(index.getProject(projectId)?.lastActivityAtMs).toBe(session?.fileMtimeMs)
  })

  it('retries request synchronization after a missing transcript', async () => {
    const { projectDir, store } = await setup()

    await expect(sync()).rejects.toThrow('transcript unavailable')
    await writeFile(join(projectDir, 'session.jsonl'), jsonl(primary('session', 'user')))
    await expect(sync()).resolves.toBeUndefined()
    expect([...store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.keys()]).toEqual(['user'])
  })

  it('does not treat projectId as a transcript shard name', async () => {
    const { config, store } = await setup()
    const projectIdDir = join(config, 'projects', projectIdFromPath('/repo'))
    const duplicateDir = join(config, 'projects', 'duplicate-project')
    await mkdir(projectIdDir, { recursive: true })
    await mkdir(duplicateDir, { recursive: true })
    await writeFile(join(projectIdDir, 'session.jsonl'), jsonl(primary('session', 'exact'), duration('session', 'exact-duration', 'exact', 42)))
    await writeFile(join(duplicateDir, 'session.jsonl'), jsonl(primary('session', 'duplicate'), duration('session', 'duplicate-duration', 'duplicate', 99)))

    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['duplicate', 99]]))
  })

  it('accepts the exact project transcript when its cwd moved to a worktree', async () => {
    const { config, store } = await setup()
    const exactDir = join(config, 'projects', projectIdFromPath('/repo'))
    await mkdir(exactDir, { recursive: true })
    await writeFile(join(exactDir, 'session.jsonl'), jsonl({ ...primary('session', 'user'), cwd: '/repo-worktree' }, duration('session', 'duration', 'user', 42)))

    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
  })

  it('ignores end_turn duration and prefers transcript duration over live result', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(
      path,
      jsonl(
        { ...primary('session', 'sdk-user'), entrypoint: 'sdk-ts' },
        child('session', 'assistant', 'sdk-user', { timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [], stop_reason: 'end_turn' } }),
      ),
    )
    await sync()
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('sdk-user')).not.toHaveProperty('durationMs')
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('sdk-user')).not.toHaveProperty('durationTimestampMs')

    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1, 0, 0, 2))
    store.recordLiveResult(projectIdFromPath('/repo'), 'session', 'sdk-user', { type: 'result', uuid: 'result', subtype: 'success', is_error: false, duration_ms: 123 } as never)
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('sdk-user')).toMatchObject({
      durationMs: 123,
      durationTimestampMs: Date.UTC(2026, 0, 1, 0, 0, 2),
    })

    vi.restoreAllMocks()
    await appendFile(path, jsonl(duration('session', 'duration', 'assistant', 42)))
    await sync()
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('sdk-user')).toMatchObject({
      durationMs: 42,
      durationTimestampMs: Date.UTC(2026, 0, 1, 0, 0, 1),
    })
  })

  it('uses live result duration and SDK timestamp until transcript duration arrives', async () => {
    const { projectDir, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl({ ...primary('session', 'sdk-user'), entrypoint: 'sdk-ts' }, primary('session', 'cli-user')))
    await sync()
    const before = store.timelineVersion(projectIdFromPath('/repo'), 'session', 'base')
    const recordedAtMs = Date.now() + 1_000
    vi.spyOn(Date, 'now').mockReturnValue(recordedAtMs)

    store.recordLiveResult(projectIdFromPath('/repo'), 'session', 'sdk-user', {
      type: 'result',
      uuid: 'sdk-result',
      subtype: 'success',
      is_error: false,
      duration_ms: 123,
      duration_api_ms: 999,
      terminal_reason: 'completed',
    } as never)
    store.recordLiveResult(projectIdFromPath('/repo'), 'session', 'cli-user', {
      type: 'result',
      uuid: 'cli-result',
      subtype: 'success',
      is_error: false,
      duration_ms: 456,
      duration_api_ms: 999,
      terminal_reason: 'completed',
    } as never)

    const liveMetadata = store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata
    expect(liveMetadata.get('sdk-user')).toMatchObject({ durationMs: 123, durationTimestampMs: recordedAtMs })
    expect(liveMetadata.get('cli-user')).toMatchObject({ durationMs: 456 })
    expect(liveMetadata.get('cli-user')).not.toHaveProperty('durationTimestampMs')
    expect(store.timelineVersion(projectIdFromPath('/repo'), 'session', 'base')).not.toBe(before)

    vi.restoreAllMocks()
    await appendFile(join(projectDir, 'session.jsonl'), jsonl(duration('session', 'duration', 'sdk-user', 42)))
    await sync()
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('sdk-user')).toMatchObject({
      durationMs: 42,
      durationTimestampMs: Date.UTC(2026, 0, 1, 0, 0, 1),
    })
  })

  it('inserts a primary immediately and completes it from appended bytes', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user')))

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map())
    const first = db.prepare('SELECT primary_user_uuid, duration_uuid, scan_byte_offset FROM turn_meta_transcript').get() as Record<string, unknown>
    expect(first).toMatchObject({ primary_user_uuid: 'user', duration_uuid: null, scan_byte_offset: Buffer.byteLength(jsonl(primary('session', 'user'))) })

    await appendFile(path, jsonl(duration('session', 'duration', 'user')))
    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
    expect((db.prepare('SELECT duration_byte_offset FROM turn_meta_transcript').get() as { duration_byte_offset: number }).duration_byte_offset).toBe(
      Buffer.byteLength(jsonl(primary('session', 'user'))),
    )
  })

  it('loads each turn source from its primary message', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { ...primary('session', 'sdk-turn'), entrypoint: 'sdk-ts' },
        duration('session', 'sdk-duration', 'sdk-turn', 42, { entrypoint: 'cli' }),
        primary('session', 'unknown-turn'),
        duration('session', 'unknown-duration', 'unknown-turn'),
      ),
    )

    await sync()

    const metadata = store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata
    expect(metadata.get('sdk-turn')).toMatchObject({ entrypoint: 'sdk-ts' })
    expect(metadata.get('unknown-turn')).not.toHaveProperty('entrypoint')
  })

  it('loads pending background agent counts from turn duration metadata', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'waiting'),
        duration('session', 'waiting-duration', 'waiting', 42, { pendingBackgroundAgentCount: 2 }),
        primary('session', 'done'),
        duration('session', 'done-duration', 'done', 42, { pendingBackgroundAgentCount: 0 }),
        primary('session', 'legacy'),
        duration('session', 'legacy-duration', 'legacy'),
      ),
    )

    await sync()

    const metadata = store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata
    expect(metadata.get('waiting')).toMatchObject({ pendingBackgroundAgentCount: 2 })
    expect(metadata.get('done')).toMatchObject({ pendingBackgroundAgentCount: 0 })
    expect(metadata.get('legacy')).not.toHaveProperty('pendingBackgroundAgentCount')
  })

  it('stores permission, model, and effort observed while scanning on the session', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { ...primary('session', 'user'), permissionMode: 'default' },
        { type: 'permission-mode', sessionId: 'session', permissionMode: 'bypassPermissions', timestamp: '2026-01-01T00:00:00.250Z' },
        child('session', 'assistant', 'user', { effort: 'xhigh', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
        duration('session', 'duration', 'assistant'),
      ),
    )

    await sync()

    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnOptions).toEqual({
      permissionMode: 'bypassPermissions',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })
  })

  it('clears session effort when transcript switches to a model without effort support', async () => {
    const { projectDir, config, db } = await setup()
    const settingsStore = {
      getAll: () => ({
        modelCatalog: {
          models: [
            { value: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] },
            { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku' },
          ],
        },
      }),
    }
    const store = new TurnMetaTranscriptStore(db, { settingsStore: settingsStore as never })
    activeRaw = new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config, turnMetaStore: store })
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'first'),
        child('session', 'first-assistant', 'first', { effort: 'high', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
        duration('session', 'first-duration', 'first-assistant'),
        primary('session', 'second'),
        child('session', 'second-assistant', 'second', { message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [] } }),
        duration('session', 'second-duration', 'second-assistant'),
      ),
    )

    await sync()

    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnOptions).toEqual({ permissionMode: null, model: 'claude-haiku-4-5-20251001', effort: null })
  })

  it('stores away summaries on their owner turn', async () => {
    const { projectDir, store, db } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'user'),
        child('session', 'assistant', 'user'),
        away('session', 'away-summary', 'assistant', '※ recap: done (disable recaps in /config)  '),
        duration('session', 'duration', 'assistant'),
      ),
    )

    await sync()

    expect(db.prepare('SELECT away_summary FROM turn_meta_transcript').get()).toEqual({ away_summary: '※ recap: done' })
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('user')).toMatchObject({ awaySummary: '※ recap: done' })
    expect({ turnOptions: store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnOptions }).toEqual({ turnOptions: { permissionMode: null, model: null, effort: null } })
  })

  it('resolves away summaries whose parent is a turn duration in the same scan', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(primary('session', 'user'), child('session', 'assistant', 'user'), duration('session', 'duration', 'assistant'), away('session', 'away-summary', 'duration')),
    )

    await sync()

    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('user')).toMatchObject({ durationMs: 42, awaySummary: '※ recap: done' })
  })

  it('rebuilds duration ownership for away summaries appended after restart', async () => {
    const { projectDir, db, config } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user'), child('session', 'assistant', 'user'), duration('session', 'duration', 'assistant')))
    await sync()
    await appendFile(path, jsonl(away('session', 'away-summary', 'duration')))

    const restarted = new TurnMetaTranscriptStore(db)
    activeRaw = new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config, turnMetaStore: restarted })
    await sync()

    expect(restarted.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('user')).toMatchObject({ durationMs: 42, awaySummary: '※ recap: done' })
  })

  it('returns no away summary when the latest turn has none', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'first'),
        child('session', 'first-assistant', 'first'),
        { type: 'system', subtype: 'away_summary', uuid: 'away-summary', parentUuid: 'first-assistant', sessionId: 'session', timestamp: '2026-01-01T00:00:00.800Z', content: '※ recap: old' },
        duration('session', 'first-duration', 'first-assistant'),
        primary('session', 'second'),
        child('session', 'second-assistant', 'second', { effort: 'xhigh', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
        duration('session', 'second-duration', 'second-assistant'),
      ),
    )

    await sync()

    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('first')).toMatchObject({ awaySummary: '※ recap: old' })
    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('second')).toMatchObject({ awaySummary: null })
    expect({ turnOptions: store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnOptions }).toEqual({ turnOptions: { permissionMode: null, model: 'claude-sonnet-5', effort: 'xhigh' } })
  })

  it('loads recent non-null turn options across turns', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { ...primary('session', 'first'), permissionMode: 'bypassPermissions' },
        child('session', 'first-assistant', 'first', { effort: 'medium', message: { role: 'assistant', model: 'claude-opus-5', content: [] } }),
        duration('session', 'first-duration', 'first-assistant'),
        primary('session', 'second'),
        child('session', 'second-assistant', 'second', { effort: 'xhigh', message: { role: 'assistant', content: [] } }),
        { type: 'system', subtype: 'away_summary', uuid: 'away-summary', parentUuid: 'second-assistant', sessionId: 'session', timestamp: '2026-01-01T00:00:02.800Z', content: '※ recap: latest' },
        duration('session', 'second-duration', 'second-assistant'),
      ),
    )

    await sync()

    expect(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata.get('second')).toMatchObject({ awaySummary: '※ recap: latest' })
    expect({ turnOptions: store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnOptions }).toEqual({
      turnOptions: { permissionMode: 'bypassPermissions', model: 'claude-opus-5', effort: 'xhigh' },
    })
  })

  it('isolates timeline metadata by project when session ids match', async () => {
    const { store, db } = await setup()
    const insert = db.prepare(`
      INSERT INTO turn_meta_transcript (
        project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms,
        primary_byte_offset, file_mtime_ms, file_size, scan_byte_offset, scan_line_no, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'shared-session', ?, ?, 0, 0, 0, 0, 0, 0, 0)
    `)
    insert.run('project-a', '/a.jsonl', 'turn-a', 1)
    insert.run('project-b', '/b.jsonl', 'turn-b', 2)

    expect(store.loadTimelineMetadata('project-a', 'shared-session').turnOptions).toEqual({ permissionMode: null, model: null, effort: null })
    expect(store.loadTimelineMetadata('project-b', 'shared-session').turnOptions).toEqual({ permissionMode: null, model: null, effort: null })
  })

  it('associates delayed and out-of-order durations by parent ownership', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'a'),
        child('session', 'a-child', 'a'),
        primary('session', 'b'),
        child('session', 'b-child', 'b'),
        primary('session', 'c'),
        child('session', 'c-middle', 'c'),
        child('session', 'c-child', 'c-middle'),
        duration('session', 'c-duration', 'c-child', 30),
        duration('session', 'a-duration', 'a-child', 10),
        duration('session', 'b-duration', 'b-child', 20),
      ),
    )

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(
      new Map([
        ['a', 10],
        ['b', 20],
        ['c', 30],
      ]),
    )
  })

  it('sums multiple duration records for one turn', async () => {
    const { projectDir, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(primary('session', 'user'), child('session', 'assistant', 'user'), duration('session', 'duration-1', 'assistant', 10), duration('session', 'duration-2', 'assistant', 15)),
    )

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 25]]))
  })

  it('rebuilds replayed duration records without accumulating them again', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'a'), child('session', 'a-child', 'a'), primary('session', 'b')))
    await sync()
    await appendFile(path, jsonl(duration('session', 'a-duration', 'a-child', 10)))
    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['a', 10]]))

    await appendFile(path, jsonl(duration('session', 'b-duration', 'b', 20)))
    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(
      new Map([
        ['a', 10],
        ['b', 20],
      ]),
    )
  })

  it('keeps sidechain ownership but excludes its durations', async () => {
    const { projectDir, store, db } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        primary('session', 'user'),
        child('session', 'side', 'user', { isSidechain: true }),
        child('session', 'cross', 'user', { isSidechain: true }),
        duration('session', 'side-duration', 'side', 1),
        duration('session', 'cross-duration', 'cross', 2),
        { ...duration('session', 'parentless', 'user', 3), parentUuid: undefined },
        duration('session', 'accepted', 'user', 4),
        duration('session', 'duplicate', 'user', 5),
      ),
    )

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 9]]))
    expect(db.prepare('SELECT duration_uuid FROM turn_meta_transcript').get()).toEqual({ duration_uuid: 'duplicate' })
  })

  it('self-heals ownership from the file prefix while replaying only the latest incomplete turn', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'a'), child('session', 'a-child', 'a'), primary('session', 'b')))
    await sync()
    await appendFile(path, jsonl(duration('session', 'a-duration', 'a-child', 10)))
    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['a', 10]]))
  })

  it('rebuilds prefix ownership from cached raw rows', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'a'), child('session', 'a-child', 'a'), primary('session', 'b')))
    await sync()
    await appendFile(path, jsonl(duration('session', 'a-duration', 'a-child', 10)))

    await sync()

    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['a', 10]]))
  })

  it('moves a legacy duration from the wrong row to its exact owner', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'true'), child('session', 'true-child', 'true'), primary('session', 'wrong')))
    await sync()
    db.prepare(`
      UPDATE turn_meta_transcript SET duration_uuid = 'duration', duration_parent_uuid = 'true-child',
        duration_timestamp_ms = 1, duration_ms = 99, duration_message_count = 1,
        duration_line_no = 1, duration_byte_offset = 0, duration_byte_length = 1,
        duration_is_sidechain = 0, duration_is_meta = 0, duration_payload_json = '{}'
      WHERE primary_user_uuid = 'wrong'
    `).run()
    db.prepare("UPDATE turn_meta_transcript SET scan_byte_offset = 0 WHERE primary_user_uuid = 'true'").run()
    await appendFile(path, jsonl(duration('session', 'duration', 'true-child', 77)))

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['true', 77]]))
    expect(
      db
        .prepare(`
      SELECT primary_user_uuid, duration_uuid, duration_ms, duration_payload_json
      FROM turn_meta_transcript ORDER BY primary_byte_offset
    `)
        .all(),
    ).toEqual([
      { primary_user_uuid: 'true', duration_uuid: 'duration', duration_ms: 77, duration_payload_json: JSON.stringify(duration('session', 'duration', 'true-child', 77)) },
      { primary_user_uuid: 'wrong', duration_uuid: null, duration_ms: null, duration_payload_json: null },
    ])

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['true', 77]]))
  })

  it('uses UTF-8 byte offsets and waits for a complete final line', async () => {
    const { projectDir, store, db } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const userLine = jsonl(primary('session', 'user', '你好'))
    const durationLine = JSON.stringify(duration('session', 'duration', 'user'))
    await writeFile(path, userLine + durationLine.slice(0, 20))

    await sync()
    expect((db.prepare('SELECT scan_byte_offset FROM turn_meta_transcript').get() as { scan_byte_offset: number }).scan_byte_offset).toBe(Buffer.byteLength(userLine))
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map())

    await appendFile(path, `${durationLine.slice(20)}\n`)
    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
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
    await writeFile(path, jsonl(...ignored, primary('session', 'old'), duration('session', 'old-duration', 'old', 10)))
    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['old', 10]]))

    await writeFile(path, jsonl(primary('session', 'new'), duration('session', 'new-duration', 'new', 20)))
    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['new', 20]]))
    expect((db.prepare('SELECT COUNT(*) AS count FROM turn_meta_transcript').get() as { count: number }).count).toBe(1)
  })

  it('scopes reads and versions by project and session', async () => {
    const { projectDir, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, jsonl(primary('session', 'user'), duration('session', 'duration', 'user')))

    await sync()
    expect(durationMsOnly(store.loadTimelineMetadata(projectIdFromPath('/repo'), 'session').turnMetadata)).toEqual(new Map([['user', 42]]))
    expect(store.loadTimelineMetadata('other-project', 'session')).toEqual({
      turnMetadata: new Map(),
      turnOptions: { permissionMode: null, model: null, effort: null },
      scanByteOffset: null,
      scannedFileSize: null,
    })
    expect(store.timelineVersion(projectIdFromPath('/repo'), 'session', 'base')).toMatch(/^base:turn-meta=\d+:\d+:turn-options=\d+:[^:]*:[^:]*:[^:]*:live-results=0:0$/)
    expect(store.timelineVersion('other-project', 'session', 'base')).toMatch(/^base:turn-meta=0:0:turn-options=\d+:[^:]*:[^:]*:[^:]*:live-results=0:0$/)
  })
})
