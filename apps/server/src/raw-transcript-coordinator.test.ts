import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from './database.js'

const taskSnapshotReader = vi.hoisted(() => ({
  actual: null as null | typeof import('./session-task-snapshot.js').readSessionTaskSnapshot,
  read: vi.fn(),
}))

vi.mock('./session-task-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-task-snapshot.js')>()
  taskSnapshotReader.actual = actual.readSessionTaskSnapshot
  taskSnapshotReader.read.mockImplementation(actual.readSessionTaskSnapshot)
  return { ...actual, readSessionTaskSnapshot: taskSnapshotReader.read }
})

import { RawTranscriptCoordinator } from './raw-transcript-coordinator.js'
import { SessionRawTranscriptCacheStore, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { SessionSubagentStore } from './session-subagent-store.js'
import { TokenUsageStore } from './token-usage-store.js'

const roots: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  taskSnapshotReader.read.mockImplementation(taskSnapshotReader.actual!)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(options: Partial<ConstructorParameters<typeof RawTranscriptCoordinator>[1]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cotta-raw-transcript-coordinator-'))
  roots.push(root)
  const config = join(root, '.claude')
  const projectsRoot = join(config, 'projects')
  await mkdir(projectsRoot, { recursive: true })
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  const cache = new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config })
  return { db, cache, config, projectsRoot, coordinator: new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', ...options }) }
}

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

describe('RawTranscriptCoordinator', () => {
  it('keeps unavailable background sync quiet while explicit reads fail', async () => {
    const { db, coordinator } = await setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(coordinator.syncForRead('missing')).rejects.toBeInstanceOf(TranscriptUnavailableError)
    expect(consoleError).not.toHaveBeenCalled()

    await coordinator.close()
    db.close()
  })

  it('signals hot sessions without immediately syncing', async () => {
    const { db, cache, coordinator } = await setup()
    const sync = vi.spyOn(cache, 'ensureSessionCachedById')

    coordinator.signalSession('session')

    expect(sync).not.toHaveBeenCalled()
    await coordinator.close()
    db.close()
  })

  it('logs unexpected hot tail sync failures', async () => {
    const { db, cache, coordinator } = await setup({ hotPollMs: 1 })
    const error = new Error('boom')
    vi.spyOn(cache, 'ensureSessionCachedById').mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    coordinator.start()
    coordinator.signalSession('session')

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('raw-transcript:hot sync failed for session', error))
    await coordinator.close()
    db.close()
  })

  it('syncs explicit reads immediately', async () => {
    const { db, cache, coordinator } = await setup()
    const sync = vi.spyOn(cache, 'ensureSessionCachedById').mockResolvedValue({ changed: false })

    await coordinator.syncForRead('session')

    expect(sync).toHaveBeenCalledWith('session')
    await coordinator.close()
    db.close()
  })

  it('runs one follow-up sync when another request arrives in flight', async () => {
    const onSessionSynced = vi.fn()
    const { db, cache, coordinator } = await setup({ onSessionSynced, timelineVersionReader: () => 'canonical-v1' })
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const sync = vi
      .spyOn(cache, 'ensureSessionCachedById')
      .mockImplementationOnce(async () => {
        await first
        return { changed: true, sessionId: 'session', projectId: 'project', previousProjectId: 'old-project', version: 'v1', reset: false, invalidateFromTurnId: null, subagentRootsChanged: false }
      })
      .mockResolvedValueOnce({ changed: false })
    const a = coordinator.syncForRead('session', 'project')
    const b = coordinator.syncForRead('session', 'project')
    release()
    await Promise.all([a, b])

    expect(sync).toHaveBeenCalledTimes(2)
    expect(onSessionSynced).toHaveBeenCalledTimes(1)
    expect(onSessionSynced).toHaveBeenCalledWith(expect.objectContaining({ previousProjectId: 'old-project', projectId: 'project', version: 'canonical-v1' }))
    await coordinator.close()
    db.close()
  })

  it('re-reads a task snapshot requested while a refresh is in flight', async () => {
    const { db, cache, config, coordinator } = await setup()
    process.env.CLAUDE_CONFIG_DIR = config
    cache.index.upsertSession({ sessionId: 'session', transcriptPath: '/tmp/session.jsonl', fileSize: 1, fileMtimeMs: 1, currentCwd: '/repo/project' })
    const taskPath = join(config, 'tasks', 'session', '1.json')
    await mkdir(join(config, 'tasks', 'session'), { recursive: true })
    await writeFile(taskPath, JSON.stringify({ id: '1', subject: 'old', status: 'pending', blockedBy: [] }))
    let releaseFirstRead!: () => void
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    const actualRead = taskSnapshotReader.actual!
    const initialReads = taskSnapshotReader.read.mock.calls.length
    taskSnapshotReader.read.mockImplementationOnce(async (...args: Parameters<typeof actualRead>) => {
      const snapshot = await actualRead(...args)
      await firstRead
      return snapshot
    })

    const first = coordinator.refreshTaskSnapshot('session')
    await vi.waitFor(() => expect(taskSnapshotReader.read).toHaveBeenCalled())
    await writeFile(taskPath, JSON.stringify({ id: '1', subject: 'new', status: 'pending', blockedBy: [] }))
    const second = coordinator.refreshTaskSnapshot('session')
    releaseFirstRead()
    await Promise.all([first, second])

    expect(cache.index.getSession('session')?.taskSnapshot).toEqual([{ id: '1', subject: 'new', status: 'pending', blockedBy: [] }])
    expect(taskSnapshotReader.read).toHaveBeenCalledTimes(initialReads + 2)
    await coordinator.close()
    db.close()
  })

  it('publishes only a session version for task-only refreshes', async () => {
    const onSessionSynced = vi.fn()
    const onSessionVersionChanged = vi.fn()
    const { db, cache, config, coordinator } = await setup({ onSessionSynced, onSessionVersionChanged, timelineVersionReader: () => 'canonical-tasks-v1' })
    process.env.CLAUDE_CONFIG_DIR = config
    cache.index.upsertSession({ sessionId: 'session', transcriptPath: '/tmp/session.jsonl', fileSize: 1, fileMtimeMs: 1, currentCwd: '/repo/project' })
    await mkdir(join(config, 'tasks', 'session'), { recursive: true })
    await writeFile(join(config, 'tasks', 'session', '1.json'), JSON.stringify({ id: '1', subject: 'task', status: 'pending', blockedBy: [] }))

    await coordinator.refreshTaskSnapshot('session')

    expect(onSessionSynced).not.toHaveBeenCalled()
    expect(onSessionVersionChanged).toHaveBeenCalledWith({ projectId: cache.index.getSession('session')!.currentProjectId, sessionId: 'session', version: 'canonical-tasks-v1' })
    await coordinator.close()
    db.close()
  })

  it('reconciles metadata when transcript sync discovers a root', async () => {
    const onSessionSynced = vi.fn()
    const onSubagentsChanged = vi.fn()
    const { db, config } = await setup()
    const subagentStore = new SessionSubagentStore(db)
    const cache = new SessionRawTranscriptCacheStore(db, { claudeConfigDir: config, subagentStore })
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', onSessionSynced, onSubagentsChanged, subagentStore })
    const transcriptPath = join(config, 'projects', '-repo-project', 'session.jsonl')
    const subagentsDir = join(config, 'projects', '-repo-project', 'session', 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(subagentsDir, 'agent-a.meta.json'), JSON.stringify({ description: 'scan' }))
    await writeFile(
      transcriptPath,
      jsonl(
        { type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'scan' } },
        { type: 'user', uuid: 'result-1', sessionId: 'session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] }, toolUseResult: { agentId: 'a' } },
      ),
    )

    await coordinator.syncForRead('session')

    expect(cache.index.getSession('session')).toMatchObject({ currentCwd: '/repo/project' })
    expect(db.prepare('SELECT uuid, owner_turn_id, raw_json FROM session_raw_transcript_lines ORDER BY line_no').all()).toEqual([
      expect.objectContaining({ uuid: 'user-1', owner_turn_id: 'user-1' }),
      expect.objectContaining({ uuid: 'result-1', owner_turn_id: 'user-1' }),
    ])
    expect(db.prepare('SELECT subagent_id, owner_turn_id, meta_path FROM session_subagents').all()).toEqual([
      expect.objectContaining({ subagent_id: 'a', owner_turn_id: 'user-1', meta_path: expect.any(String) }),
    ])
    expect(subagentStore.listTurn('session', 'user-1')).toEqual([expect.objectContaining({ subagentId: 'a', metadataReady: true })])
    expect(onSubagentsChanged).toHaveBeenCalledOnce()
    expect(onSubagentsChanged).toHaveBeenCalledWith({ projectId: cache.index.getSession('session')!.currentProjectId, sessionId: 'session' })
    expect(onSessionSynced).toHaveBeenCalledOnce()
    await coordinator.close()
    db.close()
  })

  it('runs one trailing subagent refresh and returns cumulative change', async () => {
    const { db, cache, config } = await setup()
    const subagentStore = new SessionSubagentStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore })
    let trailing!: Promise<boolean>
    const reconcile = vi
      .spyOn(subagentStore, 'reconcileMetadata')
      .mockImplementationOnce(() => {
        trailing = coordinator.refreshSubagentIndex('session')
        return true
      })
      .mockReturnValueOnce(false)
    const transcriptPath = join(config, 'projects', '-repo-project', 'session.jsonl')
    const subagentsDir = join(config, 'projects', '-repo-project', 'session', 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project' }))
    await writeFile(join(subagentsDir, 'agent-a.meta.json'), JSON.stringify({ description: 'scan' }))
    cache.index.upsertSession({ sessionId: 'session', transcriptPath, fileSize: 1, fileMtimeMs: 1, currentCwd: '/repo/project' })
    subagentStore.recordRoots('session', [{ subagentId: 'a', ownerTurnId: 'user-1' }], false)

    await expect(coordinator.refreshSubagentIndex('session')).resolves.toBe(true)
    await expect(trailing).resolves.toBe(true)
    expect(reconcile).toHaveBeenCalledTimes(2)
    await coordinator.close()
    db.close()
  })

  it('still publishes transcript changes when auxiliary refreshes fail', async () => {
    const onSessionSynced = vi.fn()
    const { db, cache, coordinator } = await setup({ onSessionSynced })
    const taskError = new Error('task failed')
    const subagentError = new Error('subagent failed')
    vi.spyOn(cache, 'ensureSessionCachedById').mockResolvedValue({
      changed: true,
      sessionId: 'session',
      projectId: 'project',
      version: 'v1',
      reset: false,
      invalidateFromTurnId: null,
      subagentRootsChanged: true,
    })
    vi.spyOn(coordinator, 'refreshTaskSnapshot').mockRejectedValue(taskError)
    vi.spyOn(coordinator, 'refreshSubagentIndex').mockRejectedValue(subagentError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await coordinator.syncForRead('session')

    expect(consoleError).toHaveBeenCalledWith('raw-transcript:task refresh failed for session', taskError)
    expect(consoleError).toHaveBeenCalledWith('raw-transcript:subagent refresh failed for session', subagentError)
    expect(onSessionSynced).toHaveBeenCalledOnce()
    await coordinator.close()
    db.close()
  })

  it('waits for initial discovery only when the cache is empty', async () => {
    const { db, coordinator } = await setup()
    let release!: () => void
    const scan = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan').mockReturnValue(scan)

    coordinator.start()
    let ready = false
    void coordinator.ensureReady().then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    release()
    await expect(coordinator.ensureReady()).resolves.toBeUndefined()
    await coordinator.close()
    db.close()
  })

  it('serves a persisted search index without waiting for startup or later scans', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, 'project-a')
    await mkdir(projectDir)
    await writeFile(join(projectDir, 'session.jsonl'), jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project-a', message: { role: 'user', content: 'persisted' } }))
    await cache.ensureSessionCachedById('session')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan').mockReturnValue(blocked)

    coordinator.start()
    await expect(coordinator.ensureReady()).resolves.toBeUndefined()
    const refresh = coordinator.refreshNow()
    await expect(coordinator.ensureReady()).resolves.toBeUndefined()

    release()
    await refresh
    await coordinator.close()
    db.close()
  })

  it('reports per-session scan progress for a global scan', async () => {
    const onScanProgress = vi.fn()
    const { db, projectsRoot, coordinator } = await setup({ onScanProgress })
    const projectDir = join(projectsRoot, 'project-a')
    await mkdir(projectDir)
    await writeFile(join(projectDir, 'session-1.jsonl'), jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session-1', cwd: '/repo/project-a', message: { role: 'user', content: 'a' } }))
    await writeFile(join(projectDir, 'session-2.jsonl'), jsonl({ type: 'user', uuid: 'user-2', sessionId: 'session-2', cwd: '/repo/project-a', message: { role: 'user', content: 'b' } }))

    await coordinator.refreshNow()
    const totals = onScanProgress.mock.calls.map((call) => call[1])
    const dones = onScanProgress.mock.calls.map((call) => call[0])
    expect(totals.every((total) => total === 2)).toBe(true)
    expect(dones).toEqual([1, 2])

    await coordinator.close()
    db.close()
  })

  it('repairs missing persisted search state and documents from cached raw lines before becoming ready', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, 'project-a')
    await mkdir(projectDir)
    await writeFile(join(projectDir, 'session.jsonl'), jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project-a', message: { role: 'user', content: 'repairable' } }))
    await cache.ensureSessionCachedById('session')
    db.prepare('DELETE FROM session_search_state WHERE session_id = ?').run('session')
    db.prepare('DELETE FROM session_search_documents WHERE session_id = ?').run('session')
    let release!: () => void
    vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan').mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )

    coordinator.start()
    await expect(coordinator.ensureReady()).resolves.toBeUndefined()

    expect(db.prepare('SELECT session_id FROM session_search_state').all()).toEqual([{ session_id: 'session' }])
    expect(db.prepare(`SELECT content FROM session_search_documents WHERE field = 'user'`).all()).toEqual([{ content: 'repairable' }])
    release()
    await coordinator.close()
    db.close()
  })

  it('rebuilds persisted search with new rules before becoming ready', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, 'project-a')
    await mkdir(projectDir)
    await writeFile(
      join(projectDir, 'session.jsonl'),
      jsonl(
        {
          type: 'user',
          uuid: 'interrupted',
          sessionId: 'session',
          cwd: '/repo/project-a',
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        },
        { type: 'user', uuid: 'ordinary', sessionId: 'session', message: { role: 'user', content: 'repairable' } },
      ),
    )
    await cache.ensureSessionCachedById('session')
    db.prepare('INSERT INTO settings (scope, key, value_json, updated_at_ms) VALUES (?, ?, ?, ?)').run('session-search-store', 'rules-version', '0', 1)
    let release!: () => void
    vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan').mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )

    coordinator.start()
    await expect(coordinator.ensureReady()).resolves.toBeUndefined()

    expect(db.prepare('SELECT session_id FROM session_search_state').all()).toEqual([{ session_id: 'session' }])
    expect(db.prepare(`SELECT message_uuid, content FROM session_search_documents WHERE field = 'user' ORDER BY doc_id`).all()).toEqual([{ message_uuid: 'ordinary', content: 'repairable' }])
    release()
    await coordinator.close()
    db.close()
  })

  it('fails startup explicitly when the persisted search schema is broken', async () => {
    const { db, coordinator } = await setup()
    db.exec('DROP TABLE session_search_state')

    expect(() => coordinator.start()).toThrow()

    db.close()
  })

  it('propagates startup scan failure for an empty cache', async () => {
    const { db, coordinator } = await setup()
    const fullScan = vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan')
    const failure = new Error('initial scan failed')
    fullScan.mockRejectedValueOnce(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    coordinator.start()

    await expect(coordinator.ensureReady()).rejects.toBe(failure)
    expect(consoleError).toHaveBeenCalledWith('raw-transcript:initial full scan failed', failure)
    await coordinator.close()
    db.close()
  })

  it('queues an authoritative global pass behind an active incremental scan', async () => {
    const { db, coordinator } = await setup()
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const calls: Array<{ projectIds?: readonly string[]; authoritative?: boolean }> = []
    vi.spyOn(coordinator as unknown as { fullScan(projectIds?: readonly string[], authoritative?: boolean): Promise<void> }, 'fullScan').mockImplementation(async (projectIds, authoritative) => {
      calls.push({ projectIds, authoritative })
      if (calls.length === 1) {
        started()
        await blocked
      }
    })

    const incremental = coordinator.refreshProjectNow('/repo/project')
    await reached
    const authoritative = coordinator.refreshUsageNow()
    release()
    await Promise.all([incremental, authoritative])

    expect(calls).toEqual([
      { projectIds: ['-repo-project'], authoritative: false },
      { projectIds: undefined, authoritative: true },
    ])
    await coordinator.close()
    db.close()
  })

  it('skips subagent refresh for unchanged rootless sessions', async () => {
    const { db, cache } = await setup()
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore: new SessionSubagentStore(db) })
    vi.spyOn(cache, 'ensureSessionCachedById').mockResolvedValue({ changed: false })
    const refresh = vi.spyOn(coordinator, 'refreshSubagentIndex')

    await coordinator.syncForRead('session')

    expect(refresh).not.toHaveBeenCalled()
    await coordinator.close()
    db.close()
  })

  it('skips subagent refresh for unchanged rooted sessions during explicit reads', async () => {
    const { db, cache } = await setup()
    const subagentStore = new SessionSubagentStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore })
    subagentStore.recordRoots('session', [{ subagentId: 'agent-1', ownerTurnId: 'user-1' }], false)
    vi.spyOn(cache, 'ensureSessionCachedById').mockResolvedValue({ changed: false })
    const refresh = vi.spyOn(coordinator, 'refreshSubagentIndex')

    await coordinator.syncForRead('session')

    expect(refresh).not.toHaveBeenCalled()
    await coordinator.close()
    db.close()
  })

  it('refreshes unchanged sessions with rooted subagents during global scans', async () => {
    const { db, cache, projectsRoot } = await setup()
    const subagentStore = new SessionSubagentStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project-a' }))
    await cache.ensureSessionCachedById('session')
    subagentStore.recordRoots('session', [{ subagentId: 'agent-1', ownerTurnId: 'user-1' }], false)
    const refresh = vi.spyOn(coordinator, 'refreshSubagentIndex').mockResolvedValue(false)

    await coordinator.refreshNow()

    expect(refresh).toHaveBeenCalledWith('session')
    await coordinator.close()
    db.close()
  })

  it('re-syncs unchanged sessions during global scans when search documents are missing', async () => {
    const { db, cache, projectsRoot } = await setup()
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing' })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project-a', message: { role: 'user', content: 'hello' } }))
    await cache.ensureSessionCachedById('session')
    db.prepare('DELETE FROM session_search_state WHERE session_id = ?').run('session')
    db.prepare('DELETE FROM session_search_documents WHERE session_id = ?').run('session')
    const sync = vi.spyOn(cache, 'ensureSessionCachedById').mockResolvedValue({ changed: false })

    await coordinator.refreshNow()

    expect(sync).toHaveBeenCalledWith('session')
    await coordinator.close()
    db.close()
  })

  it('propagates subagent refresh failures from authoritative usage refreshes', async () => {
    const { db, cache, projectsRoot } = await setup()
    const subagentStore = new SessionSubagentStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'session', cwd: '/repo/project-a' }))
    await cache.ensureSessionCachedById('session')
    subagentStore.recordRoots('session', [{ subagentId: 'agent-1', ownerTurnId: 'user-1' }], false)
    const failure = new Error('subagent snapshot failed')
    vi.spyOn(coordinator, 'refreshSubagentIndex').mockRejectedValue(failure)

    await expect(coordinator.refreshUsageNow()).rejects.toBe(failure)

    await coordinator.close()
    db.close()
  })

  it('indexes old sessions and imports raw lines', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z')
    const { db, cache, projectsRoot, coordinator } = await setup({ now: () => now })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'old-session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'old-session', cwd: '/repo/old', timestamp: '2025-01-01T00:00:00.000Z' }))
    await utimes(transcriptPath, new Date(now - 31 * 24 * 60 * 60_000), new Date(now - 31 * 24 * 60 * 60_000))

    coordinator.start()

    await vi.waitFor(() => expect(cache.index.getSession('old-session')?.transcriptPath).toBe(transcriptPath))
    expect(cache.index.getSession('old-session')).toMatchObject({
      currentCwd: '/repo/old',
      fileSize: Buffer.byteLength(jsonl({ type: 'user', uuid: 'user-1', sessionId: 'old-session', cwd: '/repo/old', timestamp: '2025-01-01T00:00:00.000Z' })),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })
    await coordinator.close()
    db.close()
  })

  it('serializes global usage repair behind incremental sync and reads fresh file state', async () => {
    const { db, cache, projectsRoot } = await setup()
    const tokenUsageStore = new TokenUsageStore(db)
    const subagentStore = new SessionSubagentStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', subagentStore, tokenUsageStore })
    const projectDir = join(projectsRoot, '-repo-usage-race')
    const transcriptPath = join(projectDir, 'usage-race.jsonl')
    const firstLine = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'usage-race', cwd: '/repo/usage-race' })
    const secondLine = jsonl({ type: 'assistant', uuid: 'assistant-1', sessionId: 'usage-race', cwd: '/repo/usage-race' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, firstLine)
    subagentStore.recordRoots('usage-race', [{ subagentId: 'agent-1', ownerTurnId: 'user-1' }], false)

    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalSync = cache.ensureSessionCachedById.bind(cache)
    const order: string[] = []
    const sync = vi
      .spyOn(cache, 'ensureSessionCachedById')
      .mockImplementationOnce(async () => {
        order.push('incremental')
        await blocked
        return { changed: false }
      })
      .mockImplementation(async (sessionId) => {
        const result = await originalSync(sessionId)
        order.push('authoritative-sync')
        return result
      })
    const refreshSubagents = vi.spyOn(coordinator, 'refreshSubagentIndex').mockImplementation(async () => {
      order.push('subagents')
      return false
    })
    const repair = vi.spyOn(tokenUsageStore, 'repairTranscript').mockImplementation(async () => {
      order.push('repair')
    })

    const incremental = coordinator.syncForRead('usage-race')
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    const scan = coordinator.refreshUsageNow()
    await writeFile(transcriptPath, `${firstLine}${secondLine}`)
    release()
    await Promise.all([incremental, scan])

    expect(order).toEqual(['incremental', 'authoritative-sync', 'subagents', 'repair'])
    expect(refreshSubagents).toHaveBeenCalledWith('usage-race')
    expect(repair).toHaveBeenCalledWith(transcriptPath, 'usage-race', Buffer.byteLength(firstLine) + Buffer.byteLength(secondLine))
    await coordinator.close()
    db.close()
  })

  it('repairs usage only on global full scans', async () => {
    const { db, cache, projectsRoot } = await setup()
    const tokenUsageStore = new TokenUsageStore(db)
    const coordinator = new RawTranscriptCoordinator(cache, { timelineVersionReader: () => 'timeline-missing', tokenUsageStore })
    const projectDir = join(projectsRoot, '-repo-usage')
    const transcriptPath = join(projectDir, 'usage-session.jsonl')
    const usage = (id: string, input: number) => ({
      type: 'assistant',
      uuid: id,
      sessionId: 'usage-session',
      cwd: '/repo/usage',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id, model: 'claude-test', usage: { input_tokens: input } },
    })
    await mkdir(projectDir)
    const original = jsonl(usage('old', 10), usage('new', 2))
    await writeFile(transcriptPath, original)
    await coordinator.refreshUsageNow()
    expect(db.prepare('SELECT response_key FROM token_usage_stats ORDER BY response_key').all()).toEqual([{ response_key: 'claude-code:new' }, { response_key: 'claude-code:old' }])

    const replacement = jsonl(usage('new', 2))
    const rewritten = `${replacement}${' '.repeat(Buffer.byteLength(original) - Buffer.byteLength(replacement))}`
    await writeFile(transcriptPath, rewritten)
    await coordinator.refreshProjectNow('/repo/usage')
    expect(db.prepare('SELECT response_key FROM token_usage_stats ORDER BY response_key').all()).toEqual([{ response_key: 'claude-code:new' }, { response_key: 'claude-code:old' }])

    await coordinator.refreshUsageNow()
    expect(db.prepare('SELECT response_key FROM token_usage_stats').all()).toEqual([{ response_key: 'claude-code:new' }])
    await coordinator.close()
    db.close()
  })

  it('rebuilds rewritten cached transcripts during refresh', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, '-repo-cached')
    const transcriptPath = join(projectDir, 'cached-session.jsonl')
    const original = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'cached-session', cwd: '/repo/cached', timestamp: '2026-01-01T00:00:00.000Z' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, original)
    await coordinator.refreshProjectNow('/repo/cached')

    expect(cache.index.getSession('cached-session')?.currentCwd).toBe('/repo/cached')
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })

    const replacement = jsonl({ type: 'user', uuid: 'user-2', sessionId: 'cached-session', cwd: '/repo/cached', timestamp: '2026-01-01T00:00:00.000Z' })
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(transcriptPath, replacement)
    const newer = new Date(Date.now() + 2_000)
    await utimes(transcriptPath, newer, newer)
    await coordinator.refreshProjectNow('/repo/cached')

    expect(cache.index.getSession('cached-session')?.currentCwd).toBe('/repo/cached')
    expect(db.prepare('SELECT uuid FROM session_raw_transcript_lines').all()).toEqual([{ uuid: 'user-2' }])
    await coordinator.close()
    db.close()
  })

  it('indexes complete lines when active transcript has an incomplete tail', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z')
    const { db, cache, projectsRoot, coordinator } = await setup({ now: () => now })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'partial-session.jsonl')
    const complete = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'partial-session', cwd: '/repo/partial', timestamp: '2026-01-01T00:00:00.000Z' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, `${complete}{"type":`)

    coordinator.start()

    await vi.waitFor(() => expect(cache.index.getSession('partial-session')?.currentCwd).toBe('/repo/partial'))
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })
    await coordinator.close()
    db.close()
  })

  it('does not keep hot polling a stable incomplete tail', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'partial-session.jsonl')
    const complete = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'partial-session', cwd: '/repo/partial', timestamp: '2026-01-01T00:00:00.000Z' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, complete)
    await coordinator.refreshProjectNow('/repo/partial')
    await writeFile(transcriptPath, `${complete}{"type":`)
    coordinator.signalSession('partial-session')
    const sync = vi.spyOn(cache, 'ensureSessionCachedById')

    await (coordinator as unknown as { pollHot: () => Promise<void> }).pollHot()
    await (coordinator as unknown as { pollHot: () => Promise<void> }).pollHot()

    expect(sync).toHaveBeenCalledTimes(1)
    await coordinator.close()
    db.close()
  })

  it('keeps the transcript path on a transient stat error and clears it only when the file disappears', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'flaky-session.jsonl')
    const line = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'flaky-session', cwd: '/repo/flaky', timestamp: '2026-01-01T00:00:00.000Z' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, line)
    await coordinator.refreshNow()
    expect(cache.index.getSession('flaky-session')?.transcriptPath).toBe(transcriptPath)

    const clearSpy = vi.spyOn(cache.index, 'clearTranscriptPath')

    // Transient (non-ENOENT) errors must not be treated as the transcript disappearing.
    // Removing execute permission on the parent directory makes stat() throw EACCES while the file still exists.
    // Skipped under root, which bypasses directory permission checks.
    if (process.getuid?.() !== 0) {
      await chmod(projectDir, 0o000)
      coordinator.signalSession('flaky-session')
      await (coordinator as unknown as { pollHot: () => Promise<void> }).pollHot()
      await chmod(projectDir, 0o755)
      expect(clearSpy).not.toHaveBeenCalled()
      expect(cache.index.getSession('flaky-session')?.transcriptPath).toBe(transcriptPath)
    }

    // Real disappearance (ENOENT) clears the path.
    await rm(transcriptPath)
    coordinator.signalSession('flaky-session')
    await (coordinator as unknown as { pollHot: () => Promise<void> }).pollHot()
    expect(clearSpy).toHaveBeenCalledWith('flaky-session')
    expect(cache.index.getSession('flaky-session')?.transcriptPath ?? null).toBeNull()

    await coordinator.close()
    db.close()
  })

  it('coalesces overlapping full scans', async () => {
    const { db, cache, coordinator } = await setup()
    const sync = vi.spyOn(cache, 'ensureSessionCachedById').mockRejectedValue(new TranscriptUnavailableError('session'))
    cache.index.upsertSession({ sessionId: 'session', transcriptPath: '/missing/session.jsonl', fileSize: 1, fileMtimeMs: 1 })

    const first = coordinator.refreshNow()
    const second = coordinator.refreshNow()
    const project = coordinator.refreshProjectNow('/repo/project')
    await Promise.all([first, second, project])

    expect(sync).toHaveBeenCalledTimes(1)
    await coordinator.close()
    db.close()
  })

  it('reconciles a transcript discovered and removed during the same scan', async () => {
    const onSessionSynced = vi.fn()
    const { db, cache, projectsRoot, coordinator } = await setup({ onSessionSynced })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'gone-session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'gone-session', cwd: '/repo/gone', timestamp: '2026-01-01T00:00:00.000Z' }))
    await coordinator.refreshNow()
    const projectId = cache.index.getSession('gone-session')!.currentProjectId!
    await utimes(transcriptPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000))
    vi.spyOn(cache, 'ensureSessionCachedById').mockImplementationOnce(async () => {
      await rm(transcriptPath)
      throw new TranscriptUnavailableError('gone-session')
    })
    onSessionSynced.mockClear()

    await coordinator.refreshNow()

    expect(cache.index.getSession('gone-session')).toBeNull()
    expect(onSessionSynced).toHaveBeenCalledWith({ sessionId: 'gone-session', projectId, kind: 'removed' })
    await coordinator.close()
    db.close()
  })

  it('reconciles offline deletion only after a successful global scan', async () => {
    const onSessionSynced = vi.fn()
    const { db, cache, projectsRoot, coordinator } = await setup({ onSessionSynced })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'deleted-session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'deleted-session', cwd: '/repo/deleted', timestamp: '2026-01-01T00:00:00.000Z' }))
    await coordinator.refreshNow()
    const projectId = cache.index.getSession('deleted-session')!.currentProjectId!
    coordinator.signalSession('deleted-session')
    onSessionSynced.mockClear()

    await rm(transcriptPath)
    await coordinator.refreshNow()

    expect(cache.index.getSession('deleted-session')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines WHERE session_id = ?').get('deleted-session')).toEqual({ count: 0 })
    expect((coordinator as unknown as { hot: Map<string, unknown> }).hot.has('deleted-session')).toBe(false)
    expect(onSessionSynced).toHaveBeenCalledWith({ sessionId: 'deleted-session', projectId, kind: 'removed' })
    await coordinator.close()
    db.close()
  })

  it('keeps a session re-synced while a global scan is in flight', async () => {
    const onSessionSynced = vi.fn()
    const { db, cache, projectsRoot, coordinator } = await setup({ onSessionSynced })
    const projectDir = join(projectsRoot, 'project-a')
    const transcriptPath = join(projectDir, 'restored-session.jsonl')
    const transcript = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'restored-session', cwd: '/repo/restored', timestamp: '2026-01-01T00:00:00.000Z' })
    await mkdir(projectDir)
    await writeFile(transcriptPath, transcript)
    await coordinator.refreshNow()
    await rm(transcriptPath)
    await writeFile(join(projectDir, 'blocker.jsonl'), jsonl({ type: 'user', uuid: 'user-2', sessionId: 'blocker', cwd: '/repo/blocker', timestamp: '2026-01-01T00:00:00.000Z' }))

    let release!: () => void
    let blocked!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      blocked = resolve
    })
    const ensureSessionCached = cache.ensureSessionCachedById.bind(cache)
    vi.spyOn(cache, 'ensureSessionCachedById').mockImplementation(async (sessionId) => {
      if (sessionId === 'blocker') {
        blocked()
        await waiting
      }
      return ensureSessionCached(sessionId)
    })

    const scan = coordinator.refreshNow()
    await reached
    await writeFile(transcriptPath, transcript)
    await coordinator.syncForRead('restored-session')
    onSessionSynced.mockClear()
    release()
    await scan

    expect(cache.index.getSession('restored-session')?.transcriptPath).toBe(transcriptPath)
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines WHERE session_id = ?').get('restored-session')).toEqual({ count: 1 })
    expect(onSessionSynced).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'restored-session', kind: 'removed' }))
    await coordinator.close()
    db.close()
  })

  it('reconciles deletion only after complete global discovery', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const projectDir = join(projectsRoot, '-repo-kept')
    const transcriptPath = join(projectDir, 'kept-session.jsonl')
    await mkdir(projectDir)
    await writeFile(transcriptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'kept-session', cwd: '/repo/kept', timestamp: '2026-01-01T00:00:00.000Z' }))
    await coordinator.refreshNow()
    await rm(transcriptPath)

    await coordinator.refreshProjectNow('/repo/kept')
    expect(cache.index.getSession('kept-session')).not.toBeNull()

    await rm(projectsRoot, { recursive: true })
    await expect(coordinator.refreshNow()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cache.index.getSession('kept-session')).not.toBeNull()

    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken-session.jsonl'), jsonl({ type: 'user', uuid: 'user-2', sessionId: 'broken-session', cwd: '/repo/broken', timestamp: '2026-01-01T00:00:00.000Z' }))
    vi.spyOn(cache, 'ensureSessionCachedById').mockRejectedValueOnce(new Error('sync failed'))
    await expect(coordinator.refreshNow()).rejects.toThrow('sync failed')
    expect(cache.index.getSession('kept-session')).not.toBeNull()

    await coordinator.close()
    db.close()
  })

  it.skipIf(process.getuid?.() === 0)('does not reconcile deletion when one project directory is unreadable', async () => {
    const { db, cache, projectsRoot, coordinator } = await setup()
    const keptDir = join(projectsRoot, 'kept-project')
    const blockedDir = join(projectsRoot, 'blocked-project')
    const keptPath = join(keptDir, 'kept-session.jsonl')
    await mkdir(keptDir)
    await mkdir(blockedDir)
    await writeFile(keptPath, jsonl({ type: 'user', uuid: 'user-1', sessionId: 'kept-session', cwd: '/repo/kept', timestamp: '2026-01-01T00:00:00.000Z' }))
    await coordinator.refreshNow()
    await rm(keptPath)
    await chmod(blockedDir, 0o000)

    await expect(coordinator.refreshNow()).rejects.toMatchObject({ code: 'EACCES' })

    await chmod(blockedDir, 0o755)
    expect(cache.index.getSession('kept-session')).not.toBeNull()
    await coordinator.close()
    db.close()
  })

  it('refreshes only the requested project', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z')
    const { db, cache, projectsRoot, coordinator } = await setup({ now: () => now })
    const firstDir = join(projectsRoot, '-repo-a')
    const secondDir = join(projectsRoot, '-repo-b')
    await Promise.all([mkdir(firstDir), mkdir(secondDir)])
    await writeFile(join(firstDir, 'session-a.jsonl'), jsonl({ type: 'user', uuid: 'user-a', sessionId: 'session-a', cwd: '/repo/a', timestamp: '2026-01-01T00:00:00.000Z' }))
    await writeFile(join(secondDir, 'session-b.jsonl'), jsonl({ type: 'user', uuid: 'user-b', sessionId: 'session-b', cwd: '/repo/b', timestamp: '2026-01-01T00:00:00.000Z' }))

    await coordinator.refreshProjectNow('/repo/a')

    expect(cache.index.getSession('session-a')?.currentCwd).toBe('/repo/a')
    expect(cache.index.getSession('session-b')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 1 })
    await coordinator.close()
    db.close()
  })

  it('ignores missing project transcript directories', async () => {
    const { db, coordinator } = await setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await coordinator.refreshProjectNow('/missing/repo')

    expect(consoleError).not.toHaveBeenCalled()
    await coordinator.close()
    db.close()
  })

  it('indexes and imports the append-only superset for duplicate sessions', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z')
    const { db, cache, projectsRoot, coordinator } = await setup({ now: () => now })
    const firstDir = join(projectsRoot, 'project-a')
    const secondDir = join(projectsRoot, 'project-b')
    await Promise.all([mkdir(firstDir), mkdir(secondDir)])
    const first = jsonl({ type: 'user', uuid: 'user-1', sessionId: 'old-session', cwd: '/repo/old-a', timestamp: '2025-01-01T00:00:00.000Z' })
    const second = `${first}${jsonl({ type: 'assistant', uuid: 'assistant-1', sessionId: 'old-session', cwd: '/repo/old-b', timestamp: '2025-01-01T00:00:01.000Z' })}`
    const firstPath = join(firstDir, 'old-session.jsonl')
    const secondPath = join(secondDir, 'old-session.jsonl')
    await Promise.all([writeFile(firstPath, first), writeFile(secondPath, second)])
    const old = new Date(now - 31 * 24 * 60 * 60_000)
    await Promise.all([utimes(firstPath, old, old), utimes(secondPath, old, old)])

    coordinator.start()

    await vi.waitFor(() => expect(cache.index.getSession('old-session')?.transcriptPath).toBe(secondPath))
    expect(cache.index.getSession('old-session')).toMatchObject({ currentCwd: '/repo/old-b', fileSize: Buffer.byteLength(second) })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_raw_transcript_lines').get()).toEqual({ count: 2 })
    await coordinator.close()
    db.close()
  })
})
