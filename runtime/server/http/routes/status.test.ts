import { describe, expect, it, vi } from 'vitest'
import type { AgentTemplate } from '../../../orchestration/types.js'
import { collectPersistedSessionsByAgent, toStatusAgentConfig } from './status.js'

describe('toStatusAgentConfig', () => {
  it('redacts sensitive agent config fields into summaries', () => {
    const agent: AgentTemplate = {
      agentId: 'agent-1',
      projectDir: '/project-a',
      model: 'claude-sonnet',
      permissionMode: 'acceptEdits',
      allowTools: ['bash'],
      allowSkills: ['lark-doc'],
      env: {
        OPENAI_API_KEY: 'secret-key',
        FEATURE_FLAG: 'true',
      },
      mcpServers: {
        notion: {
          enabled: true,
          token: 'secret-token',
        },
        github: {
          enabled: false,
          token: 'another-secret',
        },
      },
      promptConfig: {
        version: 'v3',
        systemPrompt: 'super secret instructions',
      },
    }

    const statusAgent = toStatusAgentConfig(agent) as Record<string, unknown>

    expect(statusAgent).toMatchObject({
      agentId: 'agent-1',
      projectDir: '/project-a',
      model: 'claude-sonnet',
      permissionMode: 'acceptEdits',
      allowTools: ['bash'],
      allowSkills: ['lark-doc'],
      envSummary: {
        keys: ['FEATURE_FLAG', 'OPENAI_API_KEY'],
        count: 2,
      },
      mcpSummary: {
        count: 2,
        servers: [
          { name: 'github', enabled: false },
          { name: 'notion', enabled: true },
        ],
      },
      promptConfigSummary: {
        configured: true,
        keyCount: 2,
        version: 'v3',
      },
    })
    expect(statusAgent).not.toHaveProperty('env')
    expect(statusAgent).not.toHaveProperty('mcpServers')
    expect(statusAgent).not.toHaveProperty('promptConfig')
  })
})

describe('collectPersistedSessionsByAgent', () => {
  it('reuses a single projectDir scan for multiple agents sharing the same directory', async () => {
    const listSessionsByProjectDir = vi.fn().mockImplementation(async (dir: string) => {
      if (dir === '/project-a') {
        return [
          { id: 'session-1', title: 'Session 1', updatedAt: 10 },
          { id: 'session-2', title: 'Session 2', updatedAt: 20 },
        ]
      }
      return [
        { id: 'session-3', title: 'Session 3', updatedAt: 30 },
      ]
    })

    const result = await collectPersistedSessionsByAgent(
      [
        { agentId: 'agent-1', projectDir: '/project-a' },
        { agentId: 'agent-2', projectDir: '/project-a' },
        { agentId: 'agent-3', projectDir: '/project-b' },
      ],
      listSessionsByProjectDir,
    )

    expect(listSessionsByProjectDir).toHaveBeenCalledTimes(2)
    expect(listSessionsByProjectDir).toHaveBeenCalledWith('/project-a')
    expect(listSessionsByProjectDir).toHaveBeenCalledWith('/project-b')
    expect(result.persistedSessions.map((item) => item.id)).toEqual(['session-3', 'session-2', 'session-1'])
    expect(result.perAgentPersistedSessions).toEqual([
      {
        agentId: 'agent-1',
        sessions: [
          { id: 'session-1', title: 'Session 1', updatedAt: 10 },
          { id: 'session-2', title: 'Session 2', updatedAt: 20 },
        ],
      },
      {
        agentId: 'agent-2',
        sessions: [
          { id: 'session-1', title: 'Session 1', updatedAt: 10 },
          { id: 'session-2', title: 'Session 2', updatedAt: 20 },
        ],
      },
      {
        agentId: 'agent-3',
        sessions: [
          { id: 'session-3', title: 'Session 3', updatedAt: 30 },
        ],
      },
    ])
  })
})
