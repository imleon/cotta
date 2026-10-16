import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectIdFromPath } from './claude-code-api.js'
import { createCottaDatabase } from './database.js'
import { repairTranscriptOwnership } from './repair-transcript-ownership.js'
import { SessionRawTranscriptCacheStore, TimelineAnchorStaleError, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { SessionSearchStore } from './session-search-store.js'
import { SessionSubagentStore } from './session-subagent-store.js'
import { TurnMetaTranscriptStore } from './turn-meta-transcript.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-raw-transcript-'))
  roots.push(root)
  const config = join(root, '.claude')
  const projectPath = '/repo/cotta'
  const projectId = projectIdFromPath(projectPath)
  const projectDir = join(config, 'projects', '-repo-cotta')
  await mkdir(projectDir, { recursive: true })
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  const turnMetaStore = new TurnMetaTranscriptStore(db)
  const subagentStore = new SessionSubagentStore(db)
  return { root, config, projectDir, projectPath, projectId, db, subagentStore, store: new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config, turnMetaStore, subagentStore }) }
}

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

const perSessionTables = ['turn_meta_live', 'turn_meta_transcript', 'session_raw_transcript_lines', 'session_subagents', 'session_pins', 'session_index']

function seedPerSessionRows(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    'INSERT INTO turn_meta_live (session_id, primary_user_uuid, result_uuid, result_subtype, is_error, duration_ms, result_recorded_at_ms, payload_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, 'user-1', `result-${sessionId}`, 'success', 0, 1, 1, '{}', 1)
  db.prepare(
    'INSERT INTO turn_meta_transcript (project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms, primary_byte_offset, file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('project', `${sessionId}.jsonl`, sessionId, 'user-1', 1, 0, 1, 1, 1, 1, 1)
  db.prepare('INSERT OR IGNORE INTO session_raw_transcript_lines (session_id, byte_offset, byte_length, line_no, raw_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
    sessionId,
    999,
    1,
    999,
    '{}',
    1,
  )
  db.prepare('INSERT INTO session_subagents (session_id, subagent_id, meta_path, meta_file_size, meta_file_mtime_ms, observed_at_ms, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sessionId,
    'agent-1',
    '/tmp/meta.json',
    1,
    1,
    1,
    '{}',
  )
  db.prepare('INSERT INTO session_pins (session_id, pinned_at_ms) VALUES (?, ?)').run(sessionId, 1)
  db.prepare('INSERT OR REPLACE INTO session_index (session_id, is_valid_session_id, updated_at_ms) VALUES (?, ?, ?)').run(sessionId, 1, 1)
}

describe('SessionRawTranscriptCacheStore', () => {
  it('does not use transcript mtime as project activity when syncing session metadata', async () => {
    const { db, projectPath, projectId, store } = await setup()
    store.index.upsertProject(projectPath, 100)

    store.index.upsertSession({
      sessionId: 'session',
      transcriptPath: '/repo/cotta/session.jsonl',
      fileMtimeMs: 999,
      currentCwd: projectPath,
      customTitle: 'Old session',
    })

    expect(store.index.getProject(projectId)?.lastActivityAtMs).toBe(100)
    db.close()
  })

  it('recomputes project activity from listable session ordering only', async () => {
    const { db, projectPath, projectId, store } = await setup()
    const visibleId = '00000000-0000-4000-8000-000000000001'
    const hiddenId = '00000000-0000-4000-8000-000000000002'
    store.index.upsertSession({ sessionId: visibleId, transcriptPath: '/repo/cotta/visible.jsonl', fileMtimeMs: 200, currentCwd: projectPath, customTitle: 'Visible' })
    store.index.upsertSession({ sessionId: hiddenId, transcriptPath: '/repo/cotta/hidden.jsonl', fileMtimeMs: 999, currentCwd: projectPath })

    store.index.recomputeProjectActivity(projectId)

    expect(store.index.getProject(projectId)?.lastActivityAtMs).toBe(200)
    db.close()
  })

  it('discovers roots from current and historical structured tool result fields', async () => {
    const { projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    const first = jsonl(
      { type: 'user', uuid: 'turn-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'one' } },
      {
        type: 'user',
        uuid: 'result-1',
        sessionId: 'session',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] },
        tool_use_result: { agentId: 'root-1' },
      },
      {
        type: 'user',
        uuid: 'result-conflict',
        sessionId: 'session',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] },
        tool_use_result: { agentId: 'root-current' },
        toolUseResult: { agentId: 'root-legacy-ignored' },
      },
      { type: 'user', uuid: 'turn-2', sessionId: 'session', message: { role: 'user', content: 'two' } },
      { type: 'assistant', uuid: 'ignored', sessionId: 'session', message: { role: 'assistant', content: [{ type: 'text', text: 'agentId: text' }] }, toolUseId: 'root-ignored' },
    )
    await writeFile(transcriptPath, first)
    const initial = await store.ensureSessionCached('session')
    expect(initial).toMatchObject({ changed: true, subagentRootsChanged: true })
    expect(db.prepare('SELECT subagent_id, owner_turn_id FROM session_subagents ORDER BY subagent_id').all()).toEqual([
      { subagent_id: 'root-1', owner_turn_id: 'turn-1' },
      { subagent_id: 'root-current', owner_turn_id: 'turn-1' },
    ])

    await writeFile(
      transcriptPath,
      `${first}${jsonl({ type: 'user', uuid: 'result-2', sessionId: 'session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] }, toolUseResult: { agentId: 'root-2' } })}`,
    )
    const appended = await store.ensureSessionCached('session')
    expect(appended).toMatchObject({ changed: true, subagentRootsChanged: true })
    expect(db.prepare('SELECT subagent_id, owner_turn_id FROM session_subagents ORDER BY subagent_id').all()).toEqual([
      { subagent_id: 'root-1', owner_turn_id: 'turn-1' },
      { subagent_id: 'root-2', owner_turn_id: 'turn-2' },
      { subagent_id: 'root-current', owner_turn_id: 'turn-1' },
    ])

    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'turn-3', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'three' } }))
    await store.ensureSessionCached('session')
    expect(db.prepare('SELECT * FROM session_subagents').all()).toEqual([])
    db.close()
  })

  it('skips a malformed transcript line and keeps ingesting later valid lines', async () => {
    const { projectDir, db, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const good1 = JSON.stringify({ type: 'user', uuid: 'turn-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'one' } })
    const good2 = JSON.stringify({ type: 'user', uuid: 'turn-2', sessionId: 'session', message: { role: 'user', content: 'two' } })
    await writeFile(path, `${good1}\n{"type":"user","broken\n${good2}\n`)
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await store.ensureSessionCached('session')
      expect(result).toMatchObject({ changed: true })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(db.prepare('SELECT uuid FROM session_raw_transcript_lines ORDER BY byte_offset').all()).toEqual([{ uuid: 'turn-1' }, { uuid: 'turn-2' }])
    db.close()
  })

  it('locks an image-only first prompt before later user text arrives', async () => {
    const { projectDir, db, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    const imageOnly = jsonl({
      type: 'user',
      uuid: 'user-image',
      sessionId: 'session',
      cwd: '/repo/cotta',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-data' } }] },
    })
    await writeFile(path, imageOnly)
    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({ firstPrompt: 'Image prompt', firstPromptLocked: true })

    await writeFile(path, `${imageOnly}${jsonl({ type: 'user', uuid: 'user-text', sessionId: 'session', message: { role: 'user', content: 'Later text' } })}`)
    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({ firstPrompt: 'Image prompt', firstPromptLocked: true })
    db.close()
  })

  it('does not use non-primary images as the session prompt', async () => {
    const { projectDir, db, store } = await setup()
    const path = join(projectDir, 'session.jsonl')
    await writeFile(
      path,
      `${jsonl({
        type: 'user',
        uuid: 'peer-image',
        sessionId: 'session',
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-data' } }] },
        parent_tool_use_id: null,
        origin: { kind: 'peer' },
      })}${jsonl({ type: 'user', uuid: 'user-text', sessionId: 'session', message: { role: 'user', content: 'Primary text' } })}`,
    )
    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({ firstPrompt: 'Primary text', firstPromptLocked: true })
    db.close()
  })

  it('caches raw transcript lines', async () => {
    const { projectDir, projectId, db, store } = await setup()
    const transcript = jsonl(
      { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      {
        type: 'user',
        uuid: 'result-1',
        sessionId: 'session',
        cwd: '/repo/cotta',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        toolUseResult: { filePath: '/repo/cotta/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
      },
    )
    await writeFile(join(projectDir, 'session.jsonl'), transcript)

    await store.ensureSessionCached('session')

    expect(
      db.prepare('SELECT line_no, uuid, type, parent_uuid, is_sidechain, user_type, entrypoint, cwd, version, git_branch, owner_turn_id FROM session_raw_transcript_lines ORDER BY line_no').all(),
    ).toEqual([
      {
        line_no: 1,
        uuid: 'user-1',
        type: 'user',
        parent_uuid: null,
        is_sidechain: null,
        user_type: null,
        entrypoint: null,
        cwd: '/repo/cotta',
        version: null,
        git_branch: null,
        owner_turn_id: 'user-1',
      },
      {
        line_no: 2,
        uuid: 'result-1',
        type: 'user',
        parent_uuid: null,
        is_sidechain: null,
        user_type: null,
        entrypoint: null,
        cwd: '/repo/cotta',
        version: null,
        git_branch: null,
        owner_turn_id: 'user-1',
      },
    ])
    db.close()
  })

  it('rebuilds persisted search documents when indexing rules change', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        {
          type: 'user',
          uuid: 'interrupted',
          sessionId: 'session',
          cwd: '/repo/cotta',
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        },
        { type: 'user', uuid: 'ordinary', sessionId: 'session', message: { role: 'user', content: 'still searchable' } },
      ),
    )
    await store.ensureSessionCached('session')
    db.prepare(`
      INSERT INTO session_search_documents (
        session_id, field, owner_turn_id, message_uuid, content_block_index, logical_message_id, content, folded_content, updated_at_ms
      ) VALUES (?, 'user', ?, ?, 0, ?, ?, ?, ?)
    `).run('session', 'interrupted', 'interrupted', 'interrupted', '[Request interrupted by user]', '[request interrupted by user]', 1)

    store.prepareSearchIndex()

    expect(db.prepare(`SELECT message_uuid, content FROM session_search_documents WHERE field = 'user' ORDER BY doc_id`).all()).toEqual([{ message_uuid: 'ordinary', content: 'still searchable' }])
    expect(db.prepare(`SELECT session_id FROM session_search_state`).all()).toEqual([{ session_id: 'session' }])
    db.close()
  })

  it('materializes appended ownership from cached history without updating old rows', async () => {
    const { projectDir, db, store } = await setup()
    const first = jsonl(
      { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
      },
      { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second' } },
      {
        type: 'assistant',
        uuid: 'assistant-2',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: {} }] },
      },
    )
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, first)
    await store.ensureSessionCached('session')
    db.exec(`
      CREATE TABLE owner_update_log (id INTEGER PRIMARY KEY);
      CREATE TRIGGER log_old_owner_update
      BEFORE UPDATE OF owner_turn_id ON session_raw_transcript_lines
      WHEN old.session_id = 'session' AND old.byte_offset < ${Buffer.byteLength(first)}
      BEGIN
        INSERT INTO owner_update_log (id) VALUES (NULL);
      END;
    `)

    await writeFile(
      path,
      `${first}${jsonl({
        type: 'user',
        uuid: 'result-2',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] },
      })}`,
    )
    const result = await store.ensureSessionCached('session')

    expect(db.prepare('SELECT COUNT(*) AS count FROM owner_update_log').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT uuid, owner_turn_id FROM session_raw_transcript_lines ORDER BY line_no').all()).toEqual([
      { uuid: 'user-1', owner_turn_id: 'user-1' },
      { uuid: 'assistant-1', owner_turn_id: 'user-1' },
      { uuid: 'user-2', owner_turn_id: 'user-2' },
      { uuid: 'assistant-2', owner_turn_id: 'user-2' },
      { uuid: 'result-2', owner_turn_id: 'user-2' },
    ])
    expect(result).toMatchObject({ changed: true, reset: false, invalidateFromTurnId: 'user-2' })
    db.close()
  })

  it('repairs stale null ownership before appending linked tool results', async () => {
    const { projectDir, db, store } = await setup()
    const first = jsonl(
      { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
      },
    )
    const path = join(projectDir, 'session.jsonl')
    await writeFile(path, first)
    await store.ensureSessionCached('session')
    db.prepare('UPDATE session_raw_transcript_lines SET owner_turn_id = NULL').run()

    expect(repairTranscriptOwnership(db)).toMatchObject({ sessions: 1, rows: 2, changed: 2 })
    await writeFile(
      path,
      `${first}${jsonl({
        type: 'user',
        uuid: 'result-1',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      })}`,
    )
    await store.ensureSessionCached('session')

    expect(db.prepare('SELECT uuid, owner_turn_id FROM session_raw_transcript_lines ORDER BY line_no').all()).toEqual([
      { uuid: 'user-1', owner_turn_id: 'user-1' },
      { uuid: 'assistant-1', owner_turn_id: 'user-1' },
      { uuid: 'result-1', owner_turn_id: 'user-1' },
    ])
    db.close()
  })

  it('keeps a snake_case subagent root when rebuilding search index', async () => {
    const { projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    await writeFile(
      transcriptPath,
      jsonl(
        { type: 'user', uuid: 'command', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'go' } },
        { type: 'assistant', uuid: 'camel-root', sessionId: 'session', message: { role: 'assistant', content: [] }, toolUseResult: { agentId: 'subagent-camel' } },
        { type: 'assistant', uuid: 'snake-root', sessionId: 'session', message: { role: 'assistant', content: [] }, tool_use_result: { agentId: 'subagent-snake' } },
      ),
    )
    await store.ensureSessionCached('session')
    db.prepare('INSERT INTO settings (scope, key, value_json, updated_at_ms) VALUES (?, ?, ?, ?)').run('session-search-store', 'rules-version', '1', 1)

    store.prepareSearchIndex()

    expect(db.prepare('SELECT subagent_id FROM session_subagents WHERE is_root = 1 ORDER BY subagent_id').all()).toEqual([{ subagent_id: 'subagent-camel' }, { subagent_id: 'subagent-snake' }])
    db.close()
  })

  it('repairs command-chain ownership before rebuilding search documents', async () => {
    const { config, projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    await writeFile(
      transcriptPath,
      jsonl(
        {
          type: 'user',
          uuid: 'command',
          sessionId: 'session',
          cwd: '/repo/cotta',
          timestamp: '2026-01-01T00:00:00.000Z',
          userType: 'external',
          message: { role: 'user', content: '<command-name>/model</command-name><command-message>model</command-message>' },
        },
        { type: 'system', uuid: 'stdout', parentUuid: 'command', sessionId: 'session', subtype: 'local_command', content: '<local-command-stdout>Set model to Example</local-command-stdout>' },
        { type: 'assistant', uuid: 'agent-root', sessionId: 'session', message: { role: 'assistant', content: [] }, toolUseResult: { agentId: 'subagent-1' } },
      ),
    )
    await store.ensureSessionCached('session')
    db.prepare('UPDATE session_raw_transcript_lines SET owner_turn_id = uuid').run()
    db.prepare('UPDATE session_subagents SET owner_turn_id = ? WHERE subagent_id = ?').run('stdout', 'subagent-1')
    db.prepare('INSERT INTO settings (scope, key, value_json, updated_at_ms) VALUES (?, ?, ?, ?)').run('session-search-store', 'rules-version', '1', 1)

    store.prepareSearchIndex()

    expect(db.prepare('SELECT uuid, owner_turn_id FROM session_raw_transcript_lines ORDER BY line_no').all()).toEqual([
      { uuid: 'command', owner_turn_id: 'command' },
      { uuid: 'stdout', owner_turn_id: 'command' },
      { uuid: 'agent-root', owner_turn_id: 'command' },
    ])
    expect(db.prepare('SELECT subagent_id, owner_turn_id FROM session_subagents WHERE subagent_id = ?').get('subagent-1')).toEqual({ subagent_id: 'subagent-1', owner_turn_id: 'command' })
    expect(new SessionSearchStore(db).search({ query: 'Example' }).results).toEqual([])
    expect(db.prepare('SELECT * FROM turn_meta_transcript').all()).toEqual([])
    db.close()
  })

  it('orders sessions by visible timestamp and falls back to file mtime', async () => {
    const { projectDir, projectId, db, store } = await setup()
    const olderId = '00000000-0000-4000-8000-000000000001'
    const fallbackId = '00000000-0000-4000-8000-000000000002'
    const newerId = '00000000-0000-4000-8000-000000000003'
    const olderVisible = join(projectDir, `${olderId}.jsonl`)
    const fallbackVisible = join(projectDir, `${fallbackId}.jsonl`)
    const newerVisible = join(projectDir, `${newerId}.jsonl`)
    await writeFile(
      olderVisible,
      jsonl(
        { type: 'user', uuid: 'user-old', sessionId: olderId, cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'old' } },
        { type: 'system', subtype: 'turn_duration', uuid: 'duration-old', parentUuid: 'user-old', sessionId: olderId, timestamp: '2026-01-01T00:00:01.000Z', durationMs: 1000, messageCount: 2 },
      ),
    )
    await writeFile(fallbackVisible, jsonl({ type: 'summary', sessionId: fallbackId, cwd: '/repo/cotta', summary: 'fallback' }))
    await writeFile(
      newerVisible,
      jsonl(
        { type: 'user', uuid: 'user-new', sessionId: newerId, cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:10.000Z', message: { role: 'user', content: 'new' } },
        { type: 'system', subtype: 'turn_duration', uuid: 'duration-new', parentUuid: 'user-new', sessionId: newerId, timestamp: '2026-01-01T00:00:11.000Z', durationMs: 1000, messageCount: 2 },
        { type: 'system', subtype: 'hook_response', uuid: 'hidden-later', sessionId: newerId, timestamp: '2026-01-01T00:10:00.000Z', content: 'hidden' },
      ),
    )
    await utimes(olderVisible, new Date('2026-01-01T00:01:00.000Z'), new Date('2026-01-01T00:01:00.000Z'))
    await utimes(fallbackVisible, new Date('2026-01-01T00:00:06.000Z'), new Date('2026-01-01T00:00:06.000Z'))
    await utimes(newerVisible, new Date('2026-01-01T00:00:30.000Z'), new Date('2026-01-01T00:00:30.000Z'))

    await store.ensureSessionCached(olderId)
    await store.ensureSessionCached(fallbackId)
    await store.ensureSessionCached(newerId)

    expect(db.prepare('SELECT session_id, last_visible_message_at_ms FROM session_index ORDER BY session_id').all()).toEqual([
      { session_id: olderId, last_visible_message_at_ms: Date.parse('2026-01-01T00:00:01.000Z') },
      { session_id: fallbackId, last_visible_message_at_ms: null },
      { session_id: newerId, last_visible_message_at_ms: Date.parse('2026-01-01T00:00:11.000Z') },
    ])
    const page = store.index.listProjectSessionsPage(projectId, { limit: 2 })
    expect(store.index.getProject(projectId)?.lastActivityAtMs).toBe(Date.parse('2026-01-01T00:00:11.000Z'))
    expect(page.items.map((session) => session.sessionId)).toEqual([newerId, fallbackId])
    expect(page.defaultSessionId).toBe(newerId)
    expect(page.nextKey).toEqual({ sort: Date.parse('2026-01-01T00:00:06.000Z'), id: fallbackId })
    db.close()
  })

  it('keeps raw timeline version independent from task snapshots', async () => {
    const { db, store } = await setup()
    store.index.upsertSession({ sessionId: 'session', transcriptPath: '/tmp/session.jsonl', fileSize: 1, fileMtimeMs: 1 })
    store.index.updateTaskSnapshot('session', { version: 'task-v1', tasks: [] })

    expect(store.timelineVersion('session')).toBe(`raw-v1:path=${Buffer.from('/tmp/session.jsonl').toString('base64url')};mtime=1;size=1;lines=0`)
    db.close()
  })

  it('rebuilds session search documents with transcript sync and clears them on delete', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'search me' } },
        { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant result' }] } },
      ),
    )
    store.index.upsertSession({
      sessionId: 'session',
      transcriptPath: join(projectDir, 'session.jsonl'),
      fileSize: 1,
      fileMtimeMs: 1,
      currentCwd: '/repo/cotta',
      customTitle: 'Seed',
      isValidSessionId: true,
    })

    await store.ensureSessionCached('session')
    const searchStore = new SessionSearchStore(db)
    expect(searchStore.search({ query: 'search' }).results).toHaveLength(1)
    expect(searchStore.hasIndexedSession('session')).toBe(true)

    store.deleteCachedSession('session')
    expect(searchStore.search({ query: 'search' }).results).toEqual([])
    expect(searchStore.hasIndexedSession('session')).toBe(false)
    db.close()
  })

  it('converges to a transcript rename after the immediate title update fails', async () => {
    const { projectDir, db, store } = await setup()
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const path = join(projectDir, `${sessionId}.jsonl`)
    const initial = jsonl(
      { type: 'user', uuid: 'user-1', sessionId, cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'custom-title', sessionId, customTitle: 'Before rename' },
    )
    try {
      await writeFile(path, initial)
      await store.ensureSessionCached(sessionId)
      const searchStore = new SessionSearchStore(db)
      expect(searchStore.search({ query: 'Before rename' }).results).toHaveLength(1)

      await writeFile(path, initial + jsonl({ type: 'custom-title', sessionId, customTitle: 'After rename' }))
      db.exec(`CREATE TEMP TRIGGER reject_rename BEFORE UPDATE OF custom_title ON session_index BEGIN SELECT RAISE(ABORT, 'title update failed'); END`)
      expect(() => searchStore.updateTitle(sessionId, 'After rename')).toThrow('title update failed')
      expect(store.index.getSession(sessionId)?.customTitle).toBe('Before rename')
      db.exec('DROP TRIGGER reject_rename')

      await store.ensureSessionCached(sessionId)

      expect(store.index.getSession(sessionId)?.customTitle).toBe('After rename')
      expect(searchStore.search({ query: 'After rename' }).results[0]?.session.title).toBe('After rename')
      expect(searchStore.search({ query: 'Before rename' }).results).toEqual([])
    } finally {
      db.close()
    }
  })

  it('backfills missing search index when transcript content is unchanged', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'backfill me' } }))
    store.index.upsertSession({
      sessionId: 'session',
      transcriptPath: join(projectDir, 'session.jsonl'),
      fileSize: 1,
      fileMtimeMs: 1,
      currentCwd: '/repo/cotta',
      customTitle: 'Seed',
      isValidSessionId: true,
    })
    await store.ensureSessionCached('session')
    const searchStore = new SessionSearchStore(db)
    searchStore.clearSession('session')

    const result = await store.ensureSessionCached('session')
    expect(result).toEqual({ changed: false })
    expect(searchStore.search({ query: 'backfill' }).results).toHaveLength(1)
    db.close()
  })

  it('loads sqlite rows for one primary turn until the next primary user message', async () => {
    const { projectDir, projectId, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
        {
          type: 'user',
          uuid: 'task-1',
          sessionId: 'session',
          origin: { kind: 'task-notification' },
          message: { role: 'user', content: '<task-notification><task-id>1</task-id><tool-use-id>call-1</tool-use-id></task-notification>' },
        },
        {
          type: 'user',
          uuid: 'tool-result-1',
          sessionId: 'session',
          parent_tool_use_id: 'tool-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        },
        { type: 'user', uuid: 'user-2', sessionId: 'session', message: { role: 'user', content: 'second' } },
        { type: 'assistant', uuid: 'assistant-2', sessionId: 'session', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ),
    )

    await store.ensureSessionCached('session')

    expect(store.loadRawLinesForTurn('session', 'user-1')?.map((row) => row.uuid)).toEqual(['user-1', 'assistant-1', 'task-1', 'tool-result-1'])
    expect(store.loadRawLinesForTurn('session', 'user-2')?.map((row) => row.uuid)).toEqual(['user-2', 'assistant-2'])
    expect(store.loadRawLinesForTurn('session', 'assistant-1')).toBeNull()
    expect(store.loadRawLinesByUuid('session', 'assistant-1')[0]?.owner_turn_id).toBe('user-1')
    expect(store.loadRawLinesByUuid('session', 'missing')).toEqual([])
    db.close()
  })

  it('loads the latest transcript variant for a repeated UUID', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } },
        { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: [{ type: 'text', text: 'latest' }] } },
      ),
    )

    await store.ensureSessionCached('session')

    expect(store.loadRawLinesByUuid('session', 'assistant-1').map((line) => JSON.parse(line.raw_json).message.content[0].text)).toEqual(['old', 'latest'])
    db.close()
  })

  it('only parses window rows and linked task notifications for timeline windows', async () => {
    const { projectDir, projectId, db, store } = await setup()
    const outsideRows = Array.from({ length: 20 }, (_, index) => ({
      type: 'assistant',
      uuid: `outside-${index}`,
      sessionId: 'session',
      message: { role: 'assistant', content: [{ type: 'text', text: `outside ${index}` }] },
    }))
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          sessionId: 'session',
          cwd: '/repo/middle',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-selected', name: 'Task', input: {} }] },
        },
        { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second' } },
        ...outsideRows,
        {
          type: 'user',
          uuid: 'task-selected',
          sessionId: 'session',
          origin: { kind: 'task-notification' },
          cwd: '/repo/end',
          message: { role: 'user', content: '<task-notification><task-id>1</task-id><tool-use-id>tool-selected</tool-use-id></task-notification>' },
        },
        {
          type: 'user',
          uuid: 'task-other',
          sessionId: 'session',
          origin: { kind: 'task-notification' },
          message: { role: 'user', content: '<task-notification><task-id>2</task-id><tool-use-id>tool-other</tool-use-id></task-notification>' },
        },
      ),
    )
    await store.ensureSessionCached('session')
    const parse = vi.spyOn(JSON, 'parse')
    const window = store.loadTimelineWindow('session', { limitTurns: 1, cursor: 'user-2', fromTurnId: null, anchorTurnId: null })

    expect(window.primaryTurns).toEqual([
      {
        uuid: 'user-1',
        timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
        userCwd: '/repo/cotta',
        responseCwd: '/repo/end',
      },
    ])
    expect(window.ownedMessages.map(({ ownerTurnId, message }) => [ownerTurnId, message.uuid])).toEqual([
      ['user-1', 'user-1'],
      ['user-1', 'assistant-1'],
      ['user-1', 'task-selected'],
    ])
    expect(parse).toHaveBeenCalledTimes(3)
    parse.mockRestore()
    db.close()
  })

  it('deduplicates replayed primary UUIDs using their first occurrence', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/replay', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first replay' } },
        { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second' } },
      ),
    )
    await store.ensureSessionCached('session')

    expect(store.loadTimelineWindow('session', { limitTurns: 10, cursor: null, fromTurnId: null, anchorTurnId: null }).primaryTurns).toEqual([
      { uuid: 'user-1', timestamp: Date.parse('2026-01-01T00:00:01.000Z') },
      { uuid: 'user-2', timestamp: Date.parse('2026-01-01T00:00:02.000Z'), userCwd: '/repo/cotta' },
    ])
    expect(store.loadTimelineWindow('session', { limitTurns: 1, cursor: 'user-2', fromTurnId: null, anchorTurnId: null }).primaryTurns.map((turn) => turn.uuid)).toEqual(['user-1'])
    db.close()
  })

  it('keeps timestamp-less primary turns in timeline windows without turn metadata', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
        { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second' } },
      ),
    )
    await store.ensureSessionCached('session')

    expect(db.prepare('SELECT primary_user_uuid FROM turn_meta_transcript').all()).toEqual([{ primary_user_uuid: 'user-2' }])
    expect(store.loadTimelineWindow('session', { limitTurns: 1, cursor: 'user-2', fromTurnId: null, anchorTurnId: null }).primaryTurns).toEqual([
      { uuid: 'user-1', timestamp: null, userCwd: '/repo/cotta' },
    ])
    expect(store.loadTimelineWindow('session', { limitTurns: 10, cursor: null, fromTurnId: 'user-1', anchorTurnId: null }).primaryTurns).toEqual([
      { uuid: 'user-1', timestamp: null, userCwd: '/repo/cotta' },
      { uuid: 'user-2', timestamp: Date.parse('2026-01-01T00:00:02.000Z'), userCwd: '/repo/cotta' },
    ])
    db.close()
  })

  it('returns a bounded anchor window that includes the target turn and reports newer turns', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
        { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second' } },
        { type: 'assistant', uuid: 'assistant-2', parentUuid: 'user-2', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
        { type: 'user', uuid: 'user-3', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: 'third' } },
      ),
    )
    await store.ensureSessionCached('session')

    expect(store.loadTimelineWindow('session', { limitTurns: 2, cursor: null, fromTurnId: null, anchorTurnId: 'user-2' })).toMatchObject({
      primaryTurns: [
        { uuid: 'user-1', timestamp: Date.parse('2026-01-01T00:00:01.000Z'), userCwd: '/repo/cotta' },
        { uuid: 'user-2', timestamp: Date.parse('2026-01-01T00:00:02.000Z'), userCwd: '/repo/cotta' },
      ],
      hasMore: false,
      hasNewer: true,
      nextCursor: null,
      anchorTurnId: 'user-2',
      snapshotFromTurnId: null,
    })
    expect(store.loadTimelineWindow('session', { limitTurns: 1, cursor: null, fromTurnId: null, anchorTurnId: 'user-2' })).toMatchObject({
      primaryTurns: [{ uuid: 'user-2', timestamp: Date.parse('2026-01-01T00:00:02.000Z'), userCwd: '/repo/cotta' }],
      hasMore: true,
      hasNewer: true,
      nextCursor: 'user-2',
      anchorTurnId: 'user-2',
    })
    expect(store.adjacentTurnIds('session', 'user-1')).toEqual({ firstTurnId: 'user-1', previousTurnId: null, nextTurnId: 'user-2', latestTurnId: 'user-3' })
    expect(store.adjacentTurnIds('session', 'user-2')).toEqual({ firstTurnId: 'user-1', previousTurnId: 'user-1', nextTurnId: 'user-3', latestTurnId: 'user-3' })
    expect(store.adjacentTurnIds('session', 'user-3')).toEqual({ firstTurnId: 'user-1', previousTurnId: 'user-2', nextTurnId: null, latestTurnId: 'user-3' })
    expect(store.adjacentTurnIds('session', 'missing')).toBeNull()
    db.close()
  })

  it('optionally excludes local-command Turn roots from windows and navigation', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } },
        {
          type: 'system',
          subtype: 'local_command',
          uuid: 'local',
          sessionId: 'session',
          content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>',
        },
        {
          type: 'user',
          uuid: 'tagged-literal',
          sessionId: 'session',
          cwd: '/repo/cotta',
          userType: 'external',
          origin: { kind: 'human' },
          promptSource: 'typed',
          message: { role: 'user', content: '<command-name>/model</command-name><command-message>model</command-message>' },
        },
        { type: 'user', uuid: 'slash', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: [{ type: 'text', text: '/review this' }] } },
        { type: 'assistant', uuid: 'slash-answer', parentUuid: 'slash', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
        { type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'second' } },
      ),
    )
    await store.ensureSessionCached('session')

    expect(store.loadTimelineWindow('session', { limitTurns: 4, cursor: null, fromTurnId: null, anchorTurnId: null }).primaryTurns.map(({ uuid }) => uuid)).toEqual([
      'local',
      'tagged-literal',
      'slash',
      'user-2',
    ])
    expect(store.loadTimelineWindow('session', { limitTurns: 4, cursor: null, fromTurnId: null, anchorTurnId: null, excludeLocalCommandTurns: true }).primaryTurns.map(({ uuid }) => uuid)).toEqual([
      'user-1',
      'tagged-literal',
      'slash',
      'user-2',
    ])
    expect(store.adjacentTurnIds('session', 'slash', { excludeLocalCommandTurns: true })).toEqual({
      firstTurnId: 'user-1',
      previousTurnId: 'tagged-literal',
      nextTurnId: 'user-2',
      latestTurnId: 'user-2',
    })
    expect(store.adjacentTurnIds('session', 'local', { excludeLocalCommandTurns: true })).toBeNull()
    db.close()
  })

  it.each([
    ['O20', { limitTurns: 10, cursor: 'missing', fromTurnId: null, anchorTurnId: null }, 'cursor'],
    ['O21', { limitTurns: 10, cursor: null, fromTurnId: 'missing', anchorTurnId: null }, 'invalidation'],
    ['S09', { limitTurns: 10, cursor: null, fromTurnId: null, anchorTurnId: 'missing' }, 'anchor'],
  ] as const)('%s: rejects a stale timeline anchor without returning a partial window', async (_scenario, options, kind: 'cursor' | 'invalidation' | 'anchor') => {
    const { projectDir, db, store } = await setup()
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } }),
    )
    await store.ensureSessionCached('session')

    let thrown: unknown
    try {
      store.loadTimelineWindow('session', options)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(TimelineAnchorStaleError)
    expect(thrown).toMatchObject({ kind })
    expect(store.loadRawLinesForTurn('session', 'user-1')).toHaveLength(1)
    db.close()
  })

  it('keeps the committed path when an unrelated smaller fork shares the session id', async () => {
    const { config, projectDir, projectId, db, store } = await setup()
    const full = jsonl(
      { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
    )
    await writeFile(join(projectDir, 'session.jsonl'), full)
    await store.ensureSessionCached('session')
    const forkDir = join(config, 'projects', '-repo-cotta-v2')
    await mkdir(forkDir, { recursive: true })
    await writeFile(join(forkDir, 'session.jsonl'), jsonl({ type: 'ai-title', sessionId: 'session', aiTitle: 'fork' }))

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: join(projectDir, 'session.jsonl'),
      fileSize: Buffer.byteLength(full),
    })
    db.close()
  })

  it('keeps sticky indexed path over a larger non-covering duplicate', async () => {
    const { config, projectDir, db, store } = await setup()
    const canonical = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } })
    const canonicalPath = join(projectDir, 'session.jsonl')
    await writeFile(canonicalPath, canonical)
    await store.ensureSessionCached('session')
    const duplicateDir = join(config, 'projects', '-repo-cotta-v2')
    await mkdir(duplicateDir, { recursive: true })
    await writeFile(
      join(duplicateDir, 'session.jsonl'),
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta-v2', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: 'duplicate' } },
      ),
    )

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: canonicalPath,
      fileSize: Buffer.byteLength(canonical),
      currentCwd: '/repo/cotta',
    })
    db.close()
  })

  it('lets sticky indexed path yield to a verified append-only continuation', async () => {
    const { config, projectDir, db, store } = await setup()
    const first = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } })
    const canonicalPath = join(projectDir, 'session.jsonl')
    await writeFile(canonicalPath, first)
    await store.ensureSessionCached('session')
    const continuationDir = join(config, 'projects', '-repo-cotta-v2')
    await mkdir(continuationDir, { recursive: true })
    const continuationPath = join(continuationDir, 'session.jsonl')
    const continuation = `${first}${jsonl({ type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: 'continued' } })}`
    await writeFile(continuationPath, continuation)

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: continuationPath,
      fileSize: Buffer.byteLength(continuation),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 2 })
    db.close()
  })

  it('chooses the append-only superset when duplicate session paths exist', async () => {
    const { config, projectDir, projectId, db, store } = await setup()
    const full = jsonl(
      { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
    )
    await writeFile(join(projectDir, 'session.jsonl'), full)
    const duplicateDir = join(config, 'projects', '-repo-cotta-v2')
    await mkdir(duplicateDir, { recursive: true })
    await writeFile(join(duplicateDir, 'session.jsonl'), full.slice(0, full.indexOf('\n') + 1))
    store.index.upsertSession({ sessionId: 'session', transcriptPath: join(duplicateDir, 'session.jsonl'), fileSize: 1 })

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: join(projectDir, 'session.jsonl'),
      fileSize: Buffer.byteLength(full),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 2 })
    db.close()
  })

  it('prefers an older complete transcript over a newer short duplicate', async () => {
    const { config, projectDir, db, store } = await setup()
    const completePath = join(projectDir, 'session.jsonl')
    const first = { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } }
    const complete = jsonl(first, { type: 'assistant', uuid: 'assistant-1', sessionId: 'session', message: { role: 'assistant', content: 'done' } })
    await writeFile(completePath, complete)
    const shortDir = join(config, 'projects', '-repo-cotta-v2')
    await mkdir(shortDir, { recursive: true })
    const shortPath = join(shortDir, 'session.jsonl')
    await writeFile(shortPath, jsonl(first))
    const older = new Date('2026-01-01T00:00:00.000Z')
    const newer = new Date('2026-01-02T00:00:00.000Z')
    await utimes(completePath, older, older)
    await utimes(shortPath, newer, newer)

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: completePath,
      fileSize: Buffer.byteLength(complete),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 2 })
    db.close()
  })

  it('replaces a truncated sticky path with a complete candidate', async () => {
    const { config, projectDir, db, store } = await setup()
    const oldPath = join(projectDir, 'session.jsonl')
    const old = jsonl({ type: 'user', uuid: 'old-user', sessionId: 'session', cwd: '/repo/old', message: { role: 'user', content: 'old' } })
    await writeFile(oldPath, old)
    await store.ensureSessionCached('session')
    await writeFile(oldPath, '')
    const canonicalDir = join(config, 'projects', '-repo-canonical')
    await mkdir(canonicalDir, { recursive: true })
    const canonicalPath = join(canonicalDir, 'session.jsonl')
    const canonical = jsonl(
      { type: 'user', uuid: 'canonical-user', sessionId: 'session', cwd: '/repo/canonical', message: { role: 'user', content: 'canonical' } },
      { type: 'assistant', uuid: 'canonical-assistant', sessionId: 'session', message: { role: 'assistant', content: 'done' } },
    )
    await writeFile(canonicalPath, canonical)
    const older = new Date('2026-01-01T00:00:00.000Z')
    await utimes(canonicalPath, older, older)

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      currentCwd: '/repo/canonical',
      transcriptPath: canonicalPath,
      fileMtimeMs: older.getTime(),
    })
    db.close()
  })

  it('rebuilds a same-size transcript rewrite when mtime changes', async () => {
    const { projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    const original = jsonl({ type: 'user', uuid: 'user-old', sessionId: 'session', cwd: '/repo/old', message: { role: 'user', content: 'old' } })
    const replacement = jsonl({ type: 'user', uuid: 'user-new', sessionId: 'session', cwd: '/repo/new', message: { role: 'user', content: 'new' } })
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(transcriptPath, original)
    await store.ensureSessionCached('session')
    const newer = new Date(Date.now() + 2_000)
    await writeFile(transcriptPath, replacement)
    await utimes(transcriptPath, newer, newer)

    const result = await store.ensureSessionCached('session')

    expect(result).toMatchObject({ changed: true, reset: true })
    expect(db.prepare('SELECT uuid FROM session_raw_transcript_lines').all()).toEqual([{ uuid: 'user-new' }])
    expect(store.index.getSession('session')).toMatchObject({ transcriptPath, currentCwd: '/repo/new', fileSize: Buffer.byteLength(replacement) })
    expect(store.index.getSession('session')!.fileMtimeMs).toBeGreaterThan(Date.now())
    db.close()
  })

  it('reports previous owner when a later cwd moves the session', async () => {
    const { projectDir, projectId, db, store } = await setup()
    const first = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } })
    await writeFile(join(projectDir, 'session.jsonl'), first)
    await store.ensureSessionCached('session')
    const moved = `${first}${jsonl({ type: 'user', uuid: 'user-2', sessionId: 'session', cwd: '/repo/cotta-worktree', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'moved' } })}`
    await writeFile(join(projectDir, 'session.jsonl'), moved)

    const result = await store.ensureSessionCached('session')

    expect(result).toMatchObject({ changed: true, projectId: projectIdFromPath('/repo/cotta-worktree'), previousProjectId: projectId })
    db.close()
  })

  it('leaves incomplete trailing lines for a later scan', async () => {
    const { projectDir, projectId, db, store } = await setup()
    const complete = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } })
    await writeFile(join(projectDir, 'session.jsonl'), `${complete}{"type":"user"`)

    await store.ensureSessionCached('session')

    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT MAX(byte_offset + byte_length) AS cached_until_byte FROM session_raw_transcript_lines').get()).toEqual({ cached_until_byte: Buffer.byteLength(complete) })
    db.close()
  })

  it('uses the current cwd shard as the project hint over newer duplicates', async () => {
    const { config, projectDir, db, store } = await setup()
    const canonical = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'first' } })
    const duplicateDir = join(config, 'projects', '-repo-other')
    await mkdir(duplicateDir, { recursive: true })
    const duplicatePath = join(duplicateDir, 'session.jsonl')
    await writeFile(join(projectDir, 'session.jsonl'), canonical)
    await writeFile(duplicatePath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/other', message: { role: 'user', content: 'first' } }))
    const newer = new Date('2026-01-02T00:00:00.000Z')
    await utimes(duplicatePath, newer, newer)
    store.index.upsertSession({ sessionId: 'session', transcriptPath: null, currentCwd: '/repo/cotta' })

    await store.ensureSessionCached('session')

    expect(store.index.getSession('session')).toMatchObject({
      transcriptPath: join(projectDir, 'session.jsonl'),
      fileSize: Buffer.byteLength(canonical),
      currentCwd: '/repo/cotta',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })
    db.close()
  })

  it('preserves cached state when transcript discovery fails unexpectedly', async () => {
    const { projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'hi' } }))
    await store.ensureSessionCached('session')
    const failure = new Error('scan failed')
    vi.spyOn(store as unknown as { locateTranscript(sessionId: string): Promise<string> }, 'locateTranscript').mockRejectedValueOnce(failure)

    await expect(store.ensureSessionCached('session')).rejects.toBe(failure)

    expect(store.index.getSession('session')?.transcriptPath).toBe(transcriptPath)
    expect(store.loadRawLinesForTurn('session', 'user-1')).toHaveLength(1)
    db.close()
  })

  it('reports a complete zero-candidate discovery as unavailable and clears only the indexed path', async () => {
    const { projectDir, db, store } = await setup()
    const transcriptPath = join(projectDir, 'session.jsonl')
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'hi' } }))
    await store.ensureSessionCached('session')
    await rm(transcriptPath)

    await expect(store.ensureSessionCached('session')).rejects.toBeInstanceOf(TranscriptUnavailableError)

    expect(store.index.getSession('session')?.transcriptPath).toBeNull()
    expect(store.loadRawLinesForTurn('session', 'user-1')).toHaveLength(1)
    db.close()
  })

  it('deletes all per-session rows and keeps other sessions', async () => {
    const { projectDir, db, store } = await setup()
    await writeFile(join(projectDir, 'session.jsonl'), jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/cotta', message: { role: 'user', content: 'hi' } }))
    await store.ensureSessionCached('session')
    seedPerSessionRows(db, 'session')
    seedPerSessionRows(db, 'other-session')

    store.deleteCachedSession('session')

    expect(store.index.getSession('session')).toBeNull()
    for (const table of perSessionTables) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get('session')).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get('other-session')).toEqual({ count: 1 })
    }
    db.close()
  })
})
