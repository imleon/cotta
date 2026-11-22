import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ClaudeSessionRegistry, type ClaudeSessionRegistryChange, type ClaudeSessionRegistryOptions, createClaudeSessionRegistry } from './claude-session-registry.js'
import { LiveTurnManager, SessionExternallyOwnedError } from './live-turn-manager.js'

const roots: string[] = []
const observers: ClaudeSessionRegistry[] = []

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(prefix: string, options: Pick<ClaudeSessionRegistryOptions, 'isOwnedProcess'> = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const sessionsDir = join(root, 'sessions')
  await mkdir(sessionsDir)
  const observer = await createClaudeSessionRegistry({ sessionsDir, debounceMs: 10, ...options })
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

  it('excludes owned cotta PIDs but retains another process with the same entrypoint and session', async () => {
    const entrypoint = 'cotta'
    const owned = new Set([101])
    const { sessionsDir, observer } = await setup('cotta-session-registry-owned-', { isOwnedProcess: (pid) => owned.has(pid) })
    const changes: ClaudeSessionRegistryChange[] = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(join(sessionsDir, '101.json'), JSON.stringify({ sessionId: 'session-1', entrypoint, status: 'busy', updatedAt: 200 }))
    await expect.poll(() => changes.length).toBe(1)
    expect(observer.cliSessionMetadata('session-1')).toBeNull()
    expect(changes[0]?.activeSessionIds).toEqual([])

    await writeFile(join(sessionsDir, '102.json'), JSON.stringify({ sessionId: 'session-1', entrypoint, status: 'waiting', updatedAt: 100 }))
    await expect.poll(() => observer.cliSessionMetadata('session-1')).toEqual({ status: 'waiting', hasRunningShell: false, kind: null, entrypoint })
    expect(changes.at(-1)?.activeSessionIds).toEqual(['session-1'])

    await rm(join(sessionsDir, '102.json'))
    await expect.poll(() => observer.cliSessionMetadata('session-1')).toBeNull()
    expect(changes.at(-1)?.idleSessionIds).toEqual(['session-1'])

    await rm(join(sessionsDir, '101.json'))
    await expect.poll(() => changes.length).toBe(4)
    expect(changes.at(-1)?.idleSessionIds).toEqual([])
    owned.delete(101)
    await writeFile(join(sessionsDir, '101.json'), JSON.stringify({ sessionId: 'session-2', entrypoint: 'sdk-cli', status: 'busy' }))
    await expect.poll(() => observer.cliSessionMetadata('session-2')?.entrypoint).toBe('sdk-cli')
    expect(changes.at(-1)?.activeSessionIds).toEqual(['session-2'])
  })

  it('keeps an observed owned session file excluded after the owned PID exits before deletion is scanned', async () => {
    const owned = new Set([101])
    const { sessionsDir, observer } = await setup('cotta-session-registry-owned-exit-', { isOwnedProcess: (pid) => owned.has(pid) })
    const changes: ClaudeSessionRegistryChange[] = []
    observer.subscribe((change) => changes.push(change))

    await writeFile(join(sessionsDir, '101.json'), JSON.stringify({ sessionId: 'session-1', entrypoint: 'cotta', status: 'busy' }))
    await expect.poll(() => changes.length).toBe(1)
    expect(observer.cliSessionMetadata('session-1')).toBeNull()

    // Process exits and drops from ownedProcesses before the session file is removed or rescanned.
    owned.delete(101)
    expect(observer.cliSessionMetadata('session-1')).toBeNull()

    await rm(join(sessionsDir, '101.json'))
    await expect.poll(() => changes.length).toBe(2)
    expect(changes[1]?.idleSessionIds).toEqual([])
    expect(observer.cliSessionMetadata('session-1')).toBeNull()
  })

  it('excludes owned PIDs from the initial registry snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-session-registry-owned-initial-'))
    roots.push(root)
    await writeFile(join(root, '101.json'), JSON.stringify({ sessionId: 'owned', entrypoint: 'cotta', status: 'busy' }))
    await writeFile(join(root, '102.json'), JSON.stringify({ sessionId: 'external', entrypoint: 'sdk-cli', status: 'idle' }))
    const observer = await createClaudeSessionRegistry({ sessionsDir: root, isOwnedProcess: (pid) => pid === 101 })
    observers.push(observer)
    expect(observer.cliSessionMetadata('owned')).toBeNull()
    expect(observer.cliSessionMetadata('external')).toEqual({ status: 'idle', hasRunningShell: false, kind: null, entrypoint: 'sdk-cli' })
  })

  it.each(['cotta', 'cli', 'sdk-ts', 'sdk-cli', 'unknown', '', undefined].flatMap((entrypoint) => [false, true].map((owned) => ({ entrypoint, owned }))))(
    'classifies entrypoint=$entrypoint owned=$owned without losing the original source',
    async ({ entrypoint, owned }) => {
      const { sessionsDir, observer } = await setup('cotta-session-registry-sources-', { isOwnedProcess: () => owned })
      const changes: ClaudeSessionRegistryChange[] = []
      observer.subscribe((change) => changes.push(change))
      await writeFile(join(sessionsDir, '101.json'), JSON.stringify({ sessionId: 'session-1', entrypoint, status: 'busy' }))
      await expect.poll(() => changes.length).toBe(1)

      const excluded = entrypoint === 'cotta' && owned
      expect(observer.cliSessionMetadata('session-1')).toEqual(excluded ? null : { status: 'busy', hasRunningShell: false, kind: null, entrypoint: entrypoint ?? null })
      expect(changes[0]?.activeSessionIds).toEqual(excluded ? [] : ['session-1'])
    },
  )

  it.each(['idle', 'removal'])('notifies a missing-source active session becoming %s', async (transition) => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-missing-source-')
    const sessionPath = join(sessionsDir, '101.json')
    const changes: ClaudeSessionRegistryChange[] = []
    observer.subscribe((change) => changes.push(change))
    await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', status: 'busy', cwd: '/repo' }))
    await expect.poll(() => changes.length).toBe(1)
    expect(changes[0]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: '/repo' }], activeSessionIds: ['session-1'], idleSessionIds: [] })

    if (transition === 'idle') await writeFile(sessionPath, JSON.stringify({ sessionId: 'session-1', status: 'idle', cwd: '/repo' }))
    else await rm(sessionPath)
    await expect.poll(() => changes.length).toBe(2)
    expect(changes[1]).toEqual({ changedSessions: [{ sessionId: 'session-1', cwd: '/repo' }], activeSessionIds: [], idleSessionIds: ['session-1'] })
    expect(observer.cliSessionMetadata('session-1')).toEqual(transition === 'idle' ? { status: 'idle', hasRunningShell: false, kind: null, entrypoint: null } : null)
  })

  it.each(['unknown', undefined])('blocks turn submission using real registry ownership for source %s', async (entrypoint) => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-submit-')
    const changes: ClaudeSessionRegistryChange[] = []
    observer.subscribe((change) => changes.push(change))
    await writeFile(join(sessionsDir, '101.json'), JSON.stringify({ sessionId: 'session-1', entrypoint, status: 'busy' }))
    await expect.poll(() => changes.length).toBe(1)
    const providerEnv = vi.fn().mockRejectedValue(new Error('Runtime must not be created'))
    const manager = new LiveTurnManager(undefined, undefined, undefined, undefined, (sessionId) => observer.cliSessionMetadata(sessionId), undefined, providerEnv)
    try {
      await expect(
        manager.startTurn({ projectId: Buffer.from(sessionsDir).toString('base64url'), sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' }),
      ).rejects.toBeInstanceOf(SessionExternallyOwnedError)
      expect(providerEnv).not.toHaveBeenCalled()
      expect(manager.hasRuntime('session-1')).toBe(false)
    } finally {
      manager.closeAll()
    }
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
