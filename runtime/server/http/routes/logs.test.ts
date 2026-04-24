import { describe, expect, it, vi } from 'vitest'
import { MutableConfigRegistry } from '../../../config/registry.js'
import type { RuntimeConfig } from '../../../config/schema.js'
import { SessionRegistry } from '../../../orchestration/session-registry.js'
import { canAccessSessionLogs } from './logs.js'

const config: RuntimeConfig = {
  connectors: [],
  agents: [
    {
      agentId: 'agent-1',
      projectDir: '/project-a',
      modelJson: { model: 'claude-sonnet' },
    },
  ],
  channels: [],
}

describe('canAccessSessionLogs', () => {
  it('allows managed runtime sessions without needing persisted session lookup', async () => {
    const configRegistry = new MutableConfigRegistry(config)
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1')
    const getSession = vi.fn()

    await expect(
      canAccessSessionLogs('session-1', {
        configRegistry,
        sessionRegistry,
        getSession: getSession as never,
      }),
    ).resolves.toBe(true)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('denies foreign runtime sessions that are not in current project scope', async () => {
    const configRegistry = new MutableConfigRegistry(config)
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-foreign', 'agent-1', { sessionScope: 'foreign' })
    const getSession = vi.fn().mockResolvedValue(null)

    await expect(
      canAccessSessionLogs('session-foreign', {
        configRegistry,
        sessionRegistry,
        getSession,
      }),
    ).resolves.toBe(false)
    expect(getSession).toHaveBeenCalledWith('session-foreign', ['/project-a'])
  })

  it('allows persisted sessions inside configured project directories', async () => {
    const configRegistry = new MutableConfigRegistry(config)
    const sessionRegistry = new SessionRegistry()
    const getSession = vi.fn().mockResolvedValue({ id: 'session-2' })

    await expect(
      canAccessSessionLogs('session-2', {
        configRegistry,
        sessionRegistry,
        getSession,
      }),
    ).resolves.toBe(true)
    expect(getSession).toHaveBeenCalledWith('session-2', ['/project-a'])
  })
})
