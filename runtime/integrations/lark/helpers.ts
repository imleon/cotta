import * as Lark from '@larksuiteoapi/node-sdk'
import type { ConfigRegistry } from '../../config/registry.js'
import type { ChannelConfig, ConnectorConfig } from '../../config/schema.js'
import type { DisplayAssistantFooter, PermissionInteraction } from '../../protocol/index.js'
import { buildAssistantStreamingCard } from './card-builder.js'
import type { LarkStreamingBuildCardParams } from './streaming-controller.js'

export type LarkConnectorRuntimeConfig = {
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
  botName?: string
}

export type LarkReceiveEvent = {
  sender: {
    sender_type: string
    sender_id?: {
      open_id?: string
    }
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time?: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
  }
}

export type LarkCardActionEvent = {
  open_message_id?: string
  action?: {
    value?: Record<string, unknown>
  }
}

export type LarkReplyContext = {
  replyToMessageId?: string
  chatType?: 'group' | 'p2p'
  senderOpenId?: string
}

export type LarkInteractionCommand =
  | { type: 'permission'; sessionId?: string; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'elicitation'; sessionId?: string; requestId: string; action: 'accept' | 'decline' | 'cancel'; payload?: string; payloadFormat?: 'text' | 'json' }
  | { type: 'session'; action: 'current' | 'clear' | 'new' | 'use'; sessionId?: string }
  | { type: 'stop' }
  | { type: 'invalid'; scope: 'permission' | 'session' | 'elicitation'; reason: string }

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isEventExpired(createTime?: string, expiryMs: number = 30 * 60 * 1000): boolean {
  if (!createTime) return false
  const value = Number(createTime)
  if (!Number.isFinite(value)) return false
  return Date.now() - value > expiryMs
}

export function formatPermissionSuggestions(suggestions?: Array<{
  label?: string
  action?: string
  description?: string
  scope?: string
}>): string[] {
  if (!suggestions || suggestions.length === 0) return []
  return suggestions.map((suggestion) => {
    const label = suggestion.label || suggestion.action
    const details = [suggestion.description, suggestion.scope].filter(Boolean).join(' · ')
    return details ? `- ${label}: ${details}` : `- ${label}`
  })
}

export function formatPermissionMetadata(interaction: PermissionInteraction): string[] {
  return [
    interaction.decisionReason ? `Why Claude asked: ${interaction.decisionReason}` : '',
    interaction.blockedPath ? `Path: ${interaction.blockedPath}` : '',
    interaction.toolUseId ? `Tool use: ${interaction.toolUseId}` : '',
    interaction.agentId ? `Agent: ${interaction.agentId}` : '',
  ].filter(Boolean)
}

export function parseLarkInteractionCommand(text: string): LarkInteractionCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const answerJsonCurrent = trimmed.match(/^\/answer-json\s+(\S+)\s+([\s\S]+)$/)
  if (answerJsonCurrent) {
    return {
      type: 'elicitation',
      requestId: answerJsonCurrent[1],
      action: 'accept',
      payload: answerJsonCurrent[2],
      payloadFormat: 'json',
    }
  }

  const answerJsonSession = trimmed.match(/^\/answer-json\s+(\S+)\s+(\S+)\s+([\s\S]+)$/)
  if (answerJsonSession) {
    return {
      type: 'elicitation',
      sessionId: answerJsonSession[1],
      requestId: answerJsonSession[2],
      action: 'accept',
      payload: answerJsonSession[3],
      payloadFormat: 'json',
    }
  }

  const answerCurrent = trimmed.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/)
  if (answerCurrent) {
    return {
      type: 'elicitation',
      requestId: answerCurrent[1],
      action: 'accept',
      payload: answerCurrent[2],
      payloadFormat: 'text',
    }
  }

  const answerSession = trimmed.match(/^\/answer\s+(\S+)\s+(\S+)\s+([\s\S]+)$/)
  if (answerSession) {
    return {
      type: 'elicitation',
      sessionId: answerSession[1],
      requestId: answerSession[2],
      action: 'accept',
      payload: answerSession[3],
      payloadFormat: 'text',
    }
  }

  const declineCurrent = trimmed.match(/^\/decline\s+(\S+)$/)
  if (declineCurrent) {
    return { type: 'elicitation', requestId: declineCurrent[1], action: 'decline' }
  }
  const declineSession = trimmed.match(/^\/decline\s+(\S+)\s+(\S+)$/)
  if (declineSession) {
    return { type: 'elicitation', sessionId: declineSession[1], requestId: declineSession[2], action: 'decline' }
  }

  const cancelCurrent = trimmed.match(/^\/cancel\s+(\S+)$/)
  if (cancelCurrent) {
    return { type: 'elicitation', requestId: cancelCurrent[1], action: 'cancel' }
  }
  const cancelSession = trimmed.match(/^\/cancel\s+(\S+)\s+(\S+)$/)
  if (cancelSession) {
    return { type: 'elicitation', sessionId: cancelSession[1], requestId: cancelSession[2], action: 'cancel' }
  }

  const permissionCurrentMatch = trimmed.match(/^\/permission\s+(\S+)\s+(approve|deny)$/)
  if (permissionCurrentMatch) {
    return {
      type: 'permission',
      requestId: permissionCurrentMatch[1],
      decision: permissionCurrentMatch[2] as 'approve' | 'deny',
    }
  }

  const permissionSessionMatch = trimmed.match(/^\/permission\s+(\S+)\s+(\S+)\s+(approve|deny)$/)
  if (permissionSessionMatch) {
    return {
      type: 'permission',
      sessionId: permissionSessionMatch[1],
      requestId: permissionSessionMatch[2],
      decision: permissionSessionMatch[3] as 'approve' | 'deny',
    }
  }

  if (trimmed === '/session current') return { type: 'session', action: 'current' }
  if (trimmed === '/session clear') return { type: 'session', action: 'clear' }
  if (trimmed === '/session new') return { type: 'session', action: 'new' }

  const sessionUseMatch = trimmed.match(/^\/session\s+use\s+(\S+)$/)
  if (sessionUseMatch) {
    return { type: 'session', action: 'use', sessionId: sessionUseMatch[1] }
  }

  if (trimmed === '/stop') return { type: 'stop' }

  if (trimmed.startsWith('/permission')) {
    return {
      type: 'invalid',
      scope: 'permission',
      reason: 'use /permission <requestId> approve|deny or /permission <sessionId> <requestId> approve|deny',
    }
  }

  if (trimmed.startsWith('/answer') || trimmed.startsWith('/decline') || trimmed.startsWith('/cancel')) {
    return {
      type: 'invalid',
      scope: 'elicitation',
      reason: 'use /answer <requestId> <value> | /answer-json <requestId> <json> | /decline <requestId> | /cancel <requestId>',
    }
  }

  if (trimmed.startsWith('/session')) {
    return {
      type: 'invalid',
      scope: 'session',
      reason: 'use /session current | /session use <sessionId> | /session clear | /session new',
    }
  }

  return null
}

export function buildStreamingCardDocumentFromParams(params: LarkStreamingBuildCardParams): Record<string, unknown> {
  return buildAssistantStreamingCard(params)
}

export function buildLarkReplyPrefix(context?: LarkReplyContext): { textPrefix?: string; cardPrefix?: string } {
  if (!context?.replyToMessageId || context.chatType !== 'group' || !context.senderOpenId) {
    return {}
  }
  return {
    textPrefix: `<at user_id="${context.senderOpenId}"></at>`,
    cardPrefix: `<at id=${context.senderOpenId}></at>`,
  }
}

export function applyLarkReplyMentionToText(text: string, context?: LarkReplyContext): string {
  const prefix = buildLarkReplyPrefix(context).textPrefix
  return prefix ? `${prefix}\n${text}` : text
}

export function applyLarkReplyMentionToCard(card: Lark.InteractiveCard, context?: LarkReplyContext): Lark.InteractiveCard {
  const prefix = buildLarkReplyPrefix(context).cardPrefix
  if (!prefix || !Array.isArray(card.elements)) return card
  const first = card.elements[0]
  if (first && typeof first === 'object' && (first as unknown as Record<string, unknown>).element_id === 'reply_mention') {
    return card
  }
  return {
    ...card,
    elements: [
      {
        tag: 'markdown',
        content: prefix,
        element_id: 'reply_mention',
      } as any, // any: Lark SDK card element union is too broad for this lightweight injected block
      ...card.elements,
    ] as any, // any: preserve existing SDK card element array shape without duplicating SDK internals
  }
}

export function buildFooterFromResultPayload(payload: unknown, completedAt: number): DisplayAssistantFooter | null {
  const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  if (!result) return null
  const usage = result.usage && typeof result.usage === 'object'
    ? result.usage as Record<string, unknown>
    : null
  const modelUsage = result.modelUsage && typeof result.modelUsage === 'object'
    ? result.modelUsage as Record<string, unknown>
    : null
  const model = modelUsage ? Object.keys(modelUsage).find((key) => key.trim().length > 0) ?? undefined : undefined
  return {
    completedAt,
    ...(typeof result.stop_reason === 'string' ? { stopReason: result.stop_reason } : {}),
    ...(usage ? {
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
        cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
      },
    } : {}),
    ...(model ? { model } : {}),
  }
}

export function hasMeaningfulFooterUsage(usage: DisplayAssistantFooter['usage'] | null | undefined): boolean {
  if (!usage) return false
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .some((value) => typeof value === 'number' && value > 0)
}

export function hasMeaningfulFooter(footer: DisplayAssistantFooter | null | undefined): footer is DisplayAssistantFooter {
  if (!footer) return false
  return hasMeaningfulFooterUsage(footer.usage) || Boolean(footer.stopReason) || Boolean(footer.model)
}

export function getProjectDirs(configRegistry: ConfigRegistry): string[] {
  const dirs = configRegistry.listAgents().map((agent) => agent.projectDir.trim()).filter(Boolean)
  return [...new Set(dirs)]
}

export function parseConnectorConfig(connector: ConnectorConfig): LarkConnectorRuntimeConfig | null {
  if (connector.connectorType !== 'lark') return null
  const config = asRecord(connector.connectorConfig)
  if (!config) return null
  const appId = typeof config.appId === 'string' ? config.appId.trim() : ''
  const appSecret = typeof config.appSecret === 'string' ? config.appSecret.trim() : ''
  if (!appId || !appSecret) return null
  return {
    appId,
    appSecret,
    encryptKey: typeof config.encryptKey === 'string' ? config.encryptKey.trim() : undefined,
    verificationToken: typeof config.verificationToken === 'string' ? config.verificationToken.trim() : undefined,
    botName: typeof config.botName === 'string' ? config.botName.trim() : undefined,
  }
}

export function parseLarkTextContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text.trim() : raw.trim()
  } catch (_parseError) {
    return raw.trim()
  }
}

export function truncateText(value: string, maxChars: number = 4000): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 32))}\n\n[内容过长，已截断]`
}

export function wrapLarkCardResponse(card: Lark.InteractiveCard): { card: Lark.InteractiveCard } {
  return { card }
}

function buildPermissionStatusCard(title: string, message: string, template: 'green' | 'red' | 'grey'): Lark.InteractiveCard {
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

export function buildPermissionResolvedCard(decision: 'approve' | 'deny' | 'cancel', ok: boolean): Lark.InteractiveCard {
  const approved = ok && decision === 'approve'
  const denied = ok && decision === 'deny'
  const cancelled = ok && decision === 'cancel'
  return buildPermissionStatusCard(
    ok
      ? (approved ? 'Permission approved' : denied ? 'Permission denied' : 'Permission cancelled')
      : 'Permission unavailable',
    ok
      ? (approved
          ? 'Claude can continue with this action.'
          : denied
            ? 'Claude will not continue with this action.'
            : 'This permission request was cancelled.')
      : 'No matching active permission request was found.',
    approved ? 'green' : denied ? 'red' : 'grey',
  )
}

export function buildPermissionCard(sessionId: string, interaction: {
  id: string
  toolName: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  toolUseId?: string
  agentId?: string
  suggestions?: Array<{ toolName?: string; command?: string; label?: string }>
}): Lark.InteractiveCard {
  const title = interaction.title || interaction.displayName || interaction.toolName || 'Tool permission'
  const description = interaction.description || 'Claude requests permission to continue.'
  const metadataLines = formatPermissionMetadata({
    kind: 'permission',
    id: interaction.id,
    status: 'pending',
    source: { kind: 'host', subtype: 'lark' },
    toolName: interaction.toolName,
    input: {},
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.displayName ? { displayName: interaction.displayName } : {}),
    ...(interaction.description ? { description: interaction.description } : {}),
    ...(interaction.decisionReason ? { decisionReason: interaction.decisionReason } : {}),
    ...(interaction.blockedPath ? { blockedPath: interaction.blockedPath } : {}),
    ...(interaction.toolUseId ? { toolUseId: interaction.toolUseId } : {}),
    ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
  })
  const suggestionLines = Array.isArray(interaction.suggestions)
    ? interaction.suggestions.slice(0, 5).map((item) => {
        const label = asString(item.label) || asString(item.toolName) || 'Suggested action'
        const command = asString(item.command)
        return {
          action: label,
          label,
          description: command ? `\`${command}\`` : '',
        }
      })
    : []
  const formattedSuggestionLines = formatPermissionSuggestions(suggestionLines)

  const elements: Array<Record<string, unknown>> = [
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
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: metadataLines.join('\n'),
      },
    })
  }

  if (formattedSuggestionLines.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Suggested action**\n${formattedSuggestionLines.join('\n')}`,
      },
    })
  }

  elements.push(
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'primary',
          text: {
            tag: 'plain_text',
            content: 'Approve',
          },
          value: {
            actionType: 'permission',
            sessionId,
            requestId: interaction.id,
            decision: 'approve',
          },
        },
        {
          tag: 'button',
          type: 'danger',
          text: {
            tag: 'plain_text',
            content: 'Deny',
          },
          value: {
            actionType: 'permission',
            sessionId,
            requestId: interaction.id,
            decision: 'deny',
          },
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Cancel request',
          },
          value: {
            actionType: 'control_cancel',
            sessionId,
            requestId: interaction.id,
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

export function listLarkConnectors(configRegistry: ConfigRegistry): ConnectorConfig[] {
  return configRegistry
    .listConnectors()
    .filter((connector) => connector.connectorType === 'lark' && parseConnectorConfig(connector))
}

export function listEnabledLarkChannels(configRegistry: ConfigRegistry): ChannelConfig[] {
  return configRegistry
    .listChannels()
    .filter((channel) => {
      if (!channel.enabled) return false
      const connector = configRegistry.getConnector(channel.connectorId)
      return connector?.connectorType === 'lark'
    })
}

export function findLarkChannelByConversationKey(
  configRegistry: ConfigRegistry,
  conversationKey: string,
): ChannelConfig | null {
  return listEnabledLarkChannels(configRegistry).find((channel) => channel.channelKey === conversationKey) ?? null
}
