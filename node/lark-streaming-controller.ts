import { createLogger } from './logger.js'
import { LarkFlushController } from './lark-flush-controller.js'
import {
  LARK_EMPTY_REPLY_FALLBACK_TEXT,
  LARK_PHASE_TRANSITIONS,
  LARK_STREAMING_PHASES,
  LARK_TERMINAL_PHASES,
  LARK_THROTTLE,
  type LarkCardState,
  type LarkStreamingPhase,
  type LarkStreamingTextState,
  type LarkTerminalReason,
} from './lark-streaming-types.js'
import type { DisplayAssistantFooter, SessionStreamEvent, StreamPreviewState } from '../shared/message-types.js'
import { reduceStreamPreviewEvent, renderStreamPreviewText } from '../shared/transcript-normalizer.js'

const logger = createLogger('lark-streaming-controller')

type CreateCardResult = {
  delivered: boolean
  cardId?: string
  messageId?: string
  error?: string
}

type InteractiveCardResult = {
  delivered: boolean
  messageId?: string
  error?: string
}

type UpdateResult = {
  delivered: boolean
  error?: string
}

type BuildCardParams = {
  answerText: string
  thinkingText?: string
  toolCalls?: string[]
  toolResults?: string[]
  footer?: DisplayAssistantFooter
  isFinal?: boolean
}

type ChannelLogParams = {
  eventName: string
  payloadSummary: string
  payload?: unknown
  rawPayload?: unknown
}

type StreamingControllerDeps = {
  runId: string
  conversationKey: string
  sessionId?: string
  buildCard: (params: BuildCardParams) => unknown
  buildFinalCard?: (footer: DisplayAssistantFooter) => Promise<unknown | null>
  createCardKitMessage: (card: unknown) => Promise<CreateCardResult>
  sendInteractiveCard: (card: unknown) => Promise<InteractiveCardResult>
  streamCardKitContent: (cardId: string, content: string, sequence: number) => Promise<UpdateResult>
  updateInteractiveCard: (messageId: string, card: unknown) => Promise<UpdateResult>
  finalizeCardKit: (cardId: string, closeSequence: number, updateSequence: number, card: unknown) => Promise<UpdateResult>
  appendLog: (params: ChannelLogParams) => Promise<void>
  getFooterMetrics: () => Promise<DisplayAssistantFooter>
}

export class LarkStreamingController {
  private phase: LarkStreamingPhase = LARK_STREAMING_PHASES.idle
  private terminalReason: LarkTerminalReason | null = null
  private createEpoch = 0
  private dispatchFullyComplete = false
  private cardCreationPromise: Promise<void> | null = null
  private readonly flush: LarkFlushController
  private readonly card: LarkCardState = {
    cardKitCardId: null,
    originalCardKitCardId: null,
    cardKitSequence: 0,
    cardMessageId: null,
  }

  private readonly text: LarkStreamingTextState = {
    accumulatedText: '',
    completedText: '',
    lastFlushedText: '',
    previewState: null,
  }

  private thinkingText = ''
  private readonly toolCalls = new Set<string>()

  constructor(private readonly deps: StreamingControllerDeps) {
    this.flush = new LarkFlushController(() => this.performFlush())
  }

  get isTerminalPhase(): boolean {
    return LARK_TERMINAL_PHASES.has(this.phase)
  }

  get hasVisibleContent(): boolean {
    return Boolean(this.text.completedText.trim() || this.text.accumulatedText.trim())
  }

  private shouldProceed(source: string): boolean {
    if (this.isTerminalPhase) {
      logger.debug('skip:terminal', { source, runId: this.deps.runId, phase: this.phase })
      return false
    }
    return true
  }

  private transition(to: LarkStreamingPhase, source: string, reason?: LarkTerminalReason): boolean {
    const from = this.phase
    if (from === to) return false
    if (!LARK_PHASE_TRANSITIONS[from].has(to)) {
      logger.warn('phase-transition-rejected', { from, to, source, runId: this.deps.runId })
      return false
    }
    this.phase = to
    if (LARK_TERMINAL_PHASES.has(to)) {
      this.terminalReason = reason ?? null
      this.onEnterTerminalPhase()
    }
    logger.info('phase-transition', { from, to, source, reason, runId: this.deps.runId })
    return true
  }

  private onEnterTerminalPhase(): void {
    this.createEpoch += 1
    this.flush.cancelPendingFlush()
    this.flush.complete()
  }

  private isStaleCreate(epoch: number): boolean {
    return epoch !== this.createEpoch
  }

  private nextSequence(): number {
    this.card.cardKitSequence += 1
    return this.card.cardKitSequence
  }

  private shouldProcessStreamEvent(event: SessionStreamEvent): boolean {
    const scope = event.scope
    return event.scope.anchorKind === 'message' && Boolean(scope.messageId || scope.anchorId)
  }

  async onStreamEvent(event: SessionStreamEvent): Promise<void> {
    if (!this.shouldProceed('onStreamEvent')) return
    if (!this.shouldProcessStreamEvent(event)) return

    const nextPreview = reduceStreamPreviewEvent(this.text.previewState, event)
    this.text.previewState = nextPreview
    const accumulatedText = renderStreamPreviewText(nextPreview)

    const thinkingBlocks = nextPreview.blocks.filter(
      (block): block is Extract<StreamPreviewState['blocks'][number], { kind: 'thinking' }> => block.kind === 'thinking' && !block.redacted,
    )
    this.thinkingText = thinkingBlocks.map((block) => block.text.trim()).filter(Boolean).join('\n\n')

    const toolUseBlocks = nextPreview.blocks.filter((block) => block.kind === 'tool_use')
    this.toolCalls.clear()
    for (const block of toolUseBlocks) {
      this.toolCalls.add(`[Tool call] ${block.name}`)
    }

    if (!accumulatedText.trim() && !this.thinkingText.trim() && this.toolCalls.size === 0) return

    if (accumulatedText.trim()) {
      this.text.accumulatedText = accumulatedText
    }

    await this.ensureCardCreated()
    if (!this.shouldProceed('onStreamEvent.postCreate')) return
    if (!this.card.cardMessageId) return

    await this.throttledCardUpdate()
  }

  async onMaterializedText(text: string): Promise<void> {
    if (!this.shouldProceed('onMaterializedText')) return
    const normalized = text.trim()
    if (!normalized) return

    this.text.completedText = normalized

    const hasVisibleStreamText = this.text.accumulatedText.trim().length > 0
    const hasFlushedStreamText = this.text.lastFlushedText.trim().length > 0
    const shouldPromoteMaterialized = !hasVisibleStreamText || !hasFlushedStreamText
    if (shouldPromoteMaterialized) {
      this.text.accumulatedText = normalized
    }

    await this.ensureCardCreated()
    if (!this.shouldProceed('onMaterializedText.postCreate')) return
    if (!this.card.cardMessageId) return

    if (!hasFlushedStreamText || this.text.previewState === null) {
      await this.throttledCardUpdate()
    }
  }

  markFullyComplete(): void {
    this.dispatchFullyComplete = true
  }

  async onIdle(): Promise<void> {
    if (!this.dispatchFullyComplete) return
    if (this.isTerminalPhase) return

    this.transition(LARK_STREAMING_PHASES.completed, 'onIdle', 'normal')
    await this.prepareForTerminalUpdate()

    if (!this.card.cardMessageId) return

    const finalText = this.text.completedText || this.text.accumulatedText || LARK_EMPTY_REPLY_FALLBACK_TEXT
    const footer = await this.deps.getFooterMetrics()
    const finalCard = await this.deps.buildFinalCard?.(footer) ?? this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-finalize' : (result.error || 'failed'),
      payload: result,
    })
  }

  async onError(error: string): Promise<void> {
    if (this.isTerminalPhase) return
    this.transition(LARK_STREAMING_PHASES.completed, 'onError', 'error')
    await this.prepareForTerminalUpdate()

    if (!this.card.cardMessageId) return

    const finalText = this.text.accumulatedText
      ? `${this.text.accumulatedText}\n\n---\nError: ${error}`
      : `Error: ${error}`
    const footer = await this.deps.getFooterMetrics()
    const finalCard = this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-error' : (result.error || 'failed'),
      payload: result,
    })
  }

  async abort(): Promise<void> {
    if (!this.transition(LARK_STREAMING_PHASES.aborted, 'abort', 'abort')) return
    this.flush.cancelPendingFlush()
    await this.flush.waitForFlush()

    if (!this.card.cardMessageId) return

    const finalText = this.text.accumulatedText || 'Aborted.'
    const footer = await this.deps.getFooterMetrics()
    const finalCard = this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-abort' : (result.error || 'failed'),
      payload: result,
    })
  }

  private async prepareForTerminalUpdate(): Promise<void> {
    await this.flush.waitForFlush()
    if (this.cardCreationPromise) {
      await this.cardCreationPromise
      await this.flush.waitForFlush()
    }
  }

  private async ensureCardCreated(): Promise<void> {
    if (!this.shouldProceed('ensureCardCreated.precheck')) return
    if (this.card.cardMessageId || this.phase === LARK_STREAMING_PHASES.creation_failed) {
      return
    }
    if (this.cardCreationPromise) {
      await this.cardCreationPromise
      return
    }
    if (!this.transition(LARK_STREAMING_PHASES.creating, 'ensureCardCreated')) return

    this.createEpoch += 1
    const epoch = this.createEpoch
    const initialCard = this.deps.buildCard({ answerText: '', isFinal: false })

    this.cardCreationPromise = (async () => {
      try {
        await this.appendRequested(initialCard, this.text.accumulatedText || 'interactive-card')
        const cardKitResult = await this.deps.createCardKitMessage(initialCard)
        await this.deps.appendLog({
          eventName: cardKitResult.delivered ? 'message.delivered' : 'message.failed',
          payloadSummary: cardKitResult.delivered ? 'cardkit-card' : (cardKitResult.error || 'failed'),
          payload: cardKitResult,
        })

        if (this.isStaleCreate(epoch)) return
        if (cardKitResult.delivered && cardKitResult.cardId && cardKitResult.messageId) {
          this.card.cardKitCardId = cardKitResult.cardId
          this.card.originalCardKitCardId = cardKitResult.cardId
          this.card.cardKitSequence = 1
          this.card.cardMessageId = cardKitResult.messageId
          this.flush.setCardMessageReady(true)
          this.transition(LARK_STREAMING_PHASES.streaming, 'ensureCardCreated.cardkit')
          return
        }

        const fallbackResult = await this.deps.sendInteractiveCard(initialCard)
        await this.deps.appendLog({
          eventName: fallbackResult.delivered ? 'message.delivered' : 'message.failed',
          payloadSummary: fallbackResult.delivered ? 'interactive-card' : (fallbackResult.error || 'failed'),
          payload: fallbackResult,
        })

        if (this.isStaleCreate(epoch)) return
        if (fallbackResult.delivered && fallbackResult.messageId) {
          this.card.cardKitCardId = null
          this.card.originalCardKitCardId = null
          this.card.cardMessageId = fallbackResult.messageId
          this.flush.setCardMessageReady(true)
          this.transition(LARK_STREAMING_PHASES.streaming, 'ensureCardCreated.interactive')
          return
        }

        this.transition(LARK_STREAMING_PHASES.creation_failed, 'ensureCardCreated.failed', 'creation_failed')
      } catch (error) {
        if (this.isStaleCreate(epoch)) return
        logger.warn('ensure-card-created-failed', {
          runId: this.deps.runId,
          error: error instanceof Error ? error.message : String(error),
        })
        this.transition(LARK_STREAMING_PHASES.creation_failed, 'ensureCardCreated.error', 'creation_failed')
      }
    })()

    await this.cardCreationPromise
  }

  private async performFlush(): Promise<void> {
    if (!this.card.cardMessageId || this.isTerminalPhase) return
    if (!this.card.cardKitCardId && this.card.originalCardKitCardId) {
      logger.debug('flush-skipped-awaiting-finalize', { runId: this.deps.runId })
      return
    }

    const displayText = this.text.accumulatedText.trim()
    if (!displayText) return

    if (this.card.cardKitCardId) {
      if (displayText === this.text.lastFlushedText) {
        return
      }
      const sequence = this.nextSequence()
      const result = await this.deps.streamCardKitContent(this.card.cardKitCardId, displayText, sequence)
      await this.deps.appendLog({
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        payloadSummary: result.delivered ? 'cardkit-stream' : (result.error || 'failed'),
        payload: result,
      })
      if (result.delivered) {
        this.text.lastFlushedText = displayText
        return
      }
      this.card.cardKitCardId = null
      return
    }

    const card = this.deps.buildCard({ answerText: displayText, isFinal: false })
    const result = await this.deps.updateInteractiveCard(this.card.cardMessageId, card)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'interactive-patch' : (result.error || 'failed'),
      payload: result,
    })
    if (result.delivered) {
      this.text.lastFlushedText = displayText
    }
  }

  private async throttledCardUpdate(): Promise<void> {
    const throttleMs = this.card.cardKitCardId ? LARK_THROTTLE.CARDKIT_MS : LARK_THROTTLE.PATCH_MS
    await this.flush.throttledUpdate(throttleMs)
  }

  private async updateFinalCard(card: unknown): Promise<UpdateResult> {
    const effectiveCardId = this.card.cardKitCardId ?? this.card.originalCardKitCardId
    if (effectiveCardId) {
      const closeSequence = this.nextSequence()
      const updateSequence = this.nextSequence()
      return await this.deps.finalizeCardKit(effectiveCardId, closeSequence, updateSequence, card)
    }

    if (!this.card.cardMessageId) {
      return { delivered: false, error: 'No message to finalize' }
    }

    return await this.deps.updateInteractiveCard(this.card.cardMessageId, card)
  }

  private async appendRequested(card: unknown, summary: string): Promise<void> {
    await this.deps.appendLog({
      eventName: 'message.requested',
      payloadSummary: summary,
      payload: card,
    })
  }
}
