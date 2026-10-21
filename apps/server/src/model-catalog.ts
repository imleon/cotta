import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelCatalogResponse } from '@cotta/shared'

export type ModelCatalogProvider = (cwd?: string) => Promise<ModelCatalogResponse>

/**
 * Queries the SDK for the model catalog. With `env` (a provider's ANTHROPIC_BASE_URL/AUTH_TOKEN
 * pointing at a gateway) it lists the models that backend serves instead of official Anthropic's;
 * with no env it's the stock official-Anthropic catalog.
 */
export function modelCatalogProvider(env?: Record<string, string>): ModelCatalogProvider {
  return async (cwd = homedir()) => {
    const options = env ? { cwd, env: { ...process.env, ...env } } : { cwd }
    const sdkQuery = query({ prompt: (async function* () {})(), options })
    try {
      return await sdkQuery.initializationResult()
    } finally {
      sdkQuery.close()
    }
  }
}

export const defaultModelCatalogProvider: ModelCatalogProvider = modelCatalogProvider()
