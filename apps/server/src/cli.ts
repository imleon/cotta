import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  acquireServerLock,
  assertNoLegacyDatabase,
  cottaHome,
  cottaVersion,
  databasePath,
  isServerLocked,
  lockFilePath,
  logFilePath,
  type PidRecord,
  pidFilePath,
  readPidRecord,
  releaseServerLock,
  serverUrl,
} from './cotta-home.js'

const HELP = `Usage: cotta <command> [options]

Commands:
  start [-f|--foreground] [--reconfigure-github]   Start the server (background by default)
  stop                                             Stop the running server
  restart [--reconfigure-github]                   Restart the server in the background
  status                                           Show whether the server is running
  uninstall [-y|--yes]                             Stop, delete ~/.cotta, and remove the npm package
  help                                             Show this help

Options:
  -v, --version   Print the version
  -h, --help      Show this help

Environment: HOST, PORT, COTTA_DB_PATH (default ~/.cotta/cotta.sqlite)`

const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function logTail(lines = 20): string {
  if (!existsSync(logFilePath())) return ''
  return readFileSync(logFilePath(), 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

function reportAlreadyRunning(record: PidRecord | null): number {
  console.error(record ? `Cotta is already running at ${serverUrl(record)} (pid ${record.pid}).` : 'Cotta is already running.')
  return 1
}

/** The running server's record, or null when no server holds the lock (the next lock holder clears a stale pidfile). */
function runningServer(): { record: PidRecord | null } | null {
  return isServerLocked() ? { record: readPidRecord() } : null
}

function responds(record: PidRecord): Promise<boolean> {
  return fetch(`${serverUrl(record)}/api/auth/session`, { signal: AbortSignal.timeout(3000) })
    .then((response) => response.ok)
    .catch(() => false)
}

async function startForeground(reconfigureGithub: boolean): Promise<number> {
  // runServer's lock is the single decision point; a pre-check here would only reintroduce a race.
  const { runServer } = await import('./index.js')
  if (await runServer({ reconfigureGithub })) return 0
  return reportAlreadyRunning(readPidRecord())
}

async function startBackground(reconfigureGithub: boolean): Promise<number> {
  // Hold the lock through setup so a concurrent start or server never migrates or prompts alongside us;
  // release it just before spawning, and the daemon's own lock still rejects anyone who slips in between.
  if (!acquireServerLock()) return reportAlreadyRunning(readPidRecord())
  try {
    // The daemon has no TTY, so first-run GitHub setup must happen here in the user's terminal.
    assertNoLegacyDatabase()
    const [{ createCottaDatabase }, { SqliteSettingsStore }, { ensureGithubConfig }] = await Promise.all([import('./database.js'), import('./settings-store.js'), import('./startup-config.js')])
    const db = createCottaDatabase()
    try {
      await ensureGithubConfig(new SqliteSettingsStore(db), { force: reconfigureGithub })
    } finally {
      db.close()
    }
  } finally {
    releaseServerLock()
  }

  mkdirSync(dirname(logFilePath()), { recursive: true })
  const logFd = openSync(logFilePath(), 'a')
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  let exitCode: number | null = null
  child.once('exit', (code) => {
    exitCode = code ?? 1
  })
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      console.error(`Cotta failed to start (exit ${exitCode}). Last log lines from ${logFilePath()}:`)
      console.error(logTail())
      return 1
    }
    const record = readPidRecord()
    if (record && record.pid === child.pid && (await responds(record))) {
      console.log(`Cotta started at ${serverUrl(record)} (pid ${record.pid}).`)
      console.log(`Logs: ${logFilePath()}`)
      return 0
    }
    await sleep(200)
  }
  console.error(`Cotta is still starting (pid ${child.pid}); check ${logFilePath()} or run \`cotta status\`.`)
  return 1
}

async function stop(): Promise<number> {
  const running = runningServer()
  if (!running) {
    console.log('Cotta is not running.')
    return 0
  }
  const { record } = running
  if (!record) {
    console.error(`Cotta holds the lock but has not written ${pidFilePath()} yet; retry in a moment.`)
    return 1
  }
  signal(record.pid, 'SIGTERM')
  if (!(await waitForLockRelease())) {
    // Escalate only while the lock is still held by the same recorded server, so a reused pid is never killed.
    if (readPidRecord()?.pid === record.pid) signal(record.pid, 'SIGKILL')
    if (!(await waitForLockRelease())) {
      console.error(`Cotta (pid ${record.pid}) did not stop; it still holds ${lockFilePath()}.`)
      return 1
    }
  }
  console.log(`Cotta stopped (pid ${record.pid}).`)
  return 0
}

/** A server that exits between the lock check and the signal is already stopping; the lock wait confirms it. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForLockRelease(): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (isServerLocked()) {
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
  return true
}

async function status(): Promise<number> {
  const running = runningServer()
  if (!running) {
    console.log('Cotta is not running.')
    return 3
  }
  const { record } = running
  if (!record) {
    console.log('Cotta is starting.')
    return 0
  }
  const uptimeMinutes = Math.floor((Date.now() - record.startedAt) / 60_000)
  console.log(`Cotta is ${(await responds(record)) ? 'running' : 'starting'}.`)
  console.log(`  URL:      ${serverUrl(record)}`)
  console.log(`  PID:      ${record.pid}`)
  console.log(`  Uptime:   ${Math.floor(uptimeMinutes / 60)}h ${uptimeMinutes % 60}m`)
  console.log(`  Database: ${databasePath()}`)
  console.log(`  Logs:     ${logFilePath()}`)
  return 0
}

/** True when this CLI runs from the npm global prefix, i.e. `npm uninstall -g cotta` removes it. */
export function isNpmGlobalInstall(entryPath: string, npmGlobalRoot: string | null): boolean {
  if (!npmGlobalRoot || !existsSync(npmGlobalRoot)) return false
  const rel = relative(realpathSync(npmGlobalRoot), realpathSync(entryPath))
  return !rel.startsWith('..') && rel.split(/[\\/]/)[0] === 'cotta'
}

function npmGlobalRoot(): string | null {
  const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function uninstall(yes: boolean): Promise<number> {
  const home = cottaHome()
  // stop() targets the COTTA_DB_PATH instance while rmSync targets ~/.cotta; refuse rather than delete a live database.
  if (process.env.COTTA_DB_PATH) {
    console.error(`Unset COTTA_DB_PATH before uninstalling; uninstall only manages the default ${home} instance.`)
    return 1
  }
  if (!yes) {
    if (!stdin.isTTY) {
      console.error('Refusing to uninstall without a terminal. Re-run with --yes to confirm.')
      return 1
    }
    console.log(`This stops Cotta, deletes ${home} (database, auth sessions, share assets, logs), and removes the npm package.`)
    console.log('Claude Code transcripts are not touched.')
    if (!(await confirm('Continue? [y/N] '))) {
      console.log('Aborted.')
      return 1
    }
  }

  if ((await stop()) !== 0) {
    console.error(`Left ${home} in place because Cotta is still running.`)
    return 1
  }
  const globalInstall = isNpmGlobalInstall(fileURLToPath(import.meta.url), npmGlobalRoot())
  rmSync(home, { recursive: true, force: true })
  console.log(`Deleted ${home}.`)

  if (!globalInstall) {
    console.log('No npm global install of cotta detected; remove the package with the package manager you installed it with.')
    return 0
  }
  return spawnSync('npm', ['uninstall', '-g', 'cotta'], { stdio: 'inherit' }).status ?? 1
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      foreground: { type: 'boolean', short: 'f' },
      'reconfigure-github': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.version) {
    console.log(cottaVersion())
    return 0
  }
  const [command] = positionals
  const reconfigureGithub = values['reconfigure-github'] ?? false
  switch (command) {
    case 'start':
      return values.foreground ? startForeground(reconfigureGithub) : startBackground(reconfigureGithub)
    case 'stop':
      return stop()
    case 'restart':
      return (await stop()) === 0 ? startBackground(reconfigureGithub) : 1
    case 'status':
      return status()
    case 'uninstall':
      return uninstall(values.yes ?? false)
    case undefined:
    case 'help':
      console.log(HELP)
      return 0
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`)
      return 1
  }
}

if (process.env.NODE_ENV !== 'test') {
  main(process.argv.slice(2)).then(
    (code) => {
      // A foreground server keeps the event loop alive; only set the code so it isn't cut short.
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error)
      // Exit outright: a server that failed mid-setup still holds the lock and open watchers.
      process.exit(1)
    },
  )
}
