import type {
  AgentConfig,
  ChannelConfig,
  ConnectorConfig,
  RuntimeConfig,
} from './schema.js'
import type { AgentTemplate } from '../orchestration/types.js'

export interface ConfigRegistry {
  getAgent(agentId: string): AgentTemplate | null
  listAgents(): AgentTemplate[]
  getChannel(channelId: string): ChannelConfig | null
  listChannels(): ChannelConfig[]
  getConnector(connectorId: string): ConnectorConfig | null
  listConnectors(): ConnectorConfig[]
}

function toAgentTemplate(agent: AgentConfig): AgentTemplate {
  return {
    agentId: agent.agentId,
    projectDir: agent.projectDir,
    model: agent.modelJson?.model,
    permissionMode: agent.permissionMode,
    allowTools: agent.allowToolsJson,
    allowSkills: agent.allowSkillsJson,
    mcpServers: agent.mcpServersJson,
    env: agent.envJson,
    promptConfig: agent.promptConfigJson,
  }
}

export class StaticConfigRegistry implements ConfigRegistry {
  private readonly agents: AgentTemplate[]
  private readonly agentById: Map<string, AgentTemplate>
  private readonly channels: ChannelConfig[]
  private readonly channelById: Map<string, ChannelConfig>
  private readonly connectors: ConnectorConfig[]
  private readonly connectorById: Map<string, ConnectorConfig>

  constructor(config: RuntimeConfig) {
    this.agents = config.agents.map(toAgentTemplate)
    this.agentById = new Map(this.agents.map((agent) => [agent.agentId, agent]))
    this.channels = config.channels
    this.channelById = new Map(this.channels.map((channel) => [channel.channelId, channel]))
    this.connectors = config.connectors
    this.connectorById = new Map(this.connectors.map((connector) => [connector.connectorId, connector]))
  }

  getAgent(agentId: string): AgentTemplate | null {
    return this.agentById.get(agentId) ?? null
  }

  listAgents(): AgentTemplate[] {
    return this.agents
  }

  getChannel(channelId: string): ChannelConfig | null {
    return this.channelById.get(channelId) ?? null
  }

  listChannels(): ChannelConfig[] {
    return this.channels
  }

  getConnector(connectorId: string): ConnectorConfig | null {
    return this.connectorById.get(connectorId) ?? null
  }

  listConnectors(): ConnectorConfig[] {
    return this.connectors
  }
}
