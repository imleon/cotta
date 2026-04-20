import type {
  PendingInteraction,
  PermissionInteraction,
  PermissionSuggestion,
  SdkElicitationInteraction,
} from '../../contract/runtime'
import type { SessionInteractionResponseInput } from '../../api/sessions'
import type {
  TimelineElicitationInteraction,
  TimelineInteractionResponse,
  TimelinePendingInteraction,
  TimelinePermissionInteraction,
  TimelinePermissionSuggestion,
} from '../../models/interaction'

function getPermissionSuggestionKey(suggestion: Pick<PermissionSuggestion, 'action' | 'scope'>, index = 0): string {
  return `${suggestion.scope || 'once'}::${suggestion.action}::${index}`
}

function mapPermissionSuggestion(suggestion: PermissionSuggestion, index: number): TimelinePermissionSuggestion {
  return {
    key: getPermissionSuggestionKey(suggestion, index),
    action: suggestion.action,
    ...(suggestion.label !== undefined ? { label: suggestion.label } : {}),
    ...(suggestion.description !== undefined ? { description: suggestion.description } : {}),
    ...(suggestion.scope !== undefined ? { scope: suggestion.scope } : {}),
  }
}

function mapPermissionInteraction(interaction: PermissionInteraction): TimelinePermissionInteraction {
  return {
    id: interaction.id,
    kind: 'permission',
    status: interaction.status,
    source: interaction.source,
    ...(interaction.blocksRun !== undefined ? { blocksRun: interaction.blocksRun } : {}),
    toolName: interaction.toolName,
    input: { ...interaction.input },
    ...(interaction.title !== undefined ? { title: interaction.title } : {}),
    ...(interaction.displayName !== undefined ? { displayName: interaction.displayName } : {}),
    ...(interaction.description !== undefined ? { description: interaction.description } : {}),
    ...(interaction.decisionReason !== undefined ? { decisionReason: interaction.decisionReason } : {}),
    ...(interaction.blockedPath !== undefined ? { blockedPath: interaction.blockedPath } : {}),
    ...(interaction.toolUseId !== undefined ? { toolUseId: interaction.toolUseId } : {}),
    ...(interaction.agentId !== undefined ? { agentId: interaction.agentId } : {}),
    ...(interaction.permissionSuggestions
      ? { permissionSuggestions: interaction.permissionSuggestions.map((suggestion, index) => mapPermissionSuggestion(suggestion, index)) }
      : {}),
  }
}

function mapElicitationInteraction(interaction: SdkElicitationInteraction): TimelineElicitationInteraction {
  return {
    id: interaction.id,
    kind: 'elicitation',
    status: interaction.status,
    source: interaction.source,
    ...(interaction.blocksRun !== undefined ? { blocksRun: interaction.blocksRun } : {}),
    serverName: interaction.serverName,
    message: interaction.message,
    ...(interaction.toolUseId !== undefined ? { toolUseId: interaction.toolUseId } : {}),
    ...(interaction.mode !== undefined ? { mode: interaction.mode } : {}),
    ...(interaction.url !== undefined ? { url: interaction.url } : {}),
    ...(interaction.requestedSchema !== undefined ? { requestedSchema: interaction.requestedSchema } : {}),
  }
}

export function mapPendingInteraction(
  interaction: PendingInteraction | null | undefined,
): TimelinePendingInteraction | null {
  if (!interaction) return null
  return interaction.kind === 'permission'
    ? mapPermissionInteraction(interaction)
    : mapElicitationInteraction(interaction)
}

export function buildSessionInteractionResponseInput(
  response: TimelineInteractionResponse,
  interaction: PendingInteraction,
): SessionInteractionResponseInput {
  if (response.kind === 'elicitation') {
    return {
      kind: 'elicitation',
      requestId: interaction.id,
      response: {
        action: response.action,
        ...(response.content ? { content: response.content } : {}),
      },
    }
  }

  const permissionInteraction = interaction.kind === 'permission' ? interaction : null
  const selectedSuggestion = response.selectedSuggestionKey && permissionInteraction?.permissionSuggestions
    ? permissionInteraction.permissionSuggestions.find((suggestion, index) =>
        getPermissionSuggestionKey(suggestion, index) === response.selectedSuggestionKey)
    : undefined

  return {
    kind: 'permission',
    requestId: interaction.id,
    response: {
      decision: response.decision,
      ...(selectedSuggestion !== undefined ? { selectedSuggestion: selectedSuggestion.raw } : {}),
      ...(response.content ? { content: response.content } : {}),
    },
  }
}
