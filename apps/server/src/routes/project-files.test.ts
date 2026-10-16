import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeApi } from '../claude-code-api.js'
import { createApp } from '../index.js'
import { projectGitIndexPath } from '../project-files-git.js'
import { ProjectFilesWatcherRegistry } from '../project-files-watcher-registry.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-files-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.ts'), 'const answer = 42\n')
  await writeFile(join(root, 'README.md'), '# Demo\n')
  const api = {
    getProject: async (id: string) => (id === 'project' ? { id, name: 'demo', path: root, lastActivityAt: 1 } : null),
  } as ClaudeCodeApi
  return {
    root,
    app: createApp({
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',
      claudeCodeApi: api,
    }),
  }
}

describe('project files', () => {
  it('lists direct children and reads text files', async () => {
    const { app } = await fixture()
    const listing = await app.request('/api/projects/project/files?path=')
    expect(listing.status).toBe(200)
    expect(await listing.json()).toMatchObject({
      path: '',
      truncated: false,
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
    })

    const response = await app.request('/api/projects/project/file?path=src%2Fmain.ts')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'src/main.ts', content: 'const answer = 42\n', size: 18 })
  })

  it('preserves project image raster, SVG, and 5 MiB behavior', async () => {
    const { app, root } = await fixture()
    await writeFile(join(root, 'image.jpg'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await writeFile(join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(root, 'large.png'), Buffer.alloc(5 * 1024 * 1024 + 1))

    const raster = await app.request('/api/projects/project/file/image?path=image.jpg')
    expect(raster.status).toBe(200)
    expect(raster.headers.get('content-type')).toBe('image/png')
    const svg = await app.request('/api/projects/project/file/image?path=image.svg')
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect((await app.request('/api/projects/project/file/image?path=large.png')).status).toBe(413)
  })

  it('reads an image through its canonical path', async () => {
    const { app, root } = await fixture()
    await writeFile(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    const response = await app.request('/api/projects/project/file/image?path=image.png')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('limits Files SSE to 16 requested directories', async () => {
    const { app } = await fixture()
    const paths = new URLSearchParams(Array.from({ length: 17 }, () => ['path', 'src']))

    const response = await app.request(`/api/projects/project/files/events?${paths}`)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_file_path' })
  })

  it('keeps Files SSE alive when an expanded directory disappeared', async () => {
    const { app } = await fixture()

    const response = await app.request('/api/projects/project/files/events?path=missing')

    expect(response.status).toBe(200)
    await response.body?.cancel()
  })

  it('watches only requested directory tree changes and shares subscriptions', async () => {
    const { root } = await fixture()
    const registry = new ProjectFilesWatcherRegistry()
    const events: Array<{ version: number; contentOnly?: true }> = []
    const [first, second] = await Promise.all([registry.acquire([root, join(root, 'src')], (event) => events.push(event)), registry.acquire(root, (event) => events.push(event))])
    await writeFile(join(root, 'src', 'main.ts'), 'export {}\n')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(events).toEqual([])

    await writeFile(join(root, 'src', 'new.ts'), 'export {}\n')
    await vi.waitFor(() => expect(events).toEqual([{ version: 1 }]))
    first.release()
    second.release()
    registry.close()
  })

  it('watches selected file content without refreshing the tree', async () => {
    const { root } = await fixture()
    const registry = new ProjectFilesWatcherRegistry()
    const events: Array<{ version: number; contentOnly?: true }> = []
    const subscription = await registry.acquire({ path: join(root, 'src', 'main.ts'), contentOnlyOnChange: true }, (event) => events.push(event))

    await writeFile(join(root, 'src', 'main.ts'), 'export {}\n')

    await vi.waitFor(() => expect(events).toEqual([{ version: 1, contentOnly: true }]))
    subscription.release()
    registry.close()
  })

  it('watches the Git index without recursively watching .git', async () => {
    const { root } = await fixture()
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    const indexPath = await projectGitIndexPath(root)
    expect(indexPath).not.toBeNull()
    const registry = new ProjectFilesWatcherRegistry()
    const events: Array<{ version: number; contentOnly?: true }> = []
    const subscription = await registry.acquire([root, indexPath!], (event) => events.push(event))

    await execFileAsync('git', ['add', 'README.md'], { cwd: root })

    await vi.waitFor(() => expect(events).toEqual([{ version: 1 }]))
    subscription.release()
    registry.close()
  })

  it('marks listings as truncated after 1,000 entries', async () => {
    const { app, root } = await fixture()
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => writeFile(join(root, `file-${index}`), '')))

    const listing = await app.request('/api/projects/project/files')

    expect((await listing.json()).truncated).toBe(true)
  })

  it('reports real git status and diffs', async () => {
    const { app, root } = await fixture()
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await execFileAsync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: root })
    await writeFile(join(root, 'README.md'), '# Changed\n')
    await writeFile(join(root, 'new.ts'), 'export {}\n')
    await writeFile(join(root, 'src', 'main.ts'), 'const answer = 43\n')
    await execFileAsync('git', ['add', 'src/main.ts'], { cwd: root })

    const listing = (await (await app.request('/api/projects/project/files')).json()) as { entries: Array<{ path: string; gitStatus?: string }> }
    expect(listing.entries).toContainEqual(expect.objectContaining({ path: 'README.md', gitStatus: 'modified' }))
    expect(listing.entries).toContainEqual(expect.objectContaining({ path: 'new.ts', gitStatus: 'untracked' }))
    expect(listing.entries).toContainEqual(expect.objectContaining({ path: 'src' }))

    const changes = await app.request('/api/projects/project/files/git')
    expect(changes.status).toBe(200)
    const payload = (await changes.json()) as { available: boolean; branch: string | null; worktree: unknown; changes: Array<{ path: string; status: string }> }
    expect(payload).toMatchObject({
      available: true,
      branch: expect.any(String),
      worktree: null,
      changes: expect.arrayContaining([
        { path: 'README.md', status: 'modified' },
        { path: 'new.ts', status: 'untracked' },
      ]),
    })
    expect(payload.changes).not.toContainEqual(expect.objectContaining({ path: 'src/main.ts' }))

    const diff = await app.request('/api/projects/project/file/diff?path=README.md')
    expect(diff.status).toBe(200)
    expect(await diff.json()).toMatchObject({ kind: 'text', path: 'README.md', hunks: expect.any(Array), truncated: false })
    expect((await app.request('/api/projects/project/file/diff?path=new.ts')).status).toBe(200)

    await unlink(join(root, 'README.md'))
    const deleted = await app.request('/api/projects/project/file/diff?path=README.md')
    expect(await deleted.json()).toMatchObject({ kind: 'deleted', path: 'README.md' })
  })

  it('rejects traversal, git internals, symlinks, binary files, and unknown projects', async () => {
    const { app, root } = await fixture()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'secret')
    await symlink(tmpdir(), join(root, 'outside'))
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]))

    expect((await app.request('/api/projects/project/files?path=..')).status).toBe(400)
    expect((await app.request('/api/projects/project/files?path=.git')).status).toBe(400)
    expect((await app.request('/api/projects/project/files?path=outside')).status).toBe(400)
    expect((await app.request('/api/projects/project/file?path=binary')).status).toBe(415)
    expect((await app.request('/api/projects/missing/files')).status).toBe(404)

    const listing = (await (await app.request('/api/projects/project/files')).json()) as { entries: Array<{ name: string }> }
    expect(listing.entries.map((entry) => entry.name)).not.toContain('.git')
    expect(listing.entries.map((entry) => entry.name)).not.toContain('outside')
  })
})
