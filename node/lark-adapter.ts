import * as Lark from '@larksuiteoapi/node-sdk'
import { CONFIG } from './config.js'
import { createLogger, shortId } from './logger.js'
import { KeyedTaskQueue } from './keyed-task-queue.js'
import { optimizeLarkMarkdownStyle } from './lark-markdown-style.js'
import { SessionBindingStore } from './session-bindings.js'
import { SessionControlService } from './session-control-service.js'
import { LarkStreamingController } from './lark-streaming-controller.js'
import { DedupeStore } from './dedupe-store.js'
import { getMessages } from './sessions.js'
import type {
  AssistantDisplayItem,
  ChannelInboundMessage,
  ChannelOutboundMessage,
  CollapsedToolBatchDisplayItem,
  DisplayAssistantFooter,
  DisplayFragment,
  GroupedToolUseDisplayItem,
  LarkStreamingState,
  PendingInteraction,
  SessionEvent,
  SessionMessage,
} from '../shared/message-types.js'
import type { RunCoordinator, RunRecord } from './run-coordinator.js'
import {
  buildContentFromBlocks,
  extractStructuredContentFromBlocks,
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptStopReason,
  hasRenderableTranscriptContent,
  normalizeSdkEnvelopeMessage,
  stringifyStructuredValue,
} from '../shared/transcript-normalizer.js'
import {
  buildElicitationContent,
  inferElicitationRenderer,
  type ElicitationRenderer,
} from '../shared/elicitation-renderer.js'
import { buildAssistantFooterText } from '../shared/assistant-footer-format.js'
import { buildHistoryDisplayItems, getAssistantFooter } from '../shared/transcript-display.js'

const logger = createLogger('lark-adapter')
const DEDUPE_TTL_MS = 10 * 60 * 1000

let clientInstance: any | null = null
let dispatcherInstance: any | null = null
let wsClientInstance: any | null = null
let wsClientCardPatched = false
let wsStartPromise: Promise<void> | null = null
let bindings = new SessionBindingStore()
let sessionControl: SessionControlService | null = null
const messageDedupe = new DedupeStore(DEDUPE_TTL_MS)
const actionDedupe = new DedupeStore(DEDUPE_TTL_MS)
const larkStreamingControllers = new Map<string, LarkStreamingController>()
const larkDeliveryQueue = new KeyedTaskQueue(CONFIG.maxConcurrentAgents)
const streamingControllerStartedAt = new Map<string, number>()
const latestAssistantModelByRun = new Map<string, string | null>()
const latestAssistantUsageByRun = new Map<string, ReturnType<typeof getTranscriptAssistantUsage>>()
const latestAssistantStopReasonByRun = new Map<string, string | null>()
const STREAMING_CARD_ELEMENT_ID = 'streaming_content'

export type LarkInboundEvent = {
  conversationKey: string
  userKey?: string
  senderOpenId?: string
  chatType?: 'p2p' | 'group'
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
  preferRawCardFallback?: boolean
  replyToMessageId?: string
  chatType?: 'p2p' | 'group'
  senderOpenId?: string
}

type LarkReplyContext = {
  replyToMessageId?: string
  chatType?: 'p2p' | 'group'
  senderOpenId?: string
}

type LarkElicitationCardActionType =
  | 'elicitation_submit'
  | 'elicitation_decline'
  | 'elicitation_cancel'
  | 'elicitation_continue_url'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function getActionFormValue(data: Lark.InteractiveCardActionEvent): Record<string, unknown> {
  const action = asRecord(data?.action)
  const formValue = asRecord(action?.form_value)
  return formValue ?? {}
}

function getActionValue(data: Lark.InteractiveCardActionEvent): Record<string, unknown> {
  const action = asRecord(data?.action)
  const value = asRecord(action?.value)
  return value ?? {}
}

function getActionType(data: Lark.InteractiveCardActionEvent): string {
  return getString(getActionValue(data).actionType) || ''
}

function getActionName(data: Lark.InteractiveCardActionEvent): string {
  return getString(asRecord(data?.action)?.name) || ''
}

function getActionOption(data: Lark.InteractiveCardActionEvent): string | undefined {
  return getString(asRecord(data?.action)?.option)
}

function getActionChecked(data: Lark.InteractiveCardActionEvent): boolean | undefined {
  const action = asRecord(data?.action)
  return typeof action?.checked === 'boolean' ? action.checked : undefined
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
  | { type: 'stop' }
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

function isDuplicateMessage(platformMessageId?: string): boolean {
  return messageDedupe.checkAndMark(platformMessageId)
}

function isDuplicateAction(actionKey?: string): boolean {
  return actionDedupe.checkAndMark(actionKey)
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

  if (trimmed === '/stop') {
    return { type: 'stop' }
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

function isEventExpired(createTime?: string, expiryMs: number = 30 * 60 * 1000): boolean {
  if (!createTime) return false
  const value = Number(createTime)
  if (!Number.isFinite(value)) return false
  return Date.now() - value > expiryMs
}

function resolveElicitationAvailability(
  coordinator: RunCoordinator,
  runId: string,
  interactionId: string,
): Extract<PendingInteraction, { kind: 'elicitation' }> | null {
  const interaction = coordinator.getCurrentInteraction(runId)
  if (!interaction || interaction.kind !== 'elicitation' || interaction.id !== interactionId) {
    return null
  }
  return interaction
}

function resolvePermissionAvailability(
  coordinator: RunCoordinator,
  runId: string,
  interactionId: string,
): Extract<PendingInteraction, { kind: 'permission' }> | null {
  const interaction = coordinator.getCurrentInteraction(runId)
  if (!interaction || interaction.kind !== 'permission' || interaction.id !== interactionId) {
    return null
  }
  return interaction
}

async function handleInteractionCommand(
  coordinator: RunCoordinator,
  control: SessionControlService,
  conversationKey: string,
  command: LarkInteractionCommand,
  replyContext?: LarkReplyContext,
): Promise<void> {
  if (command.type === 'invalid') {
    await sendLarkTextMessage(conversationKey, `Invalid ${command.scope} command: ${command.reason}`, replyContext)
    return
  }

  if (command.type === 'stop') {
    const activeRun = coordinator.getLatestInterruptibleRunByConversation('lark', conversationKey)
    if (!activeRun) {
      await sendLarkTextMessage(conversationKey, 'No active run to stop.', replyContext)
      return
    }
    const requestId = `stop-${Date.now()}`
    const requested = coordinator.requestControl(activeRun.runId, requestId, { subtype: 'interrupt' })
    const controller = larkStreamingControllers.get(activeRun.runId) ?? null
    if (controller) {
      await controller.abort()
      larkStreamingControllers.delete(activeRun.runId)
    }
    await sendLarkTextMessage(
      conversationKey,
      requested ? 'Stopping current run.' : 'Unable to stop the current run.',
      replyContext,
    )
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
      await sendLarkTextMessage(conversationKey, lines.join('\n'), replyContext)
      return
    }

    if (command.action === 'clear' || command.action === 'new') {
      await control.clearBinding(ref)
      await sendLarkTextMessage(
        conversationKey,
        command.action === 'new'
          ? 'Cleared current binding. The next message will start a new session.'
          : 'Cleared current session binding.',
        replyContext,
      )
      return
    }

    const status = await control.bindToSession(ref, command.sessionId ?? '')
    await sendLarkTextMessage(
      conversationKey,
      status.binding
        ? `Bound this chat to session ${status.binding.sessionId}${status.session?.title ? ` (${status.session.title})` : ''}.`
        : 'Failed to bind this chat to the requested session.',
      replyContext,
    )
    return
  }

  if (command.type === 'permission') {
    const run = coordinator.getRun(command.runId)
    const interaction = resolvePermissionAvailability(coordinator, command.runId, command.interactionId)
    const ok = interaction
      ? coordinator.respondToInteractive(command.runId, command.interactionId, {
          kind: 'permission',
          decision: command.decision,
        })
      : false
    await sendLarkTextMessage(
      conversationKey,
      ok
        ? `Permission response recorded: ${command.decision}`
        : 'No matching active run for that permission command.',
      replyContext,
    )
    return
  }

  const run = coordinator.getRun(command.runId)
  const interaction = resolveElicitationAvailability(coordinator, command.runId, command.interactionId)
  const ok = interaction
    ? coordinator.respondToInteractive(command.runId, command.interactionId, {
        kind: 'elicitation',
        action: command.action,
        ...(command.content ? { content: command.content } : {}),
      })
    : false
  await sendLarkTextMessage(
    conversationKey,
    ok
      ? `Elicitation response recorded: ${command.action}`
      : 'No matching active run for that elicitation command.',
    replyContext,
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

function buildElicitationStatusCard(title: string, message: string, template: 'green' | 'red' | 'grey'): Lark.InteractiveCard {
  return buildPermissionStatusCard(title, message, template)
}

function buildElicitationResolvedCard(action: 'accept' | 'decline' | 'cancel', ok: boolean): Lark.InteractiveCard {
  const accepted = ok && action === 'accept'
  const declined = ok && action === 'decline'
  return buildElicitationStatusCard(
    ok
      ? (accepted ? 'Elicitation submitted' : declined ? 'Elicitation declined' : 'Elicitation cancelled')
      : 'Elicitation unavailable',
    ok
      ? (accepted
          ? 'Claude received the requested input.'
          : declined
            ? 'Claude will continue without this input.'
            : 'This interaction was cancelled.')
      : 'No matching active run was found for this elicitation action.',
    accepted ? 'green' : declined ? 'red' : 'grey',
  )
}

function makePlainText(content: string): Lark.InteractiveCardPlainTextItem {
  return { tag: 'plain_text', content }
}

function makeMarkdown(content: string): Lark.InteractiveCardLarkMdItem {
  return { tag: 'lark_md', content }
}

function buildBaseElicitationCard(title: string, description?: string): { config: Record<string, unknown>; header: Record<string, unknown>; elements: unknown[] } {
  const elements: unknown[] = [{
    tag: 'div',
    text: makeMarkdown(`**${title}**${description ? `\n${description}` : ''}`),
  }]

  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: 'orange',
      title: makePlainText(`Elicitation required · ${title}`),
    },
    elements,
  }
}

function buildElicitationActionValue(runId: string, interactionId: string, renderer: ElicitationRenderer, actionType: LarkElicitationCardActionType): Record<string, unknown> {
  return {
    actionType,
    runId,
    interactionId,
    rendererType: renderer.type,
    ...('field' in renderer ? { field: renderer.field } : {}),
    ...('containerField' in renderer && renderer.containerField ? { containerField: renderer.containerField } : {}),
    ...('valueType' in renderer ? { valueType: renderer.valueType } : {}),
  }
}

function buildElicitationCardActions(
  runId: string,
  interaction: Extract<PendingInteraction, { kind: 'elicitation' }>,
  renderer: ElicitationRenderer,
  options?: { includeSubmit?: boolean; submitLabel?: string; formAction?: boolean },
): Lark.InterfaceCardActionElement {
  const includeSubmit = options?.includeSubmit ?? true
  const submitLabel = options?.submitLabel ?? (renderer.type === 'url_open' ? 'Continue' : 'Submit')
  const formAction = options?.formAction ?? false
  const actions: unknown[] = []

  if (includeSubmit) {
    actions.push({
      tag: 'button',
      type: 'primary',
      text: makePlainText(submitLabel),
      ...(formAction
        ? {
            form_action_type: 'submit',
            name: `submit_${interaction.id.slice(0, 12)}`,
          }
        : {}),
      value: buildElicitationActionValue(
        runId,
        interaction.id,
        renderer,
        renderer.type === 'url_open' ? 'elicitation_continue_url' : 'elicitation_submit',
      ),
    })
  }

  actions.push(
    {
      tag: 'button',
      type: 'default',
      text: makePlainText('Decline'),
      value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_decline'),
    },
    {
      tag: 'button',
      type: 'danger',
      text: makePlainText('Cancel'),
      value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_cancel'),
    },
  )

  return {
    tag: 'action',
    layout: 'trisection',
    actions: actions as Lark.InteractiveCardActionItem[],
  }
}

function buildElicitationCard(runId: string, interaction: Extract<PendingInteraction, { kind: 'elicitation' }>): Lark.InteractiveCard {
  const renderer = inferElicitationRenderer(interaction)
  const card = buildBaseElicitationCard(renderer.title, renderer.description)

  switch (renderer.type) {
    case 'url_open':
      card.elements.push(
        {
          tag: 'div',
          text: makeMarkdown(`Open the URL, complete the external step, then continue here.\n${renderer.url}`),
        },
        {
          tag: 'action',
          layout: 'bisected',
          actions: [
            {
              tag: 'button',
              type: 'default',
              text: makePlainText('Open URL'),
              multi_utl: { url: renderer.url, android_url: renderer.url, ios_url: renderer.url, pc_url: renderer.url },
              value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_continue_url'),
            },
            {
              tag: 'button',
              type: 'primary',
              text: makePlainText('Continue'),
              value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_continue_url'),
            },
          ],
        },
        buildElicitationCardActions(runId, interaction, renderer, { includeSubmit: false }),
      )
      break
    case 'form_text':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'input',
            name: renderer.field,
            required: renderer.required,
            input_type: renderer.type === 'form_text' && renderer.format === 'date-time' ? 'multiline_text' : 'text',
            ...(renderer.placeholder ? { placeholder: makePlainText(renderer.placeholder) } : {}),
            ...(renderer.defaultValue !== undefined ? { default_value: String(renderer.defaultValue) } : {}),
            ...(renderer.type === 'form_text' && renderer.maxLength !== undefined ? { max_length: renderer.maxLength } : {}),
            label: makePlainText(renderer.title),
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'form_boolean':
      card.elements.push(
        {
          tag: 'checker',
          name: renderer.field,
          checked: renderer.defaultValue ?? false,
          text: makePlainText(renderer.title),
          behaviors: [{ type: 'callback', value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_submit') }],
        },
        buildElicitationCardActions(runId, interaction, renderer, { includeSubmit: false }),
      )
      break
    case 'form_single_select':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'select_static',
            name: renderer.field,
            required: renderer.required,
            ...(renderer.defaultValue ? { initial_option: renderer.defaultValue } : {}),
            placeholder: makePlainText('Please select'),
            options: renderer.options.map((option) => ({
              text: makePlainText(option.label),
              value: option.value,
            })),
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'form_multi_select':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'multi_select_static',
            name: renderer.field,
            required: renderer.required,
            selected_values: renderer.defaultValue ?? [],
            placeholder: makePlainText('Select one or more'),
            options: renderer.options.map((option) => ({
              text: makePlainText(option.label),
              value: option.value,
            })),
          },
          {
            tag: 'note',
            elements: [makePlainText(`Min: ${renderer.minSelections ?? 0} · Max: ${renderer.maxSelections ?? renderer.options.length}`)],
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'generic_json_fallback':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'input',
            name: 'json_payload',
            required: true,
            input_type: 'multiline_text',
            rows: 3,
            auto_resize: true,
            max_rows: 6,
            placeholder: makePlainText('{"field":"value"}'),
            label: makePlainText('JSON payload'),
          },
          {
            tag: 'note',
            elements: [makePlainText('Provide a JSON object payload. The /elicitation text command still works as fallback.')],
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
  }

  return {
    config: card.config as unknown as Lark.InteractiveCard['config'],
    header: card.header as unknown as Lark.InteractiveCard['header'],
    elements: card.elements as unknown as Lark.InteractiveCard['elements'],
  }
}

function buildAssistantStreamingCard(params: {
  answerText: string
  thinkingText?: string
  toolCalls?: string[]
  toolResults?: string[]
  footer?: DisplayAssistantFooter
  isFinal?: boolean
}): Record<string, unknown> {
  const mainContent = optimizeLarkMarkdownStyle(params.answerText || params.thinkingText || (params.isFinal ? 'Done.' : 'Processing...'))
  const normalizedThinking = params.thinkingText ? optimizeLarkMarkdownStyle(params.thinkingText) : undefined
  const normalizedToolCalls = params.toolCalls?.map((item) => optimizeLarkMarkdownStyle(item))
  const normalizedToolResults = params.toolResults?.map((item) => optimizeLarkMarkdownStyle(item))
  const elements: unknown[] = []

  if (normalizedThinking && params.answerText) {
    elements.push(createLarkThinkingPanel(normalizedThinking))
  }

  elements.push({
    tag: 'markdown',
    content: mainContent,
    text_align: 'left',
    text_size: 'normal_v2',
    margin: '0px 0px 0px 0px',
    element_id: STREAMING_CARD_ELEMENT_ID,
  })

  if (normalizedToolCalls && normalizedToolCalls.length > 0) {
    for (const toolCall of normalizedToolCalls) {
      elements.push(createLarkToolPanel(toolCall))
    }
  }

  if (normalizedToolResults && normalizedToolResults.length > 0) {
    for (const toolResult of normalizedToolResults) {
      elements.push(createLarkToolResultPanel(toolResult))
    }
  }

  const footerText = params.footer ? buildAssistantFooterText(params.footer) : ''

  if (footerText.trim().length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: footerText,
      text_size: 'notation',
    })
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      ...(params.isFinal ? {} : { streaming_mode: true }),
      locales: ['zh_cn', 'en_us'],
      summary: {
        content: params.isFinal ? 'Claude response' : 'Processing...',
        i18n_content: {
          zh_cn: params.isFinal ? 'Claude 回复' : '处理中...',
          en_us: params.isFinal ? 'Claude response' : 'Processing...',
        },
      },
    },
    body: {
      elements,
    },
  }
}

function getStreamingController(runId: string): LarkStreamingController | null {
  return larkStreamingControllers.get(runId) ?? null
}

function clearStreamingController(runId: string): void {
  larkStreamingControllers.delete(runId)
  streamingControllerStartedAt.delete(runId)
  latestAssistantModelByRun.delete(runId)
  latestAssistantUsageByRun.delete(runId)
  latestAssistantStopReasonByRun.delete(runId)
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
  const senderOpenId = typeof data?.sender?.sender_id?.open_id === 'string' ? data.sender.sender_id.open_id : undefined
  const userKey = senderOpenId
    ?? (typeof data?.sender?.sender_id?.user_id === 'string' ? data.sender.sender_id.user_id : undefined)
  const chatType = data?.message?.chat_type === 'p2p' || data?.message?.chat_type === 'group'
    ? data.message.chat_type
    : undefined
  const platformMessageId = typeof data?.message?.message_id === 'string' ? data.message.message_id : undefined

  if (!conversationKey || !text) {
    return
  }

  if (await isDuplicateInboundMessage(conversationKey, platformMessageId)) {
    return
  }

  if (isEventExpired(typeof data?.message?.create_time === 'string' ? data.message.create_time : undefined)) {
    logger.info('lark:message:expired', { conversationKey, platformMessageId })
    return
  }

  const control = getSessionControl(coordinator)
  const interactionCommand = parseLarkInteractionCommand(text)
  if (interactionCommand) {
    await handleInteractionCommand(
      coordinator,
      control,
      conversationKey,
      interactionCommand,
      {
        ...(platformMessageId ? { replyToMessageId: platformMessageId } : {}),
        ...(chatType ? { chatType } : {}),
        ...(senderOpenId ? { senderOpenId } : {}),
      },
    )
    return
  }

  const currentBinding = await control.getBindingStatus({ channel: 'lark', conversationKey })
  const resolvedSessionId = currentBinding.binding?.sessionId
  const inbound = control.resolveInboundMessage(
    toLarkInboundMessage({
      conversationKey,
      text,
      ...(userKey ? { userKey } : {}),
      ...(senderOpenId ? { senderOpenId } : {}),
      ...(chatType ? { chatType } : {}),
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
}

async function handleLarkCardActionEvent(coordinator: RunCoordinator, data: Lark.InteractiveCardActionEvent): Promise<unknown> {
  const cardEvent = data as Lark.InteractiveCardActionEvent & { open_chat_id?: string }
  const runId = typeof data?.action?.value?.runId === 'string' ? data.action.value.runId : undefined
  const actionType = getActionType(data) || undefined
  const run = runId ? coordinator.getRun(runId) : null


  if ((actionType || '').startsWith('elicitation_')) {
    return await processLarkElicitationAction(coordinator, data)
  }
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

function parseElicitationSubmitContent(
  renderer: ElicitationRenderer,
  data: Lark.InteractiveCardActionEvent,
): Record<string, unknown> | { __error: string } {
  const formValue = getActionFormValue(data)
  switch (renderer.type) {
    case 'url_open':
      return {}
    case 'form_text': {
      const rawValue = getString(formValue[renderer.field]) ?? ''
      if (renderer.required && !rawValue.trim()) return { __error: 'This field is required.' }
      if (renderer.valueType === 'string') {
        if (renderer.minLength !== undefined && rawValue.length < renderer.minLength) return { __error: `Must be at least ${renderer.minLength} characters.` }
        if (renderer.maxLength !== undefined && rawValue.length > renderer.maxLength) return { __error: `Must be at most ${renderer.maxLength} characters.` }
        return buildElicitationContent(renderer, rawValue)
      }
      const numericValue = Number(rawValue)
      if (!Number.isFinite(numericValue)) return { __error: renderer.valueType === 'integer' ? 'Must be a valid integer.' : 'Must be a valid number.' }
      if (renderer.valueType === 'integer' && !Number.isInteger(numericValue)) return { __error: 'Must be a valid integer.' }
      if (renderer.minimum !== undefined && numericValue < renderer.minimum) return { __error: `Must be >= ${renderer.minimum}.` }
      if (renderer.maximum !== undefined && numericValue > renderer.maximum) return { __error: `Must be <= ${renderer.maximum}.` }
      return buildElicitationContent(renderer, numericValue)
    }
    case 'form_boolean': {
      const checked = getActionChecked(data)
      return buildElicitationContent(renderer, checked ?? false)
    }
    case 'form_single_select': {
      const selected = getActionOption(data) ?? getString(formValue[renderer.field]) ?? ''
      if (renderer.required && !selected) return { __error: 'Please select an option.' }
      if (selected && !renderer.options.some((option) => option.value === selected)) return { __error: 'Invalid selection.' }
      return buildElicitationContent(renderer, selected)
    }
    case 'form_multi_select': {
      const selected = getStringArray(formValue[renderer.field])
      if (renderer.required && selected.length === 0) return { __error: 'Please select at least one option.' }
      if (renderer.minSelections !== undefined && selected.length < renderer.minSelections) return { __error: `Please select at least ${renderer.minSelections} option(s).` }
      if (renderer.maxSelections !== undefined && selected.length > renderer.maxSelections) return { __error: `Please select at most ${renderer.maxSelections} option(s).` }
      if (selected.some((value) => !renderer.options.some((option) => option.value === value))) return { __error: 'Invalid selection.' }
      return buildElicitationContent(renderer, selected)
    }
    case 'generic_json_fallback': {
      const rawJson = getString(formValue.json_payload) ?? ''
      if (!rawJson.trim()) return { __error: 'JSON payload is required.' }
      try {
        const parsed = JSON.parse(rawJson)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { __error: 'Invalid JSON payload.' }
        }
        return parsed as Record<string, unknown>
      } catch {
        return { __error: 'Invalid JSON payload.' }
      }
    }
  }
}

async function processLarkElicitationAction(coordinator: RunCoordinator, data: Lark.InteractiveCardActionEvent): Promise<unknown> {
  const actionValue = getActionValue(data)
  const runId = getString(actionValue.runId) || ''
  const interactionId = getString(actionValue.interactionId) || ''
  const actionType = getActionType(data) as LarkElicitationCardActionType
  const actionKey = [data?.open_message_id, runId, interactionId, actionType || 'invalid'].join(':')

  if (!runId || !interactionId || !actionType) {
    return {
      toast: {
        type: 'error',
        content: 'Invalid elicitation action.',
      },
    }
  }

  if (isDuplicateAction(actionKey)) {
    return {
      toast: {
        type: 'info',
        content: 'This elicitation action was already handled.',
      },
    }
  }

  const run = coordinator.getRun(runId)
  const interaction = resolveElicitationAvailability(coordinator, runId, interactionId)
  if (!interaction) {
    return {
      toast: {
        type: 'error',
        content: 'No matching active run for that elicitation action.',
      },
      ...wrapLarkCardResponse(buildElicitationResolvedCard('cancel', false)),
    }
  }

  const renderer = inferElicitationRenderer(interaction)
  if (actionType === 'elicitation_decline' || actionType === 'elicitation_cancel') {
    const action = actionType === 'elicitation_decline' ? 'decline' : 'cancel'
    const ok = coordinator.respondToInteractive(runId, interactionId, {
      kind: 'elicitation',
      action,
    })
    return {
      toast: {
        type: ok ? 'success' : 'error',
        content: ok ? `Elicitation ${action}.` : 'No matching active run for that elicitation action.',
      },
      ...wrapLarkCardResponse(buildElicitationResolvedCard(action, ok)),
    }
  }

  const content = parseElicitationSubmitContent(renderer, data)
  if ('__error' in content) {
    return {
      toast: {
        type: 'error',
        content: content.__error,
      },
    }
  }

  const ok = coordinator.respondToInteractive(runId, interactionId, {
    kind: 'elicitation',
    action: 'accept',
    ...(Object.keys(content).length > 0 ? { content } : {}),
  })
  return {
    toast: {
      type: ok ? 'success' : 'error',
      content: ok ? 'Elicitation submitted.' : 'No matching active run for that elicitation action.',
    },
    ...wrapLarkCardResponse(buildElicitationResolvedCard('accept', ok)),
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

  const interaction = resolvePermissionAvailability(coordinator, runId, interactionId)
  const ok = interaction
    ? coordinator.respondToInteractive(runId, interactionId, {
        kind: 'permission',
        decision,
      })
    : false
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

function toLarkReplyContext(context: LarkReplyContext): LarkReplyContext | undefined {
  const replyContext: LarkReplyContext = {
    ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
    ...(context.chatType ? { chatType: context.chatType } : {}),
    ...(context.senderOpenId ? { senderOpenId: context.senderOpenId } : {}),
  }
  return Object.keys(replyContext).length > 0 ? replyContext : undefined
}

function buildLarkReplyPrefix(context: LarkReplyContext): { textPrefix?: string; cardPrefix?: string } {
  if (!context.replyToMessageId || context.chatType !== 'group' || !context.senderOpenId) {
    return {}
  }
  return {
    textPrefix: `<at user_id="${context.senderOpenId}"></at>`,
    cardPrefix: `<at id=${context.senderOpenId}></at>`,
  }
}

function applyLarkReplyMentionToText(text: string, context: LarkReplyContext): string {
  const prefix = buildLarkReplyPrefix(context).textPrefix
  return prefix ? `${prefix}\n${text}` : text
}

function applyLarkReplyMentionToCard(card: unknown, context: LarkReplyContext): unknown {
  const prefix = buildLarkReplyPrefix(context).cardPrefix
  if (!prefix) return card
  const asRecordCard = card && typeof card === 'object' ? card as Record<string, unknown> : null
  const body = asRecordCard?.body && typeof asRecordCard.body === 'object' ? asRecordCard.body as Record<string, unknown> : null
  const elements = Array.isArray(body?.elements) ? [...body.elements as unknown[]] : null
  if (!asRecordCard || !body || !elements) return card

  const first = elements[0]
  if (first && typeof first === 'object' && (first as Record<string, unknown>).element_id === 'reply_mention') {
    return card
  }

  elements.unshift({ tag: 'markdown', content: prefix, element_id: 'reply_mention' })
  return {
    ...asRecordCard,
    body: {
      ...body,
      elements,
    },
  }
}

async function addLarkTypingReaction(messageId: string): Promise<{ reactionId: string | null; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    return { reactionId: null, error: 'Lark client is not configured' }
  }

  try {
    const response = await client.im.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: 'Typing',
        },
      },
    })
    const reactionId = typeof response?.data?.reaction_id === 'string' ? response.data.reaction_id : null
    return { reactionId }
  } catch (error) {
    logger.error('lark:typing:add:error', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { reactionId: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function removeLarkTypingReaction(state: { sourceMessageId: string; reactionId?: string | null }): Promise<void> {
  if (!state.reactionId) return
  const client = getLarkClient()
  if (!client) {
    return
  }

  try {
    await client.im.messageReaction.delete({
      path: {
        message_id: state.sourceMessageId,
        reaction_id: state.reactionId,
      },
    })
  } catch (error) {
    logger.error('lark:typing:remove:error', {
      messageId: state.sourceMessageId,
      reactionId: state.reactionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function ensureTypingReactionStarted(record: RunRecord): Promise<void> {
  if (!record.typingReaction || record.typingReaction.started || !record.typingReaction.sourceMessageId) return
  const result = await addLarkTypingReaction(record.typingReaction.sourceMessageId)
  record.typingReaction = {
    ...record.typingReaction,
    reactionId: result.reactionId,
    started: true,
  }
}

async function clearTypingReaction(record: RunRecord): Promise<void> {
  if (!record.typingReaction || record.typingReaction.cleared) return
  await removeLarkTypingReaction(record.typingReaction)
  record.typingReaction = {
    ...record.typingReaction,
    cleared: true,
  }
}

export async function sendLarkTextMessage(
  conversationKey: string,
  text: string,
  options?: LarkReplyContext,
): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const resolvedText = applyLarkReplyMentionToText(text, options ?? {})
    if (options?.replyToMessageId) {
      const response = await client.im.message.reply({
        path: {
          message_id: options.replyToMessageId,
        },
        data: {
          content: JSON.stringify({ text: resolvedText }),
          msg_type: 'text',
        },
      })
      return { delivered: true, response }
    }

    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        content: JSON.stringify({ text: resolvedText }),
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
  options?: LarkReplyContext,
): Promise<{ delivered: boolean; response?: unknown; error?: string; content: string; responseContent?: string }> {
  const client = getLarkClient()
  const resolvedCard = applyLarkReplyMentionToCard(card, options ?? {})
  const content = JSON.stringify(resolvedCard)
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured', content }
  }

  try {
    if (options?.replyToMessageId) {
      const response = await client.im.message.reply({
        path: {
          message_id: options.replyToMessageId,
        },
        data: {
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
    }

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
  options?: LarkReplyContext,
): Promise<{ delivered: boolean; cardId?: string; messageId?: string; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const resolvedCard = applyLarkReplyMentionToCard(card, options ?? {})
    const cardResponse = await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(resolvedCard),
      },
    })
    const cardId = typeof cardResponse?.data?.card_id === 'string'
      ? cardResponse.data.card_id
      : undefined
    if (!cardId) {
      return { delivered: false, response: cardResponse, error: 'CardKit card_id missing' }
    }

    const payload = JSON.stringify({
      type: 'card',
      data: { card_id: cardId },
    })

    const response = options?.replyToMessageId
      ? await client.im.message.reply({
          path: {
            message_id: options.replyToMessageId,
          },
          data: {
            msg_type: 'interactive',
            content: payload,
          },
        })
      : await client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: conversationKey,
            msg_type: 'interactive',
            content: payload,
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

async function updateLarkCardMessage(
  messageId: string,
  card: unknown,
  options?: LarkReplyContext,
): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const response = await client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(applyLarkReplyMentionToCard(card, options ?? {})),
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:update-card:error', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function setLarkCardKitStreamingMode(
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<{ delivered: boolean; error?: string; response?: unknown }> {
  const client = getLarkClient()
  if (!client) {
    return { delivered: false, error: 'Lark CardKit is not configured' }
  }

  try {
    const response = await client.cardkit.v1.card.settings({
      data: {
        settings: JSON.stringify({ streaming_mode: streamingMode }),
        sequence,
      },
      path: {
        card_id: cardId,
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:cardkit:settings:error', {
      cardId,
      sequence,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function updateLarkCardKitCard(
  cardId: string,
  card: unknown,
  sequence: number,
  options?: LarkReplyContext,
): Promise<{ delivered: boolean; error?: string; response?: unknown }> {
  const client = getLarkClient()
  if (!client) {
    return { delivered: false, error: 'Lark CardKit is not configured' }
  }

  try {
    const response = await client.cardkit.v1.card.update({
      data: {
        card: {
          type: 'card_json',
          data: JSON.stringify(applyLarkReplyMentionToCard(card, options ?? {})),
        },
        sequence,
      },
      path: {
        card_id: cardId,
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:cardkit:update:error', {
      cardId,
      sequence,
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
    const elements = card && typeof card === 'object' && 'body' in (card as Record<string, unknown>)
      ? (((card as Record<string, unknown>).body as Record<string, unknown> | undefined)?.elements as unknown[] | undefined)
      : undefined
    const markdownElement = Array.isArray(elements)
      ? elements.find((element) => {
          if (!element || typeof element !== 'object') return false
          return (element as { element_id?: unknown }).element_id === STREAMING_CARD_ELEMENT_ID
        })
      : null
    const content = markdownElement && typeof markdownElement === 'object' && 'content' in (markdownElement as Record<string, unknown>)
      ? ((markdownElement as Record<string, unknown>).content as string | undefined)
      : state.accumulatedText

    const response = await client.cardkit.v1.cardElement.content({
      data: {
        content: content ?? state.accumulatedText,
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
  if (!state.cardId) {
    return { delivered: false, error: 'Lark CardKit is not configured' }
  }

  const closeResult = await setLarkCardKitStreamingMode(state.cardId, false, Math.max(1, state.sequence))
  if (!closeResult.delivered) {
    return closeResult
  }

  const updateResult = await updateLarkCardKitCard(
    state.cardId,
    card,
    Math.max(2, state.sequence + 1),
  )
  return updateResult
}

export function toLarkInboundMessage(event: LarkInboundEvent): ChannelInboundMessage {
  return {
    channel: 'lark',
    conversationKey: event.conversationKey,
    ...(event.userKey ? { userKey: event.userKey } : {}),
    ...(event.senderOpenId ? { senderOpenId: event.senderOpenId } : {}),
    ...(event.chatType ? { chatType: event.chatType } : {}),
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

function summarizeElicitationInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'elicitation' }>): string {
  const renderer = inferElicitationRenderer(interaction)
  const schemaHint = interaction.requestedSchema
    ? `\nSchema hint: ${JSON.stringify(interaction.requestedSchema)}`
    : ''

  switch (renderer.type) {
    case 'url_open':
      return [
        renderer.title,
        renderer.url,
        `Continue: use the card button or /elicitation ${runId} ${interaction.id} accept {}`,
        `Decline: /elicitation ${runId} ${interaction.id} decline`,
        `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
      ].join('\n')
    case 'form_text':
      return [
        renderer.title,
        `Submit with JSON: /elicitation ${runId} ${interaction.id} accept {"${renderer.field}":"value"}`,
        `Decline: /elicitation ${runId} ${interaction.id} decline`,
        `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
      ].join('\n') + schemaHint
    case 'form_boolean':
      return [
        renderer.title,
        `Submit with JSON: /elicitation ${runId} ${interaction.id} accept {"${renderer.field}":true}`,
        `Decline: /elicitation ${runId} ${interaction.id} decline`,
        `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
      ].join('\n')
    case 'form_single_select':
    case 'form_multi_select':
      return [
        renderer.title,
        `Options: ${renderer.options.map((option) => option.value).join(', ')}`,
        `Use the card to submit or fallback to /elicitation ${runId} ${interaction.id} accept <json>`,
        `Decline: /elicitation ${runId} ${interaction.id} decline`,
        `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
      ].join('\n')
    case 'generic_json_fallback':
      return [
        interaction.message || 'Additional input required',
        `Use the card JSON field or /elicitation ${runId} ${interaction.id} accept {"field":"value"}`,
        `Decline: /elicitation ${runId} ${interaction.id} decline`,
        `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
      ].join('\n') + schemaHint
  }
}

export function summarizeLarkInteraction(runId: string, interaction: PendingInteraction): string {
  if (interaction.kind === 'permission') {
    return summarizePermissionInteraction(runId, interaction)
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

export function buildLarkDeliveries(event: SessionEvent, record: RunRecord): LarkOutboundDelivery[] {
  if (record.channel !== 'lark') return []

  switch (event.type) {
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
          ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
          ...(record.chatType ? { chatType: record.chatType } : {}),
          ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
          mode: 'create',
          preferRawCardFallback: true,
        }]
      }
      return [{
        conversationKey: record.conversationKey,
        text: summarizeLarkInteraction(record.runId, event.transaction.interaction),
        card: buildElicitationCard(record.runId, event.transaction.interaction),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
        ...(record.chatType ? { chatType: record.chatType } : {}),
        ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
        mode: 'create',
        preferRawCardFallback: true,
      }]
    case 'session.interactive.completed':
    case 'session.interactive.cancelled':
    case 'session.control.completed':
    case 'session.control.cancelled': {
      if (!event.transaction.interaction) return []
      if (event.transaction.interaction.kind === 'permission') {
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
          ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
          ...(record.chatType ? { chatType: record.chatType } : {}),
          ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
          mode: 'create',
          preferRawCardFallback: true,
        }]
      }
      const ok = event.transaction.interaction.status === 'resolved'
      const action = event.transaction.interaction.status === 'cancelled'
        ? 'cancel'
        : ((asRecord(event.payload)?.action === 'decline' ? 'decline' : 'accept') as 'accept' | 'decline' | 'cancel')
      return [{
        conversationKey: record.conversationKey,
        text: ok ? `Elicitation ${action}` : 'Elicitation unavailable',
        card: buildElicitationResolvedCard(action, ok),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
        ...(record.chatType ? { chatType: record.chatType } : {}),
        ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
        mode: 'create',
        preferRawCardFallback: true,
      }]
    }
    case 'session.run.completed': {
      const controller = getStreamingController(record.runId)
      if (controller?.hasVisibleContent) return []
      return [{
        conversationKey: record.conversationKey,
        text: 'Run completed, but no renderable assistant message was produced for Lark delivery.',
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'fallback',
      }]
    }
    case 'session.run.cancelled':
      return []
    case 'session.run.failed': {
      const controller = getStreamingController(record.runId)
      if (controller?.hasVisibleContent) return []
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

async function resolvePersistedFooter(record: RunRecord): Promise<Pick<DisplayAssistantFooter, 'stopReason' | 'model' | 'usage'> | null> {
  if (!record.sessionId) return null
  const messages = await getMessages(record.sessionId, 200)
  const footer = getAssistantFooter(messages)
  if (!footer) return null
  if (!footer.stopReason && !footer.model && !footer.usage) return null
  return {
    stopReason: footer.stopReason ?? null,
    model: footer.model ?? null,
    usage: footer.usage ?? null,
  }
}

const LARK_PANEL_PADDING = '6px 8px 6px 8px'
const LARK_PANEL_BORDER = { color: 'grey', corner_radius: '5px' } as const
const TOOL_USE_STEP_CONTENT_INDENT = '0px 0px 0px 22px'

function createLarkDivMarkdown(content: string, options: { textSize?: 'notation' | 'normal_v2'; margin?: string } = {}): Record<string, unknown> {
  return {
    tag: 'div',
    ...(options.margin ? { margin: options.margin } : {}),
    text: {
      tag: 'lark_md',
      content: optimizeLarkMarkdownStyle(content),
      ...(options.textSize ? { text_size: options.textSize } : {}),
    },
  }
}

function createLarkDivPlainText(content: string, options: { textSize?: 'notation' | 'normal_v2'; margin?: string; textColor?: 'grey' } = {}): Record<string, unknown> {
  return {
    tag: 'div',
    ...(options.margin ? { margin: options.margin } : {}),
    text: {
      tag: 'plain_text',
      content,
      ...(options.textColor ? { text_color: options.textColor } : {}),
      ...(options.textSize ? { text_size: options.textSize } : {}),
    },
  }
}

function createLarkSectionPanel(params: {
  title: string
  titleEmoji?: string
  body?: string
  bodyTag?: 'markdown' | 'plain'
  bodyMargin?: string
  verticalSpacing?: '4px' | '8px'
  elements?: unknown[]
}): Record<string, unknown> {
  const title = params.titleEmoji ? `${params.titleEmoji} ${params.title}` : params.title
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: title,
        text_color: 'grey',
        text_size: 'notation',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: LARK_PANEL_BORDER,
    vertical_spacing: params.verticalSpacing ?? '4px',
    padding: LARK_PANEL_PADDING,
    elements: params.elements ?? (params.body
      ? [params.bodyTag === 'plain'
        ? createLarkDivPlainText(params.body, { textSize: 'notation', textColor: 'grey', ...(params.bodyMargin ? { margin: params.bodyMargin } : {}) })
        : createLarkDivMarkdown(params.body, { textSize: 'notation', ...(params.bodyMargin ? { margin: params.bodyMargin } : {}) })]
      : []),
  }
}

function longestBacktickRun(value: string): number {
  const matches = value.match(/`+/g) ?? []
  return matches.reduce((max, run) => Math.max(max, run.length), 0)
}

function formatLarkCodeBlock(content: string, language: 'json' | 'text' = 'text'): string {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(normalized) + 1))
  return `${fence}${language}\n${normalized}\n${fence}`
}

function buildLarkToolTitle(name: string): string {
  return name || 'unknown_tool'
}

function buildLarkToolInputDetail(input?: unknown): string {
  const inputText = stringifyStructuredValue(input).trim().replace(/\s+/g, ' ')
  if (!inputText) return ''
  return inputText.length > 240 ? `${inputText.slice(0, 240)}…` : inputText
}

function createLarkThinkingPanel(body: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Thinking',
    titleEmoji: '💭',
    body,
    verticalSpacing: '4px',
  })
}

function createLarkToolPanel(name: string, input?: unknown, resultText?: string): Record<string, unknown> {
  const elements: unknown[] = [
    createLarkDivMarkdown(`**${buildLarkToolTitle(name)}**`, { textSize: 'notation' }),
  ]

  const detail = buildLarkToolInputDetail(input)
  if (detail) {
    elements.push(createLarkDivPlainText(detail, {
      textSize: 'notation',
      textColor: 'grey',
      margin: TOOL_USE_STEP_CONTENT_INDENT,
    }))
  }

  if (resultText) {
    elements.push(createLarkDivMarkdown(`**Result**\n${formatLarkCodeBlock(resultText)}`, {
      textSize: 'notation',
      margin: TOOL_USE_STEP_CONTENT_INDENT,
    }))
  }

  return createLarkSectionPanel({
    title: 'Tool',
    titleEmoji: '🛠️',
    verticalSpacing: '4px',
    elements,
  })
}

function createLarkToolResultPanel(resultText: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Tool Result',
    titleEmoji: '🧾',
    body: `**Result**\n${formatLarkCodeBlock(resultText)}`,
    verticalSpacing: '4px',
  })
}

function createLarkSectionMarkdown(title: string, body: string): Record<string, unknown> {
  return createLarkSectionPanel({ title, body, verticalSpacing: '4px' })
}

function buildLarkToolUseLabel(name: string, input?: unknown): string {
  const safeName = name || 'unknown_tool'
  const inputText = stringifyStructuredValue(input).trim().replace(/\s+/g, ' ')
  if (!inputText) return safeName
  const compact = inputText.length > 160 ? `${inputText.slice(0, 160)}…` : inputText
  return `${safeName}(${compact})`
}

function buildLarkToolResultText(fragment: DisplayFragment & { type: 'tool_result' }): string {
  if (fragment.display?.previewText) return fragment.display.previewText
  return stringifyStructuredValue(fragment.output).trim()
}

function buildLarkAssistantElements(item: AssistantDisplayItem): unknown[] {
  const elements: unknown[] = []
  const shouldIndentFooter = item.fragments[0]?.type === 'tool_use'

  for (const fragment of item.fragments) {
    if (fragment.type === 'text') {
      const text = optimizeLarkMarkdownStyle(fragment.text.trim())
      if (text) {
        elements.push({
          tag: 'markdown',
          content: text,
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
        })
      }
      continue
    }

    if (fragment.type === 'thinking') {
      const text = fragment.text?.trim()
      if (text) {
        elements.push(createLarkThinkingPanel(text))
      }
      continue
    }

    if (fragment.type === 'tool_use') {
      elements.push(createLarkToolPanel(fragment.name, fragment.input))
      continue
    }

    if (fragment.type === 'tool_result') {
      const resultText = buildLarkToolResultText(fragment)
      if (resultText) {
        elements.push(createLarkToolResultPanel(resultText))
      }
      continue
    }

    if (fragment.type === 'summary') {
      const text = fragment.text.trim()
      if (text) {
        elements.push(createLarkSectionMarkdown('Summary', text))
      }
    }
  }

  const footerText = buildAssistantFooterText(item.footer)
  if (footerText.trim()) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: shouldIndentFooter ? `&nbsp;&nbsp;&nbsp;&nbsp;${footerText}` : footerText,
      text_size: 'notation',
    })
  }

  return elements
}

function buildLarkGroupedToolUseElements(item: GroupedToolUseDisplayItem): unknown[] {
  const elements: unknown[] = []
  for (const tool of item.toolUses) {
    const resultText = tool.resultDisplay?.previewText ?? stringifyStructuredValue(tool.result).trim()
    elements.push(createLarkToolPanel(tool.name, tool.input, resultText || undefined))
  }

  const footerText = buildAssistantFooterText(item.footer)
  if (footerText.trim()) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: footerText,
      text_size: 'notation',
    })
  }
  return elements
}

function buildLarkCollapsedToolBatchElements(item: CollapsedToolBatchDisplayItem): unknown[] {
  const totalOps = item.summary.readCount + item.summary.searchCount + item.summary.listCount + item.summary.bashCount
  const lines = [
    `${totalOps} low-signal tool calls${item.summary.latestHint ? ` · ${item.summary.latestHint}` : ''}`,
    `Read ${item.summary.readCount} · Search ${item.summary.searchCount} · List ${item.summary.listCount} · Bash ${item.summary.bashCount}`,
  ]

  const elements: unknown[] = [createLarkSectionMarkdown('Tool Batch', lines.join('\n'))]
  const footerText = buildAssistantFooterText(item.footer)
  if (footerText.trim()) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: footerText,
      text_size: 'notation',
    })
  }
  return elements
}

function buildLarkFinalCardFromHistory(messages: SessionMessage[], footer: DisplayAssistantFooter): Record<string, unknown> | null {
  const items = buildHistoryDisplayItems(messages, { mode: 'default', includeHiddenAtoms: false })
    .filter((item): item is AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem =>
      item.kind === 'assistant' || item.kind === 'grouped_tool_use' || item.kind === 'collapsed_tool_batch')
  const target = items[items.length - 1]
  if (!target) return null

  const elements = target.kind === 'assistant'
    ? buildLarkAssistantElements({ ...target, footer })
    : target.kind === 'grouped_tool_use'
      ? buildLarkGroupedToolUseElements({ ...target, footer })
      : buildLarkCollapsedToolBatchElements({ ...target, footer })

  if (elements.length === 0) return null

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      summary: {
        content: 'Claude response',
        i18n_content: {
          zh_cn: 'Claude 回复',
          en_us: 'Claude response',
        },
      },
    },
    body: {
      elements,
    },
  }
}

function getOrCreateStreamingController(record: RunRecord): LarkStreamingController {
  const existing = getStreamingController(record.runId)
  if (existing) return existing

  streamingControllerStartedAt.set(record.runId, Date.now())
  const controller = new LarkStreamingController({
    runId: record.runId,
    conversationKey: record.conversationKey,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    buildCard: ({ answerText, thinkingText, toolCalls, toolResults, footer, isFinal }) => buildAssistantStreamingCard({ answerText, thinkingText, toolCalls, toolResults, footer, isFinal }),
    buildFinalCard: async (footer) => {
      if (!record.sessionId) return null
      const messages = await getMessages(record.sessionId, 200)
      return buildLarkFinalCardFromHistory(messages, footer)
    },
    createCardKitMessage: async (card) => await sendLarkCardKitMessage(
      record.conversationKey,
      card,
      toLarkReplyContext({
        ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
        ...(record.chatType ? { chatType: record.chatType } : {}),
        ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
      }),
    ),
    sendInteractiveCard: async (card) => {
      const result = await sendLarkCardMessage(
        record.conversationKey,
        card,
        toLarkReplyContext({
          ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
          ...(record.chatType ? { chatType: record.chatType } : {}),
          ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
        }),
      )
      return {
        delivered: result.delivered,
        messageId: result.delivered && result.response && typeof result.response === 'object' && 'data' in (result.response as Record<string, unknown>)
          ? (((result.response as Record<string, unknown>).data as Record<string, unknown> | undefined)?.message_id as string | undefined)
          : undefined,
        error: result.error,
      }
    },
    streamCardKitContent: async (cardId, content, sequence) => {
      const card = buildAssistantStreamingCard({ answerText: content, isFinal: false })
      return await updateLarkCardKitStreamingContent({
        runId: record.runId,
        conversationKey: record.conversationKey,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        mode: 'cardkit',
        phase: 'streaming',
        accumulatedText: content,
        sequence,
        cardId,
      }, card)
    },
    updateInteractiveCard: async (messageId, card) => {
      return await updateLarkCardMessage(
        messageId,
        card,
        toLarkReplyContext({
          ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
          ...(record.chatType ? { chatType: record.chatType } : {}),
          ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
        }),
      )
    },
    finalizeCardKit: async (cardId, closeSequence, updateSequence, card) => {
      const closeResult = await setLarkCardKitStreamingMode(cardId, false, closeSequence)
      if (!closeResult.delivered) return closeResult
      return await updateLarkCardKitCard(
        cardId,
        card,
        updateSequence,
        toLarkReplyContext({
          ...(record.inboundPlatformMessageId ? { replyToMessageId: record.inboundPlatformMessageId } : {}),
          ...(record.chatType ? { chatType: record.chatType } : {}),
          ...(record.senderOpenId ? { senderOpenId: record.senderOpenId } : {}),
        }),
      )
    },
    appendLog: async () => {
    },
    getFooterMetrics: async () => {
      const startedAt = streamingControllerStartedAt.get(record.runId) ?? Date.now()
      const completedAt = Date.now()
      const deltaMs = Math.max(0, completedAt - startedAt)
      const persistedFooter = await resolvePersistedFooter(record)
      return {
        stopReason: persistedFooter?.stopReason ?? (latestAssistantStopReasonByRun.get(record.runId) ?? null),
        model: persistedFooter?.model ?? (latestAssistantModelByRun.get(record.runId) ?? null),
        usage: persistedFooter?.usage ?? (latestAssistantUsageByRun.get(record.runId) ?? null),
        executionDurationMs: deltaMs,
        completedAt,
        deltaMs,
      }
    },
  })

  larkStreamingControllers.set(record.runId, controller)
  return controller
}

async function deliverLarkSessionEventNow(event: SessionEvent, record: RunRecord): Promise<void> {
  if (record.channel === 'lark') {
    if (event.type === 'session.sdk.stream_event') {
      await ensureTypingReactionStarted(record)
      const controller = getOrCreateStreamingController(record)
      await controller.onStreamEvent(event.event)
      return
    }

    if (event.type === 'session.sdk.message') {
      await ensureTypingReactionStarted(record)
      const parsed = event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
      if (parsed?.role === 'assistant') {
        latestAssistantModelByRun.set(record.runId, getTranscriptAssistantModel(parsed))
        latestAssistantUsageByRun.set(record.runId, getTranscriptAssistantUsage(parsed))
        const stopReason = getTranscriptStopReason(parsed)
        if (stopReason) {
          latestAssistantStopReasonByRun.set(record.runId, stopReason)
        }
        const text = extractLarkAssistantText(event)
        if (text) {
          const controller = getOrCreateStreamingController(record)
          await controller.onMaterializedText(text)
        }
      }
      return
    }

    if (event.type === 'session.run.completed') {
      const controller = getStreamingController(record.runId)
      if (controller) {
        controller.markFullyComplete()
        await controller.onIdle()
        await clearTypingReaction(record)
        clearStreamingController(record.runId)
        return
      }
      await clearTypingReaction(record)
    }

    if (event.type === 'session.run.failed') {
      const controller = getStreamingController(record.runId)
      if (controller) {
        await controller.onError(event.error)
        await clearTypingReaction(record)
        clearStreamingController(record.runId)
        return
      }
      await clearTypingReaction(record)
    }

    if (event.type === 'session.run.cancelled') {
      const controller = getStreamingController(record.runId)
      if (controller) {
        await controller.abort()
        await clearTypingReaction(record)
        clearStreamingController(record.runId)
        return
      }
      await clearTypingReaction(record)
    }
  }

  const deliveries = buildLarkDeliveries(event, record)
  if (deliveries.length === 0) return

  logger.info('lark:deliveries:built', {
    count: deliveries.length,
    runId: record.runId,
    sessionId: record.sessionId,
  })

  for (const delivery of deliveries) {

    const replyContext = toLarkReplyContext(delivery)

    if (delivery.card) {
      const result = await sendLarkCardMessage(delivery.conversationKey, delivery.card, replyContext)
      continue
    }
    if (delivery.text) {
      const result = await sendLarkTextMessage(delivery.conversationKey, delivery.text, replyContext)
    }
  }
}

export async function deliverLarkSessionEvent(event: SessionEvent, record: RunRecord): Promise<void> {
  await larkDeliveryQueue.enqueue(record.runId, async () => {
    await deliverLarkSessionEventNow(event, record)
  })
}
