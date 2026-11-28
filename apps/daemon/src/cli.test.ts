import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNpmGlobalInstall, main } from './cli.js'
import { acquireServerLock, assertNoLegacyDatabase, cottaHome, isServerLocked, lockFilePath, pidFilePath, readPidRecord, releaseServerLock, serverUrl, writePidRecord } from './cotta-home.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cotta-cli-'))
  vi.stubEnv('COTTA_DB_PATH', join(dir, 'cotta.sqlite'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Spawns a separate process holding the server lock, as a running Cotta would. */
async function holdLock({ ignoreSigterm = false } = {}): Promise<{ pid: number; kill: () => Promise<void> }> {
  const script = `const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(lockFilePath())});d.exec('BEGIN EXCLUSIVE');${ignoreSigterm ? "process.on('SIGTERM',()=>{});" : ''}console.log('held');setInterval(()=>{},1e6)`
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
  return {
    pid: child.pid as number,
    kill: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      }),
  }
}

describe('single-instance lock', () => {
  it('treats the lock, not a live pid, as the source of truth, and status leaves the pidfile alone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // A live but unrelated pid (this test process) must not read as a running Cotta.
    writePidRecord({ pid: process.pid, host: '127.0.0.1', port: 3000, startedAt: 1 })
    expect(isServerLocked()).toBe(false)
    expect(await main(['status'])).toBe(3)
    expect(readPidRecord()?.pid).toBe(process.pid)
    expect(pidFilePath()).toBe(join(dir, 'cotta.pid'))
  })

  it('creates a missing state directory private', () => {
    vi.stubEnv('COTTA_DB_PATH', join(dir, 'state', 'cotta.sqlite'))
    expect(acquireServerLock()).toBe(true)
    releaseServerLock()
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)
  })

  it('refuses to start on a fresh default database while a legacy one exists', () => {
    vi.stubEnv('COTTA_DB_PATH', undefined)
    vi.stubEnv('HOME', join(dir, 'home'))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'cotta.sqlite'), '')
    expect(() => assertNoLegacyDatabase()).toThrow(/old default/)
    expect(existsSync(join(dir, 'home', '.cotta'))).toBe(false)
  })

  it('stop never signals the recorded pid when the lock is free', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const kill = vi.spyOn(process, 'kill')
    writePidRecord({ pid: process.pid, host: '127.0.0.1', port: 3000, startedAt: 1 })
    expect(await main(['stop'])).toBe(0)
    expect(kill).not.toHaveBeenCalled()
  })

  it('refuses to start while another process holds the lock, and frees it when that process is killed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const holder = await holdLock()
    try {
      expect(isServerLocked()).toBe(true)
      expect(await main(['start', '-f'])).toBe(1)
      expect(await main(['start'])).toBe(1)
      expect(error).toHaveBeenCalledTimes(2)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('already running'))
    } finally {
      await holder.kill()
    }
    expect(isServerLocked()).toBe(false)
  }, 15_000)

  it('stop escalates to SIGKILL when the server ignores SIGTERM but keeps its pidfile', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const holder = await holdLock({ ignoreSigterm: true })
    try {
      writePidRecord({ pid: holder.pid, host: '127.0.0.1', port: 3000, startedAt: 1 })
      expect(await main(['stop'])).toBe(0)
      expect(isServerLocked()).toBe(false)
    } finally {
      await holder.kill()
    }
  }, 15_000)

  it('taking the lock clears a pidfile left by a crashed predecessor', () => {
    writePidRecord({ pid: process.pid, host: '127.0.0.1', port: 3000, startedAt: 1 })
    expect(acquireServerLock()).toBe(true)
    try {
      expect(readPidRecord()).toBeNull()
    } finally {
      releaseServerLock()
    }
    expect(isServerLocked()).toBe(false)
  })

  it('a corrupt lock file surfaces as an error instead of posing as a running server', () => {
    writeFileSync(lockFilePath(), 'x'.repeat(200))
    expect(() => isServerLocked()).toThrow(/not a database/)
    expect(() => acquireServerLock()).toThrow(/not a database/)
  })

  it('uninstall refuses under COTTA_DB_PATH so it never deletes a live ~/.cotta', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('HOME', dir)
    mkdirSync(cottaHome())
    expect(await main(['uninstall', '--yes'])).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('COTTA_DB_PATH'))
    expect(existsSync(cottaHome())).toBe(true)
  })

  it('uninstall keeps the data when the server cannot be stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('HOME', dir)
    vi.stubEnv('COTTA_DB_PATH', undefined)
    mkdirSync(cottaHome())
    const holder = await holdLock()
    try {
      // Lock held without a pidfile: the server is still starting, so stop() refuses.
      expect(await main(['uninstall', '--yes'])).toBe(1)
      expect(existsSync(cottaHome())).toBe(true)
    } finally {
      await holder.kill()
    }
  })
})

describe('serverUrl', () => {
  it('brackets IPv6 hosts', () => {
    expect(serverUrl({ host: '127.0.0.1', port: 3000 })).toBe('http://127.0.0.1:3000')
    expect(serverUrl({ host: '::1', port: 3000 })).toBe('http://[::1]:3000')
  })
})

describe('main', () => {
  it('prints help without a command and rejects unknown commands', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main([])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: cotta'))
    expect(await main(['bogus'])).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown command: bogus'))
  })

  it('reports not running with exit 3 and stop is a no-op', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['status'])).toBe(3)
    expect(await main(['stop'])).toBe(0)
  })

  it('refuses to uninstall without a terminal or --yes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isTTY = process.stdin.isTTY
    process.stdin.isTTY = false
    vi.stubEnv('COTTA_DB_PATH', undefined)
    try {
      expect(await main(['uninstall'])).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('--yes'))
    } finally {
      process.stdin.isTTY = isTTY
    }
  })
})

describe('isNpmGlobalInstall', () => {
  it('only matches an entry inside <npm root -g>/cotta, following symlinks', () => {
    const root = join(dir, 'lib', 'node_modules')
    mkdirSync(join(root, 'cotta', 'dist'), { recursive: true })
    writeFileSync(join(root, 'cotta', 'dist', 'cli.js'), '')
    mkdirSync(join(dir, 'bin'))
    symlinkSync(join(root, 'cotta', 'dist', 'cli.js'), join(dir, 'bin', 'cotta'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'cli.ts'), '')

    expect(isNpmGlobalInstall(join(dir, 'bin', 'cotta'), root)).toBe(true)
    expect(isNpmGlobalInstall(join(dir, 'src', 'cli.ts'), root)).toBe(false)
    expect(isNpmGlobalInstall(join(dir, 'src', 'cli.ts'), null)).toBe(false)
    expect(isNpmGlobalInstall(join(dir, 'src', 'cli.ts'), join(dir, 'missing'))).toBe(false)
  })
})
