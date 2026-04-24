import { describe, expect, it, vi } from 'vitest'
import { MutableConfigRegistry } from '../../../config/registry.js'
import type { RuntimeConfig } from '../../../config/schema.js'
import { SessionRegistry } from '../../../orchestration/session-registry.js'
import { replaceRuntimeConfigAtomically } from './config.js'

const initialConfig: RuntimeConfig = {
  connectors: [
    {
      connectorId: 'connector-1',
      connectorType: 'lark',
      connectorConfig: { appId: 'app-1', appSecret: 'secret-1' },
    },
  ],
  agents: [
    {
      agentId: 'agent-1',
      projectDir: '/project-a',
      modelJson: { model: 'claude-sonnet' },
    },
  ],
  channels: [
    {
      channelId: 'channel-1',
      channelKey: 'chat-a',
      connectorId: 'connector-1',
      agentId: 'agent-1',
      enabled: true,
      currentSdkSessionId: 'session-1',
    },
  ],
}

const nextConfig: RuntimeConfig = {
  connectors: [
    {
      connectorId: 'connector-2',
      connectorType: 'lark',
      connectorConfig: { appId: 'app-2', appSecret: 'secret-2' },
    },
  ],
  agents: [
    {
      agentId: 'agent-2',
      projectDir: '/project-b',
      modelJson: { model: 'claude-opus' },
    },
  ],
  channels: [
    {
      channelId: 'channel-2',
      channelKey: 'chat-b',
      connectorId: 'connector-2',
      agentId: 'agent-2',
      enabled: true,
      currentSdkSessionId: 'session-2',
    },
  ],
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as RuntimeConfig
}

describe('replaceRuntimeConfigAtomically', () => {
  it('rolls DB, config registry, and session registry back when runtime apply fails', async () => {
    let storedConfig = cloneConfig(initialConfig)
    let updatedAt = 1
    const configRepository = {
      loadRuntimeConfig: vi.fn(() => cloneConfig(storedConfig)),
      replaceRuntimeConfig: vi.fn((config: RuntimeConfig) => {
        storedConfig = cloneConfig(config)
        updatedAt += 1
      }),
      getLastUpdatedAt: vi.fn(() => updatedAt),
    }
    const configRegistry = new MutableConfigRegistry(initialConfig)
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', { channelId: 'channel-1' })

    const orchestrator = {
      refreshConfigDependentSessions: vi
        .fn()
        .mockRejectedValueOnce(new Error('rebuild exploded'))
        .mockResolvedValueOnce({ checked: 0, rebuilt: 0 }),
    }

    await expect(
      replaceRuntimeConfigAtomically({
        config: nextConfig,
        configRepository: configRepository as never,
        configRegistry,
        sessionRegistry,
        orchestrator: orchestrator as never,
      }),
    ).rejects.toThrow('Failed to apply runtime config: rebuild exploded')

    expect(storedConfig).toEqual(initialConfig)
    expect(configRegistry.listAgents()).toMatchObject([{ agentId: 'agent-1', projectDir: '/project-a' }])
    expect(configRegistry.getChannel('channel-1')?.currentSdkSessionId).toBe('session-1')
    expect(configRegistry.getChannel('channel-2')).toBeNull()
    expect(sessionRegistry.get('session-1')).toMatchObject({
      agentId: 'agent-1',
      channelId: 'channel-1',
    })
    expect(sessionRegistry.get('session-2')).toBeNull()
    expect(orchestrator.refreshConfigDependentSessions).toHaveBeenCalledTimes(2)
  })
})
