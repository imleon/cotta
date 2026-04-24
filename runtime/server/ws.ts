import { randomUUID } from 'node:crypto'
import type { UpgradeWebSocket } from 'hono/ws'
import type { Orchestrator } from '../orchestration/orchestrator.js'
import type { ExternalAdminWsEvent, SessionEvent } from '../protocol/index.js'
import { createLogger, shortId } from './logger.js'

const logger = createLogger('websocket')

function sendSocketEvent(ws: { send: (data: string) => void }, payload: ExternalAdminWsEvent) {
  try {
    ws.send(JSON.stringify(payload))
  } catch (error) {
    logger.error('ws:send:error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function matchesFilter(
  event: SessionEvent,
  sessionId?: string,
  runId?: string,
): boolean {
  if (sessionId && event.sessionId !== sessionId) return false
  if (runId && (!('runId' in event) || event.runId !== runId)) return false
  return true
}

export function createWebSocketHandler(
  upgradeWebSocket: UpgradeWebSocket,
  input: { orchestrator: Orchestrator },
) {
  const { orchestrator } = input
  return upgradeWebSocket((c) => {
    const connId = shortId(randomUUID())
    const subscriberKey = `web:${connId}`
    const sessionId = c.req.query('sessionId')?.trim() || undefined
    const runId = c.req.query('runId')?.trim() || undefined

    logger.info('ws:connect', {
      connId,
      sessionId: sessionId ? shortId(sessionId) : null,
      runId: runId ? shortId(runId) : null,
    })

    return {
      onOpen(_evt, ws) {
        orchestrator.subscribeSessionEvents(subscriberKey, (event) => {
          if (!matchesFilter(event, sessionId, runId)) return
          sendSocketEvent(ws, event)
        })
      },
      onMessage(evt, ws) {
        const raw = typeof evt.data === 'string' ? evt.data : ''
        if (!raw) return
        sendSocketEvent(ws, {
          type: 'ws.notice',
          message: 'WebSocket is read-only; use HTTP /api/runs to create runs.',
        })
      },
      onClose() {
        orchestrator.unsubscribeSessionEvents(subscriberKey)
        logger.info('ws:close', { connId })
      },
    }
  })
}
