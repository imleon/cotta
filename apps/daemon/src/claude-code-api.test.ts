import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeCodeApi, projectIdFromPath, projectPathFromId } from './claude-code-api.js'
import type { IndexedSession } from './transcript-index-store.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function indexFromSessions(sessions: Array<{ sessionId: string; cwd: string; lastModified: number; lastVisibleMessageAtMs?: number | null; customTitle?: string; summary?: string }>) {
  const projects = new Map<string, { projectId: string; projectPath: string; lastActivityAtMs: number }>()
  for (const item of sessions) {
    const path = projectPathFromId(projectIdFromPath(item.cwd))!
    projects.set(path, { projectId: projectIdFromPath(path), projectPath: path, lastActivityAtMs: Math.max(projects.get(path)?.lastActivityAtMs ?? 0, item.lastModified) })
  }
  const activity = (item: IndexedSession) => item.lastVisibleMessageAtMs ?? item.fileMtimeMs ?? 0
  return {
    getProject: (id: string) => [...projects.values()].find((project) => project.projectId === id) ?? null,
    listProjectsPage: () => ({ items: [...projects.values()], hasMore: false, nextKey: null }),
    listProjectSessionsPage: (id: string, { limit, after }: { limit: number; after?: { sort: number | null; id: string } | null }) => {
      const all = sessions
        .filter((item) => projectIdFromPath(item.cwd) === id)
        .map(
          (item) =>
            ({
              sessionId: item.sessionId,
              currentProjectId: id,
              currentCwd: projectPathFromId(id),
              transcriptPath: null,
              fileSize: null,
              fileMtimeMs: item.lastModified,
              lastVisibleMessageAtMs: item.lastVisibleMessageAtMs ?? null,
              customTitle: item.customTitle ?? null,
              lastPrompt: item.summary ?? null,
            }) as IndexedSession,
        )
        .sort((a, b) => activity(b) - activity(a) || a.sessionId.localeCompare(b.sessionId))
      const rows = all.filter((item) => !after || activity(item) < (after.sort ?? -Infinity) || (activity(item) === after.sort && item.sessionId > after.id))
      const items = rows.slice(0, limit)
      return { items, defaultSessionId: all[0]?.sessionId ?? null, hasMore: rows.length > limit, nextKey: rows.length > limit ? { sort: activity(items.at(-1)!), id: items.at(-1)!.sessionId } : null }
    },
  }
}

describe('createClaudeCodeApi', () => {
  it('normalizes project paths before encoding ids', () => {
    expect(projectIdFromPath('/repo/cotta')).toBe(projectIdFromPath('/repo/cotta/'))
    expect(projectPathFromId(projectIdFromPath('/repo/cotta/'))).toBe('/repo/cotta')
    expect(projectPathFromId(projectIdFromPath('/'))).toBe('/')
  })

  it('keeps sibling projects and worktrees separate using only the index', async () => {
    const worktree = '/repo/cotta/.claude/worktrees/feature'
    const beforeList = vi.fn(async () => {})
    const api = createClaudeCodeApi({
      beforeList,
      transcriptIndex: indexFromSessions([
        { sessionId: 'older', cwd: '/repo/cotta/', lastModified: 1 },
        { sessionId: 'newer', cwd: '/repo/cotta', lastModified: 5, customTitle: 'New title', summary: 'Latest prompt' },
        { sessionId: 'sibling', cwd: '/repo/cotta-v2', lastModified: 10 },
        { sessionId: 'worktree', cwd: worktree, lastModified: 3 },
      ]),
    })
    await expect(api.getProject(projectIdFromPath('/repo/cotta'))).resolves.toEqual({ id: projectIdFromPath('/repo/cotta'), name: 'cotta', path: '/repo/cotta', lastActivityAt: 5 })
    await expect(api.listProjects()).resolves.toMatchObject({
      projects: expect.arrayContaining([{ id: projectIdFromPath(worktree), name: 'cotta', path: worktree, worktreeName: 'feature', lastActivityAt: 3 }]),
    })
    const result = await api.listProjectSessions(projectIdFromPath('/repo/cotta'))
    expect(result?.sessions.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(result?.sessions[0]).toMatchObject({ title: 'New title', lastPrompt: 'Latest prompt', occupiedBy: null, occupiedStatus: 'idle', hasRunningShell: false })
    expect(result?.defaultSessionId).toBe('newer')
    expect(beforeList).toHaveBeenCalledTimes(3)
  })

  it('uses visible activity and continues keyset pagination after newer rows arrive', async () => {
    const sessions = [
      { sessionId: 's1', cwd: '/repo/cotta', lastModified: 2, lastVisibleMessageAtMs: 9 },
      { sessionId: 's2', cwd: '/repo/cotta', lastModified: 5 },
      { sessionId: 's3', cwd: '/repo/cotta', lastModified: 10, lastVisibleMessageAtMs: 1 },
    ]
    const api = createClaudeCodeApi({ transcriptIndex: indexFromSessions(sessions) })
    const first = await api.listProjectSessions(projectIdFromPath('/repo/cotta'), { limit: 2 })
    expect(first?.sessions.map((item) => [item.id, item.lastActivityAt])).toEqual([
      ['s1', 9],
      ['s2', 5],
    ])
    sessions.push({ sessionId: 's0', cwd: '/repo/cotta', lastModified: 15 })
    await expect(api.listProjectSessions(projectIdFromPath('/repo/cotta'), { limit: 2, cursor: first?.nextCursor })).resolves.toMatchObject({
      sessions: [{ id: 's3' }],
      defaultSessionId: 's0',
      hasMore: false,
    })
  })

  it('requires explicit mutation dependencies rather than silently falling back to discovery', async () => {
    await expect(createClaudeCodeApi().renameSession('project', 'session', 'Title')).rejects.toThrow('not configured')
  })

  it('preserves the resolver ownership decision for every mutation', async () => {
    const mutationTarget = vi.fn(async () => null)
    const api = createClaudeCodeApi({ mutationTarget })
    await expect(api.renameSession('wrong-project', 'session', 'Title')).resolves.toBe(false)
    await expect(api.forkSession('wrong-project', 'session')).resolves.toBeNull()
    await expect(api.deleteSession('wrong-project', 'session')).resolves.toBe(false)
    expect(mutationTarget.mock.calls).toEqual([
      ['wrong-project', 'session', 'rename'],
      ['wrong-project', 'session', 'fork'],
      ['wrong-project', 'session', 'delete'],
    ])
  })

  it('mutates only the canonical source supplied by the synchronized index resolver', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cotta-api-mutations-'))
    directories.push(directory)
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const transcriptPath = join(directory, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, `${JSON.stringify({ type: 'user', uuid: messageId, sessionId, message: { content: 'Original prompt' } })}\n`)
    const mutationTarget = vi.fn(async () => ({ transcriptPath }))
    const api = createClaudeCodeApi({ mutationTarget })
    await expect(api.renameSession('sticky-ancestor-project', sessionId, 'New title')).resolves.toBe(true)
    const forkId = await api.forkSession('sticky-ancestor-project', sessionId, messageId)
    expect(await readFile(join(directory, `${forkId}.jsonl`), 'utf8')).toContain('New title (fork)')
    await expect(api.deleteSession('sticky-ancestor-project', sessionId)).resolves.toBe(true)
    await expect(readFile(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, `${forkId}.jsonl`), 'utf8')).toContain('Original prompt')
  })

  it('treats a transcript disappearing before mutation open as not found', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cotta-api-missing-'))
    directories.push(directory)
    const sessionId = randomUUID()
    const transcriptPath = join(directory, `${sessionId}.jsonl`)
    const api = createClaudeCodeApi({ mutationTarget: async () => ({ transcriptPath }) })
    await expect(api.renameSession('project', sessionId, 'Title')).resolves.toBe(false)
    await expect(api.forkSession('project', sessionId)).resolves.toBeNull()
    await expect(api.deleteSession('project', sessionId)).resolves.toBe(false)
  })
})
