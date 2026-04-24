import type { Hono } from 'hono'
import type { RuntimeConfig } from '../../../config/schema.js'
import type { MutableConfigRegistry } from '../../../config/registry.js'
import {
  RuntimeConfigWrapperSchema,
  type RuntimeConfigWrapper,
  runtimeConfigIntegrityIssues,
} from '../../../config/zod-schemas.js'
import type { Orchestrator } from '../../../orchestration/orchestrator.js'
import type { SqliteConfigRepository } from '../../../storage/sqlite/config-repository.js'
import type { AppEnv } from '../app-env.js'
import {
  getValidatedBody,
  sendError,
  sendInternalError,
  validateJsonBody,
} from '../validation.js'

type SessionRegistryLike = {
  ensure: (sessionId: string, agentId: string, init?: { channelId?: string }) => void
  claimChannel: (sessionId: string, channelId: string) => void
  releaseChannel: (channelId: string) => void
}

function applyRuntimeConfigToSessionRegistry(
  config: RuntimeConfig,
  sessionRegistry: SessionRegistryLike,
): void {
  for (const channel of config.channels) {
    if (channel.currentSdkSessionId) {
      sessionRegistry.ensure(channel.currentSdkSessionId, channel.agentId)
      sessionRegistry.claimChannel(channel.currentSdkSessionId, channel.channelId)
    } else {
      sessionRegistry.releaseChannel(channel.channelId)
    }
  }
}

export function registerConfigRoutes(app: Hono<AppEnv>, input: {
  configDbPath: string
  configRepository: SqliteConfigRepository
  configRegistry: MutableConfigRegistry
  sessionRegistry: SessionRegistryLike
  orchestrator: Orchestrator
}) {
  app.get('/api/config/overview', (c) => {
    return c.json({
      dbPath: input.configDbPath,
      updatedAt: input.configRepository.getLastUpdatedAt(),
      config: input.configRepository.loadRuntimeConfig(),
    })
  })

  app.put(
    '/api/config/overview',
    validateJsonBody(RuntimeConfigWrapperSchema),
    async (c) => {
      const startedAt = Date.now()
      const logger = c.get('logger')
      const { config } = getValidatedBody<RuntimeConfigWrapper>(c)

      const integrityIssues = runtimeConfigIntegrityIssues(config)
      if (integrityIssues.length > 0) {
        return sendError(c, 400, 'config_integrity_error', integrityIssues.join('；'), {
          details: { issues: integrityIssues },
        })
      }

      try {
        input.configRepository.replaceRuntimeConfig(config)
        input.configRegistry.update(config)
        applyRuntimeConfigToSessionRegistry(config, input.sessionRegistry)
        const refresh = await input.orchestrator.refreshConfigDependentSessions()
        const updatedAt = input.configRepository.getLastUpdatedAt()
        logger.info('http:config:save:success', {
          durationMs: Date.now() - startedAt,
          connectors: config.connectors.length,
          agents: config.agents.length,
          channels: config.channels.length,
          refreshedSessions: refresh.checked,
          rebuiltIdleWorkers: refresh.rebuilt,
        })
        return c.json({ ok: true, updatedAt })
      } catch (error) {
        logger.error('http:config:save:error', {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'config_save_failed', error)
      }
    },
  )
}
