import { describe, expect, it, vi } from 'vitest'
import { SessionWatcherRegistry } from './session-watcher-registry.js'

describe('SessionWatcherRegistry', () => {
  it('allows a later acquire to retry when no watcher can be started', async () => {
    const close = vi.fn()
    const watchSessionTasks = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ close })
    const registry = new SessionWatcherRegistry({ watchSessionTasks, watchSessionSubagents: vi.fn() })
    ;(await registry.acquireTask('session-1', vi.fn()))()
    const release = await registry.acquireTask('session-1', vi.fn())
    expect(watchSessionTasks).toHaveBeenCalledTimes(2)
    release()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('shares an asynchronously starting watcher until the last release', async () => {
    let finish!: () => void
    const starting = new Promise<void>((resolve) => (finish = resolve))
    const close = vi.fn()
    let notify!: () => void | Promise<void>
    const watchSessionTasks = vi.fn(async (_sessionId: string, onChange: () => void | Promise<void>) => {
      notify = onChange
      await starting
      return { close }
    })
    const registry = new SessionWatcherRegistry({ watchSessionTasks, watchSessionSubagents: vi.fn() })
    const a = vi.fn()
    const b = vi.fn()
    const first = registry.acquireTask('session-1', a)
    const second = registry.acquireTask('session-1', b)
    expect(watchSessionTasks).toHaveBeenCalledTimes(1)
    finish()
    const [releaseFirst, releaseSecond] = await Promise.all([first, second])
    await notify()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    releaseFirst()
    await notify()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledTimes(2)
    releaseSecond()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keys subagent watchers by session and transcript path', async () => {
    const close = vi.fn()
    const watchSessionSubagents = vi.fn(async () => ({ close }))
    const registry = new SessionWatcherRegistry({ watchSessionTasks: vi.fn(), watchSessionSubagents })

    const releaseFirst = await registry.acquireSubagent('session-1', '/repo/first.jsonl', vi.fn())
    const releaseShared = await registry.acquireSubagent('session-1', '/repo/first.jsonl', vi.fn())
    const releaseOther = await registry.acquireSubagent('session-1', '/repo/second.jsonl', vi.fn())

    expect(watchSessionSubagents).toHaveBeenCalledTimes(2)
    releaseFirst()
    expect(close).not.toHaveBeenCalled()
    releaseShared()
    releaseOther()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('closes a watcher that finishes starting after shutdown', async () => {
    let finish!: (watcher: { close: () => void }) => void
    const starting = new Promise<{ close: () => void }>((resolve) => (finish = resolve))
    const close = vi.fn()
    const registry = new SessionWatcherRegistry({ watchSessionTasks: vi.fn(() => starting), watchSessionSubagents: vi.fn() })

    const acquire = registry.acquireTask('session-1', vi.fn())
    registry.close()
    finish({ close })
    await acquire

    expect(close).toHaveBeenCalledOnce()
  })

  it('closes active watchers during shutdown', async () => {
    const taskClose = vi.fn()
    const subagentClose = vi.fn()
    const watchSessionTasks = vi.fn(async () => ({ close: taskClose }))
    const watchSessionSubagents = vi.fn(async () => ({ close: subagentClose }))
    const registry = new SessionWatcherRegistry({ watchSessionTasks, watchSessionSubagents })

    const releaseTask = await registry.acquireTask('session-1', vi.fn())
    const releaseSubagent = await registry.acquireSubagent('session-1', '/repo/session.jsonl', vi.fn())
    registry.close()

    expect(taskClose).toHaveBeenCalledOnce()
    expect(subagentClose).toHaveBeenCalledOnce()
    releaseTask()
    releaseSubagent()
    expect(taskClose).toHaveBeenCalledOnce()
    expect(subagentClose).toHaveBeenCalledOnce()

    const release = await registry.acquireTask('session-1', vi.fn())
    expect(watchSessionTasks).toHaveBeenCalledTimes(2)
    release()
  })
})
