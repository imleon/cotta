import * as Lark from '@larksuiteoapi/node-sdk'
import { CONFIG } from './config.js'
import { createLogger, shortId } from './logger.js'
import { appendSessionChannelLog } from './transport-logs.js'
import { SessionBindingStore } from './session-bindings.js'
import { SessionControlService } from './session-control-service.js'
import type {
  ChannelInboundMessage,
  ChannelOutboundMessage,
  LarkStreamingState,
  PendingInteraction,
  SessionEvent,
} from '../shared/message-types.js'
import type { RunCoordinator, RunRecord } from './run-coordinator.js'
import {
  buildContentFromBlocks,
  extractStructuredContentFromBlocks,
  hasRenderableTranscriptContent,
  normalizeSdkEnvelopeMessage,
} from '../shared/transcript-normalizer.js'

const logger = createLogger('lark-adapter')
const DEDUPE_TTL_MS = 10 * 60 * 1000

let clientInstance: any | null = null
let dispatcherInstance: any | null = null
let wsClientInstance: any | null = null
let wsClientCardPatched = false
let wsStartPromise: Promise<void> | null = null
let bindings = new SessionBindingStore()
let sessionControl: SessionControlService | null = null
const processedMessageIds = new Map<string, number>()
const processedActionKeys = new Map<string, number>()
const larkStreamingStates = new Map<string, LarkStreamingState>()
const STREAMING_CARD_ELEMENT_ID = 'streaming_content'

export type LarkInboundEvent = {
  conversationKey: string
  userKey?: string
  text: string
  platformMessageId?: string
}

type LarkOutboundDelivery = {
  conversationKey: string
  text?: string
  card?: unknown
  runId?: string
  sessionId?: string
  mode?: 'create' | 'stream' | 'finalize' | 'fallback'
  state?: LarkStreamingState
  preferRawCardFallback?: boolean
}

function formatPermissionSuggestions(suggestions?: Extract<PendingInteraction, { kind: 'permission' }>['permissionSuggestions']): string[] {
  if (!suggestions || suggestions.length === 0) return []
  return suggestions.map((suggestion) => {
    const label = suggestion.label || suggestion.action
    const details = [suggestion.description, suggestion.scope].filter(Boolean).join(' · ')
    return details ? `• **${label}** — ${details}` : `• **${label}**`
  })
}

function formatPermissionMetadata(interaction: Extract<PendingInteraction, { kind: 'permission' }>): string[] {
  return [
    interaction.decisionReason ? `**Why Claude asked:** ${interaction.decisionReason}` : '',
    interaction.blockedPath ? `**Path:** ${interaction.blockedPath}` : '',
    interaction.toolUseId ? `**Tool use:** ${interaction.toolUseId}` : '',
    interaction.agentId ? `**Agent:** ${interaction.agentId}` : '',
  ].filter(Boolean)
}

function getPermissionDecisionFromPayload(payload: unknown): 'approve' | 'deny' | null {
  if (!payload || typeof payload !== 'object') return null
  const decision = (payload as Record<string, unknown>).decision
  return decision === 'approve' || decision === 'deny' ? decision : null
}

type LarkInteractionCommand =
  | { type: 'permission'; runId: string; interactionId: string; decision: 'approve' | 'deny' }
  | { type: 'elicitation'; runId: string; interactionId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }
  | { type: 'session'; action: 'current' | 'clear' | 'new' | 'use'; sessionId?: string }
  | { type: 'invalid'; scope: 'permission' | 'elicitation' | 'session'; reason: string }

function getSessionControl(coordinator: RunCoordinator): SessionControlService {
  if (sessionControl) return sessionControl
  sessionControl = new SessionControlService(bindings, coordinator)
  return sessionControl
}

export function configureLarkSessionControl(sharedBindings: SessionBindingStore, control?: SessionControlService): void {
  bindings = sharedBindings
  sessionControl = control ?? null
}

function hasLarkCredentials(): boolean {
  return Boolean(CONFIG.lark.appId && CONFIG.lark.appSecret)
}

function parseLarkMessageText(content: unknown): string {
  if (typeof content !== 'string') return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return typeof parsed.text === 'string' ? parsed.text.trim() : content.trim()
  } catch {
    return content.trim()
  }
}

function cleanupDedupeMap(store: Map<string, number>, now: number): void {
  for (const [key, seenAt] of store.entries()) {
    if (now - seenAt > DEDUPE_TTL_MS) {
      store.delete(key)
    }
  }
}

function markIfDuplicate(store: Map<string, number>, key?: string): boolean {
  if (!key) return false
  const now = Date.now()
  cleanupDedupeMap(store, now)
  if (store.has(key)) return true
  store.set(key, now)
  return false
}

function isDuplicateMessage(platformMessageId?: string): boolean {
  return markIfDuplicate(processedMessageIds, platformMessageId)
}

function isDuplicateAction(actionKey?: string): boolean {
  return markIfDuplicate(processedActionKeys, actionKey)
}

async function isDuplicateInboundMessage(conversationKey: string, platformMessageId?: string): Promise<boolean> {
  if (!platformMessageId) return false
  if (isDuplicateMessage(platformMessageId)) return true
  const binding = await bindings.get({ channel: 'lark', conversationKey })
  return binding?.lastInboundPlatformMessageId === platformMessageId
}

function parseInteractionContent(raw: string): Record<string, string | number | boolean | string[]> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, string | number | boolean | string[]>
  } catch {
    return { response: trimmed }
  }
}

function parseLarkInteractionCommand(text: string): LarkInteractionCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const permissionMatch = trimmed.match(/^\/permission\s+(\S+)\s+(\S+)\s+(approve|deny)$/)
  if (permissionMatch) {
    return {
      type: 'permission',
      runId: permissionMatch[1],
      interactionId: permissionMatch[2],
      decision: permissionMatch[3] as 'approve' | 'deny',
    }
  }

  const elicitationMatch = trimmed.match(/^\/elicitation\s+(\S+)\s+(\S+)\s+(accept|decline|cancel)(?:\s+([\s\S]+))?$/)
  if (elicitationMatch) {
    const action = elicitationMatch[3] as 'accept' | 'decline' | 'cancel'
    const content = action === 'accept' ? parseInteractionContent(elicitationMatch[4] ?? '') : undefined
    if (action === 'accept' && !content) {
      return {
        type: 'invalid',
        scope: 'elicitation',
        reason: 'accept requires JSON object content or plain text content',
      }
    }
    return {
      type: 'elicitation',
      runId: elicitationMatch[1],
      interactionId: elicitationMatch[2],
      action,
      ...(content ? { content } : {}),
    }
  }

  const sessionCurrentMatch = trimmed.match(/^\/session\s+current$/)
  if (sessionCurrentMatch) {
    return { type: 'session', action: 'current' }
  }

  const sessionClearMatch = trimmed.match(/^\/session\s+clear$/)
  if (sessionClearMatch) {
    return { type: 'session', action: 'clear' }
  }

  const sessionNewMatch = trimmed.match(/^\/session\s+new$/)
  if (sessionNewMatch) {
    return { type: 'session', action: 'new' }
  }

  const sessionUseMatch = trimmed.match(/^\/session\s+use\s+(\S+)$/)
  if (sessionUseMatch) {
    return {
      type: 'session',
      action: 'use',
      sessionId: sessionUseMatch[1],
    }
  }

  if (trimmed.startsWith('/permission')) {
    return {
      type: 'invalid',
      scope: 'permission',
      reason: 'use /permission <runId> <interactionId> approve|deny',
    }
  }

  if (trimmed.startsWith('/elicitation')) {
    return {
      type: 'invalid',
      scope: 'elicitation',
      reason: 'use /elicitation <runId> <interactionId> accept <json|text> | decline | cancel',
    }
  }

  if (trimmed.startsWith('/session')) {
    return {
      type: 'invalid',
      scope: 'session',
      reason: 'use /session current | /session use <sessionId> | /session clear | /session new',
    }
  }

  return null
}

function getLarkClient(): any | null {
  if (!hasLarkCredentials()) return null
  if (clientInstance) return clientInstance

  clientInstance = new Lark.Client({
    appId: CONFIG.lark.appId,
    appSecret: CONFIG.lark.appSecret,
  })
  return clientInstance
}

function getLarkWsClient(): any | null {
  if (!hasLarkCredentials()) return null
  if (wsClientInstance) return wsClientInstance

  wsClientInstance = new Lark.WSClient({
    appId: CONFIG.lark.appId,
    appSecret: CONFIG.lark.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  })

  patchLarkWsClientForCardCallbacks(wsClientInstance)
  return wsClientInstance
}

function patchLarkWsClientForCardCallbacks(wsClient: any): void {
  if (wsClientCardPatched) return
  const originalHandleEventData = wsClient?.handleEventData
  if (typeof originalHandleEventData !== 'function') return

  wsClient.handleEventData = async function patchedHandleEventData(data: any): Promise<void> {
    const headers = Array.isArray(data?.headers)
      ? data.headers.reduce((acc: Record<string, string>, cur: { key?: string; value?: string }) => {
          if (typeof cur?.key === 'string' && typeof cur?.value === 'string') {
            acc[cur.key] = cur.value
          }
          return acc
        }, {})
      : {}
    const frameType = headers.type
    const payload = data?.payload instanceof Uint8Array ? data.payload : null

    if (frameType === 'card') {
      if (payload) {
        data = {
          ...data,
          headers: Array.isArray(data.headers)
            ? data.headers.map((entry: { key?: string; value?: string }) =>
                entry?.key === 'type' ? { ...entry, value: 'event' } : entry,
              )
            : data.headers,
        }
      } else {
        logger.warn('lark:ws:frame:card:missing-payload', { headers })
      }
    }

    return await originalHandleEventData.call(this, data)
  }

  wsClientCardPatched = true
}

export async function startLarkLongConnection(coordinator: RunCoordinator): Promise<void> {
  const wsClient = getLarkWsClient()
  if (!wsClient) {
    logger.info('lark:ws:disabled', { reason: 'missing-config' })
    return
  }
  if (wsStartPromise) return await wsStartPromise

  logger.info('lark:ws:starting', {
    hasVerificationToken: Boolean(CONFIG.lark.verificationToken),
    hasEncryptKey: Boolean(CONFIG.lark.encryptKey),
    appIdConfigured: Boolean(CONFIG.lark.appId),
  })
  const startPromise = wsClient.start({
    eventDispatcher: createLarkEventDispatcher(coordinator),
  }).then(() => {
    logger.info('lark:ws:started', {})
  }).catch((error: unknown) => {
    wsStartPromise = null
    logger.error('lark:ws:start:error', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  })

  wsStartPromise = startPromise
  return await startPromise
}

async function appendLarkChannelLog(params: {
  sessionId?: string
  runId?: string
  direction: 'inbound' | 'outbound' | 'internal'
  eventName: string
  conversationKey?: string
  platformMessageId?: string
  payloadSummary?: string
  payload?: unknown
  rawPayload?: unknown
}): Promise<void> {
  if (typeof params.sessionId !== 'string' || !params.sessionId) return
  await appendSessionChannelLog(params.sessionId, {
    source: 'channel',
    channel: 'lark',
    direction: params.direction,
    eventName: params.eventName,
    ...(params.conversationKey ? { conversationKey: params.conversationKey } : {}),
    ...(params.platformMessageId ? { platformMessageId: params.platformMessageId } : {}),
    ...(params.payloadSummary ? { payloadSummary: params.payloadSummary } : {}),
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
    ...(params.rawPayload !== undefined ? { rawPayload: params.rawPayload } : {}),
  }, params.runId)
}

async function handleInteractionCommand(
  coordinator: RunCoordinator,
  control: SessionControlService,
  conversationKey: string,
  command: LarkInteractionCommand,
): Promise<void> {
  if (command.type === 'invalid') {
    await sendLarkTextMessage(conversationKey, `Invalid ${command.scope} command: ${command.reason}`)
    return
  }

  if (command.type === 'session') {
    const ref = { channel: 'lark' as const, conversationKey }
    if (command.action === 'current') {
      const status = await control.getBindingStatus(ref)
      const binding = status.binding
      const session = status.session
      const activeRun = status.activeRun
      const lines = [
        `Conversation: ${conversationKey}`,
        binding
          ? `Bound session: ${binding.sessionId}`
          : 'Bound session: none',
        session?.title ? `Session title: ${session.title}` : '',
        activeRun ? `Active run: ${activeRun.runId} (${activeRun.state})` : 'Active run: none',
      ].filter(Boolean)
      await sendLarkTextMessage(conversationKey, lines.join('\n'))
      return
    }

    if (command.action === 'clear' || command.action === 'new') {
      await control.clearBinding(ref)
      await sendLarkTextMessage(
        conversationKey,
        command.action === 'new'
          ? 'Cleared current binding. The next message will start a new session.'
          : 'Cleared current session binding.',
      )
      return
    }

    const status = await control.bindToSession(ref, command.sessionId ?? '')
    await sendLarkTextMessage(
      conversationKey,
      status.binding
        ? `Bound this chat to session ${status.binding.sessionId}${status.session?.title ? ` (${status.session.title})` : ''}.`
        : 'Failed to bind this chat to the requested session.',
    )
    return
  }

  if (command.type === 'permission') {
    const run = coordinator.getRun(command.runId)
    await appendLarkChannelLog({
      sessionId: run?.sessionId,
      runId: command.runId,
      direction: 'inbound',
      eventName: 'permission.respond',
      conversationKey,
      payloadSummary: command.decision,
      payload: {
        interactionId: command.interactionId,
        decision: command.decision,
      },
    })
    const ok = coordinator.respondToPermission(command.runId, command.interactionId, command.decision)
    await sendLarkTextMessage(
      conversationKey,
      ok
        ? `Permission response recorded: ${command.decision}`
        : 'No matching active run for that permission command.',
    )
    return
  }

  const run = coordinator.getRun(command.runId)
  await appendLarkChannelLog({
    sessionId: run?.sessionId,
    runId: command.runId,
    direction: 'inbound',
    eventName: 'elicitation.respond',
    conversationKey,
    payloadSummary: command.action,
    payload: {
      interactionId: command.interactionId,
      action: command.action,
      ...(command.content ? { content: command.content } : {}),
    },
  })
  const ok = coordinator.respondToElicitation(command.runId, command.interactionId, command.action, command.content)
  await sendLarkTextMessage(
    conversationKey,
    ok
      ? `Elicitation response recorded: ${command.action}`
      : 'No matching active run for that elicitation command.',
  )
}

function buildPermissionCard(runId: string, interaction: Extract<PendingInteraction, { kind: 'permission' }>): Lark.InteractiveCard {
  const title = interaction.title || interaction.displayName || interaction.toolName
  const description = interaction.description || 'Claude 需要你的确认后才能继续执行。'
  const metadataLines = formatPermissionMetadata(interaction)
  const suggestionLines = formatPermissionSuggestions(interaction.permissionSuggestions)

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${title}**\n${description}`,
      },
    },
  ]

  if (metadataLines.length > 0) {
    elements.push({
      tag: 'note',
      elements: metadataLines.map((item) => ({
        tag: 'plain_text',
        content: item.replace(/\*\*/g, ''),
      })),
    })
  }

  if (suggestionLines.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Suggested action**\n${suggestionLines.join('\n')}`,
      },
    })
  }

  elements.push(
    {
      tag: 'hr',
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'primary',
          text: {
            tag: 'plain_text',
            content: 'Approve and continue',
          },
          value: {
            actionType: 'permission',
            runId,
            interactionId: interaction.id,
            decision: 'approve',
          },
        },
        {
          tag: 'button',
          type: 'danger',
          text: {
            tag: 'plain_text',
            content: 'Deny request',
          },
          value: {
            actionType: 'permission',
            runId,
            interactionId: interaction.id,
            decision: 'deny',
          },
        },
      ],
    },
  )

  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `Permission required · ${title}`,
      },
    },
    elements: elements as unknown as Lark.InteractiveCard['elements'],
  }
}

function buildPermissionStatusCard(title: string, message: string, template: 'green' | 'red' | 'grey'): Lark.InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: message,
        },
      },
    ],
  }
}

function buildPermissionResolvedCard(decision: 'approve' | 'deny', ok: boolean): Lark.InteractiveCard {
  const approved = ok && decision === 'approve'
  const denied = ok && decision === 'deny'
  return buildPermissionStatusCard(
    ok
      ? (approved ? 'Permission approved' : 'Permission denied')
      : 'Permission unavailable',
    ok
      ? (approved
          ? 'Claude can continue with this action.'
          : 'Claude will not continue with this action.')
      : 'No matching active run was found for this permission action.',
    approved ? 'green' : denied ? 'red' : 'grey',
  )
}

function buildAssistantStreamingCard(params: {
  title?: string
  answerText: string
  thinkingText?: string
  toolCalls?: string[]
  toolResults?: string[]
  isFinal?: boolean
}): Lark.InteractiveCard {
  const mainContent = params.answerText || params.thinkingText || (params.isFinal ? 'Done.' : 'Thinking...')
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: mainContent,
      },
      element_id: STREAMING_CARD_ELEMENT_ID,
    },
  ]

  if (params.thinkingText && params.answerText) {
    elements.unshift({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Thinking**\n${params.thinkingText}`,
      },
    })
  }

  if (params.toolCalls && params.toolCalls.length > 0) {
    elements.push({
      tag: 'note',
      elements: params.toolCalls.map((item) => ({
        tag: 'plain_text',
        content: item,
      })),
    })
  }

  if (params.toolResults && params.toolResults.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: params.toolResults.join('\n\n'),
      },
    })
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: params.isFinal ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: params.title || (params.isFinal ? 'Claude response' : 'Claude is responding'),
      },
    },
    elements: elements as unknown as Lark.InteractiveCard['elements'],
  }
}

function getStreamingState(runId: string): LarkStreamingState | null {
  return larkStreamingStates.get(runId) ?? null
}

function setStreamingState(state: LarkStreamingState): LarkStreamingState {
  larkStreamingStates.set(state.runId, state)
  return state
}

function clearStreamingState(runId: string): void {
  larkStreamingStates.delete(runId)
}

function buildStreamingState(record: RunRecord): LarkStreamingState {
  return setStreamingState({
    runId: record.runId,
    conversationKey: record.conversationKey,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    mode: 'interactive',
    phase: 'idle',
    accumulatedText: '',
    sequence: 0,
  })
}

function resolveStreamingState(record: RunRecord): LarkStreamingState {
  return getStreamingState(record.runId) ?? buildStreamingState(record)
}

function buildStructuredAssistantCardState(event: Extract<SessionEvent, { type: 'session.sdk.message' }>, record: RunRecord): LarkStreamingState | null {
  const parsed = event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
  if (!parsed || parsed.role !== 'assistant' || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
    return null
  }
  if (!hasRenderableTranscriptContent(parsed.blocks)) {
    return null
  }

  const structured = extractStructuredContentFromBlocks(parsed.blocks)
  const segments = [
    structured.answerText,
    ...structured.toolResults.map((item) => item.output).filter(Boolean),
  ].filter(Boolean)
  const accumulatedText = segments.join('\n\n').trim() || buildContentFromBlocks(parsed.blocks).trim()
  const current = resolveStreamingState(record)

  return setStreamingState({
    ...current,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    mode: current.mode,
    phase: 'streaming',
    accumulatedText,
    sequence: event.sequence,
    lastMessageCursor: event.sequence,
  })
}


function buildPermissionCardKitState(record: RunRecord): LarkStreamingState {
  return {
    runId: record.runId,
    conversationKey: record.conversationKey,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    mode: 'cardkit',
    phase: 'completed',
    accumulatedText: '',
    sequence: 0,
  }
}

function createLarkEventDispatcher(coordinator: RunCoordinator): any {
  return new Lark.EventDispatcher({
    ...(CONFIG.lark.encryptKey ? { encryptKey: CONFIG.lark.encryptKey } : {}),
    ...(CONFIG.lark.verificationToken ? { verificationToken: CONFIG.lark.verificationToken } : {}),
  }).register({
    'im.message.receive_v1': async (data: any) => {
      await handleLarkMessageEvent(coordinator, data)
      return undefined
    },
    'im.message.message_read_v1': async () => {
      return undefined
    },
    'card.action.trigger': async (data: any) => {
      return await handleLarkCardActionEvent(coordinator, data)
    },
  })
}

async function handleLarkMessageEvent(coordinator: RunCoordinator, data: any): Promise<void> {
  const conversationKey = typeof data?.message?.chat_id === 'string' ? data.message.chat_id : ''
  const text = parseLarkMessageText(data?.message?.content)
  const userKey = typeof data?.sender?.sender_id?.open_id === 'string'
    ? data.sender.sender_id.open_id
    : typeof data?.sender?.sender_id?.user_id === 'string'
      ? data.sender.sender_id.user_id
      : undefined
  const platformMessageId = typeof data?.message?.message_id === 'string' ? data.message.message_id : undefined

  if (!conversationKey || !text) {
    return
  }

  if (await isDuplicateInboundMessage(conversationKey, platformMessageId)) {
    return
  }

  const control = getSessionControl(coordinator)
  const interactionCommand = parseLarkInteractionCommand(text)
  if (interactionCommand) {
    await handleInteractionCommand(coordinator, control, conversationKey, interactionCommand)
    return
  }

  const currentBinding = await control.getBindingStatus({ channel: 'lark', conversationKey })
  const resolvedSessionId = currentBinding.binding?.sessionId
  const inbound = control.resolveInboundMessage(
    toLarkInboundMessage({
      conversationKey,
      text,
      ...(userKey ? { userKey } : {}),
      ...(platformMessageId ? { platformMessageId } : {}),
    }),
    resolvedSessionId,
  )
  logger.info('lark:message:session-resolved', {
    conversationKey,
    platformMessageId,
    bindingSessionId: shortId(currentBinding.binding?.sessionId),
    explicitSessionId: shortId(undefined),
    finalSessionId: shortId(inbound.sessionId),
  })
  const run = await coordinator.startRun(inbound)
  await appendLarkChannelLog({
    sessionId: run.sessionId,
    runId: run.runId,
    direction: 'inbound',
    eventName: 'message.accepted',
    conversationKey,
    platformMessageId,
    payloadSummary: text,
  })
}

async function handleLarkCardActionEvent(coordinator: RunCoordinator, data: Lark.InteractiveCardActionEvent): Promise<unknown> {
  const cardEvent = data as Lark.InteractiveCardActionEvent & { open_chat_id?: string }
  const runId = typeof data?.action?.value?.runId === 'string' ? data.action.value.runId : undefined
  const actionType = typeof data?.action?.value?.actionType === 'string' ? data.action.value.actionType : undefined
  const run = runId ? coordinator.getRun(runId) : null

  await appendLarkChannelLog({
    sessionId: run?.sessionId,
    runId,
    direction: 'inbound',
    eventName: 'card-action.received',
    conversationKey: typeof cardEvent.open_chat_id === 'string' ? cardEvent.open_chat_id : undefined,
    platformMessageId: typeof data?.open_message_id === 'string' ? data.open_message_id : undefined,
    payloadSummary: actionType || 'card-action',
    payload: {
      openMessageId: data?.open_message_id,
      actionType,
      decision: data?.action?.value?.decision,
      source: 'ws',
    },
  })

  return await processLarkPermissionAction(coordinator, data)
}

function wrapLarkCardResponse(card: Lark.InteractiveCard): { card: { type: 'raw'; data: Lark.InteractiveCard } } {
  return {
    card: {
      type: 'raw',
      data: card,
    },
  }
}

async function processLarkPermissionAction(coordinator: RunCoordinator, data: Lark.InteractiveCardActionEvent): Promise<unknown> {
  const runId = typeof data?.action?.value?.runId === 'string' ? data.action.value.runId : ''
  const interactionId = typeof data?.action?.value?.interactionId === 'string' ? data.action.value.interactionId : ''
  const decision = data?.action?.value?.decision === 'approve' || data?.action?.value?.decision === 'deny'
    ? data.action.value.decision
    : null
  const actionType = typeof data?.action?.value?.actionType === 'string' ? data.action.value.actionType : ''
  const actionKey = [data?.open_message_id, runId, interactionId, decision ?? 'invalid'].join(':')

  if (actionType !== 'permission' || !runId || !interactionId || !decision) {
    logger.warn('lark:card-action:invalid', {
      openMessageId: data?.open_message_id,
      runId,
      interactionId,
      actionType,
      source: 'ws',
    })
    return {
      toast: {
        type: 'error',
        content: 'Invalid permission action.',
      },
    }
  }

  if (isDuplicateAction(actionKey)) {
    return {
      toast: {
        type: 'info',
        content: 'This permission action was already handled.',
      },
    }
  }

  const ok = coordinator.respondToPermission(runId, interactionId, decision)
  const resolvedCard = buildPermissionResolvedCard(decision, ok)
  return {
    ...(ok
      ? {
          toast: {
            type: 'success',
            content: decision === 'approve' ? 'Permission approved.' : 'Permission denied.',
          },
        }
      : {
          toast: {
            type: 'error',
            content: 'No matching active run for that permission action.',
          },
        }),
    ...wrapLarkCardResponse(resolvedCard),
  }
}

function getLarkDispatcher(coordinator: RunCoordinator): any {
  if (dispatcherInstance) return dispatcherInstance

  dispatcherInstance = createLarkEventDispatcher(coordinator)
  return dispatcherInstance
}

export async function invokeLarkEvent(coordinator: RunCoordinator, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const dispatcher = getLarkDispatcher(coordinator)
  const assigned = Object.assign(Object.create({ headers }), body as object)
  return dispatcher.invoke(assigned)
}

export async function sendLarkTextMessage(conversationKey: string, text: string): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:send:error', {
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function sendLarkCardMessage(
  conversationKey: string,
  card: unknown,
): Promise<{ delivered: boolean; response?: unknown; error?: string; content: string; responseContent?: string }> {
  const client = getLarkClient()
  const content = JSON.stringify(card)
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured', content }
  }

  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        msg_type: 'interactive',
        content,
      },
    })
    return {
      delivered: true,
      response,
      content,
      responseContent: JSON.stringify(response),
    }
  } catch (error) {
    logger.error('lark:send-card:error', {
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      delivered: false,
      error: error instanceof Error ? error.message : String(error),
      content,
    }
  }
}

async function sendLarkCardKitMessage(
  conversationKey: string,
  card: unknown,
): Promise<{ delivered: boolean; cardId?: string; messageId?: string; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const cardResponse = await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    })
    const cardId = typeof cardResponse?.data?.card_id === 'string'
      ? cardResponse.data.card_id
      : undefined
    if (!cardId) {
      return { delivered: false, response: cardResponse, error: 'CardKit card_id missing' }
    }

    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        msg_type: 'interactive',
        content: JSON.stringify({
          type: 'card',
          data: { card_id: cardId },
        }),
      },
    })

    return {
      delivered: true,
      cardId,
      messageId: typeof response?.data?.message_id === 'string' ? response.data.message_id : undefined,
      response,
    }
  } catch (error) {
    logger.error('lark:send-cardkit:error', {
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function updateLarkCardKitStreamingContent(
  state: LarkStreamingState,
  card: ReturnType<typeof buildAssistantStreamingCard>,
): Promise<{ delivered: boolean; error?: string; response?: unknown }> {
  const client = getLarkClient()
  if (!client || !state.cardId) {
    return { delivered: false, error: 'Lark CardKit is not configured' }
  }

  try {
    const markdownElement = Array.isArray(card.elements)
      ? card.elements.find((element) => {
          if (!element || typeof element !== 'object') return false
          return (element as { tag?: unknown }).tag === 'div'
        })
      : null
    const text = markdownElement && typeof markdownElement === 'object'
      ? ((markdownElement as { text?: unknown }).text as Record<string, unknown> | undefined)
      : undefined
    const content = text && typeof text.content === 'string' ? text.content : state.accumulatedText

    const response = await client.cardkit.v1.cardElement.content({
      data: {
        content,
        sequence: Math.max(1, state.sequence),
      },
      path: {
        card_id: state.cardId,
        element_id: STREAMING_CARD_ELEMENT_ID,
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:cardkit:stream:error', {
      runId: state.runId,
      cardId: state.cardId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function finalizeLarkCardKit(
  state: LarkStreamingState,
  card: ReturnType<typeof buildAssistantStreamingCard>,
): Promise<{ delivered: boolean; error?: string; response?: unknown }> {
  const client = getLarkClient()
  if (!client || !state.cardId) {
    return { delivered: false, error: 'Lark CardKit is not configured' }
  }

  try {
    await client.cardkit.v1.card.settings({
      data: {
        settings: JSON.stringify({ streaming_mode: false }),
        sequence: Math.max(1, state.sequence),
      },
      path: {
        card_id: state.cardId,
      },
    })
    const response = await client.cardkit.v1.card.update({
      data: {
        card: {
          type: 'card_json',
          data: JSON.stringify({
            schema: '2.0',
            config: card.config,
            header: card.header,
            body: { elements: card.elements },
          }),
        },
        sequence: Math.max(2, state.sequence + 1),
      },
      path: {
        card_id: state.cardId,
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:cardkit:finalize:error', {
      runId: state.runId,
      cardId: state.cardId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function toLarkInboundMessage(event: LarkInboundEvent): ChannelInboundMessage {
  return {
    channel: 'lark',
    conversationKey: event.conversationKey,
    ...(event.userKey ? { userKey: event.userKey } : {}),
    text: event.text,
    ...(event.platformMessageId ? { platformMessageId: event.platformMessageId } : {}),
  }
}

export function createLarkOutboundMessage(runId: string, sessionId: string | undefined, conversationKey: string, content: string): ChannelOutboundMessage {
  return {
    channel: 'lark',
    conversationKey,
    runId,
    ...(sessionId ? { sessionId } : {}),
    content,
  }
}

function summarizePermissionInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'permission' }>): string {
  const title = interaction.title || interaction.displayName || interaction.toolName
  const description = interaction.description ? `\n${interaction.description}` : ''
  return [
    `Permission required: ${title}${description}`,
    `Approve: /permission ${runId} ${interaction.id} approve`,
    `Deny: /permission ${runId} ${interaction.id} deny`,
  ].join('\n')
}

function summarizeAskUserQuestionInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'ask_user_question' }>): string {
  const optionsHint = interaction.options.map((option) => option.label).join(' / ')
  return [
    interaction.prompt || 'Question required',
    optionsHint ? `Options: ${optionsHint}` : '',
    `Accept: /elicitation ${runId} ${interaction.id} accept {"answers":{"${interaction.field}":"<value>"}}`,
    `Decline: /elicitation ${runId} ${interaction.id} decline`,
    `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
  ].filter(Boolean).join('\n')
}

function summarizeElicitationInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'elicitation' }>): string {
  const schemaHint = interaction.requestedSchema
    ? `\nSchema hint: ${JSON.stringify(interaction.requestedSchema)}`
    : ''
  return [
    interaction.message || 'Additional input required',
    `Accept with text: /elicitation ${runId} ${interaction.id} accept your answer`,
    `Accept with JSON: /elicitation ${runId} ${interaction.id} accept {"field":"value"}`,
    `Decline: /elicitation ${runId} ${interaction.id} decline`,
    `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
  ].join('\n') + schemaHint
}

export function summarizeLarkInteraction(runId: string, interaction: PendingInteraction): string {
  if (interaction.kind === 'permission') {
    return summarizePermissionInteraction(runId, interaction)
  }
  if (interaction.kind === 'ask_user_question') {
    return summarizeAskUserQuestionInteraction(runId, interaction)
  }
  return summarizeElicitationInteraction(runId, interaction)
}

export function extractLarkAssistantText(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): string {
  const parsed = event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
  if (!parsed || parsed.role !== 'assistant') return ''
  if (Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
    const structured = extractStructuredContentFromBlocks(parsed.blocks)
    return [
      structured.thinkingText ? `Thinking:\n${structured.thinkingText}` : '',
      structured.answerText,
      ...structured.toolCalls.map((item) => `[Tool call] ${item.name}`),
      ...structured.toolResults.map((item) => item.output ? `[Tool result]\n${item.output}` : '[Tool result]'),
    ].filter(Boolean).join('\n\n').trim()
  }
  return parsed.content.trim()
}

function buildAssistantStreamingDelivery(
  event: Extract<SessionEvent, { type: 'session.sdk.message' }>,
  record: RunRecord,
): LarkOutboundDelivery[] {
  const parsed = event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
  if (!parsed || parsed.role !== 'assistant' || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
    return []
  }

  const nextState = buildStructuredAssistantCardState(event, record)
  if (!nextState) return []

  const structured = extractStructuredContentFromBlocks(parsed.blocks)
  const fallbackText = buildContentFromBlocks(parsed.blocks).trim()
  if (nextState.mode === 'text') {
    return fallbackText
      ? [{
          conversationKey: record.conversationKey,
          text: fallbackText,
          runId: record.runId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          mode: 'fallback',
          state: nextState,
        }]
      : []
  }

  return [{
    conversationKey: record.conversationKey,
    card: buildAssistantStreamingCard({
      answerText: structured.answerText,
      thinkingText: structured.thinkingText,
      toolCalls: structured.toolCalls.map((item) => `[Tool call] ${item.name}`),
      toolResults: structured.toolResults.map((item) => item.output ? `[Tool result]\n${item.output}` : '[Tool result]'),
      isFinal: false,
    }),
    runId: record.runId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    mode: nextState.cardId ? 'stream' : 'create',
    state: nextState,
  }]
}

function buildAssistantFinalizeDelivery(record: RunRecord): LarkOutboundDelivery[] {
  const state = getStreamingState(record.runId)
  if (!state || state.phase !== 'streaming') return []

  const finalized = setStreamingState({
    ...state,
    phase: 'completed',
    finalizedAt: Date.now(),
  })

  if (finalized.mode === 'text') {
    return finalized.accumulatedText
      ? [{
          conversationKey: record.conversationKey,
          text: finalized.accumulatedText,
          runId: record.runId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          mode: 'finalize',
          state: finalized,
        }]
      : []
  }

  return [{
    conversationKey: record.conversationKey,
    card: buildAssistantStreamingCard({
      answerText: finalized.accumulatedText,
      isFinal: true,
    }),
    runId: record.runId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    mode: 'finalize',
    state: finalized,
  }]
}

export function buildLarkDeliveries(event: SessionEvent, record: RunRecord): LarkOutboundDelivery[] {
  if (record.channel !== 'lark') return []

  switch (event.type) {
    case 'session.sdk.message':
      return buildAssistantStreamingDelivery(event, record)
    case 'session.interactive.awaiting_user':
    case 'session.control.awaiting_user':
      if (!event.transaction.interaction) return []
      if (event.transaction.interaction.kind === 'permission') {
        return [{
          conversationKey: record.conversationKey,
          text: summarizePermissionInteraction(record.runId, event.transaction.interaction),
          card: buildPermissionCard(record.runId, event.transaction.interaction),
          runId: record.runId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          mode: 'create',
          state: buildPermissionCardKitState(record),
          preferRawCardFallback: true,
        }]
      }
      return [{
        conversationKey: record.conversationKey,
        text: summarizeLarkInteraction(record.runId, event.transaction.interaction),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'fallback',
      }]
    case 'session.interactive.completed':
    case 'session.interactive.cancelled':
    case 'session.control.completed':
    case 'session.control.cancelled': {
      if (!event.transaction.interaction || event.transaction.interaction.kind !== 'permission') return []
      const decision = getPermissionDecisionFromPayload(event.payload) ?? 'approve'
      const ok = event.transaction.interaction.status === 'resolved'
      return [{
        conversationKey: record.conversationKey,
        text: ok
          ? `Permission ${decision}`
          : 'Permission unavailable',
        card: buildPermissionResolvedCard(decision, ok),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'create',
        state: buildPermissionCardKitState(record),
        preferRawCardFallback: true,
      }]
    }
    case 'session.run.completed': {
      const finalized = buildAssistantFinalizeDelivery(record)
      if (finalized.length > 0) return finalized
      return [{
        conversationKey: record.conversationKey,
        text: 'Run completed, but no renderable assistant message was produced for Lark delivery.',
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'fallback',
      }]
    }
    case 'session.run.cancelled':
      return buildAssistantFinalizeDelivery(record)
    case 'session.run.failed': {
      const finalized = buildAssistantFinalizeDelivery(record)
      if (finalized.length > 0) return finalized
      return [{
        conversationKey: record.conversationKey,
        text: `Run failed: ${event.error}`,
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'fallback',
      }]
    }
    default:
      return []
  }
}

export async function deliverLarkSessionEvent(event: SessionEvent, record: RunRecord): Promise<void> {
  const deliveries = buildLarkDeliveries(event, record)
  if (deliveries.length === 0) return

  logger.info('lark:deliveries:built', {
    count: deliveries.length,
    runId: record.runId,
    sessionId: record.sessionId,
  })

  for (const delivery of deliveries) {
    await appendLarkChannelLog({
      sessionId: delivery.sessionId,
      runId: delivery.runId,
      direction: 'outbound',
      eventName: 'message.requested',
      conversationKey: delivery.conversationKey,
      payloadSummary: delivery.text || (delivery.card ? 'interactive-card' : 'outbound'),
      payload: delivery.card ?? delivery.text,
    })

    if (delivery.card && delivery.state && delivery.state.mode === 'cardkit') {
      if (!delivery.state.cardId && delivery.mode === 'create') {
        const result = await sendLarkCardKitMessage(delivery.conversationKey, {
          schema: '2.0',
          config: delivery.card && typeof delivery.card === 'object' && 'config' in (delivery.card as Record<string, unknown>)
            ? ((delivery.card as Record<string, unknown>).config as Record<string, unknown>)
            : { wide_screen_mode: true, streaming_mode: true },
          header: delivery.card && typeof delivery.card === 'object' && 'header' in (delivery.card as Record<string, unknown>)
            ? (delivery.card as Record<string, unknown>).header
            : undefined,
          body: {
            elements: delivery.card && typeof delivery.card === 'object' && 'elements' in (delivery.card as Record<string, unknown>)
              ? (delivery.card as Record<string, unknown>).elements
              : [],
          },
        })
        if (result.delivered) {
          if (delivery.state) {
            setStreamingState({
              ...delivery.state,
              cardId: result.cardId,
              messageId: result.messageId,
            })
          }
        } else if (delivery.state) {
          setStreamingState({
            ...delivery.state,
            mode: 'text',
          })
        }
        await appendLarkChannelLog({
          sessionId: delivery.sessionId,
          runId: delivery.runId,
          direction: 'outbound',
          eventName: result.delivered ? 'message.delivered' : 'message.failed',
          conversationKey: delivery.conversationKey,
          payloadSummary: result.delivered ? 'cardkit-card' : (result.error || 'failed'),
          payload: result,
        })
        if (result.delivered) continue
        if (delivery.card && delivery.preferRawCardFallback) {
          const rawFallback = await sendLarkCardMessage(delivery.conversationKey, delivery.card)
          await appendLarkChannelLog({
            sessionId: delivery.sessionId,
            runId: delivery.runId,
            direction: 'outbound',
            eventName: 'card.raw.requested',
            conversationKey: delivery.conversationKey,
            payloadSummary: 'interactive-card-raw',
            rawPayload: rawFallback.content,
            payload: {
              contentLength: rawFallback.content.length,
            },
          })
          await appendLarkChannelLog({
            sessionId: delivery.sessionId,
            runId: delivery.runId,
            direction: 'outbound',
            eventName: rawFallback.delivered ? 'message.delivered' : 'message.failed',
            conversationKey: delivery.conversationKey,
            payloadSummary: rawFallback.delivered ? 'interactive-card' : (rawFallback.error || 'failed'),
            rawPayload: rawFallback.responseContent,
            payload: rawFallback,
          })
          if (rawFallback.delivered) continue
        }
        if (delivery.text) {
          const fallback = await sendLarkTextMessage(delivery.conversationKey, delivery.text)
          await appendLarkChannelLog({
            sessionId: delivery.sessionId,
            runId: delivery.runId,
            direction: 'outbound',
            eventName: fallback.delivered ? 'message.delivered' : 'message.failed',
            conversationKey: delivery.conversationKey,
            payloadSummary: fallback.delivered ? delivery.text : (fallback.error || 'failed'),
            payload: fallback,
          })
          continue
        }
      }

      if (delivery.state.cardId && delivery.mode === 'stream') {
        const result = await updateLarkCardKitStreamingContent(delivery.state, delivery.card as ReturnType<typeof buildAssistantStreamingCard>)
        await appendLarkChannelLog({
          sessionId: delivery.sessionId,
          runId: delivery.runId,
          direction: 'outbound',
          eventName: result.delivered ? 'message.delivered' : 'message.failed',
          conversationKey: delivery.conversationKey,
          payloadSummary: result.delivered ? 'cardkit-stream' : (result.error || 'failed'),
          payload: result,
        })
        if (result.delivered) continue
      }

      if (delivery.state.cardId && delivery.mode === 'finalize') {
        const result = await finalizeLarkCardKit(delivery.state, delivery.card as ReturnType<typeof buildAssistantStreamingCard>)
        await appendLarkChannelLog({
          sessionId: delivery.sessionId,
          runId: delivery.runId,
          direction: 'outbound',
          eventName: result.delivered ? 'message.delivered' : 'message.failed',
          conversationKey: delivery.conversationKey,
          payloadSummary: result.delivered ? 'cardkit-finalize' : (result.error || 'failed'),
          payload: result,
        })
        clearStreamingState(delivery.runId || record.runId)
        if (result.delivered) continue
      }
    }

    if (delivery.card) {
      const result = await sendLarkCardMessage(delivery.conversationKey, delivery.card)
      if (delivery.state) {
        const nextMode = result.delivered ? delivery.state.mode : 'text'
        setStreamingState({
          ...delivery.state,
          mode: nextMode,
        })
      }
      await appendLarkChannelLog({
        sessionId: delivery.sessionId,
        runId: delivery.runId,
        direction: 'outbound',
        eventName: 'card.raw.requested',
        conversationKey: delivery.conversationKey,
        payloadSummary: 'interactive-card-raw',
        rawPayload: result.content,
        payload: {
          contentLength: result.content.length,
        },
      })
      await appendLarkChannelLog({
        sessionId: delivery.sessionId,
        runId: delivery.runId,
        direction: 'outbound',
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        conversationKey: delivery.conversationKey,
        payloadSummary: result.delivered ? 'interactive-card' : (result.error || 'failed'),
        rawPayload: result.responseContent,
        payload: result,
      })
      continue
    }
    if (delivery.text) {
      const result = await sendLarkTextMessage(delivery.conversationKey, delivery.text)
      if (delivery.mode === 'finalize') {
        clearStreamingState(delivery.runId || record.runId)
      }
      await appendLarkChannelLog({
        sessionId: delivery.sessionId,
        runId: delivery.runId,
        direction: 'outbound',
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        conversationKey: delivery.conversationKey,
        payloadSummary: result.delivered ? delivery.text : (result.error || 'failed'),
        payload: result,
      })
    }
  }
}
