import type { Hono } from 'hono'
import type { StaticConfigRegistry } from '../../../config/registry.js'

export function registerAgentRoutes(app: Hono<any, any, any>, input: {
  defaultAgentId: string
  configRegistry: StaticConfigRegistry
}) {
  app.get('/api/agents', (c) => {
    const agents = input.configRegistry.listAgents().map((agent) => ({
      agentId: agent.agentId,
      projectDir: agent.projectDir,
    }))
    return c.json({
      defaultAgentId: input.defaultAgentId,
      agents,
    })
  })
}

