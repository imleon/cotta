import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionRegistryObserver, type SessionRegistryObserver } from './session-registry-observer.js'

const roots: string[] = []
const observers: SessionRegistryObserver[] = []

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function processStart(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const value = await readFile(`/proc/${process.pid}/stat`, 'utf8')
  const close = value.lastIndexOf(')')
  return close >= 0 ? value.slice(close + 2).split(' ')[19] : undefined
}

function rows(dbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('SELECT * FROM session_registry_observations ORDER BY id').all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

describe('SessionRegistryObserver', () => {
  it('removes duplicate content once and preserves the earliest row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-session-observer-cleanup-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const dbPath = join(root, 'observations.sqlite')
    await mkdir(sessionsDir)
    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'session-1' }))

    const first = await createSessionRegistryObserver({ sessionsDir, dbPath, debounceMs: 10 })
    await first.close()
    const db = new DatabaseSync(dbPath)
    const earliestId = Number((db.prepare('SELECT id FROM session_registry_observations').get() as { id: number }).id)
    db.exec(`
      INSERT INTO session_registry_observations (
        event_kind, observed_at_ms, file_name, file_path, file_pid, file_mtime_ms, file_size_bytes, raw_json
      ) SELECT event_kind, observed_at_ms + 1, file_name, file_path, file_pid, file_mtime_ms, file_size_bytes, raw_json
      FROM session_registry_observations;
      PRAGMA user_version = 0;
    `)
    db.close()

    const restarted = await createSessionRegistryObserver({ sessionsDir, dbPath, debounceMs: 10 })
    observers.push(restarted)
    expect(rows(dbPath)).toHaveLength(1)
    expect(rows(dbPath)[0]?.id).toBe(earliestId)
  })

  it('appends complete snapshots and every observed file state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-session-observer-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const dbPath = join(root, 'observations.sqlite')
    await mkdir(sessionsDir)

    const procStart = await processStart()
    const initial = {
      pid: process.pid,
      procStart,
      sessionId: 'session-1',
      cwd: '/repo/cotta',
      startedAt: 100,
      updatedAt: 200,
      statusUpdatedAt: 200,
      version: '2.1.220',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'cotta',
      nameSource: 'derived',
      status: 'idle',
      waitingFor: 'user',
      tempo: 'idle',
      state: 'ready',
      detail: 'waiting',
      needs: 'prompt',
      agent: 'claude',
      messagingSocketPath: '/tmp/claude.sock',
      jobId: 'job-1',
      parkedJobId: 'job-0',
      bridgeSessionId: 'bridge-1',
      logPath: '/tmp/claude.log',
      tmux: 'claude-cotta',
      futureField: { preserved: true },
    }
    const firstRaw = JSON.stringify(initial)
    await writeFile(join(sessionsDir, `${process.pid}.json`), firstRaw)

    const observer = await createSessionRegistryObserver({ sessionsDir, dbPath, debounceMs: 10 })
    observers.push(observer)

    let observed = rows(dbPath)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      event_kind: 'snapshot',
      file_pid: process.pid,
      payload_pid: process.pid,
      session_id: 'session-1',
      cwd: '/repo/cotta',
      started_at_ms: 100,
      updated_at_ms: 200,
      status_updated_at_ms: 200,
      version: '2.1.220',
      peer_protocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'cotta',
      name_source: 'derived',
      status: 'idle',
      waiting_for: 'user',
      tempo: 'idle',
      state: 'ready',
      detail: 'waiting',
      needs: 'prompt',
      agent: 'claude',
      messaging_socket_path: '/tmp/claude.sock',
      job_id: 'job-1',
      parked_job_id: 'job-0',
      bridge_session_id: 'bridge-1',
      log_path: '/tmp/claude.log',
      tmux: 'claude-cotta',
      pid_alive: 1,
      proc_start_matches: process.platform === 'linux' ? 1 : null,
      raw_json: firstRaw,
      parse_error: null,
    })

    await observer.close()
    observers.splice(observers.indexOf(observer), 1)
    const restarted = await createSessionRegistryObserver({ sessionsDir, dbPath, debounceMs: 10 })
    observers.push(restarted)
    expect(rows(dbPath)).toHaveLength(1)

    const createdRaw = JSON.stringify({ pid: 999_999_999, sessionId: 'session-2', cwd: '/repo/other', kind: 'bg', status: 'busy', tempo: 'active' })
    const createdPath = join(sessionsDir, '999999999.json')
    await writeFile(createdPath, createdRaw)
    await expect.poll(() => rows(dbPath).length).toBe(2)
    expect(rows(dbPath)[1]).toMatchObject({ event_kind: 'create', session_id: 'session-2', kind: 'bg', status: 'busy', tempo: 'active', pid_alive: 0, raw_json: createdRaw })

    const changedRaw = JSON.stringify({ pid: 999_999_999, sessionId: 'session-2', cwd: '/repo/other', kind: 'bg', status: 'waiting', tempo: 'blocked', waitingFor: 'permission' })
    await writeFile(createdPath, changedRaw)
    await expect.poll(() => rows(dbPath).length).toBe(3)
    expect(rows(dbPath)[2]).toMatchObject({ event_kind: 'change', session_id: 'session-2', status: 'waiting', tempo: 'blocked', waiting_for: 'permission', raw_json: changedRaw })

    const malformed = '{"pid":999999999,"sessionId":"session-2"'
    await writeFile(createdPath, malformed)
    await expect.poll(() => rows(dbPath).length).toBe(4)
    observed = rows(dbPath)
    expect(observed[3]).toMatchObject({ event_kind: 'change', raw_json: malformed })
    expect(observed[3]?.parse_error).toEqual(expect.any(String))

    await unlink(createdPath)
    await expect.poll(() => rows(dbPath).length).toBe(5)
    expect(rows(dbPath)[4]).toMatchObject({ event_kind: 'delete', raw_json: malformed, pid_alive: 0 })

    await restarted.close()
    observers.splice(observers.indexOf(restarted), 1)
    await writeFile(join(sessionsDir, '888888888.json'), JSON.stringify({ sessionId: 'after-close' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rows(dbPath)).toHaveLength(5)
  })
})
