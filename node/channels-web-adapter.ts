import { randomUUID } from 'node:crypto'
import type { UpgradeWebSocket } from 'hono/ws'
import type { SessionEvent, PermissionSuggestion } from '../shared/message-types.js'
import type { ElicitationAction, PermissionDecision, RunCoordinator } from './run-coordinator.js'
import { appendSessionChannelLog } from './transport-logs.js'
import { createLogger, shortId } from './logger.js'

const logger = createLogger('web-adapter')

type ActiveRunState = {
  runId: string
}

type HostControlRequest =
  | { subtype: 'interrupt' }
  | { subtype: 'get_context_usage' }
  | { subtype: 'mcp_status' }

function sendSocketEvent(ws: any, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload))
  } catch (error) {
    logger.error('ws:send:error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function sendSessionEvent(ws: any, event: SessionEvent) {
  sendSocketEvent(ws, event)
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value)
}

async function appendWebChannelLog(params: {
  sessionId?: string
  runId?: string
  direction: 'inbound' | 'outbound' | 'internal'
  eventName: string
  conversationKey?: string
  payloadSummary?: string
  payload?: unknown
}) {
  if (!isSafeSessionId(params.sessionId)) return
  await appendSessionChannelLog(params.sessionId, {
    source: 'channel',
    channel: 'web',
    direction: params.direction,
    eventName: params.eventName,
    ...(params.conversationKey ? { conversationKey: params.conversationKey } : {}),
    ...(params.payloadSummary ? { payloadSummary: params.payloadSummary } : {}),
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
  }, params.runId)
}


function isStructuredResponseContent(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function handleInteractiveResponse(
  ws: any,
  coordinator: RunCoordinator,
  runId: string,
  interactionId: string,
  response: { kind: 'permission'; decision: PermissionDecision; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: ElicitationAction; content?: Record<string, unknown> },
) {
  const ok = coordinator.respondToInteractive(runId, interactionId, response)
  if (!ok) {
    sendSessionEvent(ws, { type: 'session.error', runId, error: 'No matching active run for interactive response' })
  }
}

function handleControlRequest(ws: any, coordinator: RunCoordinator, runId: string, request: HostControlRequest) {
  const requestId = `${request.subtype}:${Date.now()}`
  const ok = coordinator.requestControl(runId, requestId, request)
  if (!ok) {
    sendSessionEvent(ws, { type: 'session.error', runId, error: `No matching active run for control request: ${request.subtype}` })
  }
}

export function createWebSocketHandler(upgradeWebSocket: UpgradeWebSocket, coordinator: RunCoordinator) {
  return upgradeWebSocket(() => {
    let activeRun: ActiveRunState | null = null
    const connId = shortId(randomUUID())
    const subscriberKey = `web:${connId}`
    let forwardedEvents = 0

    logger.info('ws:connect', { connId })

    return {
      onOpen(_evt, ws) {
        coordinator.subscribe(subscriberKey, (event: SessionEvent) => {
          if (!activeRun) return
          const eventRunId = 'runId' in event ? event.runId : undefined
          if (eventRunId !== activeRun.runId) return
          if (event.type === 'session.sdk.transport') return

          sendSessionEvent(ws, event)
          void appendWebChannelLog({
            sessionId: 'sessionId' in event ? event.sessionId : undefined,
            runId: eventRunId,
            direction: 'outbound',
            eventName: event.type,
            payloadSummary: event.type,
          })
          if (event.type === 'session.run.completed' || event.type === 'session.run.failed' || event.type === 'session.run.cancelled') {
            activeRun = null
          }
        })
      },
      onMessage: async (evt, ws) => {
        try {
          const raw = typeof evt.data === 'string' ? evt.data : ''
          const data = JSON.parse(raw)

          if (data.action === 'message.create' && data.prompt) {
            if (activeRun && coordinator.getRun(activeRun.runId)) {
              sendSessionEvent(ws, { type: 'session.error', runId: activeRun.runId, error: 'Another run is already active' })
              return
            }

            const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
            const conversationKey = sessionId || `conn:${connId}`
            void appendWebChannelLog({
              sessionId,
              direction: 'inbound',
              eventName: 'message.create',
              conversationKey,
              payloadSummary: typeof data.prompt === 'string' ? data.prompt : 'message.create',
            })
            const run = await coordinator.startRun({
              channel: 'web',
              conversationKey,
              text: data.prompt,
              ...(sessionId ? { sessionId } : {}),
            })
            activeRun = { runId: run.runId }
            return
          }

          if (data.action === 'interactive.respond' && data.runId && data.interactionId && data.kind) {
            void appendWebChannelLog({
              sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
              runId: data.runId,
              direction: 'inbound',
              eventName: 'interactive.respond',
              payloadSummary: data.kind,
              payload: {
                interactionId: data.interactionId,
                kind: data.kind,
                response: data.response,
              },
            })
            handleInteractiveResponse(
              ws,
              coordinator,
              data.runId,
              data.interactionId,
              data.kind === 'permission'
                ? {
                    kind: 'permission' as const,
                    decision: data.response?.decision as PermissionDecision,
                    ...(data.response?.selectedSuggestion !== undefined ? { selectedSuggestion: data.response.selectedSuggestion as PermissionSuggestion | null | undefined } : {}),
                    ...(data.response?.content !== undefined ? { content: data.response.content as Record<string, string | number | boolean | string[]> } : {}),
                  }
                : {
                    kind: 'elicitation' as const,
                    action: data.response?.action as ElicitationAction,
                    ...(data.response?.content !== undefined ? { content: data.response.content as Record<string, unknown> } : {}),
                  },
            )
            return
          }

          if (data.action === 'control.request' && data.runId && (data.subtype === 'interrupt' || data.subtype === 'get_context_usage' || data.subtype === 'mcp_status')) {
            void appendWebChannelLog({
              sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
              runId: data.runId,
              direction: 'inbound',
              eventName: 'control.request',
              payloadSummary: data.subtype,
              payload: { subtype: data.subtype },
            })
            handleControlRequest(ws, coordinator, data.runId, { subtype: data.subtype })
            return
          }

          if (data.action === 'run.cancel') {
            void appendWebChannelLog({
              sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
              runId: activeRun?.runId,
              direction: 'inbound',
              eventName: 'run.cancel',
              payloadSummary: 'cancel',
            })
            if (activeRun) {
              coordinator.cancelRun(activeRun.runId)
              activeRun = null
            }
            return
          }
        } catch (error) {
          logger.warn('ws:message:invalid-json', {
            connId,
            error: error instanceof Error ? error.message : String(error),
          })
          sendSessionEvent(ws, { type: 'session.error', error: 'Invalid message' })
        }
      },
      onClose() {
        coordinator.unsubscribe(subscriberKey)
        activeRun = null
      },
    }
  })
}
