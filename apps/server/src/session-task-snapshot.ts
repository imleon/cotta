import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { type RawSessionTask, rawSessionTaskSchema } from '@cotta/shared'

export type SessionTaskSnapshot = {
  tasks: RawSessionTask[]
  version: string
  updatedAtMs: number
}

export type SessionTaskSnapshotResult = { ok: true; snapshot: SessionTaskSnapshot } | { ok: false }

export function sessionTaskDir(sessionId: string, claudeConfigDir?: string): string {
  return join(resolve(claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')), 'tasks', sessionId)
}

function taskOrder(a: RawSessionTask, b: RawSessionTask): number {
  const an = Number(a.id)
  const bn = Number(b.id)
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
  return a.id.localeCompare(b.id)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readSnapshotOnce(sessionId: string, claudeConfigDir?: string): Promise<SessionTaskSnapshot> {
  const dir = sessionTaskDir(sessionId, claudeConfigDir)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { tasks: [], version: 'missing', updatedAtMs: Date.now() }
    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
  const tasks: RawSessionTask[] = []

  for (const file of files) {
    const path = join(dir, file)
    const raw = await readFile(path, 'utf8')
    tasks.push(rawSessionTaskSchema.parse(JSON.parse(raw)))
  }

  tasks.sort(taskOrder)
  const version = `task-v1:${createHash('sha256').update(JSON.stringify(tasks)).digest('base64url')}`
  return { tasks, version, updatedAtMs: Date.now() }
}

export async function readSessionTaskSnapshot(sessionId: string, options: { claudeConfigDir?: string; retryDelayMs?: number } = {}): Promise<SessionTaskSnapshotResult> {
  try {
    return { ok: true, snapshot: await readSnapshotOnce(sessionId, options.claudeConfigDir) }
  } catch {
    await sleep(options.retryDelayMs ?? 25)
    try {
      return { ok: true, snapshot: await readSnapshotOnce(sessionId, options.claudeConfigDir) }
    } catch {
      return { ok: false }
    }
  }
}
