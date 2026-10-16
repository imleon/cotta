import { type AppSettings, appSettingsSchema, type DefaultTurnOption, type EffortLevel, type ModelSelection, matchingCatalogModel, type PermissionMode, supportedEffortLevels } from '@cotta/shared'

export { mergeTranscriptModelEffort, normalizeModelEffortSelection } from '@cotta/shared'

import type { SettingsStore } from './settings-store.js'
import type { TurnOptionsStore } from './turn-options-store.js'

const DEFAULT_MODEL: DefaultTurnOption = 'default'
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'
const DEFAULT_EFFORT: EffortLevel = 'medium'

export function readSettings(settingsStore?: SettingsStore): AppSettings {
  return appSettingsSchema.parse(settingsStore?.getAll('global') ?? {})
}

export type ResolvedTurnOptions = {
  permissionMode: PermissionMode
  model: ModelSelection | DefaultTurnOption
  effort: EffortLevel | null
}

export type TurnOptionsStoreReader = Pick<TurnOptionsStore, 'getSessionTurnOptions'>

export function resolveTurnOptions(input: { sessionId?: string; settingsStore?: SettingsStore; turnOptionsStore?: TurnOptionsStoreReader }): ResolvedTurnOptions {
  const globalSettings = readSettings(input.settingsStore)
  const sessionTurnOptions = input.sessionId ? input.turnOptionsStore?.getSessionTurnOptions(input.sessionId) : null
  const sessionModelSet = sessionTurnOptions?.model != null
  return {
    permissionMode: sessionTurnOptions?.permissionMode ?? globalSettings.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
    model: sessionModelSet ? sessionTurnOptions.model! : (globalSettings.defaultModel ?? DEFAULT_MODEL),
    effort: sessionModelSet ? (sessionTurnOptions.effort ?? (sessionTurnOptions.model === DEFAULT_MODEL ? DEFAULT_EFFORT : null)) : globalSettings.defaultEffort,
  }
}

export function sdkEffort(effort: ResolvedTurnOptions['effort'] | DefaultTurnOption): EffortLevel | undefined {
  return !effort || effort === DEFAULT_MODEL ? undefined : effort
}

export function persistedTurnOptions(options: ResolvedTurnOptions) {
  return { ...options, model: options.model, effort: sdkEffort(options.effort) ?? null }
}

export function validateTurnOptions(options: ResolvedTurnOptions, settingsStore?: SettingsStore): { ok: true } | { ok: false; error: 'unsupported_model' | 'unsupported_effort' } {
  const modelValue = options.model
  const effortValue = sdkEffort(options.effort)
  const settings = readSettings(settingsStore)
  const catalog = settings.modelCatalog
  if (!catalog) return { ok: true }
  const model = matchingCatalogModel(catalog.models, modelValue, settings)
  if (!model) return { ok: false, error: 'unsupported_model' }
  if (effortValue && !supportedEffortLevels(model).includes(effortValue)) return { ok: false, error: 'unsupported_effort' }
  return { ok: true }
}
