import { describe, expect, it } from 'vitest'
import { resolveTurnOptions } from './turn-options.js'

const settingsStore = {
  getAll: () => ({ defaultPermissionMode: 'plan', defaultModel: 'initial-model', defaultEffort: 'high' }),
}

function sessionMetaStore(meta: { permissionMode: 'default' | 'plan' | null; model: string | null; effort: 'low' | 'high' | null } | null) {
  return { getSessionMeta: () => meta }
}

describe('resolveTurnOptions', () => {
  it('uses settings initial values when session meta is absent', () => {
    expect(resolveTurnOptions({ projectId: 'project', sessionId: 'session', settingsStore: settingsStore as never, sessionMetaStore: sessionMetaStore(null) })).toEqual({
      permissionMode: 'plan',
      model: 'initial-model',
      effort: 'high',
    })
  })

  it('preserves explicit null model and effort from session meta', () => {
    expect(resolveTurnOptions({
      projectId: 'project',
      sessionId: 'session',
      settingsStore: settingsStore as never,
      sessionMetaStore: sessionMetaStore({ permissionMode: null, model: null, effort: null }),
    })).toEqual({
      permissionMode: 'plan',
      model: null,
      effort: null,
    })
  })

  it('uses explicit session model and effort', () => {
    expect(resolveTurnOptions({
      projectId: 'project',
      sessionId: 'session',
      settingsStore: settingsStore as never,
      sessionMetaStore: sessionMetaStore({ permissionMode: 'default', model: 'session-model', effort: 'low' }),
    })).toEqual({
      permissionMode: 'default',
      model: 'session-model',
      effort: 'low',
    })
  })
})
