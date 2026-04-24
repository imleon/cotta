import { describe, expect, it } from 'vitest'
import { computeWorkerConfigSignature } from './worker-config-signature.js'
import type { AgentTemplate } from './types.js'

const baseAgent: AgentTemplate = {
  agentId: 'agent-1',
  projectDir: '/tmp/project',
  model: 'claude-sonnet',
}

describe('computeWorkerConfigSignature', () => {
  it('produces a stable signature even when nested object keys are ordered differently', () => {
    const left: AgentTemplate = {
      ...baseAgent,
      env: {
        Z: 'last',
        A: 'first',
      },
      mcpServers: {
        beta: { type: 'stdio', command: 'b' },
        alpha: { type: 'stdio', command: 'a' },
      },
      promptConfig: {
        appendSystemPrompt: 'hello',
        extra: {
          y: 2,
          x: 1,
        },
      },
    }
    const right: AgentTemplate = {
      ...baseAgent,
      env: {
        A: 'first',
        Z: 'last',
      },
      mcpServers: {
        alpha: { command: 'a', type: 'stdio' },
        beta: { command: 'b', type: 'stdio' },
      },
      promptConfig: {
        extra: {
          x: 1,
          y: 2,
        },
        appendSystemPrompt: 'hello',
      },
    }

    expect(computeWorkerConfigSignature(left)).toBe(computeWorkerConfigSignature(right))
  })

  it('changes the signature when execution-relevant fields change', () => {
    const left = computeWorkerConfigSignature({
      ...baseAgent,
      allowTools: ['Read'],
      permissionMode: 'default',
    })
    const right = computeWorkerConfigSignature({
      ...baseAgent,
      allowTools: ['Read', 'Write'],
      permissionMode: 'acceptEdits',
    })

    expect(left).not.toBe(right)
  })

  it('normalizes missing optional fields to the same signature', () => {
    const left = computeWorkerConfigSignature(baseAgent)
    const right = computeWorkerConfigSignature({
      ...baseAgent,
      permissionMode: undefined,
      allowTools: undefined,
      allowSkills: undefined,
      mcpServers: undefined,
      env: undefined,
      promptConfig: undefined,
    })

    expect(left).toBe(right)
  })
})
