import { getSession, listAllSessions, getMessagesPage, listSessionsByProjectDir, listSessionsByProjectDirs } from '../storage/fs/sessions.js'
import { readSessionPersistentLogs, readSessionSdkRawLogs } from '../storage/fs/transport-logs.js'
import { DEFAULT_AGENT_ID, configRegistry, orchestrator, runRegistry, sessionRegistry } from '../app/index.js'
import { LarkIntegrationService } from '../integrations/lark/service.js'
import { CONFIG } from './config.js'
import { createLogger, shortId } from './logger.js'

const logger = createLogger('web')
const larkIntegration = new LarkIntegrationService({
  configRegistry,
  sessionRegistry,
  orchestrator,
  logger,
})
larkIntegration.start()

export function createServerContext() {
  return {
    config: CONFIG,
    logger,
    shortId,
    defaultAgentId: DEFAULT_AGENT_ID,

    configRegistry,
    orchestrator,
    runRegistry,
    sessionRegistry,

    larkIntegration,
    getSession,
    listAllSessions,
    listSessionsByProjectDir,
    getMessagesPage,
    listSessionsByProjectDirs,
    readSessionPersistentLogs,
    readSessionSdkRawLogs,
  }
}

export type ServerContext = ReturnType<typeof createServerContext>
