import { describe, expect, it, vi } from 'vitest'
import { ChannelBindingService } from './channel-binding-service.js'
import { SessionRegistry } from './session-registry.js'

describe('ChannelBindingService', () => {
  it('binds through the repository first and then projects the result into the session registry', () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-old', 'agent-1', { channelId: 'channel-1' })
    sessionRegistry.ensure('session-1', 'agent-1', { channelId: 'channel-2' })
    const configRepository = {
      bindChannelToSession: vi.fn(),
      clearChannelSessionBinding: vi.fn(),
    }
    const service = new ChannelBindingService({
      configRepository: configRepository as never,
      sessionRegistry,
    })

    service.bindChannel('channel-1', 'session-1', 'agent-1')

    expect(configRepository.bindChannelToSession).toHaveBeenCalledWith('channel-1', 'session-1')
    expect(sessionRegistry.get('session-old')?.channelId).toBeUndefined()
    expect(sessionRegistry.get('session-1')).toMatchObject({
      channelId: 'channel-1',
      agentId: 'agent-1',
    })
  })

  it('clears both persisted and runtime channel bindings', () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', { channelId: 'channel-1' })
    const configRepository = {
      bindChannelToSession: vi.fn(),
      clearChannelSessionBinding: vi.fn(),
    }
    const service = new ChannelBindingService({
      configRepository: configRepository as never,
      sessionRegistry,
    })

    service.clearChannel('channel-1')

    expect(configRepository.clearChannelSessionBinding).toHaveBeenCalledWith('channel-1')
    expect(sessionRegistry.findByChannelId('channel-1')).toBeNull()
  })
})
