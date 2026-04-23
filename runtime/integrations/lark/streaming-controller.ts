import type {
  DisplayAssistantFooter,
  SessionStreamEvent,
  StreamAnimationCursor,
  StreamPreviewState,
  StreamRenderedPreviewState,
} from '../../protocol/message-types.js'
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
  private readonly previewStatesByScope = new Map<string, StreamPreviewState>()
  private readonly animationCursorsByScope = new Map<string, StreamAnimationCursor>()
  private readonly scopeOrderByKey = new Map<string, number>()

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
    if (!this.shouldProceed() || !this.shouldProcessStreamEvent(event)) {
      return
    }

    const scopeKey = event.scope.scopeKey
    const currentPreview = this.previewStatesByScope.get(scopeKey) ?? null
    const nextPreview = reduceStreamPreviewEvent(currentPreview, event)
    this.previewStatesByScope.set(scopeKey, nextPreview)
    if (!this.scopeOrderByKey.has(scopeKey)) {
      this.scopeOrderByKey.set(scopeKey, event.sequence)
    }
    if (!this.animationCursorsByScope.has(scopeKey)) {
      this.animationCursorsByScope.set(scopeKey, createStreamAnimationCursor(nextPreview))
    }

    const { visibleText } = this.rebuildDerivedPreviewState()
    if (!this.text.accumulatedText.trim() && visibleText.trim()) {
      this.text.accumulatedText = visibleText.trim()
    }

    await this.ensureCardCreated()
    if (!this.shouldProceed()) return
    if (visibleText.trim() || this.thinkingText.trim() || this.toolCalls.size > 0) {
      this.advanceAnimation()
      await this.throttledCardUpdate()
    }
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
    if (!this.text.lastFlushedText.trim() || this.previewStatesByScope.size === 0) {
      await this.throttledCardUpdate()
    }
  }

  markFullyComplete(): void {
    this.dispatchFullyComplete = true
  }

  async onIdle(): Promise<boolean> {
    if (!this.dispatchFullyComplete || LARK_TERMINAL_PHASES.has(this.phase)) {
      return false
    }

    this.transition(LARK_STREAMING_PHASES.completed, 'normal')
    await this.prepareForTerminalUpdate()
    if (!this.card.cardMessageId) {
      return false
    }

    const finalText = this.text.completedText || this.text.accumulatedText || LARK_EMPTY_REPLY_FALLBACK_TEXT
    const footer = await this.deps.getFooterMetrics()
    const finalCard = (footer ? await this.deps.buildFinalCard?.(footer) : null)
      ?? this.deps.buildCard({
        answerText: finalText,
        thinkingText: this.thinkingText || undefined,
        toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
        footer: footer ?? undefined,
        isFinal: true,
        ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
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
    const finalCard = (footer ? await this.deps.buildFinalCard?.(footer) : null)
      ?? this.deps.buildCard({
        answerText: finalText,
        thinkingText: this.thinkingText || undefined,
        toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
        footer: footer ?? undefined,
        isFinal: true,
        ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
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
    const finalCard = (footer ? await this.deps.buildFinalCard?.(footer) : null)
      ?? this.deps.buildCard({
        answerText: finalText,
        thinkingText: this.thinkingText || undefined,
        toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
        footer: footer ?? undefined,
        isFinal: true,
        ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
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
    const seededAnswerText = this.text.accumulatedText.trim()
      ? this.text.accumulatedText
      : 'Processing...'
    const initialCard = this.deps.buildCard({
      answerText: seededAnswerText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: this.toolCalls.size > 0 ? [...this.toolCalls] : undefined,
      isFinal: false,
      ...(this.renderedPreview ? { preview: this.renderedPreview } : {}),
    })

    this.cardCreationPromise = (async () => {
      try {
        await this.appendRequested(initialCard, seededAnswerText || 'interactive-card')
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
      } catch (error) {
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
      const orderedPreviews = this.getOrderedPreviews()
      if (orderedPreviews.length === 0) return

      let done = true
      let hasActivePreview = false
      for (const [scopeKey, preview] of orderedPreviews) {
        const currentCursor = this.animationCursorsByScope.get(scopeKey) ?? null
        const advanced = advanceStreamAnimationCursor(currentCursor, preview)
        this.animationCursorsByScope.set(scopeKey, advanced.cursor)
        done = done && advanced.done
        hasActivePreview = hasActivePreview || preview.active
      }

      this.text.animationDone = done
      this.rebuildDerivedPreviewState()
      const renderedText = (this.renderedPreview?.blocks ?? [])
        .map((block) => {
          if (block.kind === 'text') return block.shownText
          if (block.kind === 'tool_use') return block.name ? `[Tool call] ${block.name}` : ''
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
      this.text.accumulatedText = done || !hasActivePreview
        ? renderedText
        : `${renderedText || ''} ▎`.trim()
      void this.throttledCardUpdate()

      if (done && !hasActivePreview && this.animationTimer) {
        clearInterval(this.animationTimer)
        this.animationTimer = null
      }
    }

    step()
    if (this.getOrderedPreviews().some(([, preview]) => preview.active) && !this.animationTimer) {
      this.animationTimer = setInterval(step, 50)
    }
  }

  private getOrderedPreviews(): Array<[string, StreamPreviewState]> {
    return [...this.previewStatesByScope.entries()]
      .sort(([leftKey], [rightKey]) => {
        const leftOrder = this.scopeOrderByKey.get(leftKey) ?? Number.MAX_SAFE_INTEGER
        const rightOrder = this.scopeOrderByKey.get(rightKey) ?? Number.MAX_SAFE_INTEGER
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
        return leftKey.localeCompare(rightKey)
      })
  }

  private rebuildDerivedPreviewState(): { visibleText: string } {
    const orderedPreviews = this.getOrderedPreviews()
    if (orderedPreviews.length === 0) {
      this.renderedPreview = null
      this.thinkingText = ''
      this.toolCalls.clear()
      return { visibleText: '' }
    }

    let nextIndexOffset = 0
    const mergedBlocks: StreamPreviewState['blocks'] = []
    const mergedRenderedBlocks: StreamRenderedPreviewState['blocks'] = []

    for (const [scopeKey, preview] of orderedPreviews) {
      const cursor = this.animationCursorsByScope.get(scopeKey) ?? createStreamAnimationCursor(preview)
      this.animationCursorsByScope.set(scopeKey, cursor)
      const renderedPreview = renderStreamPreviewState(preview, cursor)
      const maxLocalIndex = preview.blocks.reduce((max, block) => Math.max(max, block.index), -1)

      for (const block of preview.blocks) {
        const mergedIndex = nextIndexOffset + block.index
        if (block.kind === 'text') {
          mergedBlocks.push({ ...block, index: mergedIndex })
        } else if (block.kind === 'thinking') {
          mergedBlocks.push({ ...block, index: mergedIndex })
        } else {
          mergedBlocks.push({ ...block, index: mergedIndex })
        }
      }

      for (const block of renderedPreview.blocks) {
        const mergedIndex = nextIndexOffset + block.index
        if (block.kind === 'text') {
          mergedRenderedBlocks.push({ ...block, index: mergedIndex })
        } else if (block.kind === 'thinking') {
          mergedRenderedBlocks.push({ ...block, index: mergedIndex })
        } else {
          mergedRenderedBlocks.push({ ...block, index: mergedIndex })
        }
      }

      nextIndexOffset += Math.max(1, maxLocalIndex + 1)
      if (!preview.active) {
        this.animationCursorsByScope.set(scopeKey, createStreamAnimationCursor(preview))
      }
    }

    const latestPreview = orderedPreviews[orderedPreviews.length - 1][1]
    const activePreview = [...orderedPreviews].reverse().find(([, preview]) => preview.active)?.[1] ?? latestPreview
    const mergedPreview: StreamPreviewState = {
      scope: activePreview.scope,
      phase: activePreview.phase,
      status: activePreview.status,
      active: orderedPreviews.some(([, preview]) => preview.active),
      blocks: mergedBlocks,
      receivedAt: latestPreview.receivedAt,
      sequence: latestPreview.sequence,
    }

    this.renderedPreview = {
      scope: activePreview.scope,
      phase: activePreview.phase,
      status: activePreview.status,
      active: mergedPreview.active,
      blocks: mergedRenderedBlocks,
    }

    const thinkingBlocks = mergedPreview.blocks.filter(
      (block): block is Extract<typeof mergedPreview.blocks[number], { kind: 'thinking' }> => block.kind === 'thinking' && !block.redacted,
    )
    this.thinkingText = thinkingBlocks.map((block) => block.text.trim()).filter(Boolean).join('\n\n')

    this.toolCalls.clear()
    for (const block of mergedPreview.blocks) {
      if (block.kind === 'tool_use') {
        this.toolCalls.add(`[Tool call] ${block.name}`)
      }
    }

    return { visibleText: renderStreamPreviewText(mergedPreview) }
  }

  private async performFlush(): Promise<void> {
    if (!this.card.cardMessageId || LARK_TERMINAL_PHASES.has(this.phase)) {
      return
    }
    const signature = this.renderedPreview ? JSON.stringify(this.renderedPreview) : this.text.accumulatedText.trim()
    if (!signature) {
      return
    }

    if (this.card.cardKitCardId) {
      if (signature === this.text.lastFlushedText) {
        return
      }
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
      // updateSequence must be < closeSequence: we update the final content first
      // (while streaming_mode=true), then close streaming_mode. See service.finalizeCardKit.
      const updateSequence = this.nextSequence()
      const closeSequence = this.nextSequence()
      const result = await this.deps.finalizeCardKit(effectiveCardId, closeSequence, updateSequence, card)
      return result
    }

    return { delivered: false, error: 'No message to finalize' }
  }

  private async appendRequested(card: Record<string, unknown>, summary: string): Promise<void> {
    await this.deps.appendLog({
      eventName: 'message.requested',
      payloadSummary: summary,
      payload: card,
    })
  }
}
