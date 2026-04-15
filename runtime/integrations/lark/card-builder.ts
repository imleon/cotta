import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  DisplayAssistantFooter,
  DisplayFragment,
  GroupedToolUseDisplayItem,
  SessionMessage,
} from '../../protocol/message-types.js'
import { stringifyStructuredValue } from '../../protocol/transcript-normalizer.js'
import { buildAssistantFooterText } from '../../presentation/assistant-footer-format.js'
import { buildHistoryDisplayItems } from '../../presentation/transcript-display.js'
import { optimizeLarkMarkdownStyle } from './markdown.js'
import type { LarkStreamingBuildCardParams } from './streaming-controller.js'

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

function createLarkSectionMarkdown(title: string, body: string): Record<string, unknown> {
  return createLarkSectionPanel({ title, body, verticalSpacing: '4px' })
}

function buildLarkToolResultText(fragment: DisplayFragment & { type: 'tool_result' }): string {
  if (fragment.display?.previewText) return fragment.display.previewText
  return stringifyStructuredValue(fragment.output).trim()
}

function buildLarkAssistantElements(item: AssistantDisplayItem): unknown[] {
  const elements: unknown[] = []
  const shouldIndentFooter = item.fragments[0]?.type === 'tool_use'

  for (const fragment of item.fragments) {
    if (fragment.type === 'text') {
      const text = optimizeLarkMarkdownStyle(fragment.text.trim())
      if (text) {
        elements.push({
          tag: 'markdown',
          content: text,
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
        })
      }
      continue
    }

    if (fragment.type === 'thinking') {
      const text = fragment.text?.trim()
      if (text) elements.push(createLarkThinkingPanel(text))
      continue
    }

    if (fragment.type === 'tool_use') {
      elements.push(createLarkToolPanel(fragment.name, fragment.input))
      continue
    }

    if (fragment.type === 'tool_result') {
      const resultText = buildLarkToolResultText(fragment)
      if (resultText) elements.push(createLarkToolResultPanel(resultText))
      continue
    }

    if (fragment.type === 'summary') {
      const text = fragment.text.trim()
      if (text) elements.push(createLarkSectionMarkdown('Summary', text))
    }
  }

  const footerText = buildAssistantFooterText(item.footer)
  if (footerText.trim()) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: shouldIndentFooter ? `&nbsp;&nbsp;&nbsp;&nbsp;${footerText}` : footerText,
      text_size: 'notation',
    })
  }

  return elements
}

function buildLarkGroupedToolUseElements(item: GroupedToolUseDisplayItem): unknown[] {
  const elements: unknown[] = []
  for (const tool of item.toolUses) {
    const resultText = tool.resultDisplay?.previewText ?? stringifyStructuredValue(tool.result).trim()
    elements.push(createLarkToolPanel(tool.name, tool.input, resultText || undefined))
  }

  const footerText = buildAssistantFooterText(item.footer)
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

function buildLarkCollapsedToolBatchElements(item: CollapsedToolBatchDisplayItem): unknown[] {
  const totalOps = item.summary.readCount + item.summary.searchCount + item.summary.listCount + item.summary.bashCount
  const lines = [
    `${totalOps} low-signal tool calls${item.summary.latestHint ? ` · ${item.summary.latestHint}` : ''}`,
    `Read ${item.summary.readCount} · Search ${item.summary.searchCount} · List ${item.summary.listCount} · Bash ${item.summary.bashCount}`,
  ]

  const elements: unknown[] = [createLarkSectionMarkdown('Tool Batch', lines.join('\n'))]
  const footerText = buildAssistantFooterText(item.footer)
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

  const footerText = params.footer ? buildAssistantFooterText(params.footer) : ''
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
    .filter((item): item is AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem =>
      item.kind === 'assistant' || item.kind === 'grouped_tool_use' || item.kind === 'collapsed_tool_batch')
  const target = items[items.length - 1]
  if (!target) return null

  const elements = target.kind === 'assistant'
    ? buildLarkAssistantElements({ ...target, footer })
    : target.kind === 'grouped_tool_use'
      ? buildLarkGroupedToolUseElements({ ...target, footer })
      : buildLarkCollapsedToolBatchElements({ ...target, footer })

  if (elements.length === 0) return null

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
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
