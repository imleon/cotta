import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ModelCatalogItem, ModelCatalogResponse } from '@cotta/shared'

const MODEL_CATALOG_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; response: ModelCatalogResponse }>()

function emptyPrompt(): AsyncIterable<never> {
  return (async function* () {})()
}

function toCatalogItem(model: ModelInfo): ModelCatalogItem {
  return {
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsFastMode: model.supportsFastMode,
    supportsAutoMode: model.supportsAutoMode,
  }
}

export type ModelCatalogProvider = (cwd?: string) => Promise<ModelCatalogResponse>

export const defaultModelCatalogProvider: ModelCatalogProvider = async (cwd = process.cwd()) => {
  const cached = cache.get(cwd)
  if (cached && cached.expiresAt > Date.now()) return cached.response

  const sdkQuery = query({ prompt: emptyPrompt(), options: { cwd } })
  try {
    const response = { models: (await sdkQuery.supportedModels()).map(toCatalogItem) }
    cache.set(cwd, { expiresAt: Date.now() + MODEL_CATALOG_TTL_MS, response })
    return response
  } finally {
    sdkQuery.close()
  }
}
