import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RuntimeConfig } from './schema.js'
import { ENV } from './env.js'

export const DEFAULT_RUNTIME_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
export const DEFAULT_AGENT_ID = 'local-dev'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function expandEnvString(input: string): string {
  return input.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    return process.env[name] ?? ''
  })
}

function expandEnvValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return expandEnvString(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvValue(item))
  }
  const record = asRecord(value)
  if (!record) return value

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, expandEnvValue(entry)]),
  )
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function buildLegacyFallbackRuntimeConfig(): RuntimeConfig {
  const defaultModel = ENV.defaultModel.trim()
  return {
    connectors: [],
    channels: [],
    agents: [{
      agentId: DEFAULT_AGENT_ID,
      projectDir: process.cwd(),
      modelJson: defaultModel ? { model: defaultModel } : {},
      permissionMode: 'default',
    }],
  }
}

export function resolveRuntimeConfigPath(): string | null {
  const explicitPath = ENV.runtimeSettingsPath.trim()
  if (explicitPath) {
    return explicitPath
  }
  if (existsSync(DEFAULT_RUNTIME_SETTINGS_PATH)) {
    return DEFAULT_RUNTIME_SETTINGS_PATH
  }
  return null
}

export function loadRuntimeConfigSync(configPath: string | null = resolveRuntimeConfigPath()): RuntimeConfig {
  if (!configPath || !existsSync(configPath)) {
    return buildLegacyFallbackRuntimeConfig()
  }

  const raw = readFileSync(configPath, 'utf-8')
  const parsed = expandEnvValue(JSON.parse(raw))
  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`Invalid runtime config: expected object at ${configPath}`)
  }

  const config: RuntimeConfig = {
    connectors: toArray(record.connectors),
    channels: toArray(record.channels),
    agents: toArray(record.agents),
  }

  if (config.agents.length === 0) {
    return buildLegacyFallbackRuntimeConfig()
  }

  return config
}
