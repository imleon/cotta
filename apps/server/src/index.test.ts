import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInfoResponseSchema, healthResponseSchema } from '@cotta/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth, saveGithubConfig } from './auth.js'
import { getClaudeCliRuntimeInfo } from './claude-cli/executable.js'
import { forceCloseOwnedClaudeProcesses } from './claude-cli/query.js'
import { type ClaudeSessionRegistryChange, type CliSessionMetadata, createClaudeSessionRegistry } from './claude-session-registry.js'
import { createCottaDatabase } from './database.js'
import { closeServerResources, createApp, shutdownServer, subscribeCliSessionOwnership } from './index.js'
import { SqliteSettingsStore } from './settings-store.js'
import type { TranscriptIndexStore } from './transcript-index-store.js'
import { TurnOptionsStore } from './turn-options-store.js'

vi.mock('./claude-cli/executable.js', () => ({
  getClaudeCliRuntimeInfo: vi.fn().mockResolvedValue({ path: '/usr/local/bin/claude', version: '2.1.322' }),
}))

vi.mock('./claude-cli/query.js', () => ({ forceCloseOwnedClaudeProcesses: vi.fn() }))

function emptyClaudeCodeApi() {
  return {
    async listProjects() {
      return { projects: [], hasMore: false, nextCursor: null }
    },
    async getProject() {
      return null
    },
    async listProjectSessions() {
      return null
    },
    async deleteSession() {
      return false
    },
    async renameSession() {
      return false
    },
    async forkSession() {
      return null
    },
  }
}

function emptyTranscriptIndex(): Pick<TranscriptIndexStore, 'getSession' | 'getProject' | 'listProjectsPage' | 'listProjectSessionsPage'> {
  return {
    getSession: () => null,
    getProject: () => null,
    listProjectsPage: () => ({ items: [], hasMore: false, nextKey: null }),
    listProjectSessionsPage: () => ({ items: [], hasMore: false, nextKey: null, defaultSessionId: null }),
  }
}

function memorySettingsStore() {
  const authSessions = new Map<string, { user: { login: string; name: string | null; avatarUrl: string | null }; expiresAt: number }>()
  return {
    getAll: () => ({}),
    setMany(_scope: string, _settings: Record<string, unknown>, options: { clearAuthSessions?: boolean } = {}) {
      if (options.clearAuthSessions) authSessions.clear()
    },
    getAuthSession: (sessionId: string) => authSessions.get(sessionId) ?? null,
    setAuthSession: (sessionId: string, session: { user: { login: string; name: string | null; avatarUrl: string | null }; expiresAt: number }) => {
      authSessions.set(sessionId, session)
    },
    deleteAuthSession: (sessionId: string) => {
      authSessions.delete(sessionId)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('CLI session ownership subscription', () => {
  it('releases stale cotta ownership through registry notifications without changing transcript history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cotta-stale-ownership-'))
    const sessionId = '12345678-1234-4123-8123-123456789abc'
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const recordPath = join(root, '101.json')
    const transcriptPath = join(root, `${sessionId}.jsonl`)
    const history = '{"type":"user","message":{"content":"hi"}}\n'
    writeFileSync(transcriptPath, history)
    writeFileSync(recordPath, JSON.stringify({ pid: 101, sessionId, cwd: '/repo/a', entrypoint: 'cotta', status: 'busy' }))
    let now = 0
    let alive = true
    const registry = await createClaudeSessionRegistry({
      sessionsDir: root,
      now: () => now,
      isOwnedProcess: () => false,
      checkProcess: () => {
        if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      },
    })
    const database = createCottaDatabase(':memory:')
    const rebuildRuntimeAfterCliIdle = vi.fn().mockResolvedValue(true)
    const closeForExternalOwner = vi.fn().mockResolvedValue(true)
    const publishChange = vi.fn()
    const unsubscribe = subscribeCliSessionOwnership({
      claudeSessionRegistry: registry,
      liveTurnManager: { closeForExternalOwner, rebuildRuntimeAfterCliIdle },
      rawTranscriptCoordinator: { signalSession: vi.fn(), syncForRead: vi.fn().mockResolvedValue(undefined) },
      rawTranscriptCache: { index: { getSession: () => ({ currentProjectId: projectId }) as never } },
      indexChangeNotifier: { publishChange },
      timelineVersion: () => 'v1',
      syncTranscriptIndex: vi.fn().mockResolvedValue(undefined),
      settingsStore: memorySettingsStore() as never,
      turnOptionsStore: new TurnOptionsStore(database),
    })
    try {
      expect(registry.cliSessionMetadata(sessionId)?.status).toBe('busy')
      writeFileSync(recordPath, JSON.stringify({ pid: 101, sessionId, cwd: '/repo/a', entrypoint: 'cotta', status: 'busy', updatedAt: 1 }))
      await vi.waitFor(() => expect(closeForExternalOwner).toHaveBeenCalledWith(sessionId))
      alive = false
      now = 30_000
      await registry.revalidateIfDue()
      await vi.waitFor(() => expect(rebuildRuntimeAfterCliIdle).toHaveBeenCalledOnce())
      expect(registry.cliSessionMetadata(sessionId)).toBeNull()
      expect(rebuildRuntimeAfterCliIdle.mock.calls[0]?.[0].hasCliOwnership()).toBe(false)
      expect(publishChange).toHaveBeenCalled()
      expect(() => readFileSync(recordPath)).toThrow()
      expect(readFileSync(transcriptPath, 'utf8')).toBe(history)
    } finally {
      unsubscribe()
      await registry.close()
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('waits for CLI metadata removal before rebuilding a previously opened runtime', async () => {
    const listeners: Array<(change: ClaudeSessionRegistryChange) => void> = []
    let metadata: CliSessionMetadata | null = { status: 'busy', hasRunningShell: false, kind: null, entrypoint: 'cli' }
    const rebuildRuntimeAfterCliIdle = vi.fn().mockResolvedValue(true)
    const closeForExternalOwner = vi.fn().mockResolvedValue(true)
    const database = createCottaDatabase(':memory:')
    const turnOptionsStore = new TurnOptionsStore(database)
    const sessionId = '12345678-1234-4123-8123-123456789abc'
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const session = { currentProjectId: projectId }
    const unsubscribe = subscribeCliSessionOwnership({
      claudeSessionRegistry: {
        subscribe: (next) => {
          listeners.push(next)
          return vi.fn()
        },
        cliSessionMetadata: () => metadata,
      },
      liveTurnManager: { closeForExternalOwner, rebuildRuntimeAfterCliIdle },
      rawTranscriptCoordinator: { signalSession: vi.fn(), syncForRead: vi.fn().mockResolvedValue(undefined) },
      rawTranscriptCache: { index: { getSession: () => session as never } },
      indexChangeNotifier: { publishChange: vi.fn() },
      timelineVersion: () => 'v1',
      syncTranscriptIndex: vi.fn().mockResolvedValue(undefined),
      settingsStore: memorySettingsStore() as never,
      turnOptionsStore,
    })

    listeners[0]?.({ changedSessions: [{ sessionId, cwd: '/repo/a' }], activeSessionIds: [sessionId], idleSessionIds: [] })
    await vi.waitFor(() => expect(closeForExternalOwner).toHaveBeenCalledWith(sessionId))
    metadata = { status: 'idle', hasRunningShell: false, kind: null, entrypoint: 'cli' }
    listeners[0]?.({ changedSessions: [{ sessionId, cwd: '/repo/a' }], activeSessionIds: [], idleSessionIds: [sessionId] })
    await Promise.resolve()
    expect(rebuildRuntimeAfterCliIdle).not.toHaveBeenCalled()

    metadata = null
    listeners[0]?.({ changedSessions: [{ sessionId, cwd: '/repo/a' }], activeSessionIds: [], idleSessionIds: [] })
    await vi.waitFor(() => expect(rebuildRuntimeAfterCliIdle).toHaveBeenCalledOnce())
    expect(rebuildRuntimeAfterCliIdle.mock.calls[0]?.[0].hasCliOwnership()).toBe(false)
    listeners[0]?.({ changedSessions: [{ sessionId: 'other-session', cwd: '/repo/a' }], activeSessionIds: [], idleSessionIds: [] })
    await Promise.resolve()
    expect(rebuildRuntimeAfterCliIdle).toHaveBeenCalledOnce()

    unsubscribe()
    database.close()
  })
})

describe('server shutdown', () => {
  it.skipIf(process.platform !== 'linux')(
    'reaps isolated CLI and tool processes before the real parent hard exit',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cotta-shutdown-'))
      let external: ChildProcess | undefined
      let parent: ChildProcess | undefined
      const pids: number[] = []
      try {
        const fakeCli = `#!${process.execPath}
      const {spawn}=require('node:child_process');
      const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const frame=JSON.parse(line);
        process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{models:[],toolPid:tool.pid}}})+'\\n');
      });
    `
        writeFileSync(join(root, 'claude'), fakeCli, { mode: 0o700 })
        const parentScript = join(root, 'parent.mjs')
        writeFileSync(
          parentScript,
          `
      import {query} from ${JSON.stringify(new URL('./claude-cli/query.ts', import.meta.url).href)};
      import {shutdownServer} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const active=query({prompt:(async function*(){})(),options:{cwd:${JSON.stringify(root)}}});
      const closing=query({prompt:(async function*(){})(),options:{cwd:${JSON.stringify(root)}}});
      const catalogs=await Promise.all([active.initializationResult(),closing.initializationResult()]);
      process.send({pids:[active.pid,closing.pid,...catalogs.map(c=>c.toolPid)]});
      void closing.close();
      const close=()=>{};
      shutdownServer({close}, {
        liveTurnManager:{closeAll:()=>new Promise(()=>{})},
        indexChangeNotifier:{close},rawTranscriptCoordinator:{close},turnMetaStore:{close},cottaDb:{close}
      });
    `,
        )
        const loader = createRequire(import.meta.url).resolve('tsx')
        external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
        const externalPid = external.pid!
        parent = spawn(process.execPath, ['--import', loader, parentScript], {
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.dev.json', import.meta.url)) },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        })
        const exited = once(parent, 'exit')
        let stderr = ''
        parent.stderr?.on('data', (chunk) => {
          stderr += chunk.toString()
        })
        parent.on('message', (message) => {
          pids.push(...(message as { pids: number[] }).pids)
        })
        expect(await exited, stderr).toEqual([0, null])
        expect(pids).toHaveLength(4)
        for (const pid of pids) {
          await vi.waitFor(() => {
            try {
              expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]).toBe('Z')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          })
        }
        expect(() => process.kill(externalPid, 0)).not.toThrow()
      } finally {
        if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
        external?.kill('SIGKILL')
        for (const pid of pids.slice(0, 2)) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
    15_000,
  )

  it.each(['deadline', 'graceful'] as const)('synchronously reaps owned CLI processes before %s exit, only once', async (mode) => {
    vi.useFakeTimers()
    const calls: string[] = []
    vi.mocked(forceCloseOwnedClaudeProcesses).mockImplementation(() => {
      calls.push('kill')
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      calls.push('exit')
      return undefined as never
    })
    let release!: () => void
    const resourcesClosed = new Promise<void>((resolve) => {
      release = resolve
    })
    const close = vi.fn()
    try {
      shutdownServer(
        { close: (done) => done() },
        {
          liveTurnManager: { closeAll: () => resourcesClosed },
          indexChangeNotifier: { close },
          rawTranscriptCoordinator: { close },
          turnMetaStore: { close },
          cottaDb: { close },
        },
      )
      expect(calls).toEqual([])
      if (mode === 'deadline') {
        await vi.advanceTimersByTimeAsync(999)
        expect(calls).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(calls).toEqual(['kill', 'exit'])
        expect(close).not.toHaveBeenCalled()
      }
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['kill', 'exit'])
      await vi.advanceTimersByTimeAsync(3_000)
      expect(calls).toEqual(['kill', 'exit'])
    } finally {
      release()
      exit.mockRestore()
      vi.mocked(forceCloseOwnedClaudeProcesses).mockReset()
      vi.useRealTimers()
    }
  })
})

describe('server resources', () => {
  it('waits for CLI processes to exit before closing transcript resources', async () => {
    let release!: () => void
    const exited = new Promise<void>((resolve) => {
      release = resolve
    })
    const close = vi.fn()
    const closing = closeServerResources({
      liveTurnManager: { closeAll: () => exited },
      indexChangeNotifier: { close },
      rawTranscriptCoordinator: { close },
      turnMetaStore: { close },
      cottaDb: { close },
    })
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    release()
    await closing
    expect(close).toHaveBeenCalledTimes(4)
  })

  it('waits for registry close before closing SQLite', async () => {
    const calls: string[] = []
    let resolveRegistry!: () => void
    const registryClosed = new Promise<void>((resolve) => {
      resolveRegistry = resolve
    })
    const closing = closeServerResources({
      liveTurnManager: {
        closeAll: () => {
          calls.push('live')
        },
      },
      unsubscribeRegistry: () => {
        calls.push('unsubscribe')
      },
      indexChangeNotifier: {
        close: () => {
          calls.push('notifier')
        },
      },
      rawTranscriptCoordinator: {
        close: async () => {
          calls.push('coordinator')
        },
      },
      turnMetaStore: {
        close: () => {
          calls.push('turn-meta')
        },
      },
      claudeSessionRegistry: {
        close: async () => {
          calls.push('registry')
          await registryClosed
        },
      },
      sessionWatcherRegistry: {
        close: () => {
          calls.push('session-watchers')
        },
      },
      remoteBotManager: {
        close: async () => {
          calls.push('remote-bots')
        },
      },
      cottaDb: {
        close: () => {
          calls.push('db')
        },
      },
    })

    await Promise.resolve()
    expect(calls).toContain('session-watchers')
    expect(calls).toContain('remote-bots')
    expect(calls).not.toContain('coordinator')
    expect(calls).not.toContain('db')

    resolveRegistry()
    await closing
    expect(calls.indexOf('registry')).toBeLessThan(calls.indexOf('coordinator'))
    expect(calls.at(-1)).toBe('db')
  })
})

describe('server routes', () => {
  it('uses its transcript index for the default project API', async () => {
    const project = { projectId: 'project-1', projectPath: '/repo/cotta', lastActivityAtMs: 123 }
    const session = {
      sessionId: 'session-1',
      currentProjectId: project.projectId,
      currentCwd: project.projectPath,
      transcriptPath: '/tmp/session-1.jsonl',
      fileSize: 1,
      fileMtimeMs: 123,
      lastVisibleMessageAtMs: 123,
      customTitle: 'Session title',
      aiTitle: null,
      lastPrompt: null,
      summaryHint: null,
      firstPrompt: null,
      firstPromptLocked: null,
      commandFallback: null,
      gitBranch: null,
      isSidechain: false,
      entrypoint: null,
      sessionKind: null,
      taskSnapshot: null,
      taskSnapshotVersion: null,
      taskSnapshotUpdatedAtMs: null,
      isValidSessionId: true,
    }
    const app = createApp({
      transcriptIndex: {
        getSession: (sessionId) => (sessionId === session.sessionId ? session : null),
        getProject: (projectId) => (projectId === project.projectId ? project : null),
        listProjectsPage: () => ({ items: [project], hasMore: false, nextKey: null }),
        listProjectSessionsPage: () => ({ items: [session], hasMore: false, nextKey: null, defaultSessionId: session.sessionId }),
      },
      timelineVersionReader: () => 'timeline-version',
    })

    expect(await (await app.request('/api/projects')).json()).toEqual({
      projects: [{ id: 'project-1', name: 'cotta', path: '/repo/cotta', lastActivityAt: 123 }],
      hasMore: false,
      nextCursor: null,
    })
    expect(await (await app.request('/api/projects/project-1/sessions')).json()).toMatchObject({
      project: { id: 'project-1' },
      sessions: [{ id: 'session-1', title: 'Session title' }],
      defaultSessionId: 'session-1',
    })
  })

  it('reports bubblewrap availability and terminates the global terminal', async () => {
    const available = vi.fn(() => true)
    const terminate = vi.fn(() => true)
    const app = createApp({
      claudeCodeApi: emptyClaudeCodeApi(),
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',
      terminalRegistry: { available, terminate },
    })

    expect(await (await app.request('/api/terminal')).json()).toEqual({ available: true })
    expect(available).toHaveBeenCalledWith()
    expect(await (await app.request('/api/terminal', { method: 'DELETE', headers: { Origin: 'http://localhost:5173', Host: 'localhost:5173' } })).json()).toEqual({ ok: true })
    expect(terminate).toHaveBeenCalledWith()

    available.mockReturnValue(false)
    expect(await (await app.request('/api/terminal')).json()).toEqual({ available: false })
    terminate.mockReturnValue(false)
    expect(await (await app.request('/api/terminal', { method: 'DELETE', headers: { Origin: 'http://localhost:5173', Host: 'localhost:5173' } })).json()).toEqual({ error: 'terminal_not_found' })
  })

  it('requires the DELETE Origin to match the request host before termination', async () => {
    const terminate = vi.fn(() => true)
    const app = createApp({
      claudeCodeApi: emptyClaudeCodeApi(),
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',
      terminalRegistry: { available: () => true, terminate },
    })

    // Cross-origin: Origin host differs from Host → forbidden.
    const rejected = await app.request('/api/terminal', { method: 'DELETE', headers: { Origin: 'https://evil.example.com', Host: 'cotta.example.com' } })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ error: 'forbidden' })
    expect(terminate).not.toHaveBeenCalled()
    // Same-origin: Origin host matches Host → allowed.
    expect(await (await app.request('/api/terminal', { method: 'DELETE', headers: { Origin: 'https://cotta.example.com', Host: 'cotta.example.com' } })).json()).toEqual({ ok: true })
  })

  it('returns the service health payload with a request ID', async () => {
    const response = await createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing' }).request('/api/health', {
      headers: { 'X-Request-Id': 'health-request-1' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Request-Id')).toBe('health-request-1')
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      service: 'cotta-server',
    })
  })

  it('serves build info including the system Claude Code CLI version', async () => {
    const response = await createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing' }).request('/api/build-info')
    expect(response.status).toBe(200)
    const payload = await response.json()
    const info = buildInfoResponseSchema.parse(payload)
    expect(info.version).toMatch(/\d/)
    expect(info.claudeCodeCliVersion).toBe('2.1.322')
    expect(payload).not.toHaveProperty('agentSdkVersion')
  })

  it('reports an unavailable CLI without inventing a runtime version', async () => {
    vi.mocked(getClaudeCliRuntimeInfo).mockRejectedValueOnce(new Error('Claude Code CLI not found on PATH'))
    const response = await createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing' }).request('/api/build-info')
    expect(response.status).toBe(200)
    const info = buildInfoResponseSchema.parse(await response.json())
    expect(info.claudeCodeCliVersion).toBeNull()
  })

  it('keeps build info behind auth while health stays public', async () => {
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    expect((await app.request('/api/health')).status).toBe(200)
    expect((await app.request('/api/build-info')).status).toBe(401)
  })

  it('generates a request ID and returns structured errors for uncaught failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing' })
    app.get('/uncaught-test', () => {
      throw new Error('database offline')
    })
    const response = await app.request('/uncaught-test')
    const body = (await response.json()) as { error: string; requestId: string }

    expect(response.status).toBe(500)
    expect(body.error).toBe('internal_server_error')
    expect(body.requestId).toBeTruthy()
    expect(response.headers.get('X-Request-Id')).toBe(body.requestId)
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      event: 'http_request_error',
      requestId: body.requestId,
      method: 'GET',
      path: '/uncaught-test',
      error: { name: 'Error', message: 'database offline' },
    })
  })

  it('rejects protected API requests without a GitHub session when auth is configured', async () => {
    const response = await createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    }).request('/api/projects')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns unauthenticated auth session publicly', async () => {
    const response = await createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    }).request('/api/auth/session')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false, user: null })
  })

  it('accepts GitHub device login session cookies for protected API requests', async () => {
    const bodies: Record<string, Record<string, string>> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.body instanceof URLSearchParams) bodies[new URL(url).pathname] = Object.fromEntries(init.body)
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: 'Leon', avatar_url: 'https://example.com/avatar.png' }))
        return new Response('{}', { status: 404 })
      }),
    )
    const authedApp = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',

      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
      claudeCodeApi: emptyClaudeCodeApi(),
    })
    const start = await authedApp.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const poll = await authedApp.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!
    expect(cookie).toContain('cotta_session=')
    expect(cookie).toContain('HttpOnly')
    // Identity-only login: the built-in client id on both calls, and no scope requested.
    expect(bodies['/login/device/code']).toEqual({ client_id: 'Ov23liMLUPsdQ154njI3' })
    expect(bodies['/login/oauth/access_token']).toEqual({
      client_id: 'Ov23liMLUPsdQ154njI3',
      device_code: 'device-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const response = await authedApp.request('/api/projects', { headers: { cookie } })
    expect(response.status).toBe(200)
  })

  it('keeps GitHub sessions after recreating auth with the same store and secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: null, avatar_url: null }))
        return new Response('{}', { status: 404 })
      }),
    )
    const settingsStore = memorySettingsStore()
    const authConfig = { allowedUsers: 'imleon', sessionSecret: 'test-secret' }
    const firstApp = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: authConfig, settingsStore }),
      claudeCodeApi: emptyClaudeCodeApi(),
    })
    const start = await firstApp.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const poll = await firstApp.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!

    const secondApp = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: authConfig, settingsStore }),
      claudeCodeApi: emptyClaudeCodeApi(),
    })
    expect((await secondApp.request('/api/projects', { headers: { cookie } })).status).toBe(200)
    await secondApp.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect((await secondApp.request('/api/projects', { headers: { cookie } })).status).toBe(401)
  })

  it('rejects GitHub users outside the allowlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'someone-else', name: null, avatar_url: null }))
        return new Response('{}', { status: 404 })
      }),
    )
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })

    expect(poll.status).toBe(403)
    expect(await poll.json()).toEqual({ error: 'forbidden' })
  })

  it('reads the allowed user fresh from the store so a changed user can log in without a restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'teammate', name: null, avatar_url: null }))
        return new Response('{}', { status: 404 })
      }),
    )
    const database = createCottaDatabase(':memory:')
    try {
      const settingsStore = new SqliteSettingsStore(database)
      saveGithubConfig(settingsStore, { allowedUsers: 'imleon' })
      const auth = createAuth({ github: { sessionSecret: 'test-secret' }, settingsStore })
      const app = createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing', auth, claudeCodeApi: emptyClaudeCodeApi() })

      // Change the allowed user in the store — same auth instance, no restart.
      saveGithubConfig(settingsStore, { allowedUsers: 'teammate' })

      const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
      const { flowId } = (await start.json()) as { flowId: string }
      const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
      expect(poll.status).toBe(200)
      expect(await poll.json()).toEqual({ status: 'authorized', user: { login: 'teammate', name: null, avatarUrl: null } })
    } finally {
      database.close()
    }
  })

  it('returns 400 invalid_request when the device poll body is malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const database = createCottaDatabase(':memory:')
    try {
      const settingsStore = new SqliteSettingsStore(database)
      saveGithubConfig(settingsStore, { allowedUsers: 'imleon' })
      const auth = createAuth({ github: { sessionSecret: 'test-secret' }, settingsStore })
      const app = createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing', auth, claudeCodeApi: emptyClaudeCodeApi() })

      const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })
      expect(poll.status).toBe(400)
      expect(await poll.json()).toEqual({ error: 'invalid_request' })
    } finally {
      database.close()
    }
  })

  it('retries transient GitHub auth request failures', async () => {
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
    })
    vi.stubGlobal('fetch', fetch)
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    const response = await app.request('/api/auth/github/device/start', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns 502 when GitHub auth request retries fail', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetch)
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    const response = await app.request('/api/auth/github/device/start', { method: 'POST' })

    expect(response.status).toBe(502)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(await response.json()).toEqual({ error: 'github_request_failed' })
  })

  it('returns 502 when GitHub auth returns invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json')),
    )
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    const response = await app.request('/api/auth/github/device/start', { method: 'POST' })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'github_invalid_json' })
  })

  it('logs out a GitHub session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: null, avatar_url: null }))
        return new Response('{}', { status: 404 })
      }),
    )
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
      claudeCodeApi: emptyClaudeCodeApi(),
    })
    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!

    expect((await app.request('/api/projects', { headers: { cookie } })).status).toBe(200)
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(logout.status).toBe(200)
    expect(await logout.json()).toEqual({ ok: true })
    expect((await app.request('/api/projects', { headers: { cookie } })).status).toBe(401)
  })

  it('refuses to construct without exactly one allowed user', () => {
    expect(() => createAuth({ github: { allowedUsers: '', sessionSecret: 'test-secret' } })).toThrow('exactly one allowed user')
    expect(() => createAuth({ github: { allowedUsers: 'imleon,teammate', sessionSecret: 'test-secret' } })).toThrow('exactly one allowed user')
  })

  it('persists a generated session secret in the settings store', () => {
    const secrets = new Map<string, string>()
    const store = {
      getAll: (scope?: string) => (scope === 'secrets' ? Object.fromEntries(secrets) : {}),
      setMany: (scope: string, values: Record<string, unknown>) => {
        if (scope === 'secrets') for (const [k, v] of Object.entries(values)) secrets.set(k, v as string)
      },
      getAuthSession: () => null,
      setAuthSession: () => {},
      deleteAuthSession: () => {},
    }
    const github = { allowedUsers: 'imleon' }
    createAuth({ github, settingsStore: store as never })
    const generated = secrets.get('sessionSecret')
    expect(typeof generated).toBe('string')
    createAuth({ github, settingsStore: store as never })
    expect(secrets.get('sessionSecret')).toBe(generated)
  })

  it('renews the session cookie after the daily threshold and not before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
        if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: null, avatar_url: null }))
        return new Response('{}', { status: 404 })
      }),
    )
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const app = createApp({
        transcriptIndex: emptyTranscriptIndex(),
        timelineVersionReader: () => 'timeline-missing',
        auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' }, settingsStore: memorySettingsStore() }),
        claudeCodeApi: emptyClaudeCodeApi(),
      })
      const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
      const { flowId } = (await start.json()) as { flowId: string }
      const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
      const cookie = poll.headers.get('set-cookie')!.split(';')[0]!

      vi.setSystemTime(new Date('2026-01-01T06:00:00Z'))
      const soon = await app.request('/api/projects', { headers: { cookie } })
      expect(soon.status).toBe(200)
      expect(soon.headers.get('set-cookie')).toBeNull()

      vi.setSystemTime(new Date('2026-01-02T06:00:00Z'))
      const later = await app.request('/api/projects', { headers: { cookie } })
      expect(later.status).toBe(200)
      expect(later.headers.get('set-cookie')).toContain('cotta_session=')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the device flow after access is denied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/device/code'))
          return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
        if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ error: 'access_denied' }))
        return new Response('{}', { status: 404 })
      }),
    )
    const app = createApp({
      transcriptIndex: emptyTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      auth: createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
    })
    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const denied = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    expect(denied.status).toBe(403)
    const again = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    expect(await again.json()).toEqual({ error: 'expired_token' })
  })
})

describe('bundled web serving', () => {
  let webRoot: string
  beforeEach(() => {
    webRoot = mkdtempSync(join(tmpdir(), 'cotta-web-'))
    mkdirSync(join(webRoot, 'assets'))
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Cotta</title>')
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")')
  })
  afterEach(() => rmSync(webRoot, { recursive: true, force: true }))

  function appWithWeb() {
    // Real auth so an unauthenticated request is actually gated; proves static bypasses auth, API does not.
    const auth = createAuth({ github: { allowedUsers: 'imleon', sessionSecret: 'test-secret' } })
    return createApp({ transcriptIndex: emptyTranscriptIndex(), timelineVersionReader: () => 'timeline-missing', auth, claudeCodeApi: emptyClaudeCodeApi(), webRoot })
  }

  it('serves the SPA shell and assets to an unauthenticated visitor', async () => {
    const app = appWithWeb()
    const index = await app.request('/')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('Cotta')
    const asset = await app.request('/assets/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('app')
  })

  it('falls back to index.html for unknown non-API routes (deep links)', async () => {
    const app = appWithWeb()
    const deep = await app.request('/settings')
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('Cotta')
  })

  it('falls back to index.html for anonymous share/detail deep links', async () => {
    const app = appWithWeb()
    for (const path of ['/share/some-token', '/detail/some-token']) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Cotta')
    }
  })

  it('404s a missing asset instead of serving the HTML shell', async () => {
    const app = appWithWeb()
    const missing = await app.request('/assets/old-chunk.js')
    expect(missing.status).toBe(404)
  })

  it('still gates API routes behind auth instead of swallowing them into the SPA', async () => {
    const app = appWithWeb()
    const api = await app.request('/api/projects')
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ error: 'unauthorized' })
  })
})
