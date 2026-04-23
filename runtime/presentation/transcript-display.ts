import type {
  AssistantDisplayItem,
  DisplayAssistantFooter,
  DisplayFragment,
  DisplayItem,
  SessionMessage,
  TranscriptAtom,
  TranscriptLinkage,
  TranscriptLookup,
  UserDisplayItem,
} from '../protocol/message-types.js'
import {
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptMessageId,
  getTranscriptSemanticKind,
  getTranscriptStopReason,
  getTranscriptToolResultIds,
  getTranscriptToolUseIds,
  hasRenderableTranscriptContent,
  isTranscriptMetaMessage,
  isTranscriptRedactedThinkingMessage,
  type TranscriptAssistantUsage,
  type TranscriptMessage,
} from '../protocol/transcript-normalizer.js'

export interface BuildDisplayItemsOptions {
  mode?: 'default' | 'transcript'
  includeHiddenAtoms?: boolean
}

export interface BuildTranscriptAtomOptions {
  source: 'history' | 'live'
  sourceIndex: number
  timestamp?: number
  sequence?: number
  optimistic?: boolean
  localId?: string
}

function makeAtomId(message: TranscriptMessage, options: BuildTranscriptAtomOptions): string {
  return getTranscriptMessageId(message)
    ?? (options.localId && options.localId.trim())
    ?? `${options.source}-${options.sequence ?? 'noseq'}-${options.sourceIndex}`
}

function getLinkage(message: TranscriptMessage): TranscriptLinkage {
  return {
    messageId: getTranscriptMessageId(message),
    toolUseIds: getTranscriptToolUseIds(message),
    toolResultForIds: getTranscriptToolResultIds(message),
  }
}

function getFooterSourceMessage(messages: SessionMessage[]): SessionMessage | undefined {
  return [...messages].reverse().find((message) => {
    const stopReason = getTranscriptStopReason(message)
    const usage = getTranscriptAssistantUsage(message)
    const model = getTranscriptAssistantModel(message)
    return Boolean(stopReason) || Boolean(usage) || Boolean(model)
  }) ?? messages[messages.length - 1] ?? messages[0]
}

function sumAssistantUsage(messages: SessionMessage[]): TranscriptAssistantUsage | null {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let hasAny = false

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const usage = getTranscriptAssistantUsage(message)
    if (!usage) continue
    if (typeof usage.inputTokens === 'number') {
      inputTokens += usage.inputTokens
      hasAny = true
    }
    if (typeof usage.outputTokens === 'number') {
      outputTokens += usage.outputTokens
      hasAny = true
    }
    if (typeof usage.cacheReadTokens === 'number') {
      cacheReadTokens += usage.cacheReadTokens
      hasAny = true
    }
    if (typeof usage.cacheWriteTokens === 'number') {
      cacheWriteTokens += usage.cacheWriteTokens
      hasAny = true
    }
  }

  if (!hasAny) return null
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

export function getAssistantFooter(messages: SessionMessage[]): DisplayAssistantFooter | undefined {
  const source = getFooterSourceMessage(messages)
  if (!source) return undefined

  const stopReason = source ? getTranscriptStopReason(source) : null
  const model = source ? getTranscriptAssistantModel(source) : null
  const usage = sumAssistantUsage(messages)
  return {
    stopReason,
    model,
    usage,
  }
}

function withFooterTiming<T extends { footer?: DisplayAssistantFooter; messages: SessionMessage[] }>(
  item: T,
  promptTimestamp: number | null,
): T {
  if (!item.footer) {
    return item
  }
  const source = getFooterSourceMessage(item.messages)
  const completedAt = typeof source?.timestamp === 'number' ? source.timestamp : null
  const deltaMs = (
    typeof completedAt === 'number'
    && typeof promptTimestamp === 'number'
  )
    ? Math.max(0, completedAt - promptTimestamp)
    : null
  return {
    ...item,
    footer: {
      ...item.footer,
      completedAt,
      deltaMs,
    },
  }
}

export function buildTranscriptAtom(message: SessionMessage, options: BuildTranscriptAtomOptions): TranscriptAtom {
  const timestamp = typeof options.timestamp === 'number'
    ? options.timestamp
    : typeof message.timestamp === 'number'
      ? message.timestamp
      : Date.now()

  const semanticKind = getTranscriptSemanticKind(message)
  const role: TranscriptAtom['role'] = message.role

  return {
    id: makeAtomId(message, options),
    source: options.source,
    order: {
      timestamp,
      ...(typeof options.sequence === 'number' ? { sequence: options.sequence } : {}),
      sourceIndex: options.sourceIndex,
    },
    message,
    role,
    semanticKind,
    linkage: getLinkage(message),
    assistant: {
      stopReason: getTranscriptStopReason(message),
      model: getTranscriptAssistantModel(message),
      usage: getTranscriptAssistantUsage(message),
    },
    meta: {
      ...(options.optimistic ? { optimistic: true } : {}),
      ...(options.localId ? { localId: options.localId } : {}),
      raw: message.raw,
    },
  }
}

function compareAtoms(left: TranscriptAtom, right: TranscriptAtom): number {
  if (left.order.timestamp !== right.order.timestamp) return left.order.timestamp - right.order.timestamp
  if (left.order.sequence !== undefined && right.order.sequence !== undefined && left.order.sequence !== right.order.sequence) {
    return left.order.sequence - right.order.sequence
  }
  return left.order.sourceIndex - right.order.sourceIndex
}

function getToolResultDisplayMeta(output: unknown, attachedToParent = false) {
  const text = stringifyStructuredContent(output)
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const lineCount = normalized ? normalized.split('\n').length : 0
  const charCount = normalized.length
  const previewLines = normalized.split('\n').slice(0, 3).join('\n').trim()
  const previewText = previewLines || normalized.slice(0, 160)
  const expandedLineThreshold = attachedToParent ? 10 : 8
  const expandedCharThreshold = attachedToParent ? 400 : 320
  const hasStructuredShape = normalized.includes('```') || normalized.includes('{\n') || normalized.includes('[\n')
  const defaultExpanded = lineCount < 4 && charCount < 140
    ? true
    : !(lineCount > expandedLineThreshold || charCount > expandedCharThreshold || hasStructuredShape)

  return {
    previewText,
    lineCount,
    charCount,
    defaultExpanded,
  }
}

function stringifyStructuredContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(stringifyStructuredContent).filter(Boolean).join('\n').trim()
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function createFragments(
  atom: TranscriptAtom,
  options: { mode: 'default' | 'transcript'; attachToolResultsToParent?: boolean } = { mode: 'default' },
): DisplayFragment[] {
  const message = atom.message
  const fragments: DisplayFragment[] = []

  for (const block of message.blocks || []) {
    if (block.type === 'text' && block.text) {
      fragments.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'thinking') {
      if (isTranscriptRedactedThinkingMessage(message)) {
        continue
      }
      if (!block.text?.trim()) {
        continue
      }
      fragments.push({
        type: 'thinking',
        text: block.text,
        redacted: false,
        defaultHidden: false,
      })
      continue
    }

    if (block.type === 'tool_use') {
      fragments.push({
        type: 'tool_use',
        name: block.name || 'unknown_tool',
        toolUseId: block.toolUseId,
        input: block.input,
      })
      continue
    }

    if (block.type === 'tool_result') {
      const attachedToParent = options.attachToolResultsToParent ?? false
      const display = getToolResultDisplayMeta(block.output, attachedToParent)
      fragments.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        output: block.output,
        raw: message.raw ?? block.raw,
        attachedToParent,
        defaultCollapsed: options.mode !== 'transcript' && !display.defaultExpanded,
        display,
      })
    }
  }

  if (fragments.length === 0) {
    if (isTranscriptRedactedThinkingMessage(message)) {
      return fragments
    }
    if (message.blocks?.length && !hasRenderableTranscriptContent(message.blocks)) {
      return fragments
    }
  }

  if (fragments.length === 0 && message.content) {
    fragments.push({ type: 'text', text: message.content })
  }

  return fragments
}

function getUserDisplayKind(message: SessionMessage): UserDisplayItem['displayKind'] {
  const content = message.content.trim()
  if (/^<(command|bash)-[^>]+>/.test(content)) {
    return 'command_input'
  }
  if (/^<(local-command|bash)-(stdout|stderr)>/.test(content)) {
    return 'command_output'
  }
  return 'default'
}

function createUserDisplayItem(atom: TranscriptAtom): UserDisplayItem {
  return {
    kind: 'user',
    id: atom.id,
    key: atom.id,
    timestamp: atom.order.timestamp,
    atomIds: [atom.id],
    message: atom.message,
    displayKind: getUserDisplayKind(atom.message),
  }
}

function makeHistoryItemId(message: SessionMessage, index: number): string {
  return getTranscriptMessageId(message) ?? `history-item-${index}`
}

function buildHistoryAtom(message: SessionMessage, index: number): TranscriptAtom {
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
  return {
    id: makeHistoryItemId(message, index),
    source: 'history',
    order: {
      timestamp,
      sourceIndex: index,
    },
    message,
    role: message.role,
    semanticKind: getTranscriptSemanticKind(message),
    linkage: getLinkage(message),
    assistant: {
      stopReason: getTranscriptStopReason(message),
      model: getTranscriptAssistantModel(message),
      usage: getTranscriptAssistantUsage(message),
    },
    meta: {
      raw: message.raw,
    },
  }
}

function buildHistoryAtoms(messages: SessionMessage[]): TranscriptAtom[] {
  return messages.map((message, index) => buildHistoryAtom(message, index))
}

function createAssistantDisplayItem(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
): AssistantDisplayItem {
  const anchorAtom = atoms[atoms.length - 1] ?? atoms[0]!
  const anchor = anchorAtom.message
  const atomIds = atoms.map((atom) => atom.id)
  const fragments: DisplayFragment[] = []

  const orderedAtoms = atoms.slice().sort((left, right) => left.order.sourceIndex - right.order.sourceIndex)

  for (const atom of orderedAtoms) {
    fragments.push(...createFragments(atom, { mode }))
  }

  return {
    kind: 'assistant',
    id: atoms[0]!.id,
    key: atoms[0]!.id,
    timestamp: anchorAtom.order.timestamp,
    atomIds,
    messages: atoms.map((atom) => atom.message),
    anchorMessage: anchor,
    fragments,
    footer: getAssistantFooter(atoms.map((atom) => atom.message)),
  }
}

export function buildTranscriptLookups(atoms: TranscriptAtom[]): TranscriptLookup {
  const toolUseAtomsByToolUseId = new Map<string, TranscriptAtom>()
  const toolResultAtomsByToolUseId = new Map<string, TranscriptAtom>()
  const atomsByMessageId = new Map<string, TranscriptAtom[]>()
  const siblingToolUseIdsByToolUseId = new Map<string, string[]>()
  const resolvedToolUseIds = new Set<string>()

  for (const atom of atoms) {
    if (atom.linkage.messageId) {
      atomsByMessageId.set(atom.linkage.messageId, [...(atomsByMessageId.get(atom.linkage.messageId) || []), atom])
    }

    for (const toolUseId of atom.linkage.toolUseIds) {
      toolUseAtomsByToolUseId.set(toolUseId, atom)
    }

    if (atom.linkage.toolUseIds.length > 1) {
      for (const toolUseId of atom.linkage.toolUseIds) {
        siblingToolUseIdsByToolUseId.set(
          toolUseId,
          atom.linkage.toolUseIds.filter((candidate) => candidate !== toolUseId),
        )
      }
    }

    for (const toolUseId of atom.linkage.toolResultForIds) {
      toolResultAtomsByToolUseId.set(toolUseId, atom)
      resolvedToolUseIds.add(toolUseId)
    }
  }

  return {
    toolUseAtomsByToolUseId,
    toolResultAtomsByToolUseId,
    atomsByMessageId,
    siblingToolUseIdsByToolUseId,
    resolvedToolUseIds,
  }
}

function shouldHideMetaMessage(message: TranscriptMessage, mode: 'default' | 'transcript'): boolean {
  return mode !== 'transcript' && isTranscriptMetaMessage(message)
}

function shouldHideSummaryMessage(_message: TranscriptMessage, _mode: 'default' | 'transcript'): boolean {
  return false
}

function shouldHideThinkingMessage(message: TranscriptMessage, mode: 'default' | 'transcript'): boolean {
  return mode !== 'transcript' && isTranscriptRedactedThinkingMessage(message)
}

function shouldHideMessage(message: TranscriptMessage, mode: 'default' | 'transcript'): boolean {
  return shouldHideMetaMessage(message, mode)
    || shouldHideSummaryMessage(message, mode)
    || shouldHideThinkingMessage(message, mode)
}

function shouldOmitFromAssembly(message: TranscriptMessage, mode: 'default' | 'transcript'): boolean {
  return shouldHideMetaMessage(message, mode)
    || shouldHideSummaryMessage(message, mode)
}

function orderAtomsForAssembly(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): TranscriptAtom[] {
  const mode = options.mode ?? 'default'
  return atoms
    .slice()
    .sort(compareAtoms)
    .filter((atom) => !shouldOmitFromAssembly(atom.message, mode))
}

export function orderAtomsForTimeline(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): TranscriptAtom[] {
  const mode = options.mode ?? 'default'
  return atoms
    .slice()
    .sort(compareAtoms)
    .filter((atom) => options.includeHiddenAtoms || !shouldHideMessage(atom.message, mode))
}

function isBridgeMessage(atom: TranscriptAtom): boolean {
  if (atom.role === 'assistant') return true

  if (atom.role === 'user') {
    const hasToolResult = atom.message.blocks?.some((block) => block.type === 'tool_result')
    if (hasToolResult) return true

    const content = atom.message.content.trim()
    return content.includes('<local-command-stdout>')
      || content.includes('<local-command-stderr>')
      || content.includes('<bash-stdout>')
      || content.includes('<bash-stderr>')
      || content.includes('<tool_result>')
  }

  const raw = atom.message.raw
  if (raw && typeof raw === 'object') {
    const type = typeof (raw as Record<string, unknown>).type === 'string'
      ? (raw as Record<string, unknown>).type as string
      : null
    return type === 'system' || type === 'file-history-snapshot' || type === 'progress' || type === 'queue-operation' || type === 'last-prompt'
  }

  return false
}

function isPrimaryUserTurnAtom(atom: TranscriptAtom): boolean {
  return atom.role === 'user' && !isBridgeMessage(atom)
}

function buildPrimaryDisplayItems(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
): DisplayItem[] {
  const items: DisplayItem[] = []
  let lastUserPromptTimestamp: number | null = null

  let pendingTurnAtoms: TranscriptAtom[] = []

  const flushPendingTurn = () => {
    const visibleAtoms = pendingTurnAtoms
    pendingTurnAtoms = []
    if (!visibleAtoms.length) return

    const item = createAssistantDisplayItem(visibleAtoms, mode)
    if (item.fragments.length > 0 || item.overlays?.length) {
      const timed: AssistantDisplayItem = withFooterTiming(item, lastUserPromptTimestamp)
      items.push(timed)
    }
  }

  for (const atom of atoms) {
    if (isPrimaryUserTurnAtom(atom)) {
      flushPendingTurn()
      const item = createUserDisplayItem(atom)
      items.push(item)
      lastUserPromptTimestamp = item.timestamp
      continue
    }

    pendingTurnAtoms.push(atom)
  }

  flushPendingTurn()

  return items
}

function applyDisplayPoliciesAndTransforms(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
): DisplayItem[] {
  return buildPrimaryDisplayItems(atoms, mode)
}

export function buildDisplayItems(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): DisplayItem[] {
  const mode = options.mode ?? 'default'
  const orderedAtoms = orderAtomsForAssembly(atoms, { mode, includeHiddenAtoms: options.includeHiddenAtoms })
  return applyDisplayPoliciesAndTransforms(orderedAtoms, mode)
}

export function buildHistoryDisplayItems(messages: SessionMessage[], options: BuildDisplayItemsOptions = {}): DisplayItem[] {
  const atoms = buildHistoryAtoms(messages)
  const items = buildDisplayItems(atoms, options)
  // Disable low-signal collapsing: always return the fully expanded items so the UI can
  // decide how to present details per-turn.
  return items
}

export function getLatestAssistantHistoryFooter(messages: SessionMessage[]): DisplayAssistantFooter | undefined {
  const items = buildHistoryDisplayItems(messages, { mode: 'default', includeHiddenAtoms: false })
  const assistants = items.filter((item): item is AssistantDisplayItem => item.kind === 'assistant')
  return assistants[assistants.length - 1]?.footer
}
