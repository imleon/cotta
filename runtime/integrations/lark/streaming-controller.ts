import type { DisplayAssistantFooter, SessionStreamEvent, StreamRenderedPreviewState } from '../../protocol/message-types.js'
import type { SessionMessage } from '../../protocol/message-types.js'
import {
  advanceStreamAnimationCursor,
  createStreamAnimationCursor,
  reduceStreamPreviewEvent,
  renderStreamPreviewState,
  renderStreamPreviewText,
} from '../../protocol/transcript-normalizer.js'
import { LarkFlushController } from './flush-controller.js'
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
} from './streaming-types.js'

type CreateCardResult = {
  delivered: boolean
  cardId?: string
  messageId?: string
  error?: string
}

type UpdateResult = {
  delivered: boolean
  error?: string
}

export type LarkStreamingBuildCardParams = {
  answerText: string
  thinkingText?: string
  toolCalls?: string[]
  toolResults?: string[]
  footer?: DisplayAssistantFooter
  isFinal?: boolean
  preview?: StreamRenderedPreviewState
  materializedMessages?: SessionMessage[]
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
  buildCard: (params: LarkStreamingBuildCardParams) => Record<string, unknown>
  buildFinalCard?: (footer: DisplayAssistantFooter) => Promise<Record<string, unknown> | null>
  createCardKitMessage: (card: Record<string, unknown>) => Promise<CreateCardResult>
  updateCardKitPreview: (cardId: string, card: Record<string, unknown>, sequence: number) => Promise<UpdateResult>
  finalizeCardKit: (cardId: string, closeSequence: number, updateSequence: number, card: Record<string, unknown>) => Promise<UpdateResult>
  appendLog: (params: ChannelLogParams) => Promise<void>
  getFooterMetrics: () => Promise<DisplayAssistantFooter | null>
}

export class LarkStreamingController {
  private phase: LarkStreamingPhase = LARK_STREAMING_PHASES.idle
  private createEpoch = 0
  private dispatchFullyComplete = false
  private cardCreationPromise: Promise<void> | null = null
  private readonly flush: LarkFlushController
  private animationTimer: ReturnType<typeof setInterval> | null = null
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
    cursor: null,
    animationDone: false,
  }

  private thinkingText = ''
  private readonly toolCalls = new Set<string>()
  private renderedPreview: StreamRenderedPreviewState | null = null

  constructor(private readonly deps: StreamingControllerDeps) {
    this.flush = new LarkFlushController(() => this.performFlush())
  }

  get hasCard(): boolean {
    return Boolean(this.card.cardKitCardId || this.card.cardMessageId)
  }

  private shouldProceed(): boolean {
    return !LARK_TERMINAL_PHASES.has(this.phase)
  }

  private transition(to: LarkStreamingPhase, _reason?: LarkTerminalReason): boolean {
    const from = this.phase
    if (from === to) return false
    if (!LARK_PHASE_TRANSITIONS[from].has(to)) return false
    this.phase = to
    if (LARK_TERMINAL_PHASES.has(to)) {
      this.onEnterTerminalPhase()
    }
    return true
  }

  private onEnterTerminalPhase(): void {
    this.flush.cancelPendingFlush()
    this.flush.complete()
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }
  }

  private isStaleCreate(epoch: number): boolean {
    return epoch !== this.createEpoch
  }

  private nextSequence(): number {
    this.card.cardKitSequence += 1
    return this.card.cardKitSequence
  }

  private shouldProcessStreamEvent(event: SessionStreamEvent): boolean {
    return event.scope.anchorKind === 'message' && Boolean(event.scope.messageId || event.scope.anchorId)
  }

  async onStreamEvent(event: SessionStreamEvent): Promise<void> {
    if (!this.shouldProceed() || !this.shouldProcessStreamEvent(event)) return

    const nextPreview = reduceStreamPreviewEvent(this.text.previewState, event)
    this.text.previewState = nextPreview
    if (!this.text.cursor) {
      this.text.cursor = createStreamAnimationCursor(nextPreview)
    }
    this.renderedPreview = renderStreamPreviewState(nextPreview, this.text.cursor)

    const thinkingBlocks = nextPreview.blocks.filter(
      (block): block is Extract<typeof nextPreview.blocks[number], { kind: 'thinking' }> => block.kind === 'thinking' && !block.redacted,
    )
    this.thinkingText = thinkingBlocks.map((block) => block.text.trim()).filter(Boolean).join('\n\n')

    const toolUseBlocks = nextPreview.blocks.filter((block) => block.kind === 'tool_use')
    this.toolCalls.clear()
    for (const block of toolUseBlocks) {
      this.toolCalls.add(`[Tool call] ${block.name}`)
    }

    const visibleText = renderStreamPreviewText(nextPreview)
    if (!visibleText.trim() && !this.thinkingText.trim() && this.toolCalls.size === 0) return

    // Seed the initial card with the first visible content instead of a generic
    // "Processing..." placeholder, so users don't see an extra transient card.
    if (!this.text.accumulatedText.trim() && visibleText.trim()) {
      this.text.accumulatedText = visibleText.trim()
    }

    await this.ensureCardCreated()
    if (!this.shouldProceed()) return
    this.advanceAnimation()
    await this.throttledCardUpdate()
  }

  async onMaterializedText(text: string): Promise<void> {
    if (!this.shouldProceed()) return
    const normalized = text.trim()
    if (!normalized) return

    this.text.completedText = normalized
    const shouldPromoteMaterialized = !this.text.accumulatedText.trim() || !this.text.lastFlushedText.trim()
    if (shouldPromoteMaterialized) {
      this.text.accumulatedText = normalized
    }

    if (!this.hasCard) return
    if (!this.text.lastFlushedText.trim() || this.text.previewState === null) {
      await this.throttledCardUpdate()
    }
  }

  markFullyComplete(): void {
    this.dispatchFullyComplete = true
  }

  async onIdle(): Promise<boolean> {
    if (!this.dispatchFullyComplete || LARK_TERMINAL_PHASES.has(this.phase)) return false

    this.transition(LARK_STREAMING_PHASES.completed, 'normal')
    await this.prepareForTerminalUpdate()
    if (!this.card.cardMessageId) return false

    const finalText = this.text.completedText || this.text.accumulatedText || LARK_EMPTY_REPLY_FALLBACK_TEXT
    const footer = await this.deps.getFooterMetrics()
    const finalCard = await this.deps.buildFinalCard?.(footer ?? undefined as never) ?? this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer: footer ?? undefined,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-finalize' : (result.error || 'failed'),
      payload: result,
    })
    return result.delivered
  }

  async onError(error: string): Promise<boolean> {
    if (LARK_TERMINAL_PHASES.has(this.phase)) return false
    this.transition(LARK_STREAMING_PHASES.completed, 'error')
    await this.prepareForTerminalUpdate()
    if (!this.card.cardMessageId) return false

    const finalText = this.text.accumulatedText
      ? `${this.text.accumulatedText}\n\n---\nError: ${error}`
      : `Error: ${error}`
    const footer = await this.deps.getFooterMetrics()
    const finalCard = this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer: footer ?? undefined,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-error' : (result.error || 'failed'),
      payload: result,
    })
    return result.delivered
  }

  async abort(): Promise<boolean> {
    if (!this.transition(LARK_STREAMING_PHASES.aborted, 'abort')) return false
    await this.prepareForTerminalUpdate()
    if (!this.card.cardMessageId) return false

    const finalText = this.text.accumulatedText || 'Aborted.'
    const footer = await this.deps.getFooterMetrics()
    const finalCard = this.deps.buildCard({
      answerText: finalText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      footer: footer ?? undefined,
      isFinal: true,
    })

    await this.appendRequested(finalCard, finalText)
    const result = await this.updateFinalCard(finalCard)
    await this.deps.appendLog({
      eventName: result.delivered ? 'message.delivered' : 'message.failed',
      payloadSummary: result.delivered ? 'streaming-abort' : (result.error || 'failed'),
      payload: result,
    })
    return result.delivered
  }

  dispose(): void {
    this.flush.cancelPendingFlush()
    this.flush.complete()
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }
  }

  private async prepareForTerminalUpdate(): Promise<void> {
    this.flush.cancelPendingFlush()
    await this.flush.waitForFlush()
    if (this.cardCreationPromise) {
      await this.cardCreationPromise
      await this.flush.waitForFlush()
    }
  }

  private async ensureCardCreated(): Promise<void> {
    if (!this.shouldProceed()) return
    if (this.card.cardMessageId || this.phase === LARK_STREAMING_PHASES.creation_failed) return
    if (this.cardCreationPromise) {
      await this.cardCreationPromise
      return
    }
    if (!this.transition(LARK_STREAMING_PHASES.creating)) return

    this.createEpoch += 1
    const epoch = this.createEpoch
    const initialCard = this.deps.buildCard({
      answerText: this.text.accumulatedText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      isFinal: false,
      ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
    })

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
        if (cardKitResult.delivered && cardKitResult.cardId) {
          this.card.cardKitCardId = cardKitResult.cardId
          this.card.originalCardKitCardId = cardKitResult.cardId
          this.card.cardKitSequence = 1
          this.card.cardMessageId = cardKitResult.messageId ?? '__cardkit__'
          this.flush.setCardMessageReady(true)
          this.transition(LARK_STREAMING_PHASES.streaming)
          return
        }

        this.transition(LARK_STREAMING_PHASES.creation_failed, 'creation_failed')
      } catch {
        if (this.isStaleCreate(epoch)) return
        this.transition(LARK_STREAMING_PHASES.creation_failed, 'creation_failed')
      }
    })().finally(() => {
      this.cardCreationPromise = null
    })

    await this.cardCreationPromise
  }

  private advanceAnimation(): void {
    const step = () => {
      if (!this.text.previewState) return
      const advanced = advanceStreamAnimationCursor(this.text.cursor, this.text.previewState)
      this.text.cursor = advanced.cursor
      this.text.animationDone = advanced.done
      const rendered = renderStreamPreviewState(this.text.previewState, advanced.cursor)
      this.renderedPreview = rendered
      const renderedText = rendered.blocks
        .map((block) => {
          if (block.kind === 'text') return block.shownText
          if (block.kind === 'tool_use') return block.name ? `[Tool call] ${block.name}` : ''
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
      this.text.accumulatedText = advanced.done || !this.text.previewState.active
        ? renderedText
        : `${renderedText || ''} ▎`.trim()
      void this.throttledCardUpdate()

      if (advanced.done && !this.text.previewState.active && this.animationTimer) {
        clearInterval(this.animationTimer)
        this.animationTimer = null
      }
    }

    step()
    if (this.text.previewState?.active && !this.animationTimer) {
      this.animationTimer = setInterval(step, 50)
    }
  }

  private async performFlush(): Promise<void> {
    if (!this.card.cardMessageId || LARK_TERMINAL_PHASES.has(this.phase)) return
    const signature = this.renderedPreview ? JSON.stringify(this.renderedPreview) : this.text.accumulatedText.trim()
    if (!signature) return

    if (this.card.cardKitCardId) {
      if (signature === this.text.lastFlushedText) return
      const previewCard = this.deps.buildCard({
        answerText: this.text.accumulatedText,
        thinkingText: this.thinkingText || undefined,
        toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
        isFinal: false,
        ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
      })
      const sequence = this.nextSequence()
      const result = await this.deps.updateCardKitPreview(this.card.cardKitCardId, previewCard, sequence)
      await this.deps.appendLog({
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        payloadSummary: result.delivered ? 'cardkit-preview-update' : (result.error || 'failed'),
        payload: result,
      })
      if (result.delivered) {
        this.text.lastFlushedText = signature
        return
      }
      this.card.cardKitCardId = null
      return
    }
  }

  private async throttledCardUpdate(): Promise<void> {
    await this.flush.throttledUpdate(LARK_THROTTLE.CARDKIT_MS)
  }

  private async updateFinalCard(card: Record<string, unknown>): Promise<UpdateResult> {
    const effectiveCardId = this.card.cardKitCardId ?? this.card.originalCardKitCardId
    if (effectiveCardId) {
      const closeSequence = this.nextSequence()
      const updateSequence = this.nextSequence()
      return await this.deps.finalizeCardKit(effectiveCardId, closeSequence, updateSequence, card)
    }

    if (!effectiveCardId) {
      return { delivered: false, error: 'No message to finalize' }
    }
    return { delivered: false, error: 'No cardkit card to finalize' }
  }

  private async appendRequested(card: Record<string, unknown>, summary: string): Promise<void> {
    await this.deps.appendLog({
      eventName: 'message.requested',
      payloadSummary: summary,
      payload: card,
    })
  }
}
