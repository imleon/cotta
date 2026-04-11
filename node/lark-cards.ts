import * as Lark from '@larksuiteoapi/node-sdk'
import { optimizeLarkMarkdownStyle } from './lark-markdown-style.js'
import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  DisplayAssistantFooter,
  DisplayFragment,
  GroupedToolUseDisplayItem,
  PendingInteraction,
  SessionMessage,
} from '../shared/message-types.js'
import {
  stringifyStructuredValue,
} from '../shared/transcript-normalizer.js'
import {
  inferElicitationRenderer,
  type ElicitationRenderer,
} from '../shared/elicitation-renderer.js'
import { buildAssistantFooterText } from '../shared/assistant-footer-format.js'
import { buildHistoryDisplayItems } from '../shared/transcript-display.js'

// --- Extracted from lark-adapter.ts ---

export type LarkElicitationCardActionType =
  | 'elicitation_submit'
  | 'elicitation_decline'
  | 'elicitation_cancel'
  | 'elicitation_continue_url'

export function formatPermissionSuggestions(suggestions?: Extract<PendingInteraction, { kind: 'permission' }>['permissionSuggestions']): string[] {
  if (!suggestions || suggestions.length === 0) return []
  return suggestions.map((suggestion) => {
    const label = suggestion.label || suggestion.action
    const details = [suggestion.description, suggestion.scope].filter(Boolean).join(' · ')
    return details ? `• **${label}** — ${details}` : `• **${label}**`
  })
}

export function formatPermissionMetadata(interaction: Extract<PendingInteraction, { kind: 'permission' }>): string[] {
  return [
    interaction.decisionReason ? `**Why Claude asked:** ${interaction.decisionReason}` : '',
    interaction.blockedPath ? `**Path:** ${interaction.blockedPath}` : '',
    interaction.toolUseId ? `**Tool use:** ${interaction.toolUseId}` : '',
    interaction.agentId ? `**Agent:** ${interaction.agentId}` : '',
  ].filter(Boolean)
}

export function getPermissionDecisionFromPayload(payload: unknown): 'approve' | 'deny' | null {
  if (!payload || typeof payload !== 'object') return null
  const decision = (payload as Record<string, unknown>).decision
  return decision === 'approve' || decision === 'deny' ? decision : null
}

export function buildPermissionCard(runId: string, interaction: Extract<PendingInteraction, { kind: 'permission' }>): Lark.InteractiveCard {
  const title = interaction.title || interaction.displayName || interaction.toolName
  const description = interaction.description || 'Claude 需要你的确认后才能继续执行。'
  const metadataLines = formatPermissionMetadata(interaction)
  const suggestionLines = formatPermissionSuggestions(interaction.permissionSuggestions)

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${title}**\n${description}`,
      },
    },
  ]

  if (metadataLines.length > 0) {
    elements.push({
      tag: 'note',
      elements: metadataLines.map((item) => ({
        tag: 'plain_text',
        content: item.replace(/\*\*/g, ''),
      })),
    })
  }

  if (suggestionLines.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Suggested action**\n${suggestionLines.join('\n')}`,
      },
    })
  }

  elements.push(
    {
      tag: 'hr',
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'primary',
          text: {
            tag: 'plain_text',
            content: 'Approve and continue',
          },
          value: {
            actionType: 'permission',
            runId,
            interactionId: interaction.id,
            decision: 'approve',
          },
        },
        {
          tag: 'button',
          type: 'danger',
          text: {
            tag: 'plain_text',
            content: 'Deny request',
          },
          value: {
            actionType: 'permission',
            runId,
            interactionId: interaction.id,
            decision: 'deny',
          },
        },
      ],
    },
  )

  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `Permission required · ${title}`,
      },
    },
    elements: elements as unknown as Lark.InteractiveCard['elements'],
  }
}

export function buildPermissionStatusCard(title: string, message: string, template: 'green' | 'red' | 'grey'): Lark.InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: message,
        },
      },
    ],
  }
}

export function buildPermissionResolvedCard(decision: 'approve' | 'deny', ok: boolean): Lark.InteractiveCard {
  const approved = ok && decision === 'approve'
  const denied = ok && decision === 'deny'
  return buildPermissionStatusCard(
    ok
      ? (approved ? 'Permission approved' : 'Permission denied')
      : 'Permission unavailable',
    ok
      ? (approved
          ? 'Claude can continue with this action.'
          : 'Claude will not continue with this action.')
      : 'No matching active run was found for this permission action.',
    approved ? 'green' : denied ? 'red' : 'grey',
  )
}

export function buildElicitationStatusCard(title: string, message: string, template: 'green' | 'red' | 'grey'): Lark.InteractiveCard {
  return buildPermissionStatusCard(title, message, template)
}

export function buildElicitationResolvedCard(action: 'accept' | 'decline' | 'cancel', ok: boolean): Lark.InteractiveCard {
  const accepted = ok && action === 'accept'
  const declined = ok && action === 'decline'
  return buildElicitationStatusCard(
    ok
      ? (accepted ? 'Elicitation submitted' : declined ? 'Elicitation declined' : 'Elicitation cancelled')
      : 'Elicitation unavailable',
    ok
      ? (accepted
          ? 'Claude received the requested input.'
          : declined
            ? 'Claude will continue without this input.'
            : 'This interaction was cancelled.')
      : 'No matching active run was found for this elicitation action.',
    accepted ? 'green' : declined ? 'red' : 'grey',
  )
}

export function makePlainText(content: string): Lark.InteractiveCardPlainTextItem {
  return { tag: 'plain_text', content }
}

export function makeMarkdown(content: string): Lark.InteractiveCardLarkMdItem {
  return { tag: 'lark_md', content }
}

export function buildBaseElicitationCard(title: string, description?: string): { config: Record<string, unknown>; header: Record<string, unknown>; elements: unknown[] } {
  const elements: unknown[] = [{
    tag: 'div',
    text: makeMarkdown(`**${title}**${description ? `\n${description}` : ''}`),
  }]

  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: 'orange',
      title: makePlainText(`Elicitation required · ${title}`),
    },
    elements,
  }
}

export function buildElicitationActionValue(runId: string, interactionId: string, renderer: ElicitationRenderer, actionType: LarkElicitationCardActionType): Record<string, unknown> {
  return {
    actionType,
    runId,
    interactionId,
    rendererType: renderer.type,
    ...('field' in renderer ? { field: renderer.field } : {}),
    ...('containerField' in renderer && renderer.containerField ? { containerField: renderer.containerField } : {}),
    ...('valueType' in renderer ? { valueType: renderer.valueType } : {}),
  }
}

export function buildElicitationCardActions(
  runId: string,
  interaction: Extract<PendingInteraction, { kind: 'elicitation' }>,
  renderer: ElicitationRenderer,
  options?: { includeSubmit?: boolean; submitLabel?: string; formAction?: boolean },
): Lark.InterfaceCardActionElement {
  const includeSubmit = options?.includeSubmit ?? true
  const submitLabel = options?.submitLabel ?? (renderer.type === 'url_open' ? 'Continue' : 'Submit')
  const formAction = options?.formAction ?? false
  const actions: unknown[] = []

  if (includeSubmit) {
    actions.push({
      tag: 'button',
      type: 'primary',
      text: makePlainText(submitLabel),
      ...(formAction
        ? {
            form_action_type: 'submit',
            name: `submit_${interaction.id.slice(0, 12)}`,
          }
        : {}),
      value: buildElicitationActionValue(
        runId,
        interaction.id,
        renderer,
        renderer.type === 'url_open' ? 'elicitation_continue_url' : 'elicitation_submit',
      ),
    })
  }

  actions.push(
    {
      tag: 'button',
      type: 'default',
      text: makePlainText('Decline'),
      value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_decline'),
    },
    {
      tag: 'button',
      type: 'danger',
      text: makePlainText('Cancel'),
      value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_cancel'),
    },
  )

  return {
    tag: 'action',
    layout: 'trisection',
    actions: actions as Lark.InteractiveCardActionItem[],
  }
}

export function buildElicitationCard(runId: string, interaction: Extract<PendingInteraction, { kind: 'elicitation' }>): Lark.InteractiveCard {
  const renderer = inferElicitationRenderer(interaction)
  const card = buildBaseElicitationCard(renderer.title, renderer.description)

  switch (renderer.type) {
    case 'url_open':
      card.elements.push(
        {
          tag: 'div',
          text: makeMarkdown(`Open the URL, complete the external step, then continue here.\n${renderer.url}`),
        },
        {
          tag: 'action',
          layout: 'bisected',
          actions: [
            {
              tag: 'button',
              type: 'default',
              text: makePlainText('Open URL'),
              multi_utl: { url: renderer.url, android_url: renderer.url, ios_url: renderer.url, pc_url: renderer.url },
              value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_continue_url'),
            },
            {
              tag: 'button',
              type: 'primary',
              text: makePlainText('Continue'),
              value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_continue_url'),
            },
          ],
        },
        buildElicitationCardActions(runId, interaction, renderer, { includeSubmit: false }),
      )
      break
    case 'form_text':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'input',
            name: renderer.field,
            required: renderer.required,
            input_type: renderer.type === 'form_text' && renderer.format === 'date-time' ? 'multiline_text' : 'text',
            ...(renderer.placeholder ? { placeholder: makePlainText(renderer.placeholder) } : {}),
            ...(renderer.defaultValue !== undefined ? { default_value: String(renderer.defaultValue) } : {}),
            ...(renderer.type === 'form_text' && renderer.maxLength !== undefined ? { max_length: renderer.maxLength } : {}),
            label: makePlainText(renderer.title),
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'form_boolean':
      card.elements.push(
        {
          tag: 'checker',
          name: renderer.field,
          checked: renderer.defaultValue ?? false,
          text: makePlainText(renderer.title),
          behaviors: [{ type: 'callback', value: buildElicitationActionValue(runId, interaction.id, renderer, 'elicitation_submit') }],
        },
        buildElicitationCardActions(runId, interaction, renderer, { includeSubmit: false }),
      )
      break
    case 'form_single_select':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'select_static',
            name: renderer.field,
            required: renderer.required,
            ...(renderer.defaultValue ? { initial_option: renderer.defaultValue } : {}),
            placeholder: makePlainText('Please select'),
            options: renderer.options.map((option) => ({
              text: makePlainText(option.label),
              value: option.value,
            })),
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'form_multi_select':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'multi_select_static',
            name: renderer.field,
            required: renderer.required,
            selected_values: renderer.defaultValue ?? [],
            placeholder: makePlainText('Select one or more'),
            options: renderer.options.map((option) => ({
              text: makePlainText(option.label),
              value: option.value,
            })),
          },
          {
            tag: 'note',
            elements: [makePlainText(`Min: ${renderer.minSelections ?? 0} · Max: ${renderer.maxSelections ?? renderer.options.length}`)],
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
    case 'generic_json_fallback':
      card.elements.push({
        tag: 'form',
        name: `elicitation_form_${interaction.id.slice(0, 12)}`,
        elements: [
          {
            tag: 'input',
            name: 'json_payload',
            required: true,
            input_type: 'multiline_text',
            rows: 3,
            auto_resize: true,
            max_rows: 6,
            placeholder: makePlainText('{"field":"value"}'),
            label: makePlainText('JSON payload'),
          },
          {
            tag: 'note',
            elements: [makePlainText('Provide a JSON object payload. The /elicitation text command still works as fallback.')],
          },
          buildElicitationCardActions(runId, interaction, renderer, { formAction: true }),
        ],
      })
      break
  }

  return {
    config: card.config as unknown as Lark.InteractiveCard['config'],
    header: card.header as unknown as Lark.InteractiveCard['header'],
    elements: card.elements as unknown as Lark.InteractiveCard['elements'],
  }
}


export const LARK_PANEL_PADDING = '6px 8px 6px 8px'
export const LARK_PANEL_BORDER = { color: 'grey', corner_radius: '5px' } as const
export const TOOL_USE_STEP_CONTENT_INDENT = '0px 0px 0px 22px'

export function createLarkDivMarkdown(content: string, options: { textSize?: 'notation' | 'normal_v2'; margin?: string } = {}): Record<string, unknown> {
  return {
    tag: 'div',
    ...(options.margin ? { margin: options.margin } : {}),
    text: {
      tag: 'lark_md',
      content: optimizeLarkMarkdownStyle(content),
      ...(options.textSize ? { text_size: options.textSize } : {}),
    },
  }
}

export function createLarkDivPlainText(content: string, options: { textSize?: 'notation' | 'normal_v2'; margin?: string; textColor?: 'grey' } = {}): Record<string, unknown> {
  return {
    tag: 'div',
    ...(options.margin ? { margin: options.margin } : {}),
    text: {
      tag: 'plain_text',
      content,
      ...(options.textColor ? { text_color: options.textColor } : {}),
      ...(options.textSize ? { text_size: options.textSize } : {}),
    },
  }
}

export function createLarkSectionPanel(params: {
  title: string
  titleEmoji?: string
  body?: string
  bodyTag?: 'markdown' | 'plain'
  bodyMargin?: string
  verticalSpacing?: '4px' | '8px'
  elements?: unknown[]
}): Record<string, unknown> {
  const title = params.titleEmoji ? `${params.titleEmoji} ${params.title}` : params.title
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: title,
        text_color: 'grey',
        text_size: 'notation',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: LARK_PANEL_BORDER,
    vertical_spacing: params.verticalSpacing ?? '4px',
    padding: LARK_PANEL_PADDING,
    elements: params.elements ?? (params.body
      ? [params.bodyTag === 'plain'
        ? createLarkDivPlainText(params.body, { textSize: 'notation', textColor: 'grey', ...(params.bodyMargin ? { margin: params.bodyMargin } : {}) })
        : createLarkDivMarkdown(params.body, { textSize: 'notation', ...(params.bodyMargin ? { margin: params.bodyMargin } : {}) })]
      : []),
  }
}

export function longestBacktickRun(value: string): number {
  const matches = value.match(/`+/g) ?? []
  return matches.reduce((max, run) => Math.max(max, run.length), 0)
}

export function formatLarkCodeBlock(content: string, language: 'json' | 'text' = 'text'): string {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(normalized) + 1))
  return `${fence}${language}\n${normalized}\n${fence}`
}

export function buildLarkToolTitle(name: string): string {
  return name || 'unknown_tool'
}

export function buildLarkToolInputDetail(input?: unknown): string {
  const inputText = stringifyStructuredValue(input).trim().replace(/\s+/g, ' ')
  if (!inputText) return ''
  return inputText.length > 240 ? `${inputText.slice(0, 240)}…` : inputText
}

export function createLarkThinkingPanel(body: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Thinking',
    titleEmoji: '💭',
    body,
    verticalSpacing: '4px',
  })
}

export function createLarkToolPanel(name: string, input?: unknown, resultText?: string): Record<string, unknown> {
  const elements: unknown[] = [
    createLarkDivMarkdown(`**${buildLarkToolTitle(name)}**`, { textSize: 'notation' }),
  ]

  const detail = buildLarkToolInputDetail(input)
  if (detail) {
    elements.push(createLarkDivPlainText(detail, {
      textSize: 'notation',
      textColor: 'grey',
      margin: TOOL_USE_STEP_CONTENT_INDENT,
    }))
  }

  if (resultText) {
    elements.push(createLarkDivMarkdown(`**Result**\n${formatLarkCodeBlock(resultText)}`, {
      textSize: 'notation',
      margin: TOOL_USE_STEP_CONTENT_INDENT,
    }))
  }

  return createLarkSectionPanel({
    title: 'Tool',
    titleEmoji: '🛠️',
    verticalSpacing: '4px',
    elements,
  })
}

export function createLarkToolResultPanel(resultText: string): Record<string, unknown> {
  return createLarkSectionPanel({
    title: 'Tool Result',
    titleEmoji: '🧾',
    body: `**Result**\n${formatLarkCodeBlock(resultText)}`,
    verticalSpacing: '4px',
  })
}

export function createLarkSectionMarkdown(title: string, body: string): Record<string, unknown> {
  return createLarkSectionPanel({ title, body, verticalSpacing: '4px' })
}

export function buildLarkToolUseLabel(name: string, input?: unknown): string {
  const safeName = name || 'unknown_tool'
  const inputText = stringifyStructuredValue(input).trim().replace(/\s+/g, ' ')
  if (!inputText) return safeName
  const compact = inputText.length > 160 ? `${inputText.slice(0, 160)}…` : inputText
  return `${safeName}(${compact})`
}

export function buildLarkToolResultText(fragment: DisplayFragment & { type: 'tool_result' }): string {
  if (fragment.display?.previewText) return fragment.display.previewText
  return stringifyStructuredValue(fragment.output).trim()
}

export function buildLarkAssistantElements(item: AssistantDisplayItem): unknown[] {
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
      if (text) {
        elements.push(createLarkThinkingPanel(text))
      }
      continue
    }

    if (fragment.type === 'tool_use') {
      elements.push(createLarkToolPanel(fragment.name, fragment.input))
      continue
    }

    if (fragment.type === 'tool_result') {
      const resultText = buildLarkToolResultText(fragment)
      if (resultText) {
        elements.push(createLarkToolResultPanel(resultText))
      }
      continue
    }

    if (fragment.type === 'summary') {
      const text = fragment.text.trim()
      if (text) {
        elements.push(createLarkSectionMarkdown('Summary', text))
      }
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

export function buildLarkGroupedToolUseElements(item: GroupedToolUseDisplayItem): unknown[] {
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

export function buildLarkCollapsedToolBatchElements(item: CollapsedToolBatchDisplayItem): unknown[] {
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


export const STREAMING_CARD_ELEMENT_ID = 'streaming_content'

export function buildAssistantStreamingCard(params: {
  answerText: string
  thinkingText?: string
  toolCalls?: string[]
  toolResults?: string[]
  footer?: DisplayAssistantFooter
  isFinal?: boolean
}): Record<string, unknown> {
  const mainContent = optimizeLarkMarkdownStyle(params.answerText || params.thinkingText || (params.isFinal ? 'Done.' : 'Processing...'))
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

