import { homedir } from 'node:os'
import type { ModelCatalogResponse } from '@cotta/shared'
import { query } from './claude-cli/query.js'

export type ModelCatalogProvider = (cwd?: string) => Promise<ModelCatalogResponse>

/**
 * Queries the system Claude Code CLI for the model catalog. With `env` (a provider's ANTHROPIC_BASE_URL/AUTH_TOKEN
 * pointing at a gateway) it lists the models that backend serves instead of official Anthropic's;
 * with no env it's the stock official-Anthropic catalog.
 */
export function modelCatalogProvider(env?: Record<string, string>): ModelCatalogProvider {
  return async (cwd = homedir()) => {
    const options = env ? { cwd, env: { ...process.env, ...env } } : { cwd }
    const cliQuery = query({ prompt: (async function* () {})(), options })
    try {
      return await cliQuery.initializationResult()
    } finally {
      await cliQuery.close()
    }
  }
}

export const defaultModelCatalogProvider: ModelCatalogProvider = modelCatalogProvider()
