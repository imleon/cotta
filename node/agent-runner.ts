import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG } from './config.js'
import { createOutputParser, type AgentEvent } from './agent-output-parser.js'
import type { RunnerRuntimeEvent, SessionEvent, PermissionSuggestion } from '../shared/message-types.js'
import { createLogger, shortId } from './logger.js'
import { appendSessionRuntimeLog, appendSessionTransportLog } from './transport-logs.js'
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
  respondToPermission: (permissionId: string, decision: 'approve' | 'deny', selectedSuggestion?: PermissionSuggestion | null, content?: Record<string, string | number | boolean | string[]>) => void
  respondToElicitation: (requestId: string, response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => void
  cancel: () => void
}

export type ServerEvent =
  | Extract<SessionEvent, { type: 'session.sdk.message' }>
  | Extract<SessionEvent, { type: 'session.sdk.control.requested' }>
  | Extract<SessionEvent, { type: 'session.sdk.control.resolved' }>
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
    record.type === 'sdk.control.requested' ||
    record.type === 'sdk.control.resolved' ||
    record.type === 'sdk.transport'
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
    case 'sdk.message':
      return {
        type: 'session.sdk.message',
        runId,
        payload: event.payload,
        ...(event.parsed ? { parsed: event.parsed } : {}),
        ...(event.livePreview ? { livePreview: event.livePreview } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'sdk.control.requested':
      return {
        type: 'session.sdk.control.requested',
        runId,
        interaction: event.interaction,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        receivedAt: event.receivedAt,
        sequence: event.sequence,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }
    case 'sdk.control.resolved':
      return {
        type: 'session.sdk.control.resolved',
        runId,
        interaction: event.interaction,
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
  return event.type === 'sdk.transport' ? event.event.sessionId : event.sessionId
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
    respondToPermission(permissionId, decision, selectedSuggestion, content) {
      writeCommand(child, {
        type: 'interaction.permission.respond',
        permissionId,
        decision,
        ...(selectedSuggestion !== undefined ? { selectedSuggestion } : {}),
        ...(content ? { content } : {}),
      })
    },
    respondToElicitation(requestId, response) {
      writeCommand(child, { type: 'interaction.elicitation.respond', requestId, response })
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
