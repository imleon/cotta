import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ignoredGitPaths, parseGitStatus, parseUnifiedDiff, projectGitContext, projectGitDiff, projectGitStatus } from './project-files-git.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project Git status', () => {
  it.each(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])('maps %s as conflicted', (xy) => {
    expect(parseGitStatus(Buffer.from(`${xy} conflicted.ts\0`))).toEqual([{ path: 'conflicted.ts', index: 'conflicted', worktree: 'conflicted' }])
  })

  it('retains the current path for renames', () => {
    expect(parseGitStatus(Buffer.from('R  new.ts\0old.ts\0'))).toEqual([{ path: 'new.ts', index: 'renamed', worktree: null }])
  })

  it('excludes no-newline metadata from patch hunks', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n')).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
    ])
  })

  it('normalizes nested repo paths to project-relative paths', () => {
    expect(parseGitStatus(Buffer.from(' M apps/web/src/main.ts\0?? apps/web/src/new.ts\0 M other/file.ts\0'), 'apps/web/')).toEqual([
      { path: 'src/main.ts', index: null, worktree: 'modified' },
      { path: 'src/new.ts', index: null, worktree: 'untracked' },
    ])
  })

  it('normalizes renamed paths and trims untracked directory records', () => {
    expect(parseGitStatus(Buffer.from('R  apps/web/new.ts\0apps/web/old.ts\0?? apps/web/generated/\0'), 'apps/web/')).toEqual([
      { path: 'new.ts', index: 'renamed', worktree: null },
      { path: 'generated', index: null, worktree: 'untracked' },
    ])
  })

  it('treats stdin EPIPE as a normal git exit when git stops reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-git-'))
    roots.push(root)
    const paths = Array.from({ length: 20000 }, (_, i) => `some/long/path/name/${i}`)
    for (let i = 0; i < 5; i++) await expect(ignoredGitPaths(root, paths)).resolves.toEqual(new Set())
  })

  it('reports nested project status and diff with project-relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-git-'))
    roots.push(root)
    const project = join(root, 'apps/web')
    await mkdir(join(project, 'src'), { recursive: true })
    await writeFile(join(project, 'src/main.ts'), 'const answer = 42\n')
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await execFileAsync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'], { cwd: root })
    await writeFile(join(project, 'src/main.ts'), 'const answer = 43\n')
    await writeFile(join(project, 'src/new.ts'), 'export {}\n')

    const status = await projectGitStatus(project)
    expect(status).toMatchObject({
      available: true,
      entries: expect.arrayContaining([expect.objectContaining({ path: 'src/main.ts', worktree: 'modified' }), expect.objectContaining({ path: 'src/new.ts', worktree: 'untracked' })]),
    })
    if (status.available) expect(status.entries.map((entry) => entry.path)).not.toContain('apps/web/src/main.ts')

    const context = await projectGitContext(project)
    expect(context).toMatchObject({ branch: expect.any(String), worktree: null })

    const diff = await projectGitDiff(project, 'src/main.ts')
    expect(diff).toMatchObject({ kind: 'text', hunks: expect.any(Array), truncated: false })
    if (diff.kind === 'text') expect(diff.hunks.length).toBeGreaterThan(0)
  })
})
