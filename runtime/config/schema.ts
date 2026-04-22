export interface ConnectorConfig {
  connectorId: string
  connectorType: string
  connectorConfig: Record<string, unknown>
}

export interface ChannelConfig {
  channelId: string
  channelKey: string
  channelName?: string
  connectorId: string
  agentId: string
  enabled: boolean
  // Optional binding to an SDK session id. When empty, a new session will be
  // allocated and persisted when the channel receives its next prompt.
  currentSdkSessionId?: string
}

export interface AgentConfig {
  agentId: string
  agentName?: string
  modelJson: {
    model?: string
    thinking?: unknown
    effort?: string
  }
  projectDir: string
  permissionMode?: string
  allowToolsJson?: string[]
  allowSkillsJson?: string[]
  mcpServersJson?: Record<string, unknown>
  envJson?: Record<string, string>
  promptConfigJson?: Record<string, unknown>
}

export interface RuntimeConfig {
  connectors: ConnectorConfig[]
  channels: ChannelConfig[]
  agents: AgentConfig[]
}
