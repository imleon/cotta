export type SessionStatus = 'idle' | 'running' | 'requires_action'
export type SessionScope = 'managed' | 'foreign'

export type RunTerminalStatus =
  | 'success'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'

export type RunStatus = 'running' | 'requires_action' | RunTerminalStatus

export interface AgentTemplate {
  agentId: string
  projectDir: string
  model?: string
  permissionMode?: string
  allowTools?: string[]
  allowSkills?: string[]
  mcpServers?: Record<string, unknown>
  env?: Record<string, string>
  promptConfig?: Record<string, unknown>
}

export interface SessionRecord {
  sessionId: string
  agentId: string
  sessionScope: SessionScope
  channelId?: string
  workerRef?: string
  workerConfigSig?: string
  sessionStatus?: SessionStatus
  activeRunId?: string
  createdAt: number
  updatedAt: number
}

export interface PendingActionRecord {
  kind: 'can_use_tool' | 'elicitation'
  [key: string]: unknown
}

export interface ResultSummaryRecord {
  kind: RunTerminalStatus
  message?: string
  title?: string
  brief?: string
  usage?: unknown
  costUsd?: number
  durationMs?: number
  toolCallsCount?: number
}

export interface RunRecord {
  runId: string
  sessionId: string
  runStatus: RunStatus
  pendingAction?: PendingActionRecord
  resultSummary?: ResultSummaryRecord
  createdAt: number
  updatedAt: number
}

export interface SessionCandidate {
  sessionId: string
  title?: string
  updatedAt: number
}

export type ChannelClaimMode = 'new' | 'resume'

export interface ChannelClaimPlan {
  channelId: string
  agentId: string
  sessionId: string
  mode: ChannelClaimMode
  reason: 'existing_claim' | 'persisted_claim' | 'latest_unclaimed_session' | 'generated_new_session'
}
