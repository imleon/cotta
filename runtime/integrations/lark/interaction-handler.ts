import type * as Lark from '@larksuiteoapi/node-sdk'
import type { Orchestrator } from '../../orchestration/orchestrator.js'
import type { SessionRegistry } from '../../orchestration/session-registry.js'
import type { ChannelConfig } from '../../config/schema.js'
import type { PendingInteraction } from '../../protocol/control-types.js'
import {
  buildPermissionCard,
  buildPermissionResolvedCard,
  wrapLarkCardResponse,
} from './helpers.js'
import { asRecord, asString, parseLarkInteractionCommand, truncateText } from './helpers.js'
import type { LarkCardActionEvent, LarkInteractionCommand, LarkReplyContext } from './helpers.js'
import {
  buildElicitationContent,
  buildElicitationContentForObject,
  inferElicitationRenderer,
  type ElicitationRenderer,
} from '../../render/elicitation-renderer.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type SendText = (channel: ChannelConfig, text: string, replyContext?: LarkReplyContext) => Promise<void>
type SendCard = (channel: ChannelConfig, card: Lark.InteractiveCard, replyContext?: LarkReplyContext) => Promise<string | undefined>

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true
  if (['false', 'no', 'n', '0'].includes(normalized)) return false
  return null
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch (_parseError) {
    // ignore: non-JSON or malformed input returns null
  }
  return null
}

function formatElicitationPrompt(requestId: string, renderer: ElicitationRenderer): string {
  const title = renderer.title || 'Interaction required'
  const description = renderer.description ? `\n${renderer.description}` : ''
  const header = `**${title}**${description}\n\nRequest: \`${requestId}\``

  switch (renderer.type) {
    case 'url_open':
      return `${header}\n\nOpen: ${renderer.url}`
    case 'form_text':
      return `${header}\n\nReply with:\n- \`/answer ${requestId} <value>\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\``
    case 'form_boolean':
      return `${header}\n\nReply with:\n- \`/answer ${requestId} true|false\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\``
    case 'form_single_select':
      return `${header}\n\nOptions: ${renderer.options.map((o) => o.value).join(', ')}\n\nReply with:\n- \`/answer ${requestId} <option>\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\``
    case 'form_multi_select':
      return `${header}\n\nOptions: ${renderer.options.map((o) => o.value).join(', ')}\n\nReply with:\n- \`/answer ${requestId} a,b,c\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\``
    case 'form_object':
      return `${header}\n\nThis interaction requires multiple fields.\nReply with:\n- \`/answer-json ${requestId} <json>\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\`\n\nExample:\n\`\`\`json\n{}\n\`\`\``
    case 'generic_json_fallback':
      return `${header}\n\nReply with:\n- \`/answer-json ${requestId} <json>\`\n- \`/decline ${requestId}\`\n- \`/cancel ${requestId}\``
  }
}

function tryBuildElicitationContent(renderer: ElicitationRenderer | null, command: Extract<LarkInteractionCommand, { type: 'elicitation' }>): Record<string, unknown> | null {
  if (command.action !== 'accept') return null
  const raw = command.payload ?? ''
  if (!raw.trim()) return null

  if (!renderer) {
    if (command.payloadFormat === 'json') {
      return parseJsonObject(raw)
    }
    return { value: raw }
  }

  switch (renderer.type) {
    case 'form_text': {
      if (renderer.valueType === 'number' || renderer.valueType === 'integer') {
        const n = Number(raw)
        if (!Number.isFinite(n)) return null
        return buildElicitationContent(renderer, renderer.valueType === 'integer' ? Math.trunc(n) : n)
      }
      return buildElicitationContent(renderer, raw)
    }
    case 'form_boolean': {
      const b = parseBoolean(raw)
      if (b === null) return null
      return buildElicitationContent(renderer, b)
    }
    case 'form_single_select': {
      const normalized = raw.trim()
      const match = renderer.options.find((opt) => opt.value === normalized || opt.label === normalized)
      if (!match) return null
      return buildElicitationContent(renderer, match.value)
    }
    case 'form_multi_select': {
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
      if (parts.length === 0) return null
      const selected = parts
        .map((item) => renderer.options.find((opt) => opt.value === item || opt.label === item)?.value)
        .filter((v): v is string => typeof v === 'string')
      if (selected.length === 0) return null
      return buildElicitationContent(renderer, selected)
    }
    case 'form_object': {
      const obj = parseJsonObject(raw)
      if (!obj) return null
      return buildElicitationContentForObject(renderer, obj)
    }
    case 'generic_json_fallback': {
      return parseJsonObject(raw)
    }
    case 'url_open':
      return null
  }
}

export class LarkInteractionHandler {
  private readonly deliveredInteractionIds = new Set<string>()
  private readonly handledCardActions = new Set<string>()
  private readonly elicitationRenderersByRequestId = new Map<string, ElicitationRenderer>()

  constructor(private readonly deps: {
    orchestrator: Orchestrator
    sessionRegistry: SessionRegistry
    logger: Logger
    sendText: SendText
    sendCard: SendCard
  }) {}

  parseCommand(text: string): LarkInteractionCommand | null {
    return parseLarkInteractionCommand(text)
  }

  async handleCommand(
    channel: ChannelConfig,
    command: LarkInteractionCommand,
    replyContext?: LarkReplyContext,
  ): Promise<boolean> {
    if (command.type === 'invalid') {
      await this.deps.sendText(channel, `Invalid ${command.scope} command: ${command.reason}`, replyContext)
      return true
    }

    if (command.type === 'permission') {
      const targetSessionId = command.sessionId || this.deps.sessionRegistry.findByChannelId(channel.channelId)?.sessionId
      if (!targetSessionId) {
        await this.deps.sendText(channel, 'No current session is bound to this conversation.', replyContext)
        return true
      }

      try {
        await this.deps.orchestrator.respondToInteraction({
          sessionId: targetSessionId,
          requestId: command.requestId,
          kind: 'permission',
          response: { decision: command.decision },
        })
        await this.deps.sendText(channel, `Permission response recorded: ${command.decision}`, replyContext)
      } catch (error) {
        this.deps.logger.warn('lark:permission-response:missing', {
          sessionId: targetSessionId,
          requestId: command.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
        await this.deps.sendText(channel, 'No matching active permission request was found.', replyContext)
      }
      return true
    }

    if (command.type === 'elicitation') {
      const targetSessionId = command.sessionId || this.deps.sessionRegistry.findByChannelId(channel.channelId)?.sessionId
      if (!targetSessionId) {
        await this.deps.sendText(channel, 'No current session is bound to this conversation.', replyContext)
        return true
      }

      const renderer = this.elicitationRenderersByRequestId.get(command.requestId) ?? null
      const content = tryBuildElicitationContent(renderer, command)
      if (command.action === 'accept' && !content) {
        await this.deps.sendText(channel, 'Invalid elicitation response. Use /answer or /answer-json with the requested fields.', replyContext)
        return true
      }

      try {
        await this.deps.orchestrator.respondToInteraction({
          sessionId: targetSessionId,
          requestId: command.requestId,
          kind: 'elicitation',
          response: {
            action: command.action,
            ...(content ? { content } : {}),
          },
        })
        await this.deps.sendText(channel, `Elicitation response recorded: ${command.action}`, replyContext)
      } catch (error) {
        this.deps.logger.warn('lark:elicitation-response:error', {
          sessionId: targetSessionId,
          requestId: command.requestId,
          action: command.action,
          error: error instanceof Error ? error.message : String(error),
        })
        await this.deps.sendText(channel, 'No matching active elicitation request was found.', replyContext)
      }
      return true
    }

    return false
  }

  async handleAwaitingUser(
    sessionId: string,
    channel: ChannelConfig,
    interaction: PendingInteraction,
    replyContext?: LarkReplyContext,
  ): Promise<boolean> {
    if (this.deliveredInteractionIds.has(interaction.id)) return true
    this.deliveredInteractionIds.add(interaction.id)

    if (interaction.kind === 'permission') {
      await this.deps.sendCard(channel, buildPermissionCard(sessionId, {
        id: interaction.id,
        toolName: interaction.toolName,
        title: interaction.title,
        displayName: interaction.displayName,
        description: interaction.description,
        decisionReason: interaction.decisionReason,
        blockedPath: interaction.blockedPath,
        toolUseId: interaction.toolUseId,
        agentId: interaction.agentId,
        suggestions: interaction.permissionSuggestions?.map((raw) => ({
          toolName: interaction.toolName,
          command: typeof raw === 'object' && raw && 'type' in raw ? JSON.stringify(raw) : '',
          label: typeof raw === 'object' && raw && 'label' in raw ? String((raw as unknown as Record<string, unknown>).label) : undefined,
        })),
      }), replyContext)
      return true
    }

    if (interaction.kind === 'elicitation') {
      const renderer = inferElicitationRenderer(interaction)
      this.elicitationRenderersByRequestId.set(interaction.id, renderer)
      const prompt = truncateText(formatElicitationPrompt(interaction.id, renderer), 3500)
      await this.deps.sendText(channel, prompt, replyContext)
      return true
    }

    return false
  }

  async handleCardAction(body: unknown): Promise<{ status: number; payload: unknown } | null> {
    const record = asRecord(body)
    if (!record) return { status: 400, payload: { error: 'Invalid request body' } }
    if ('challenge' in record) {
      return { status: 200, payload: { challenge: (record as Record<string, unknown>).challenge } }
    }

    const data = record as LarkCardActionEvent
    const actionValue = asRecord(data.action?.value)
    const actionType = asString(actionValue?.actionType)
    const sessionId = asString(actionValue?.sessionId)
    const requestId = asString(actionValue?.requestId)
    const decision = actionValue?.decision === 'approve' || actionValue?.decision === 'deny'
      ? actionValue.decision
      : null
    const actionKey = [asString(data.open_message_id), actionType, sessionId, requestId, decision ?? ''].join(':')

    if (!actionType || !sessionId || !requestId) {
      this.deps.logger.warn('lark:card-action:invalid', {
        keys: Object.keys(record),
        actionType,
        sessionId,
        requestId,
      })
      return {
        status: 200,
        payload: {
          toast: {
            type: 'error',
            content: 'Invalid card action.',
          },
        },
      }
    }

    if (this.handledCardActions.has(actionKey)) {
      return {
        status: 200,
        payload: {
          toast: {
            type: 'info',
            content: 'This action was already handled.',
          },
        },
      }
    }
    this.handledCardActions.add(actionKey)

    if (actionType === 'permission') {
      if (!decision) {
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'Invalid permission action.',
            },
          },
        }
      }

      try {
        await this.deps.orchestrator.respondToInteraction({
          sessionId,
          requestId,
          kind: 'permission',
          response: { decision },
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'success',
              content: decision === 'approve' ? 'Permission approved.' : 'Permission denied.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard(decision, true)),
          },
        }
      } catch (error) {
        this.deps.logger.warn('lark:card-action:permission:error', {
          sessionId,
          requestId,
          decision,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'No matching active permission request was found.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard(decision, false)),
          },
        }
      }
    }

    if (actionType === 'control_cancel') {
      try {
        await this.deps.orchestrator.cancelControl({ sessionId, requestId })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'success',
              content: 'Permission request cancelled.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard('cancel', true)),
          },
        }
      } catch (error) {
        this.deps.logger.warn('lark:card-action:cancel:error', {
          sessionId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          status: 200,
          payload: {
            toast: {
              type: 'error',
              content: 'No matching active permission request was found.',
            },
            ...wrapLarkCardResponse(buildPermissionResolvedCard('cancel', false)),
          },
        }
      }
    }

    return {
      status: 200,
      payload: {
        toast: {
          type: 'error',
          content: 'Unsupported card action.',
        },
      },
    }
  }
}

