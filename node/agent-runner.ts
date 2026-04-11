import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG } from './config.js'
import { createOutputParser, type AgentEvent } from './agent-output-parser.js'
import type {
  ControlTransactionSummary,
  RunnerRuntimeEvent,
  SessionEvent,
  PermissionSuggestion,
} from '../shared/message-types.js'
import { normalizeSdkEnvelopeMessage } from '../shared/transcript-normalizer.js'
import { createLogger, shortId } from './logger.js'
import { appendSessionRuntimeLog, appendSessionSdkRawLog, appendSessionTransportLog } from './transport-logs.js'
export type { AgentEvent } from './agent-output-parser.js'

const logger = createLogger('agent-runner')

export interface AgentInput {
  prompt: string
  sessionId?: string
  workspacePath: string
  systemPrompt?: string
  model?: string
}

export interface AgentRunResult {
  sessionId?: string
  events: AgentEvent[]
  exitCode: number | null
  error?: string
}

export interface AgentRunHandle {
  done: Promise<AgentRunResult>
  respondToInteractive: (requestId: string, response: { kind: 'permission'; decision: 'approve' | 'deny'; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => void
  requestControl: (requestId: string, request: { subtype: 'interrupt' } | { subtype: 'get_context_usage' } | { subtype: 'mcp_status' }) => void
  cancelControl: (requestId: string) => void
  cancel: () => void
}

export type ServerEvent =
  | Extract<SessionEvent, { type: 'session.sdk.message' }>
  | Extract<SessionEvent, { type: 'session.sdk.stream_event' }>
  | Extract<SessionEvent, { type: 'session.control.message' }>
  | Extract<SessionEvent, { type: 'session.control.opened' }>
  | Extract<SessionEvent, { type: 'session.control.awaiting_user' }>
  | Extract<SessionEvent, { type: 'session.control.responded' }>
  | Extract<SessionEvent, { type: 'session.control.completed' }>
  | Extract<SessionEvent, { type: 'session.control.cancel_requested' }>
  | Extract<SessionEvent, { type: 'session.control.cancelled' }>
  | Extract<SessionEvent, { type: 'session.control.failed' }>
  | Extract<SessionEvent, { type: 'session.interactive.opened' }>
  | Extract<SessionEvent, { type: 'session.interactive.awaiting_user' }>
  | Extract<SessionEvent, { type: 'session.interactive.responded' }>
  | Extract<SessionEvent, { type: 'session.interactive.completed' }>
  | Extract<SessionEvent, { type: 'session.interactive.cancelled' }>
  | Extract<SessionEvent, { type: 'session.interactive.failed' }>
  | Extract<SessionEvent, { type: 'session.sdk.transport' }>
  | Extract<SessionEvent, { type: 'session.run.state_changed' }>

export type AgentEventHandler = (event: ServerEvent) => void

function writeCommand(child: ChildProcess, message: unknown) {
  if (!child.stdin || child.stdin.destroyed) return
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function isRunnerRuntimeEvent(value: unknown): value is RunnerRuntimeEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.type === 'string' && (
    record.type === 'run.started' ||
    record.type === 'run.state_changed' ||
    record.type === 'run.completed' ||
    record.type === 'run.failed' ||
    record.type === 'run.cancelled' ||
    record.type === 'sdk.message' ||
    record.type === 'sdk.stream_event' ||
    record.type === 'control.message' ||
    record.type === 'control.opened' ||
    record.type === 'control.awaiting_user' ||
    record.type === 'control.responded' ||
    record.type === 'control.completed' ||
    record.type === 'control.cancel_requested' ||
    record.type === 'control.cancelled' ||
    record.type === 'control.failed' ||
    record.type === 'sdk.transport' ||
    record.type === 'sdk.raw'
  )
}

function toServerEvent(runId: string, event: RunnerRuntimeEvent): ServerEvent | null {
  switch (event.type) {
    case 'run.state_changed':
      return {
        type: 'session.run.state_changed',
        runId,
        state: event.state,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'sdk.message': {
      const payloadType = typeof event.payload === 'object' && event.payload && 'type' in event.payload
        ? (event.payload as { type?: unknown }).type
        : undefined
      const parsed = normalizeSdkEnvelopeMessage(event.payload) ?? event.parsed
      if ((payloadType === 'assistant' || payloadType === 'user') && !parsed) {
        logger.warn('runner:normalize:missing-parsed', {
          runId: shortId(runId),
          sessionId: shortId(event.sessionId),
          payloadType,
          sequence: event.sequence,
        })
      }
      return {
        type: 'session.sdk.message',
        runId,
        payload: event.payload,
        ...(parsed ? { parsed } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    }
    case 'sdk.stream_event':
      return {
        type: 'session.sdk.stream_event',
        runId,
        event: event.event,
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.message':
      return {
        type: 'session.control.message',
        runId,
        direction: event.direction,
        message: event.message,
        transaction: event.transaction,
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.opened':
      return {
        type: 'session.control.opened',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.opened':
      return {
        type: 'session.interactive.opened',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.awaiting_user':
      return {
        type: 'session.control.awaiting_user',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.awaiting_user':
      return {
        type: 'session.interactive.awaiting_user',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.responded':
      return {
        type: 'session.control.responded',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.responded':
      return {
        type: 'session.interactive.responded',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.completed':
      return {
        type: 'session.control.completed',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.completed':
      return {
        type: 'session.interactive.completed',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.cancel_requested':
      return {
        type: 'session.control.cancel_requested',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.cancelled':
      return {
        type: 'session.control.cancelled',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.cancelled':
      return {
        type: 'session.interactive.cancelled',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'control.failed':
      return {
        type: 'session.control.failed',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'interactive.failed':
      return {
        type: 'session.interactive.failed',
        runId,
        transaction: event.transaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'sdk.transport':
      return {
        type: 'session.sdk.transport',
        runId,
        event: event.event,
      }
    default:
      return null
  }
}

function getEventSessionId(event: RunnerRuntimeEvent): string | undefined {
  return event.type === 'sdk.transport' || event.type === 'sdk.raw' ? event.event.sessionId : event.sessionId
}

function attachSessionId(event: RunnerRuntimeEvent, sessionId: string): RunnerRuntimeEvent {
  if (event.type === 'sdk.transport') {
    return {
      ...event,
      event: {
        ...event.event,
        sessionId,
      },
    }
  }
  if (event.type === 'sdk.raw') {
    return {
      ...event,
      event: {
        ...event.event,
        sessionId,
      },
    }
  }
  return {
    ...event,
    sessionId,
  }
}

export function createAgentRun(input: AgentInput, onEvent: AgentEventHandler, signal?: AbortSignal, runId: string = randomUUID()): AgentRunHandle {
  const agentPath = resolve(CONFIG.agentRunnerPath)
  const events: AgentEvent[] = []
  let sessionId: string | undefined = input.sessionId
  let stderrOutput = ''
  const pendingRuntimeEvents: RunnerRuntimeEvent[] = []

  async function persistRuntimeEvent(event: RunnerRuntimeEvent) {
    const eventSessionId = getEventSessionId(event)
    if (!eventSessionId) {
      pendingRuntimeEvents.push(event)
      return
    }

    const flushTargets = pendingRuntimeEvents.splice(0, pendingRuntimeEvents.length)
    for (const pendingEvent of [...flushTargets, event]) {
      const hydrated = getEventSessionId(pendingEvent) ? pendingEvent : attachSessionId(pendingEvent, eventSessionId)
      await appendSessionRuntimeLog(runId, hydrated)
      if (hydrated.type === 'sdk.transport') {
        await appendSessionTransportLog(runId, hydrated.event)
      }
      if (hydrated.type === 'sdk.raw') {
        await appendSessionSdkRawLog(runId, hydrated.event)
      }
    }
  }

  const child: ChildProcess = spawn('npx', ['tsx', agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=4096',
    },
    cwd: process.cwd(),
  })

  const timeout = setTimeout(() => {
    logger.warn('runner:timeout', {
      runId: shortId(runId),
      pid: child.pid,
      timeoutMs: CONFIG.agentTimeoutMs,
    })
    child.kill('SIGTERM')
    setTimeout(() => {
      child.kill('SIGKILL')
    }, 5000)
  }, CONFIG.agentTimeoutMs)

  if (signal) {
    signal.addEventListener('abort', () => {
      child.kill('SIGTERM')
    }, { once: true })
  }

  const parser = createOutputParser((event) => {
    events.push(event)
    if (!isRunnerRuntimeEvent(event)) return

    const runtimeSessionId = getEventSessionId(event)
    if (runtimeSessionId) sessionId = runtimeSessionId

    void persistRuntimeEvent(event).catch((error) => {
      logger.error('runner:runtime-log:append-error', {
        runId: shortId(runId),
        sessionId: shortId(runtimeSessionId || sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
    })

    const serverEvent = toServerEvent(runId, event)
    if (serverEvent) onEvent(serverEvent)
  })

  child.stdout!.on('data', (data: Buffer) => {
    parser.feed(data.toString())
  })

  child.stderr!.on('data', (data: Buffer) => {
    const text = data.toString()
    stderrOutput += text
    if (text.trim()) {
      logger.error('runner:stderr', {
        runId: shortId(runId),
        pid: child.pid,
        output: text.trim().slice(-300),
      })
    }
  })

  const done = new Promise<AgentRunResult>((resolvePromise, reject) => {
    child.on('error', (err) => {
      clearTimeout(timeout)
      parser.flush()
      logger.error('runner:error', {
        runId: shortId(runId),
        pid: child.pid,
        error: err instanceof Error ? err.message : String(err),
      })
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      parser.flush()
      resolvePromise({
        sessionId,
        events,
        exitCode: code,
        error: code !== 0 ? stderrOutput.slice(-500) : undefined,
      })
    })
  })

  writeCommand(child, { type: 'run.start', input })

  return {
    done,
    respondToInteractive(requestId, response) {
      writeCommand(child, { type: 'interactive.respond', requestId, response })
    },
    requestControl(requestId, request) {
      writeCommand(child, { type: 'control.request', requestId, request })
    },
    cancelControl(requestId) {
      writeCommand(child, { type: 'control.cancel', requestId })
    },
    cancel() {
      onEvent({ type: 'session.run.state_changed', runId, state: 'cancelled', ...(sessionId ? { sessionId } : {}) })
      writeCommand(child, { type: 'run.cancel' })
      child.kill('SIGTERM')
    },
  }
}

export function runAgent(input: AgentInput, onEvent: AgentEventHandler, signal?: AbortSignal, runId?: string): Promise<AgentRunResult> {
  return createAgentRun(input, onEvent, signal, runId).done
}
