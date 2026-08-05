import {
  appSettingsSchema,
  type AppSettings,
  type CreateTurnRequest,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelSelection,
  type PermissionMode,
} from '@cotta/shared'
import type { SettingsStore } from './settings-store.js'

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

export function resolveTurnOptions(input: { body?: Pick<CreateTurnRequest, 'permissionMode' | 'model' | 'effort'>; projectId: string; sessionId?: string; settingsStore?: SettingsStore }): ResolvedTurnOptions {
  const globalSettings = readSettings(input.settingsStore)
  const sessionSettings = input.sessionId ? input.settingsStore?.getSessionSettings(input.projectId, input.sessionId) : null
  return {
    permissionMode: input.body?.permissionMode ?? sessionSettings?.permissionMode ?? globalSettings.defaultPermissionMode ?? 'default',
    model: input.body?.model ?? sessionSettings?.model ?? globalSettings.defaultModel ?? null,
    effort: input.body?.effort ?? sessionSettings?.effort ?? globalSettings.defaultEffort ?? null,
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
