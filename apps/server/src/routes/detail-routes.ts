import type { DetailResponse, TurnSummary } from '@cotta/shared'
import type { Hono } from 'hono'
import { decodeDetailToken } from '../detail-token.js'
import { resolveTurnImagePath } from '../local-image-turn.js'
import { ProjectReadModelError, readProjectTimeline, TimelineAnchorStaleError, TranscriptUnavailableError } from '../project-read-model.js'
import { resolveProjectRoot } from '../project-root.js'
import { inspectLocalRasterImage, isInside, MAX_AUTO_IMAGE_BYTES, readInspectedLocalRasterImage } from './local-image-file.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** Reads the live source turn behind a Detail token, or null if the token is bad or the turn is gone. No persistence. */
async function detailTurn(input: ProjectRoutesInput, token: string): Promise<{ projectId: string; turn: TurnSummary } | null> {
  if (!input.detailTokenKey) return null
  const identity = decodeDetailToken(token, input.detailTokenKey)
  if (!identity) return null
  try {
    const response = await readProjectTimeline(input, {
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      anchorTurnId: identity.turnId,
      limitTurns: 1,
      cursor: null,
      fromTurnId: null,
      pendingSubmissionUuid: null,
      waitContext: false,
      acknowledgeCompletedTurn: false,
    })
    if (!('turns' in response)) return null
    const turn = response.turns.find((candidate) => candidate.primaryUserUuid === identity.turnId)
    return turn ? { projectId: identity.projectId, turn } : null
  } catch (error) {
    if (error instanceof ProjectReadModelError || error instanceof TimelineAnchorStaleError || error instanceof TranscriptUnavailableError) return null
    console.error('detail:read failed', error)
    return null
  }
}

export function registerDetailRoutes(app: Hono, input: ProjectRoutesInput): void {
  app.get('/api/detail/:token', async (c) => {
    // Every failure mode (bad key, malformed/unknown/forged token, deleted source turn) returns the same
    // indistinguishable "unavailable" response — no existence or identity signal leaks.
    const unavailable = () => c.json({ error: 'detail_unavailable' }, 404, NO_STORE)
    const resolved = await detailTurn(input, c.req.param('token'))
    return resolved ? c.json({ turn: resolved.turn } satisfies DetailResponse, 200, NO_STORE) : unavailable()
  })

  // Anonymous local-image bytes for the Detail page. Served live from disk (recordless), authorized by the token's
  // own turn: only images that turn's markdown references are reachable, so the token can't read arbitrary files.
  // Out-of-project or large images need an explicit click (`confirmed=1`), mirroring the Timeline; the 409 carries no
  // path, size or reason. The token only reaches its owner (Lark p2p card), so confirmation is intent, not identity.
  app.get('/api/detail/:token/asset', async (c) => {
    const unavailable = () => c.json({ error: 'detail_unavailable' }, 404, NO_STORE)
    const src = c.req.query('src')
    if (!src) return unavailable()
    const confirmed = c.req.query('confirmed') === '1'
    const resolved = await detailTurn(input, c.req.param('token'))
    if (!resolved) return unavailable()
    const path = resolveTurnImagePath(resolved.turn, src)
    if (!path) return unavailable()
    const root = await resolveProjectRoot(input.claudeCodeApi, resolved.projectId)
    if ('error' in root) return unavailable()
    const image = await inspectLocalRasterImage(path)
    if ('error' in image) return unavailable()
    try {
      if (!confirmed && (!isInside(root.root, image.canonicalPath) || image.size > MAX_AUTO_IMAGE_BYTES)) return c.json({ error: 'image_confirmation_required' }, 409, NO_STORE)
      const loaded = await readInspectedLocalRasterImage(image)
      if ('error' in loaded) return unavailable()
      c.header('Cache-Control', 'no-store')
      c.header('Content-Type', loaded.mimeType)
      c.header('Content-Disposition', 'inline')
      c.header('X-Content-Type-Options', 'nosniff')
      return c.body(new Uint8Array(loaded.bytes))
    } finally {
      await image.handle.close()
    }
  })
}
