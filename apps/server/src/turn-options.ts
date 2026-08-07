import {
  appSettingsSchema,
  type AppSettings,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelCatalogResponse,
  type ModelSelection,
  type PermissionMode,
} from '@cotta/shared'
import type { SettingsStore } from './settings-store.js'
import type { SessionMetaStore } from './session-meta-store.js'

const DEFAULT_MODEL: DefaultTurnOption = 'default'
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'
const DEFAULT_TRANSCRIPT_EFFORT: EffortLevel = 'medium'
const EFFORT_ORDER: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']

function modelIds(model: ModelCatalogItem): string[] {
  return [model.value, model.resolvedModel].filter((value): value is string => Boolean(value))
}

function baseModelId(model: string): string {
  return model.replace(/\[[^\]]+\]$/, '')
}

function isOneMillionModel(model: ModelCatalogItem): boolean {
  return modelIds(model).some((id) => /\[1m\]$/.test(id))
}

function matchingCatalogModel(models: ModelCatalogItem[], model: string, settings?: Pick<AppSettings, 'useOneMillionContext'>): ModelCatalogItem | undefined {
  const base = baseModelId(model)
  const candidates = models.filter((item) => modelIds(item).some((id) => id === model || baseModelId(id) === base))
  if (candidates.length <= 1) return candidates[0]
  const oneMillion = candidates.find(isOneMillionModel)
  const standard = candidates.find((item) => !isOneMillionModel(item))
  return settings?.useOneMillionContext === false ? standard ?? oneMillion : oneMillion ?? standard
}

function supportedEffortLevels(model?: ModelCatalogItem): EffortLevel[] {
  return model?.supportsEffort ? model.supportedEffortLevels ?? [] : []
}

function downgradeEffort(effort: EffortLevel, supported: EffortLevel[]): EffortLevel | null {
  if (supported.includes(effort)) return effort
  const start = EFFORT_ORDER.indexOf(effort)
  const lowerOrEqual = start >= 0 ? EFFORT_ORDER.slice(start + 1) : EFFORT_ORDER
  return lowerOrEqual.find((level) => supported.includes(level)) ?? EFFORT_ORDER.find((level) => supported.includes(level)) ?? null
}

function modelSupportsEffort(model?: ModelCatalogItem): boolean {
  return supportedEffortLevels(model).length > 0
}

export function readSettings(settingsStore?: SettingsStore): AppSettings {
  return appSettingsSchema.parse(settingsStore?.getAll('global') ?? {})
}

export type ResolvedTurnOptions = {
  permissionMode: PermissionMode
  model: ModelSelection | DefaultTurnOption
  effort: EffortLevel | null
}

export type TurnOptionsSessionMetaStore = Pick<SessionMetaStore, 'getSessionMeta'>

export function resolveTurnOptions(input: { projectId: string; sessionId?: string; settingsStore?: SettingsStore; sessionMetaStore?: TurnOptionsSessionMetaStore }): ResolvedTurnOptions {
  const globalSettings = readSettings(input.settingsStore)
  const sessionMeta = input.sessionId ? input.sessionMetaStore?.getSessionMeta(input.projectId, input.sessionId) : null
  const sessionModelSet = sessionMeta?.model != null
  const settingsModelSet = globalSettings.defaultModel != null
  return {
    permissionMode: sessionMeta?.permissionMode ?? globalSettings.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
    model: sessionModelSet ? sessionMeta.model! : settingsModelSet ? globalSettings.defaultModel! : DEFAULT_MODEL,
    effort: sessionModelSet ? sessionMeta.effort ?? null : settingsModelSet ? globalSettings.defaultEffort ?? null : null,
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
  if (modelValue === DEFAULT_MODEL) return effortValue ? { ok: false, error: 'unsupported_effort' } : { ok: true }
  const catalog = readSettings(settingsStore).modelCatalog
  if (!catalog) return { ok: true }
  const model = matchingCatalogModel(catalog.models, modelValue, readSettings(settingsStore))
  if (!model) return { ok: false, error: 'unsupported_model' }
  if (effortValue && !supportedEffortLevels(model).includes(effortValue)) return { ok: false, error: 'unsupported_effort' }
  return { ok: true }
}

export function normalizeModelEffortSelection(input: { model: ModelSelection | DefaultTurnOption | null; effort: EffortLevel | null }, settings?: Pick<AppSettings, 'modelCatalog' | 'useOneMillionContext'>): { model: ModelSelection | DefaultTurnOption | null; effort: EffortLevel | null } {
  if (input.model == null) return { model: null, effort: null }
  if (input.model === DEFAULT_MODEL) return { model: DEFAULT_MODEL, effort: null }
  const catalogModel = settings?.modelCatalog ? matchingCatalogModel(settings.modelCatalog.models, input.model, settings) : undefined
  if (!catalogModel) return input
  const supported = supportedEffortLevels(catalogModel)
  if (!supported.length) return { model: catalogModel.value, effort: null }
  return { model: catalogModel.value, effort: input.effort ? downgradeEffort(input.effort, supported) : null }
}

export function mergeTranscriptModelEffort(input: {
  currentModel: ModelSelection | DefaultTurnOption | null
  currentEffort: EffortLevel | null
  observedModel?: ModelSelection | null
  observedEffort?: EffortLevel | null
  settings?: AppSettings
}): { model: ModelSelection | DefaultTurnOption; effort: EffortLevel | null } {
  const catalog = input.settings?.modelCatalog
  const currentModel = input.currentModel ?? input.settings?.defaultModel ?? DEFAULT_MODEL
  const currentEffort = input.currentModel != null
    ? input.currentEffort
    : input.settings?.defaultModel != null
      ? input.settings.defaultEffort ?? null
      : null
  const observedCatalogModel = input.observedModel && catalog ? matchingCatalogModel(catalog.models, input.observedModel, input.settings) : undefined
  const targetModel = observedCatalogModel?.value ?? input.observedModel ?? currentModel
  if (targetModel === DEFAULT_MODEL) return { model: DEFAULT_MODEL, effort: null }
  const targetCatalogModel = catalog ? matchingCatalogModel(catalog.models, targetModel, input.settings) : undefined
  const targetSupported = supportedEffortLevels(targetCatalogModel)
  if (targetCatalogModel && !targetSupported.length) return { model: targetModel, effort: null }
  if (input.observedEffort) return { model: targetModel, effort: targetSupported.length ? downgradeEffort(input.observedEffort, targetSupported) : input.observedEffort }
  if (!targetCatalogModel) return { model: targetModel, effort: currentEffort }
  if (currentEffort) return { model: targetModel, effort: downgradeEffort(currentEffort, targetSupported) }
  const currentCatalogModel = catalog ? matchingCatalogModel(catalog.models, currentModel, input.settings) : undefined
  if (currentCatalogModel && modelSupportsEffort(currentCatalogModel)) return { model: targetModel, effort: null }
  return { model: targetModel, effort: targetSupported.includes(DEFAULT_TRANSCRIPT_EFFORT) ? DEFAULT_TRANSCRIPT_EFFORT : targetSupported[0] ?? null }
}
