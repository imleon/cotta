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

/**
 * Like defaultModelCatalogProvider but queries the SDK with provider env merged in (e.g. a gateway's
 * ANTHROPIC_BASE_URL/AUTH_TOKEN), so a provider that supplies only envForTurn still lists the models
 * its backend actually serves instead of official Anthropic's.
 */
export function providerModelCatalogProvider(env: Record<string, string>): ModelCatalogProvider {
  return async (cwd = homedir()) => {
    const sdkQuery = query({ prompt: (async function* () {})(), options: { cwd, env: { ...process.env, ...env } } })
    try {
      return await sdkQuery.initializationResult()
    } finally {
      sdkQuery.close()
    }
  }
}
