import { randomUUID } from 'node:crypto'
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk'
import {
  type SdkControlEnvelope,
  type SdkControlRequestEnvelope,
  type SdkControlResponseEnvelope,
  summarizeControlTransaction,
  type ControlTransaction,
  type PendingInteraction,
  type PermissionInteraction,
  type PermissionSuggestion,
  type SdkElicitationInteraction,
} from '../protocol/message-types.js'
import { getControlDescriptor } from '../protocol/control-descriptors.js'
import type { AgentTemplate } from '../orchestration/types.js'
import type {
  WorkerHandle,
  WorkerInputEvent,
  WorkerOutputEvent,
  WorkerOutputResult,
  WorkerOutputSessionStateChanged,
} from './types.js'
import type { WorkerFactory, WorkerStartMode } from './worker-manager.js'
import { adaptSdkMessage } from './sdk-event-adapter.js'

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly resolvers: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) {
      throw new Error('AsyncQueue is closed')
    }

    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }

    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true

    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T
          return { value, done: false }
        }

        if (this.closed) {
          return { value: undefined as T, done: true }
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

function toSdkUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as SDKUserMessage
}

function toQueryOptions(
  sessionId: string,
  agent: AgentTemplate,
  mode: WorkerStartMode,
): NonNullable<Parameters<typeof query>[0]['options']> {
  type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>
  type QueryMcpServers = QueryOptions['mcpServers']
  type QuerySettingSources = QueryOptions['settingSources']
  type QueryEnv = QueryOptions['env']
  type QuerySettingSource = 'user' | 'project' | 'local'
  // Default to a small safe allowlist for convenience, unless configured.
  const defaultAllowedTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
  const allowedTools = Array.isArray(agent.allowTools) && agent.allowTools.length > 0
    ? agent.allowTools
    : defaultAllowedTools
  // Explicitly mirror Cotta's runtime policy:
  // - load user-level Claude settings (~/.claude/settings.json)
  // - load project-level settings and CLAUDE.md under each projectDir
  // This avoids behavior drift from SDK default changes across versions.
  const defaultSettingSources: QuerySettingSources = ['user', 'project']

  const promptConfig = (agent.promptConfig && typeof agent.promptConfig === 'object' && !Array.isArray(agent.promptConfig))
    ? agent.promptConfig as Record<string, unknown>
    : {}
  const settingSourcesFromPrompt = Array.isArray(promptConfig.settingSources)
    ? (promptConfig.settingSources.filter((item): item is QuerySettingSource => (
      item === 'user' || item === 'project' || item === 'local'
    )) as QuerySettingSources)
    : null
  const settingSources: QuerySettingSources = (settingSourcesFromPrompt && settingSourcesFromPrompt.length > 0)
    ? settingSourcesFromPrompt
    : defaultSettingSources

  const env: QueryEnv | undefined = agent.env && Object.keys(agent.env).length > 0
    ? agent.env
    : undefined

  // allowSkillsJson maps to Claude Code "skills" allowlist. When omitted, all discovered skills load.
  const skills = Array.isArray(agent.allowSkills) && agent.allowSkills.length > 0
    ? agent.allowSkills
    : undefined

  const planModeInstructions = typeof promptConfig.planModeInstructions === 'string'
    ? promptConfig.planModeInstructions
    : undefined
  const allowDangerouslySkipPermissions = promptConfig.allowDangerouslySkipPermissions === true
    ? true
    : undefined
  return {
    ...(mode === 'new' ? { sessionId } : { resume: sessionId }),
    cwd: agent.projectDir,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode as never } : {}),
    ...(allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions } : {}),
    ...(planModeInstructions ? { planModeInstructions } : {}),
    includePartialMessages: true,
    allowedTools,
    settingSources,
    ...(env ? { env } : {}),
    ...(skills ? { skills } : {}),
    ...(agent.mcpServers ? { mcpServers: agent.mcpServers as QueryMcpServers } : {}),
  } as QueryOptions
}

function isTerminalEvent(
  event: WorkerOutputEvent,
): event is WorkerOutputResult | WorkerOutputSessionStateChanged {
  if (event.kind === 'result') return true
  return event.kind === 'session_state_changed' && event.state === 'idle'
}

function createHostControlEnvelope(requestId: string, subtype: 'interrupt' | 'get_context_usage' | 'mcp_status'): SdkControlRequestEnvelope {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype },
  }
}

function createControlTransaction(input: {
  sessionId: string
  runId?: string
  requestId: string
  subtype: string
  status: ControlTransaction['status']
  direction: ControlTransaction['direction']
  openedAt: number
  updatedAt?: number
  error?: string
  request?: SdkControlRequestEnvelope
  response?: SdkControlResponseEnvelope
  interaction?: PendingInteraction | null
  payload?: unknown
}): ControlTransaction {
  const descriptor = getControlDescriptor(input.subtype)
  return {
    requestId: input.requestId,
    subtype: input.subtype,
    family: descriptor.family,
    direction: input.direction,
    status: input.status,
    openedAt: input.openedAt,
    updatedAt: input.updatedAt ?? Date.now(),
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.request ? { request: input.request } : {}),
    ...(input.response ? { response: input.response } : {}),
    ...(input.interaction !== undefined ? { interaction: input.interaction } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.error ? { error: input.error } : {}),
    blocksRun: descriptor.blocksRun,
  }
}

type PermissionRequest = {
  toolName: string
  input: Record<string, unknown>
  permissionId: string
  permissionSuggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  agentId?: string
}

type PermissionResponse = {
  decision: 'approve' | 'deny'
  selectedSuggestion?: PermissionSuggestion | null
  content?: Record<string, string | number | boolean | string[]>
}

type ElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, string | number | boolean | string[]>
}

function normalizePermissionSuggestions(suggestions: PermissionUpdate[] | undefined): PermissionSuggestion[] | undefined {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return undefined

  return suggestions.map((suggestion) => {
    switch (suggestion.type) {
      case 'addRules':
      case 'replaceRules':
      case 'removeRules': {
        const ruleSummary = suggestion.rules
          .map((rule) => rule.ruleContent ? `${rule.toolName} ${rule.ruleContent}` : rule.toolName)
          .join(' · ')
        return {
          action: suggestion.type,
          label: suggestion.destination === 'session' ? 'Allow for session' : 'Update rules',
          description: ruleSummary || suggestion.destination,
          scope: suggestion.destination,
          raw: suggestion,
        }
      }
      case 'setMode':
        return {
          action: suggestion.type,
          label: `Set mode: ${suggestion.mode}`,
          description: suggestion.destination,
          scope: suggestion.destination,
          raw: suggestion,
        }
      case 'addDirectories':
      case 'removeDirectories':
        return {
          action: suggestion.type,
          label: suggestion.type === 'addDirectories' ? 'Allow directories' : 'Remove directories',
          description: suggestion.directories.join(' · '),
          scope: suggestion.destination,
          raw: suggestion,
        }
      default:
        return {
          action: 'allow',
          label: 'Allow once',
          raw: suggestion,
        }
    }
  })
}

function getPermissionResult(request: PermissionRequest, response: PermissionResponse): PermissionResult {
  if (response.decision === 'deny') {
    return {
      behavior: 'deny',
      message: 'User denied this action.',
      interrupt: true,
      toolUseID: request.permissionId,
      decisionClassification: 'user_reject',
    }
  }

  const updatedInput = (response.content ?? {}) as Record<string, unknown>
  const selectedRaw = response.selectedSuggestion?.raw
  if (selectedRaw && typeof selectedRaw === 'object' && 'type' in selectedRaw) {
    const permissionUpdate = selectedRaw as PermissionUpdate
    return {
      behavior: 'allow',
      updatedInput,
      updatedPermissions: [permissionUpdate],
      toolUseID: request.permissionId,
      decisionClassification: permissionUpdate.destination === 'session' ? 'user_permanent' : 'user_temporary',
    }
  }

  return {
    behavior: 'allow',
    updatedInput,
    toolUseID: request.permissionId,
    decisionClassification: 'user_temporary',
  }
}

function createSdkControlResponseEnvelope(input: {
  requestId: string
  response: Record<string, unknown>
}): SdkControlResponseEnvelope {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: input.requestId,
      response: input.response,
    },
  }
}

function createInteractiveControlRequestEnvelope(
  requestId: string,
  request: { subtype: string; [key: string]: unknown },
): SdkControlRequestEnvelope {
  return {
    type: 'control_request',
    request_id: requestId,
    request,
  }
}

export async function startSdkSessionWorker(input: {
  sessionId: string
  agent: AgentTemplate
  mode: WorkerStartMode
}): Promise<WorkerHandle> {
  const workerRef = randomUUID()
  const sdkInputQueue = new AsyncQueue<SDKUserMessage>()
  const outputQueue = new AsyncQueue<WorkerOutputEvent>()
  const permissionWaiters = new Map<string, (response: PermissionResponse) => void>()
  const elicitationWaiters = new Map<string, (response: ElicitationResponse) => void>()
  const pendingControlInteractions = new Map<string, {
    subtype: 'can_use_tool' | 'elicitation'
    openedAt: number
    runId?: string
    interaction: PendingInteraction
  }>()

  let closed = false
  let activeRunId: string | undefined

  const queryOptions = toQueryOptions(input.sessionId, input.agent, input.mode)
  queryOptions.canUseTool = async (toolName, toolInput, options) => {
    const requestId = randomUUID()
    const openedAt = Date.now()
    const permissionRequest: PermissionRequest = {
      toolName,
      input: toolInput,
      permissionId: options.toolUseID || requestId,
      ...(Array.isArray(options.suggestions) ? { permissionSuggestions: options.suggestions } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.agentID ? { agentId: options.agentID } : {}),
    }
    const interaction: PermissionInteraction = {
      id: requestId,
      kind: 'permission',
      status: 'pending',
      source: { kind: 'control', subtype: 'can_use_tool' },
      blocksRun: true,
      toolName,
      input: toolInput,
      ...(permissionRequest.title ? { title: permissionRequest.title } : {}),
      ...(permissionRequest.displayName ? { displayName: permissionRequest.displayName } : {}),
      ...(permissionRequest.description ? { description: permissionRequest.description } : {}),
      ...(permissionRequest.decisionReason ? { decisionReason: permissionRequest.decisionReason } : {}),
      ...(permissionRequest.blockedPath ? { blockedPath: permissionRequest.blockedPath } : {}),
      ...(permissionRequest.permissionId ? { toolUseId: permissionRequest.permissionId } : {}),
      ...(permissionRequest.agentId ? { agentId: permissionRequest.agentId } : {}),
      ...(normalizePermissionSuggestions(permissionRequest.permissionSuggestions) ? { permissionSuggestions: normalizePermissionSuggestions(permissionRequest.permissionSuggestions) } : {}),
    }
    const requestEnvelope = createInteractiveControlRequestEnvelope(requestId, {
      subtype: 'can_use_tool',
      tool_name: permissionRequest.toolName,
      input: permissionRequest.input,
      ...(permissionRequest.permissionSuggestions ? { permission_suggestions: permissionRequest.permissionSuggestions as unknown as Record<string, unknown>[] } : {}),
      ...(permissionRequest.blockedPath ? { blocked_path: permissionRequest.blockedPath } : {}),
      ...(permissionRequest.decisionReason ? { decision_reason: permissionRequest.decisionReason } : {}),
      ...(permissionRequest.title ? { title: permissionRequest.title } : {}),
      ...(permissionRequest.displayName ? { display_name: permissionRequest.displayName } : {}),
      ...(permissionRequest.description ? { description: permissionRequest.description } : {}),
      tool_use_id: permissionRequest.permissionId,
      ...(permissionRequest.agentId ? { agent_id: permissionRequest.agentId } : {}),
    })
    const awaitingTransaction = createControlTransaction({
      sessionId: input.sessionId,
      runId: activeRunId,
      requestId,
      subtype: 'can_use_tool',
      status: 'awaiting_user',
      direction: 'sdk_to_host',
      openedAt,
      request: requestEnvelope,
      interaction,
      payload: permissionRequest,
    })
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: 'awaiting_user',
      transaction: summarizeControlTransaction(awaitingTransaction),
      payload: permissionRequest,
    })
    pendingControlInteractions.set(requestId, {
      subtype: 'can_use_tool',
      openedAt,
      runId: activeRunId,
      interaction,
    })

    const response = await new Promise<PermissionResponse>((resolve, reject) => {
      const onAbort = () => {
        permissionWaiters.delete(requestId)
        pendingControlInteractions.delete(requestId)
        reject(new Error('Permission request aborted'))
      }
      permissionWaiters.set(requestId, (value) => {
        options.signal.removeEventListener('abort', onAbort)
        resolve(value)
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
    })

    const responseEnvelope = createSdkControlResponseEnvelope({
      requestId,
      response: {
        behavior: response.decision === 'approve' ? 'allow' : 'deny',
        ...(response.selectedSuggestion ? { selectedSuggestion: response.selectedSuggestion } : {}),
        ...(response.content ? { content: response.content as Record<string, unknown> } : {}),
      },
    })
    const respondingTransaction = createControlTransaction({
      sessionId: input.sessionId,
      runId: activeRunId,
      requestId,
      subtype: 'can_use_tool',
      status: 'responding',
      direction: 'host_to_sdk',
      openedAt,
      interaction,
      response: responseEnvelope,
      payload: response,
    })
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: 'responded',
      transaction: summarizeControlTransaction(respondingTransaction),
      payload: response,
    })
    const result = getPermissionResult(permissionRequest, response)
    const completedTransaction: ControlTransaction = {
      ...respondingTransaction,
      direction: 'sdk_to_host',
      status: 'completed',
      updatedAt: Date.now(),
    }
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: 'completed',
      transaction: summarizeControlTransaction(completedTransaction),
      payload: response,
    })
    pendingControlInteractions.delete(requestId)
    return result
  }
  queryOptions.onElicitation = async (request, options) => {
    const requestId = randomUUID()
    const openedAt = Date.now()
    const interaction: SdkElicitationInteraction = {
      id: requestId,
      kind: 'elicitation',
      status: 'pending',
      source: { kind: 'control', subtype: 'elicitation' },
      blocksRun: true,
      serverName: request.serverName,
      message: request.message,
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.url ? { url: request.url } : {}),
      ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
    }
    const requestEnvelope = createInteractiveControlRequestEnvelope(requestId, {
      subtype: 'elicitation',
      mcp_server_name: request.serverName,
      message: request.message,
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.url ? { url: request.url } : {}),
      ...(request.elicitationId ? { elicitation_id: request.elicitationId } : {}),
      ...(request.requestedSchema ? { requested_schema: request.requestedSchema } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.displayName ? { display_name: request.displayName } : {}),
      ...(request.description ? { description: request.description } : {}),
    })
    const awaitingTransaction = createControlTransaction({
      sessionId: input.sessionId,
      runId: activeRunId,
      requestId,
      subtype: 'elicitation',
      status: 'awaiting_user',
      direction: 'sdk_to_host',
      openedAt,
      request: requestEnvelope,
      interaction,
      payload: request,
    })
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: 'awaiting_user',
      transaction: summarizeControlTransaction(awaitingTransaction),
      payload: request,
    })
    pendingControlInteractions.set(requestId, {
      subtype: 'elicitation',
      openedAt,
      runId: activeRunId,
      interaction,
    })

    const response = await new Promise<ElicitationResponse>((resolve, reject) => {
      const onAbort = () => {
        elicitationWaiters.delete(requestId)
        pendingControlInteractions.delete(requestId)
        reject(new Error('Elicitation aborted'))
      }
      elicitationWaiters.set(requestId, (value) => {
        options.signal.removeEventListener('abort', onAbort)
        resolve(value)
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
    })

    const responseEnvelope = createSdkControlResponseEnvelope({
      requestId,
      response: {
        action: response.action,
        ...(response.content ? { content: response.content as Record<string, unknown> } : {}),
      },
    })
    const respondingTransaction = createControlTransaction({
      sessionId: input.sessionId,
      runId: activeRunId,
      requestId,
      subtype: 'elicitation',
      status: response.action === 'cancel' ? 'cancel_requested' : 'responding',
      direction: 'host_to_sdk',
      openedAt,
      interaction,
      response: responseEnvelope,
      payload: response,
    })
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: response.action === 'cancel' ? 'cancel_requested' : 'responded',
      transaction: summarizeControlTransaction(respondingTransaction),
      payload: response,
    })
    const completedTransaction: ControlTransaction = {
      ...respondingTransaction,
      direction: 'sdk_to_host',
      status: response.action === 'cancel' ? 'cancelled' : 'completed',
      updatedAt: Date.now(),
    }
    outputQueue.push({
      kind: 'control_transaction',
      sessionId: input.sessionId,
      runId: activeRunId,
      receivedAt: Date.now(),
      phase: response.action === 'cancel' ? 'cancelled' : 'completed',
      transaction: summarizeControlTransaction(completedTransaction),
      payload: response,
    })
    pendingControlInteractions.delete(requestId)
    return {
      action: response.action,
      ...(response.content ? { content: response.content as Record<string, unknown> } : {}),
    } as ElicitationResult
  }

  const q: Query = query({
    prompt: sdkInputQueue,
    options: queryOptions,
  })

  void (async () => {
    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        const event = adaptSdkMessage(message, input.sessionId, activeRunId)
        outputQueue.push(event)

        if (isTerminalEvent(event)) {
          activeRunId = undefined
        }
      }

      outputQueue.push({
        kind: 'worker_closed',
        sessionId: input.sessionId,
        runId: activeRunId,
        receivedAt: Date.now(),
        payload: null,
      })
    } catch (error) {
      outputQueue.push({
        kind: 'worker_error',
        sessionId: input.sessionId,
        runId: activeRunId,
        receivedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      closed = true
      outputQueue.close()
    }
  })()

  return {
    workerRef,
    sessionId: input.sessionId,
    input: {
      async write(event: WorkerInputEvent): Promise<void> {
        if (closed) {
          throw new Error(`Worker already closed: ${input.sessionId}`)
        }

        if (event.type === 'query') {
          activeRunId = event.runId
          sdkInputQueue.push(toSdkUserMessage(event.text))
          return
        }

        if (event.type === 'control.respond') {
          if (event.kind === 'permission') {
            const responder = permissionWaiters.get(event.requestId)
            if (!responder) {
              throw new Error(`Permission request not found: ${event.requestId}`)
            }
            permissionWaiters.delete(event.requestId)
            pendingControlInteractions.delete(event.requestId)
            responder(event.response as PermissionResponse)
            return
          }
          const responder = elicitationWaiters.get(event.requestId)
          if (!responder) {
            throw new Error(`Elicitation request not found: ${event.requestId}`)
          }
          elicitationWaiters.delete(event.requestId)
          pendingControlInteractions.delete(event.requestId)
          responder(event.response as ElicitationResponse)
          return
        }

        if (event.type === 'control.cancel') {
          const pending = pendingControlInteractions.get(event.requestId)
          if (!pending) {
            throw new Error(`Control request not found: ${event.requestId}`)
          }

          const cancelRequestedTransaction = createControlTransaction({
            sessionId: input.sessionId,
            runId: pending.runId,
            requestId: event.requestId,
            subtype: pending.subtype,
            status: 'cancel_requested',
            direction: 'host_to_sdk',
            openedAt: pending.openedAt,
            interaction: pending.interaction,
            payload: { requestId: event.requestId },
          })
          outputQueue.push({
            kind: 'control_transaction',
            sessionId: input.sessionId,
            runId: pending.runId,
            receivedAt: Date.now(),
            phase: 'cancel_requested',
            transaction: summarizeControlTransaction(cancelRequestedTransaction),
            payload: { requestId: event.requestId },
          })

          if (pending.subtype === 'can_use_tool') {
            const responder = permissionWaiters.get(event.requestId)
            if (!responder) {
              throw new Error(`Permission request not found: ${event.requestId}`)
            }
            permissionWaiters.delete(event.requestId)
            pendingControlInteractions.delete(event.requestId)
            responder({ decision: 'deny' })
          } else {
            const responder = elicitationWaiters.get(event.requestId)
            if (!responder) {
              throw new Error(`Elicitation request not found: ${event.requestId}`)
            }
            elicitationWaiters.delete(event.requestId)
            pendingControlInteractions.delete(event.requestId)
            responder({ action: 'cancel' })
          }
          return
        }

        if (event.type === 'control') {
          const requestId = event.requestId ?? `${event.subtype}:${Date.now()}`
          const openedAt = Date.now()
          const envelope = createHostControlEnvelope(requestId, event.subtype)
          const openedTransaction = createControlTransaction({
            sessionId: input.sessionId,
            runId: activeRunId,
            requestId,
            subtype: event.subtype,
            status: 'opened',
            direction: 'host_to_sdk',
            openedAt,
            request: envelope,
            payload: { subtype: event.subtype },
          })

          outputQueue.push({
            kind: 'control_message',
            sessionId: input.sessionId,
            runId: activeRunId,
            receivedAt: Date.now(),
            direction: 'host_to_sdk',
            message: envelope,
            transaction: summarizeControlTransaction(openedTransaction),
          })
          outputQueue.push({
            kind: 'control_transaction',
            sessionId: input.sessionId,
            runId: activeRunId,
            receivedAt: Date.now(),
            phase: 'opened',
            transaction: summarizeControlTransaction(openedTransaction),
            payload: { subtype: event.subtype },
          })

          try {
            let resultPayload: unknown = null
            switch (event.subtype) {
              case 'interrupt':
                await q.interrupt()
                resultPayload = { subtype: event.subtype }
                break
              case 'get_context_usage':
                resultPayload = await q.getContextUsage?.()
                break
              case 'mcp_status':
                resultPayload = await q.mcpServerStatus?.()
                break
            }

            const completedTransaction = createControlTransaction({
              sessionId: input.sessionId,
              runId: activeRunId,
              requestId,
              subtype: event.subtype,
              status: 'completed',
              direction: 'sdk_to_host',
              openedAt,
              payload: { subtype: event.subtype, result: resultPayload },
            })
            outputQueue.push({
              kind: 'control_transaction',
              sessionId: input.sessionId,
              runId: activeRunId,
              receivedAt: Date.now(),
              phase: 'completed',
              transaction: summarizeControlTransaction(completedTransaction),
              payload: { subtype: event.subtype, result: resultPayload },
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const failedTransaction = createControlTransaction({
              sessionId: input.sessionId,
              runId: activeRunId,
              requestId,
              subtype: event.subtype,
              status: 'failed',
              direction: 'sdk_to_host',
              openedAt,
              error: message,
              payload: { subtype: event.subtype },
            })
            outputQueue.push({
              kind: 'control_transaction',
              sessionId: input.sessionId,
              runId: activeRunId,
              receivedAt: Date.now(),
              phase: 'failed',
              transaction: summarizeControlTransaction(failedTransaction),
              payload: { subtype: event.subtype, error: message },
            })
          }
        }
      },
    },
    output: outputQueue,
    async close(): Promise<void> {
      if (closed) return
      sdkInputQueue.close()
      q.close()
    },
  }
}

export class SdkSessionWorkerFactory implements WorkerFactory {
  async start(input: {
    sessionId: string
    agent: AgentTemplate
    mode: WorkerStartMode
  }): Promise<WorkerHandle> {
    return await startSdkSessionWorker(input)
  }
}
