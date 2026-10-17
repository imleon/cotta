import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** This module lives in `src/` in dev and is inlined into `dist/cli.js` once bundled; both sit one level below package.json. */
const packageRoot = resolve(import.meta.dirname, '..')

export function cottaVersion(): string {
  return (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version
}

/** Version of the bundled Claude Agent SDK. Its `exports` hides `./package.json`, so read it next to the main entry at the package root. */
export function cottaAgentSdkVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    return (JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return null
  }
}

/** Short HEAD commit, only when running from the Cotta checkout itself (not an install nested in some other repo). */
export function cottaGitCommit(): string | null {
  try {
    const git = (...args: string[]) => execFileSync('git', ['rev-parse', ...args], { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return git('--show-prefix') === 'apps/server/' ? git('--short', 'HEAD') || null : null
  } catch {
    return null
  }
}

/** Per-user Cotta state root holding the default database, share assets, pidfile and daemon log. */
export function cottaHome(): string {
  return join(homedir(), '.cotta')
}

export function databasePath(): string {
  return process.env.COTTA_DB_PATH ? resolve(process.cwd(), process.env.COTTA_DB_PATH) : join(cottaHome(), 'cotta.sqlite')
}

// One server per database: the lock, pidfile and log live beside it, so a dev server on its own
// COTTA_DB_PATH never collides with an installed instance.
export function lockFilePath(): string {
  return join(dirname(databasePath()), 'cotta.lock')
}

export function pidFilePath(): string {
  return join(dirname(databasePath()), 'cotta.pid')
}

export function logFilePath(): string {
  return join(dirname(databasePath()), 'cotta.log')
}

// Single-instance lock: a SQLite exclusive transaction on a dedicated file is a kernel fcntl lock
// (Node has no flock API), held for the server's whole life and released by the OS however the
// process dies — so a stale pidfile or a reused pid can never make a dead server look alive.
// Two constraints: the connection must stay referenced (GC closing it drops the lock), and nothing
// outside SQLite may open/close this file in the holding process (closing any fd of a file drops
// its POSIX locks) — which is also why the WAL main database can't double as the lock.
let heldLock: DatabaseSync | null = null

/** Takes the single-instance lock for this database; false when another server already holds it. */
export function acquireServerLock(): boolean {
  // Every server and CLI start takes the lock first, so this creates the state dir private; a pre-existing
  // directory (e.g. a custom COTTA_DB_PATH parent) keeps its mode.
  mkdirSync(dirname(lockFilePath()), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(lockFilePath())
  try {
    // Wait out a concurrent `cotta status` probe, which holds the lock for microseconds.
    db.exec('PRAGMA busy_timeout = 2000')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if (isBusy(error)) return false
    throw error
  }
  heldLock = db
  // The lock holder owns the pidfile: drop any record a crashed predecessor left behind.
  rmSync(pidFilePath(), { force: true })
  return true
}

export function releaseServerLock(): void {
  heldLock?.close()
  heldLock = null
}

/** Whether some server holds the lock. The source of truth for "running"; the pidfile is only metadata. */
export function isServerLocked(): boolean {
  if (heldLock) return true
  if (!existsSync(lockFilePath())) return false
  const db = new DatabaseSync(lockFilePath())
  try {
    db.exec('PRAGMA busy_timeout = 100')
    db.exec('BEGIN EXCLUSIVE')
    db.exec('ROLLBACK')
    return false
  } catch (error) {
    // Only contention means "held"; a corrupt or foreign lock file must surface, not pose as a running server.
    if (isBusy(error)) return true
    throw error
  } finally {
    db.close()
  }
}

function isBusy(error: unknown): boolean {
  return (error as { errcode?: number }).errcode === 5 // SQLITE_BUSY
}

export type PidRecord = { pid: number; host: string; port: number; startedAt: number }

/** Base URL for a bind address; IPv6 literals need brackets. */
export function serverUrl({ host, port }: { host: string; port: number }): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export function readPidRecord(): PidRecord | null {
  try {
    const record = JSON.parse(readFileSync(pidFilePath(), 'utf8')) as PidRecord
    return Number.isInteger(record.pid) ? record : null
  } catch {
    return null
  }
}

// The pidfile is written right after the server takes the lock and outlives it: taking the lock and finding the lock free both clear it,
// and keeping it until exit lets `cotta stop` still identify a server stuck in shutdown.
export function writePidRecord(record: PidRecord): void {
  mkdirSync(dirname(pidFilePath()), { recursive: true })
  writeFileSync(pidFilePath(), JSON.stringify(record), { mode: 0o600 })
}

/**
 * Refuses to start on a fresh database while a pre-~/.cotta one sits at the old cwd-relative default; never moves it.
 * Throwing (not warning) keeps the check alive: creating the new database would make it pass forever after.
 */
export function assertNoLegacyDatabase(): void {
  const legacy = join(process.cwd(), 'data', 'cotta.sqlite')
  const current = databasePath()
  if (process.env.COTTA_DB_PATH || existsSync(current) || !existsSync(legacy)) return
  const [from, to] = [shellQuote(dirname(legacy)), shellQuote(dirname(current))]
  // share-assets lives beside the database (shareAssetsRoot), so it must move with it.
  throw new Error(
    [
      `Found a database at the old default ${legacy}; Cotta now uses ${current}.`,
      'Move it, then start again:',
      `  mkdir -p ${to} && for f in cotta.sqlite cotta.sqlite-wal cotta.sqlite-shm share-assets; do [ -e ${from}/$f ] && mv ${from}/$f ${to}/; done`,
      `Or set COTTA_DB_PATH=${legacy} to keep using it in place.`,
    ].join('\n'),
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
