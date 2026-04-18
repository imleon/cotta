import { createHash } from 'node:crypto'
import type { AgentTemplate } from './types.js'

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

export function computeWorkerConfigSignature(agent: AgentTemplate): string {
  // Only include config that can change worker execution behavior.
  const payload = {
    model: agent.model ?? '',
    permissionMode: agent.permissionMode ?? '',
    allowTools: Array.isArray(agent.allowTools) ? agent.allowTools : [],
    allowSkills: Array.isArray(agent.allowSkills) ? agent.allowSkills : [],
    mcpServers: agent.mcpServers ?? null,
    env: agent.env ?? null,
    promptConfig: agent.promptConfig ?? null,
  }
  const raw = stableStringify(payload)
  return createHash('sha256').update(raw).digest('hex')
}

