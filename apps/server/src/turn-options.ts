import {
  appSettingsSchema,
  type AppSettings,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelSelection,
  type PermissionMode,
} from '@cotta/shared'
import type { SettingsStore } from './settings-store.js'
import type { SessionMetaStore } from './session-meta-store.js'

function matchingCatalogModel(models: ModelCatalogItem[], model: string): ModelCatalogItem | undefined {
  return models.find((item) => item.value === model || item.resolvedModel === model)
}

export function readSettings(settingsStore?: SettingsStore): AppSettings {
  return appSettingsSchema.parse(settingsStore?.getAll('global') ?? {})
}

export type ResolvedTurnOptions = {
  permissionMode: PermissionMode
  model: ModelSelection | DefaultTurnOption | null
  effort: EffortLevel | DefaultTurnOption | null
}

export type TurnOptionsSessionMetaStore = Pick<SessionMetaStore, 'getSessionMeta'>

export function resolveTurnOptions(input: { projectId: string; sessionId?: string; settingsStore?: SettingsStore; sessionMetaStore?: TurnOptionsSessionMetaStore }): ResolvedTurnOptions {
  const globalSettings = readSettings(input.settingsStore)
  const sessionMeta = input.sessionId ? input.sessionMetaStore?.getSessionMeta(input.projectId, input.sessionId) : null
  return {
    permissionMode: sessionMeta?.permissionMode ?? globalSettings.defaultPermissionMode ?? 'default',
    model: sessionMeta ? sessionMeta.model : globalSettings.defaultModel ?? null,
    effort: sessionMeta ? sessionMeta.effort : globalSettings.defaultEffort ?? null,
  }
}

export function sdkModel(model: ResolvedTurnOptions['model']): ModelSelection | undefined {
  return !model || model === 'default' ? undefined : model
}

export function sdkEffort(effort: ResolvedTurnOptions['effort']): EffortLevel | undefined {
  return !effort || effort === 'default' ? undefined : effort
}

export function persistedTurnOptions(options: ResolvedTurnOptions) {
  return { ...options, model: sdkModel(options.model) ?? null, effort: sdkEffort(options.effort) ?? null }
}

export function validateTurnOptions(options: ResolvedTurnOptions, settingsStore?: SettingsStore): { ok: true } | { ok: false; error: 'unsupported_model' | 'unsupported_effort' } {
  const modelValue = sdkModel(options.model)
  const effortValue = sdkEffort(options.effort)
  if (!modelValue && !effortValue) return { ok: true }
  const catalog = readSettings(settingsStore).modelCatalog
  if (!catalog) return { ok: true }
  const model = modelValue ? matchingCatalogModel(catalog.models, modelValue) : catalog.models[0]
  if (!model) return { ok: false, error: 'unsupported_model' }
  if (effortValue && (!model.supportsEffort || !model.supportedEffortLevels?.includes(effortValue))) return { ok: false, error: 'unsupported_effort' }
  return { ok: true }
}
