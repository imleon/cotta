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
import {
  buildElicitationContent,
  inferElicitationRenderer,
  type ElicitationRenderer,
} from '../shared/elicitation-renderer.js'

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
    const ok = coordinator.respondToInteractive(command.runId, command.interactionId, {
      kind: 'permission',
      decision: command.decision,
    })
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
  const ok = coordinator.respondToInteractive(command.runId, command.interactionId, {
    kind: 'elicitation',
    action: command.action,
    ...(command.content ? { content: command.content } : {}),
  })
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
  const actionType = getActionType(data) || undefined
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
  const interaction = run?.currentInteraction?.kind === 'elicitation' && run.currentInteraction.id === interactionId
    ? run.currentInteraction
    : null
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

  const ok = coordinator.respondToInteractive(runId, interactionId, {
    kind: 'permission',
    decision,
  })
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
        card: buildElicitationCard(record.runId, event.transaction.interaction),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
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
          mode: 'create',
          state: buildPermissionCardKitState(record),
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
        mode: 'create',
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
