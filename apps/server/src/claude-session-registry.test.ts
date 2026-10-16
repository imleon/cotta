import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ClaudeSessionRegistry, createClaudeSessionRegistry } from './claude-session-registry.js'

const roots: string[] = []
const observers: ClaudeSessionRegistry[] = []

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const sessionsDir = join(root, 'sessions')
  await mkdir(sessionsDir)
  const observer = await createClaudeSessionRegistry({ sessionsDir, debounceMs: 10 })
  observers.push(observer)
  return { sessionsDir, observer }
}

describe('ClaudeSessionRegistry', () => {
  it('rejects startup when the sessions directory is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-session-registry-missing-'))
    roots.push(root)

    await expect(createClaudeSessionRegistry({ sessionsDir: join(root, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('loads initial metadata without replaying it as a change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-session-registry-initial-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    await mkdir(sessionsDir)
    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'idle' }))

    const observer = await createClaudeSessionRegistry({ sessionsDir, debounceMs: 10 })
    observers.push(observer)
    const changes: unknown[] = []
    observer.subscribe((change) => changes.push(change))

    expect(observer.cliSessionMetadata('session-1')).toEqual({ status: 'idle', hasRunningShell: false, kind: null, entrypoint: 'cli' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(changes).toEqual([])
  })

  it('notifies active and idle CLI session transitions', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-notify-')
    const sessionPath = join(sessionsDir, '999999999.json')
    const changes: Array<{ changedSessions: Array<{ sessionId: string; cwd: string | null }>; idleSessionIds: string[]; activeSessionIds: string[] }> = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'busy' }))
    await expect.poll(() => changes.length).toBe(1)
    expect(changes[0]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: null }], idleSessionIds: [], activeSessionIds: ['session-1'] })

    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'idle' }))
    await expect.poll(() => changes.length).toBe(2)
    expect(changes[1]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: null }], idleSessionIds: ['session-1'], activeSessionIds: [] })
  })

  it('notifies changes for non-CLI session files', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-sdk-')
    const changes: Array<{ changedSessions: Array<{ sessionId: string; cwd: string | null }>; idleSessionIds: string[]; activeSessionIds: string[] }> = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'session-1', entrypoint: 'sdk-ts', cwd: '/repo/a' }))
    await expect.poll(() => changes.length).toBe(1)
    expect(changes[0]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: '/repo/a' }], idleSessionIds: [], activeSessionIds: [] })
  })

  it('treats background daemon kinds as active even when idle', async () => {
    for (const kind of ['daemon', 'daemon-worker']) {
      const { sessionsDir, observer } = await setup(`cotta-session-registry-${kind}-`)
      await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', kind, status: 'idle' }))
      await expect.poll(() => observer.cliSessionMetadata('session-1')?.kind).toBe(kind)
    }
  })

  it('reports CLI background metadata even when idle', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-bg-')
    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', kind: 'bg', status: 'idle' }))
    await expect.poll(() => observer.cliSessionMetadata('session-1')).toEqual({ status: 'idle', hasRunningShell: false, kind: 'bg', entrypoint: 'cli' })
  })

  it('treats CLI shell as idle metadata with a shell tag', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-shell-')
    const sessionPath = join(sessionsDir, '999999999.json')
    const changes: Array<{ changedSessions: Array<{ sessionId: string; cwd: string | null }>; idleSessionIds: string[]; activeSessionIds: string[] }> = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'busy' }))
    await expect.poll(() => changes.length).toBe(1)
    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'shell' }))
    await expect.poll(() => changes.length).toBe(2)
    expect(changes[1]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: null }], idleSessionIds: ['session-1'], activeSessionIds: [] })
    expect(observer.cliSessionMetadata('session-1')).toEqual({ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' })
  })

  it('reports CLI idle immediately after active status clears', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-idle-')
    const sessionPath = join(sessionsDir, '999999999.json')
    const changes: Array<{ changedSessions: Array<{ sessionId: string; cwd: string | null }>; idleSessionIds: string[]; activeSessionIds: string[] }> = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'busy' }))
    await expect.poll(() => changes.length).toBe(1)
    expect(observer.cliSessionMetadata('session-1')).toEqual({ status: 'busy', hasRunningShell: false, kind: null, entrypoint: 'cli' })

    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', entrypoint: 'cli', status: 'idle' }))
    await expect.poll(() => changes.length).toBe(2)
    expect(changes[1]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: null }], idleSessionIds: ['session-1'], activeSessionIds: [] })
  })

  it('stops notifying after close', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-close-')
    const changes: unknown[] = []
    observer.subscribe((change) => changes.push(change))
    await observer.close()
    observers.splice(observers.indexOf(observer), 1)

    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ sessionId: 'after-close' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(changes).toEqual([])
  })
})
