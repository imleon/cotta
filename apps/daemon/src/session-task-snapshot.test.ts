import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { readSessionTaskSnapshot } from './session-task-snapshot.js'
import { TranscriptIndexStore } from './transcript-index-store.js'

const roots: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readSessionTaskSnapshot', () => {
  it('reads raw task json files and strips unused fields while preserving active labels', async () => {
    const root = await tempRoot('cotta-tasks-')
    process.env.CLAUDE_CONFIG_DIR = root
    const dir = join(root, 'tasks', 'session-1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.highwatermark'), '2')
    await writeFile(join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'second', description: 'd2', status: 'pending', blocks: [], blockedBy: ['1'], metadata: { custom: true } }))
    await writeFile(
      join(dir, '1.json'),
      JSON.stringify({ id: '1', subject: 'first', description: 'd1', activeForm: 'doing', status: 'in_progress', blocks: ['2'], blockedBy: [], owner: 'agent', extra: 'kept' }),
    )

    const result = await readSessionTaskSnapshot('session-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.tasks.map((task) => task.id)).toEqual(['1', '2'])
    expect(result.snapshot.tasks[0]).toEqual({ id: '1', subject: 'first', activeForm: 'doing', status: 'in_progress', blockedBy: [] })
    expect(result.snapshot.tasks[1]).toEqual({ id: '2', subject: 'second', status: 'pending', blockedBy: ['1'] })
    expect(result.snapshot.version).toMatch(/^task-v1:[A-Za-z0-9_-]+$/)
  })

  it('changes version when equal-size task content is rewritten with the same mtime', async () => {
    const root = await tempRoot('cotta-tasks-')
    process.env.CLAUDE_CONFIG_DIR = root
    const dir = join(root, 'tasks', 'session-1')
    const path = join(dir, '1.json')
    const mtime = new Date('2026-01-01T00:00:00.000Z')
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify({ id: '1', subject: 'old', status: 'pending', blockedBy: [] }))
    await utimes(path, mtime, mtime)
    const first = await readSessionTaskSnapshot('session-1')

    await writeFile(path, JSON.stringify({ id: '1', subject: 'new', status: 'pending', blockedBy: [] }))
    await utimes(path, mtime, mtime)
    const second = await readSessionTaskSnapshot('session-1')

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    if (!first.ok || !second.ok) return
    expect(second.snapshot.tasks[0]?.subject).toBe('new')
    expect(second.snapshot.version).not.toBe(first.snapshot.version)
  })

  it('returns a distinct empty snapshot when the task directory is missing', async () => {
    const root = await tempRoot('cotta-tasks-')
    process.env.CLAUDE_CONFIG_DIR = root

    const result = await readSessionTaskSnapshot('missing-session')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.tasks).toEqual([])
    expect(result.snapshot.version).toBe('missing')
  })

  it('returns a different version for an existing empty task directory', async () => {
    const root = await tempRoot('cotta-tasks-')
    process.env.CLAUDE_CONFIG_DIR = root
    await mkdir(join(root, 'tasks', 'session-1'), { recursive: true })

    const result = await readSessionTaskSnapshot('session-1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.tasks).toEqual([])
    expect(result.snapshot.version).toMatch(/^task-v1:[A-Za-z0-9_-]+$/)
  })
})

describe('TranscriptIndexStore task snapshot', () => {
  it('treats malformed persisted snapshots as unknown', async () => {
    const root = await tempRoot('cotta-task-store-')
    const db = createCottaDatabase(join(root, 'cotta.sqlite'))
    try {
      const store = new TranscriptIndexStore(db)
      store.upsertSession({ sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl', fileSize: 1, fileMtimeMs: 1, currentCwd: '/tmp/project' })
      db.prepare('UPDATE session_index SET task_snapshot_json = ? WHERE session_id = ?').run(JSON.stringify([{ invalid: true }]), 'session-1')

      expect(store.getSession('session-1')?.taskSnapshot).toBeNull()
    } finally {
      db.close()
    }
  })

  it('updates only when the snapshot version changes', async () => {
    const root = await tempRoot('cotta-task-store-')
    const db = createCottaDatabase(join(root, 'cotta.sqlite'))
    try {
      const store = new TranscriptIndexStore(db)
      store.upsertSession({ sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl', fileSize: 1, fileMtimeMs: 1, currentCwd: '/tmp/project' })

      expect(store.updateTaskSnapshot('session-1', { version: '1:10:20', tasks: [{ id: '1', subject: 'task', status: 'pending', blockedBy: [] }] })).toBe(true)
      expect(store.updateTaskSnapshot('session-1', { version: '1:10:20', tasks: [] })).toBe(false)
      expect(store.getSession('session-1')?.taskSnapshot).toEqual([{ id: '1', subject: 'task', status: 'pending', blockedBy: [] }])
    } finally {
      db.close()
    }
  })
})
