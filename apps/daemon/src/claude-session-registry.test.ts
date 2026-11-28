import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fsSync from 'node:fs'
import { renameSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionRegistry, type ClaudeSessionRegistryChange, type ClaudeSessionRegistryOptions, createClaudeSessionRegistry } from './claude-session-registry.js'
import { LiveTurnManager, SessionExternallyOwnedError } from './live-turn-manager.js'

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()) }))
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs/promises')>()) }))

const roots: string[] = []
const observers: ClaudeSessionRegistry[] = []

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()))
  vi.restoreAllMocks()
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

const deadProcess = () => {
  throw Object.assign(new Error('process absent'), { code: 'ESRCH' })
}
const stalePayload = { pid: 12345, sessionId: 'stale', entrypoint: 'cotta', status: 'busy', cwd: '/repo' }

async function staleFixture(options: ClaudeSessionRegistryOptions = {}, records: Record<string, unknown> = { '12345.json': stalePayload }) {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'cotta-session-registry-stale-'))
  roots.push(sessionsDir)
  for (const [name, payload] of Object.entries(records)) await writeFile(join(sessionsDir, name), typeof payload === 'string' ? payload : JSON.stringify(payload))
  let now = 0
  const observer = await createClaudeSessionRegistry({
    sessionsDir,
    debounceMs: 60_000,
    checkProcess: deadProcess,
    now: () => now,
    ...options,
  })
  observers.push(observer)
  return {
    sessionsDir,
    observer,
    advance: async (milliseconds = 30_000) => {
      now += milliseconds
      await observer.revalidateIfDue()
    },
  }
}

describe('ClaudeSessionRegistry stale cotta records', () => {
  it('cleans startup records without changing other assets and stays clean after restart', async () => {
    const { sessionsDir, observer } = await staleFixture({}, { '12345.json': stalePayload, 'transcript.jsonl': 'unchanged', '12345.sock': 'socket' })
    expect(observer.cliSessionMetadata('stale')).toBeNull()
    await expect(readFile(join(sessionsDir, '12345.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(sessionsDir, 'transcript.jsonl'), 'utf8')).toBe('unchanged')
    expect(await readFile(join(sessionsDir, '12345.sock'), 'utf8')).toBe('socket')
    await observer.close()
    const restarted = await createClaudeSessionRegistry({ sessionsDir })
    observers.push(restarted)
    expect(restarted.cliSessionMetadata('stale')).toBeNull()
  })

  it.each([
    ['cli', { ...stalePayload, entrypoint: 'cli' }, '12345.json'],
    ['sdk-ts', { ...stalePayload, entrypoint: 'sdk-ts' }, '12345.json'],
    ['sdk-cli', { ...stalePayload, entrypoint: 'sdk-cli' }, '12345.json'],
    ['unknown source', { ...stalePayload, entrypoint: 'unknown' }, '12345.json'],
    ['missing source', { ...stalePayload, entrypoint: undefined }, '12345.json'],
    ['pid mismatch', { ...stalePayload, pid: 12346 }, '12345.json'],
    ['string pid', { ...stalePayload, pid: '12345' }, '12345.json'],
    ['missing pid', { ...stalePayload, pid: undefined }, '12345.json'],
    ['leading zero', stalePayload, '012345.json'],
    ['zero', { ...stalePayload, pid: 0 }, '0.json'],
    ['init', { ...stalePayload, pid: 1 }, '1.json'],
    ['unsafe pid', { ...stalePayload, pid: 9007199254740992 }, '9007199254740992.json'],
    ['negative pid', { ...stalePayload, pid: -2 }, '-2.json'],
    ['invalid json', '{', '12345.json'],
    ['array json', [stalePayload], '12345.json'],
  ])('retains %s without probing or unlinking', async (_label, payload, name) => {
    const checkProcess = vi.fn(deadProcess)
    const { sessionsDir } = await staleFixture({ checkProcess }, { [name as string]: payload })
    await expect(readFile(join(sessionsDir, name as string))).resolves.toBeInstanceOf(Buffer)
    expect(checkProcess).not.toHaveBeenCalled()
  })

  it.each(['alive', 'EPERM', 'EIO'])('retains another cotta process when the PID probe is %s regardless of procStart', async (result) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { observer, sessionsDir } = await staleFixture(
      {
        checkProcess: () => {
          if (result !== 'alive') throw Object.assign(new Error(result), { code: result })
        },
      },
      { '12345.json': { ...stalePayload, procStart: 'old-process' } },
    )
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    await expect(readFile(join(sessionsDir, '12345.json'))).resolves.toBeInstanceOf(Buffer)
    expect(log).toHaveBeenCalledTimes(result === 'alive' ? 0 : 1)
  })

  it('revalidates unchanged files at 30 seconds and emits the existing idle transition once', async () => {
    let alive = true
    const checkProcess = vi.fn(() => {
      if (!alive) deadProcess()
    })
    const { observer, sessionsDir, advance } = await staleFixture({ checkProcess })
    const changes: ClaudeSessionRegistryChange[] = []
    observer.subscribe((change) => changes.push(change))
    alive = false
    await advance(29_999)
    expect(checkProcess).toHaveBeenCalledTimes(1)
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    await advance(1)
    expect(checkProcess).toHaveBeenCalledTimes(3)
    expect(observer.cliSessionMetadata('stale')).toBeNull()
    expect(changes).toEqual([{ changedSessions: [{ sessionId: 'stale', cwd: '/repo' }], idleSessionIds: ['stale'], activeSessionIds: [] }])
    await expect(readFile(join(sessionsDir, '12345.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await advance()
    expect(changes).toHaveLength(1)
    await observer.close()
    const readdir = vi.spyOn(fs, 'readdir')
    await advance()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('also cleans on watch scans, without waiting for periodic revalidation', async () => {
    const { sessionsDir, observer } = await setup('cotta-session-registry-watch-stale-')
    await writeFile(join(sessionsDir, '999999999.json'), JSON.stringify({ ...stalePayload, pid: 999999999 }))
    await expect.poll(async () => fs.readdir(sessionsDir)).toEqual([])
    expect(observer.cliSessionMetadata('stale')).toBeNull()
  })

  it('revalidates immediately when the wall clock steps backwards', async () => {
    let alive = true
    const checkProcess = vi.fn(() => {
      if (!alive) deadProcess()
    })
    const { observer, advance } = await staleFixture({ checkProcess })
    alive = false
    await advance(-60_000)
    expect(observer.cliSessionMetadata('stale')).toBeNull()
  })

  it('does not use parse-fallback payload as deletion authority', async () => {
    let alive = true
    const checkProcess = vi.fn(() => {
      if (!alive) deadProcess()
    })
    const { observer, sessionsDir, advance } = await staleFixture({ checkProcess })
    await writeFile(join(sessionsDir, '12345.json'), '{')
    alive = false
    await advance()
    expect(checkProcess).toHaveBeenCalledTimes(1)
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    expect(await readFile(join(sessionsDir, '12345.json'), 'utf8')).toBe('{')
  })

  it('does not follow or remove symlinks', async () => {
    const { observer, sessionsDir, advance } = await staleFixture({}, {})
    const target = join(sessionsDir, 'target')
    await writeFile(target, JSON.stringify(stalePayload))
    await symlink(target, join(sessionsDir, '12345.json'))
    await advance()
    expect(await readlink(join(sessionsDir, '12345.json'))).toBe(target)
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(stalePayload))
    expect(observer.cliSessionMetadata('stale')).toBeNull()
  })

  it.each(['replace', 'rewrite', 'symlink'])('cancels deletion and rereads a concurrent %s', async (race) => {
    let mutate: (() => void) | undefined
    let alive = true
    const checkProcess = vi.fn(() => {
      mutate?.()
      if (!alive) deadProcess()
    })
    const { observer, sessionsDir, advance } = await staleFixture({ checkProcess })
    // Start from a live snapshot, then inject a race after the first dead-PID check.
    const path = join(sessionsDir, '12345.json')
    const replacement = JSON.stringify({ ...stalePayload, entrypoint: 'cli', sessionId: 'replacement' })
    const target = join(sessionsDir, 'replacement')
    await writeFile(target, replacement)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    alive = false
    mutate = () => {
      mutate = undefined
      if (race === 'rewrite') writeFileSync(path, replacement)
      else {
        renameSync(path, join(sessionsDir, 'original'))
        if (race === 'symlink') symlinkSync(target, path)
        else renameSync(target, path)
      }
    }
    await advance()
    expect(await readFile(path, 'utf8')).toBe(replacement)
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    if (race === 'symlink') {
      expect(await readlink(path)).toBe(target)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('stale verification failed'), expect.objectContaining({ code: 'ELOOP' }))
    }
    await advance()
    if (race === 'symlink') {
      expect(observer.cliSessionMetadata('stale')).toBeNull()
      expect(observer.cliSessionMetadata('replacement')).toBeNull()
    } else {
      expect(observer.cliSessionMetadata('stale')).toBeNull()
      expect(observer.cliSessionMetadata('replacement')).toEqual({ status: 'busy', hasRunningShell: false, kind: null, entrypoint: 'cli' })
    }
  })

  it('cancels deletion when the independent handle read races with an in-place rewrite', async () => {
    let alive = true
    const { observer, sessionsDir, advance } = await staleFixture({
      checkProcess: () => {
        if (!alive) deadProcess()
      },
    })
    const path = join(sessionsDir, '12345.json')
    const replacement = JSON.stringify({ ...stalePayload, entrypoint: 'cli' })
    const originalOpen = fs.open
    let opens = 0
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === path && ++opens === 2) {
        const originalRead = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs) => {
          const content = await originalRead(...readArgs)
          await writeFile(path, replacement)
          return content
        })
      }
      return handle
    })
    alive = false
    await advance()
    expect(opens).toBe(2)
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    expect(await readFile(path, 'utf8')).toBe(replacement)
    await advance()
    expect(observer.cliSessionMetadata('stale')?.entrypoint).toBe('cli')
  })

  it('retains occupancy on verification errors and retries at the next maintenance window', async () => {
    let alive = true
    const { observer, sessionsDir, advance } = await staleFixture({
      checkProcess: () => {
        if (!alive) deadProcess()
      },
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const originalOpen = fs.open
    let opens = 0
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (++opens === 2) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return originalOpen(...args)
    })
    alive = false
    await advance()
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stale verification failed'), expect.objectContaining({ code: 'EACCES' }))
    await expect(readFile(join(sessionsDir, '12345.json'))).resolves.toBeInstanceOf(Buffer)
    open.mockRestore()
    await advance()
    expect(observer.cliSessionMetadata('stale')).toBeNull()
  })

  it('treats a record disappearing before the independent reopen as absent', async () => {
    let alive = true
    const { observer, sessionsDir, advance } = await staleFixture({
      checkProcess: () => {
        if (!alive) deadProcess()
      },
    })
    const originalOpen = fs.open
    let opens = 0
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (++opens === 2) await rm(join(sessionsDir, '12345.json'))
      return originalOpen(...args)
    })
    alive = false
    await advance()
    expect(observer.cliSessionMetadata('stale')).toBeNull()
  })

  it('retains the snapshot when a PID reappears before unlink', async () => {
    const checkProcess = vi
      .fn()
      .mockImplementationOnce(deadProcess)
      .mockImplementation(() => {})
    const { observer, sessionsDir, advance } = await staleFixture({ checkProcess })
    expect(checkProcess).toHaveBeenCalledTimes(2)
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    await expect(readFile(join(sessionsDir, '12345.json'))).resolves.toBeInstanceOf(Buffer)
    await advance()
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
  })

  it('excludes confirmed invalid metadata on unlink failure, logs details, retries without a dead-PID cache', async () => {
    const unlink = vi.spyOn(fsSync, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let alive = false
    const checkProcess = vi.fn(() => {
      if (!alive) deadProcess()
    })
    const { observer, sessionsDir, advance } = await staleFixture({ checkProcess })
    expect(observer.cliSessionMetadata('stale')).toBeNull()
    expect(log).toHaveBeenCalledWith(`claude-session-registry:stale unlink failed path=${join(sessionsDir, '12345.json')} pid=12345 code=EACCES`, expect.any(Error))
    await expect(readFile(join(sessionsDir, '12345.json'))).resolves.toBeInstanceOf(Buffer)
    alive = true
    await advance()
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    expect(unlink).toHaveBeenCalledTimes(1)
    alive = false
    unlink.mockRestore()
    await advance()
    expect(observer.cliSessionMetadata('stale')).toBeNull()
    await expect(readFile(join(sessionsDir, '12345.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats ENOENT during unlink as already removed without logging failure', async () => {
    const originalUnlinkSync = fsSync.unlinkSync
    vi.spyOn(fsSync, 'unlinkSync').mockImplementation((path) => {
      originalUnlinkSync(path)
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { observer } = await staleFixture()
    expect(observer.cliSessionMetadata('stale')).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('preserves another valid PID for the same session', async () => {
    const { observer } = await staleFixture(
      {
        checkProcess: (pid) => {
          if (pid === 12345) deadProcess()
        },
      },
      {
        '12345.json': { ...stalePayload, updatedAt: 200 },
        '12346.json': { ...stalePayload, pid: 12346, status: 'waiting', updatedAt: 100 },
      },
    )
    expect(observer.cliSessionMetadata('stale')?.status).toBe('waiting')
  })

  it('coalesces slow periodic scans without adding timers or accumulating ticks', async () => {
    const { observer, advance } = await staleFixture({}, {})
    const originalReaddir = fs.readdir
    let release!: () => void
    const readdir = vi.spyOn(fs, 'readdir').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => {
            void originalReaddir(...args).then(resolve, reject)
          }
        }) as ReturnType<typeof fs.readdir>,
    )
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    const first = advance()
    await Promise.resolve()
    const ticks = Array.from({ length: 100 }, () => advance())
    release()
    await Promise.all([first, ...ticks])
    expect(readdir).toHaveBeenCalledTimes(1)
    expect(timeout).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
    await observer.close()
    await advance()
    expect(readdir).toHaveBeenCalledTimes(1)
  })

  it('recovers from scan failure on a later gated scan', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { observer, advance } = await staleFixture({ checkProcess: () => {} })
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('probe unavailable'))
    await advance()
    expect(log).toHaveBeenCalledWith('claude-session-registry:scan failed', expect.any(Error))
    expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
    await advance()
    expect(readdir).toHaveBeenCalledTimes(2)
  })

  it('closes the watcher and keeps close() clean when initial readSnapshots fails', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'cotta-session-registry-start-fail-'))
    roots.push(sessionsDir)
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const observer = new ClaudeSessionRegistry({ sessionsDir, debounceMs: 60_000 })
    observers.push(observer)
    await expect(observer.start()).rejects.toMatchObject({ code: 'EACCES' })
    await expect(observer.close()).resolves.toBeUndefined()
  })

  it('verifies a real controlled child exiting without touching actual Claude sessions', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    await once(child, 'spawn')
    const pid = child.pid!
    try {
      const { observer, sessionsDir, advance } = await staleFixture(
        { checkProcess: undefined },
        {
          [`${pid}.json`]: { ...stalePayload, pid },
          'transcript.jsonl': 'preserved transcript',
        },
      )
      expect(observer.cliSessionMetadata('stale')?.status).toBe('busy')
      const exited = once(child, 'exit')
      child.stdin.end()
      await exited
      await advance()
      expect(observer.cliSessionMetadata('stale')).toBeNull()
      await expect(readFile(join(sessionsDir, `${pid}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(sessionsDir, 'transcript.jsonl'), 'utf8')).toBe('preserved transcript')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
  })
})

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
