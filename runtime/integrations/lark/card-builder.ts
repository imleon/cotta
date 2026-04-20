import type {
  AssistantDisplayItem,
  DisplayAssistantFooter,
  SessionMessage,
} from '../../protocol/message-types.js'
import { stringifyStructuredValue } from '../../protocol/transcript-normalizer.js'
import { buildAssistantFooterText } from '../../presentation/assistant-footer-format.js'
import { buildHistoryDisplayItems } from '../../presentation/transcript-display.js'
import {
  buildAssistantDetailEntries,
  type AssistantDetailEntry,
  type AssistantToolEntry,
} from '../../presentation/assistant-detail-entries.js'
import { buildAssistantToolRenderConfig } from '../../presentation/assistant-tool-sections.js'
import { optimizeLarkMarkdownStyle } from './markdown.js'
import type { LarkStreamingBuildCardParams } from './streaming-controller.js'

const LARK_COMPACT_TEXT_SIZE = 'cus-compact'

export const STREAMING_CARD_ELEMENT_ID = 'streaming_content'

function formatLarkCodeBlock(text: string): string {
  const trimmed = text.trim()
  return trimmed ? `\`\`\`\n${trimmed}\n\`\`\`` : ''
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

function buildLarkToolTitle(name: string): string {
  return name || 'unknown_tool'
}

function buildLarkToolInputDetail(input?: unknown): string {
  const inputText = stringifyStructuredValue(input).trim().replace(/\s+/g, ' ')
  return inputText.length > 240 ? `${inputText.slice(0, 240)}...` : inputText
}

function createLarkToolPanel(name: string, input?: unknown, resultText?: string): Record<string, unknown> {
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: `**${buildLarkToolTitle(name)}**`,
      text_size: 'notation',
    },
  ]

  const detail = buildLarkToolInputDetail(input)
  if (detail) {
    elements.push({
      tag: 'plain_text',
      content: detail,
      text_size: 'notation',
      text_color: 'grey',
      margin: '4px 0px 0px 12px',
    })
  }

  if (resultText) {
    elements.push({
      tag: 'markdown',
      content: `**Result**\n${formatLarkCodeBlock(resultText)}`,
      text_size: 'notation',
      margin: '4px 0px 0px 12px',
    })
  }

  return createLarkSectionPanel({
    title: 'Tool',
    verticalSpacing: '4px',
    elements,
  })
}

function createLarkToolResultPanel(resultText: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Tool Result',
    body: `**Result**\n${formatLarkCodeBlock(resultText)}`,
    verticalSpacing: '4px',
  })
}

function extractCollapsibleSubtitle(raw: string, maxChars = 36): string {
  const text = raw.trim()
  if (!text) return ''

  const headingMatch = text.match(/^#{1,6}\s+(.+?)\s*#*\s*(?:\n|$)/)
  if (headingMatch?.[1]) return headingMatch[1].trim()

  const boldMatch = text.match(/^\*\*(.+?)\*\*(?:\s|:|：|\n|$)/)
  if (boldMatch?.[1]) return boldMatch[1].trim()

  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
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
}): Record<string, unknown> | null {
  const elements = params.elements.filter(Boolean)
  if (elements.length === 0) return null

  const subtitle = params.subtitle?.trim()
    ? optimizeLarkMarkdownStyle(params.subtitle.trim()).replace(/\s+/g, ' ').trim()
    : ''
  // Keep title + subtitle in one line to mimic Web ToolRowShell layout.
  const headerContent = subtitle
    ? `${params.title} <font color='grey'>${subtitle}</font>`
    : `${params.title}`

  return {
    tag: 'collapsible_panel',
    expanded: params.expanded ?? false,
    background_color: '',
    margin: '0px 0px 0px 0px',
    header: {
      title: {
        tag: 'markdown',
        content: headerContent,
        text_size: LARK_COMPACT_TEXT_SIZE,
        ...(params.titleIcon ? {
          icon: {
            ...params.titleIcon,
            size: params.titleIcon.size ?? '12px 12px',
          },
        } : {}),
      },
      background_color: '',
      vertical_align: 'center',
      padding: '0px 0px 0px 0px',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
        color: 'grey',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '0px',
    padding: '4px 0px 4px 8px',
    elements,
  }
}

function wrapTopLevelPanelInContainer(element: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    height: 'auto',
    direction: 'vertical',
    margin: '0px 0px 0px 0px',
    padding: '0px 0px 0px 0px',
    vertical_spacing: '0px',
    horizontal_spacing: '0px',
    background_style: 'default',
    has_border: false,
    elements: [element],
  }
}

function createLarkDetailSectionWithOptions(
  label: string,
  content: string,
  mode: 'plain' | 'markdown',
  options: { forceQuoteMarkdown: boolean },
): Record<string, unknown> | null {
  const normalized = content.trim()
  if (!normalized) return null

  if (mode === 'markdown') {
    const body = optimizeLarkMarkdownStyle(normalized)
    if (!body) return null
    if (options.forceQuoteMarkdown) {
      const quoted = toMarkdownQuote(`${label}\n${body}`, true)
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
      content: `<font color='grey'>${label}</font>\n${body}`,
      text_size: LARK_COMPACT_TEXT_SIZE,
      margin: '0px 0px 0px 0px',
    }
  }

  const quoted = toMarkdownQuote(`${label}\n${formatLarkCodeBlock(normalized)}`, true)
  if (!quoted) return null
  return {
    tag: 'markdown',
    content: quoted,
    text_size: LARK_COMPACT_TEXT_SIZE,
    margin: '0px 0px 0px 0px',
  }
}

function createLarkStaticDetailRow(title: string, subtitle?: string): Record<string, unknown> | null {
  const parts = [title]
  if (subtitle?.trim()) parts.push(optimizeLarkMarkdownStyle(subtitle.trim()))
  return {
    tag: 'markdown',
    content: parts.join('\n'),
    text_size: LARK_COMPACT_TEXT_SIZE,
    margin: '0px 0px 0px 0px',
  }
}

function buildLarkToolRowElement(
  entry: AssistantToolEntry,
  options: { forceQuoteMarkdown?: boolean } = {},
): Record<string, unknown> | null {
  if (entry.kind === 'taskcreate') {
    return createLarkStaticDetailRow('调用 TaskCreate', entry.subtitle)
  }

  const config = buildAssistantToolRenderConfig(entry)
  const elements = config.sections
    .map((section) => createLarkDetailSectionWithOptions(
      section.label,
      section.content,
      section.mode || 'plain',
      { forceQuoteMarkdown: options.forceQuoteMarkdown === true },
    ))
    .filter(Boolean)
  if (elements.length === 0) {
    return createLarkStaticDetailRow(config.title, config.subtitle)
  }
  return createLarkCollapsiblePanel({
    title: config.title,
    subtitle: config.subtitle,
    elements,
    titleIcon: {
      tag: 'standard_icon',
      token: 'setting-inter_outlined',
      color: 'grey',
    },
  })
}

function buildLarkAssistantEntryElement(entry: AssistantDetailEntry): Record<string, unknown> | null {
  if (entry.kind === 'text') {
    return createLarkMarkdownBlock(entry.fragment.text)
  }

  if (entry.kind === 'thinking') {
    const subtitle = entry.redacted ? 'redacted' : extractCollapsibleSubtitle(entry.content)
    return createLarkCollapsiblePanel({
      title: entry.title,
      subtitle,
      elements: [
        {
          tag: 'markdown',
          content: toMarkdownQuote(entry.content, true),
          text_size: LARK_COMPACT_TEXT_SIZE,
        },
      ].filter(Boolean),
      titleIcon: {
        tag: 'standard_icon',
        token: 'efficiency_outlined',
        color: 'grey',
      },
    })
  }

  if (entry.kind === 'tool_group') {
    return createLarkCollapsiblePanel({
      title: '调用工具',
      subtitle: entry.summary,
      elements: entry.entries
        .map((toolEntry) => buildLarkToolRowElement(toolEntry, { forceQuoteMarkdown: true }))
        .filter(Boolean),
      titleIcon: {
        tag: 'standard_icon',
        token: 'treelist_outlined',
        color: 'grey',
      },
    })
  }

  return buildLarkToolRowElement(entry, { forceQuoteMarkdown: true })
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
      content: footerText,
      text_size: 'notation',
    })
  }

  return elements
}

export function buildAssistantStreamingCard(params: LarkStreamingBuildCardParams): Record<string, unknown> {
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
      elements.push(createLarkToolPanel(toolCall))
    }
  }

  if (normalizedToolResults && normalizedToolResults.length > 0) {
    for (const toolResult of normalizedToolResults) {
      elements.push(createLarkToolResultPanel(toolResult))
    }
  }

  const footerText = params.footer ? buildAssistantFooterText(params.footer, { includeTimestamp: false }) : ''
  if (footerText.trim().length > 0) {
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
        content: params.isFinal ? 'Claude response' : 'Processing...',
        i18n_content: {
          zh_cn: params.isFinal ? 'Claude 回复' : '处理中...',
          en_us: params.isFinal ? 'Claude response' : 'Processing...',
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
      summary: {
        content: 'Claude response',
        i18n_content: {
          zh_cn: 'Claude 回复',
          en_us: 'Claude response',
        },
      },
    },
    body: {
      elements,
    },
  }
}
