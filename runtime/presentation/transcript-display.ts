import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  DisplayAssistantFooter,
  DisplayFragment,
  DisplayItem,
  GroupedToolUseDisplayItem,
  SessionMessage,
  SummaryDisplayItem,
  TranscriptAtom,
  TranscriptLinkage,
  TranscriptLookup,
  UserDisplayItem,
} from '../protocol/message-types.js'
import {
  extractStructuredContentFromBlocks,
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptMessageId,
  getTranscriptRawMessage,
  getTranscriptResponseId,
  getTranscriptSemanticKind,
  getTranscriptStopReason,
  getTranscriptToolResultIds,
  getTranscriptToolUseIds,
  hasRenderableTranscriptContent,
  isTranscriptMetaMessage,
  isTranscriptRedactedThinkingMessage,
  isTranscriptSummaryMessage,
  type TranscriptBlock,
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

export function getAssistantFooter(messages: SessionMessage[], executionDurationMs?: number | null): DisplayAssistantFooter | undefined {
  const source = [...messages].reverse().find((message) => {
    const stopReason = getTranscriptStopReason(message)
    const usage = getTranscriptAssistantUsage(message)
    const model = getTranscriptAssistantModel(message)
    return Boolean(stopReason) || Boolean(usage) || Boolean(model)
  }) ?? messages[messages.length - 1] ?? messages[0]

  if (!source && executionDurationMs == null) return undefined

  const stopReason = source ? getTranscriptStopReason(source) : null
  const model = source ? getTranscriptAssistantModel(source) : null
  const usage = source ? getTranscriptAssistantUsage(source) : null
  return {
    stopReason,
    model,
    usage,
    executionDurationMs: executionDurationMs ?? null,
  }
}

function withFooterTiming<T extends { footer?: DisplayAssistantFooter; timestamp: number }>(item: T, previousTimestamp?: number | null): T {
  if (!item.footer) {
    return item
  }
  return {
    ...item,
    footer: {
      ...item.footer,
      completedAt: item.timestamp,
      deltaMs: typeof previousTimestamp === 'number' ? Math.max(0, item.timestamp - previousTimestamp) : null,
    },
  }
}

export function buildTranscriptAtom(message: SessionMessage, options: BuildTranscriptAtomOptions): TranscriptAtom {
  const timestamp = typeof options.timestamp === 'number'
    ? options.timestamp
    : typeof message.timestamp === 'number'
      ? message.timestamp
      : Date.now()

  return {
    id: makeAtomId(message, options),
    source: options.source,
    order: {
      timestamp,
      ...(typeof options.sequence === 'number' ? { sequence: options.sequence } : {}),
      sourceIndex: options.sourceIndex,
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

function isReadSearchLikeTool(name?: string): { isSearch: boolean; isRead: boolean; isList: boolean; isBash: boolean } {
  const normalized = (name || '').toLowerCase()
  return {
    isSearch: normalized === 'grep' || normalized === 'glob' || normalized.includes('search'),
    isRead: normalized === 'read' || normalized.includes('read'),
    isList: normalized === 'ls' || normalized.includes('list'),
    isBash: normalized === 'bash',
  }
}

function isLowSignalToolName(name?: string): boolean {
  const toolInfo = isReadSearchLikeTool(name)
  return toolInfo.isRead || toolInfo.isSearch || toolInfo.isList || toolInfo.isBash
}

function getToolUseBlocks(atom: TranscriptAtom): TranscriptBlock[] {
  return (atom.message.blocks || []).filter((block) => block.type === 'tool_use')
}

function getToolUseNames(atom: TranscriptAtom): string[] {
  return getToolUseBlocks(atom).map((block) => block.name || 'unknown_tool')
}

function getAtomGroupingScope(atom: TranscriptAtom): string {
  const raw = atom.message.raw
  const parentToolUseId = raw && typeof raw === 'object' && 'parent_tool_use_id' in raw && typeof (raw as Record<string, unknown>).parent_tool_use_id === 'string'
    ? (raw as Record<string, unknown>).parent_tool_use_id as string
    : null

  return parentToolUseId
    ?? atom.linkage.messageId
    ?? `${atom.source}:${atom.order.sequence ?? 'noseq'}:${atom.order.sourceIndex}`
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
  const structured = extractStructuredContentFromBlocks(message.blocks || [])
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

  if (isTranscriptSummaryMessage(message) && structured.answerText) {
    fragments.push({
      type: 'summary',
      text: structured.answerText,
      defaultCollapsed: options.mode !== 'transcript',
    })
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

function createSummaryDisplayItem(atom: TranscriptAtom, mode: 'default' | 'transcript'): SummaryDisplayItem {
  return {
    kind: 'summary',
    id: atom.id,
    key: atom.id,
    timestamp: atom.order.timestamp,
    atomIds: [atom.id],
    content: atom.message.content,
    summaryType: 'compact',
    defaultCollapsed: mode !== 'transcript',
    anchorMessage: atom.message,
  }
}

function createAssistantDisplayItem(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
  attachedToolResultAtoms: TranscriptAtom[] = [],
): AssistantDisplayItem {
  const anchorAtom = atoms[atoms.length - 1] ?? atoms[0]!
  const anchor = anchorAtom.message
  const atomIds = atoms.map((atom) => atom.id)
  const fragments: DisplayFragment[] = []

  const orderedAtoms = atoms.slice().sort((left, right) => {
    const leftThinking = left.semanticKind === 'thinking' || isTranscriptRedactedThinkingMessage(left.message)
    const rightThinking = right.semanticKind === 'thinking' || isTranscriptRedactedThinkingMessage(right.message)
    if (leftThinking !== rightThinking) return leftThinking ? -1 : 1
    return left.order.sourceIndex - right.order.sourceIndex
  })

  for (const atom of orderedAtoms) {
    fragments.push(...createFragments(atom, { mode }))
  }
  for (const atom of attachedToolResultAtoms) {
    atomIds.push(atom.id)
    fragments.push(...createFragments(atom, { mode, attachToolResultsToParent: true }))
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

function createGroupedToolUseDisplayItem(
  group: TranscriptAtom[],
  lookups: TranscriptLookup,
): GroupedToolUseDisplayItem {
  const first = group[0]!
  const toolUses = group.flatMap((atom) =>
    getToolUseBlocks(atom).map((block) => {
      const result = typeof block.toolUseId === 'string'
        ? lookups.toolResultAtomsByToolUseId.get(block.toolUseId)?.message.blocks?.find((item) => item.type === 'tool_result')?.output
        : undefined

      return {
        toolUseId: block.toolUseId,
        name: block.name || 'unknown_tool',
        input: block.input,
        result,
        resultDisplay: result !== undefined ? getToolResultDisplayMeta(result, true) : undefined,
      }
    })
  )

  const status = toolUses.every((tool) => !tool.toolUseId || lookups.resolvedToolUseIds.has(tool.toolUseId))
    ? 'completed'
    : 'streaming'

  return {
    kind: 'grouped_tool_use',
    id: `grouped-${first.id}`,
    key: `grouped-${first.id}`,
    timestamp: first.order.timestamp,
    atomIds: group.map((atom) => atom.id),
    toolName: toolUses[0]?.name || 'unknown_tool',
    toolUses,
    anchorMessage: first.message,
    footer: getAssistantFooter(group.map((atom) => atom.message)),
    status,
  }
}

function createCollapsedToolBatchDisplayItem(
  items: Array<AssistantDisplayItem | GroupedToolUseDisplayItem>,
): CollapsedToolBatchDisplayItem {
  const first = items[0]!
  const summary = {
    readCount: 0,
    searchCount: 0,
    listCount: 0,
    bashCount: 0,
    latestHint: '',
  }

  for (const item of items) {
    if (item.kind === 'grouped_tool_use') {
      for (const tool of item.toolUses) {
        const toolInfo = isReadSearchLikeTool(tool.name)
        if (toolInfo.isRead) summary.readCount += 1
        if (toolInfo.isSearch) summary.searchCount += 1
        if (toolInfo.isList) summary.listCount += 1
        if (toolInfo.isBash) summary.bashCount += 1
        summary.latestHint = tool.name
      }
      continue
    }

    for (const fragment of item.fragments) {
      if (fragment.type !== 'tool_use') continue
      const toolInfo = isReadSearchLikeTool(fragment.name)
      if (toolInfo.isRead) summary.readCount += 1
      if (toolInfo.isSearch) summary.searchCount += 1
      if (toolInfo.isList) summary.listCount += 1
      if (toolInfo.isBash) summary.bashCount += 1
      summary.latestHint = fragment.name
    }
  }

  const status = items.some((item) => item.kind === 'grouped_tool_use' && item.status !== 'completed')
    ? 'streaming'
    : 'completed'

  return {
    kind: 'collapsed_tool_batch',
    id: `collapsed-${first.id}`,
    key: `collapsed-${first.id}`,
    timestamp: first.timestamp,
    atomIds: items.flatMap((item) => item.atomIds),
    batchKind: 'read_search',
    summary,
    items,
    anchorMessage: first.anchorMessage,
    footer: getAssistantFooter(items.flatMap((item) => item.kind === 'grouped_tool_use' ? [item.anchorMessage] : item.messages)),
    status,
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

function shouldHideSummaryMessage(message: TranscriptMessage, mode: 'default' | 'transcript'): boolean {
  return mode !== 'transcript' && isTranscriptSummaryMessage(message)
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

function deriveAttachedToolResultPolicy(atoms: TranscriptAtom[], lookups: TranscriptLookup): {
  attachedResultAtomsByOwnerId: Map<string, TranscriptAtom[]>
  attachedResultAtomIds: Set<string>
} {
  const attachedResultAtomsByOwnerId = new Map<string, TranscriptAtom[]>()
  const attachedResultAtomIds = new Set<string>()

  for (const atom of atoms) {
    if (!atom.linkage.toolUseIds.length) continue

    const attached = atom.linkage.toolUseIds.flatMap((toolUseId) => {
      const resultAtom = lookups.toolResultAtomsByToolUseId.get(toolUseId)
      return resultAtom ? [resultAtom] : []
    })

    if (!attached.length) continue

    attachedResultAtomsByOwnerId.set(atom.id, attached)
    for (const resultAtom of attached) {
      attachedResultAtomIds.add(resultAtom.id)
    }
  }

  return {
    attachedResultAtomsByOwnerId,
    attachedResultAtomIds,
  }
}

function isAssistantResponseFragmentAtom(atom: TranscriptAtom): boolean {
  if (atom.role !== 'assistant') return false
  if (atom.semanticKind !== 'assistant' && atom.semanticKind !== 'thinking') return false
  if (atom.linkage.toolUseIds.length > 0) return false
  if (atom.linkage.toolResultForIds.length > 0) return false
  return true
}

function canMergeAssistantSiblingAtoms(group: TranscriptAtom[], candidate: TranscriptAtom): boolean {
  const first = group[0]
  if (!first) return false
  if (!isAssistantResponseFragmentAtom(first) || !isAssistantResponseFragmentAtom(candidate)) return false

  const firstResponseId = getTranscriptResponseId(first.message)
  const candidateResponseId = getTranscriptResponseId(candidate.message)
  if (!firstResponseId || !candidateResponseId) return false
  if (firstResponseId !== candidateResponseId) return false

  return getTranscriptStopReason(first.message) == null && getTranscriptStopReason(candidate.message) == null
}

function canGroupToolUseAtoms(group: TranscriptAtom[], candidate: TranscriptAtom): boolean {
  const first = group[0]
  if (!first) return false
  if (candidate.role !== 'assistant' || candidate.semanticKind === 'tool_result') return false

  const firstToolNames = getToolUseNames(first)
  const candidateToolNames = getToolUseNames(candidate)
  if (!firstToolNames.length || !candidateToolNames.length) return false
  if (new Set(firstToolNames).size !== 1 || new Set(candidateToolNames).size !== 1) return false
  if (firstToolNames[0] !== candidateToolNames[0]) return false
  if (getAtomGroupingScope(first) !== getAtomGroupingScope(candidate)) return false

  return true
}

function isAssistantResponseScopedAtom(atom: TranscriptAtom): boolean {
  return atom.role === 'assistant'
}

function isThinkingLikeAtom(atom: TranscriptAtom): boolean {
  return atom.semanticKind === 'thinking' || isTranscriptRedactedThinkingMessage(atom.message)
}

function comparableAssistantMessageWithoutContent(message: SessionMessage): string | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  const comparable = { ...rawMessage }
  delete comparable.content
  return JSON.stringify(comparable)
}

function canKeepTerminalAssistantSiblingsTogether(left: TranscriptAtom, right: TranscriptAtom): boolean {
  if (left.role !== 'assistant' || right.role !== 'assistant') return false

  const leftResponseId = getTranscriptResponseId(left.message)
  const rightResponseId = getTranscriptResponseId(right.message)
  if (!leftResponseId || !rightResponseId || leftResponseId !== rightResponseId) return false
  if (!isThinkingLikeAtom(left) && !isThinkingLikeAtom(right)) return false

  const leftComparable = comparableAssistantMessageWithoutContent(left.message)
  const rightComparable = comparableAssistantMessageWithoutContent(right.message)
  if (!leftComparable || !rightComparable) return false

  return leftComparable === rightComparable
}

function isTerminalBoundaryMessage(atom: TranscriptAtom): boolean {
  if (atom.role !== 'assistant') return false
  return getTranscriptStopReason(atom.message) != null
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

function isTailBridgeMessage(atom: TranscriptAtom): boolean {
  if (atom.role === 'assistant') return false
  const raw = atom.message.raw
  if (raw && typeof raw === 'object') {
    const type = typeof (raw as Record<string, unknown>).type === 'string'
      ? (raw as Record<string, unknown>).type as string
      : null
    return type === 'system' || type === 'file-history-snapshot' || type === 'progress' || type === 'queue-operation' || type === 'last-prompt'
  }
  return false
}

function buildAssistantResponseGroups(atoms: TranscriptAtom[]): TranscriptAtom[][] {
  const groups: TranscriptAtom[][] = []
  let index = 0

  while (index < atoms.length) {
    const atom = atoms[index]!
    const responseId = atom.role === 'assistant' ? getTranscriptResponseId(atom.message) : null

    if (!isAssistantResponseScopedAtom(atom) || !responseId) {
      groups.push([atom])
      index += 1
      continue
    }

    const group: TranscriptAtom[] = []
    let seenTerminal = false
    let currentIndex = index
    let currentResponseId = responseId

    while (currentIndex < atoms.length) {
      const current = atoms[currentIndex]!
      const nextResponseId = current.role === 'assistant' ? getTranscriptResponseId(current.message) : null

      if (seenTerminal) {
        if (current.role === 'assistant' && canKeepTerminalAssistantSiblingsTogether(group[group.length - 1]!, current)) {
          // Keep terminal assistant siblings with matching response envelope together.
        } else if (!isTailBridgeMessage(current)) {
          break
        }
      } else if (current.role === 'assistant' && nextResponseId && nextResponseId !== currentResponseId) {
        currentResponseId = nextResponseId
      } else if (currentIndex !== index && !isBridgeMessage(current)) {
        break
      }

      group.push(current)

      if (isTerminalBoundaryMessage(current)) {
        seenTerminal = true
      }

      currentIndex += 1
    }

    groups.push(group)
    index = currentIndex
  }

  return groups
}

function buildPrimaryDisplayItems(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
  lookups: TranscriptLookup,
  attachedResultAtomsByOwnerId: Map<string, TranscriptAtom[]>,
  attachedResultAtomIds: Set<string>,
): DisplayItem[] {
  const items: DisplayItem[] = []
  const responseGroups = buildAssistantResponseGroups(atoms)
  let previousVisibleTimestamp: number | null = null

  for (const group of responseGroups) {
    const atom = group[0]!

    if (attachedResultAtomIds.has(atom.id)) continue

    if (atom.semanticKind === 'summary') {
      items.push(createSummaryDisplayItem(atom, mode))
      continue
    }

    if (atom.semanticKind === 'user') {
      const item = createUserDisplayItem(atom)
      items.push(item)
      previousVisibleTimestamp = item.timestamp
      continue
    }

    if (atom.semanticKind === 'tool_result') {
      const item = createAssistantDisplayItem([atom], mode)
      if (item.fragments.length > 0) {
        const timed: AssistantDisplayItem = withFooterTiming(item, previousVisibleTimestamp)
        items.push(timed)
        previousVisibleTimestamp = timed.timestamp
      }
      continue
    }

    if (atom.role !== 'assistant') {
      const item = createAssistantDisplayItem([atom], mode)
      if (item.fragments.length > 0) {
        const timed: AssistantDisplayItem = withFooterTiming(item, previousVisibleTimestamp)
        items.push(timed)
        previousVisibleTimestamp = timed.timestamp
      }
      continue
    }

    const item = createAssistantDisplayItem(group, mode, attachedResultAtomsByOwnerId.get(atom.id) || [])
    if (item.fragments.length > 0) {
      const timed: AssistantDisplayItem = withFooterTiming(item, previousVisibleTimestamp)
      items.push(timed)
      previousVisibleTimestamp = timed.timestamp
    }
  }

  return items
}

function applyDisplayPoliciesAndTransforms(
  atoms: TranscriptAtom[],
  mode: 'default' | 'transcript',
): DisplayItem[] {
  const lookups = buildTranscriptLookups(atoms)
  const { attachedResultAtomsByOwnerId, attachedResultAtomIds } = deriveAttachedToolResultPolicy(atoms, lookups)
  return buildPrimaryDisplayItems(atoms, mode, lookups, attachedResultAtomsByOwnerId, attachedResultAtomIds)
}

function isCollapsibleToolItem(item: DisplayItem): item is AssistantDisplayItem | GroupedToolUseDisplayItem {
  if (item.kind === 'grouped_tool_use') {
    return item.toolUses.every((tool) => isLowSignalToolName(tool.name))
  }

  if (item.kind === 'assistant') {
    const toolUseFragments = item.fragments.filter((fragment) => fragment.type === 'tool_use')
    return toolUseFragments.length > 0 && toolUseFragments.every((fragment) => isLowSignalToolName(fragment.name))
  }

  return false
}

export function collapseLowSignalTools(items: DisplayItem[]): DisplayItem[] {
  const collapsed: DisplayItem[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    if (!isCollapsibleToolItem(item)) {
      collapsed.push(item)
      continue
    }

    const group: Array<AssistantDisplayItem | GroupedToolUseDisplayItem> = [item]
    let cursor = index + 1
    while (cursor < items.length && isCollapsibleToolItem(items[cursor]!)) {
      group.push(items[cursor] as AssistantDisplayItem | GroupedToolUseDisplayItem)
      cursor += 1
    }

    if (group.length >= 2) {
      collapsed.push(createCollapsedToolBatchDisplayItem(group))
      index = cursor - 1
      continue
    }

    collapsed.push(item)
  }

  return collapsed
}

export function buildDisplayItems(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): DisplayItem[] {
  const mode = options.mode ?? 'default'
  const orderedAtoms = orderAtomsForAssembly(atoms, { mode, includeHiddenAtoms: options.includeHiddenAtoms })
  return applyDisplayPoliciesAndTransforms(orderedAtoms, mode)
}

export function buildHistoryDisplayItems(messages: SessionMessage[], options: BuildDisplayItemsOptions = {}): DisplayItem[] {
  const atoms = buildHistoryAtoms(messages)
  const items = buildDisplayItems(atoms, options)
  return collapseLowSignalTools(items)
}
