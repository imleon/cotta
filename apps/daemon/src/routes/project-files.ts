import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { projectFileDiffResponseSchema, projectFileResponseSchema, projectFilesGitResponseSchema, projectFilesResponseSchema, projectFilesVersionEventSchema } from '@cotta/shared'
import type { Hono } from 'hono'
import type { ClaudeCodeApi } from '../claude-code-api.js'
import { gitChanges, gitStatusByPath, ignoredGitPaths, projectGitContext, projectGitDiff, projectGitIndexPath, projectGitStatus } from '../project-files-git.js'
import type { ProjectFilesWatcherRegistry } from '../project-files-watcher-registry.js'
import { resolveProjectRoot } from '../project-root.js'
import { isInside, openProjectImageFile, readInspectedLocalRasterImage } from './local-image-file.js'
import { createSseHeartbeat } from './project-routes-shared.js'

const MAX_DIRECTORY_ENTRIES = 1000
const MAX_WATCHED_DIRECTORIES = 16
const MAX_FILE_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function pathSegments(path: string, allowEmpty: boolean): string[] | null {
  if (!path) return allowEmpty ? [] : null
  if (path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null
  const segments = path.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && segment !== '.git') ? segments : null
}

async function resolveProjectEntry(claudeCodeApi: ClaudeCodeApi, projectId: string, path: string, allowRoot: boolean) {
  const rootResult = await resolveProjectRoot(claudeCodeApi, projectId)
  if ('error' in rootResult) return rootResult
  const segments = pathSegments(path, allowRoot)
  if (!segments) return { error: 'invalid_file_path' as const }

  try {
    const root = rootResult.root
    let target: string = root
    for (const segment of segments) {
      target = resolve(target, segment)
      if (!isInside(root, target)) return { error: 'invalid_file_path' as const }
      const info = await lstat(target)
      if (info.isSymbolicLink()) return { error: 'invalid_file_path' as const }
    }
    const canonicalTarget = await realpath(target)
    if (!isInside(root, canonicalTarget)) return { error: 'invalid_file_path' as const }
    return { root, target: canonicalTarget }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { error: 'file_not_found' as const }
    return { error: 'project_files_failed' as const }
  }
}

function revision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url')
}

async function readTextFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { error: 'unsupported_file_type' as const }
    if (info.size > MAX_FILE_BYTES) return { error: 'file_too_large' as const }
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_FILE_BYTES) return { error: 'file_too_large' as const }
    if (bytes.includes(0)) return { error: 'file_not_text' as const }
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        size: bytes.byteLength,
        revision: revision(bytes),
        mode: info.mode,
      }
    } catch {
      return { error: 'file_not_text' as const }
    }
  } finally {
    await handle.close()
  }
}

async function readImageFile(root: string, path: string, requestedPath: string) {
  const image = await openProjectImageFile(root, path)
  if ('error' in image) return image
  try {
    if (requestedPath.split('.').pop()?.toLowerCase() === 'svg') {
      if (image.size > MAX_IMAGE_BYTES) return { error: 'file_too_large' as const }
      const bytes = await image.handle.readFile()
      if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: 'file_too_large' as const }
      return /<svg[\s>]/i.test(bytes.toString('utf8')) ? { bytes, mimeType: 'image/svg+xml' } : { error: 'unsupported_file_type' as const }
    }
    return await readInspectedLocalRasterImage(image, MAX_IMAGE_BYTES, false)
  } finally {
    await image.handle.close()
  }
}

function errorStatus(error: string): 400 | 404 | 409 | 413 | 415 | 500 {
  if (error === 'invalid_file_path') return 400
  if (error === 'project_not_found' || error === 'file_not_found') return 404
  if (error === 'file_revision_conflict') return 409
  if (error === 'file_too_large') return 413
  if (error === 'file_not_text' || error === 'unsupported_file_type') return 415
  return 500
}

export function registerProjectFileRoutes(app: Hono, input: { claudeCodeApi: ClaudeCodeApi; watcherRegistry: Pick<ProjectFilesWatcherRegistry, 'acquire'> }): void {
  app.get('/api/projects/:projectId/files', async (context) => {
    const path = context.req.query('path') ?? ''
    const resolved = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', path, true)
    if ('error' in resolved && resolved.error) return context.json({ error: resolved.error }, errorStatus(resolved.error))

    try {
      if (!(await lstat(resolved.target)).isDirectory()) return context.json({ error: 'file_not_found' }, 404)
      const git = await projectGitStatus(resolved.root, { path: path || '.' })
      const statuses = git.available ? gitStatusByPath(git.entries) : new Map()
      const directoryEntries = await readdir(resolved.target, { withFileTypes: true })
      const paths = directoryEntries.map((entry) => (path ? `${path}/${entry.name}` : entry.name))
      const ignoredPaths = await ignoredGitPaths(resolved.root, paths)
      const entries = []
      for (const entry of directoryEntries) {
        if (entry.name === '.git' || entry.isSymbolicLink()) continue
        const entryPath = resolve(resolved.target, entry.name)
        const info = await lstat(entryPath)
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue
        const relativePath = path ? `${path}/${entry.name}` : entry.name
        const gitStatus = statuses.get(relativePath) ?? (ignoredPaths.has(relativePath) ? 'ignored' : undefined)
        entries.push({
          name: entry.name,
          path: relativePath,
          type: info.isDirectory() ? ('directory' as const) : ('file' as const),
          ...(info.isFile() ? { size: info.size } : {}),
          ...(gitStatus ? { gitStatus } : {}),
        })
      }
      entries.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1))
      return context.json(
        projectFilesResponseSchema.parse({
          path,
          entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
          truncated: entries.length > MAX_DIRECTORY_ENTRIES,
          gitStatusTruncated: git.available && git.truncated,
        }),
      )
    } catch {
      return context.json({ error: 'project_files_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/files/events', async (context) => {
    const projectId = context.req.param('projectId') ?? ''
    const resolved = await resolveProjectEntry(input.claudeCodeApi, projectId, '', true)
    if ('error' in resolved && resolved.error) return context.json({ error: resolved.error }, errorStatus(resolved.error))
    const paths = context.req.queries('path') ?? []
    if (paths.length > MAX_WATCHED_DIRECTORIES) return context.json({ error: 'invalid_file_path' }, 400)
    const watchedPaths: Array<string | { path: string; contentOnlyOnChange: true }> = [resolved.root]
    const indexPath = await projectGitIndexPath(resolved.root)
    if (indexPath) watchedPaths.push(indexPath)
    for (const path of paths) {
      const directory = await resolveProjectEntry(input.claudeCodeApi, projectId, path, false)
      if ('error' in directory && directory.error) {
        if (directory.error === 'file_not_found') continue
        return context.json({ error: directory.error }, errorStatus(directory.error))
      }
      if (!(await lstat(directory.target)).isDirectory()) continue
      watchedPaths.push(directory.target)
    }
    const file = context.req.query('file')
    if (file) {
      const selected = await resolveProjectEntry(input.claudeCodeApi, projectId, file, false)
      if ('error' in selected && selected.error) {
        if (selected.error !== 'file_not_found') return context.json({ error: selected.error }, errorStatus(selected.error))
      } else {
        try {
          if ((await lstat(selected.target)).isFile()) watchedPaths.push({ path: selected.target, contentOnlyOnChange: true })
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return context.json({ error: 'project_files_failed' }, 500)
        }
      }
    }
    let release = () => {}
    let cleanup = () => {}
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const heartbeat = createSseHeartbeat(controller, context.req.raw.signal, () => release())
        cleanup = heartbeat.cleanup
        try {
          const watcher = await input.watcherRegistry.acquire(watchedPaths, (event) => heartbeat.enqueue(`data: ${JSON.stringify(projectFilesVersionEventSchema.parse({ projectId, ...event }))}\n\n`))
          if (cancelled || context.req.raw.signal.aborted) return watcher.release()
          release = watcher.release
          if (!heartbeat.enqueue(`data: ${JSON.stringify(projectFilesVersionEventSchema.parse({ projectId, version: watcher.version, snapshot: true }))}\n\n`)) watcher.release()
        } catch (error) {
          heartbeat.cleanup()
          throw error
        }
      },
      cancel() {
        cancelled = true
        cleanup()
      },
    })
    return new Response(stream, { headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' } })
  })

  app.get('/api/projects/:projectId/file', async (context) => {
    const path = context.req.query('path') ?? ''
    const resolved = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', path, false)
    if ('error' in resolved && resolved.error) return context.json({ error: resolved.error }, errorStatus(resolved.error))
    try {
      const file = await readTextFile(resolved.target)
      if ('error' in file && file.error) return context.json({ error: file.error }, errorStatus(file.error))
      return context.json(projectFileResponseSchema.parse({ path, content: file.content, size: file.size, revision: file.revision }))
    } catch {
      return context.json({ error: 'project_files_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/files/git', async (context) => {
    const resolved = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', '', true)
    if ('error' in resolved && resolved.error) return context.json({ error: resolved.error }, errorStatus(resolved.error))
    const git = await projectGitStatus(resolved.root)
    if (!git.available) return context.json(projectFilesGitResponseSchema.parse(git))
    const { branch, worktree } = await projectGitContext(resolved.root)
    return context.json(projectFilesGitResponseSchema.parse({ available: true, changes: gitChanges(git.entries), truncated: git.truncated, branch, worktree }))
  })

  app.get('/api/projects/:projectId/file/image', async (context) => {
    const path = context.req.query('path') ?? ''
    const resolved = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', path, false)
    if ('error' in resolved && resolved.error) return context.json({ error: resolved.error }, errorStatus(resolved.error))
    try {
      const image = await readImageFile(resolved.root, resolved.target, path)
      if ('error' in image) return context.json({ error: image.error }, errorStatus(image.error))
      context.header('Content-Type', image.mimeType)
      context.header('Content-Disposition', 'inline')
      context.header('X-Content-Type-Options', 'nosniff')
      if (image.mimeType === 'image/svg+xml') context.header('Content-Security-Policy', "sandbox; default-src 'none'")
      return context.body(new Uint8Array(image.bytes))
    } catch {
      return context.json({ error: 'project_files_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/file/diff', async (context) => {
    const path = context.req.query('path') ?? ''
    const resolved = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', path, false)
    if ('error' in resolved && resolved.error) {
      const root = await resolveProjectEntry(input.claudeCodeApi, context.req.param('projectId') ?? '', '', true)
      if ('error' in root || !pathSegments(path, false)) return context.json({ error: resolved.error }, errorStatus(resolved.error))
      const diff = await projectGitDiff(root.root, path)
      if (diff.kind === 'deleted' || diff.kind === 'conflicted') return context.json(projectFileDiffResponseSchema.parse({ kind: diff.kind, path }))
      return context.json({ error: resolved.error }, errorStatus(resolved.error))
    }
    const diff = await projectGitDiff(resolved.root, path)
    if (diff.kind === 'deleted' || diff.kind === 'untracked' || diff.kind === 'conflicted') return context.json(projectFileDiffResponseSchema.parse({ kind: diff.kind, path }))
    if (diff.kind === 'unavailable') return context.json({ error: 'git_unavailable' }, 409)
    if (diff.kind === 'text') return context.json(projectFileDiffResponseSchema.parse({ kind: 'text', path, hunks: diff.hunks, truncated: diff.truncated }))
    return context.json({ error: 'git_unavailable' }, 409)
  })
}
