import type {
  AssistantDisplayItem,
  DisplayFragment,
  DisplayAssistantFooter,
  SessionMessage,
} from '../../protocol/message-types.js'
import {
  buildAssistantDetailEntries,
  buildAssistantFooterText,
  buildAssistantToolRenderConfig,
  buildHistoryDisplayItems,
  extractThinkingSubtitle,
} from '../../render/assistant-display.js'
import type {
  AssistantDetailEntry,
  AssistantGroupChildEntry,
  AssistantToolEntry,
} from '../../render/assistant-detail-entries.js'
import { optimizeLarkMarkdownStyle } from './markdown.js'
import type { LarkStreamingBuildCardParams } from './streaming-controller.js'

const LARK_COMPACT_TEXT_SIZE = 'cus-compact'

export const STREAMING_CARD_ELEMENT_ID = 'streaming_content'

const LARK_PROCESSING_SUMMARY = 'Processing...'
const LARK_EMPTY_PANEL_MARKDOWN = '&nbsp;'

function truncateSummaryText(text: string, maxChars: number = 30): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return Array.from(normalized).slice(0, maxChars).join('')
}

function buildLarkSummaryFromPreview(
  preview: NonNullable<LarkStreamingBuildCardParams['preview']>,
): { content: string; i18n_content: { zh_cn: string; en_us: string } } {
  const firstTextBlock = preview.blocks.find((block) => block.kind === 'text')
  const summary = firstTextBlock ? truncateSummaryText(firstTextBlock.shownText) : ''
  const content = summary || LARK_PROCESSING_SUMMARY
  return {
    content,
    i18n_content: {
      zh_cn: content,
      en_us: content,
    },
  }
}

function buildLarkSummaryFromFragments(
  fragments: DisplayFragment[],
): { content: string; i18n_content: { zh_cn: string; en_us: string } } {
  const firstTextFragment = fragments.find(
    (fragment): fragment is Extract<DisplayFragment, { type: 'text' }> => fragment.type === 'text',
  )
  const summary = firstTextFragment ? truncateSummaryText(firstTextFragment.text) : ''
  const content = summary || LARK_PROCESSING_SUMMARY
  return {
    content,
    i18n_content: {
      zh_cn: content,
      en_us: content,
    },
  }
}

function formatLarkCodeBlock(text: string): string {
  const trimmed = text.trim()
  return trimmed ? `\`\`\`\n${trimmed}\n\`\`\`` : ''
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function createLarkSectionPanel(params: {
  title: string
  body?: string
  elements?: unknown[]
  verticalSpacing?: string
}): Record<string, unknown> {
  const elements: unknown[] = []
  elements.push({
    tag: 'markdown',
    content: `**${params.title}**`,
    text_size: 'notation',
  })
  if (params.body?.trim()) {
    elements.push({
      tag: 'markdown',
      content: optimizeLarkMarkdownStyle(params.body),
      text_size: 'notation',
      margin: params.verticalSpacing ?? '4px',
    })
  }
  if (Array.isArray(params.elements) && params.elements.length > 0) {
    elements.push(...params.elements)
  }
  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'grey',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        elements,
      },
    ],
  }
}

function createLarkThinkingPanel(body: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Thinking',
    body,
    verticalSpacing: '4px',
  })
}

function isPreviewBlockActive(
  preview: NonNullable<LarkStreamingBuildCardParams['preview']>,
  block: NonNullable<LarkStreamingBuildCardParams['preview']>['blocks'][number],
): boolean {
  if (!preview.active) return false
  if (block.kind === 'thinking' && preview.phase === 'thinking') {
    const latest = Math.max(
      ...preview.blocks.filter((candidate) => candidate.kind === 'thinking').map((candidate) => candidate.index),
    )
    return block.index === latest
  }
  if (block.kind === 'tool_use' && preview.phase === 'tool-input') {
    const latest = Math.max(
      ...preview.blocks.filter((candidate) => candidate.kind === 'tool_use').map((candidate) => candidate.index),
    )
    return block.index === latest
  }
  return false
}

function buildLarkPreviewElementsFromBlocks(
  preview: NonNullable<LarkStreamingBuildCardParams['preview']>,
): unknown[] {
  const elements: unknown[] = []
  // `preview.blocks` is already maintained in the assistant's content order by the runtime reducer.
  // Do not re-sort here, otherwise ties/late index fixes may cause perceived "jumping".
  const blocks = preview.blocks

  for (const block of blocks) {
    if (block.kind === 'text') {
      const element = createLarkMarkdownBlock(block.shownText, 'normal_v2')
      if (element) elements.push(element)
      continue
    }

    if (block.kind === 'thinking') {
      const content = optimizeLarkMarkdownStyle(block.shownText.trim())
      const active = isPreviewBlockActive(preview, block)
      // Keep an empty thinking panel stable only while it is actively streaming.
      // Once the block is inactive/finalized, an empty panel is just noise and can
      // become the top-most element of the final card, which leaves the real text
      // body shifted down and may cause Lark to keep showing the old placeholder UI.
      if (!content && !active) {
        continue
      }
      const element = createLarkCollapsiblePanel({
        title: 'Thinking',
        subtitle: '',
        // Keep the panel stable during streaming. If `shownText` is temporarily empty,
        // render an empty body so the panel doesn't flicker/disappear.
        elements: content
          ? [{
              tag: 'markdown',
              content,
              text_size: LARK_COMPACT_TEXT_SIZE,
            }]
          : [{
              tag: 'markdown',
              content: LARK_EMPTY_PANEL_MARKDOWN,
              text_size: LARK_COMPACT_TEXT_SIZE,
            }],
        expanded: active,
        variant: 'top_level',
        titleIcon: {
          tag: 'standard_icon',
          token: 'efficiency_outlined',
          color: 'orange',
        },
      })
      if (element) elements.push(wrapTopLevelPanelInContainer(element as Record<string, unknown>))
      continue
    }

    if (block.kind === 'tool_use') {
      const input = (block.shownInput || '').trim()
      const title = `调用 ${buildLarkToolTitle(block.name)}`
      const element = input
        ? createLarkCollapsiblePanel({
            title,
            subtitle: '',
            elements: [{
              tag: 'markdown',
              content: `**Input**\n${formatLarkCodeBlock(input)}`,
              text_size: LARK_COMPACT_TEXT_SIZE,
              margin: '0px 0px 0px 0px',
            }],
            expanded: isPreviewBlockActive(preview, block),
            variant: 'top_level',
            titleIcon: {
              tag: 'standard_icon',
              token: 'setting-inter_outlined',
              color: 'blue',
            },
          })
        : createLarkStaticDetailRow(title, '', {
            tag: 'standard_icon',
            token: 'setting-inter_outlined',
            color: 'blue',
          })
      const elementRecord = element && typeof element === 'object' ? element as Record<string, unknown> : null
      if (elementRecord?.tag === 'collapsible_panel') {
        elements.push(wrapTopLevelPanelInContainer(elementRecord))
      } else if (element) {
        elements.push(element)
      }
      continue
    }
  }

  return elements
}

function buildLarkToolTitle(name: string): string {
  return name || 'unknown_tool'
}

function createLarkMarkdownBlock(content: string, textSize: string = 'normal_v2'): Record<string, unknown> | null {
  const normalized = optimizeLarkMarkdownStyle(content.trim())
  if (!normalized) return null
  return {
    tag: 'markdown',
    content: normalized,
    text_align: 'left',
    text_size: textSize,
    margin: '0px 0px 0px 0px',
  }
}

function toMarkdownQuote(content: string, preserveLineBreaks = false): string {
  const normalized = optimizeLarkMarkdownStyle(content.trim())
  if (!normalized) return ''
  return normalized
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '>'
      return preserveLineBreaks ? `> ${line}<br>` : `> ${line}`
    })
    .join('\n')
}

function createLarkCollapsiblePanel(params: {
  title: string
  subtitle?: string
  elements: unknown[]
  expanded?: boolean
  titleIcon?: { tag: 'standard_icon'; token: string; color?: string; size?: string }
  variant?: 'top_level' | 'nested'
}): Record<string, unknown> | null {
  const elements = params.elements.filter(Boolean)
  if (elements.length === 0) return null

  const isTopLevel = params.variant === 'top_level'
  const subtitle = params.subtitle?.trim()
    ? optimizeLarkMarkdownStyle(params.subtitle.trim()).replace(/\s+/g, ' ').trim()
    : ''
  // Keep title + subtitle in one line to mimic Web ToolRowShell layout.
  const headerContent = subtitle
    ? `${params.title} <font color='grey'>${subtitle}</font>`
    : `${params.title}`

  const iconColor = params.titleIcon?.color || 'grey'

  const bodyElements = isTopLevel
    ? elements
    : [wrapNestedPanelBody(elements)]

  return {
    tag: 'collapsible_panel',
    expanded: params.expanded ?? false,
    background_color: '',
    margin: '0px 0px 0px 0px',
    ...(isTopLevel
      ? {
          border: {
            color: 'grey',
          },
          corner_radius: '8px',
        }
      : {}),
    header: {
      title: {
        tag: 'markdown',
        content: headerContent,
        text_size: LARK_COMPACT_TEXT_SIZE,
        ...(params.titleIcon ? {
          icon: {
            ...params.titleIcon,
            size: params.titleIcon.size ?? (isTopLevel ? '14px 14px' : '12px 12px'),
          },
        } : {}),
      },
      background_color: isTopLevel ? 'grey' : '',
      vertical_align: 'center',
      padding: isTopLevel ? '8px 12px 8px 12px' : '4px 6px 4px 6px',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: isTopLevel ? '16px 16px' : '14px 14px',
        color: iconColor,
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '0px',
    padding: isTopLevel ? '8px 12px 8px 12px' : '4px 0px 4px 8px',
    elements: bodyElements,
  }
}

function wrapTopLevelPanelInContainer(element: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    height: 'auto',
    direction: 'vertical',
    margin: '4px 0px 0px 0px',
    padding: '0px 0px 0px 0px',
    vertical_spacing: '0px',
    horizontal_spacing: '0px',
    background_style: 'default',
    has_border: false,
    elements: [element],
  }
}

function wrapNestedPanelBody(elements: unknown[]): Record<string, unknown> {
  // Grey rounded container for nested panel body only (header remains unchanged).
  return {
    tag: 'interactive_container',
    width: 'fill',
    height: 'auto',
    direction: 'vertical',
    margin: '4px 0px 0px 0px',
    padding: '6px 10px 6px 10px',
    vertical_spacing: '6px',
    horizontal_spacing: '0px',
    background_style: 'grey',
    has_border: true,
    border_color: 'grey',
    corner_radius: '8px',
    elements,
  }
}

function createLarkDetailSectionWithOptions(
  label: string | undefined,
  content: string,
  mode: 'plain' | 'markdown' | 'bash',
  options: { forceQuoteMarkdown: boolean },
  command?: string,
): Record<string, unknown> | null {
  const normalized = content.trim()
  if (!normalized) return null
  const normalizedLabel = label?.trim() || ''

  if (mode === 'bash') {
    const shellLine = `<font color='red'>$</font> <font color='default'>${escapeHtml((command || '').trim())}</font>`
    const body = normalized
      .split('\n')
      .map((line) => `<font color='grey'>${escapeHtml(line) || ' '}</font>`)
      .join('<br>')
    const combined = normalized ? `${shellLine}\n${body}` : shellLine
    if (options.forceQuoteMarkdown) {
      const quoted = toMarkdownQuote(combined, true)
      if (!quoted) return null
      return {
        tag: 'markdown',
        content: quoted,
        text_size: LARK_COMPACT_TEXT_SIZE,
        margin: '0px 0px 0px 0px',
      }
    }
    return {
      tag: 'markdown',
      content: combined,
      text_size: LARK_COMPACT_TEXT_SIZE,
      margin: '0px 0px 0px 0px',
    }
  }

  if (mode === 'markdown') {
    const body = optimizeLarkMarkdownStyle(normalized)
    if (!body) return null
    if (options.forceQuoteMarkdown) {
      const quoted = toMarkdownQuote(normalizedLabel ? `${normalizedLabel}\n${body}` : body, true)
      if (!quoted) return null
      return {
        tag: 'markdown',
        content: quoted,
        text_size: LARK_COMPACT_TEXT_SIZE,
        margin: '0px 0px 0px 0px',
      }
    }
    return {
      tag: 'markdown',
      // Preserve markdown semantics for rich result blocks instead of flattening
      // them into a quoted plain-text shape.
      content: normalizedLabel ? `<font color='grey'>${normalizedLabel}</font>\n${body}` : body,
      text_size: LARK_COMPACT_TEXT_SIZE,
      margin: '0px 0px 0px 0px',
    }
  }

  if (!options.forceQuoteMarkdown) {
    return {
      tag: 'markdown',
      content: normalizedLabel
        ? `<font color='grey'>${normalizedLabel}</font>\n${optimizeLarkMarkdownStyle(normalized)}`
        : optimizeLarkMarkdownStyle(normalized),
      text_size: LARK_COMPACT_TEXT_SIZE,
      margin: '0px 0px 0px 0px',
    }
  }

  const quoted = toMarkdownQuote(
    normalizedLabel ? `${normalizedLabel}\n${optimizeLarkMarkdownStyle(normalized)}` : optimizeLarkMarkdownStyle(normalized),
    true,
  )
  if (!quoted) return null
  return {
    tag: 'markdown',
    content: quoted,
    text_size: LARK_COMPACT_TEXT_SIZE,
    margin: '0px 0px 0px 0px',
  }
}

function createLarkStaticDetailRow(
  title: string,
  subtitle?: string,
  icon?: { tag: string; token: string; color: string },
): Record<string, unknown> | null {
  const parts = [title]
  if (subtitle?.trim()) parts.push(optimizeLarkMarkdownStyle(subtitle.trim()))
  return {
    tag: 'markdown',
    content: parts.join('\n'),
    text_size: LARK_COMPACT_TEXT_SIZE,
    margin: '0px 0px 0px 0px',
    ...(icon ? { icon } : {}),
  }
}

function buildLarkToolRowElement(
  entry: AssistantToolEntry,
  options: { forceQuoteMarkdown?: boolean; topLevel?: boolean; preferPanel?: boolean } = {},
): Record<string, unknown> | null {
  const config = buildAssistantToolRenderConfig(entry)
  const toolIcon = {
    tag: 'standard_icon' as const,
    token: config.iconName,
    color: 'blue',
  }
  const shouldPreferNestedPanel = options.topLevel === false && options.preferPanel === true
  const nestedFallbackElements = config.subtitle.trim()
    ? [{
        tag: 'markdown',
        content: optimizeLarkMarkdownStyle(config.subtitle.trim()),
        text_size: LARK_COMPACT_TEXT_SIZE,
        margin: '0px 0px 0px 0px',
      }]
    : [{
        tag: 'markdown',
        content: LARK_EMPTY_PANEL_MARKDOWN,
        text_size: LARK_COMPACT_TEXT_SIZE,
      }]

  if (!config.expandable || config.sections.length === 0) {
    if (shouldPreferNestedPanel) {
      return createLarkCollapsiblePanel({
        title: config.title,
        subtitle: '',
        elements: nestedFallbackElements,
        variant: 'nested',
        titleIcon: toolIcon,
      })
    }
    return createLarkStaticDetailRow(
      config.title,
      config.subtitle,
      toolIcon,
    )
  }

  const elements = config.sections
    .map((section) => createLarkDetailSectionWithOptions(
      section.label,
      section.content,
      section.mode || 'plain',
      { forceQuoteMarkdown: options.forceQuoteMarkdown === true },
      section.command,
    ))
    .filter(Boolean)
  if (elements.length === 0) {
    if (shouldPreferNestedPanel) {
      return createLarkCollapsiblePanel({
        title: config.title,
        subtitle: '',
        elements: nestedFallbackElements,
        variant: 'nested',
        titleIcon: toolIcon,
      })
    }
    return createLarkStaticDetailRow(config.title, config.subtitle, toolIcon)
  }
  return createLarkCollapsiblePanel({
    title: config.title,
    subtitle: config.subtitle,
    elements,
    variant: options.topLevel ? 'top_level' : 'nested',
    titleIcon: toolIcon,
  })
}

function buildLarkGroupedChildElement(entry: AssistantGroupChildEntry): Record<string, unknown> | null {
  if (entry.kind === 'thinking') {
    return buildLarkAssistantEntryElement(entry, { topLevel: false })
  }
  return buildLarkToolRowElement(entry, {
    forceQuoteMarkdown: false,
    topLevel: false,
    preferPanel: true,
  })
}

function buildLarkAssistantEntryElement(
  entry: AssistantDetailEntry,
  options: { topLevel?: boolean } = {},
): Record<string, unknown> | null {
  const isTopLevel = options.topLevel !== false
  if (entry.kind === 'text') {
    return createLarkMarkdownBlock(entry.fragment.text)
  }

  if (entry.kind === 'thinking') {
    const subtitle = entry.redacted ? 'redacted' : extractThinkingSubtitle(entry.content)
    const body = entry.redacted
      ? 'redacted thinking'
      : optimizeLarkMarkdownStyle(entry.content)
    return createLarkCollapsiblePanel({
      title: entry.title,
      subtitle,
      elements: [
        {
          tag: 'markdown',
          content: body,
          text_size: LARK_COMPACT_TEXT_SIZE,
        },
      ].filter(Boolean),
      variant: isTopLevel ? 'top_level' : 'nested',
      titleIcon: {
        tag: 'standard_icon',
        token: 'efficiency_outlined',
        color: 'orange',
      },
    })
  }

  if (entry.kind === 'tool_group') {
    return createLarkCollapsiblePanel({
      title: entry.summary,
      subtitle: '',
      elements: entry.entries
        .map((childEntry) => buildLarkGroupedChildElement(childEntry))
        .filter(Boolean),
      variant: isTopLevel ? 'top_level' : 'nested',
      titleIcon: {
        tag: 'standard_icon',
        token: 'treelist_outlined',
        color: 'indigo',
      },
    })
  }

  return buildLarkToolRowElement(entry, {
    forceQuoteMarkdown: !isTopLevel,
    topLevel: isTopLevel,
  })
}

function buildLarkAssistantElements(item: AssistantDisplayItem): unknown[] {
  const elements: unknown[] = []
  for (const entry of buildAssistantDetailEntries(item)) {
    const element = buildLarkAssistantEntryElement(entry)
    if (!element) continue
    if (element.tag === 'collapsible_panel') {
      elements.push(wrapTopLevelPanelInContainer(element as Record<string, unknown>))
      continue
    }
    elements.push(element)
  }

  const footerText = buildAssistantFooterText(item.footer, { includeTimestamp: false })
  if (footerText.trim()) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${footerText}</font>`,
      text_size: 'notation',
    })
  }

  return elements
}

function buildAssistantDisplayFragmentsFromPreview(
  preview: NonNullable<LarkStreamingBuildCardParams['preview']>,
): DisplayFragment[] {
  const fragments: DisplayFragment[] = []
  for (const block of preview.blocks) {
    if (block.kind === 'text') {
      const text = block.shownText.trim()
      if (text) {
        fragments.push({ type: 'text', text })
      }
      continue
    }
    if (block.kind === 'thinking') {
      fragments.push({
        type: 'thinking',
        ...(block.redacted ? {} : { text: block.shownText }),
        ...(block.redacted ? { redacted: true } : {}),
        defaultHidden: false,
      })
      continue
    }
    fragments.push({
      type: 'tool_use',
      name: block.name,
      ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}),
    })
  }
  return fragments
}

function buildLarkFinalCardFromPreview(
  preview: NonNullable<LarkStreamingBuildCardParams['preview']>,
  footer: DisplayAssistantFooter | undefined,
  answerText: string | undefined,
): Record<string, unknown> | null {
  const summary = buildLarkSummaryFromPreview(preview)
  const fragments = buildAssistantDisplayFragmentsFromPreview(preview)
  if (fragments.length === 0 && answerText?.trim()) {
    fragments.push({ type: 'text', text: answerText.trim() })
  }
  if (fragments.length === 0) return null

  const scopeKey = preview.scope.scopeKey || 'lark-preview-final'
  const pseudoItem = {
    kind: 'assistant',
    id: `preview-final-${scopeKey}`,
    key: `preview-final-${scopeKey}`,
    timestamp: Date.now(),
    atomIds: [],
    messages: [],
    anchorMessage: {},
    fragments,
    ...(footer ? { footer } : {}),
  } as unknown as AssistantDisplayItem

  const elements = buildLarkAssistantElements(pseudoItem)
  if (elements.length === 0) return null

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      style: {
        text_size: {
          [LARK_COMPACT_TEXT_SIZE]: {
            default: 'notation',
            pc: '10px',
            mobile: '10px',
          },
        },
      },
      summary,
    },
    body: {
      elements,
    },
  }
}

export function buildAssistantStreamingCard(params: LarkStreamingBuildCardParams): Record<string, unknown> {
  if (params.preview) {
    if (params.isFinal) {
      const groupedFinalCard = buildLarkFinalCardFromPreview(params.preview, params.footer, params.answerText)
      if (groupedFinalCard) {
        return groupedFinalCard
      }
    }
    const previewElements = buildLarkPreviewElementsFromBlocks(params.preview)
    const bodyElements: unknown[] = previewElements.length > 0
      ? [...previewElements]
      : [{
          tag: 'markdown',
          content: params.answerText?.trim() || 'Processing...',
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
          element_id: STREAMING_CARD_ELEMENT_ID,
        }]

    const footerText = params.isFinal && params.footer
      ? buildAssistantFooterText(params.footer, { includeTimestamp: false })
      : ''
    if (params.isFinal && footerText.trim().length > 0) {
      bodyElements.push({ tag: 'hr' })
      bodyElements.push({
        tag: 'markdown',
        content: `<font color='grey'>${footerText}</font>`,
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
        style: {
          text_size: {
            [LARK_COMPACT_TEXT_SIZE]: {
              default: 'notation',
              pc: '10px',
              mobile: '10px',
            },
          },
        },
        summary: buildLarkSummaryFromPreview(params.preview),
      },
      body: {
        elements: bodyElements,
      },
    }
  }

  const mainContent = optimizeLarkMarkdownStyle(
    params.answerText || params.thinkingText || (params.isFinal ? 'Done.' : 'Processing...'),
  )
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
      elements.push({
        tag: 'markdown',
        content: `**Tool**\n${toolCall}`,
        text_size: 'notation',
        margin: '4px 0px 0px 0px',
      })
    }
  }

  if (normalizedToolResults && normalizedToolResults.length > 0) {
    for (const toolResult of normalizedToolResults) {
      elements.push({
        tag: 'markdown',
        content: `**Tool Result**\n${formatLarkCodeBlock(toolResult)}`,
        text_size: 'notation',
        margin: '4px 0px 0px 0px',
      })
    }
  }

  const footerText = params.footer ? buildAssistantFooterText(params.footer, { includeTimestamp: false }) : ''
  if (params.isFinal && footerText.trim().length > 0) {
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
      style: {
        text_size: {
          [LARK_COMPACT_TEXT_SIZE]: {
            default: 'notation',
            pc: '10px',
            mobile: '10px',
          },
        },
      },
      summary: {
        content: LARK_PROCESSING_SUMMARY,
        i18n_content: {
          zh_cn: LARK_PROCESSING_SUMMARY,
          en_us: LARK_PROCESSING_SUMMARY,
        },
      },
    },
    body: {
      elements,
    },
  }
}

export function buildLarkFinalCardFromHistory(messages: SessionMessage[], footer: DisplayAssistantFooter): Record<string, unknown> | null {
  const items = buildHistoryDisplayItems(messages, { mode: 'default', includeHiddenAtoms: false })
    .filter((item): item is AssistantDisplayItem => item.kind === 'assistant')
  const target = items[items.length - 1]
  if (!target) return null

  const elements = buildLarkAssistantElements({ ...target, footer })
  const summary = buildLarkSummaryFromFragments(target.fragments)

  if (elements.length === 0) return null

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      style: {
        text_size: {
          [LARK_COMPACT_TEXT_SIZE]: {
            default: 'notation',
            pc: '10px',
            mobile: '10px',
          },
        },
      },
      summary,
    },
    body: {
      elements,
    },
  }
}
