import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SessionContextUsage, sessionRawMessagesResponseSchema, sessionTimelineControlResponseSchema, sessionTimelineResponseSchema, turnSubagentsTreeResponseSchema } from '@cotta/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeApi } from '../claude-code-api.js'
import { createApp } from '../index.js'
import { TimelineAnchorStaleError } from '../session-raw-transcript-cache.js'
import type { SessionSubagentStore } from '../session-subagent-store.js'
import { sessionActivityVersion } from './project-routes-shared.js'
import {
  createTestApp,
  memoryRawTranscriptCache,
  memoryTranscriptIndex,
  messages,
  modelCatalog,
  project,
  rawLines,
  type TimestampedSessionMessage,
  timelineState,
} from './project-routes-test-helpers.js'
import { registerProjectRoutes } from './projects.js'

const imageRoots: string[] = []
afterEach(async () => {
  await Promise.all(imageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const firstMessage = messages[0]
const assistantMessage = messages[1]
if (!firstMessage || !assistantMessage || assistantMessage.type !== 'assistant') throw new Error('timeline message fixtures required')

const markdownImageMessage = (markdown: string, cwd?: string): TimestampedSessionMessage =>
  ({
    ...assistantMessage,
    uuid: 'assistant-image',
    ...(cwd ? { cwd } : {}),
    message: { id: 'msg_assistant_image', type: 'message', role: 'assistant', content: [{ type: 'text', text: markdown }] },
  }) as TimestampedSessionMessage

const imageMessage = (src: string, cwd?: string): TimestampedSessionMessage => markdownImageMessage(`Rendered ![output](<${src}>)`, cwd)

async function localImageFixture(size = pngHeader.length) {
  const root = await mkdtemp(join(tmpdir(), 'cotta-local-image-'))
  imageRoots.push(root)
  const projectPath = join(root, 'project')
  const externalPath = join(root, 'external')
  await mkdir(projectPath)
  await mkdir(externalPath)
  const bytes = Buffer.alloc(size)
  pngHeader.copy(bytes)
  await writeFile(join(projectPath, 'image.png'), bytes)
  await writeFile(join(externalPath, 'outside.png'), bytes)
  const indexed = memoryTranscriptIndex()
  const transcriptIndex = {
    getSession(sessionId: string) {
      const session = indexed.getSession(sessionId)
      return session ? { ...session, currentCwd: projectPath } : null
    },
  }
  const claudeCodeApi = {
    getProject: async (id: string) => (id === project.id ? { ...project, path: projectPath } : null),
  } as ClaudeCodeApi
  const request = (
    src: string,
    options: {
      agentId?: string
      confirmedExternal?: boolean
      confirmedLarge?: boolean
      expectedConfirmation?: { canonicalPath: string; dev: string; ino: string; size: number }
      message?: TimestampedSessionMessage
      messages?: TimestampedSessionMessage[]
      messageUuid?: string
      subagentStore?: SessionSubagentStore
    } = {},
  ) => {
    const fixtureMessages = options.messages ?? [firstMessage, options.message ?? imageMessage(src, projectPath)]
    return createTestApp({}, fixtureMessages, { transcriptIndex, claudeCodeApi, ...(options.subagentStore ? { subagentStore: options.subagentStore } : {}) }).request(
      `/api/sessions/session-newest/messages/${options.messageUuid ?? 'assistant-image'}/local-image`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src,
          confirmedExternal: options.confirmedExternal ?? false,
          confirmedLarge: options.confirmedLarge ?? false,
          ...(options.expectedConfirmation ? { expectedConfirmation: options.expectedConfirmation } : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
        }),
      },
    )
  }
  return { root, projectPath, externalPath, request }
}

describe('project timeline routes', () => {
  it('serves only the raster path exactly bound to the assistant message', async () => {
    const { projectPath, request } = await localImageFixture()
    const response = await request('image.png')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('inline')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pngHeader)
    expect((await request(join(projectPath, 'image.png'), { message: imageMessage('image.png', projectPath) })).status).toBe(404)
    expect((await request('image.png', { messageUuid: 'other' })).status).toBe(404)
  })

  it('resolves reference-style Markdown image destinations', async () => {
    const { projectPath, request } = await localImageFixture()

    expect((await request('image.png', { message: markdownImageMessage('![output][Ref Name]\n\n[ref   name]: image.png', projectPath) })).status).toBe(200)
    expect((await request('image.png', { message: markdownImageMessage('[REF NAME]: image.png\n\n![output][ref name]', projectPath) })).status).toBe(200)
    expect((await request('image.png', { message: markdownImageMessage('[ref]: missing.png\n[REF]: image.png\n\n![output][ref]', projectPath) })).status).toBe(404)
  })

  it('resolves a percent-encoded Markdown image source only after exact binding', async () => {
    const { projectPath, request } = await localImageFixture()
    await writeFile(join(projectPath, 'image name.png'), pngHeader)
    await writeFile(join(projectPath, '截图 甲.png'), pngHeader)
    await writeFile(join(projectPath, 'image?name.png'), pngHeader)

    expect((await request('image%20name.png', { message: imageMessage('image name.png', projectPath) })).status).toBe(200)
    expect((await request('%E6%88%AA%E5%9B%BE%20%E7%94%B2.png', { message: imageMessage('截图 甲.png', projectPath) })).status).toBe(200)
    expect((await request('image%20name.png', { message: imageMessage('image%20name.png', projectPath) })).status).toBe(200)
    expect((await request('image%3Fname.png', { message: imageMessage('image%3Fname.png', projectPath) })).status).toBe(200)
    expect((await request('image name.png', { message: imageMessage('image name.png', projectPath) })).status).toBe(404)
    expect(await (await request('invalid%zz.png', { message: imageMessage('invalid%zz.png', projectPath) })).json()).toEqual({ error: 'invalid_local_image_request' })
  })

  it('uses only the latest message variant for image authorization', async () => {
    const { projectPath, request } = await localImageFixture()
    const oldVariant = imageMessage('image.png', projectPath)
    const latestVariant = markdownImageMessage('Image removed', projectPath)

    expect((await request('image.png', { messages: [firstMessage, oldVariant, latestVariant] })).status).toBe(404)
  })

  it('uses rendered Markdown payloads and local destination pathnames', async () => {
    const { projectPath, request } = await localImageFixture()
    const fenced = ['```md', '![output](image.png)', '', '````text', 'nested', '````', '```'].join('\n')

    expect((await request('image.png', { message: markdownImageMessage(fenced, projectPath) })).status).toBe(200)
    expect((await request('image.png?v=2#preview', { message: imageMessage('image.png?v=2#preview', projectPath) })).status).toBe(200)
  })

  it('supports exact absolute references and preceding owner cwd fallback', async () => {
    const { projectPath, request } = await localImageFixture()
    const absolute = join(projectPath, 'image.png')
    expect((await request(absolute, { message: imageMessage(absolute) })).status).toBe(200)

    const withoutCwd = imageMessage('image.png')
    expect((await request('image.png', { message: withoutCwd, messages: [{ ...firstMessage, cwd: projectPath } as TimestampedSessionMessage, withoutCwd] })).status).toBe(200)
    expect(
      (
        await request('image.png', {
          message: withoutCwd,
          messages: [withoutCwd, { ...assistantMessage, uuid: 'later', cwd: projectPath } as TimestampedSessionMessage],
        })
      ).status,
    ).toBe(409)
  })

  it('uses inherited Subagent cwd for relative image paths', async () => {
    const { root, projectPath, request } = await localImageFixture()
    const transcriptPath = join(root, 'agent.jsonl')
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({ type: 'user', uuid: 'agent-user', cwd: projectPath, message: { role: 'user', content: 'Inspect' } }),
        JSON.stringify({ type: 'assistant', uuid: 'assistant-image', message: { role: 'assistant', content: [{ type: 'text', text: '![output](image.png)' }] } }),
      ].join('\n')}\n`,
    )
    const subagentStore = { get: () => ({ transcriptPath }) } as unknown as SessionSubagentStore

    expect((await request('image.png', { agentId: 'agent-1', subagentStore })).status).toBe(200)
  })

  it('binds external and large confirmations to the inspected file identity', async () => {
    const size = 5 * 1024 * 1024 + 1
    const { externalPath, request } = await localImageFixture(size)
    const src = join(externalPath, 'outside.png')
    const message = imageMessage(src, externalPath)
    const external = await request(src, { message })
    expect(external.status).toBe(409)
    const challenge = (await external.json()) as {
      error: string
      size: number
      external: boolean
      resolvedPath: string
      confirmation: { canonicalPath: string; dev: string; ino: string; size: number }
    }
    expect(challenge).toMatchObject({ error: 'image_confirmation_required', size, external: true, resolvedPath: src, confirmation: { canonicalPath: src, size } })
    expect(challenge.confirmation.dev).toMatch(/^\d+$/)
    expect(challenge.confirmation.ino).toMatch(/^\d+$/)

    const missingIdentity = await request(src, { message, confirmedExternal: true })
    expect(missingIdentity.status).toBe(409)
    expect(await missingIdentity.json()).toEqual(challenge)
    const large = await request(src, { message, confirmedExternal: true, expectedConfirmation: challenge.confirmation })
    expect(large.status).toBe(409)
    expect(await large.json()).toEqual(challenge)
    expect((await request(src, { message, confirmedExternal: true, confirmedLarge: true, expectedConfirmation: challenge.confirmation })).status).toBe(200)
  })

  it('returns a new confirmation instead of reading a same-path same-size replacement', async () => {
    const { externalPath, request } = await localImageFixture()
    const src = join(externalPath, 'outside.png')
    const message = imageMessage(src, externalPath)
    const first = await request(src, { message })
    const firstBody = (await first.json()) as { confirmation: { canonicalPath: string; dev: string; ino: string; size: number } }
    await rename(src, join(externalPath, 'replaced.png'))
    await writeFile(src, pngHeader)

    const retry = await request(src, { message, confirmedExternal: true, expectedConfirmation: firstBody.confirmation })
    expect(retry.status).toBe(409)
    const retryBody = (await retry.json()) as { confirmation: { canonicalPath: string; dev: string; ino: string; size: number } }
    expect(retryBody.confirmation).toMatchObject({ canonicalPath: src, size: pngHeader.length })
    expect(retryBody.confirmation.ino).not.toBe(firstBody.confirmation.ino)
    expect((await request(src, { message, confirmedExternal: true, expectedConfirmation: retryBody.confirmation })).status).toBe(200)
  })

  it('accepts canonical path aliases and requires confirmation for external symlink destinations', async () => {
    const { root, projectPath, externalPath, request } = await localImageFixture()
    const projectAlias = join(root, 'project-alias')
    await symlink(projectPath, projectAlias)
    const aliasedImage = join(projectAlias, 'image.png')
    expect((await request(aliasedImage, { message: imageMessage(aliasedImage, projectPath) })).status).toBe(200)

    await symlink(externalPath, join(projectPath, 'linked'))
    const message = imageMessage('linked/outside.png', projectPath)
    const external = await request('linked/outside.png', { message })
    expect(external.status).toBe(409)
    const challenge = (await external.json()) as { confirmation: { canonicalPath: string; dev: string; ino: string; size: number } }
    expect(challenge).toMatchObject({
      error: 'image_confirmation_required',
      size: pngHeader.length,
      external: true,
      resolvedPath: join(externalPath, 'outside.png'),
      confirmation: { canonicalPath: join(externalPath, 'outside.png'), size: pngHeader.length },
    })
    expect((await request('linked/outside.png', { message, confirmedExternal: true, expectedConfirmation: challenge.confirmation })).status).toBe(200)
  })

  it('rejects oversized, invalid-scheme, non-image, and mismatched-signature paths', async () => {
    const { root, projectPath, externalPath, request } = await localImageFixture(25 * 1024 * 1024 + 1)
    const oversized = join(projectPath, 'image.png')
    expect((await request(oversized, { message: imageMessage(oversized, projectPath), confirmedLarge: true })).status).toBe(413)

    await writeFile(join(projectPath, 'text.png'), 'not an image')
    expect((await request('text.png', { message: imageMessage('text.png', projectPath) })).status).toBe(415)
    await writeFile(join(projectPath, 'wrong.jpg'), pngHeader)
    expect((await request('wrong.jpg', { message: imageMessage('wrong.jpg', projectPath) })).status).toBe(415)
    await writeFile(join(externalPath, 'outside.png'), pngHeader)
    const externalSrc = '../external/outside.png'
    const externalMessage = imageMessage(externalSrc, projectPath)
    const externalChallenge = (await (await request(externalSrc, { message: externalMessage })).json()) as {
      confirmation: { canonicalPath: string; dev: string; ino: string; size: number }
    }
    expect((await request(externalSrc, { message: externalMessage, confirmedExternal: true, confirmedLarge: true, expectedConfirmation: externalChallenge.confirmation })).status).toBe(200)
    const encodedExternal = '..%2Fexternal%2Foutside.png'
    const encodedResponse = await request(encodedExternal, { message: imageMessage(encodedExternal, projectPath) })
    expect(encodedResponse.status).toBe(409)
    expect(await encodedResponse.json()).toMatchObject({
      error: 'image_confirmation_required',
      size: pngHeader.length,
      external: true,
      resolvedPath: join(externalPath, 'outside.png'),
      confirmation: { canonicalPath: join(externalPath, 'outside.png'), size: pngHeader.length },
    })
    for (const src of ['http://example.com/image.png', 'data:image/png;base64,AA==', 'blob:test', 'C:\\image.png', 'bad\\path.png', 'nul\0.png'])
      expect((await request(src, { message: imageMessage(src, projectPath) })).status).toBe(400)
    expect(root).toBeTruthy()
  })

  it('rejects missing cwd, non-assistant messages, and non-Markdown sources', async () => {
    const { request } = await localImageFixture()
    const noCwd = imageMessage('image.png')
    expect((await request('image.png', { message: noCwd, messages: [noCwd] })).status).toBe(409)
    expect((await request('image.png', { messages: [firstMessage] })).status).toBe(404)
    const image = imageMessage('image.png')
    if (image.type !== 'assistant') throw new Error('assistant fixture required')
    const plain = { ...image, message: { id: 'msg_assistant_image', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'image.png' }] } } as TimestampedSessionMessage
    expect((await request('image.png', { message: plain })).status).toBe(404)
    const code = { ...image, message: { id: 'msg_assistant_image', type: 'message', role: 'assistant', content: [{ type: 'text', text: '`![output](image.png)`' }] } } as TimestampedSessionMessage
    expect((await request('image.png', { message: code })).status).toBe(404)
  })

  it('includes pending approval identity in activity versions', () => {
    const activity = { owner: 'cotta' as const, phase: 'waiting' as const, activeTurnId: 'turn-1' }
    const request = { requestId: 'request-1', toolUseID: 'tool-1', toolName: 'Read', input: {} }

    expect(sessionActivityVersion({ activity, pendingPermission: request })).toBe('activity=cotta:waiting:turn-1:request-1:tool-1')
    expect(sessionActivityVersion({ activity, pendingPermission: { ...request, requestId: 'request-2' } })).not.toBe(sessionActivityVersion({ activity, pendingPermission: request }))
  })

  it('returns a turn-based timeline page for a session', async () => {
    const transcriptSyncer = vi.fn()
    const response = await createTestApp({}, messages, { transcriptSyncer }).request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(200)
    expect(transcriptSyncer).toHaveBeenCalledTimes(1)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.sessionId).toBe('session-newest')
    expect(body.turns).toHaveLength(1)
    expect(body.turns[0]?.primaryUserUuid).toBe('user-2')
    expect(body.turns[0]?.primaryUserTimestampMs).toBe(Date.parse('2026-07-14T08:01:00.000Z'))
    expect(body.turns[0]?.messages).toEqual(messages.slice(2))
    expect(body.hasMore).toBe(true)
    expect(body.hasNewer).toBe(false)
    expect(body.nextCursor).toBe('user-2')
    expect(body.anchorTurnId).toBeNull()
    expect(body.contextUsage).toBeNull()
    expect(body.runState).toBeNull()
    expect(body.activity).toEqual({ owner: null, phase: 'idle', activeTurnId: null })
    expect(body.pendingPermission).toBeNull()
    expect(body.state).toEqual(timelineState)
  })

  it('acknowledges a completed turn only when its timeline window contains it', async () => {
    const acknowledgeCompletedTurn = vi.fn(() => true)
    const response = await createTestApp({ 'session-newest': { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } } }, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: (sessionId: string) => (sessionId === 'session-newest' ? { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } } : null),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        interrupt: async () => false,
        subscribe: () => () => {},
        acknowledgeCompletedTurn,
      },
    }).request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(200)
    expect(sessionTimelineResponseSchema.parse(await response.json()).turns[0]?.primaryUserUuid).toBe('user-2')
    expect(acknowledgeCompletedTurn).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', turnId: 'user-2' })
  })

  it('returns only the requested runtime projection and acknowledges only when its visible turn is in the window', async () => {
    let acknowledged = false
    const acknowledgeCompletedTurn = vi.fn(() => {
      acknowledged = true
      return true
    })
    const runtimeTurnProjection = vi.fn((_sessionId: string, submissionUuid?: string) => {
      if (submissionUuid === 'submission-1') return { submissionUuid, kind: 'visible' as const, visibleTurnUuid: 'user-2' }
      if (submissionUuid === 'submission-old') return { submissionUuid, kind: 'terminal-only' as const }
      return null
    })
    const liveTurnManager = {
      ensureRuntime: () => {},
      sessionRunState: () => ({ phase: 'idle' as const, activeUserMessageUuid: null, ...(acknowledged ? {} : { lastTurn: { id: 'submission-1', outcome: 'success' as const } }) }),
      runtimeTurnProjection,
      clearRuntimeTurnProjection: () => {},
      startTurn: async () => {
        throw new Error('not implemented')
      },
      interrupt: async () => false,
      subscribe: () => () => {},
      acknowledgeCompletedTurn,
    }
    const app = createTestApp({}, messages, { liveTurnManager })

    const initial = await app.request('/api/sessions/session-newest/timeline')
    expect(sessionTimelineResponseSchema.parse(await initial.json()).runtimeTurnProjection).toEqual({ submissionUuid: 'submission-1', kind: 'visible', visibleTurnUuid: 'user-2' })
    expect(runtimeTurnProjection).toHaveBeenLastCalledWith('session-newest', 'submission-1')
    expect(acknowledgeCompletedTurn).toHaveBeenCalledOnce()
    expect(acknowledgeCompletedTurn).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', turnId: 'submission-1' })

    const retry = await app.request('/api/sessions/session-newest/timeline?pendingSubmissionUuid=submission-1')
    expect(sessionTimelineResponseSchema.parse(await retry.json()).runtimeTurnProjection).toEqual({ submissionUuid: 'submission-1', kind: 'visible', visibleTurnUuid: 'user-2' })
    expect(runtimeTurnProjection).toHaveBeenLastCalledWith('session-newest', 'submission-1')

    const old = await app.request('/api/sessions/session-newest/timeline?pendingSubmissionUuid=submission-old')
    expect(sessionTimelineResponseSchema.parse(await old.json()).runtimeTurnProjection).toEqual({ submissionUuid: 'submission-old', kind: 'terminal-only' })
    expect(runtimeTurnProjection).toHaveBeenLastCalledWith('session-newest', 'submission-old')

    const missing = await app.request('/api/sessions/session-newest/timeline?pendingSubmissionUuid=missing')
    expect(sessionTimelineResponseSchema.parse(await missing.json()).runtimeTurnProjection).toBeNull()
    expect(runtimeTurnProjection).toHaveBeenLastCalledWith('session-newest', 'missing')

    const unscoped = await app.request('/api/sessions/session-newest/timeline')
    expect(sessionTimelineResponseSchema.parse(await unscoped.json()).runtimeTurnProjection).toBeNull()
    expect(runtimeTurnProjection).toHaveBeenCalledTimes(4)

    await app.request('/api/sessions/session-newest/timeline?limitTurns=1&anchorTurnId=user-1&pendingSubmissionUuid=submission-1')
    expect(acknowledgeCompletedTurn).toHaveBeenCalledOnce()
  })

  it('acknowledges terminal-only projection only from the default complete tail and omits projection from control', async () => {
    const acknowledgeCompletedTurn = vi.fn(() => true)
    const liveTurnManager = {
      ensureRuntime: () => {},
      sessionRunState: () => ({ phase: 'idle' as const, activeUserMessageUuid: null, lastTurn: { id: 'submission-1', outcome: 'success' as const } }),
      runtimeTurnProjection: () => ({ submissionUuid: 'submission-1', kind: 'terminal-only' as const }),
      clearRuntimeTurnProjection: () => {},
      startTurn: async () => {
        throw new Error('not implemented')
      },
      interrupt: async () => false,
      subscribe: () => () => {},
      acknowledgeCompletedTurn,
    }

    const control = await (await createTestApp({}, messages, { liveTurnManager }).request('/api/sessions/session-newest/timeline?scope=control')).json()
    expect(control).not.toHaveProperty('runtimeTurnProjection')
    expect(acknowledgeCompletedTurn).not.toHaveBeenCalled()

    await createTestApp({}, messages, { liveTurnManager }).request('/api/sessions/session-newest/timeline?cursor=user-2')
    expect(acknowledgeCompletedTurn).not.toHaveBeenCalled()
    await createTestApp({}, messages, { liveTurnManager }).request('/api/sessions/session-newest/timeline')
    expect(acknowledgeCompletedTurn).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', turnId: 'submission-1' })
  })

  it('does not acknowledge a completed turn from a control read', async () => {
    const acknowledgeCompletedTurn = vi.fn(() => true)
    const response = await createTestApp({ 'session-newest': { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } } }, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: (sessionId: string) => (sessionId === 'session-newest' ? { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } } : null),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        interrupt: async () => false,
        subscribe: () => () => {},
        acknowledgeCompletedTurn,
      },
    }).request('/api/sessions/session-newest/timeline?scope=control')

    expect(response.status).toBe(200)
    expect(acknowledgeCompletedTurn).not.toHaveBeenCalled()
  })

  it('rejects transcript-backed reads for stale rows but allows control reads', async () => {
    const indexed = memoryTranscriptIndex()
    const transcriptIndex = {
      getSession(sessionId: string) {
        const session = indexed.getSession(sessionId)
        return session ? { ...session, transcriptPath: null, fileSize: null, fileMtimeMs: null } : null
      },
    }
    const app = createTestApp({}, messages, { transcriptIndex })

    expect((await app.request('/api/sessions/session-newest/timeline')).status).toBe(404)
    expect((await app.request('/api/sessions/session-newest/timeline?scope=control')).status).toBe(200)
  })

  it('returns control-only timeline state without reading transcript windows', async () => {
    const loadTimelineWindow = vi.fn(() => {
      throw new Error('unreachable')
    })
    const transcriptSyncer = vi.fn()
    const response = await createTestApp({}, messages, {
      transcriptSyncer,
      rawTranscriptCache: { ...memoryRawTranscriptCache(messages), loadTimelineWindow },
      timelineVersionReader: () => 'timeline-control-v1',
    }).request('/api/sessions/session-newest/timeline?scope=control')

    expect(response.status).toBe(200)
    expect(transcriptSyncer).not.toHaveBeenCalled()
    const raw = await response.json()
    expect('turns' in raw).toBe(false)
    expect('hasMore' in raw).toBe(false)
    expect('hasNewer' in raw).toBe(false)
    expect('nextCursor' in raw).toBe(false)
    expect('snapshotFromTurnId' in raw).toBe(false)
    expect('anchorTurnId' in raw).toBe(false)
    expect(sessionTimelineControlResponseSchema.parse(raw)).toEqual({
      sessionId: 'session-newest',
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      state: { ...timelineState, version: 'timeline-control-v1' },
      tasks: [],
    })
    expect(loadTimelineWindow).not.toHaveBeenCalled()
  })

  it('returns null when the task snapshot is unknown', async () => {
    const indexed = memoryTranscriptIndex()
    const response = await createTestApp({}, messages, {
      transcriptIndex: {
        getSession(sessionId) {
          const session = indexed.getSession(sessionId)
          return session ? { ...session, taskSnapshot: null } : null
        },
      },
    }).request('/api/sessions/session-newest/timeline?scope=control')

    expect(response.status).toBe(200)
    expect(sessionTimelineControlResponseSchema.parse(await response.json()).tasks).toBeNull()
  })

  it('includes the current pending permission in timeline responses', async () => {
    const pendingPermission = { requestId: 'request-1', toolUseID: 'tool-1', toolName: 'AskUserQuestion', input: { questions: [] } }
    const response = await createTestApp({}, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => ({ phase: 'requires_action', activeUserMessageUuid: 'user-2', pendingPermission }),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
    }).request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.runState).toEqual({ phase: 'requires_action', activeUserMessageUuid: 'user-2', pendingPermission })
    expect(body.activity).toEqual({ owner: 'cotta', phase: 'waiting', activeTurnId: 'user-2' })
    expect(body.pendingPermission).toEqual(pendingPermission)
  })

  it('projects task-only Cotta runtime activity as background', async () => {
    const response = await createTestApp({}, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        liveBackgroundTasks: () => [{ taskId: 'task-1', taskType: 'local_bash' }],
        sessionRunState: () => ({ phase: 'idle', activeUserMessageUuid: null }),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
    }).request('/api/sessions/session-newest/timeline?scope=control')

    const body = sessionTimelineControlResponseSchema.parse(await response.json())
    expect(body.liveBackgroundTasks).toEqual([{ taskId: 'task-1', taskType: 'local_bash' }])
    expect(body.activity).toEqual({ owner: 'cotta', phase: 'background', activeTurnId: null })
  })

  it('includes external activity in timeline responses', async () => {
    const response = await createTestApp({}, messages, {
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'busy', hasRunningShell: false, kind: 'bg', entrypoint: 'cli' }) },
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
    }).request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(200)
    expect(sessionTimelineResponseSchema.parse(await response.json()).activity).toEqual({ owner: 'external', phase: 'busy', activeTurnId: null })
  })

  it('includes cached context usage in timeline responses', async () => {
    const contextUsage = {
      model: 'claude-sonnet-5',
      categories: [{ name: 'Messages', tokens: 1200, kind: 'used' }],
      totalTokens: 1500,
      autoCompactThreshold: 160000,
      maxTokens: 200000,
      percentage: 1,
      updatedAtMs: 123,
    }
    const runtimeContextUsage = vi.fn()
    const response = await createTestApp({}, messages, {
      sessionContextUsageStore: { getContextUsage: () => contextUsage, setContextUsage: () => {} } as any,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
        contextUsage: runtimeContextUsage,
      },
    }).request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.contextUsage).toEqual(contextUsage)
    expect(runtimeContextUsage).not.toHaveBeenCalled()
  })

  it('waits for fresh context usage when requested', async () => {
    const cachedContextUsage = { model: 'cached-model', categories: [], totalTokens: 10, autoCompactThreshold: null, maxTokens: 200, percentage: 5, updatedAtMs: 1 }
    const freshContextUsage = {
      model: 'fresh-model',
      categories: [{ name: 'Messages', tokens: 20, kind: 'used' }],
      totalTokens: 20,
      autoCompactThreshold: null,
      maxTokens: 200,
      percentage: 10,
      updatedAtMs: 2,
    } satisfies SessionContextUsage
    const runtimeContextUsage = vi.fn(async () => freshContextUsage)
    const response = await createTestApp({}, messages, {
      sessionContextUsageStore: { getContextUsage: () => cachedContextUsage, setContextUsage: () => {} } as any,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
        contextUsage: runtimeContextUsage,
      },
    }).request('/api/sessions/session-newest/timeline?limitTurns=1&waitContext=true')

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.contextUsage).toEqual(freshContextUsage)
    expect(runtimeContextUsage).toHaveBeenCalledWith('session-newest', true)
  })

  it('rejects mutually exclusive timeline window modes', async () => {
    const response = await createTestApp().request('/api/sessions/session-newest/timeline?cursor=user-1&anchorTurnId=user-2')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'timeline_window_conflict' })
  })

  it.each([
    ['O20', 'cursor=missing', 'cursor', 'timeline_cursor_stale'],
    ['O21', 'fromTurnId=missing', 'invalidation', 'timeline_invalidation_stale'],
    ['S09', 'anchorTurnId=missing', 'anchor', 'timeline_anchor_stale'],
  ] as const)('%s: returns a distinct 409 for a stale timeline anchor', async (_scenario, query, kind, error) => {
    const loadTimelineWindow = vi.fn((_sessionId: string, options: { limitTurns: number; cursor: string | null; fromTurnId: string | null; anchorTurnId?: string | null }) => {
      throw new TimelineAnchorStaleError(options.cursor ? 'cursor' : options.anchorTurnId ? 'anchor' : 'invalidation')
    })
    const app = new Hono()
    registerProjectRoutes(app, {
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {},
      rawTranscriptCache: {
        loadTimelineWindow,
        adjacentTurnIds: () => null,
        loadRawLinesForTurn: () => null,
        loadRawLinesByUuid: () => [],
      },
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request(`/api/sessions/session-newest/timeline?${query}`)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error })
    expect(loadTimelineWindow).toHaveBeenCalledWith('session-newest', {
      limitTurns: 20,
      cursor: kind === 'cursor' ? 'missing' : null,
      fromTurnId: kind === 'invalidation' ? 'missing' : null,
      anchorTurnId: kind === 'anchor' ? 'missing' : null,
    })
  })

  it('returns a bounded anchor timeline window with newer-state metadata', async () => {
    const response = await createTestApp().request('/api/sessions/session-newest/timeline?limitTurns=1&anchorTurnId=user-1')

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    expect(body.hasMore).toBe(false)
    expect(body.hasNewer).toBe(true)
    expect(body.nextCursor).toBeNull()
    expect(body.anchorTurnId).toBe('user-1')
    expect(body.snapshotFromTurnId).toBeNull()
  })

  it('O29: supplements an out-of-window task notification on the tool call turn once', async () => {
    const fixture = [
      messages[2]!,
      { ...messages[3]!, message: { id: 'msg_assistant_2', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call_123', name: 'Agent', input: { prompt: 'Investigate' } }] } },
      messages[4]!,
    ] as TimestampedSessionMessage[]
    const app = new Hono()
    registerProjectRoutes(app, {
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {},
      rawTranscriptCache: memoryRawTranscriptCache(fixture),
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request('/api/sessions/session-newest/timeline?limitTurns=1')
    const body = sessionTimelineResponseSchema.parse(await response.json())

    expect(body.turns).toHaveLength(1)
    expect(body.turns[0]?.primaryUserUuid).toBe('user-2')
    expect(body.turns[0]?.messages.map((message) => (message as { uuid?: string }).uuid).filter((uuid) => uuid === 'task-notification-1')).toEqual(['task-notification-1'])
  })

  it('uses the canonical timeline version in timeline responses', async () => {
    const app = new Hono()
    registerProjectRoutes(app, {
      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {},
      rawTranscriptCache: memoryRawTranscriptCache(messages),
      timelineVersionReader: () => 'timeline-canonical-v1',
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request('/api/sessions/session-newest/timeline?limitTurns=1')
    const body = sessionTimelineResponseSchema.parse(await response.json())

    expect(body.state).toEqual({ ...timelineState, version: 'timeline-canonical-v1' })
  })

  it('returns 503 when persistent history is not cached', async () => {
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {
        throw new (await import('../session-raw-transcript-cache.js')).TranscriptUnavailableError('session-newest')
      },
      rawTranscriptCache: {
        loadTimelineWindow: () => {
          throw new Error('unreachable')
        },
        adjacentTurnIds: () => null,
        loadRawLinesForTurn: () => null,
        loadRawLinesByUuid: () => [],
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })
    const response = await app.request('/api/sessions/session-newest/timeline?limitTurns=20')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'session_raw_transcript_unavailable' })
  })

  it('awaits the injected timeline metadata reader', async () => {
    const app = new Hono()
    const timelineMetadataReader = vi.fn(async () => ({
      turnMetadata: new Map([['user-2', { durationMs: 12_345, durationTimestampMs: 1_752_470_490_000, entrypoint: 'sdk-ts', pendingBackgroundAgentCount: 2, awaySummary: 'Turn recap' }]]),
      turnOptions: { permissionMode: 'plan' as const, model: 'claude-opus-5', effort: 'high' as const },
    }))
    registerProjectRoutes(app, {
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {},
      rawTranscriptCache: memoryRawTranscriptCache(messages),
      timelineMetadataReader,
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request('/api/sessions/session-newest/timeline?limitTurns=1')
    const body = sessionTimelineResponseSchema.parse(await response.json())

    expect(body.turns[0]).toMatchObject({ durationMs: 12_345, durationTimestampMs: 1_752_470_490_000, entrypoint: 'sdk-ts', pendingBackgroundAgentCount: 2, awaySummary: 'Turn recap' })
    expect(body.turnOptions).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })
    expect(timelineMetadataReader).toHaveBeenCalledWith(project.id, 'session-newest')
  })

  it('uses synchronized transcript primary history for timeline and raw turn lookup', async () => {
    const synced = vi.fn()
    const metadata = vi.fn(() => ({
      turnMetadata: new Map([['user-1', { awaySummary: null }]]),
      turnOptions: { permissionMode: null, model: null, effort: null },
      scanByteOffset: timelineState.fileSize,
      scannedFileSize: timelineState.fileSize,
    }))
    const direct = new Hono()
    registerProjectRoutes(direct, {
      transcriptIndex: memoryTranscriptIndex(),
      timelineVersionReader: () => 'timeline-missing',
      transcriptSyncer: synced,
      timelineMetadataReader: metadata,
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      rawTranscriptCache: (() => {
        const fixture = [
          messages[0]!,
          messages[1]!,
          {
            type: 'user',
            uuid: 'orphan-notification',
            session_id: 'session-newest',
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { role: 'user', content: '<task-notification><task-id>orphan</task-id><status>stopped</status></task-notification>' },
          } as unknown as TimestampedSessionMessage,
        ]
        const cache = memoryRawTranscriptCache(fixture)
        return {
          ...cache,
          loadTimelineWindow: (sessionId: string, options: { limitTurns: number; cursor: string | null; fromTurnId: string | null; anchorTurnId?: string | null }) => {
            const window = cache.loadTimelineWindow(sessionId, options)
            return {
              ...window,
              primaryTurns: [{ uuid: 'user-1', timestamp: Date.parse(messages[0]!.timestamp!), userCwd: '/repo/start', responseCwd: '/repo/end' }],
              ownedMessages: fixture.map((message) => ({ ownerTurnId: 'user-1', message })),
            }
          },
          loadRawLinesForTurn: () => null,
          loadRawLinesByUuid: () => [],
        }
      })(),
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const timelineResponse = await direct.request('/api/sessions/session-newest/timeline')
    const timeline = sessionTimelineResponseSchema.parse(await timelineResponse.json())
    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    expect(timeline.turns[0]).toMatchObject({ userCwd: '/repo/start', responseCwd: '/repo/end' })
    expect(timeline.turns[0]?.messages).toHaveLength(3)
    expect((await direct.request('/api/sessions/session-newest/raw-messages?turnId=orphan-notification')).status).toBe(404)
    expect(synced).toHaveBeenNthCalledWith(1, project.id, 'session-newest', timelineState.fileSize)
    expect(synced).toHaveBeenNthCalledWith(2, project.id, 'session-newest', timelineState.fileSize)
  })

  it('returns 503 when the timeline metadata reader fails instead of a silently degraded timeline', async () => {
    const app = new Hono()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerProjectRoutes(app, {
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: memoryTranscriptIndex(),
      transcriptSyncer: async () => {},
      rawTranscriptCache: memoryRawTranscriptCache(messages),
      timelineMetadataReader: async () => {
        throw new Error('sidecar failed')
      },
      modelCatalogProvider: async () => modelCatalog,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request('/api/sessions/session-newest/timeline?limitTurns=1')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'timeline_metadata_unavailable' })
    errorSpy.mockRestore()
  })

  it('keeps user-authored task-notification wrappers as user messages', async () => {
    const literalTaskTagMessages: TimestampedSessionMessage[] = [
      {
        type: 'user',
        uuid: 'literal-task-tag-user',
        session_id: 'session-newest',
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: '2026-07-14T08:02:00.000Z',
        message: { role: 'user', content: '<task-notification>...</task-notification>' },
      },
    ]
    const response = await createTestApp({}, literalTaskTagMessages).request('/api/sessions/session-newest/timeline')

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.turns).toHaveLength(1)
    expect(body.turns[0]?.primaryUserUuid).toBe('literal-task-tag-user')
    expect(body.turns[0]?.messages).toEqual(literalTaskTagMessages)
  })
  it('reads the subagent tree from cache without refreshing it', async () => {
    const refreshSubagentIndex = vi.fn(async () => true)
    const response = await createTestApp({}, messages, {
      refreshSubagentIndex,
      subagentStore: {
        countsByTurn: () => new Map(),
        listTurn: () => [
          {
            sessionId: 'session-newest',
            subagentId: 'agent-1',
            ownerTurnId: 'user-1',
            isRoot: true,
            metadataReady: true,
            parentAgentId: null,
            agentType: 'Explore',
            name: 'worker',
            description: 'Inspect files',
            model: 'sonnet',
            metaPath: '/tmp/agent-1.meta.json',
            metaFileSize: 10,
            metaFileMtimeMs: 20,
            transcriptPath: '/tmp/agent-1.jsonl',
            transcriptFileSize: 12,
            transcriptFileMtimeMs: 34,
            observedAtMs: 30,
            metaJson: {},
          },
        ],
      } as Pick<SessionSubagentStore, 'countsByTurn' | 'listTurn'> as SessionSubagentStore,
    }).request('/api/sessions/session-newest/turns/user-1/subagents/tree')

    expect(response.status).toBe(200)
    expect(turnSubagentsTreeResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      ownerTurnId: 'user-1',
      tree: [
        {
          agentId: 'agent-1',
          metadataReady: true,
          parentAgentId: null,
          agentType: 'Explore',
          name: 'worker',
          description: 'Inspect files',
          model: 'sonnet',
          transcriptVersion: '12:34',
          transcriptModifiedAtMs: 34,
        },
      ],
    })
    expect(refreshSubagentIndex).not.toHaveBeenCalled()
  })

  it('streams allowed live events without DB replay', async () => {
    const user = { type: 'user', uuid: 'turn-live', parent_tool_use_id: null }
    const delta = { type: 'stream_event', uuid: 'stream-live', parent_tool_use_id: null, event: { type: 'content_block_delta' } }
    const nestedAssistant = { type: 'assistant', uuid: 'nested-assistant', parent_tool_use_id: 'agent-call' }
    const nestedAgentAssistant = { type: 'assistant', uuid: 'nested-agent-assistant', parent_tool_use_id: null, parent_agent_id: 'agent-1' }
    const sidechainAssistant = { type: 'assistant', uuid: 'sidechain-assistant', parent_tool_use_id: null, isSidechain: true }
    const system = { type: 'system', subtype: 'task_progress', uuid: 'system-live' }
    const localCommand = {
      type: 'system',
      subtype: 'local_command',
      uuid: 'command-live',
      parent_tool_use_id: null,
      content: '<command-name>/model</command-name><command-message>model</command-message>',
    }
    const backgroundTasks = { type: 'system', subtype: 'background_tasks_changed', uuid: 'background-live', session_id: 'session-live', tasks: [] }
    const live = { type: 'result', subtype: 'success' }
    let subscriber: ((event: any) => void) | undefined
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => ({ phase: 'running', activeUserMessageUuid: 'turn-live', lastTurn: null }),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: (_sessionId, next) => {
          subscriber = next
          return () => {}
        },
      },
    })

    const response = await app.request('/api/sessions/session-live/events')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const connected = decoder.decode((await reader.read()).value)
    subscriber?.(user)
    subscriber?.(delta)
    subscriber?.(nestedAssistant)
    subscriber?.(nestedAgentAssistant)
    subscriber?.(sidechainAssistant)
    subscriber?.(system)
    subscriber?.(localCommand)
    subscriber?.(backgroundTasks)
    subscriber?.(live)
    let chunk = ''
    while (!chunk.includes(JSON.stringify(live))) chunk += decoder.decode((await reader.read()).value)
    await reader.cancel()

    expect(connected).toBe(': connected\n\n')
    expect(chunk).toContain(`data: ${JSON.stringify(user)}\n\n`)
    expect(chunk).toContain(`data: ${JSON.stringify(delta)}\n\n`)
    expect(chunk).toContain(`data: ${JSON.stringify(localCommand)}\n\n`)
    expect(chunk).not.toContain(JSON.stringify(backgroundTasks))
    expect(chunk).toContain(`data: ${JSON.stringify(live)}\n\n`)
    expect(chunk).not.toContain('nested-assistant')
    expect(chunk).not.toContain('nested-agent-assistant')
    expect(chunk).not.toContain('sidechain-assistant')
    expect(chunk).not.toContain('system-live')
    expect(chunk).not.toContain('id: undefined')
  })

  it('ignores Last-Event-ID for live-only events', async () => {
    const response = await createTestApp().request('/api/sessions/session-live/events', { headers: { 'Last-Event-ID': 'abc' } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    await reader.cancel()

    expect(response.status).toBe(200)
    expect(first).toBe(': connected\n\n')
  })

  it('releases live event subscribers when SSE is already aborted', async () => {
    const unsubscribe = vi.fn()
    const abortController = new AbortController()
    abortController.abort()
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => unsubscribe,
      },
    }).request('/api/sessions/session-live/events', { signal: abortController.signal })

    expect(response.status).toBe(200)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('resolves a session id to its current project', async () => {
    const app = createTestApp()
    const found = await app.request('/api/sessions/session-newest/project')
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ projectId: project.id })

    const missing = await app.request('/api/sessions/session-unknown/project')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'session_not_found' })
  })

  it.each([
    ['', '/raw-messages'],
    ['blank', '/raw-messages?turnId=%20%20'],
  ])('requires a trimmed non-empty turn id for raw messages (%s)', async (_case, suffix) => {
    const response = await createTestApp().request(`/api/sessions/session-newest${suffix}`)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'turn_id_required' })
  })

  it('returns sqlite raw lines for one turn', async () => {
    const transcriptSyncer = vi.fn()
    const response = await createTestApp({}, messages, { transcriptSyncer }).request('/api/sessions/session-newest/raw-messages?turnId=user-1')

    expect(response.status).toBe(200)
    expect(transcriptSyncer).toHaveBeenCalledTimes(1)
    expect(sessionRawMessagesResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      lines: rawLines.slice(0, 2),
    })
  })

  it('returns sqlite raw lines through eof for the last turn', async () => {
    const response = await createTestApp().request('/api/sessions/session-newest/raw-messages?turnId=user-2')

    expect(response.status).toBe(200)
    expect(sessionRawMessagesResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      lines: rawLines.slice(2),
    })
  })

  it('returns raw lines from the supplied transcript fixture', async () => {
    const fixture = [
      { ...messages[0]!, uuid: 'fixture-user' },
      { ...messages[1]!, uuid: 'fixture-assistant' },
    ] as TimestampedSessionMessage[]
    const response = await createTestApp({}, fixture).request('/api/sessions/session-newest/raw-messages?turnId=fixture-user')

    expect(response.status).toBe(200)
    expect(sessionRawMessagesResponseSchema.parse(await response.json()).lines.map((line) => line.uuid)).toEqual(['fixture-user', 'fixture-assistant'])
  })

  it('returns 503 for turn trace when sqlite raw cache is unavailable', async () => {
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
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
        async getSessionTimelineState() {
          return timelineState
        },
      },
    })

    const response = await app.request('/api/sessions/session-newest/raw-messages?turnId=user-2')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'session_raw_transcript_unavailable' })
  })

  it('returns 404 for a leading response-only id', async () => {
    const response = await createTestApp({}, [messages[1]!, messages[0]!]).request('/api/sessions/session-newest/raw-messages?turnId=assistant-1')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'turn_not_found' })
  })

  it('returns 404 for an unknown turn', async () => {
    const response = await createTestApp().request('/api/sessions/session-newest/raw-messages?turnId=missing')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'turn_not_found' })
  })

  it('returns 404 for raw messages of an unknown session', async () => {
    const response = await createTestApp().request('/api/sessions/missing/raw-messages?turnId=user-1')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })
})
