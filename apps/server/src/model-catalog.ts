import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelCatalogResponse } from '@cotta/shared'

const MODEL_CATALOG_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; response: ModelCatalogResponse }>()

function emptyPrompt(): AsyncIterable<never> {
  return (async function* () {})()
}

export type ModelCatalogProvider = (cwd?: string) => Promise<ModelCatalogResponse>

export const defaultModelCatalogProvider: ModelCatalogProvider = async (cwd = process.cwd()) => {
  const cached = cache.get(cwd)
  if (cached && cached.expiresAt > Date.now()) return cached.response

  const sdkQuery = query({ prompt: emptyPrompt(), options: { cwd } })
  try {
    const response = await sdkQuery.initializationResult()
    cache.set(cwd, { expiresAt: Date.now() + MODEL_CATALOG_TTL_MS, response })
    return response
  } finally {
    sdkQuery.close()
  }
}
