import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { projectIdFromPath } from './claude-code-api.js'
import { createCottaDatabase } from './database.js'
import { SessionSearchStore } from './session-search-store.js'
import { TranscriptIndexStore } from './transcript-index-store.js'

function insertSession(index: TranscriptIndexStore, sessionId: string, cwd: string, overrides: Partial<Parameters<TranscriptIndexStore['upsertSession']>[0]> = {}): void {
  index.upsertSession({
    sessionId,
    transcriptPath: `${cwd}/${sessionId}.jsonl`,
    fileSize: 100,
    fileMtimeMs: 200,
    currentCwd: cwd,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    summaryHint: null,
    firstPrompt: null,
    firstPromptLocked: null,
    commandFallback: null,
    gitBranch: 'main',
    isSidechain: false,
    entrypoint: 'cli',
    sessionKind: 'default',
    isValidSessionId: true,
    ...overrides,
  })
}

function insertLine(db: DatabaseSync, sessionId: string, byteOffset: number, value: unknown, ownerTurnId: string | null, timestampMs: number | null = null): void {
  db.prepare(`
    INSERT INTO session_raw_transcript_lines (
      session_id, byte_offset, byte_length, line_no, uuid, type, timestamp_ms, parent_uuid, is_sidechain,
      user_type, entrypoint, cwd, version, git_branch, owner_turn_id, raw_json, created_at_ms
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    byteOffset,
    byteOffset + 1,
    typeof value === 'object' && value !== null && 'uuid' in value ? ((value as { uuid?: string }).uuid ?? null) : null,
    typeof value === 'object' && value !== null && 'type' in value ? ((value as { type?: string }).type ?? null) : null,
    timestampMs,
    typeof value === 'object' && value !== null && 'parentUuid' in value ? ((value as { parentUuid?: string }).parentUuid ?? null) : null,
    typeof value === 'object' && value !== null && 'isSidechain' in value ? ((value as { isSidechain?: boolean }).isSidechain ? 1 : 0) : null,
    null,
    null,
    typeof value === 'object' && value !== null && 'cwd' in value ? ((value as { cwd?: string }).cwd ?? null) : null,
    null,
    null,
    ownerTurnId,
    JSON.stringify(value),
    1,
  )
}

function user(uuid: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: 'user', uuid, sessionId: 'session-1', message: { role: 'user', content }, ...extra }
}

function assistant(uuid: string, content: unknown, extra: Record<string, unknown> = {}, messageId: unknown = uuid): unknown {
  return { type: 'assistant', uuid, sessionId: 'session-1', message: { id: messageId, role: 'assistant', content }, ...extra }
}

describe('SessionSearchStore', () => {
  it('indexes metadata whitelist and visible main transcript text only', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'Alpha title', gitBranch: 'feature/search', entrypoint: 'cli', sessionKind: 'normal' })
    insertLine(db, 'session-1', 0, user('user-1', 'visible user text', { cwd: '/repo/project' }), 'user-1', 1000)
    insertLine(
      db,
      'session-1',
      1,
      assistant('assistant-1', [
        { type: 'text', text: 'visible assistant text' },
        { type: 'thinking', thinking: 'ignore' },
        { type: 'text', text: 'second visible block' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      ]),
      'user-1',
      2000,
    )
    insertLine(db, 'session-1', 2, { type: 'system', uuid: 'system-1', sessionId: 'session-1', message: { role: 'system', content: 'hidden system text' } }, 'user-1', 3000)
    insertLine(
      db,
      'session-1',
      3,
      user('task-1', '<task-notification><task-id>1</task-id><tool-use-id>tool-1</tool-use-id></task-notification>', { origin: { kind: 'task-notification' } }),
      'user-1',
      4000,
    )
    insertLine(db, 'session-1', 4, user('tool-result-1', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hidden result text' }], { parent_tool_use_id: 'tool-1' }), 'user-1', 5000)
    insertLine(db, 'session-1', 5, assistant('assistant-side', [{ type: 'text', text: 'hidden sidechain text' }], { isSidechain: true }), 'user-1', 6000)
    insertLine(db, 'session-1', 6, assistant('assistant-nested', [{ type: 'text', text: 'hidden nested assistant text' }], { parent_tool_use_id: 'tool-1' }), 'user-1', 7000)

    const store = new SessionSearchStore(db, index)
    expect(store.rebuildSession('session-1')).toBe(true)

    expect(store.search({ query: 'Alpha' }).results[0]?.matches[0]?.field).toBe('title')
    expect(store.search({ query: 'feature/search' }).results[0]?.matches[0]?.field).toBe('gitBranch')
    expect(store.search({ query: 'cli' }).results).toEqual([])
    expect(store.search({ query: 'normal' }).results).toEqual([])
    expect(store.search({ query: 'visible user' }).results[0]?.matches.some((match) => match.field === 'user')).toBe(true)
    expect(store.search({ query: 'visible assistant' }).results[0]?.matches.find((match) => match.field === 'assistant')?.locator).toEqual({
      turnId: 'user-1',
      messageUuid: 'assistant-1',
      blockIndex: 0,
    })
    expect(store.search({ query: 'second visible' }).results[0]?.matches[0]?.locator?.blockIndex).toBe(2)
    expect(store.search({ query: 'hidden result' }).results).toEqual([])
    expect(store.search({ query: 'hidden system' }).results).toEqual([])
    expect(store.search({ query: 'hidden sidechain' }).results).toEqual([])
    expect(store.search({ query: 'hidden nested' }).results).toEqual([])
    db.close()
  })

  it('replaces an indexed title immediately after metadata-only rename', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'Old searchable title' })
    insertLine(db, 'session-1', 0, user('user-1', 'stable message text'), 'user-1', 1000)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    const messageDocumentIds = db.prepare(`SELECT doc_id FROM session_search_documents WHERE session_id = ? AND field IN ('user', 'assistant') ORDER BY doc_id`).all('session-1')
    expect(store.updateTitle('session-1', 'New searchable title')).toBe(true)
    expect(db.prepare(`SELECT doc_id FROM session_search_documents WHERE session_id = ? AND field IN ('user', 'assistant') ORDER BY doc_id`).all('session-1')).toEqual(messageDocumentIds)
    expect(store.search({ query: 'Old searchable title' }).results).toEqual([])
    expect(store.search({ query: 'New searchable title' }).results[0]?.session.title).toBe('New searchable title')
    db.close()
  })

  it('supports two-character Unicode-folded substring search with original snippet offsets', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: `aa ${'x'.repeat(39)}你好标题` })
    insertLine(db, 'session-1', 0, user('user-1', 'İstanbul Åb', { cwd: '/repo/project' }), 'user-1', 1000)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    for (const [query, expected] of [
      ['你好', '你好'],
      ['ST', 'st'],
      ['i̇', 'İ'],
      ['åb', 'Åb'],
    ]) {
      const match = store.search({ query }).results[0]?.matches[0]
      expect(match?.snippet.slice(match.ranges[0]?.start, match.ranges[0]?.end)).toBe(expected)
    }
    db.close()
  })

  it('invalidates documents when search indexing rules change', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'searchable session' })
    insertLine(db, 'session-1', 0, user('user-1', 'legacy needle'), 'user-1')
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')
    db.prepare('INSERT INTO settings (scope, key, value_json, updated_at_ms) VALUES (?, ?, ?, ?)').run('session-search-store', 'rules-version', '0', 1)

    expect(store.prepareRulesVersion()).toBe(true)
    expect(db.prepare('SELECT * FROM session_search_documents').all()).toEqual([])
    expect(db.prepare('SELECT * FROM session_search_state').all()).toEqual([])
    expect(db.prepare('SELECT value_json FROM settings WHERE scope = ? AND key = ?').get('session-search-store', 'rules-version')).toEqual({ value_json: '3' })

    store.rebuildSession('session-1')
    const documents = db.prepare('SELECT message_uuid, content FROM session_search_documents').all()
    expect(store.prepareRulesVersion()).toBe(false)
    expect(db.prepare('SELECT message_uuid, content FROM session_search_documents').all()).toEqual(documents)
    db.close()
  })

  it('excludes recognized local command chains', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'searchable session' })
    insertLine(db, 'session-1', 0, user('command', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>needle</command-args>'), 'command')
    insertLine(db, 'session-1', 1, user('feedback', '<local-command-stdout>needle output</local-command-stdout>', { parentUuid: 'command', userType: 'external' }), 'command')
    insertLine(db, 'session-1', 2, user('unlinked', '<local-command-stdout>unlinked needle output</local-command-stdout>', { userType: 'external' }), 'unlinked')
    insertLine(db, 'session-1', 3, user('ordinary', 'ordinary needle text'), 'ordinary')
    insertLine(
      db,
      'session-1',
      4,
      user('sourced', '<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>needle</command-args>', {
        userType: 'external',
        origin: { kind: 'human' },
        promptSource: 'typed',
      }),
      'sourced',
    )
    insertLine(db, 'session-1', 5, user('unknown', '<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>needle</command-args>'), 'unknown')
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    const result = store.search({ query: 'needle' })
    expect(db.prepare(`SELECT field, message_uuid, logical_message_id, content FROM session_search_documents WHERE content LIKE '%needle%'`).all()).toEqual([
      { field: 'user', message_uuid: 'unlinked', logical_message_id: 'unlinked', content: '<local-command-stdout>unlinked needle output</local-command-stdout>' },
      { field: 'user', message_uuid: 'ordinary', logical_message_id: 'ordinary', content: 'ordinary needle text' },
      {
        field: 'user',
        message_uuid: 'sourced',
        logical_message_id: 'sourced',
        content: '<command-name>/plugin</command-name> <command-message>plugin</command-message> <command-args>needle</command-args>',
      },
    ])
    expect(result.totalMatches).toBe(3)
    expect(result.results[0]?.matches.map((match) => match.locator?.messageUuid)).toEqual(['ordinary', 'unlinked', 'sourced'])
    db.close()
  })

  it('excludes feedback linked to a command from an earlier incremental batch', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'searchable session' })
    const store = new SessionSearchStore(db, index)
    const command = user('command', '<command-name>/model</command-name><command-message>model</command-message>')
    const feedback = user('feedback', '<local-command-stdout>needle output</local-command-stdout>', { parentUuid: 'command', userType: 'external' })
    insertLine(db, 'session-1', 0, command, 'command')
    store.appendSessionLines('session-1', [{ ownerTurnId: 'command', uuid: 'command', timestampMs: 1, value: command }])
    insertLine(db, 'session-1', 1, feedback, 'command')
    store.appendSessionLines('session-1', [{ ownerTurnId: 'command', uuid: 'feedback', timestampMs: 2, value: feedback }])

    expect(store.search({ query: 'needle' }).results).toEqual([])
    db.close()
  })

  it('excludes only recognized interrupt markers', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'searchable session' })
    insertLine(db, 'session-1', 0, user('structured', [{ type: 'text', text: '[Request interrupted by user]' }], { interruptedMessageId: 'msg_interrupted' }), 'structured')
    insertLine(db, 'session-1', 1, user('fallback', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], { userType: 'external' }), 'fallback')
    insertLine(db, 'session-1', 2, user('ordinary', [{ type: 'text', text: '[Request interrupted by user] ordinary needle' }], { userType: 'external' }), 'ordinary')
    insertLine(db, 'session-1', 3, user('non-external', [{ type: 'text', text: '[Request interrupted by user] external needle' }]), 'non-external')
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    expect(db.prepare(`SELECT message_uuid, content FROM session_search_documents WHERE field = 'user' ORDER BY doc_id`).all()).toEqual([
      { message_uuid: 'ordinary', content: '[Request interrupted by user] ordinary needle' },
      { message_uuid: 'non-external', content: '[Request interrupted by user] external needle' },
    ])
    expect(store.search({ query: 'needle' }).results[0]?.matches.map((match) => match.locator?.messageUuid)).toEqual(['non-external', 'ordinary'])
    db.close()
  })

  it('prefers title then metadata then user then assistant and groups by session', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-title', '/repo/title', { customTitle: 'needle title' })
    insertSession(index, 'session-user', '/repo/user', { customTitle: 'other', gitBranch: 'main' })
    insertSession(index, 'session-assistant', '/repo/assistant', { customTitle: 'other-2', gitBranch: 'main' })
    insertLine(db, 'session-user', 0, user('user-1', 'needle in user', { sessionId: 'session-user', cwd: '/repo/user' }), 'user-1', 2000)
    insertLine(db, 'session-assistant', 0, user('user-2', 'prompt', { sessionId: 'session-assistant', cwd: '/repo/assistant' }), 'user-2', 1000)
    insertLine(db, 'session-assistant', 1, assistant('assistant-2', [{ type: 'text', text: 'needle in assistant' }], { sessionId: 'session-assistant' }), 'user-2', 3000)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-title')
    store.rebuildSession('session-user')
    store.rebuildSession('session-assistant')

    const result = store.search({ query: 'needle' })
    expect(result.results.map((item) => item.session.id)).toEqual(['session-title', 'session-user', 'session-assistant'])
    db.close()
  })

  it('orders each searchable field by its own priority', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    const cases = [
      ['title', '/repo/title', { customTitle: 'needle title' }],
      ['sessionId', '/repo/session-id', { customTitle: 'other', sessionId: 'needle-session' }],
      ['cwd', '/repo/needle-cwd', { customTitle: 'other' }],
      ['gitBranch', '/repo/branch', { customTitle: 'other', gitBranch: 'needle-branch' }],
    ] as const
    for (const [field, cwd, overrides] of cases) insertSession(index, 'sessionId' in overrides ? overrides.sessionId : `session-${field}`, cwd, overrides)
    insertSession(index, 'session-user', '/repo/user', { customTitle: 'other' })
    insertLine(db, 'session-user', 0, user('user-1', 'needle user'), 'user-1')
    insertSession(index, 'session-assistant', '/repo/assistant', { customTitle: 'other' })
    insertLine(db, 'session-assistant', 0, assistant('assistant-1', 'needle assistant'), 'turn-1')
    const store = new SessionSearchStore(db, index)
    for (const id of ['session-title', 'needle-session', 'session-cwd', 'session-gitBranch', 'session-user', 'session-assistant']) store.rebuildSession(id)

    expect(store.search({ query: 'needle' }).results.map((result) => result.matches[0]?.field)).toEqual(['title', 'sessionId', 'cwd', 'gitBranch', 'user', 'assistant'])
    db.close()
  })

  it('limits distinct sessions before retaining per-session matches for substring and FTS search', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-many', '/repo/many', { customTitle: 'many', fileMtimeMs: 300 })
    insertSession(index, 'session-other', '/repo/other', { customTitle: 'other', fileMtimeMs: 100 })
    for (let offset = 0; offset < 205; offset += 1)
      insertLine(db, 'session-many', offset, user(`many-${offset}`, 'needle 你好 repeated', { sessionId: 'session-many', cwd: '/repo/many' }), `many-${offset}`, 300 + offset)
    insertLine(db, 'session-other', 0, user('other-1', 'needle 你好 distinct', { sessionId: 'session-other', cwd: '/repo/other' }), 'other-1', 100)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-many')
    store.rebuildSession('session-other')

    for (const query of ['你好', 'needle']) {
      const result = store.search({ query })
      expect(
        result.results.map((item) => item.session.id),
        query,
      ).toEqual(['session-many', 'session-other'])
      expect(result.results[0]?.matches).toHaveLength(5)
      expect(result.results[0]?.truncatedMatches).toBe(true)
    }
    db.close()
  })

  it('limits matches per session and marks truncation', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'needle title' })
    insertLine(db, 'session-1', 0, user('user-1', 'needle user one', { cwd: '/repo/project' }), 'user-1', 1000)
    insertLine(db, 'session-1', 1, assistant('assistant-1', [{ type: 'text', text: 'needle assistant one' }]), 'user-1', 1001)
    insertLine(db, 'session-1', 2, assistant('assistant-2', [{ type: 'text', text: 'needle assistant two' }]), 'user-1', 1002)
    insertLine(db, 'session-1', 3, assistant('assistant-3', [{ type: 'text', text: 'needle assistant three' }]), 'user-1', 1003)
    insertLine(db, 'session-1', 4, assistant('assistant-4', [{ type: 'text', text: 'needle assistant four' }]), 'user-1', 1004)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    const result = store.search({ query: 'needle' })
    expect(result.results[0]?.matches).toHaveLength(6)
    expect(result.results[0]?.matches.filter((match) => match.field === 'user' || match.field === 'assistant')).toHaveLength(5)
    expect(result.results[0]?.messageMatchCount).toBe(5)
    expect(result.results[0]?.truncatedMatches).toBe(false)
    db.close()
  })

  it.each(['你好', 'needle'])('paginates %s search to the end with exact totals and deduplicated logical messages', (query) => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    for (let position = 0; position < 105; position += 1) {
      const sessionId = `session-${String(position).padStart(2, '0')}`
      insertSession(index, sessionId, `/repo/${sessionId}`, { customTitle: `${query} metadata`, fileMtimeMs: 1000 - position })
      insertLine(
        db,
        sessionId,
        0,
        user(
          `user-${position}`,
          [
            { type: 'text', text: `${query} first` },
            { type: 'text', text: `${query} second block` },
          ],
          { sessionId, cwd: `/repo/${sessionId}` },
        ),
        `turn-${position}`,
        2000,
      )
      insertLine(db, sessionId, 1, assistant(`assistant-${position}`, `${query} answer`, { sessionId }), `turn-${position}`, 2001)
    }
    const store = new SessionSearchStore(db, index)
    for (let position = 0; position < 105; position += 1) store.rebuildSession(`session-${String(position).padStart(2, '0')}`)

    const pages = []
    let cursor: string | undefined
    do {
      const page = store.search({ query, cursor })
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    expect(pages.map((page) => page.results.length)).toEqual([20, 20, 20, 20, 20, 5])
    expect(new Set(pages.flatMap((page) => page.results.map((item) => item.session.id)))).toHaveProperty('size', 105)
    for (const page of pages) expect(page).toMatchObject({ totalSessions: 105, totalMatches: 210 })
    expect(pages[0]).toMatchObject({ hasMore: true })
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null })
    db.close()
  })

  it('removes stale blocks when a later assistant variant has fewer text blocks', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'assistant variants' })
    insertLine(db, 'session-1', 0, user('user-1', 'prompt', { cwd: '/repo/project' }), 'user-1')
    insertLine(
      db,
      'session-1',
      1,
      assistant(
        'assistant-1',
        [
          { type: 'text', text: 'current text' },
          { type: 'text', text: 'obsolete text' },
        ],
        {},
        'assistant-api-1',
      ),
      'user-1',
    )
    insertLine(db, 'session-1', 2, assistant('assistant-2', [{ type: 'text', text: 'current text' }], {}, 'assistant-api-1'), 'user-1')
    const store = new SessionSearchStore(db, index)

    store.rebuildSession('session-1')

    expect(store.search({ query: 'obsolete' }).results).toEqual([])
    expect(store.search({ query: 'current' }).results[0]?.matches[0]?.locator?.messageUuid).toBe('assistant-2')
    db.close()
  })

  it.each(['你好', 'needle'])('counts %s matches by user transcript uuid and assistant API message id', (query) => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'search identities' })
    insertLine(db, 'session-1', 0, user('user-1', `${query} user`, { cwd: '/repo/project' }), 'user-1')
    insertLine(db, 'session-1', 1, assistant('assistant-transcript-1', `${query} first`, {}, 'assistant-api-1'), 'user-1')
    insertLine(db, 'session-1', 2, assistant('assistant-transcript-2', `${query} second`, {}, 'assistant-api-1'), 'user-1')
    insertLine(db, 'session-1', 3, { type: 'assistant', uuid: 'assistant-missing', message: { role: 'assistant', content: `${query} missing` } }, 'user-1')
    insertLine(db, 'session-1', 4, assistant('assistant-non-string', `${query} non-string`, {}, 1), 'user-1')
    insertLine(db, 'session-1', 5, assistant('assistant-empty', `${query} empty`, {}, ''), 'user-1')
    insertLine(db, 'session-1', 6, assistant('assistant-conflict', `${query} conflict one`, {}, 'assistant-api-2'), 'user-1')
    insertLine(db, 'session-1', 7, assistant('assistant-conflict', `${query} conflict two`, {}, 'assistant-api-3'), 'user-1')
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    const result = store.search({ query })
    expect(result).toMatchObject({ totalSessions: 1, totalMatches: 2 })
    expect(result.results).toHaveLength(1)
    expect(store.search({ query: 'first' }).results).toEqual([])
    expect(store.search({ query: 'second' }).results[0]?.matches[0]?.locator?.messageUuid).toBe('assistant-transcript-2')
    db.close()
  })

  it('hydrates later pages without rerunning the full search and expires snapshots', () => {
    vi.useFakeTimers()
    try {
      const db = createCottaDatabase(':memory:')
      const index = new TranscriptIndexStore(db)
      for (let position = 0; position < 21; position += 1) {
        const sessionId = `session-${position}`
        insertSession(index, sessionId, `/repo/${sessionId}`, { customTitle: 'needle title', fileMtimeMs: position })
      }
      const store = new SessionSearchStore(db, index)
      for (let position = 0; position < 21; position += 1) store.rebuildSession(`session-${position}`)
      const searchRows = vi.spyOn(store as unknown as { searchRows(query: string, mode: 'substring' | 'fts', sessionIds?: string[]): unknown[] }, 'searchRows')
      const cursor = store.search({ query: 'needle' }).nextCursor!
      expect(searchRows).toHaveBeenCalledOnce()
      expect(searchRows).toHaveBeenCalledWith('needle', 'fts', expect.arrayContaining(Array.from({ length: 20 }, () => expect.any(String))))
      searchRows.mockClear()

      expect(store.search({ query: 'needle', cursor }).results).toHaveLength(1)
      expect(searchRows).toHaveBeenCalledWith('needle', 'fts', [expect.any(String)])

      const staleCursor = store.search({ query: 'needle' }).nextCursor!
      vi.advanceTimersByTime(60_001)
      expect(() => store.search({ query: 'needle', cursor: staleCursor })).toThrowError(expect.objectContaining({ code: 'stale' }))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects invalid and query-bound stale cursors', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    for (let position = 0; position < 21; position += 1) {
      const sessionId = `session-${position}`
      insertSession(index, sessionId, `/repo/${sessionId}`, { customTitle: 'needle title', fileMtimeMs: position })
    }
    const store = new SessionSearchStore(db, index)
    for (let position = 0; position < 21; position += 1) store.rebuildSession(`session-${position}`)
    const cursor = store.search({ query: 'needle' }).nextCursor
    expect(cursor).not.toBeNull()

    expect(() => store.search({ query: 'needle', cursor: 'not-json' })).toThrowError(expect.objectContaining({ code: 'invalid' }))
    expect(() => store.search({ query: 'different', cursor: cursor ?? undefined })).toThrowError(expect.objectContaining({ code: 'stale' }))
    db.close()
  })

  it('replaces old message documents on rebuild and clearSession', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/project', { customTitle: 'alpha title' })
    insertLine(db, 'session-1', 0, user('user-1', 'alpha text', { cwd: '/repo/project' }), 'user-1', 1000)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')
    expect(store.search({ query: 'alpha text' }).results).toHaveLength(1)

    db.prepare('DELETE FROM session_raw_transcript_lines WHERE session_id = ?').run('session-1')
    insertLine(db, 'session-1', 0, user('user-1', 'beta text', { cwd: '/repo/project' }), 'user-1', 2000)
    store.rebuildSession('session-1')
    expect(store.search({ query: 'alpha text' }).results).toEqual([])
    expect(store.search({ query: 'beta text' }).results).toHaveLength(1)
    expect(store.search({ query: 'alpha title' }).results).toHaveLength(1)

    store.clearSession('session-1')
    expect(store.search({ query: 'beta text' }).results).toEqual([])
    db.close()
  })

  it('returns current project metadata after relocation without duplicating results', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    insertSession(index, 'session-1', '/repo/old-project', { customTitle: 'moved title' })
    insertLine(db, 'session-1', 0, user('user-1', 'move me', { cwd: '/repo/old-project' }), 'user-1', 1000)
    const store = new SessionSearchStore(db, index)
    store.rebuildSession('session-1')

    insertSession(index, 'session-1', '/repo/new-project', { customTitle: 'moved title' })
    const result = store.search({ query: 'move' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.project.id).toBe(projectIdFromPath('/repo/new-project'))
    expect(result.results[0]?.session.projectId).toBe(projectIdFromPath('/repo/new-project'))
    db.close()
  })
})
