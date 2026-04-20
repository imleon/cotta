import { describe, expect, it } from 'vitest'
import {
  buildClearedRunState,
  decideRunClaim,
  reconcileOptimisticUserMessages,
  reduceRunLifecycleEvent,
} from './reducer'
import type { SessionEvent, SessionMessage } from '../../contract/runtime'

function createUserMessage(input: {
  content: string
  timestamp: number
}): SessionMessage {
  return {
    role: 'user',
    content: input.content,
    timestamp: input.timestamp,
  }
}

describe('reduceRunLifecycleEvent', () => {
  it('marks completed run with non-zero exit code as failed', () => {
    const result = reduceRunLifecycleEvent({
      type: 'session.run.completed',
      runId: 'run-1',
      sessionId: 'session-1',
      exitCode: 2,
    } satisfies SessionEvent)

    expect(result).toEqual({
      clearRunState: 'failed',
    })
  })

  it('returns session notice for failed runs', () => {
    const result = reduceRunLifecycleEvent({
      type: 'session.run.failed',
      runId: 'run-1',
      sessionId: 'session-1',
      error: 'boom',
    } satisfies SessionEvent)

    expect(result).toEqual({
      clearRunState: 'failed',
      sessionNotice: 'boom',
    })
  })
})

describe('reconcileOptimisticUserMessages', () => {
  it('removes the first matching optimistic user message and returns its timestamp', () => {
    const optimistic = [
      createUserMessage({ content: 'hello', timestamp: 1000 }),
      createUserMessage({ content: 'later', timestamp: 5000 }),
    ]

    const result = reconcileOptimisticUserMessages(
      optimistic,
      createUserMessage({ content: ' hello ', timestamp: 1200 }),
      1200,
      30_000,
    )

    expect(result.matchedTimestamp).toBe(1000)
    expect(result.nextOptimistic).toHaveLength(1)
    expect(result.nextOptimistic[0]?.content).toBe('later')
  })

  it('keeps optimistic messages when candidate does not match', () => {
    const optimistic = [
      createUserMessage({ content: 'hello', timestamp: 1000 }),
    ]

    const result = reconcileOptimisticUserMessages(
      optimistic,
      createUserMessage({ content: 'other', timestamp: 1200 }),
      1200,
      30_000,
    )

    expect(result.matchedTimestamp).toBeNull()
    expect(result.nextOptimistic).toEqual(optimistic)
  })
})

describe('decideRunClaim', () => {
  it('claims a run when awaiting start and a run-scoped event arrives', () => {
    const result = decideRunClaim(
      { activeRunId: null, awaitingRunStart: true },
      {
        type: 'session.run.started',
        runId: 'run-1',
        sessionId: 'session-1',
      } satisfies SessionEvent,
    )

    expect(result.accept).toBe(true)
    expect(result.next).toEqual({
      activeRunId: 'run-1',
      awaitingRunStart: false,
    })
    expect(result.log).toEqual({
      level: 'info',
      kind: 'run-claimed',
      runId: 'run-1',
      eventType: 'session.run.started',
    })
  })

  it('rejects unclaimed run events when not awaiting start', () => {
    const result = decideRunClaim(
      { activeRunId: null, awaitingRunStart: false },
      {
        type: 'session.run.started',
        runId: 'run-2',
        sessionId: 'session-1',
      } satisfies SessionEvent,
    )

    expect(result.accept).toBe(false)
    expect(result.next).toEqual({
      activeRunId: null,
      awaitingRunStart: false,
    })
    expect(result.log).toEqual({
      level: 'warn',
      kind: 'ignored-unclaimed-run',
      runId: 'run-2',
      eventType: 'session.run.started',
    })
  })
})

describe('buildClearedRunState', () => {
  it('returns a clean state shape with requested run state', () => {
    expect(buildClearedRunState('cancelled')).toEqual({
      activeRunId: null,
      awaitingRunStart: false,
      controlTransactionsById: {},
      activeControlOrder: [],
      streamPreviewStates: {},
      streamAnimationCursors: {},
      runState: 'cancelled',
    })
  })
})
