import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionRunState } from '@cotta/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from '../database.js'
import { SessionTurnInProgressError } from '../live-turn-manager.js'
import { RequestLedger } from '../request-ledger.js'
import { createTestApp, memorySettingsStore, modelCatalog, project } from './project-routes-test-helpers.js'

const sessionId = '10000000-0000-4000-8000-000000000001'
const otherSessionId = '10000000-0000-4000-8000-000000000002'
const turnId = '00000000-0000-4000-8000-000000000001'

const roots: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function database(): Promise<DatabaseSync> {
  const root = await mkdtemp(join(tmpdir(), 'cotta-write-contract-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  databases.push(db)
  return db
}

type LiveTurnManagerOverrides = {
  startTurn?: (input: { sessionId: string; userMessageUuid: string }) => Promise<{ sessionId: string; userMessageUuid: string }>
  runStates?: Record<string, SessionRunState>
  respondToPermission?: (sessionId: string, requestId: string) => { status: 'answered' } | null
  respondToQuestion?: (sessionId: string, requestId: string) => { status: 'answered' } | null
  interrupt?: (sessionId: string, userMessageUuid?: string) => Promise<boolean>
}

async function writeApp(overrides: LiveTurnManagerOverrides = {}, options: { now?: () => number } = {}) {
  const db = await database()
  const requestLedger = new RequestLedger(db, { now: options.now })
  const startTurn = vi.fn(overrides.startTurn ?? (async (input: { sessionId: string; userMessageUuid: string }) => ({ sessionId: input.sessionId, userMessageUuid: input.userMessageUuid })))
  const interrupt = vi.fn(overrides.interrupt ?? (async () => true))
  const app = createTestApp({}, undefined, {
    requestLedger,
    settingsStore: memorySettingsStore({ modelCatalog }),
    liveTurnManager: {
      ensureRuntime: () => {},
      sessionRunState: (id: string) => overrides.runStates?.[id] ?? null,
      runtimeTurnProjection: () => null,
      clearRuntimeTurnProjection: () => {},
      startTurn,
      acknowledgeCompletedTurn: () => false,
      interrupt,
      subscribe: () => () => {},
      respondToPermission: overrides.respondToPermission ?? (() => null),
      respondToQuestion: overrides.respondToQuestion ?? (() => null),
    },
  })
  return { app, db, requestLedger, startTurn, interrupt }
}

function createSession(app: Awaited<ReturnType<typeof writeApp>>['app'], targetSessionId = sessionId, userMessageUuid = turnId) {
  return app.request(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: targetSessionId, text: 'hello', userMessageUuid }),
  })
}

function post(app: Awaited<ReturnType<typeof writeApp>>['app'], path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

describe('write request contract: turn submission', () => {
  it('returns the original result for a retried submission without running it again', async () => {
    const { app, startTurn } = await writeApp()

    const first = await createSession(app)
    const retry = await createSession(app)

    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ projectId: project.id, sessionId, userMessageUuid: turnId })
    expect(retry.status).toBe(202)
    expect(await retry.json()).toEqual({ projectId: project.id, sessionId, userMessageUuid: turnId, replayed: true })
    expect(startTurn).toHaveBeenCalledOnce()
  })

  it('lets concurrent duplicates share one execution', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { app, startTurn } = await writeApp({
      startTurn: async (input) => {
        await gate
        return { sessionId: input.sessionId, userMessageUuid: input.userMessageUuid }
      },
    })

    const first = createSession(app)
    const duplicate = createSession(app)
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    release()

    expect((await first).status).toBe(202)
    expect((await duplicate).status).toBe(202)
    expect(startTurn).toHaveBeenCalledOnce()
  })

  it('rejects a submission id reused for another session', async () => {
    const { app, startTurn } = await writeApp()

    await createSession(app)
    const reused = await createSession(app, otherSessionId)

    expect(reused.status).toBe(409)
    expect(await reused.json()).toEqual({ error: 'request_id_conflict' })
    expect(startTurn).toHaveBeenCalledOnce()
  })

  it('keeps no receipt for a rejected submission, so resending it runs normally', async () => {
    let busy = true
    const { app, startTurn } = await writeApp({
      startTurn: async (input) => {
        if (busy) throw new SessionTurnInProgressError('busy')
        return { sessionId: input.sessionId, userMessageUuid: input.userMessageUuid }
      },
    })

    expect((await createSession(app)).status).toBe(409)
    busy = false
    const resent = await createSession(app)

    expect(resent.status).toBe(202)
    expect(await resent.json()).toEqual({ projectId: project.id, sessionId, userMessageUuid: turnId })
    expect(startTurn).toHaveBeenCalledTimes(2)
  })

  it('treats a submission that is already the running turn as accepted', async () => {
    const { app, startTurn } = await writeApp({ runStates: { [sessionId]: { phase: 'running', activeUserMessageUuid: turnId, lastTurn: null } } })

    const response = await createSession(app)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ projectId: project.id, sessionId, userMessageUuid: turnId, replayed: true })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('falls back to transcript evidence once the receipt has expired', async () => {
    let now = 1_000
    const { app, db, startTurn } = await writeApp({}, { now: () => now })
    await createSession(app)
    db.prepare(
      `INSERT INTO turn_meta_transcript (project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms, primary_byte_offset, file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)`,
    ).run('project', '/transcript.jsonl', sessionId, turnId)
    now += 25 * 60 * 60 * 1000

    const retry = await createSession(app)

    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({ sessionId, userMessageUuid: turnId, replayed: true })
    expect(startTurn).toHaveBeenCalledOnce()
  })
})

describe('write request contract: submission status', () => {
  async function status(overrides: LiveTurnManagerOverrides, prepare?: (context: Awaited<ReturnType<typeof writeApp>>) => Promise<void>) {
    const context = await writeApp(overrides)
    await prepare?.(context)
    const response = await context.app.request(`/api/sessions/${sessionId}/turns/${turnId}`)
    expect(response.status).toBe(200)
    return response.json()
  }

  it('reports running, waiting and completed turns from live state', async () => {
    await expect(status({ runStates: { [sessionId]: { phase: 'running', activeUserMessageUuid: turnId, lastTurn: null } } })).resolves.toEqual({
      sessionId,
      userMessageUuid: turnId,
      status: 'running',
    })
    await expect(status({ runStates: { [sessionId]: { phase: 'requires_action', activeUserMessageUuid: turnId, lastTurn: null } } })).resolves.toMatchObject({ status: 'waiting' })
    await expect(status({ runStates: { [sessionId]: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: turnId, outcome: 'error' } } } })).resolves.toMatchObject({
      status: 'completed',
      outcome: 'error',
    })
  })

  it('reports an accepted submission whose live state is gone, and not_found when nothing arrived', async () => {
    await expect(status({}, async ({ app }) => void (await createSession(app)))).resolves.toMatchObject({ status: 'accepted' })
    await expect(status({})).resolves.toMatchObject({ status: 'not_found' })
  })
})

describe('write request contract: answers and interrupt', () => {
  it('distinguishes a retried permission answer, a conflicting one and an unknown request', async () => {
    let pending = true
    const { app } = await writeApp({
      respondToPermission: () => {
        if (!pending) return null
        pending = false
        return { status: 'answered' }
      },
    })
    const path = `/api/sessions/${sessionId}/permissions/request-1`

    const first = await post(app, path, { decision: 'allow' })
    const retry = await post(app, path, { decision: 'allow' })
    const conflicting = await post(app, path, { decision: 'deny', message: 'no' })
    const unknown = await post(app, `/api/sessions/${sessionId}/permissions/request-2`, { decision: 'allow' })

    expect(await first.json()).toEqual({ ok: true, status: 'answered' })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ok: true, status: 'already_answered' })
    expect(conflicting.status).toBe(409)
    expect(await conflicting.json()).toEqual({ error: 'permission_already_answered', decision: { decision: 'allow' } })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'permission_request_not_found' })
  })

  it('treats a retried question answer as already answered regardless of key order', async () => {
    let pending = true
    const { app } = await writeApp({
      respondToQuestion: () => {
        if (!pending) return null
        pending = false
        return { status: 'answered' }
      },
    })
    const path = `/api/sessions/${sessionId}/questions/request-1`

    await post(app, path, { behavior: 'completed', toolUseID: 'tool-1', answers: { a: '1', b: '2' } })
    const retry = await post(app, path, { answers: { b: '2', a: '1' }, toolUseID: 'tool-1', behavior: 'completed' })

    expect(await retry.json()).toEqual({ ok: true, status: 'already_answered' })
  })

  it('interrupts only the turn the client targeted', async () => {
    const { app, interrupt } = await writeApp({ interrupt: async (_sessionId, userMessageUuid) => userMessageUuid === undefined || userMessageUuid === turnId })

    const targeted = await post(app, `/api/sessions/${sessionId}/interrupt`, { userMessageUuid: turnId })
    const stale = await post(app, `/api/sessions/${sessionId}/interrupt`, { userMessageUuid: otherSessionId })
    const legacy = await post(app, `/api/sessions/${sessionId}/interrupt`)
    const invalid = await post(app, `/api/sessions/${sessionId}/interrupt`, { userMessageUuid: 'not-a-uuid' })

    expect(await targeted.json()).toEqual({ interrupted: true })
    expect(await stale.json()).toEqual({ interrupted: false })
    expect(await legacy.json()).toEqual({ interrupted: true })
    expect(invalid.status).toBe(400)
    expect(interrupt.mock.calls).toEqual([
      [sessionId, turnId],
      [sessionId, otherSessionId],
      [sessionId, undefined],
    ])
  })
})
