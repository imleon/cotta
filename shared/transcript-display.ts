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
  TranscriptVisibilityPolicy,
  UserDisplayItem,
} from './message-types.js'
import {
  extractStructuredContentFromBlocks,
  getTranscriptAssistantModel,
  getTranscriptAssistantUsage,
  getTranscriptMessageId,
  getTranscriptSemanticKind,
  getTranscriptStopReason,
  getTranscriptToolResultIds,
  getTranscriptToolUseIds,
  isTranscriptMetaMessage,
  isTranscriptRedactedThinkingMessage,
  isTranscriptSummaryMessage,
  type TranscriptBlock,
  type TranscriptMessage,
} from './transcript-normalizer.js'

export interface BuildDisplayItemsOptions {
  mode?: 'default' | 'transcript'
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

function getVisibility(message: TranscriptMessage): TranscriptVisibilityPolicy {
  const semanticKind = getTranscriptSemanticKind(message)
  if (isTranscriptMetaMessage(message)) {
    return { defaultHidden: true, transcriptOnly: false }
  }
  if (isTranscriptSummaryMessage(message)) {
    return { defaultHidden: true, transcriptOnly: false }
  }
  if (isTranscriptRedactedThinkingMessage(message)) {
    return { defaultHidden: true, transcriptOnly: true }
  }
  if (semanticKind === 'thinking') {
    return { defaultHidden: false, transcriptOnly: false }
  }
  return { defaultHidden: false, transcriptOnly: false }
}

function getLinkage(message: TranscriptMessage): TranscriptLinkage {
  return {
    messageId: getTranscriptMessageId(message),
    toolUseIds: getTranscriptToolUseIds(message),
    toolResultForIds: getTranscriptToolResultIds(message),
  }
}

function getAssistantFooter(message: SessionMessage, executionDurationMs?: number | null): DisplayAssistantFooter | undefined {
  const stopReason = getTranscriptStopReason(message)
  const model = getTranscriptAssistantModel(message)
  const usage = getTranscriptAssistantUsage(message)
  if (!stopReason && !model && !usage && executionDurationMs == null) return undefined
  return {
    stopReason,
    model,
    usage,
    executionDurationMs: executionDurationMs ?? null,
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
    visibility: getVisibility(message),
    linkage: getLinkage(message),
    assistant: {
      stopReason: getTranscriptStopReason(message),
      model: getTranscriptAssistantModel(message),
      usage: getTranscriptAssistantUsage(message),
    },
    meta: {
      isMeta: isTranscriptMetaMessage(message),
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

function createFragments(message: SessionMessage, options: { mode: 'default' | 'transcript'; attachToolResultsToParent?: boolean } = { mode: 'default' }): DisplayFragment[] {
  const structured = extractStructuredContentFromBlocks(message.blocks || [])
  const fragments: DisplayFragment[] = []

  for (const block of message.blocks || []) {
    if (block.type === 'text' && block.text) {
      fragments.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'thinking') {
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

  if (fragments.length === 0 && message.content) {
    fragments.push({ type: 'text', text: message.content })
  }

  if (isTranscriptRedactedThinkingMessage(message) && fragments.length === 0) {
    return fragments
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

function createUserDisplayItem(atom: TranscriptAtom): UserDisplayItem {
  return {
    kind: 'user',
    id: atom.id,
    key: atom.id,
    timestamp: atom.order.timestamp,
    atomIds: [atom.id],
    message: atom.message,
  }
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

  for (const atom of atoms) {
    fragments.push(...createFragments(atom.message, { mode }))
  }
  for (const atom of attachedToolResultAtoms) {
    atomIds.push(atom.id)
    fragments.push(...createFragments(atom.message, { mode, attachToolResultsToParent: true }))
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
    footer: getAssistantFooter(anchor),
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
    footer: getAssistantFooter(first.message),
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
    footer: getAssistantFooter(first.anchorMessage),
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

function shouldHideAtom(atom: TranscriptAtom, mode: 'default' | 'transcript'): boolean {
  if (mode === 'transcript') return false
  if (atom.visibility.transcriptOnly) return true
  return atom.visibility.defaultHidden
}

export function orderAtomsForTimeline(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): TranscriptAtom[] {
  const mode = options.mode ?? 'default'
  return atoms
    .slice()
    .sort(compareAtoms)
    .filter((atom) => !shouldHideAtom(atom, mode))
}

function attachToolResults(atoms: TranscriptAtom[], lookups: TranscriptLookup): {
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

export function buildBaseDisplayItems(atoms: TranscriptAtom[], options: BuildDisplayItemsOptions = {}): DisplayItem[] {
  const mode = options.mode ?? 'default'
  const lookups = buildTranscriptLookups(atoms)
  const { attachedResultAtomsByOwnerId, attachedResultAtomIds } = attachToolResults(atoms, lookups)
  const items: DisplayItem[] = []

  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index]!

    if (attachedResultAtomIds.has(atom.id)) continue

    if (atom.semanticKind === 'summary') {
      items.push(createSummaryDisplayItem(atom, mode))
      continue
    }

    if (atom.semanticKind === 'user') {
      items.push(createUserDisplayItem(atom))
      continue
    }

    if (atom.semanticKind === 'tool_result') {
      items.push(createAssistantDisplayItem([atom], mode))
      continue
    }

    if (atom.role !== 'assistant') {
      items.push(createAssistantDisplayItem([atom], mode))
      continue
    }

    const group = [atom]
    let cursor = index + 1
    while (cursor < atoms.length && canGroupToolUseAtoms(group, atoms[cursor]!)) {
      group.push(atoms[cursor]!)
      cursor += 1
    }

    if (group.length >= 2) {
      items.push(createGroupedToolUseDisplayItem(group, lookups))
      index = cursor - 1
      continue
    }

    items.push(createAssistantDisplayItem([atom], mode, attachedResultAtomsByOwnerId.get(atom.id) || []))
  }

  return items
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

export function collapseToolBatchDisplayItems(items: DisplayItem[]): DisplayItem[] {
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
  const orderedAtoms = orderAtomsForTimeline(atoms, { mode })
  const baseItems = buildBaseDisplayItems(orderedAtoms, { mode })
  return collapseToolBatchDisplayItems(baseItems)
}
