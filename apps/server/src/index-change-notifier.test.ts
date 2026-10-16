import { listVersionsEventSchema } from '@cotta/shared'
import { describe, expect, it } from 'vitest'
import { IndexChangeNotifier } from './index-change-notifier.js'

describe('IndexChangeNotifier', () => {
  it('starts with a valid empty snapshot', () => {
    expect(listVersionsEventSchema.parse(new IndexChangeNotifier().versionSnapshot)).toMatchObject({
      projectsVersion: 0,
      projectVersions: [],
      sessionVersions: [],
      subagentVersions: [],
      sessionChanges: [],
    })
  })

  it('publishes global changes by bumping projects version', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishChange()

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({ projectsVersion: 1, projectVersions: [], sessionChanges: [] })
  })

  it('publishes project and session changes', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishChange({ projectId: 'p1', sessionId: 's1', kind: 'removed' })
    notifier.publishChange({ projectId: 'p1', sessionId: 's2', kind: 'changed', version: 'v2', reset: false, invalidateFromTurnId: null })

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectsVersion: 1,
      projectVersions: [{ projectId: 'p1', version: 1 }],
      sessionChanges: [{ projectId: 'p1', sessionId: 's1', kind: 'removed' }],
    })
    expect(listVersionsEventSchema.parse(events[1])).toMatchObject({
      projectsVersion: 2,
      projectVersions: [{ projectId: 'p1', version: 2 }],
      sessionChanges: [{ projectId: 'p1', sessionId: 's2', kind: 'changed', version: 'v2', reset: false, invalidateFromTurnId: null }],
    })
  })

  it('publishes old owner project invalidation without an old session change', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishChange({ previousProjectId: 'old', projectId: 'new', sessionId: 's1', kind: 'changed', version: 'v1', reset: true, invalidateFromTurnId: null })

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectsVersion: 1,
      projectVersions: [
        { projectId: 'old', version: 1 },
        { projectId: 'new', version: 1 },
      ],
      sessionChanges: [{ projectId: 'new', sessionId: 's1', kind: 'changed', version: 'v1', reset: true, invalidateFromTurnId: null }],
    })
  })

  it('includes a selected session version in a reconnect snapshot', () => {
    const snapshot = new IndexChangeNotifier().snapshot({ projectId: 'p1', sessionId: 's1', version: 'v1' })

    expect(listVersionsEventSchema.parse(snapshot).sessionVersions).toEqual([{ projectId: 'p1', sessionId: 's1', version: 'v1', snapshot: true }])
  })

  it('publishes selected session versions without transcript changes', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishChange({ projectId: 'p1', sessionId: 's1', selectedSessionVersion: 'v1;runtime=2' })

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectVersions: [{ projectId: 'p1', version: 1 }],
      sessionVersions: [{ projectId: 'p1', sessionId: 's1', version: 'v1;runtime=2' }],
      sessionChanges: [],
    })
  })

  it('publishes a session version without list or timeline invalidation', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishSessionVersion('p1', 's1', 'timeline-v1;tasks=task-v2')

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectsVersion: 0,
      projectVersions: [],
      sessionVersions: [{ projectId: 'p1', sessionId: 's1', version: 'timeline-v1;tasks=task-v2' }],
      sessionChanges: [],
    })
  })

  it('publishes monotonic subagent versions and includes the selected session in snapshots', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishSubagentChange('p1', 's1')
    notifier.publishSubagentChange('p1', 's1')

    expect(listVersionsEventSchema.parse(events[0]).subagentVersions).toEqual([{ projectId: 'p1', sessionId: 's1', version: 1 }])
    expect(listVersionsEventSchema.parse(events[1]).subagentVersions).toEqual([{ projectId: 'p1', sessionId: 's1', version: 2 }])
    expect(listVersionsEventSchema.parse(notifier.snapshot({ projectId: 'p1', sessionId: 's1', version: 'timeline-v1' })).subagentVersions).toEqual([
      { projectId: 'p1', sessionId: 's1', version: 2, snapshot: true },
    ])
  })

  it('publishes project changes without session details', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishChange({ projectId: 'p1' })

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectsVersion: 0,
      projectVersions: [{ projectId: 'p1', version: 1 }],
      sessionChanges: [],
    })
  })

  it('bumps both list and project versions for terminal lifetime changes', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    notifier.subscribe((event) => events.push(event))

    notifier.publishProjectListChange('p1')

    expect(listVersionsEventSchema.parse(events[0])).toMatchObject({
      projectsVersion: 1,
      projectVersions: [{ projectId: 'p1', version: 1 }],
      sessionChanges: [],
    })
  })

  it('unsubscribes listeners', () => {
    const notifier = new IndexChangeNotifier()
    const events: unknown[] = []
    const unsubscribe = notifier.subscribe((event) => events.push(event))

    unsubscribe()
    notifier.publishChange()

    expect(events).toEqual([])
  })
})
