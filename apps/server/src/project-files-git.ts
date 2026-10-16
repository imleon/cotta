import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { GitFileStatus, ProjectGitWorktree, StructuredPatchHunk } from '@cotta/shared'

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const UNMERGED_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

type GitResult = { stdout: Buffer; stderr: Buffer; code: number; truncated: boolean }
export type GitStatus = { path: string; index: GitFileStatus | null; worktree: GitFileStatus | null }
type ProjectGitStatusOptions = { path?: string; untracked?: 'all' | 'normal' }

function status(value: string): GitFileStatus | null {
  if (value === ' ') return null
  if (value === '?' || value === 'A') return 'added'
  if (value === 'M') return 'modified'
  if (value === 'D') return 'deleted'
  if (value === 'R' || value === 'C') return 'renamed'
  return null
}

function runGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    const read = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, MAX_GIT_OUTPUT_BYTES - bytes)
      if (chunk.length > remaining) truncated = true
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      bytes += chunk.length
    }
    const stdoutStream = child.stdout
    const stderrStream = child.stderr
    const stdinStream = child.stdin
    if (!stdoutStream || !stderrStream || (input !== undefined && !stdinStream)) {
      reject(new Error('git process streams are unavailable'))
      return
    }
    stdoutStream.on('data', read(stdout))
    stderrStream.on('data', read(stderr))
    child.once('error', reject)
    child.once('close', (code) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1, truncated }))
    if (input !== undefined && stdinStream) stdinStream.end(input)
  })
}

function unavailable(result: GitResult): 'not_git_repository' | 'git_unavailable' | null {
  const stderr = result.stderr.toString('utf8')
  return /not a git repository/i.test(stderr) ? 'not_git_repository' : null
}

function gitPrefix(result: GitResult): string {
  return result.stdout.toString('utf8').replace(/\n$/, '')
}

function normalizeGitPath(path: string, prefix: string, trimTrailingSlash = false): string | null {
  const stripped = prefix ? (path.startsWith(prefix) ? path.slice(prefix.length) : null) : path
  if (!stripped) return null
  return trimTrailingSlash ? stripped.replace(/\/$/, '') : stripped
}

export function parseGitStatus(value: Buffer, prefix = ''): GitStatus[] {
  const fields = value.toString('utf8').split('\0')
  const entries: GitStatus[] = []
  for (let index = 0; index < fields.length - 1; index += 1) {
    const record = fields[index]
    if (!record) continue
    if (record.startsWith('?? ') || record.startsWith('!! ')) {
      const path = normalizeGitPath(record.slice(3), prefix, true)
      if (path) entries.push({ path, index: null, worktree: record.startsWith('!! ') ? 'ignored' : 'untracked' })
      continue
    }
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const path = normalizeGitPath(record.slice(3), prefix)
    const renamed = xy.includes('R') || xy.includes('C')
    if (renamed) index += 1
    if (!path) continue
    if (UNMERGED_STATUSES.has(xy)) {
      entries.push({ path, index: 'conflicted', worktree: 'conflicted' })
      continue
    }
    entries.push({ path, index: status(xy[0]), worktree: status(xy[1]) })
  }
  return entries
}

export async function projectGitStatus(
  cwd: string,
  { path = '.', untracked = 'all' }: ProjectGitStatusOptions = {},
): Promise<{ available: true; entries: GitStatus[]; truncated: boolean } | { available: false; reason: 'not_git_repository' | 'git_unavailable' }> {
  try {
    const prefix = await runGit(cwd, ['rev-parse', '--show-prefix'])
    if (prefix.code !== 0) return { available: false, reason: unavailable(prefix) ?? 'git_unavailable' }
    const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`, '--ignored=no', '--', path])
    if (result.code !== 0) return { available: false, reason: unavailable(result) ?? 'git_unavailable' }
    return { available: true, entries: parseGitStatus(result.stdout, gitPrefix(prefix)), truncated: result.truncated }
  } catch {
    return { available: false, reason: 'git_unavailable' }
  }
}

export async function projectGitIndexPath(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null
  } catch {
    return null
  }
}

export async function ignoredGitPaths(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  try {
    const result = await runGit(cwd, ['check-ignore', '-z', '--stdin'], `${paths.join('\0')}\0`)
    if (result.code !== 0 && result.code !== 1) return new Set()
    return new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}

export async function projectGitContext(cwd: string): Promise<{ branch: string | null; worktree: ProjectGitWorktree | null }> {
  const [branch, root, gitDir, commonDir] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']).catch(() => null),
    runGit(cwd, ['rev-parse', '--show-toplevel']).catch(() => null),
    runGit(cwd, ['rev-parse', '--absolute-git-dir']).catch(() => null),
    runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null),
  ])
  const path = root?.code === 0 ? root.stdout.toString('utf8').trim() : ''
  const isLinkedWorktree = gitDir?.code === 0 && commonDir?.code === 0 && gitDir.stdout.toString('utf8').trim() !== commonDir.stdout.toString('utf8').trim()
  return {
    branch: branch?.code === 0 ? branch.stdout.toString('utf8').trim() || null : null,
    worktree: path && isLinkedWorktree ? { path, name: basename(path) || undefined } : null,
  }
}

export function gitChanges(entries: GitStatus[]): Array<{ path: string; status: GitFileStatus }> {
  return entries.flatMap(({ path, worktree }) => (worktree && worktree !== 'ignored' ? [{ path, status: worktree }] : []))
}

export function gitStatusByPath(entries: GitStatus[]): Map<string, GitFileStatus> {
  const statuses = new Map<string, GitFileStatus>()
  for (const entry of entries) if (entry.worktree) statuses.set(entry.path, entry.worktree)
  return statuses
}

export function parseUnifiedDiff(value: string): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = []
  let current: StructuredPatchHunk | null = null
  for (const line of value.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match) {
      current = { oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), lines: [] }
      hunks.push(current)
    } else if (current && line !== '\\ No newline at end of file' && /^[ +\\-]/.test(line)) current.lines.push(line)
  }
  return hunks
}

function completeLines(value: Buffer, truncated: boolean): string {
  const text = value.toString('utf8')
  return truncated ? text.slice(0, text.lastIndexOf('\n')) : text
}

export async function projectGitDiff(
  cwd: string,
  path: string,
): Promise<{ kind: 'text'; hunks: StructuredPatchHunk[]; truncated: boolean } | { kind: 'deleted' | 'untracked' | 'conflicted' | 'unavailable' }> {
  const current = await projectGitStatus(cwd, { path })
  if (!current.available) return { kind: 'unavailable' }
  const entry = current.entries.find((item) => item.path === path)
  if (entry?.worktree === 'deleted') return { kind: 'deleted' }
  if (entry?.worktree === 'untracked') return { kind: 'untracked' }
  if (entry?.worktree === 'conflicted') return { kind: 'conflicted' }
  if (!entry?.worktree) return { kind: 'text', hunks: [], truncated: false }
  try {
    const result = await runGit(cwd, ['diff', '--no-ext-diff', '--unified=3', '--', path])
    if (result.code !== 0) return { kind: 'unavailable' }
    return { kind: 'text', hunks: parseUnifiedDiff(completeLines(result.stdout, result.truncated)), truncated: result.truncated }
  } catch {
    return { kind: 'unavailable' }
  }
}
