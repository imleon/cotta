import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './session-registry.js'

describe('SessionRegistry', () => {
  it('reassigns a channel to a new session and clears the previous owner', () => {
    const registry = new SessionRegistry()
    registry.ensure('session-1', 'agent-1')
    registry.ensure('session-2', 'agent-1')

    registry.claimChannel('session-1', 'channel-1')
    registry.claimChannel('session-2', 'channel-1')

    expect(registry.get('session-1')).toMatchObject({
      sessionId: 'session-1',
      channelId: undefined,
    })
    expect(registry.get('session-2')).toMatchObject({
      sessionId: 'session-2',
      channelId: 'channel-1',
    })
    expect(registry.findByChannelId('channel-1')).toMatchObject({
      sessionId: 'session-2',
    })
  })

  it('detaches a worker by clearing worker, signature, status, and active run state', () => {
    const registry = new SessionRegistry()
    registry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      workerConfigSig: 'sig-1',
      sessionStatus: 'running',
      activeRunId: 'run-1',
    })

    registry.detachWorker('session-1')

    expect(registry.get('session-1')).toMatchObject({
      sessionId: 'session-1',
      workerRef: undefined,
      workerConfigSig: undefined,
      sessionStatus: undefined,
      activeRunId: undefined,
    })
  })

  it('updates existing records in place while preserving createdAt and bumping updatedAt', async () => {
    const registry = new SessionRegistry()
    const initial = registry.ensure('session-1', 'agent-1', {
      sessionScope: 'foreign',
    })

    await new Promise((resolve) => setTimeout(resolve, 2))

    const updated = registry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
    })

    expect(updated.createdAt).toBe(initial.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(initial.updatedAt)
    expect(updated).toMatchObject({
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'foreign',
      sessionStatus: 'idle',
    })
  })
})
