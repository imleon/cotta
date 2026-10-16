import { homedir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelCatalogResponse } from '@cotta/shared'

export type ModelCatalogProvider = (cwd?: string) => Promise<ModelCatalogResponse>

export const defaultModelCatalogProvider: ModelCatalogProvider = async (cwd = homedir()) => {
  const sdkQuery = query({ prompt: (async function* () {})(), options: { cwd } })
  try {
    return await sdkQuery.initializationResult()
  } finally {
    sdkQuery.close()
  }
}
