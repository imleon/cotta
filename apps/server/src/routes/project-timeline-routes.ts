import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { localImageDestinationPathname, type SessionRawMessagesResponse, type TurnSubagentsTreeResponse, type TurnSubagentTranscriptResponse, unwrapMarkdownPayloadFences } from '@cotta/shared'
import type { Context, Hono } from 'hono'
import { markdownImageDestinations } from '../local-image-turn.js'
import { ProjectReadModelError, readProjectTimeline, TimelineAnchorStaleError, TranscriptUnavailableError } from '../project-read-model.js'
import { resolveProjectRoot } from '../project-root.js'
import { readCompleteTranscriptLines } from '../session-raw-transcript-cache.js'
import { projectSubagentTranscript } from '../subagent-transcript.js'
import type { IndexedSession } from '../transcript-index-store.js'
import { inspectLocalRasterImage, isInside, MAX_AUTO_IMAGE_BYTES, MAX_LOCAL_IMAGE_BYTES, readInspectedLocalRasterImage } from './local-image-file.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'
import { createSseHeartbeat, locateSession, parseCursor, parseLimit, resolveSessionProject, resolveSessionTimelineState } from './project-routes-shared.js'

function isTimelineSseEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  if (event.type === 'result' || event.type === 'cotta_live_turn_failed') return true
  const mainSession = event.parent_tool_use_id === null && event.parent_agent_id == null && event.isSidechain !== true
  if (event.type === 'system' && event.subtype === 'local_command') return mainSession
  return (event.type === 'user' || event.type === 'assistant' || event.type === 'stream_event') && mainSession
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function messageImageDestination(rawJson: string, src: string): { cwd: string | null } | null {
  try {
    const line: unknown = JSON.parse(rawJson)
    if (!record(line) || line.type !== 'assistant' || !record(line.message) || line.message.role !== 'assistant' || !Array.isArray(line.message.content)) return null
    for (const block of line.message.content) {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      const destinations = markdownImageDestinations(unwrapMarkdownPayloadFences(block.text))
      if (!destinations.has(src)) continue
      return { cwd: typeof line.cwd === 'string' && line.cwd.trim() ? line.cwd : null }
    }
    return null
  } catch {
    return null
  }
}

async function subagentMessageVariants(input: ProjectRoutesInput, sessionId: string, agentId: string, messageUuid: string) {
  const selected = input.subagentStore?.get(sessionId, agentId)
  if (!selected?.transcriptPath) return []
  try {
    const info = await stat(selected.transcriptPath)
    const variants = []
    let cwd: string | null = null
    for (const line of await readCompleteTranscriptLines(selected.transcriptPath, 0, info.size)) {
      if (typeof line.value.cwd === 'string' && line.value.cwd.trim()) cwd = line.value.cwd
      if (line.value.type === 'assistant' && line.value.uuid === messageUuid) variants.push({ byte_offset: line.offset, owner_turn_id: null, cwd, raw_json: line.raw })
    }
    return variants
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

type LocalImageConfirmation = { canonicalPath: string; dev: string; ino: string; size: number }

function localImageConfirmation(value: unknown): LocalImageConfirmation | null {
  if (!record(value) || typeof value.canonicalPath !== 'string' || !value.canonicalPath || value.canonicalPath.includes('\0')) return null
  if (typeof value.dev !== 'string' || !/^\d+$/.test(value.dev) || typeof value.ino !== 'string' || !/^\d+$/.test(value.ino)) return null
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) return null
  return { canonicalPath: value.canonicalPath, dev: value.dev, ino: value.ino, size: value.size }
}

function localImageInput(value: unknown): { src: string; confirmedExternal: boolean; confirmedLarge: boolean; expectedConfirmation?: LocalImageConfirmation; agentId?: string } | null {
  if (!record(value) || typeof value.src !== 'string' || typeof value.confirmedExternal !== 'boolean' || typeof value.confirmedLarge !== 'boolean') return null
  const src = value.src
  if (!src || src.includes('\0') || src.includes('\\') || /^[A-Za-z]:/.test(src) || /^(?:data|blob|https?):/i.test(src)) return null
  if (value.agentId !== undefined && (typeof value.agentId !== 'string' || !value.agentId.trim())) return null
  const expectedConfirmation = value.expectedConfirmation === undefined ? undefined : localImageConfirmation(value.expectedConfirmation)
  if (value.expectedConfirmation !== undefined && !expectedConfirmation) return null
  return {
    src,
    confirmedExternal: value.confirmedExternal,
    confirmedLarge: value.confirmedLarge,
    ...(expectedConfirmation ? { expectedConfirmation } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
  }
}

function imageErrorStatus(error: string): 400 | 404 | 413 | 415 | 500 {
  if (error === 'invalid_file_path') return 400
  if (error === 'file_not_found') return 404
  if (error === 'file_too_large') return 413
  if (error === 'unsupported_file_type') return 415
  return 500
}

export function registerProjectTimelineRoutes(app: Hono, input: ProjectRoutesInput): void {
  function sessionEvents(c: Context, sessionId: string): Response {
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let unsubscribe = () => {}
        const heartbeat = createSseHeartbeat(controller, c.req.raw.signal, () => unsubscribe())
        cleanup = heartbeat.cleanup
        unsubscribe = input.liveTurnManager.subscribe(sessionId, (event) => {
          if (!isTimelineSseEvent(event)) return
          heartbeat.enqueue(`data: ${JSON.stringify(event)}\n\n`)
        })
        if (!heartbeat.enqueue(': connected\n\n')) unsubscribe()
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  app.get('/api/sessions/:sessionId/events', (c) => sessionEvents(c, c.req.param('sessionId')))

  async function sessionTimeline(c: Context, locatedSession: IndexedSession) {
    try {
      const cursor = parseCursor(c.req.query('cursor'))
      const fromTurnId = parseCursor(c.req.query('fromTurnId'))
      const anchorTurnId = parseCursor(c.req.query('anchorTurnId'))
      const scope = c.req.query('scope')
      if ([cursor, fromTurnId, anchorTurnId].filter(Boolean).length > 1) return c.json({ error: 'timeline_window_conflict' }, 400)
      if (scope && scope !== 'control') return c.json({ error: 'invalid_timeline_scope' }, 400)
      if (!locatedSession.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      const response = await readProjectTimeline(input, {
        projectId: locatedSession.currentProjectId,
        sessionId: locatedSession.sessionId,
        ...(scope === 'control' ? { scope } : {}),
        limitTurns: parseLimit(c.req.query('limitTurns'), 20, 100),
        cursor,
        fromTurnId,
        anchorTurnId,
        pendingSubmissionUuid: parseCursor(c.req.query('pendingSubmissionUuid')),
        waitContext: c.req.query('waitContext') === 'true',
      })
      return c.json(response)
    } catch (error) {
      if (error instanceof ProjectReadModelError) {
        if (error.code === 'session_not_found') return c.json({ error: error.code }, 404)
        if (error.code === 'timeline_metadata_unavailable') console.error('timeline-metadata-reader failed', error.cause)
        return c.json({ error: error.code }, 503)
      }
      if (error instanceof TimelineAnchorStaleError)
        return c.json({ error: error.kind === 'cursor' ? 'timeline_cursor_stale' : error.kind === 'anchor' ? 'timeline_anchor_stale' : 'timeline_invalidation_stale' }, 409)
      if (error instanceof TranscriptUnavailableError) return c.json({ error: 'session_raw_transcript_unavailable' }, 503)
      console.error('session:timeline failed', error)
      return c.json({ error: 'session_timeline_failed' }, 500)
    }
  }

  app.get('/api/sessions/:sessionId/timeline', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const session = locateSession(input, sessionId)
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      return sessionTimeline(c, session)
    } catch (error) {
      console.error('session:timeline failed', error)
      return c.json({ error: 'session_timeline_failed' }, 500)
    }
  })

  async function sessionRawMessages(c: Context, locatedSession: IndexedSession) {
    try {
      const turnId = c.req.query('turnId')?.trim()
      if (!turnId) return c.json({ error: 'turn_id_required' }, 400)

      if (!input.rawTranscriptCache || !input.transcriptSyncer) return c.json({ error: 'session_raw_transcript_unavailable' }, 503)
      if (!locatedSession.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      await input.transcriptSyncer(locatedSession.currentProjectId, locatedSession.sessionId, locatedSession.fileSize ?? undefined)
      const session = resolveSessionProject(input, locatedSession.sessionId)
      if (!session?.currentProjectId || !resolveSessionTimelineState(input, session)) return c.json({ error: 'session_not_found' }, 404)
      const lines = input.rawTranscriptCache.loadRawLinesForTurn(session.sessionId, turnId)
      if (!lines) return c.json({ error: 'turn_not_found' }, 404)
      return c.json({ sessionId: session.sessionId, lines } satisfies SessionRawMessagesResponse)
    } catch (error) {
      console.error('session:raw-messages failed', error)
      return c.json({ error: 'session_raw_messages_failed' }, 500)
    }
  }

  app.get('/api/sessions/:sessionId/raw-messages', async (c) => {
    try {
      const session = locateSession(input, c.req.param('sessionId'))
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      return sessionRawMessages(c, session)
    } catch (error) {
      console.error('session:raw-messages failed', error)
      return c.json({ error: 'session_raw_messages_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/messages/:messageUuid/local-image', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const located = locateSession(input, sessionId)
      if (!located?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      if (!input.rawTranscriptCache || !input.transcriptSyncer) return c.json({ error: 'session_raw_transcript_unavailable' }, 503)
      const body = localImageInput(await c.req.json().catch(() => null))
      if (!body) return c.json({ error: 'invalid_local_image_request' }, 400)

      await input.transcriptSyncer(located.currentProjectId, sessionId, located.fileSize ?? undefined)
      const session = resolveSessionProject(input, sessionId)
      if (!session?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      const variants = body.agentId
        ? await subagentMessageVariants(input, sessionId, body.agentId, c.req.param('messageUuid'))
        : input.rawTranscriptCache.loadRawLinesByUuid(sessionId, c.req.param('messageUuid'))
      const line = variants.at(-1)
      const binding = line ? messageImageDestination(line.raw_json, body.src) : null
      if (!line || !binding) return c.json({ error: 'message_not_found' }, 404)
      const src = localImageDestinationPathname(body.src)
      if (!src) return c.json({ error: 'invalid_local_image_request' }, 400)

      const ownerLines = !body.agentId && line.owner_turn_id ? input.rawTranscriptCache.loadRawLinesForTurn(sessionId, line.owner_turn_id) : null
      let cwd = binding.cwd ?? line.cwd
      if (!cwd && ownerLines) {
        const preceding = ownerLines.filter((ownerLine) => ownerLine.byte_offset <= line.byte_offset && ownerLine.cwd?.trim())
        const responseCwd = preceding.filter((ownerLine) => ownerLine.uuid !== ownerLine.owner_turn_id).at(-1)?.cwd
        const userCwd = preceding.find((ownerLine) => ownerLine.uuid === ownerLine.owner_turn_id)?.cwd
        cwd = responseCwd ?? userCwd ?? null
      }
      let path: string
      if (isAbsolute(src)) path = resolve(src)
      else {
        if (!cwd) return c.json({ error: 'local_image_cwd_unavailable' }, 409)
        path = resolve(cwd, src)
      }
      const projectResult = await resolveProjectRoot(input.claudeCodeApi, session.currentProjectId)
      if ('error' in projectResult) return c.json({ error: projectResult.error }, projectResult.error === 'project_not_found' ? 404 : 500)
      const image = await inspectLocalRasterImage(path)
      if ('error' in image) return c.json({ error: image.error }, imageErrorStatus(image.error))
      try {
        const external = !isInside(projectResult.root, image.canonicalPath)
        if (image.size > MAX_LOCAL_IMAGE_BYTES) return c.json({ error: 'file_too_large', size: image.size, external }, 413)
        const confirmation = { canonicalPath: image.canonicalPath, dev: image.dev, ino: image.ino, size: image.size }
        const expected = body.expectedConfirmation
        const confirmationMatches =
          expected?.canonicalPath === confirmation.canonicalPath && expected.dev === confirmation.dev && expected.ino === confirmation.ino && expected.size === confirmation.size
        if (
          ((body.confirmedExternal || body.confirmedLarge || expected) && !confirmationMatches) ||
          (external && !body.confirmedExternal) ||
          (image.size > MAX_AUTO_IMAGE_BYTES && !body.confirmedLarge)
        )
          return c.json({ error: 'image_confirmation_required', size: image.size, external, confirmation, ...(external ? { resolvedPath: image.canonicalPath } : {}) }, 409)
        const loaded = await readInspectedLocalRasterImage(image)
        if ('error' in loaded) return c.json({ error: loaded.error }, imageErrorStatus(loaded.error))
        c.header('Cache-Control', 'no-store')
        c.header('Content-Type', loaded.mimeType)
        c.header('Content-Disposition', 'inline')
        c.header('X-Content-Type-Options', 'nosniff')
        return c.body(new Uint8Array(loaded.bytes))
      } finally {
        await image.handle.close()
      }
    } catch (error) {
      console.error('session:local-image failed', error)
      return c.json({ error: 'local_image_failed' }, 500)
    }
  })

  app.get('/api/sessions/:sessionId/turns/:turnId/subagents/tree', async (c) => {
    try {
      const session = resolveSessionProject(input, c.req.param('sessionId'))
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      if (!input.subagentStore) return c.json({ error: 'session_subagents_unavailable' }, 503)
      const ownerTurnId = c.req.param('turnId')
      const nodes = input.subagentStore.listTurn(session.sessionId, ownerTurnId)
      const response: TurnSubagentsTreeResponse = {
        sessionId: session.sessionId,
        ownerTurnId,
        tree: nodes.map((node) => ({
          agentId: node.subagentId,
          metadataReady: node.metadataReady,
          parentAgentId: node.parentAgentId,
          agentType: node.agentType,
          name: node.name,
          description: node.description,
          model: node.model,
          transcriptVersion: node.transcriptFileSize == null || node.transcriptFileMtimeMs == null ? null : `${node.transcriptFileSize}:${node.transcriptFileMtimeMs}`,
          transcriptModifiedAtMs: node.transcriptFileMtimeMs,
        })),
      }
      return c.json(response)
    } catch (error) {
      console.error('session:subagents tree failed', error)
      return c.json({ error: 'session_subagents_failed' }, 500)
    }
  })

  app.get('/api/sessions/:sessionId/turns/:turnId/subagents/:agentId/transcript', async (c) => {
    try {
      const session = resolveSessionProject(input, c.req.param('sessionId'))
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      if (!input.subagentStore) return c.json({ error: 'session_subagents_unavailable' }, 503)
      const ownerTurnId = c.req.param('turnId')
      const agentId = c.req.param('agentId')
      const selected = input.subagentStore.listTurn(session.sessionId, ownerTurnId).find(({ subagentId }) => subagentId === agentId)
      if (!selected) return c.json({ error: 'subagent_not_found' }, 404)
      let transcript = null
      if (selected.transcriptPath) {
        try {
          transcript = await projectSubagentTranscript(selected.subagentId, selected.transcriptPath)
        } catch (error) {
          if (!((error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
        }
      }
      const response: TurnSubagentTranscriptResponse = { sessionId: session.sessionId, ownerTurnId, agentId, transcript }
      return c.json(response)
    } catch (error) {
      console.error('session:subagent transcript failed', error)
      return c.json({ error: 'subagent_transcript_failed' }, 500)
    }
  })
}
