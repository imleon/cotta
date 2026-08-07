import { describe, expect, it } from 'vitest'
import { mergeTranscriptModelEffort, normalizeModelEffortSelection, resolveTurnOptions, validateTurnOptions } from './turn-options.js'

const modelCatalog = {
  models: [
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'opus', displayName: 'Opus', description: 'Opus', supportsEffort: true, supportedEffortLevels: ['medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Haiku' },
    { value: 'claude-gpt-5-5-max', displayName: 'GPT 5.5', description: 'GPT 5.5', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] },
    { value: 'claude-gpt-5-5-max[1m]', displayName: 'GPT 5.5 1M', description: 'GPT 5.5 1M', supportsEffort: true, supportedEffortLevels: ['medium', 'high', 'xhigh'] },
    { value: 'claude-gpt-5-6-sol-max[1m]', displayName: 'GPT 5.6 1M', description: 'GPT 5.6 1M', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] },
  ],
}

const settingsStore = {
  getAll: () => ({ defaultPermissionMode: 'plan', defaultModel: 'sonnet', defaultEffort: 'high', modelCatalog }),
}

function sessionMetaStore(meta: { permissionMode: 'default' | 'plan' | null; model: string | null; effort: 'low' | 'medium' | 'high' | null } | null) {
  return { getSessionMeta: () => meta }
}

describe('resolveTurnOptions', () => {
  it('uses settings initial values when session meta is absent', () => {
    expect(resolveTurnOptions({ projectId: 'project', sessionId: 'session', settingsStore: settingsStore as never, sessionMetaStore: sessionMetaStore(null) })).toEqual({
      permissionMode: 'plan',
      model: 'sonnet',
      effort: 'high',
    })
  })

  it('uses hardcoded defaults when settings and session meta are unset', () => {
    expect(resolveTurnOptions({ projectId: 'project', settingsStore: { getAll: () => ({}) } as never })).toEqual({
      permissionMode: 'default',
      model: 'default',
      effort: null,
    })
  })

  it('lets permission-only session meta fall through to settings model and effort', () => {
    expect(resolveTurnOptions({
      projectId: 'project',
      sessionId: 'session',
      settingsStore: settingsStore as never,
      sessionMetaStore: sessionMetaStore({ permissionMode: null, model: null, effort: null }),
    })).toEqual({
      permissionMode: 'plan',
      model: 'sonnet',
      effort: 'high',
    })
  })

  it('preserves explicit session default model as an override', () => {
    expect(resolveTurnOptions({
      projectId: 'project',
      sessionId: 'session',
      settingsStore: settingsStore as never,
      sessionMetaStore: sessionMetaStore({ permissionMode: 'default', model: 'default', effort: null }),
    })).toEqual({
      permissionMode: 'default',
      model: 'default',
      effort: null,
    })
  })

  it('uses explicit session model and effort', () => {
    expect(resolveTurnOptions({
      projectId: 'project',
      sessionId: 'session',
      settingsStore: settingsStore as never,
      sessionMetaStore: sessionMetaStore({ permissionMode: 'default', model: 'sonnet', effort: 'low' }),
    })).toEqual({
      permissionMode: 'default',
      model: 'sonnet',
      effort: 'low',
    })
  })
})

describe('validateTurnOptions', () => {
  it('requires effort to be anchored by a concrete model', () => {
    expect(validateTurnOptions({ permissionMode: 'default', model: 'default', effort: 'high' }, settingsStore as never)).toEqual({ ok: false, error: 'unsupported_effort' })
  })

  it('validates model by value and resolved model', () => {
    expect(validateTurnOptions({ permissionMode: 'default', model: 'sonnet', effort: 'high' }, settingsStore as never)).toEqual({ ok: true })
    expect(validateTurnOptions({ permissionMode: 'default', model: 'claude-sonnet-5', effort: 'high' }, settingsStore as never)).toEqual({ ok: true })
  })

  it('rejects unsupported effort for the selected model', () => {
    expect(validateTurnOptions({ permissionMode: 'default', model: 'haiku', effort: 'high' }, settingsStore as never)).toEqual({ ok: false, error: 'unsupported_effort' })
  })

  it('accepts historical non-1m ids when a matching 1m catalog value exists', () => {
    expect(validateTurnOptions({ permissionMode: 'default', model: 'claude-gpt-5-6-sol-max', effort: 'high' }, settingsStore as never)).toEqual({ ok: true })
  })
})

describe('normalizeModelEffortSelection', () => {
  it('normalizes to the only matching 1m catalog value', () => {
    expect(normalizeModelEffortSelection({ model: 'claude-gpt-5-6-sol-max', effort: 'high' }, settingsStore.getAll() as never)).toEqual({ model: 'claude-gpt-5-6-sol-max[1m]', effort: 'high' })
  })

  it('chooses between 1m and non-1m siblings from settings', () => {
    expect(normalizeModelEffortSelection({ model: 'claude-gpt-5-5-max', effort: 'xhigh' }, settingsStore.getAll() as never)).toEqual({ model: 'claude-gpt-5-5-max[1m]', effort: 'xhigh' })
    expect(normalizeModelEffortSelection({ model: 'claude-gpt-5-5-max', effort: 'xhigh' }, { ...settingsStore.getAll(), useOneMillionContext: false } as never)).toEqual({ model: 'claude-gpt-5-5-max', effort: 'high' })
  })
})

describe('mergeTranscriptModelEffort', () => {
  it('clears effort for models that do not support effort', () => {
    expect(mergeTranscriptModelEffort({ currentModel: 'sonnet', currentEffort: 'high', observedModel: 'haiku', settings: settingsStore.getAll() as never })).toEqual({ model: 'haiku', effort: null })
  })

  it('defaults to medium when switching from no-effort support to effort support', () => {
    expect(mergeTranscriptModelEffort({ currentModel: 'haiku', currentEffort: null, observedModel: 'sonnet', settings: settingsStore.getAll() as never })).toEqual({ model: 'sonnet', effort: 'medium' })
  })

  it('preserves supported effort when switching between effort-capable models', () => {
    expect(mergeTranscriptModelEffort({ currentModel: 'sonnet', currentEffort: 'high', observedModel: 'opus', settings: settingsStore.getAll() as never })).toEqual({ model: 'opus', effort: 'high' })
  })

  it('downgrades unsupported current effort for a new model', () => {
    expect(mergeTranscriptModelEffort({ currentModel: 'opus', currentEffort: 'max', observedModel: 'sonnet', settings: settingsStore.getAll() as never })).toEqual({ model: 'sonnet', effort: 'high' })
  })
})
