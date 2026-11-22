import type { EffortLevel, ModelCatalogResponse, PermissionMode, PermissionUpdate, SessionContextUsage } from '@cotta/shared'

export type { PermissionUpdate }

/** Cotta's consumed subset of Claude Code stream-json, not an Agent SDK API.
 * Field names follow the local 2.1.296 wire declarations and the 2.1.322 CLI
 * control probes. Unconsumed business fields remain opaque and are not dropped.
 */
export type SDKMessage = { type: string; [key: string]: unknown }
export type SDKUserMessage = SDKMessage & {
  type: 'user'
  message: { role: 'user'; content: string | Record<string, unknown>[] }
  uuid?: string
  session_id?: string
  parent_tool_use_id: string | null
  timestamp?: string
}
export type SDKAssistantMessage = SDKMessage & {
  type: 'assistant'
  message: {
    id: string
    role: 'assistant'
    model: string
    content: Record<string, unknown>[]
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
    [key: string]: unknown
  }
}
export type SessionMessage = {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
  parent_agent_id: string | null
}
export type SDKControlGetContextUsageResponse = Omit<SessionContextUsage, 'updatedAtMs'> & Record<string, unknown>
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }
export type CanUseToolOptions = {
  signal: AbortSignal
  requestId: string
  toolUseID: string
  suggestions?: PermissionUpdate[]
  title?: string
  displayName?: string
  description?: string
}
export type QueryOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  sessionId?: string
  resume?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  includePartialMessages?: boolean
  allowDangerouslySkipPermissions?: boolean
  canUseTool?: (name: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult>
}
export interface Query extends AsyncIterable<SDKMessage> {
  readonly pid: number | undefined
  initializationResult(): Promise<ModelCatalogResponse>
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  applyFlagSettings(settings: { model?: string; effortLevel?: EffortLevel | null }): Promise<void>
  getContextUsage(options: { detail: 'summary' }): Promise<SDKControlGetContextUsageResponse>
  /** Resolves only after the child and its stdio have closed. */
  close(): Promise<void>
}
