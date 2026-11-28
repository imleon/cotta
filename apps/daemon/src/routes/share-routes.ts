import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetailResponse, ShareListResponse, ShareSummary, TurnSummary } from '@cotta/shared'
import type { Context, Hono } from 'hono'
import type { CottaAuth } from '../auth.js'
import { projectDisplayMetadataFromPath, sessionTitle } from '../claude-code-api.js'
import { shareAssetsRoot } from '../database.js'
import { decodeDetailToken } from '../detail-token.js'
import { projectPathFromId } from '../project-path.js'
import { ProjectReadModelError, readProjectTimeline, TimelineAnchorStaleError, TranscriptUnavailableError } from '../project-read-model.js'
import { materializeShareAssets } from '../share-assets.js'
import { newShareToken, type ShareStore } from '../share-store.js'
import type { TranscriptIndexStore } from '../transcript-index-store.js'
import { readSettings } from '../turn-options.js'
import { readLocalRasterImage } from './local-image-file.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' } as const

/** Reads a single settled, share-eligible turn, or null if ineligible/unavailable. Authoritative server-side recheck. */
async function eligibleTurn(input: ProjectRoutesInput, projectId: string, sessionId: string, turnId: string): Promise<TurnSummary | null> {
  try {
    const response = await readProjectTimeline(input, {
      projectId,
      sessionId,
      anchorTurnId: turnId,
      limitTurns: 1,
      cursor: null,
      fromTurnId: null,
      pendingSubmissionUuid: null,
      waitContext: false,
      acknowledgeCompletedTurn: false,
    })
    if (!('turns' in response)) return null
    const turn = response.turns.find((candidate) => candidate.primaryUserUuid === turnId)
    return turn?.shareEligible ? turn : null
  } catch (error) {
    if (error instanceof ProjectReadModelError || error instanceof TimelineAnchorStaleError || error instanceof TranscriptUnavailableError) return null
    throw error
  }
}

/** Anonymous share surfaces: read a snapshot, and create (reusing an active share) by Detail token or (session,turn). */
export function registerShareRoutes(app: Hono, input: ProjectRoutesInput, auth: CottaAuth): void {
  // Sharing is off unless a public base URL is configured; the same switch gates create, read, the Detail routes, and the Lark button.
  const sharingEnabled = () => !!readSettings(input.settingsStore).publicBaseUrl

  app.get('/api/share/:token', (c) => {
    const unavailable = () => c.json({ error: 'share_unavailable' }, 404, NO_STORE)
    if (!sharingEnabled()) return unavailable()
    const record = input.shareStore?.getByToken(c.req.param('token'))
    if (!record) return unavailable()
    return c.json({ turn: record.snapshot } satisfies DetailResponse, 200, NO_STORE)
  })

  // Anonymous local-image bytes for the Share page, served from the frozen snapshot's manifest. The manifest IS the
  // authorization: only index-named files that were materialized at create time are reachable; src never hits the fs.
  app.get('/api/share/:token/asset', async (c) => {
    const unavailable = () => c.json({ error: 'share_unavailable' }, 404, NO_STORE)
    if (!sharingEnabled()) return unavailable()
    const token = c.req.param('token')
    const src = c.req.query('src')
    const record = src ? input.shareStore?.getByToken(token) : null
    const asset = record?.assets.find((candidate) => candidate.src === src)
    if (!asset?.file) return unavailable()
    const loaded = await readLocalRasterImage(join(shareAssetsRoot(token), asset.file))
    if ('error' in loaded) return unavailable()
    c.header('Cache-Control', IMMUTABLE['Cache-Control'])
    c.header('Content-Type', loaded.mimeType)
    c.header('Content-Disposition', 'inline')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(new Uint8Array(loaded.bytes))
  })

  app.post('/api/share', async (c) => {
    if (!input.shareStore) return c.json({ error: 'share_unavailable' }, 503, NO_STORE)
    if (!sharingEnabled()) return c.json({ error: 'sharing_disabled' }, 403, NO_STORE)
    let body: { detailToken?: unknown; projectId?: unknown; sessionId?: unknown; turnId?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'invalid_request' }, 400, NO_STORE)
    }
    // Resolve the target identity. A bearer Detail token is itself the capability (anonymous). The explicit
    // (project, session, turn) form carries no capability — internal UUIDs aren't secret — so it requires auth.
    let projectId: string
    let sessionId: string
    let turnId: string
    if (typeof body.detailToken === 'string' && input.detailTokenKey) {
      const identity = decodeDetailToken(body.detailToken, input.detailTokenKey)
      if (!identity) return c.json({ error: 'invalid_request' }, 400, NO_STORE)
      ;({ projectId, sessionId, turnId } = identity)
    } else if (typeof body.projectId === 'string' && typeof body.sessionId === 'string' && typeof body.turnId === 'string') {
      if (!auth.currentUser(c)) return c.json({ error: 'unauthorized' }, 401, NO_STORE)
      projectId = body.projectId
      sessionId = body.sessionId
      turnId = body.turnId
    } else {
      return c.json({ error: 'invalid_request' }, 400, NO_STORE)
    }
    const turn = await eligibleTurn(input, projectId, sessionId, turnId)
    if (!turn) return c.json({ error: 'not_shareable' }, 409, NO_STORE)
    const existing = input.shareStore.getByTurn(sessionId, turnId)
    if (existing) return c.json({ token: existing.token }, 200, NO_STORE)
    // Immutable snapshot: freeze local-image bytes and sanitize under a fresh token first, then insert the complete row.
    // A concurrent create that won the insert meanwhile is reused instead, and this attempt's assets are discarded.
    const token = newShareToken()
    let materialized: Awaited<ReturnType<typeof materializeShareAssets>>
    try {
      materialized = await materializeShareAssets(token, turn)
    } catch (error) {
      console.error('share:create asset materialize failed', error)
      await rm(shareAssetsRoot(token), { recursive: true, force: true })
      return c.json({ error: 'share_asset_failed' }, 500, NO_STORE)
    }
    const { record, reused } = (() => {
      try {
        return input.shareStore.createOrReuse({ token, projectId, sessionId, turnId, ...materialized })
      } catch (error) {
        void rm(shareAssetsRoot(token), { recursive: true, force: true })
        throw error
      }
    })()
    if (reused) await rm(shareAssetsRoot(token), { recursive: true, force: true })
    return c.json({ token: record.token }, 200, NO_STORE)
  })
}

/** Authenticated share management: list and revoke. Registered after auth so these require a session. */
export function registerShareAdminRoutes(app: Hono, shareStore: ShareStore | undefined, auth: CottaAuth, transcriptIndex: Pick<TranscriptIndexStore, 'getSession'>): void {
  const requireUser = (c: Context) => (auth.currentUser(c) ? null : c.json({ error: 'unauthorized' }, 401))
  app.get('/api/shares', (c) => {
    const denied = requireUser(c)
    if (denied) return denied
    if (!shareStore) return c.json({ error: 'share_unavailable' }, 503)
    const cursorRaw = c.req.query('cursor')
    const cursor = cursorRaw ? Number(cursorRaw) : null
    if (cursor !== null && !Number.isFinite(cursor)) return c.json({ error: 'invalid_cursor' }, 400)
    const { items, nextCursor } = shareStore.list(cursor, 50)
    const shares = items.map((item): ShareSummary => {
      const projectPath = projectPathFromId(item.projectId)
      const session = transcriptIndex.getSession(item.sessionId)
      const title = session ? sessionTitle(session) : undefined
      return {
        ...item,
        ...(projectPath ? { projectName: projectDisplayMetadataFromPath(projectPath).name } : {}),
        ...(title && title !== item.sessionId ? { sessionTitle: title } : {}),
      }
    })
    return c.json({ shares, nextCursor: nextCursor === null ? null : String(nextCursor) } satisfies ShareListResponse)
  })

  app.post('/api/share/:token/revoke', async (c) => {
    const denied = requireUser(c)
    if (denied) return denied
    if (!shareStore) return c.json({ error: 'share_unavailable' }, 503)
    const token = c.req.param('token')
    const record = shareStore.revoke(token)
    if (record) {
      try {
        await rm(shareAssetsRoot(token), { recursive: true, force: true })
      } catch (error) {
        console.error('share:revoke asset cleanup failed', error)
        return c.json({ error: 'share_revoke_cleanup_failed' }, 500)
      }
    }
    return c.json({ ok: true })
  })
}
