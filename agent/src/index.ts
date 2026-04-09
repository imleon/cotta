import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type ElicitationRequest, type ElicitationResult, type PermissionResult, type PermissionUpdate, type Query, type SDKControlRequest, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AskUserQuestionRequestData,
  ControlDirection,
  ControlTransaction,
  InteractiveOption,
  PendingInteraction,
  PermissionSuggestion,
  RunnerAgentInput,
  RunnerCommand,
  RunnerRuntimeEvent,
  RuntimeEnvelopeBase,
  SdkControlCancelEnvelope,
  SdkControlEnvelope,
  SdkControlRequestEnvelope,
  SdkControlResponseEnvelope,
  SessionStreamEvent,
  SdkTransportEvent,
  StreamEventEnvelope,
  StreamEventNormalized,
  StreamEventScope,
  StreamEventType,
} from '../../shared/message-types.js'
import {
  getControlDescriptor,
  summarizeControlTransaction,
} from '../../shared/message-types.js'
import { logAgent } from './logger.js'

const OUTPUT_START = '---OUTPUT_START---'
const OUTPUT_END = '---OUTPUT_END---'
const EVENT_LOG_INTERVAL = 20
let eventSequence = 0
let activeStreamMessageIds = new Map<string, string>()

function nextEnvelope(sessionId?: string): RuntimeEnvelopeBase {
  eventSequence += 1
  return {
    receivedAt: Date.now(),
    sequence: eventSequence,
    ...(sessionId ? { sessionId } : {}),
  }
}

function writeOutput(data: unknown): void {
  const json = JSON.stringify(data)
  process.stdout.write(`\n${OUTPUT_START}\n${json}\n${OUTPUT_END}\n`)
}

function writeRuntimeEvent(event: RunnerRuntimeEvent): void {
  writeOutput(event)
}

function writeTransportEvent(event: Omit<SdkTransportEvent, 'source'>): void {
  writeRuntimeEvent({
    type: 'sdk.transport',
    event: {
      source: 'sdk-transport',
      ...event,
    },
  })
}

function extractSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const direct = record.sessionId ?? record.session_id
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function summarizeValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length > 0 ? `object(${keys.slice(0, 6).join(', ')})` : 'object(0)'
  }
  return String(value)
}

function shouldIncludeTransportPayload(): boolean {
  return true
}

function maybeTransportPayload(payload: unknown): { payload?: unknown } {
  return shouldIncludeTransportPayload() ? { payload } : {}
}

function createControlTransaction(input: {
  requestId: string
  subtype: string
  direction: ControlDirection
  status: ControlTransaction['status']
  interaction?: PendingInteraction | null
  payload?: unknown
  request?: SdkControlRequestEnvelope
  response?: SdkControlResponseEnvelope
  cancel?: SdkControlCancelEnvelope
  error?: string
}): ControlTransaction {
  const now = Date.now()
  const descriptor = getControlDescriptor(input.subtype)
  return {
    requestId: input.requestId,
    subtype: descriptor.subtype,
    family: descriptor.family,
    direction: input.direction,
    status: input.status,
    openedAt: now,
    updatedAt: now,
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    ...(input.request ? { request: input.request } : {}),
    ...(input.response ? { response: input.response } : {}),
    ...(input.cancel ? { cancel: input.cancel } : {}),
    ...(input.interaction !== undefined ? { interaction: input.interaction } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.error ? { error: input.error } : {}),
    blocksRun: descriptor.blocksRun,
  }
}

function emitControlRuntimeEvent(type: Extract<RunnerRuntimeEvent['type'], 'control.message' | 'control.opened' | 'control.awaiting_user' | 'control.responded' | 'control.completed' | 'control.cancel_requested' | 'control.cancelled' | 'control.failed'>, transaction: ControlTransaction, options?: {
  direction?: ControlDirection
  message?: SdkControlEnvelope
  payload?: unknown
}): void {
  const envelope = nextEnvelope(currentSessionId)
  if (type === 'control.message') {
    if (!options?.direction || !options?.message) return
    writeRuntimeEvent({
      type,
      direction: options.direction,
      message: options.message,
      transaction: summarizeControlTransaction(transaction),
      ...envelope,
    })
    return
  }

  writeRuntimeEvent({
    type,
    transaction: summarizeControlTransaction(transaction),
    ...(options?.payload !== undefined ? { payload: options.payload } : {}),
    ...envelope,
  })
}

function emitInteractiveRuntimeEvent(type: Extract<RunnerRuntimeEvent['type'], 'interactive.opened' | 'interactive.awaiting_user' | 'interactive.responded' | 'interactive.completed' | 'interactive.cancelled' | 'interactive.failed'>, transaction: ControlTransaction, payload?: unknown): void {
  writeRuntimeEvent({
    type,
    transaction: summarizeControlTransaction(transaction),
    ...(payload !== undefined ? { payload } : {}),
    ...nextEnvelope(currentSessionId),
  })
}

function handleControlRespondCommand(requestId: string, response: ControlResponseCommand): void {
  if (response.kind === 'permission') {
    logAgent('info', 'agent:permission:response', {
      permissionId: requestId.slice(0, 8),
      decision: response.decision,
      selectedAction: response.selectedSuggestion?.action,
    })
    writeTransportEvent({
      direction: 'inbound',
      eventName: 'control.response.permission',
      sdkType: 'control_response',
      sdkSubtype: 'can_use_tool',
      requestId,
      toolUseId: requestId,
      payloadSummary: response.decision,
      ...maybeTransportPayload(response),
      ...nextEnvelope(currentSessionId),
    })
    writeTransportEvent({
      direction: 'inbound',
      eventName: 'control.response',
      sdkType: 'control_response',
      sdkSubtype: 'can_use_tool',
      requestId,
      toolUseId: requestId,
      payloadSummary: response.decision,
      ...maybeTransportPayload(response),
      ...nextEnvelope(currentSessionId),
    })
    const resolve = permissionWaiters.get(requestId)
    if (resolve) {
      permissionWaiters.delete(requestId)
      resolve({
        decision: response.decision,
        ...(response.selectedSuggestion !== undefined ? { selectedSuggestion: response.selectedSuggestion } : {}),
        ...(response.content ? { content: response.content as Record<string, ElicitationContentValue> } : {}),
      })
    }
    return
  }

  logAgent('info', 'agent:elicitation:response', {
    requestId: requestId.slice(0, 8),
    action: response.action,
  })
  writeTransportEvent({
    direction: 'inbound',
    eventName: 'control.response.elicitation',
    sdkType: 'control_response',
    sdkSubtype: 'elicitation',
    requestId,
    payloadSummary: response.action,
    ...maybeTransportPayload(response),
    ...nextEnvelope(currentSessionId),
  })
  writeTransportEvent({
    direction: 'inbound',
    eventName: 'control.response',
    sdkType: 'control_response',
    sdkSubtype: 'elicitation',
    requestId,
    payloadSummary: response.action,
    ...maybeTransportPayload(response),
    ...nextEnvelope(currentSessionId),
  })
  const resolve = elicitationWaiters.get(requestId)
  if (resolve) {
    elicitationWaiters.delete(requestId)
    resolve({
      action: response.action,
      ...(response.content ? { content: response.content as Record<string, ElicitationContentValue> } : {}),
    })
  }
}

type ControlResponseCommand = Extract<RunnerCommand, { type: 'control.respond' }>['response']
type HostControlRequestCommand = Extract<RunnerCommand, { type: 'control.request' }>['request']

function createInteractiveControlRequest(input: {
  requestId: string
  subtype: 'can_use_tool' | 'elicitation'
  payload: PermissionRequest | ElicitationRequest
  interaction: PendingInteraction
}): { envelope: SdkControlRequestEnvelope; transaction: ControlTransaction } {
  if (input.subtype === 'can_use_tool') {
    const payload = input.payload as PermissionRequest
    const envelope: SdkControlRequestEnvelope = {
      type: 'control_request',
      request_id: input.requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: payload.toolName,
        input: payload.input,
        ...(payload.permissionSuggestions ? { permission_suggestions: payload.permissionSuggestions as unknown as Record<string, unknown>[] } : {}),
        ...(payload.blockedPath ? { blocked_path: payload.blockedPath } : {}),
        ...(payload.decisionReason ? { decision_reason: payload.decisionReason } : {}),
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.displayName ? { display_name: payload.displayName } : {}),
        tool_use_id: payload.permissionId,
        ...(payload.agentId ? { agent_id: payload.agentId } : {}),
        ...(payload.description ? { description: payload.description } : {}),
      },
    }
    return {
      envelope,
      transaction: createControlTransaction({
        requestId: input.requestId,
        subtype: input.subtype,
        direction: 'sdk_to_host',
        status: 'awaiting_user',
        interaction: input.interaction,
        request: envelope,
        payload,
      }),
    }
  }

  const payload = input.payload as ElicitationRequest
  const envelope: SdkControlRequestEnvelope = {
    type: 'control_request',
    request_id: input.requestId,
    request: {
      subtype: 'elicitation',
      mcp_server_name: payload.serverName,
      message: payload.message,
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.elicitationId ? { elicitation_id: payload.elicitationId } : {}),
      ...(payload.requestedSchema ? { requested_schema: payload.requestedSchema as Record<string, unknown> } : {}),
    },
  }
  return {
    envelope,
    transaction: createControlTransaction({
      requestId: input.requestId,
      subtype: input.subtype,
      direction: 'sdk_to_host',
      status: 'awaiting_user',
      interaction: input.interaction,
      request: envelope,
      payload,
    }),
  }
}

function createInteractiveControlResponse(input: {
  requestId: string
  subtype: 'can_use_tool' | 'elicitation'
  response: PermissionResponse | ElicitationResponse
  interaction: PendingInteraction
}): {
  envelope: SdkControlResponseEnvelope
  respondedTransaction: ControlTransaction
  terminalTransaction: ControlTransaction
} {
  if (input.subtype === 'can_use_tool') {
    const response = input.response as PermissionResponse
    const envelope: SdkControlResponseEnvelope = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: input.requestId,
        response: {
          behavior: response.decision === 'approve' ? 'allow' : 'deny',
          ...(response.selectedSuggestion ? { selectedSuggestion: response.selectedSuggestion } : {}),
          ...(response.content ? { content: response.content as Record<string, unknown> } : {}),
        },
      },
    }
    const respondedTransaction = createControlTransaction({
      requestId: input.requestId,
      subtype: input.subtype,
      direction: 'host_to_sdk',
      status: 'responding',
      interaction: input.interaction,
      response: envelope,
      payload: response,
    })
    return {
      envelope,
      respondedTransaction,
      terminalTransaction: {
        ...respondedTransaction,
        direction: 'sdk_to_host',
        status: 'completed',
        updatedAt: Date.now(),
      },
    }
  }

  const response = input.response as ElicitationResponse
  const envelope: SdkControlResponseEnvelope = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: input.requestId,
      response: {
        action: response.action,
        ...(response.content ? { content: response.content as Record<string, unknown> } : {}),
      },
    },
  }
  const respondedTransaction = createControlTransaction({
    requestId: input.requestId,
    subtype: input.subtype,
    direction: 'host_to_sdk',
    status: response.action === 'cancel' ? 'cancel_requested' : 'responding',
    interaction: input.interaction,
    response: envelope,
    payload: response,
  })
  return {
    envelope,
    respondedTransaction,
    terminalTransaction: {
      ...respondedTransaction,
      direction: 'sdk_to_host',
      status: response.action === 'cancel' ? 'cancelled' : 'completed',
      updatedAt: Date.now(),
    },
  }
}

function emitInteractiveControlRequest(input: {
  requestId: string
  subtype: 'can_use_tool' | 'elicitation'
  interaction: PendingInteraction
  payload: PermissionRequest | ElicitationRequest
  payloadSummary: string
  toolUseId?: string
}): void {
  const { envelope, transaction } = createInteractiveControlRequest({
    requestId: input.requestId,
    subtype: input.subtype,
    payload: input.payload,
    interaction: input.interaction,
  })
  writeTransportEvent({
    direction: 'outbound',
    eventName: input.subtype === 'can_use_tool' ? 'control.request.permission' : 'control.request.elicitation',
    sdkType: 'control_request',
    sdkSubtype: input.subtype,
    requestId: input.requestId,
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    payloadSummary: input.payloadSummary,
    ...maybeTransportPayload(input.payload),
    ...nextEnvelope(currentSessionId),
  })
  writeTransportEvent({
    direction: 'outbound',
    eventName: 'control.request',
    sdkType: 'control_request',
    sdkSubtype: input.subtype,
    requestId: input.requestId,
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    payloadSummary: input.payloadSummary,
    ...maybeTransportPayload(envelope),
    ...nextEnvelope(currentSessionId),
  })
  emitControlRuntimeEvent('control.message', transaction, {
    direction: 'sdk_to_host',
    message: envelope,
  })
  emitControlRuntimeEvent('control.opened', transaction, { payload: input.payload })
  emitControlRuntimeEvent('control.awaiting_user', transaction, { payload: input.payload })
  emitInteractiveRuntimeEvent('interactive.opened', transaction, input.payload)
  emitInteractiveRuntimeEvent('interactive.awaiting_user', transaction, input.payload)
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: 'requires_action',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })
}

function emitInteractiveControlResponse(input: {
  requestId: string
  subtype: 'can_use_tool' | 'elicitation'
  interaction: PendingInteraction
  response: PermissionResponse | ElicitationResponse
  payloadSummary: string
  toolUseId?: string
}): void {
  const { envelope, respondedTransaction, terminalTransaction } = createInteractiveControlResponse({
    requestId: input.requestId,
    subtype: input.subtype,
    response: input.response,
    interaction: input.interaction,
  })
  emitControlRuntimeEvent('control.message', respondedTransaction, {
    direction: 'host_to_sdk',
    message: envelope,
  })
  writeTransportEvent({
    direction: 'inbound',
    eventName: 'control.response',
    sdkType: 'control_response',
    sdkSubtype: input.subtype,
    requestId: input.requestId,
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    payloadSummary: input.payloadSummary,
    ...maybeTransportPayload(envelope),
    ...nextEnvelope(currentSessionId),
  })
  emitControlRuntimeEvent('control.responded', respondedTransaction, { payload: input.response })
  emitControlRuntimeEvent(terminalTransaction.status === 'cancelled' ? 'control.cancelled' : 'control.completed', terminalTransaction, {
    payload: input.response,
  })
  emitInteractiveRuntimeEvent('interactive.responded', respondedTransaction, input.response)
  emitInteractiveRuntimeEvent(terminalTransaction.status === 'cancelled' ? 'interactive.cancelled' : 'interactive.completed', terminalTransaction, input.response)
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: terminalTransaction.status === 'cancelled' ? 'cancelled' : 'running',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })
}

function createHostControlRequestEnvelope(requestId: string, request: HostControlRequestCommand): {
  envelope: SdkControlRequestEnvelope
  transaction: ControlTransaction
} {
  const envelope: SdkControlRequestEnvelope = {
    type: 'control_request',
    request_id: requestId,
    request,
  }
  return {
    envelope,
    transaction: createControlTransaction({
      requestId,
      subtype: request.subtype,
      direction: 'host_to_sdk',
      status: 'opened',
      request: envelope,
      payload: request,
    }),
  }
}

async function executeHostControlRequest(requestId: string, request: HostControlRequestCommand): Promise<void> {
  const { envelope, transaction } = createHostControlRequestEnvelope(requestId, request)
  writeTransportEvent({
    direction: 'inbound',
    eventName: 'control.request',
    sdkType: 'control_request',
    sdkSubtype: request.subtype,
    requestId,
    payloadSummary: request.subtype,
    ...maybeTransportPayload(envelope),
    ...nextEnvelope(currentSessionId),
  })
  emitControlRuntimeEvent('control.message', transaction, {
    direction: 'host_to_sdk',
    message: envelope,
  })
  emitControlRuntimeEvent('control.opened', transaction, { payload: request })

  try {
    switch (request.subtype) {
      case 'interrupt':
        await activeQuery?.interrupt?.()
        break
      case 'get_context_usage':
        await activeQuery?.getContextUsage?.()
        break
      case 'mcp_status':
        await activeQuery?.mcpServerStatus?.()
        break
    }
    emitControlRuntimeEvent('control.completed', {
      ...transaction,
      direction: 'sdk_to_host',
      status: 'completed',
      updatedAt: Date.now(),
    }, { payload: request })
    emitInteractiveRuntimeEvent('interactive.completed', {
      ...transaction,
      direction: 'sdk_to_host',
      status: 'completed',
      updatedAt: Date.now(),
    }, request)
  } catch (error) {
    emitControlRuntimeEvent('control.failed', {
      ...transaction,
      direction: 'sdk_to_host',
      status: 'failed',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }, {
      payload: {
        request,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    emitInteractiveRuntimeEvent('interactive.failed', {
      ...transaction,
      direction: 'sdk_to_host',
      status: 'failed',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }, {
      request,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}


function getStreamParentToolUseId(message: SDKMessage): string | null | undefined {
  if (message.type !== 'stream_event' || !('parent_tool_use_id' in message)) return undefined
  return typeof message.parent_tool_use_id === 'string' || message.parent_tool_use_id === null
    ? message.parent_tool_use_id as string | null
    : undefined
}

function getStreamScopedMessageId(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') return undefined
  const directMessageId = getStreamMessageId(message)
  if (directMessageId) {
    const sessionId = extractSessionId(message) || currentSessionId || 'unknown-session'
    activeStreamMessageIds.set(sessionId, directMessageId)
    return directMessageId
  }
  const sessionId = extractSessionId(message) || currentSessionId || 'unknown-session'
  const scopedMessageId = activeStreamMessageIds.get(sessionId)
  if (message.event.type === 'message_stop') {
    activeStreamMessageIds.delete(sessionId)
  }
  return scopedMessageId
}

function buildStreamScope(message: SDKMessage, envelope: StreamEventEnvelope): StreamEventScope | null {
  if (message.type !== 'stream_event') return null
  const sessionId = extractSessionId(message) || currentSessionId || 'unknown-session'
  const messageId = getStreamScopedMessageId(message)
  const parentToolUseId = getStreamParentToolUseId(message)
  const index = getStreamIndex(message)

  if (messageId) {
    return {
      scopeKey: `${sessionId}:message:${messageId}`,
      anchorKind: 'message',
      anchorId: messageId,
      messageId,
      ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
      ...(index != null ? { index } : {}),
    }
  }

  if (typeof parentToolUseId === 'string') {
    return {
      scopeKey: `${sessionId}:tool_use:${parentToolUseId}`,
      anchorKind: 'tool_use',
      anchorId: parentToolUseId,
      parentToolUseId,
      ...(index != null ? { index } : {}),
    }
  }

  const ephemeralId = `${sessionId}:ephemeral:${envelope.sequence}`
  return {
    scopeKey: ephemeralId,
    anchorKind: 'ephemeral',
    anchorId: ephemeralId,
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
    ...(index != null ? { index } : {}),
  }
}

function getStreamIndex(message: SDKMessage): number | null {
  if (message.type !== 'stream_event') return null
  return 'index' in message.event && typeof message.event.index === 'number' ? message.event.index : null
}

function getStreamMessageId(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') return undefined
  const eventMessage = 'message' in message.event ? message.event.message : undefined
  return eventMessage && typeof eventMessage === 'object' && 'id' in eventMessage && typeof eventMessage.id === 'string'
    ? eventMessage.id
    : undefined
}

function normalizeStreamEvent(message: SDKMessage, envelope: StreamEventEnvelope): SessionStreamEvent | null {
  if (message.type !== 'stream_event') return null
  const scope = buildStreamScope(message, envelope)
  if (!scope) return null
  const eventType = message.event.type as StreamEventType

  let normalized: StreamEventNormalized | undefined
  if (eventType === 'content_block_start') {
    const startEvent = message.event
    if ('content_block' in startEvent) {
      const block = startEvent.content_block
      if (block?.type === 'text') {
        normalized = { blockKind: 'text', text: typeof block.text === 'string' ? block.text : '' }
      } else if (block?.type === 'thinking') {
        normalized = { blockKind: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', redacted: false }
      } else if (block?.type === 'redacted_thinking') {
        normalized = { blockKind: 'thinking', redacted: true }
      } else if (block?.type === 'tool_use') {
        normalized = {
          blockKind: 'tool_use',
          toolName: typeof block.name === 'string' ? block.name : 'unknown_tool',
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          partialJson: typeof block.input === 'string' ? block.input : undefined,
        }
      }
    }
  } else if (eventType === 'content_block_delta') {
    const deltaEvent = message.event
    if ('delta' in deltaEvent) {
      const delta = deltaEvent.delta as unknown as Record<string, unknown>
      const deltaType = typeof delta.type === 'string' ? delta.type : null
      if (deltaType === 'text_delta') {
        normalized = {
          blockKind: 'text',
          deltaKind: 'text_delta',
          text: typeof delta.text === 'string' ? delta.text : '',
        }
      } else if (deltaType === 'thinking_delta') {
        normalized = {
          blockKind: 'thinking',
          deltaKind: 'thinking_delta',
          thinking: typeof delta.thinking === 'string' ? delta.thinking : '',
        }
      } else if (deltaType === 'input_json_delta') {
        normalized = {
          blockKind: 'tool_use',
          deltaKind: 'input_json_delta',
          partialJson: typeof delta.partial_json === 'string' ? delta.partial_json : '',
        }
      }
    }
  }

  return {
    type: 'session.sdk.stream_event',
    ...envelope,
    scope,
    event: { type: eventType },
    ...(normalized ? { normalized } : {}),
    raw: message,
  }
}

function normalizePermissionRequest(request: SDKControlRequest): PendingInteraction | null {
  const payload = asRecord(request.request) ?? asRecord(request)
  if (!payload || payload.subtype !== 'can_use_tool') return null

  return {
    id: typeof request.request_id === 'string'
      ? request.request_id
      : typeof payload.tool_use_id === 'string'
        ? payload.tool_use_id
        : '',
    kind: 'permission',
    status: 'pending',
    source: {
      kind: 'control',
      subtype: 'can_use_tool',
    },
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown_tool',
    input: (payload.input && typeof payload.input === 'object' ? payload.input : {}) as Record<string, unknown>,
    title: typeof payload.title === 'string' ? payload.title : undefined,
    displayName: typeof payload.display_name === 'string' ? payload.display_name : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    decisionReason: typeof payload.decision_reason === 'string' ? payload.decision_reason : undefined,
    blockedPath: typeof payload.blocked_path === 'string' ? payload.blocked_path : undefined,
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
    agentId: typeof payload.agent_id === 'string' ? payload.agent_id : undefined,
    permissionSuggestions: normalizePermissionSuggestions(Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions as PermissionUpdate[] : undefined),
  }
}

function normalizeElicitationRequest(request: SDKControlRequest): PendingInteraction | null {
  const payload = asRecord(request.request) ?? asRecord(request)
  if (!payload || payload.subtype !== 'elicitation') return null

  const serverName = typeof payload.mcp_server_name === 'string'
    ? payload.mcp_server_name
    : typeof payload.server_name === 'string'
      ? payload.server_name
      : typeof payload.serverName === 'string'
        ? payload.serverName
        : 'unknown'
  const messageText = typeof payload.message === 'string' ? payload.message : ''
  const id = typeof request.request_id === 'string'
    ? request.request_id
    : typeof payload.elicitation_id === 'string'
      ? payload.elicitation_id
      : serverName

  return {
    id,
    kind: 'elicitation',
    status: 'pending',
    source: {
      kind: 'control',
      subtype: 'elicitation',
    },
    toolUseId: typeof payload.elicitation_id === 'string' ? payload.elicitation_id : undefined,
    serverName,
    message: messageText,
    mode: typeof payload.mode === 'string' ? payload.mode : undefined,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    requestedSchema: payload.requested_schema,
  }
}

type AskUserQuestionSingleSelect = {
  field: string
  prompt: string
  description?: string
  options: Array<{ value: string; label: string }>
  defaultValue?: string
  questions: Record<string, unknown>[]
}

type AskUserQuestionInteractiveMetadata = {
  field: string
  prompt: string
  description?: string
  options: InteractiveOption[]
  defaultValue?: string
  rawQuestion?: Record<string, unknown>
}

function buildAskUserQuestionInteractiveCandidate(toolName: string, toolInput: Record<string, unknown>, options: {
  toolUseID: string
  title?: string
  description?: string
}): { request: AskUserQuestionRequestData; metadata: AskUserQuestionInteractiveMetadata; toolUseId: string } | null {
  if (toolName !== 'AskUserQuestion') return null
  const parsedQuestion = parseAskUserQuestionSingleSelect(toolInput)
  if (!parsedQuestion) return null

  return {
    request: {
      field: parsedQuestion.field,
      prompt: options.description || options.title || parsedQuestion.prompt,
      ...(parsedQuestion.description ? { description: parsedQuestion.description } : {}),
      options: parsedQuestion.options,
      ...(parsedQuestion.defaultValue ? { defaultValue: parsedQuestion.defaultValue } : {}),
      ...(parsedQuestion.questions[0] ? { rawQuestion: parsedQuestion.questions[0] } : {}),
    },
    metadata: {
      field: parsedQuestion.field,
      prompt: parsedQuestion.prompt,
      ...(parsedQuestion.description ? { description: parsedQuestion.description } : {}),
      options: parsedQuestion.options,
      ...(parsedQuestion.defaultValue ? { defaultValue: parsedQuestion.defaultValue } : {}),
      ...(parsedQuestion.questions[0] ? { rawQuestion: parsedQuestion.questions[0] } : {}),
    },
    toolUseId: options.toolUseID,
  }
}

function buildAskUserQuestionSdkElicitationRequest(candidate: { request: AskUserQuestionRequestData; toolUseId: string }): ElicitationRequest {
  return {
    elicitationId: candidate.toolUseId,
    serverName: 'AskUserQuestion',
    message: candidate.request.prompt,
    requestedSchema: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: {
            [candidate.request.field]: {
              type: 'string',
              title: candidate.request.prompt,
              ...(candidate.request.description ? { description: candidate.request.description } : {}),
              enum: candidate.request.options.map((option) => option.value),
              ...(candidate.request.defaultValue ? { default: candidate.request.defaultValue } : {}),
            },
          },
          required: [candidate.request.field],
        },
      },
      required: ['answers'],
    },
  }
}

function buildSdkElicitationInteractiveRequest(toolName: string, toolInput: Record<string, unknown>, options: {
  toolUseID: string
  title?: string
  description?: string
}): { request: ElicitationRequest; metadata: AskUserQuestionInteractiveMetadata } | null {
  const candidate = buildAskUserQuestionInteractiveCandidate(toolName, toolInput, options)
  if (!candidate) return null
  return {
    request: buildAskUserQuestionSdkElicitationRequest(candidate),
    metadata: candidate.metadata,
  }
}


function normalizeQuestionOption(option: unknown): { value: string; label: string } | null {
  if (typeof option === 'string' && option.trim().length > 0) {
    return { value: option, label: option }
  }

  const record = asRecord(option)
  if (!record) return null

  const value = getString(record.value) || getString(record.id) || getString(record.key) || getString(record.label) || getString(record.text) || getString(record.title)
  if (!value) return null

  return {
    value,
    label: getString(record.label) || getString(record.text) || getString(record.title) || value,
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseAskUserQuestionSingleSelect(input: Record<string, unknown>): AskUserQuestionSingleSelect | null {
  const questions = Array.isArray(input.questions) ? input.questions : null
  if (!questions || questions.length !== 1) return null

  const question = asRecord(questions[0])
  if (!question) return null

  const type = getString(question.type)?.toLowerCase()
  const format = getString(question.format)?.toLowerCase()
  const questionType = getString(question.questionType)?.toLowerCase()
  const multiSelect = getBoolean(question.multiSelect) ?? getBoolean(question.multiple) ?? false
  const optionsSource = Array.isArray(question.options)
    ? question.options
    : Array.isArray(question.choices)
      ? question.choices
      : Array.isArray(question.enum)
        ? question.enum
        : null
  const options = (optionsSource || []).map(normalizeQuestionOption).filter((option): option is { value: string; label: string } => Boolean(option))

  const isSingleSelect = !multiSelect && (
    type === 'single_select'
    || type === 'radio'
    || questionType === 'single_select'
    || questionType === 'radio'
    || format === 'enum'
    || options.length > 0
  )

  if (!isSingleSelect || options.length === 0) return null

  const field = getString(question.name) || getString(question.key) || getString(question.id) || 'value'
  const prompt = getString(question.question) || getString(question.title) || getString(question.label) || 'Question required'

  return {
    field,
    prompt,
    description: getString(question.description) || getString(question.hint) || getString(question.helpText),
    options,
    defaultValue: getString(question.defaultValue) || getString(question.default) || getString(question.value),
    questions: questions.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))).map((item) => item as Record<string, unknown>),
  }
}

type AskUserQuestionToolAnswerContent = {
  answers?: Record<string, unknown>
}

function mapAskUserQuestionResultToPermissionResult(
  request: { toolUseID: string; originalInput: Record<string, unknown>; questionField?: string },
  response: ElicitationResult
): PermissionResult {
  if (response.action === 'accept') {
    const elicitationContent = response.content as unknown as AskUserQuestionToolAnswerContent | undefined
    const answersRecord = elicitationContent?.answers && typeof elicitationContent.answers === 'object' && !Array.isArray(elicitationContent.answers)
      ? elicitationContent.answers
      : undefined
    const answerValue = request.questionField && answersRecord
      ? answersRecord[request.questionField]
      : undefined
    const answers = request.questionField && (typeof answerValue === 'string' || typeof answerValue === 'number' || typeof answerValue === 'boolean')
      ? { [request.questionField]: String(answerValue) }
      : {}

    return {
      behavior: 'allow',
      updatedInput: {
        ...request.originalInput,
        answers,
      },
      toolUseID: request.toolUseID,
      decisionClassification: 'user_temporary',
    }
  }

  const message = response.action === 'cancel'
    ? 'User cancelled the question.'
    : 'User declined to answer the question.'

  return {
    behavior: 'deny',
    message,
    interrupt: true,
    toolUseID: request.toolUseID,
    decisionClassification: 'user_reject',
  }
}

type PermissionRequest = {
  permissionId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  agentId?: string
  permissionSuggestions?: PermissionUpdate[]
}

type PermissionResponse = {
  decision: 'approve' | 'deny'
  selectedSuggestion?: PermissionSuggestion | null
  content?: Record<string, ElicitationContentValue>
}

type ElicitationContentValue = string | number | boolean | string[]

type ElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, ElicitationContentValue>
}

type StreamAccumulatorState = {
  textByScopeAndIndex: Map<string, string>
  thinkingByScopeAndIndex: Map<string, string>
  toolInputByScopeAndIndex: Map<string, string>
}

function createStreamAccumulatorState(): StreamAccumulatorState {
  return {
    textByScopeAndIndex: new Map(),
    thinkingByScopeAndIndex: new Map(),
    toolInputByScopeAndIndex: new Map(),
  }
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

  const updatedInput = response.content ?? {}
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

function summarizeSdkMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      if (typeof message.message?.content === 'string') return summarizeValue(message.message.content)
      if (Array.isArray(message.message?.content)) return `assistant blocks=${message.message.content.length}`
      return 'assistant message'
    }
    case 'user': {
      if (typeof message.message?.content === 'string') return summarizeValue(message.message.content)
      if (Array.isArray(message.message?.content)) return `user blocks=${message.message.content.length}`
      return 'user message'
    }
    case 'result':
      return typeof message.subtype === 'string' ? `result.${message.subtype}` : 'result'
    case 'tool_progress':
      return typeof message.tool_name === 'string' ? `tool ${message.tool_name}` : 'tool progress'
    case 'tool_use_summary':
      return typeof message.summary === 'string' ? summarizeValue(message.summary) : 'tool summary'
    case 'system':
      return typeof message.subtype === 'string' ? `system.${message.subtype}` : 'system'
    default: {
      const payload = message as Record<string, unknown>
      const subtype = typeof payload.subtype === 'string' ? `.${payload.subtype}` : ''
      return `${message.type}${subtype}`
    }
  }
}

const startDeferred = createDeferred<RunnerAgentInput>()
const permissionWaiters = new Map<string, (response: PermissionResponse) => void>()
const elicitationWaiters = new Map<string, (response: ElicitationResponse) => void>()
let activeQuery: Query | null = null
let currentSessionId: string | undefined
let cancelRequested = false
let sdkMessageCount = 0

function handleCommand(command: RunnerCommand) {
  switch (command.type) {
    case 'run.start':
      startDeferred.resolve(command.input)
      break
    case 'control.respond': {
      handleControlRespondCommand(command.requestId, command.response)
      break
    }
    case 'control.request': {
      void executeHostControlRequest(command.requestId, command.request)
      break
    }
    case 'control.cancel': {
      const transaction = createControlTransaction({
        requestId: command.requestId,
        subtype: 'unknown',
        direction: 'host_to_sdk',
        status: 'cancel_requested',
        cancel: {
          type: 'control_cancel_request',
          request_id: command.requestId,
        },
      })
      writeTransportEvent({
        direction: 'inbound',
        eventName: 'control.cancel_request',
        sdkType: 'control_cancel_request',
        requestId: command.requestId,
        payloadSummary: 'cancel requested',
        ...maybeTransportPayload(transaction.cancel),
        ...nextEnvelope(currentSessionId),
      })
      emitControlRuntimeEvent('control.cancel_requested', transaction, {
        payload: transaction.cancel,
      })
      break
    }
    case 'run.cancel':
      cancelRequested = true
      logAgent('warn', 'agent:run:cancel', {
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeTransportEvent({
        direction: 'inbound',
        eventName: 'query.cancel',
        payloadSummary: 'cancel requested',
        ...nextEnvelope(currentSessionId),
      })
      activeQuery?.close()
      break
  }
}

function startCommandReader() {
  process.stdin.setEncoding('utf-8')
  let buffer = ''

  process.stdin.on('data', (chunk) => {
    buffer += chunk

    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        handleCommand(JSON.parse(line) as RunnerCommand)
      } catch (e) {
        logAgent('error', 'agent:command:parse-error', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })

  process.stdin.on('error', (error) => {
    startDeferred.reject(error)
  })

  process.stdin.on('end', () => {
    if (buffer.trim()) {
      try {
        handleCommand(JSON.parse(buffer.trim()) as RunnerCommand)
      } catch (e) {
        logAgent('error', 'agent:command:final-parse-error', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })
}

async function waitForPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult> {
  const normalizedSuggestions = normalizePermissionSuggestions(request.permissionSuggestions)
  const interaction: PendingInteraction = {
    id: request.permissionId,
    kind: 'permission',
    status: 'pending',
    source: {
      kind: 'control',
      subtype: 'can_use_tool',
    },
    toolName: request.toolName,
    input: request.input,
    title: request.title,
    displayName: request.displayName,
    description: request.description,
    decisionReason: request.decisionReason,
    blockedPath: request.blockedPath,
    toolUseId: request.permissionId,
    agentId: request.agentId,
    permissionSuggestions: normalizedSuggestions,
  }
  emitInteractiveControlRequest({
    requestId: request.permissionId,
    subtype: 'can_use_tool',
    interaction,
    payload: request,
    payloadSummary: request.toolName,
    toolUseId: request.permissionId,
  })

  const response = await new Promise<PermissionResponse>((resolve, reject) => {
    permissionWaiters.set(request.permissionId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        permissionWaiters.delete(request.permissionId)
        reject(new Error('Permission request aborted'))
      },
      { once: true }
    )
  })

  const resolvedInteraction: PendingInteraction = {
    ...interaction,
    status: 'resolved',
  }
  logAgent('info', 'agent:permission:resolved', {
    permissionId: request.permissionId.slice(0, 8),
    decision: response.decision,
    selectedAction: response.selectedSuggestion?.action,
    sessionId: currentSessionId?.slice(0, 8),
  })
  emitInteractiveControlResponse({
    requestId: request.permissionId,
    subtype: 'can_use_tool',
    interaction: resolvedInteraction,
    response,
    payloadSummary: response.decision,
    toolUseId: request.permissionId,
  })

  return getPermissionResult(request, response)
}

async function waitForAskUserQuestion(request: AskUserQuestionRequestData, signal: AbortSignal, options: {
  toolUseId: string
}): Promise<ElicitationResult> {
  const interaction: PendingInteraction = {
    id: options.toolUseId,
    kind: 'ask_user_question',
    status: 'pending',
    source: {
      kind: 'tool',
      toolName: 'AskUserQuestion',
      toolUseId: options.toolUseId,
    },
    toolName: 'AskUserQuestion',
    toolUseId: options.toolUseId,
    field: request.field,
    prompt: request.prompt,
    ...(request.description ? { description: request.description } : {}),
    options: request.options,
    ...(request.defaultValue ? { defaultValue: request.defaultValue } : {}),
    ...(request.rawQuestion ? { rawQuestion: request.rawQuestion } : {}),
  }
  const transportRequest = buildAskUserQuestionSdkElicitationRequest({
    request,
    toolUseId: options.toolUseId,
  })
  emitInteractiveControlRequest({
    requestId: options.toolUseId,
    subtype: 'elicitation',
    interaction,
    payload: transportRequest,
    payloadSummary: request.prompt,
    toolUseId: options.toolUseId,
  })

  const response = await new Promise<ElicitationResponse>((resolve, reject) => {
    elicitationWaiters.set(options.toolUseId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        elicitationWaiters.delete(options.toolUseId)
        reject(new Error('Elicitation request aborted'))
      },
      { once: true }
    )
  })

  const resolvedInteraction: PendingInteraction = {
    ...interaction,
    status: response.action === 'cancel' ? 'cancelled' : 'resolved',
  }
  logAgent('info', 'agent:ask-user-question:resolved', {
    requestId: options.toolUseId.slice(0, 8),
    action: response.action,
    sessionId: currentSessionId?.slice(0, 8),
  })
  emitInteractiveControlResponse({
    requestId: options.toolUseId,
    subtype: 'elicitation',
    interaction: resolvedInteraction,
    response,
    payloadSummary: response.action,
    toolUseId: options.toolUseId,
  })

  if (response.action === 'cancel') {
    return {
      action: 'cancel',
      ...(response.content ? { content: response.content } : {}),
    }
  }
  if (response.action === 'decline') {
    return { action: 'decline' }
  }
  return {
    action: 'accept',
    ...(response.content ? { content: response.content } : {}),
  }
}

async function waitForElicitation(request: ElicitationRequest, signal: AbortSignal, source?: PendingInteraction['source']): Promise<ElicitationResult> {
  const requestId = request.elicitationId || request.serverName
  const interaction: PendingInteraction = {
    id: requestId,
    kind: 'elicitation',
    status: 'pending',
    source: source ?? {
      kind: 'control',
      subtype: 'elicitation',
    },
    ...(request.elicitationId ? { toolUseId: request.elicitationId } : {}),
    serverName: request.serverName,
    message: request.message,
    mode: request.mode,
    url: request.url,
    requestedSchema: request.requestedSchema,
  }
  emitInteractiveControlRequest({
    requestId,
    subtype: 'elicitation',
    interaction,
    payload: request,
    payloadSummary: request.serverName,
  })

  const response = await new Promise<ElicitationResponse>((resolve, reject) => {
    elicitationWaiters.set(requestId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        elicitationWaiters.delete(requestId)
        reject(new Error('Elicitation request aborted'))
      },
      { once: true }
    )
  })

  const resolvedInteraction: PendingInteraction = {
    ...interaction,
    status: response.action === 'cancel' ? 'cancelled' : 'resolved',
  }
  logAgent('info', 'agent:elicitation:resolved', {
    requestId: requestId.slice(0, 8),
    action: response.action,
    sessionId: currentSessionId?.slice(0, 8),
  })
  emitInteractiveControlResponse({
    requestId,
    subtype: 'elicitation',
    interaction: resolvedInteraction,
    response,
    payloadSummary: response.action,
  })

  if (response.action === 'cancel') {
    return {
      action: 'cancel',
      ...(response.content ? { content: response.content } : {}),
    }
  }

  if (response.action === 'decline') {
    return {
      action: 'decline',
    }
  }

  return {
    action: 'accept',
    ...(response.content ? { content: response.content } : {}),
  }
}

function handleSdkMessage(message: SDKMessage) {
  const previousSessionId = currentSessionId
  currentSessionId = extractSessionId(message) ?? currentSessionId
  sdkMessageCount += 1

  if (currentSessionId !== previousSessionId) {
    logAgent('info', 'agent:session:updated', {
      previousSessionId: previousSessionId?.slice(0, 8),
      sessionId: currentSessionId?.slice(0, 8),
    })
  }

  writeTransportEvent({
    direction: 'outbound',
    eventName: 'message',
    sdkType: message.type,
    sdkSubtype: 'subtype' in message && typeof message.subtype === 'string' ? message.subtype : undefined,
    payloadSummary: summarizeSdkMessage(message),
    ...maybeTransportPayload(message),
    ...nextEnvelope(currentSessionId),
  })

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    writeRuntimeEvent({
      type: 'run.state_changed',
      state: message.state === 'running' || message.state === 'requires_action' || message.state === 'idle' ? message.state : 'idle',
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    })
  }

  if (sdkMessageCount === 1 || sdkMessageCount % EVENT_LOG_INTERVAL === 0) {
    logAgent('debug', 'agent:query:event', {
      count: sdkMessageCount,
      type: message.type,
      sessionId: currentSessionId?.slice(0, 8),
    })
  }

  const envelope = nextEnvelope(currentSessionId)
  if (message.type === 'stream_event') {
    const streamEvent = normalizeStreamEvent(message, {
      runId: '',
      sessionId: currentSessionId,
      receivedAt: envelope.receivedAt,
      sequence: envelope.sequence,
    })
    if (streamEvent) {
      writeRuntimeEvent({
        type: 'sdk.stream_event',
        event: streamEvent,
        ...envelope,
      })
    }
    return
  }

  writeRuntimeEvent({
    type: 'sdk.message',
    payload: message,
    ...envelope,
  })
}

async function main(): Promise<void> {
  startCommandReader()

  let input: RunnerAgentInput
  try {
    input = await startDeferred.promise
  } catch (e) {
    logAgent('error', 'agent:run:start-error', {
      error: e instanceof Error ? e.message : String(e),
    })
    writeRuntimeEvent({ type: 'run.failed', error: 'Invalid start command' })
    process.exit(1)
    return
  }

  currentSessionId = input.sessionId
  cancelRequested = false
  eventSequence = 0
  activeStreamMessageIds = new Map<string, string>()
  sdkMessageCount = 0

  logAgent('info', 'agent:run:start', {
    promptLength: input.prompt.length,
    sessionId: input.sessionId?.slice(0, 8),
    workspacePath: input.workspacePath,
    model: input.model || '(env default)',
  })

  try {
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const permissionId = options.toolUseID || randomUUID()
      const askUserQuestionCandidate = buildAskUserQuestionInteractiveCandidate(toolName, toolInput, {
        toolUseID: permissionId,
        title: options.title,
        description: options.description,
      })
      if (askUserQuestionCandidate) {
        const askUserQuestionResult = await waitForAskUserQuestion(askUserQuestionCandidate.request, options.signal, {
          toolUseId: permissionId,
        })
        return mapAskUserQuestionResultToPermissionResult(
          {
            toolUseID: permissionId,
            originalInput: toolInput,
            questionField: askUserQuestionCandidate.metadata.field,
          },
          askUserQuestionResult,
        )
      }
      return waitForPermission(
        {
          permissionId,
          toolName,
          input: toolInput,
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          decisionReason: options.decisionReason,
          blockedPath: options.blockedPath,
          agentId: options.agentID,
          permissionSuggestions: options.suggestions,
        },
        options.signal
      )
    }

    const allowedTools = [
      'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    ]
    const options: Record<string, unknown> = {
      cwd: input.workspacePath,
      ...(input.model ? { model: input.model } : {}),
      allowedTools,
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool,
      onElicitation: waitForElicitation,
    }

    if (input.sessionId) {
      options.resume = input.sessionId
    }

    if (input.systemPrompt) {
      options.systemPrompt = input.systemPrompt
    }

    let messageCount = 0
    writeRuntimeEvent({ type: 'run.started', ...(currentSessionId ? { sessionId: currentSessionId } : {}) })
    writeRuntimeEvent({ type: 'run.state_changed', state: 'running', ...(currentSessionId ? { sessionId: currentSessionId } : {}) })
    writeTransportEvent({
      direction: 'inbound',
      eventName: 'query.start',
      payloadSummary: input.prompt.trim().slice(0, 160),
      ...maybeTransportPayload({
        prompt: input.prompt,
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        model: input.model,
        allowedTools,
      }),
      ...nextEnvelope(currentSessionId),
    })
    logAgent('info', 'agent:query:start', {
      sessionId: currentSessionId?.slice(0, 8),
      resume: Boolean(input.sessionId),
      allowedTools,
    })

    activeQuery = query({
      prompt: input.prompt,
      options: options as any,
    })

    for await (const message of activeQuery) {
      messageCount++
      currentSessionId = extractSessionId(message) ?? currentSessionId
      handleSdkMessage(message)
    }

    if (!cancelRequested) {
      logAgent('info', 'agent:query:completed', {
        messageCount,
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeTransportEvent({
        direction: 'outbound',
        eventName: 'query.completed',
        payloadSummary: `messages=${messageCount}`,
        ...maybeTransportPayload({ messageCount }),
        ...nextEnvelope(currentSessionId),
      })
      writeRuntimeEvent({
        type: 'run.completed',
        messageCount,
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    } else {
      logAgent('warn', 'agent:query:cancelled', {
        messageCount,
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeTransportEvent({
        direction: 'outbound',
        eventName: 'query.cancelled',
        payloadSummary: `messages=${messageCount}`,
        ...maybeTransportPayload({ messageCount }),
        ...nextEnvelope(currentSessionId),
      })
      writeRuntimeEvent({
        type: 'run.cancelled',
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    }
  } catch (error) {
    if (!cancelRequested) {
      logAgent('error', 'agent:query:error', {
        error: error instanceof Error ? error.message : String(error),
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeTransportEvent({
        direction: 'outbound',
        eventName: 'query.failed',
        payloadSummary: error instanceof Error ? error.message : String(error),
        ...maybeTransportPayload(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { error: String(error) }),
        ...nextEnvelope(currentSessionId),
      })
      writeRuntimeEvent({
        type: 'run.failed',
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
      process.exit(1)
    } else {
      writeTransportEvent({
        direction: 'outbound',
        eventName: 'query.cancelled',
        payloadSummary: 'cancelled after close',
        ...nextEnvelope(currentSessionId),
      })
      writeRuntimeEvent({
        type: 'run.cancelled',
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    }
  } finally {
    activeQuery = null
  }

  process.exit(0)
}

main().catch((err) => {
  logAgent('error', 'agent:unhandled-error', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
