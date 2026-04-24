import { randomUUID } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { ConfigRegistry } from '../../config/registry.js'
import type { ChannelConfig, ConnectorConfig } from '../../config/schema.js'
import type { Orchestrator } from '../../orchestration/orchestrator.js'
import type { SessionRegistry } from '../../orchestration/session-registry.js'
import { getMessagesPage, getSession } from '../../storage/fs/sessions.js'
import type { SqliteConfigRepository } from '../../storage/sqlite/config-repository.js'
import type { ChannelBindingService } from '../../orchestration/channel-binding-service.js'
import type {
  DisplayAssistantFooter,
  SessionEvent,
} from '../../protocol/index.js'
import type { TranscriptMessage } from '../../protocol/index.js'
import {
  extractStructuredContentFromBlocks,
  getTranscriptMessageId,
  normalizeSdkEnvelopeMessage,
  stringifyStructuredValue,
} from '../../protocol/index.js'
import { getLatestAssistantHistoryFooter } from '../../render/assistant-display.js'
import {
  buildLarkFinalCardFromHistory,
} from './card-builder.js'
import { LarkClientManager } from './client-manager.js'
import { LarkInteractionHandler } from './interaction-handler.js'
import {
  applyLarkReplyMentionToCard,
  applyLarkReplyMentionToText,
  asRecord,
  asString,
  buildFooterFromResultPayload,
  buildStreamingCardDocumentFromParams,
  findLarkChannelByConversationKey,
  getProjectDirs,
  hasMeaningfulFooter,
  isEventExpired,
  listEnabledLarkChannels,
  listLarkConnectors,
  parseConnectorConfig,
  parseLarkTextContent,
  truncateText,
  type LarkReceiveEvent,
  type LarkInteractionCommand,
  type LarkReplyContext,
} from './helpers.js'
import { LarkStreamingController } from './streaming-controller.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type CardkitMutationResponse = {
  code?: number
  msg?: string
  data?: {
    card_id?: string
    message_id?: string
  }
}

type CardkitApi = {
  create(input: {
    data: {
      type: 'card_json'
      data: string
    }
  }): Promise<CardkitMutationResponse>
  settings(input: {
    path: { card_id: string }
    data: { settings: string; sequence: number }
  }): Promise<CardkitMutationResponse>
  update(input: {
    path: { card_id: string }
    data: {
      card: { type: 'card_json'; data: string }
      sequence: number
    }
  }): Promise<CardkitMutationResponse>
}

type ClientWithCardkit = Lark.Client & {
  cardkit?: {
    v1?: {
      card?: CardkitApi
    }
  }
}

export class LarkIntegrationService {
  private readonly subscriberKey = 'lark-integration'
  private readonly deliveredRunIds = new Map<string, number>()
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
  private readonly runEventQueueByRunId = new Map<string, Promise<void>>()
  private readonly clientManager: LarkClientManager
  private readonly interactionHandler: LarkInteractionHandler
  private started = false

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      configRepository: SqliteConfigRepository
      channelBindingService: ChannelBindingService
      sessionRegistry: SessionRegistry
      orchestrator: Orchestrator
      logger: Logger
    },
  ) {
    this.clientManager = new LarkClientManager({
      configRegistry: deps.configRegistry,
      logger: deps.logger,
      onReceiveMessage: async (connectorId, data) => await this.handleReceiveMessage(connectorId, data),
    })
    this.interactionHandler = new LarkInteractionHandler({
      orchestrator: deps.orchestrator,
      sessionRegistry: deps.sessionRegistry,
      logger: deps.logger,
      sendText: async (channel, text, replyContext) => await this.sendTextToChannel(channel, text, replyContext),
      sendCard: async (channel, card, replyContext) => await this.sendCardToChannel(channel, card, replyContext),
    })
  }

  private getCardkitApi(channel: ChannelConfig): CardkitApi {
    const client = this.clientManager.getClient(channel.connectorId) as ClientWithCardkit
    const api = client.cardkit?.v1?.card
    if (!api) {
      throw new Error(`CardKit API unavailable for connector ${channel.connectorId}`)
    }
    return api
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.deps.orchestrator.subscribeSessionEvents(this.subscriberKey, (event) => {
      void this.handleWorkerEvent(event).catch((error) => {
        this.deps.logger.error('lark:worker-event:error', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
    for (const connectorId of this.clientManager.listLarkConnectorIds()) {
      void this.clientManager.startLongConnection(connectorId).catch((error) => {
        this.deps.logger.error('lark:ws:start:error', {
          connectorId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.deps.orchestrator.unsubscribeSessionEvents(this.subscriberKey)
    await this.clientManager.stopAll()
  }

  isConfigured(): boolean {
    return listEnabledLarkChannels(this.deps.configRegistry).length > 0
  }

  async handleInbound(body: unknown): Promise<{ status: number; payload: unknown }> {
    const record = asRecord(body)
    if (!record) return { status: 400, payload: { error: 'Invalid request body' } }

    if ('challenge' in record) {
      return { status: 200, payload: { challenge: record.challenge } }
    }

    const requestTraceId = randomUUID()
    const allConnectors = listLarkConnectors(this.deps.configRegistry)
    const appIdHint = this.extractInboundAppIdHint(record)
    const connectors = appIdHint
      ? allConnectors.filter((connector) => this.matchesConnectorAppId(connector, appIdHint))
      : allConnectors
    const attemptedConnectorIds: string[] = []
    for (const connector of connectors) {
      const dispatcher = this.clientManager.getDispatcher(connector.connectorId)
      attemptedConnectorIds.push(connector.connectorId)
      try {
        await dispatcher.invoke(record, { needCheck: true })
        this.deps.logger.info('lark:inbound:matched', {
          requestTraceId,
          connectorId: connector.connectorId,
          appIdHint: appIdHint ?? undefined,
          attemptedConnectors: attemptedConnectorIds.length,
        })
        return { status: 200, payload: { ok: true } }
      } catch (error) {
        this.deps.logger.warn('lark:inbound:connector-mismatch', {
          requestTraceId,
          connectorId: connector.connectorId,
          appIdHint: appIdHint ?? undefined,
          failureKind: this.classifyInboundDispatchError(error),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    this.deps.logger.warn('lark:inbound:unmatched', {
      requestTraceId,
      connectorCount: allConnectors.length,
      attemptedConnectorIds,
      appIdHint: appIdHint ?? undefined,
      keys: Object.keys(record),
    })
    return { status: 400, payload: { error: 'No matching lark connector' } }
  }

  private extractInboundAppIdHint(record: Record<string, unknown>): string | null {
    const header = asRecord(record.header)
    const event = asRecord(record.event)
    const appIdCandidates = [
      record.app_id,
      header?.app_id,
      event?.app_id,
    ]
    for (const candidate of appIdCandidates) {
      const appId = asString(candidate)
      if (appId) return appId
    }
    return null
  }

  private matchesConnectorAppId(connector: ConnectorConfig, appIdHint: string): boolean {
    const parsed = parseConnectorConfig(connector)
    return parsed?.appId === appIdHint
  }

  private classifyInboundDispatchError(error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (message.includes('token')) return 'token'
    if (message.includes('encrypt') || message.includes('decrypt')) return 'decrypt'
    if (message.includes('sign') || message.includes('signature')) return 'signature'
    if (message.includes('app id') || message.includes('app_id')) return 'app_id'
    return 'dispatch'
  }

  async handleCardAction(body: unknown): Promise<{ status: number; payload: unknown }> {
    const result = await this.interactionHandler.handleCardAction(body)
    return result ?? { status: 400, payload: { error: 'Invalid request body' } }
  }

  async sendTextToConversation(conversationKey: string, text: string): Promise<void> {
    const channel = findLarkChannelByConversationKey(this.deps.configRegistry, conversationKey)
    if (!channel) {
      throw new Error(`Lark channel not found for conversationKey: ${conversationKey}`)
    }
    await this.sendTextToChannel(channel, text)
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
        this.deps.channelBindingService.clearChannel(channel.channelId)
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
      this.deps.channelBindingService.bindChannel(channel.channelId, sessionId, channel.agentId)
      await this.sendTextToChannel(
        channel,
        `Bound this chat to session ${sessionId}${persisted.title ? ` (${persisted.title})` : ''}.`,
        replyContext,
      )
      return
    }
    await this.interactionHandler.handleCommand(channel, command, replyContext)
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
    if (this.deps.configRepository.hasLarkInboundReceipt(connectorId, chatId, messageId)) {
      this.deps.logger.info('lark:message:deduped-persisted', { connectorId, chatId, messageId })
      return
    }
    this.inboundMessageSeenAt.set(dedupeKey, Date.now())

    try {
      if (isEventExpired(asString(data.message?.create_time))) {
        this.deps.logger.info('lark:message:expired', { connectorId, chatId, messageId })
        return
      }

      const channel = listEnabledLarkChannels(this.deps.configRegistry)
        .find((item) => item.channelKey === chatId && item.connectorId === connectorId)
      if (!channel) {
        this.deps.logger.warn('lark:message:channel-miss', { connectorId, chatId })
        return
      }

      const command = this.interactionHandler.parseCommand(text)
      const replyContext: LarkReplyContext = {
        ...(messageId ? { replyToMessageId: messageId } : {}),
        chatType,
        ...(typeof data.sender?.sender_id?.open_id === 'string' ? { senderOpenId: data.sender.sender_id.open_id } : {}),
      }
      if (command) {
        await this.handleInteractionCommand(channel, chatId, command, replyContext)
        this.deps.configRepository.recordLarkInboundReceipt(connectorId, chatId, messageId)
        return
      }

      let runtimeSession = this.deps.sessionRegistry.findByChannelId(channel.channelId)
      if (!runtimeSession) {
        const sessionId = this.deps.configRepository.getChannelCurrentSdkSessionId(channel.channelId) || randomUUID()
        this.deps.channelBindingService.bindChannel(channel.channelId, sessionId, channel.agentId)
        runtimeSession = this.deps.sessionRegistry.get(sessionId)
      }
      if (!runtimeSession) throw new Error(`Failed to resolve runtime session for channel ${channel.channelId}`)

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
      this.deps.configRepository.recordLarkInboundReceipt(connectorId, chatId, messageId)
      this.deps.logger.info('lark:message:dispatched', {
        connectorId,
        channelId: channel.channelId,
        sessionId: runtimeSession.sessionId,
        runId: dispatched.runId,
        chatId,
        chatType,
      })
    } catch (error) {
      this.inboundMessageSeenAt.delete(dedupeKey)
      throw error
    }
  }

  private async handleWorkerEvent(event: SessionEvent): Promise<void> {
    // Preserve per-run ordering across async awaits inside handlers (e.g. typing reaction,
    // card creation). Without this, a terminal event can overtake earlier stream events,
    // resulting in "final only" delivery.
    const runId = ('runId' in event && typeof event.runId === 'string' && event.runId.trim())
      ? event.runId.trim()
      : null
    if (runId) {
      this.enqueueRunEvent(runId, () => this.handleWorkerEventInner(event))
      return
    }
    await this.handleWorkerEventInner(event)
  }

  private enqueueRunEvent(runId: string, task: () => Promise<void>): void {
    const prev = this.runEventQueueByRunId.get(runId) ?? Promise.resolve()
    const next = prev
      .then(task)
      .catch((error) => {
        this.deps.logger.error('lark:run-event:error', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (this.runEventQueueByRunId.get(runId) === next) {
          this.runEventQueueByRunId.delete(runId)
        }
      })
    this.runEventQueueByRunId.set(runId, next)
  }

  private async handleWorkerEventInner(event: SessionEvent): Promise<void> {
    const sessionId = event.sessionId
    if (!sessionId) return

    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session?.channelId) return

    const channel = this.deps.configRegistry.getChannel(session.channelId)
    if (!channel) return
    const connector = this.deps.configRegistry.getConnector(channel.connectorId)
    if (connector?.connectorType !== 'lark') return

    if (event.type === 'session.sdk.message' && event.runId) {
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

    if (event.type === 'session.sdk.stream_event' && event.runId) {
      // If the run is already delivered, ignore any late stream events to avoid
      // creating a second streaming card after the final card was sent.
      if (this.deliveredRunIds.has(event.runId)) return
      void this.ensureTypingReactionStarted(channel, event.runId)
      const streamingController = this.getOrCreateStreamingController(channel, sessionId, event.runId)
      await streamingController.onStreamEvent(event.event)
      return
    }

    if (event.type === 'session.interactive.awaiting_user' || event.type === 'session.control.awaiting_user') {
      const interaction = event.transaction.interaction
      if (!interaction) return
      const replyContext = event.transaction.runId ? this.replyContextByRunId.get(event.transaction.runId) : undefined
      try {
        await this.interactionHandler.handleAwaitingUser(sessionId, channel, interaction, replyContext)
      } catch (error) {
        this.deps.logger.error('lark:interaction:send:error', {
          sessionId,
          requestId: interaction.id,
          kind: interaction.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (event.type !== 'session.run.completed' && event.type !== 'session.run.failed') return
    const runId = event.runId
    if (!runId) return
    if (this.deliveredRunIds.has(runId)) return

    try {
      const replyContext = this.replyContextByRunId.get(runId)
      const streamingController = this.streamControllersByRunId.get(runId)
      let delivered = false
      if (streamingController) {
        await this.waitForTerminalSettling()
        if (event.type === 'session.run.completed') {
          streamingController.markFullyComplete()
          delivered = await streamingController.onIdle()
        } else {
          delivered = await streamingController.onError(`运行失败：${event.error}`)
        }
        if (!delivered) {
          const card = await this.buildFinalCardForRun(sessionId, runId)
          if (card) {
            await this.createCardKitMessage(channel, card, replyContext)
            delivered = true
          }
        }
      } else {
        const cachedAssistantText = event.type === 'session.run.completed'
          ? this.latestAssistantTextByRunId.get(runId) ?? ''
          : ''
        const text = event.type === 'session.run.completed'
          ? (cachedAssistantText || await this.buildLatestAssistantReply(sessionId))
          : `运行失败：${event.error}`
        if (!text) return
        const card = await this.buildFinalCardForRun(sessionId, runId, text)
        if (card) {
          await this.createCardKitMessage(channel, card, replyContext)
          delivered = true
        }
      }
      if (delivered) {
        this.deliveredRunIds.set(runId, Date.now())
      }
      this.deps.logger.info('lark:message:sent', {
        runId,
        sessionId,
        conversationKey: channel.channelKey,
      })
    } catch (error) {
      this.deps.logger.error('lark:message:send:error', {
        runId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      try {
        await this.clearTypingReaction(runId, channel)
      } catch (error) {
        this.deps.logger.error('lark:typing:cleanup:error', {
          runId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      this.releaseRunState(runId)
      this.cleanupDeliveredRuns()
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
    const client = this.clientManager.getClient(channel.connectorId)
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
    const client = this.clientManager.getClient(channel.connectorId)
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
    const client = this.clientManager.getClient(channel.connectorId)
    const cardResponse = await this.getCardkitApi(channel).create({
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
    const response = await this.getCardkitApi(channel).settings({
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({ streaming_mode: streamingMode }),
        sequence,
      },
    })
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || `card.settings failed with code ${response.code}`)
    }
  }

  private async updateCardKitCard(
    channel: ChannelConfig,
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    const response = await this.getCardkitApi(channel).update({
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
    if (response.code && response.code !== 0) {
      throw new Error(response.msg || `card.update failed with code ${response.code}`)
    }
  }

  private cleanupInboundMessageDedupe(ttlMs: number = 30 * 60 * 1000): void {
    const now = Date.now()
    for (const [key, seenAt] of this.inboundMessageSeenAt.entries()) {
      if (now - seenAt > ttlMs) {
        this.inboundMessageSeenAt.delete(key)
      }
    }
  }

  private cleanupDeliveredRuns(ttlMs: number = 30 * 60 * 1000): void {
    const now = Date.now()
    for (const [runId, deliveredAt] of this.deliveredRunIds.entries()) {
      if (now - deliveredAt > ttlMs) {
        this.deliveredRunIds.delete(runId)
      }
    }
  }

  private cleanupStreamingRun(runId: string): void {
    const controller = this.streamControllersByRunId.get(runId)
    controller?.dispose()
    this.streamControllersByRunId.delete(runId)
    this.latestResultPayloadByRunId.delete(runId)
    this.runStartedAtByRunId.delete(runId)
    this.typingReactionByRunId.delete(runId)
    this.materializedMessagesByRunId.delete(runId)
  }

  private releaseRunState(runId: string): void {
    this.latestAssistantTextByRunId.delete(runId)
    this.latestAssistantMessageByRunId.delete(runId)
    this.replyContextByRunId.delete(runId)
    this.cleanupStreamingRun(runId)
  }

  private getOrCreateStreamingController(channel: ChannelConfig, sessionId: string, runId: string): LarkStreamingController {
    const existing = this.streamControllersByRunId.get(runId)
    if (existing) return existing

    const controller = new LarkStreamingController({
      runId,
      conversationKey: channel.channelKey,
      sessionId,
      buildCard: (params) => buildStreamingCardDocumentFromParams(params),
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
          // Update final content FIRST (while streaming_mode=true), THEN close streaming_mode.
          // Rationale: CardKit accepts card.update only while streaming_mode is active; closing
          // it first freezes the card at whatever was last shown (often Processing...).
          // Here updateSequence is the smaller one (caller: nextSequence() ordering),
          // so swap so that closeSequence is monotonically after updateSequence.
          await this.updateCardKitCard(channel, cardId, card, updateSequence)
          await this.setCardKitStreamingMode(channel, cardId, false, closeSequence)
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
    const footerFromHistory = getLatestAssistantHistoryFooter(page.messages)
    if (hasMeaningfulFooter(footerFromHistory)) {
      return footerFromHistory
    }

    const latestAssistantMessage = this.latestAssistantMessageByRunId.get(runId)
    if (latestAssistantMessage) {
      const latestMessageId = getTranscriptMessageId(latestAssistantMessage)
      const mergedMessages = latestMessageId && page.messages.some((message) => getTranscriptMessageId(message) === latestMessageId)
        ? page.messages
        : [...page.messages, latestAssistantMessage]
      const footerFromMergedHistory = getLatestAssistantHistoryFooter(mergedMessages)
      if (hasMeaningfulFooter(footerFromMergedHistory)) {
        return footerFromMergedHistory
      }
    }

    const footerFromPayload = buildFooterFromResultPayload(payload, completedAt)
    if (hasMeaningfulFooter(footerFromPayload)) {
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
    const client = this.clientManager.getClient(channel.connectorId)
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
    const client = this.clientManager.getClient(channel.connectorId)
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
