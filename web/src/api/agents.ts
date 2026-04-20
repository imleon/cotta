import type { AgentDescriptor, AgentsResponse } from './types'
import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export interface AgentsData {
  defaultAgentId: string | null
  agents: AgentDescriptor[]
}

export async function fetchAgentsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<AgentsData>> {
  const res = await apiFetch('/api/agents')
  const payload = await readJsonSafe(res)
  if (!res.ok) {
    return makeApiResult({
      ok: false,
      status: res.status,
      data: { defaultAgentId: null, agents: [] },
      error: extractApiError(payload, res.status),
    })
  }

  const data = payload as AgentsResponse
  const agents = Array.isArray(data.agents)
    ? data.agents
      .map((agent) => ({
        agentId: typeof agent?.agentId === 'string' ? agent.agentId.trim() : '',
        ...(typeof agent?.projectDir === 'string' && agent.projectDir.trim()
          ? { projectDir: agent.projectDir.trim() }
          : {}),
      }))
      .filter((agent) => agent.agentId)
    : []

  return makeApiResult({
    ok: true,
    status: res.status,
    data: {
      defaultAgentId: typeof data.defaultAgentId === 'string' && data.defaultAgentId ? data.defaultAgentId : null,
      agents,
    },
  })
}
