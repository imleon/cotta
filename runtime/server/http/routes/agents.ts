import type { Hono } from 'hono'
import type { ConfigRegistry } from '../../../config/registry.js'
import type { AppEnv } from '../app-env.js'

export function registerAgentRoutes(app: Hono<AppEnv>, input: {
  defaultAgentId: string | null
  configRegistry: ConfigRegistry
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
