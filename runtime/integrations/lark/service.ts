import { randomUUID } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { ConfigRegistry } from '../../config/registry.js'
import type { ConnectorConfig, ChannelConfig } from '../../config/schema.js'
import type { Orchestrator } from '../../orchestration/orchestrator.js'
import type { SessionRegistry } from '../../orchestration/session-registry.js'
import type { WorkerOutputEvent } from '../../execution/types.js'
import { getMessagesPage, getSession } from '../../storage/fs/sessions.js'
import type { SqliteConfigRepository } from '../../storage/sqlite/config-repository.js'
import type {
  DisplayAssistantFooter,
  PermissionInteraction,
  SessionStreamEvent,
} from '../../protocol/message-types.js'
import {
  extractStructuredContentFromBlocks,
  getTranscriptAssistantModel,
  getTranscriptMessageId,
  getTranscriptAssistantUsage,
  getTranscriptStopReason,
  normalizeSdkEnvelopeMessage,
  stringifyStructuredValue,
  type TranscriptMessage,
} from '../../protocol/transcript-normalizer.js'
import { getAssistantFooter } from '../../presentation/transcript-display.js'
import {
  buildAssistantStreamingCard,
  buildLarkFinalCardFromHistory,
} from './card-builder.js'
import { LarkStreamingController, type LarkStreamingBuildCardParams } from './streaming-controller.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type LarkConnectorRuntimeConfig = {
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
  botName?: string
}

type LarkReceiveEvent = {
  sender: {
    sender_type: string
    sender_id?: {
      open_id?: string
    }
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time?: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
  }
}

type LarkCardActionEvent = {
  open_message_id?: string
  action?: {
    value?: Record<string, unknown>
  }
}

type LarkReplyContext = {
  replyToMessageId?: string
  chatType?: 'group' | 'p2p'
  senderOpenId?: string
}

type LarkInteractionCommand =
  | { type: 'permission'; sessionId?: string; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'session'; action: 'current' | 'clear' | 'new' | 'use'; sessionId?: string }
  | { type: 'stop' }
  | { type: 'invalid'; scope: 'permission' | 'session'; reason: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isEventExpired(createTime?: string, expiryMs: number = 30 * 60 * 1000): boolean {
  if (!createTime) return false
  const value = Number(createTime)
  if (!Number.isFinite(value)) return false
  return Date.now() - value > expiryMs
}

function formatPermissionSuggestions(suggestions?: Array<{
  label?: string
  action?: string
  description?: string
  scope?: string
}>): string[] {
  if (!suggestions || suggestions.length === 0) return []
  return suggestions.map((suggestion) => {
    const label = suggestion.label || suggestion.action
    const details = [suggestion.description, suggestion.scope].filter(Boolean).join(' · ')
    return details ? `- ${label}: ${details}` : `- ${label}`
  })
}

function formatPermissionMetadata(interaction: PermissionInteraction): string[] {
  return [
    interaction.decisionReason ? `Why Claude asked: ${interaction.decisionReason}` : '',
    interaction.blockedPath ? `Path: ${interaction.blockedPath}` : '',
    interaction.toolUseId ? `Tool use: ${interaction.toolUseId}` : '',
    interaction.agentId ? `Agent: ${interaction.agentId}` : '',
  ].filter(Boolean)
}

function parseLarkInteractionCommand(text: string): LarkInteractionCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const permissionCurrentMatch = trimmed.match(/^\/permission\s+(\S+)\s+(approve|deny)$/)
  if (permissionCurrentMatch) {
    return {
      type: 'permission',
      requestId: permissionCurrentMatch[1],
      decision: permissionCurrentMatch[2] as 'approve' | 'deny',
    }
  }

  const permissionSessionMatch = trimmed.match(/^\/permission\s+(\S+)\s+(\S+)\s+(approve|deny)$/)
  if (permissionSessionMatch) {
    return {
      type: 'permission',
      sessionId: permissionSessionMatch[1],
      requestId: permissionSessionMatch[2],
      decision: permissionSessionMatch[3] as 'approve' | 'deny',
    }
  }

  if (trimmed === '/session current') return { type: 'session', action: 'current' }
  if (trimmed === '/session clear') return { type: 'session', action: 'clear' }
  if (trimmed === '/session new') return { type: 'session', action: 'new' }

  const sessionUseMatch = trimmed.match(/^\/session\s+use\s+(\S+)$/)
  if (sessionUseMatch) {
    return { type: 'session', action: 'use', sessionId: sessionUseMatch[1] }
  }

  if (trimmed === '/stop') return { type: 'stop' }

  if (trimmed.startsWith('/permission')) {
    return {
      type: 'invalid',
      scope: 'permission',
      reason: 'use /permission <requestId> approve|deny or /permission <sessionId> <requestId> approve|deny',
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

function buildStreamingCardDocumentFromParams(params: LarkStreamingBuildCardParams): Record<string, unknown> {
  return buildAssistantStreamingCard(params)
}

function buildLarkReplyPrefix(context?: LarkReplyContext): { textPrefix?: string; cardPrefix?: string } {
  if (!context?.replyToMessageId || context.chatType !== 'group' || !context.senderOpenId) {
    return {}
  }
  return {
    textPrefix: `<at user_id="${context.senderOpenId}"></at>`,
    cardPrefix: `<at id=${context.senderOpenId}></at>`,
  }
}

function applyLarkReplyMentionToText(text: string, context?: LarkReplyContext): string {
  const prefix = buildLarkReplyPrefix(context).textPrefix
  return prefix ? `${prefix}\n${text}` : text
}

function applyLarkReplyMentionToCard(card: Lark.InteractiveCard, context?: LarkReplyContext): Lark.InteractiveCard {
  const prefix = buildLarkReplyPrefix(context).cardPrefix
  if (!prefix || !Array.isArray(card.elements)) return card
  const first = card.elements[0]
  if (first && typeof first === 'object' && (first as unknown as Record<string, unknown>).element_id === 'reply_mention') {
    return card
  }
  return {
    ...card,
    elements: [
      {
        tag: 'markdown',
        content: prefix,
        element_id: 'reply_mention',
      } as any,
      ...card.elements,
    ] as any,
  }
}

function buildFooterFromResultPayload(payload: unknown, completedAt: number): DisplayAssistantFooter | null {
  const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  if (!result) return null
  const usage = result.usage && typeof result.usage === 'object'
    ? result.usage as Record<string, unknown>
    : null
  const modelUsage = result.modelUsage && typeof result.modelUsage === 'object'
    ? result.modelUsage as Record<string, unknown>
    : null
  const model = modelUsage ? Object.keys(modelUsage).find((key) => key.trim().length > 0) ?? undefined : undefined
  return {
    completedAt,
    ...(typeof result.stop_reason === 'string' ? { stopReason: result.stop_reason } : {}),
    ...(usage ? {
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
        cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
      },
    } : {}),
    ...(model ? { model } : {}),
  }
}

function hasMeaningfulFooterUsage(usage: DisplayAssistantFooter['usage'] | null | undefined): boolean {
  if (!usage) return false
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .some((value) => typeof value === 'number' && value > 0)
}

function getProjectDirs(configRegistry: ConfigRegistry): string[] {
  const dirs = configRegistry.listAgents().map((agent) => agent.projectDir.trim()).filter(Boolean)
  return [...new Set(dirs)]
}

function parseConnectorConfig(connector: ConnectorConfig): LarkConnectorRuntimeConfig | null {
  if (connector.connectorType !== 'lark') return null
  const config = asRecord(connector.connectorConfig)
  if (!config) return null
  const appId = typeof config.appId === 'string' ? config.appId.trim() : ''
  const appSecret = typeof config.appSecret === 'string' ? config.appSecret.trim() : ''
  if (!appId || !appSecret) return null
  return {
    appId,
    appSecret,
    encryptKey: typeof config.encryptKey === 'string' ? config.encryptKey.trim() : undefined,
    verificationToken: typeof config.verificationToken === 'string' ? config.verificationToken.trim() : undefined,
    botName: typeof config.botName === 'string' ? config.botName.trim() : undefined,
  }
}

function parseLarkTextContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text.trim() : raw.trim()
  } catch {
    return raw.trim()
  }
}

function truncateText(value: string, maxChars: number = 4000): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 32))}\n\n[内容过长，已截断]`
}

function wrapLarkCardResponse(card: Lark.InteractiveCard): { card: Lark.InteractiveCard } {
  return { card }
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

function buildPermissionResolvedCard(decision: 'approve' | 'deny' | 'cancel', ok: boolean): Lark.InteractiveCard {
  const approved = ok && decision === 'approve'
  const denied = ok && decision === 'deny'
  const cancelled = ok && decision === 'cancel'
  return buildPermissionStatusCard(
    ok
      ? (approved ? 'Permission approved' : denied ? 'Permission denied' : 'Permission cancelled')
      : 'Permission unavailable',
    ok
      ? (approved
          ? 'Claude can continue with this action.'
          : denied
            ? 'Claude will not continue with this action.'
            : 'This permission request was cancelled.')
      : 'No matching active permission request was found.',
    approved ? 'green' : denied ? 'red' : cancelled ? 'grey' : 'grey',
  )
}

function buildPermissionCard(sessionId: string, interaction: {
  id: string
  toolName: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  toolUseId?: string
  agentId?: string
  suggestions?: Array<{ toolName?: string; command?: string; label?: string }>
}): Lark.InteractiveCard {
  const title = interaction.title || interaction.displayName || interaction.toolName || 'Tool permission'
  const description = interaction.description || 'Claude requests permission to continue.'
  const metadataLines = formatPermissionMetadata({
    kind: 'permission',
    id: interaction.id,
    status: 'pending',
    source: { kind: 'host', subtype: 'lark' },
    toolName: interaction.toolName,
    input: {},
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.displayName ? { displayName: interaction.displayName } : {}),
    ...(interaction.description ? { description: interaction.description } : {}),
    ...(interaction.decisionReason ? { decisionReason: interaction.decisionReason } : {}),
    ...(interaction.blockedPath ? { blockedPath: interaction.blockedPath } : {}),
    ...(interaction.toolUseId ? { toolUseId: interaction.toolUseId } : {}),
    ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
  })
  const suggestionLines = Array.isArray(interaction.suggestions)
    ? interaction.suggestions.slice(0, 5).map((item) => {
        const label = asString(item.label) || asString(item.toolName) || 'Suggested action'
        const command = asString(item.command)
        return {
          action: label,
          label,
          description: command ? `\`${command}\`` : '',
        }
      })
    : []
  const formattedSuggestionLines = formatPermissionSuggestions(suggestionLines)

  const elements: Array<Record<string, unknown>> = [
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
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: metadataLines.join('\n'),
      },
    })
  }

  if (formattedSuggestionLines.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Suggested action**\n${formattedSuggestionLines.join('\n')}`,
      },
    })
  }

  elements.push(
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'primary',
          text: {
            tag: 'plain_text',
            content: 'Approve',
          },
          value: {
            actionType: 'permission',
            sessionId,
            requestId: interaction.id,
            decision: 'approve',
          },
        },
        {
          tag: 'button',
          type: 'danger',
          text: {
            tag: 'plain_text',
            content: 'Deny',
          },
          value: {
            actionType: 'permission',
            sessionId,
            requestId: interaction.id,
            decision: 'deny',
          },
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Cancel request',
          },
          value: {
            actionType: 'control_cancel',
            sessionId,
            requestId: interaction.id,
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

export class LarkIntegrationService {
  private readonly subscriberKey = 'lark-integration'
  private readonly clients = new Map<string, Lark.Client>()
  private readonly dispatchers = new Map<string, Lark.EventDispatcher>()
  private readonly wsClients = new Map<string, any>()
  private readonly wsStartPromises = new Map<string, Promise<void>>()
  private readonly wsClientCardPatched = new Set<string>()
  private readonly deliveredRunIds = new Set<string>()
  private readonly deliveredInteractionIds = new Set<string>()
  private readonly handledCardActions = new Set<string>()
  private readonly latestAssistantTextByRunId = new Map<string, string>()
  private readonly latestAssistantMessageByRunId = new Map<string, TranscriptMessage>()
  private readonly materializedMessagesByRunId = new Map<string, TranscriptMessage[]>()
  private readonly latestResultPayloadByRunId = new Map<string, unknown>()
  private readonly inboundMessageSeenAt = new Map<string, number>()
  // NOTE: inbound message dedupe is module-level (see GLOBAL_INBOUND_MESSAGE_SEEN_AT)
  private readonly replyContextByRunId = new Map<string, LarkReplyContext>()
  private readonly runStartedAtByRunId = new Map<string, number>()
  private readonly typingReactionByRunId = new Map<string, { sourceMessageId: string; reactionId?: string | null; started?: boolean; cleared?: boolean }>()
  private readonly streamControllersByRunId = new Map<string, LarkStreamingController>()
  private readonly activeStreamMessageIds = new Map<string, string>()
  private readonly streamSequenceByRunId = new Map<string, number>()
  private started = false

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      configRepository: SqliteConfigRepository
      sessionRegistry: SessionRegistry
      orchestrator: Orchestrator
      logger: Logger
    },
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.deps.orchestrator.subscribe(this.subscriberKey, (event) => {
      void this.handleWorkerEvent(event).catch((error) => {
        this.deps.logger.error('lark:worker-event:error', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
    for (const connector of this.listLarkConnectors()) {
      void this.startLongConnection(connector.connectorId).catch((error) => {
        this.deps.logger.error('lark:ws:start:error', {
          connectorId: connector.connectorId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.deps.orchestrator.unsubscribe(this.subscriberKey)

    // Best-effort shutdown of long connections. The upstream SDK has changed
    // APIs over time, so we use duck-typing to avoid hard dependencies.
    const stops: Array<Promise<unknown>> = []
    for (const wsClient of this.wsClients.values()) {
      try {
        if (wsClient && typeof wsClient.stop === 'function') {
          const result = wsClient.stop()
          stops.push(Promise.resolve(result))
          continue
        }
        if (wsClient && typeof wsClient.close === 'function') {
          const result = wsClient.close()
          stops.push(Promise.resolve(result))
          continue
        }
        if (wsClient && wsClient.ws && typeof wsClient.ws.close === 'function') {
          wsClient.ws.close()
        }
      } catch (error) {
        this.deps.logger.warn('lark:ws:stop:error', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await Promise.allSettled(stops)
  }

  isConfigured(): boolean {
    return this.listEnabledLarkChannels().length > 0
  }

  async handleInbound(body: unknown): Promise<{ status: number; payload: unknown }> {
    const record = asRecord(body)
    if (!record) return { status: 400, payload: { error: 'Invalid request body' } }

    if ('challenge' in record) {
      return { status: 200, payload: { challenge: record.challenge } }
    }

    const connectors = this.listLarkConnectors()
    for (const connector of connectors) {
      const dispatcher = this.getDispatcher(connector.connectorId)
      try {
        await dispatcher.invoke(record, { needCheck: true })
        return { status: 200, payload: { ok: true } }
      } catch (error) {
        // Try the next connector config. Each dispatcher validates token/decrypt settings.
      }
    }

    this.deps.logger.warn('lark:inbound:unmatched', {
      connectorCount: connectors.length,
      keys: Object.keys(record),
    })
    return { status: 400, payload: { error: 'No matching lark connector' } }
  }

  async handleCardAction(body: unknown): Promise<{ status: number; payload: unknown }> {
    const record = asRecord(body)
    if (!record) return { status: 400, payload: { error: 'Invalid request body' } }
    if ('challenge' in record) {
      return { status: 200, payload: { challenge: record.challenge } }
    }

    const data = record as LarkCardActionEvent
    const actionValue = asRecord(data.action?.value)
    const actionType = asString(actionValue?.actionType)
    const sessionId = asString(actionValue?.sessionId)
    const requestId = asString(actionValue?.requestId)
    const decision = actionValue?.decision === 'approve' || actionValue?.decision === 'deny'
      ? actionValue.decision
      : null
    const actionKey = [asString(data.open_message_id), actionType, sessionId, requestId, decision ?? ''].join(':')

    if (!actionType || !sessionId || !requestId) {
      this.deps.logger.warn('lark:card-action:invalid', {
        keys: Object.keys(record),
        actionType,
        sessionId,
        requestId,
      })
      return {
        status: 200,
        payload: {
          toast: {
            type: 'error',
            content: 'Invalid card action.',
          },
        },
      }
    }

    if (this.handledCardActions.has(actionKey)) {
      return {
        status: 200,
        payload: {
          toast: {
            type: 'info',
            content: 'This action was already handled.',
          },
        },
      }
    }
    this.handledCardActions.add(actionKey)

    if (actionType === 'permission') {
      if (!decision) {
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'Invalid permission action.',
            },
          },
        }
      }

      try {
        await this.deps.orchestrator.respondToInteraction({
          sessionId,
          requestId,
          kind: 'permission',
          response: { decision },
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'success',
              content: decision === 'approve' ? 'Permission approved.' : 'Permission denied.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard(decision, true)),
          },
        }
      } catch (error) {
        this.deps.logger.warn('lark:card-action:permission:error', {
          sessionId,
          requestId,
          decision,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'No matching active permission request was found.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard(decision, false)),
          },
        }
      }
    }

    if (actionType === 'control_cancel') {
      try {
        await this.deps.orchestrator.cancelControl({ sessionId, requestId })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'success',
              content: 'Permission request cancelled.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard('cancel', true)),
          },
        }
      } catch (error) {
        this.deps.logger.warn('lark:card-action:cancel:error', {
          sessionId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'No matching active permission request was found.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard('cancel', false)),
          },
        }
      }
    }

    return {
      status: 200,
      payload: {
        toast: {
          type: 'error',
          content: 'Unsupported card action.',
        },
      },
    }
  }

  async sendTextToConversation(conversationKey: string, text: string): Promise<void> {
    const channel = this.findLarkChannelByConversationKey(conversationKey)
    if (!channel) {
      throw new Error(`Lark channel not found for conversationKey: ${conversationKey}`)
    }
    await this.sendTextToChannel(channel, text)
  }

  private listLarkConnectors(): ConnectorConfig[] {
    return this.deps.configRegistry
      .listConnectors()
      .filter((connector) => connector.connectorType === 'lark' && parseConnectorConfig(connector))
  }

  private listEnabledLarkChannels(): ChannelConfig[] {
    return this.deps.configRegistry
      .listChannels()
      .filter((channel) => {
        if (!channel.enabled) return false
        const connector = this.deps.configRegistry.getConnector(channel.connectorId)
        return connector?.connectorType === 'lark'
      })
  }

  private findLarkChannelByConversationKey(conversationKey: string): ChannelConfig | null {
    return this.listEnabledLarkChannels().find((channel) => channel.channelKey === conversationKey) ?? null
  }

  private async handleInteractionCommand(
    channel: ChannelConfig,
    conversationKey: string,
    command: LarkInteractionCommand,
    replyContext?: LarkReplyContext,
  ): Promise<void> {
    if (command.type === 'invalid') {
      await this.sendTextToChannel(channel, `Invalid ${command.scope} command: ${command.reason}`, replyContext)
      return
    }

    if (command.type === 'stop') {
      const session = this.deps.sessionRegistry.findByChannelId(channel.channelId)
      if (!session?.activeRunId) {
        await this.sendTextToChannel(channel, 'No active run to stop.', replyContext)
        return
      }
      await this.deps.orchestrator.interruptSession(session.sessionId)
      await this.sendTextToChannel(channel, 'Stopping current run.', replyContext)
      return
    }

    if (command.type === 'session') {
      const agent = this.deps.configRegistry.getAgent(channel.agentId)
      if (!agent) throw new Error(`Agent not found for channel ${channel.channelId}: ${channel.agentId}`)

      if (command.action === 'current') {
        const session = this.deps.sessionRegistry.findByChannelId(channel.channelId)
        const persisted = session ? await getSession(session.sessionId, [agent.projectDir]) : null
        const lines = [
          `Conversation: ${conversationKey}`,
          session ? `Bound session: ${session.sessionId}` : 'Bound session: none',
          persisted?.title ? `Session title: ${persisted.title}` : '',
          session?.activeRunId ? `Active run: ${session.activeRunId}${session.sessionStatus ? ` (${session.sessionStatus})` : ''}` : 'Active run: none',
        ].filter(Boolean)
        await this.sendTextToChannel(channel, lines.join('\n'), replyContext)
        return
      }

      if (command.action === 'clear' || command.action === 'new') {
        this.deps.sessionRegistry.releaseChannel(channel.channelId)
        this.deps.configRepository.updateChannelCurrentSdkSessionId(channel.channelId, null)
        await this.sendTextToChannel(
          channel,
          command.action === 'new'
            ? 'Cleared current binding. The next message will start a new session.'
            : 'Cleared current session binding.',
          replyContext,
        )
        return
      }

      const sessionId = asString(command.sessionId)
      if (!sessionId) {
        await this.sendTextToChannel(channel, 'Missing session id for /session use.', replyContext)
        return
      }
      const persisted = await getSession(sessionId, [agent.projectDir])
      if (!persisted) {
        await this.sendTextToChannel(channel, `Session not found: ${sessionId}`, replyContext)
        return
      }
      this.deps.sessionRegistry.ensure(sessionId, channel.agentId)
      this.deps.sessionRegistry.claimChannel(sessionId, channel.channelId)
      this.deps.configRepository.updateChannelCurrentSdkSessionId(channel.channelId, sessionId)
      await this.sendTextToChannel(
        channel,
        `Bound this chat to session ${sessionId}${persisted.title ? ` (${persisted.title})` : ''}.`,
        replyContext,
      )
      return
    }

    const targetSessionId = command.sessionId || this.deps.sessionRegistry.findByChannelId(channel.channelId)?.sessionId
    if (!targetSessionId) {
      await this.sendTextToChannel(channel, 'No current session is bound to this conversation.', replyContext)
      return
    }

    try {
      await this.deps.orchestrator.respondToInteraction({
        sessionId: targetSessionId,
        requestId: command.requestId,
        kind: 'permission',
        response: { decision: command.decision },
      })
      await this.sendTextToChannel(channel, `Permission response recorded: ${command.decision}`, replyContext)
    } catch {
      await this.sendTextToChannel(channel, 'No matching active permission request was found.', replyContext)
    }
  }

  private getClient(connectorId: string): Lark.Client {
    const existing = this.clients.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Lark.Domain.Feishu,
    })
    this.clients.set(connectorId, client)
    return client
  }

  private getWsClient(connectorId: string): any {
    const existing = this.wsClients.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const wsClient = new (Lark as any).WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    })
    this.patchWsClientForCardCallbacks(connectorId, wsClient)
    this.wsClients.set(connectorId, wsClient)
    return wsClient
  }

  private patchWsClientForCardCallbacks(connectorId: string, wsClient: any): void {
    if (this.wsClientCardPatched.has(connectorId)) return
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
        }
      }

      return await originalHandleEventData.call(this, data)
    }

    this.wsClientCardPatched.add(connectorId)
  }

  private async startLongConnection(connectorId: string): Promise<void> {
    const existing = this.wsStartPromises.get(connectorId)
    if (existing) return await existing

    const wsClient = this.getWsClient(connectorId)
    const startPromise = wsClient.start({
      eventDispatcher: this.getDispatcher(connectorId),
    }).then(() => {
      this.deps.logger.info('lark:ws:started', { connectorId })
    }).catch((error: unknown) => {
      this.wsStartPromises.delete(connectorId)
      throw error
    })

    this.wsStartPromises.set(connectorId, startPromise)
    return await startPromise
  }

  private getDispatcher(connectorId: string): Lark.EventDispatcher {
    const existing = this.dispatchers.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const dispatcher = new Lark.EventDispatcher({
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register({
      'im.message.receive_v1': (data: LarkReceiveEvent) => {
        void this.handleReceiveMessage(connectorId, data).catch((error) => {
          this.deps.logger.error('lark:message:handle:error', {
            connectorId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return { ok: true }
      },
      'card.action.trigger': async (data: unknown) => {
        const result = await this.handleCardAction(data)
        return result.payload
      },
      'im.message.message_read_v1': async () => undefined,
    })

    this.dispatchers.set(connectorId, dispatcher)
    return dispatcher
  }

  private async handleReceiveMessage(connectorId: string, data: LarkReceiveEvent): Promise<void> {
    if (data.sender?.sender_type !== 'user') {
      return
    }

    const chatId = data.message?.chat_id?.trim()
    const messageId = data.message?.message_id?.trim()
    const chatType = data.message?.chat_type === 'p2p' ? 'p2p' : 'group'
    const messageType = data.message?.message_type
    const text = parseLarkTextContent(data.message?.content ?? '')
    if (!chatId || !messageId || !text) return
    if (messageType !== 'text') {
      this.deps.logger.info('lark:message:ignored-non-text', { connectorId, messageType, chatId })
      return
    }

    const dedupeKey = `${chatId}:${messageId}`
    this.cleanupInboundMessageDedupe()
    if (this.inboundMessageSeenAt.has(dedupeKey)) return
    this.inboundMessageSeenAt.set(dedupeKey, Date.now())

    if (isEventExpired(asString(data.message?.create_time))) {
      this.deps.logger.info('lark:message:expired', { connectorId, chatId, messageId })
      return
    }

    const channel = this.listEnabledLarkChannels().find((item) => item.channelKey === chatId && item.connectorId === connectorId)
    if (!channel) {
      this.deps.logger.warn('lark:message:channel-miss', { connectorId, chatId })
      return
    }

    const command = parseLarkInteractionCommand(text)
    const replyContext: LarkReplyContext = {
      ...(messageId ? { replyToMessageId: messageId } : {}),
      chatType,
      ...(typeof data.sender?.sender_id?.open_id === 'string' ? { senderOpenId: data.sender.sender_id.open_id } : {}),
    }
    if (command) {
      await this.handleInteractionCommand(channel, chatId, command, replyContext)
      return
    }

    let runtimeSession = this.deps.sessionRegistry.findByChannelId(channel.channelId)
    if (!runtimeSession) {
      const sessionId = channel.currentSdkSessionId || randomUUID()
      runtimeSession = this.deps.sessionRegistry.ensure(sessionId, channel.agentId, {
        channelId: channel.channelId,
      })
      if (!channel.currentSdkSessionId) {
        this.deps.configRepository.updateChannelCurrentSdkSessionId(channel.channelId, sessionId)
      }
    }

    const agent = this.deps.configRegistry.getAgent(channel.agentId)
    if (!agent) {
      throw new Error(`Agent not found for channel ${channel.channelId}: ${channel.agentId}`)
    }
    const persistedSession = await getSession(runtimeSession.sessionId, [agent.projectDir])
    const mode = persistedSession ? 'resume' as const : 'new' as const

    const dispatched = await this.deps.orchestrator.dispatchRun({
      sessionId: runtimeSession.sessionId,
      agentId: channel.agentId,
      text,
      mode,
    })
    this.replyContextByRunId.set(dispatched.runId, replyContext)
    this.runStartedAtByRunId.set(dispatched.runId, Date.now())
    // Create the streaming controller eagerly so `result` won't race ahead and
    // take the "no-controller" path (which would create a second card).
    this.getOrCreateStreamingController(channel, runtimeSession.sessionId, dispatched.runId)
    if (messageId) {
      this.typingReactionByRunId.set(dispatched.runId, {
        sourceMessageId: messageId,
        started: false,
        cleared: false,
      })
    }
    this.deps.logger.info('lark:message:dispatched', {
      connectorId,
      channelId: channel.channelId,
      sessionId: runtimeSession.sessionId,
      runId: dispatched.runId,
      chatId,
      chatType,
    })
  }

  private async handleWorkerEvent(event: WorkerOutputEvent): Promise<void> {
    const sessionId = event.sessionId
    if (!sessionId) return

    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session?.channelId) return

    const channel = this.deps.configRegistry.getChannel(session.channelId)
    if (!channel) return
    const connector = this.deps.configRegistry.getConnector(channel.connectorId)
    if (connector?.connectorType !== 'lark') return

    if (event.kind === 'sdk_message' && event.runId) {
      const normalized = normalizeSdkEnvelopeMessage(event.payload)
      if (normalized) {
        const existing = this.materializedMessagesByRunId.get(event.runId) || []
        const messageId = getTranscriptMessageId(normalized)
        const next = messageId
          ? (() => {
              const index = existing.findIndex((message) => getTranscriptMessageId(message) === messageId)
              if (index === -1) return [...existing, normalized]
              return existing.map((message, itemIndex) => (itemIndex === index ? normalized : message))
            })()
          : [...existing, normalized]
        this.materializedMessagesByRunId.set(event.runId, next)
      }
      if (normalized?.role === 'assistant') {
        this.latestAssistantMessageByRunId.set(event.runId, normalized)
        const blocks = Array.isArray(normalized.blocks) ? normalized.blocks : []
        const text = (
          extractStructuredContentFromBlocks(blocks).answerText
          || stringifyStructuredValue(normalized.content || '')
        ).trim()
        if (text) {
          this.latestAssistantTextByRunId.set(event.runId, truncateText(text))
          const streamingController = this.streamControllersByRunId.get(event.runId)
          if (streamingController) {
            await streamingController.onMaterializedText(text)
          }
        }
      }
      return
    }

    if (event.kind === 'sdk_stream_event' && event.runId) {
      // If the run is already delivered, ignore any late stream events to avoid
      // creating a second streaming card after the final card was sent.
      if (this.deliveredRunIds.has(event.runId)) return
      await this.ensureTypingReactionStarted(channel, event.runId)
      const normalized = this.normalizeSdkStreamEvent(event.runId, sessionId, event.receivedAt, event.payload)
      if (!normalized) return
      const streamingController = this.getOrCreateStreamingController(channel, sessionId, event.runId)
      await streamingController.onStreamEvent(normalized)
      return
    }

    if (event.kind === 'control_transaction') {
      if (event.phase !== 'awaiting_user') return
      const interaction = event.transaction.interaction
      if (!interaction || interaction.kind !== 'permission') return
      if (this.deliveredInteractionIds.has(interaction.id)) return
      this.deliveredInteractionIds.add(interaction.id)

      try {
        const replyContext = event.transaction.runId ? this.replyContextByRunId.get(event.transaction.runId) : undefined
        await this.sendCardToChannel(channel, buildPermissionCard(sessionId, interaction), replyContext)
        this.deps.logger.info('lark:permission-card:sent', {
          sessionId,
          requestId: interaction.id,
          conversationKey: channel.channelKey,
        })
      } catch (error) {
        this.deps.logger.error('lark:permission-card:send:error', {
          sessionId,
          requestId: interaction.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (event.kind !== 'result' || !event.runId) return
    if (this.deliveredRunIds.has(event.runId)) return
    this.deliveredRunIds.add(event.runId)
    this.latestResultPayloadByRunId.set(event.runId, event.payload)

    try {
      const replyContext = this.replyContextByRunId.get(event.runId)
      const streamingController = this.streamControllersByRunId.get(event.runId)
      if (streamingController) {
        await this.waitForTerminalSettling()
        let delivered = false
        if (event.subtype === 'success') {
          streamingController.markFullyComplete()
          delivered = await streamingController.onIdle()
        } else {
          delivered = await streamingController.onError(`运行失败：${event.subtype}`)
        }
        if (!delivered) {
          const card = await this.buildFinalCardForRun(sessionId, event.runId)
          if (card) {
            await this.createCardKitMessage(channel, card, replyContext)
          }
        }
      } else {
        const cachedAssistantText = event.subtype === 'success'
          ? this.latestAssistantTextByRunId.get(event.runId) ?? ''
          : ''
        const text = event.subtype === 'success'
          ? (cachedAssistantText || await this.buildLatestAssistantReply(sessionId))
          : `运行失败：${event.subtype}`
        if (!text) return
        const card = await this.buildFinalCardForRun(sessionId, event.runId, text)
        if (card) {
          await this.createCardKitMessage(channel, card, replyContext)
        }
      }
      this.deps.logger.info('lark:message:sent', {
        runId: event.runId,
        sessionId,
        conversationKey: channel.channelKey,
      })
      this.latestAssistantTextByRunId.delete(event.runId)
      this.latestAssistantMessageByRunId.delete(event.runId)
      this.replyContextByRunId.delete(event.runId)
      await this.clearTypingReaction(event.runId, channel)
      this.cleanupStreamingRun(event.runId)
    } catch (error) {
      this.deps.logger.error('lark:message:send:error', {
        runId: event.runId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private normalizeSdkStreamEvent(
    runId: string,
    sessionId: string,
    receivedAt: number,
    payload: unknown,
  ): SessionStreamEvent | null {
    const record = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : null
    if (!record || record.type !== 'stream_event') return null

    const rawEvent = record.event && typeof record.event === 'object'
      ? record.event as Record<string, unknown>
      : null
    const eventType = typeof rawEvent?.type === 'string'
      ? rawEvent.type as SessionStreamEvent['event']['type']
      : null
    if (!rawEvent || !eventType) return null

    const parentToolUseId = typeof record.parent_tool_use_id === 'string'
      ? record.parent_tool_use_id
      : record.parent_tool_use_id === null
        ? null
        : undefined
    const index = typeof rawEvent.index === 'number' ? rawEvent.index : undefined
    const directMessage = rawEvent.message && typeof rawEvent.message === 'object'
      ? rawEvent.message as Record<string, unknown>
      : null
    const directMessageId = typeof directMessage?.id === 'string' ? directMessage.id : undefined

    let messageId = directMessageId
    if (messageId) {
      this.activeStreamMessageIds.set(sessionId, messageId)
    } else {
      messageId = this.activeStreamMessageIds.get(sessionId)
    }
    if (eventType === 'message_stop') {
      this.activeStreamMessageIds.delete(sessionId)
    }

    const sequence = (this.streamSequenceByRunId.get(runId) ?? 0) + 1
    this.streamSequenceByRunId.set(runId, sequence)

    const scope: SessionStreamEvent['scope'] = messageId
      ? {
          scopeKey: `${sessionId}:message:${messageId}`,
          anchorKind: 'message',
          anchorId: messageId,
          messageId,
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
          ...(index !== undefined ? { index } : {}),
        }
      : typeof parentToolUseId === 'string'
        ? {
            scopeKey: `${sessionId}:tool_use:${parentToolUseId}`,
            anchorKind: 'tool_use',
            anchorId: parentToolUseId,
            parentToolUseId,
            ...(index !== undefined ? { index } : {}),
          }
        : {
            scopeKey: `${sessionId}:ephemeral:${sequence}`,
            anchorKind: 'ephemeral',
            anchorId: `${sessionId}:ephemeral:${sequence}`,
            ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
            ...(index !== undefined ? { index } : {}),
          }

    let normalized: SessionStreamEvent['normalized']
    if (eventType === 'content_block_start') {
      const block = rawEvent.content_block && typeof rawEvent.content_block === 'object'
        ? rawEvent.content_block as Record<string, unknown>
        : null
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
    } else if (eventType === 'content_block_delta') {
      const delta = rawEvent.delta && typeof rawEvent.delta === 'object'
        ? rawEvent.delta as Record<string, unknown>
        : null
      const deltaType = typeof delta?.type === 'string' ? delta.type : null
      if (delta && deltaType === 'text_delta') {
        normalized = { blockKind: 'text', deltaKind: 'text_delta', text: typeof delta.text === 'string' ? delta.text : '' }
      } else if (delta && deltaType === 'thinking_delta') {
        normalized = { blockKind: 'thinking', deltaKind: 'thinking_delta', thinking: typeof delta.thinking === 'string' ? delta.thinking : '' }
      } else if (delta && deltaType === 'input_json_delta') {
        normalized = { blockKind: 'tool_use', deltaKind: 'input_json_delta', partialJson: typeof delta.partial_json === 'string' ? delta.partial_json : '' }
      }
    }

    return {
      type: 'session.sdk.stream_event',
      runId,
      sessionId,
      receivedAt,
      sequence,
      scope,
      event: { type: eventType },
      ...(normalized ? { normalized } : {}),
      raw: payload,
    }
  }

  private async buildLatestAssistantReply(sessionId: string): Promise<string> {
    const page = await getMessagesPage(sessionId, {
      limit: 100,
      projectDirs: getProjectDirs(this.deps.configRegistry),
    })

    for (let index = page.messages.length - 1; index >= 0; index -= 1) {
      const message = page.messages[index]
      if (message?.role !== 'assistant') continue

      const blocks = Array.isArray(message.blocks) ? message.blocks : []
      const structured = extractStructuredContentFromBlocks(blocks)
      const text = structured.answerText || stringifyStructuredValue(message.content || '')
      if (text.trim()) return truncateText(text.trim())
    }

    return '已完成，但没有提取到可发送的文本回复。'
  }

  private async sendTextToChannel(channel: ChannelConfig, text: string, replyContext?: LarkReplyContext): Promise<void> {
    const client = this.getClient(channel.connectorId)
    const content = JSON.stringify({ text: truncateText(applyLarkReplyMentionToText(text, replyContext)) })
    if (replyContext?.replyToMessageId) {
      await client.im.message.reply({
        path: {
          message_id: replyContext.replyToMessageId,
        },
        data: {
          content,
          msg_type: 'text',
        },
      })
      return
    }
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: channel.channelKey,
        content,
        msg_type: 'text',
      },
    })
  }

  private async sendCardToChannel(channel: ChannelConfig, card: Lark.InteractiveCard, replyContext?: LarkReplyContext): Promise<string | undefined> {
    const client = this.getClient(channel.connectorId)
    const resolvedCard = applyLarkReplyMentionToCard(card, replyContext)
    if (replyContext?.replyToMessageId) {
      const response = await client.im.message.reply({
        path: {
          message_id: replyContext.replyToMessageId,
        },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(resolvedCard),
        },
      })
      return typeof response?.data?.message_id === 'string' ? response.data.message_id : undefined
    }
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: channel.channelKey,
        msg_type: 'interactive',
        content: JSON.stringify(resolvedCard),
      },
    })
    return typeof response?.data?.message_id === 'string' ? response.data.message_id : undefined
  }

  private async createCardKitMessage(
    channel: ChannelConfig,
    card: Record<string, unknown>,
    replyContext?: LarkReplyContext,
  ): Promise<{ cardId?: string; messageId?: string }> {
    const client = this.getClient(channel.connectorId)
    const cardResponse = await (client as any).cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    })
    const cardId = typeof cardResponse?.data?.card_id === 'string' ? cardResponse.data.card_id : undefined
    if (!cardId) return {}

    const payload = JSON.stringify({
      type: 'card',
      data: { card_id: cardId },
    })
    const messageResponse = replyContext?.replyToMessageId
      ? await client.im.message.reply({
          path: {
            message_id: replyContext.replyToMessageId,
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
            receive_id: channel.channelKey,
            msg_type: 'interactive',
            content: payload,
          },
        })

    const messageId = typeof messageResponse?.data?.message_id === 'string' ? messageResponse.data.message_id : undefined
    return {
      cardId,
      messageId,
    }
  }

  private async setCardKitStreamingMode(
    channel: ChannelConfig,
    cardId: string,
    streamingMode: boolean,
    sequence: number,
  ): Promise<void> {
    const client = this.getClient(channel.connectorId)
    await (client as any).cardkit.v1.card.settings({
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({ streaming_mode: streamingMode }),
        sequence,
      },
    })
  }

  private async updateCardKitCard(
    channel: ChannelConfig,
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    const client = this.getClient(channel.connectorId)
    await (client as any).cardkit.v1.card.update({
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: 'card_json',
          data: JSON.stringify(card),
        },
        sequence,
      },
    })
  }

  private cleanupInboundMessageDedupe(ttlMs: number = 30 * 60 * 1000): void {
    const now = Date.now()
    for (const [key, seenAt] of this.inboundMessageSeenAt.entries()) {
      if (now - seenAt > ttlMs) {
        this.inboundMessageSeenAt.delete(key)
      }
    }
  }

  private cleanupStreamingRun(runId: string): void {
    const controller = this.streamControllersByRunId.get(runId)
    controller?.dispose()
    this.streamControllersByRunId.delete(runId)
    this.streamSequenceByRunId.delete(runId)
    this.latestResultPayloadByRunId.delete(runId)
    this.runStartedAtByRunId.delete(runId)
    this.typingReactionByRunId.delete(runId)
    this.materializedMessagesByRunId.delete(runId)
  }

  private getOrCreateStreamingController(channel: ChannelConfig, sessionId: string, runId: string): LarkStreamingController {
    const existing = this.streamControllersByRunId.get(runId)
    if (existing) return existing

    const controller = new LarkStreamingController({
      runId,
      conversationKey: channel.channelKey,
      sessionId,
      buildCard: (params) => buildStreamingCardDocumentFromParams({
        ...params,
        materializedMessages: this.materializedMessagesByRunId.get(runId),
      }),
      buildFinalCard: async (footer) => {
        if (!footer) return null
        const page = await getMessagesPage(sessionId, {
          limit: 100,
          projectDirs: getProjectDirs(this.deps.configRegistry),
        })
        return buildLarkFinalCardFromHistory(page.messages, footer)
      },
      createCardKitMessage: async (card) => {
        const result = await this.createCardKitMessage(channel, card, this.replyContextByRunId.get(runId))
        return {
          delivered: Boolean(result.cardId),
          cardId: result.cardId,
          messageId: result.messageId,
          ...(result.cardId ? {} : { error: 'cardkit-create-failed' }),
        }
      },
      updateCardKitPreview: async (cardId, card, sequence) => {
        try {
          await this.updateCardKitCard(channel, cardId, card, sequence)
          return { delivered: true }
        } catch (error) {
          return { delivered: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      finalizeCardKit: async (cardId, closeSequence, updateSequence, card) => {
        try {
          await this.setCardKitStreamingMode(channel, cardId, false, closeSequence)
          await this.updateCardKitCard(channel, cardId, card, updateSequence)
          return { delivered: true }
        } catch (error) {
          return { delivered: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      appendLog: async ({ eventName, payloadSummary, payload }) => {
        this.deps.logger.info(`lark:${eventName}`, {
          runId,
          sessionId,
          conversationKey: channel.channelKey,
          payloadSummary,
          ...(payload ? { payload } : {}),
        })
      },
      getFooterMetrics: async () => {
        return await this.buildFooterForRun(
          runId,
          sessionId,
          this.latestResultPayloadByRunId.get(runId),
          Date.now(),
        )
      },
    })

    this.streamControllersByRunId.set(runId, controller)
    return controller
  }

  private async buildFooterForRun(
    runId: string,
    sessionId: string,
    payload: unknown,
    completedAt: number,
  ): Promise<DisplayAssistantFooter | null> {
    const page = await getMessagesPage(sessionId, {
      limit: 100,
      projectDirs: getProjectDirs(this.deps.configRegistry),
    })
    const footerFromHistory = getAssistantFooter(page.messages)
    if (footerFromHistory && (hasMeaningfulFooterUsage(footerFromHistory.usage) || footerFromHistory.stopReason || footerFromHistory.model)) {
      return footerFromHistory
    }

    const latestAssistantMessage = this.latestAssistantMessageByRunId.get(runId)
    if (latestAssistantMessage) {
      const footer = {
        completedAt,
        ...(getTranscriptStopReason(latestAssistantMessage) ? { stopReason: getTranscriptStopReason(latestAssistantMessage) ?? undefined } : {}),
        ...(getTranscriptAssistantUsage(latestAssistantMessage) ? { usage: getTranscriptAssistantUsage(latestAssistantMessage) ?? undefined } : {}),
        ...(getTranscriptAssistantModel(latestAssistantMessage) ? { model: getTranscriptAssistantModel(latestAssistantMessage) ?? undefined } : {}),
      }
      return footer
    }
    const footerFromPayload = buildFooterFromResultPayload(payload, completedAt)
    if (footerFromPayload?.stopReason || footerFromPayload?.model || footerFromPayload?.usage) {
      return footerFromPayload
    }
    if (!footerFromHistory) {
      return footerFromPayload
    }
    return footerFromHistory
  }

  private async buildFinalCardForRun(sessionId: string, runId: string, fallbackText?: string): Promise<Record<string, unknown> | null> {
    const footer = await this.buildFooterForRun(
      runId,
      sessionId,
      this.latestResultPayloadByRunId.get(runId),
      Date.now(),
    )
    if (footer) {
      const page = await getMessagesPage(sessionId, {
        limit: 100,
        projectDirs: getProjectDirs(this.deps.configRegistry),
      })
      const finalFromHistory = buildLarkFinalCardFromHistory(page.messages, footer)
      if (finalFromHistory) return finalFromHistory
    }
    const text = fallbackText ?? this.latestAssistantTextByRunId.get(runId) ?? ''
    if (!text.trim()) return null
    return buildStreamingCardDocumentFromParams({
      answerText: text,
      footer: footer ?? undefined,
      isFinal: true,
    })
  }

  private async ensureTypingReactionStarted(channel: ChannelConfig, runId: string): Promise<void> {
    const state = this.typingReactionByRunId.get(runId)
    if (!state || state.started || !state.sourceMessageId) return
    const client = this.getClient(channel.connectorId)
    try {
      const response = await client.im.messageReaction.create({
        path: {
          message_id: state.sourceMessageId,
        },
        data: {
          reaction_type: {
            emoji_type: 'Typing',
          },
        },
      })
      state.reactionId = typeof response?.data?.reaction_id === 'string' ? response.data.reaction_id : null
      state.started = true
    } catch (error) {
      this.deps.logger.error('lark:typing:add:error', {
        runId,
        messageId: state.sourceMessageId,
        error: error instanceof Error ? error.message : String(error),
      })
      state.started = true
    }
  }

  private async clearTypingReaction(runId: string, channel: ChannelConfig): Promise<void> {
    const state = this.typingReactionByRunId.get(runId)
    if (!state || state.cleared || !state.reactionId) return
    const client = this.getClient(channel.connectorId)
    try {
      await client.im.messageReaction.delete({
        path: {
          message_id: state.sourceMessageId,
          reaction_id: state.reactionId,
        },
      })
      state.cleared = true
    } catch (error) {
      this.deps.logger.error('lark:typing:remove:error', {
        runId,
        messageId: state.sourceMessageId,
        reactionId: state.reactionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async waitForTerminalSettling(delayMs: number = 200): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}
