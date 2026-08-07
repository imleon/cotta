import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionRunState } from '@cotta/shared'
import type { SessionMetadata } from './session-summary-cache.js'

const { listSessionsMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').listSessions>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: listSessionsMock,
}))

import { SessionSummaryCache } from './session-summary-cache.js'

function session(sessionId: string, cwd = '/repo/a', lastModified = 1): SDKSessionInfo {
  return {
    sessionId,
    cwd,
    customTitle: undefined,
    summary: '',
    firstPrompt: undefined,
    lastModified,
    fileSize: 0,
  }
}

function projectId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

describe('SessionSummaryCache', () => {
  beforeEach(() => {
    listSessionsMock.mockReset()
    listSessionsMock.mockResolvedValue([])
  })

  afterEach(() => vi.useRealTimers())

  it('uses complete global snapshots and keeps project windows cached', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([session('s1')])

    await cache.requestScan('global')
    const calls = listSessionsMock.mock.calls.length

    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ id: 's1' }],
      hasMore: false,
      nextCursor: null,
    })
    expect(listSessionsMock).toHaveBeenCalledTimes(calls)
  })

  it('uses project scans without bypassing the scan queue', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([session('s1')])
    await cache.requestScan('global')
    listSessionsMock.mockResolvedValueOnce([session('s2')])

    await cache.requestScan({ projectId: projectId('/repo/a') })

    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/a', includeProgrammatic: true }))
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({ sessions: [{ id: 's2' }] })
  })

  it('upgrades unknown project scans to global discovery', async () => {
    const cache = new SessionSummaryCache(10)

    await cache.requestScan({ projectId: projectId('/repo/new') })

    expect(listSessionsMock).toHaveBeenCalledWith(expect.objectContaining({ includeProgrammatic: true }))
    expect(listSessionsMock.mock.calls[0]?.[0]).not.toHaveProperty('dir')
  })

  it('deduplicates pending projects and lets a pending global cover them', async () => {
    let release: ((sessions: SDKSessionInfo[]) => void) | undefined
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )

    const first = cache.requestScan('global')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const project = { projectId: projectId('/repo/a') }
    const requests = [cache.requestScan(project), cache.requestScan(project), cache.requestScan('global')]
    release?.([])
    await Promise.all([first, ...requests])

    expect(listSessionsMock.mock.calls.every(([options]) => !options?.dir)).toBe(true)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('puts requests arriving during a scan into the next batch', async () => {
    let release: ((sessions: SDKSessionInfo[]) => void) | undefined
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )

    const first = cache.requestScan('global')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const next = cache.requestScan('global')
    release?.([])
    await Promise.all([first, next])

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('debounces observations and resolves known targets dynamically', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([session('known')])
    await cache.requestScan('global')
    listSessionsMock.mockClear()

    cache.observeSession({ sessionId: 'known' })
    await vi.advanceTimersByTimeAsync(700)
    cache.observeSession({ sessionId: 'known' })
    await vi.advanceTimersByTimeAsync(799)
    expect(listSessionsMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/a' }))
  })

  it('uses max wait so repeated observations cannot postpone scanning forever', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    cache.observeSession({ sessionId: 'unknown' })
    for (let elapsed = 500; elapsed < 2_500; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500)
      cache.observeSession({ sessionId: 'unknown' })
    }
    expect(listSessionsMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('retries discovery until the observed session appears and merges later observations', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([session('new')])

    cache.observeSession({ sessionId: 'new', projectId: projectId('/repo/a') })
    await vi.advanceTimersByTimeAsync(800)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(400)
    cache.observeSession({ sessionId: 'new' })
    cache.observeSession({ sessionId: 'new' })
    await vi.advanceTimersByTimeAsync(799)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_500)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('stops discovery retries at the bounded deadline', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    cache.observeSession({ sessionId: 'missing', projectId: projectId('/repo/a') })

    await vi.advanceTimersByTimeAsync(10_000)

    expect(listSessionsMock.mock.calls.length).toBeGreaterThan(1)
    const callsAtDeadline = listSessionsMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listSessionsMock).toHaveBeenCalledTimes(callsAtDeadline)
  })

  it('starts a new debounce window after a prior observation fires', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    cache.observeSession({ sessionId: 'unknown' })
    await vi.advanceTimersByTimeAsync(800)
    cache.observeSession({ sessionId: 'unknown' })
    await vi.advanceTimersByTimeAsync(799)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('prefers a new observed project over the cached session project', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([session('moved', '/repo/a'), session('other', '/repo/b')])
      .mockResolvedValueOnce([session('moved', '/repo/b'), session('other', '/repo/b')])
    await cache.requestScan('global')
    listSessionsMock.mockClear()

    cache.observeSession({ sessionId: 'moved', projectId: projectId('/repo/b') })
    await vi.advanceTimersByTimeAsync(800)

    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/b' }))
  })

  it('uses the latest known project for pending observations', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([session('known')])
    await cache.requestScan('global')
    listSessionsMock.mockClear()

    cache.observeSession({ sessionId: 'pending' })
    cache.observeSession({ sessionId: 'pending', projectId: projectId('/repo/a') })
    await vi.advanceTimersByTimeAsync(800)

    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/a' }))
  })

  it('uses a global scan for an unknown observed session and recovers on later observations', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockRejectedValueOnce(new Error('scan failed')).mockResolvedValue([])
    cache.observeSession({ sessionId: 'unknown' })

    await vi.advanceTimersByTimeAsync(800)
    expect(error).toHaveBeenCalled()
    cache.observeSession({ sessionId: 'unknown' })
    await vi.advanceTimersByTimeAsync(800)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(listSessionsMock.mock.calls.every(([options]) => !options?.dir)).toBe(true)
    error.mockRestore()
  })

  it('keeps manual refresh immediate when no session target is provided', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)

    await cache.scheduleRefresh({ reason: 'manual' })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('schedules a targeted fallback scan after refreshing a session target', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValue([session('s1')])

    await cache.scheduleRefresh({ reason: 'manual', projectId: projectId('/repo/a'), sessionId: 's1' })
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(799)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/a' }))
  })

  it('debounces targeted fallback scans from repeated manual refreshes', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValue([session('s1')])

    await cache.scheduleRefresh({ reason: 'manual', projectId: projectId('/repo/a'), sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(400)
    await cache.scheduleRefresh({ reason: 'manual', projectId: projectId('/repo/a'), sessionId: 's1' })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(799)
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)

    expect(listSessionsMock).toHaveBeenCalledTimes(3)
    expect(listSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/repo/a' }))
  })

  it('publishes session changes for changed, removed, and moved sessions', async () => {
    const cache = new SessionSummaryCache(10)
    const events: unknown[] = []
    cache.subscribe((event) => events.push(event))
    listSessionsMock.mockResolvedValueOnce([session('s1', '/repo/a', 1), session('moved', '/repo/a', 1), session('deleted', '/repo/a', 1)])
    await cache.requestScan('global')
    events.length = 0

    listSessionsMock.mockResolvedValueOnce([session('s1', '/repo/a', 2), session('moved', '/repo/b', 2)])
    await cache.requestScan('global')

    expect(events.at(-1)).toMatchObject({
      sessionChanges: expect.arrayContaining([
        { projectId: projectId('/repo/a'), sessionId: 's1', kind: 'changed' },
        { projectId: projectId('/repo/a'), sessionId: 'deleted', kind: 'removed' },
        { projectId: projectId('/repo/a'), sessionId: 'moved', kind: 'removed' },
        { projectId: projectId('/repo/b'), sessionId: 'moved', kind: 'changed' },
      ]),
    })
  })

  it('keeps Cotta-only metadata empty while exposing normalized status', async () => {
    const cache = new SessionSummaryCache(10)
    let runState: SessionRunState = { phase: 'running', activeUserMessageUuid: 'u', lastTurn: null }
    cache.setSessionRunStateReader(() => runState)
    listSessionsMock.mockResolvedValueOnce([session('s1')])

    await cache.requestScan('global')
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'busy', kind: null, entrypoint: null }],
    })

    runState = { phase: 'requires_action', activeUserMessageUuid: 'u', lastTurn: null }
    listSessionsMock.mockResolvedValueOnce([session('s1')])
    await cache.requestScan({ projectId: projectId('/repo/a') })
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'waiting', kind: null, entrypoint: null }],
    })
  })

  it('exposes CLI background metadata separately from status', async () => {
    const cache = new SessionSummaryCache(10)
    const metadata: SessionMetadata = { status: 'idle', hasRunningShell: false, kind: 'bg', entrypoint: 'cli' }
    cache.setSessionMetadataReader(() => metadata)
    listSessionsMock.mockResolvedValueOnce([session('s1')])

    await cache.requestScan('global')
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'idle', kind: 'bg', entrypoint: 'cli' }],
    })
  })

  it('exposes a running shell separately from idle status', async () => {
    const cache = new SessionSummaryCache(10)
    cache.setSessionMetadataReader(() => ({ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' }))
    listSessionsMock.mockResolvedValueOnce([session('s1')])

    await cache.requestScan('global')
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' }],
    })
  })

  it('publishes non-idle status immediately for known sessions only', async () => {
    const cache = new SessionSummaryCache(10)
    let runState: SessionRunState = { phase: 'idle', activeUserMessageUuid: null }
    cache.setSessionRunStateReader(() => runState)
    listSessionsMock.mockResolvedValueOnce([session('s1')])
    await cache.requestScan('global')
    const calls = listSessionsMock.mock.calls.length

    runState = { phase: 'running', activeUserMessageUuid: 'u', lastTurn: null }
    await cache.notifySessionRunStateActive('s1')

    expect(listSessionsMock).toHaveBeenCalledTimes(calls)
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'busy' }],
    })
  })

  it('does not clear non-idle runState until a scan confirms idle', async () => {
    const cache = new SessionSummaryCache(10)
    let runState: SessionRunState = { phase: 'running', activeUserMessageUuid: 'u', lastTurn: null }
    cache.setSessionRunStateReader(() => runState)
    listSessionsMock.mockResolvedValueOnce([session('s1')])
    await cache.requestScan('global')
    runState = { phase: 'idle' as const, activeUserMessageUuid: null }

    await cache.notifySessionRunStateActive('s1')
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'busy' }],
    })

    listSessionsMock.mockResolvedValueOnce([session('s1')])
    await cache.requestScan({ projectId: projectId('/repo/a') })
    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).resolves.toMatchObject({
      sessions: [{ status: 'idle' }],
    })
  })

  it('starts one unrefed 30-minute fallback and close clears all timers', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    await cache.ensureReady()
    cache.observeSession({ sessionId: 'unknown' })
    const calls = listSessionsMock.mock.calls.length
    cache.close()

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(listSessionsMock).toHaveBeenCalledTimes(calls)
  })
})
