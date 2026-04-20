import type {
  PermissionSuggestion,
  InteractiveSource,
} from '../contract/runtime'

export interface TimelinePermissionSuggestion {
  key: string
  action: PermissionSuggestion['action']
  label?: string
  description?: string
  scope?: string
}

export interface TimelineInteractionBase {
  id: string
  kind: 'permission' | 'elicitation'
  status: 'pending' | 'resolved' | 'cancelled'
  source: InteractiveSource
  blocksRun?: boolean
}

export interface TimelinePermissionInteraction extends TimelineInteractionBase {
  kind: 'permission'
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  toolUseId?: string
  agentId?: string
  permissionSuggestions?: TimelinePermissionSuggestion[]
}

export interface TimelineElicitationInteraction extends TimelineInteractionBase {
  kind: 'elicitation'
  toolUseId?: string
  serverName: string
  message: string
  mode?: string
  url?: string
  requestedSchema?: unknown
}

export type TimelinePendingInteraction =
  | TimelinePermissionInteraction
  | TimelineElicitationInteraction

export type TimelineInteractionResponse =
  | {
      kind: 'permission'
      decision: 'approve' | 'deny'
      selectedSuggestionKey?: string
      content?: Record<string, string | number | boolean | string[]>
    }
  | {
      kind: 'elicitation'
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }
