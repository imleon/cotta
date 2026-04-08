import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import { createWebSocketHandler } from './channels-web-adapter.js'
import { createLarkOutboundMessage, deliverLarkSessionEvent, invokeLarkCardAction, invokeLarkEvent, sendLarkTextMessage } from './lark-adapter.js'
import { CONFIG } from './config.js'
import { RunCoordinator } from './run-coordinator.js'
import type { StaticMetadataSnapshot, StaticMetadataTreeNode } from '../shared/message-types.js'
import { listAllSessions, getMessagesPage } from './sessions.js'
import { appendSessionChannelLog, readSessionChannelLogs, readSessionPersistentLogs, readSessionRuntimeLogs, readSessionTransportLogs } from './transport-logs.js'
import { createLogger, shortId } from './logger.js'
import { buildSdkExportTree, mapTree, overlayNodeValues } from './sdk-type-tree.js'

const logger = createLogger('web')
export const coordinator = new RunCoordinator()

coordinator.subscribe('lark-outbound-observer', (event, record) => {
  void deliverLarkSessionEvent(event, record)
})

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SDK_DIR = resolve(ROOT_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk')
const PROJECT_CLAUDE_DIR = resolve(ROOT_DIR, '.claude')
const SETTINGS_LOCAL_PATH = resolve(PROJECT_CLAUDE_DIR, 'settings.local.json')
const USER_STATE_PATH = resolve(homedir(), '.claude.json')
const SDK_PACKAGE_JSON_PATH = resolve(SDK_DIR, 'package.json')
const SDK_MANIFEST_JSON_PATH = resolve(SDK_DIR, 'manifest.json')
const SDK_DTS_PATH = resolve(SDK_DIR, 'sdk.d.ts')

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value)
}

async function writeChannelLog(params: {
  sessionId?: string
  runId?: string
  channel: 'web' | 'lark' | 'discord'
  direction: 'inbound' | 'outbound' | 'internal'
  eventName: string
  conversationKey?: string
  platformMessageId?: string
  payloadSummary?: string
  payload?: unknown
}): Promise<void> {
  if (!isSafeSessionId(params.sessionId)) return
  await appendSessionChannelLog(params.sessionId, {
    source: 'channel',
    channel: params.channel,
    direction: params.direction,
    eventName: params.eventName,
    ...(params.conversationKey ? { conversationKey: params.conversationKey } : {}),
    ...(params.platformMessageId ? { platformMessageId: params.platformMessageId } : {}),
    ...(params.payloadSummary ? { payloadSummary: params.payloadSummary } : {}),
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
  }, params.runId)
}

function createNode(input: {
  key: string
  path: string
  label?: string
  kind: StaticMetadataTreeNode['kind']
  status?: StaticMetadataTreeNode['status']
  description?: string
  source?: string
  value?: unknown
  requiresSession?: boolean
  children?: StaticMetadataTreeNode[]
  meta?: Record<string, unknown>
}): StaticMetadataTreeNode {
  return {
    key: input.key,
    path: input.path,
    label: input.label ?? input.key,
    kind: input.kind,
    status: input.status ?? 'resolved',
    ...(input.description ? { description: input.description } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.requiresSession ? { requiresSession: true } : {}),
    ...(input.children ? { children: input.children } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

function inferKind(value: unknown): StaticMetadataTreeNode['kind'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      return 'unknown'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function toLabel(key: string): string {
  if (!key) return key
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
}

function objectFromEntries(value: Record<string, unknown>, path: string, source: string, description?: string): StaticMetadataTreeNode {
  const children = Object.entries(value).map(([key, entry]) => valueToNode(`${path}.${key}`, entry, source))
  return createNode({
    key: path.split('.').pop() || path,
    path,
    label: toLabel(path.split('.').pop() || path),
    kind: 'object',
    source,
    description,
    value,
    children,
  })
}

function arrayToNode(path: string, items: unknown[], source: string, description?: string): StaticMetadataTreeNode {
  const children = items.map((item, index) => valueToNode(`${path}[${index}]`, item, source))
  return createNode({
    key: path.split('.').pop() || path,
    path,
    label: toLabel(path.split('.').pop() || path),
    kind: 'array',
    source,
    description,
    value: items,
    children,
    meta: { length: items.length },
  })
}

function valueToNode(path: string, value: unknown, source: string, description?: string): StaticMetadataTreeNode {
  const key = path.endsWith(']') ? path.slice(path.lastIndexOf('[') + 1, -1) : path.split('.').pop() || path
  if (Array.isArray(value)) {
    return arrayToNode(path, value, source, description)
  }
  const record = asRecord(value)
  if (record) {
    return objectFromEntries(record, path, source, description)
  }
  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: inferKind(value),
    source,
    description,
    value,
  })
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function buildInstallGroup(pkg: unknown, manifest: unknown): StaticMetadataTreeNode {
  const source = 'sdk package.json + manifest.json'
  const packageNode = valueToNode('install.package', pkg ?? {}, 'sdk package.json', 'SDK npm 包元数据')
  const manifestNode = valueToNode('install.manifest', manifest ?? {}, 'sdk manifest.json', 'Claude Code 安装清单')
  return createNode({
    key: 'install',
    path: 'install',
    label: 'Install',
    kind: 'group',
    source,
    children: [packageNode, manifestNode],
  })
}

function normalizeTreeSource(node: StaticMetadataTreeNode, source: string): StaticMetadataTreeNode {
  return mapTree(node, (entry) => ({
    ...entry,
    source,
  }))
}

function markTreeSessionRequired(node: StaticMetadataTreeNode): StaticMetadataTreeNode {
  return mapTree(node, (entry) => ({
    ...entry,
    status: 'session-required',
    requiresSession: true,
  }))
}

function buildAccountGroup(userState: unknown): StaticMetadataTreeNode {
  const source = 'sdk.d.ts AccountInfo + ~/.claude.json'
  const state = asRecord(userState)
  const claude = asRecord(state?.oauthAccount)
  const accountTree = buildSdkExportTree(SDK_DTS_PATH, 'AccountInfo', 'account', {
    source,
    maxDepth: 3,
  })

  const overlay: Record<string, unknown> = {}
  if (typeof claude?.emailAddress === 'string') overlay.email = claude.emailAddress
  if (typeof claude?.organizationName === 'string') overlay.organization = claude.organizationName
  if (typeof claude?.organizationType === 'string') overlay.subscriptionType = claude.organizationType

  return Object.keys(overlay).length > 0
    ? overlayNodeValues(accountTree, overlay, source)
    : accountTree
}

function buildAgentGroup(): StaticMetadataTreeNode {
  const source = 'sdk.d.ts AgentInfo / AgentDefinition'
  return createNode({
    key: 'agent',
    path: 'agent',
    label: 'Agent',
    kind: 'group',
    source,
    children: [
      buildSdkExportTree(SDK_DTS_PATH, 'AgentInfo', 'agent.agentInfo', {
        source,
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'AgentDefinition', 'agent.agentDefinition', {
        source,
        maxDepth: 4,
        maxUnionVariants: 12,
      }),
    ],
  })
}

function buildConfigGroup(localSettings: unknown): StaticMetadataTreeNode {
  const source = 'project settings + sdk.d.ts'
  const localSettingsNode = valueToNode('config.localSettings', localSettings ?? {}, 'project .claude/settings.local.json', '项目本地 Claude 配置')
  const settingsSchemaNode = buildSdkExportTree(SDK_DTS_PATH, 'Settings', 'config.settingsSchema', {
    source: 'sdk.d.ts Settings',
    maxDepth: 3,
    maxProperties: 60,
    maxUnionVariants: 10,
  })
  const pluginNode = buildSdkExportTree(SDK_DTS_PATH, 'SdkPluginConfig', 'config.plugin', {
    source: 'sdk.d.ts SdkPluginConfig',
    maxDepth: 3,
  })
  const mcpNode = createNode({
    key: 'mcp',
    path: 'config.mcp',
    label: 'Mcp',
    kind: 'object',
    source: 'sdk.d.ts MCP types',
    status: 'unavailable',
    children: [
      buildSdkExportTree(SDK_DTS_PATH, 'McpClaudeAIProxyServerConfig', 'config.mcp.claudeAiProxy', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpHttpServerConfig', 'config.mcp.http', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSdkServerConfig', 'config.mcp.sdk', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSSEServerConfig', 'config.mcp.sse', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpStdioServerConfig', 'config.mcp.stdio', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpServerStatus', 'config.mcp.status', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 4,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSetServersResult', 'config.mcp.setServersResult', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
    ],
  })
  return createNode({
    key: 'config',
    path: 'config',
    label: 'Config',
    kind: 'group',
    source,
    children: [localSettingsNode, settingsSchemaNode, pluginNode, mcpNode],
  })
}

function buildCapabilitiesGroup(localSettings: unknown, pkg: unknown, userState: unknown): StaticMetadataTreeNode {
  const settings = asRecord(localSettings)
  const packageJson = asRecord(pkg)
  const state = asRecord(userState)
  const capabilities = {
    settingsSchema: true,
    localSettings: Boolean(settings),
    accountMetadata: Boolean(asRecord(state?.oauthAccount)?.emailAddress),
    plugins: Array.isArray(settings?.enabledPlugins) || Boolean(settings?.pluginConfigs),
    mcp: ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedMcpServers', 'deniedMcpServers'].some((key) => key in (settings ?? {})),
    modelConfig: typeof settings?.model === 'string' || Array.isArray(settings?.availableModels),
    installMetadata: typeof packageJson?.version === 'string',
  }
  return createNode({
    key: 'capabilities',
    path: 'capabilities',
    label: 'Capabilities',
    kind: 'group',
    source: 'derived from static sources',
    children: Object.entries(capabilities).map(([key, value]) => createNode({
      key,
      path: `capabilities.${key}`,
      label: toLabel(key),
      kind: 'boolean',
      source: 'derived from static sources',
      value,
    })),
  })
}

function buildSessionOnlyGroup(): StaticMetadataTreeNode {
  const source = 'SDKSystemMessage / runtime APIs'
  const sessionTree = buildSdkExportTree(SDK_DTS_PATH, 'SDKSystemMessage', 'sessionOnly', {
    source,
    maxDepth: 3,
  })
  return markTreeSessionRequired(normalizeTreeSource(sessionTree, source))
}

async function buildStaticMetadataSnapshot(): Promise<StaticMetadataSnapshot> {
  const [pkg, manifest, localSettings, userState] = await Promise.all([
    readJsonFile(SDK_PACKAGE_JSON_PATH),
    readJsonFile(SDK_MANIFEST_JSON_PATH),
    readJsonFile(SETTINGS_LOCAL_PATH),
    readJsonFile(USER_STATE_PATH),
  ])
  return {
    generatedAt: Date.now(),
    groups: [
      buildInstallGroup(pkg, manifest),
      buildAccountGroup(userState),
      buildAgentGroup(),
      buildConfigGroup(localSettings),
      buildCapabilitiesGroup(localSettings, pkg, userState),
      buildSessionOnlyGroup(),
    ],
  }
}

function isAuthorizedToken(token?: string | null): boolean {
  if (!CONFIG.authEnabled) return true
  if (!token) return false

  const expected = Buffer.from(CONFIG.authToken)
  const actual = Buffer.from(token)
  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}

function getBearerToken(header?: string | null): string | null {
  if (!header) return null
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : null
}

function getLarkConfigStatus() {
  return {
    configured: Boolean(CONFIG.lark.appId && CONFIG.lark.appSecret),
    hasAppId: Boolean(CONFIG.lark.appId),
    hasAppSecret: Boolean(CONFIG.lark.appSecret),
    hasEncryptKey: Boolean(CONFIG.lark.encryptKey),
    hasVerificationToken: Boolean(CONFIG.lark.verificationToken),
    botName: CONFIG.lark.botName,
  }
}

export function createWebRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const app = new Hono()

  app.use('*', cors())

  app.use('/api/*', async (c, next) => {
    if (
      c.req.path === '/api/health'
      || c.req.path === '/api/channels/lark/inbound'
      || c.req.path === '/api/channels/lark/card-action'
      || !CONFIG.authEnabled
    ) {
      await next()
      return
    }

    const token = getBearerToken(c.req.header('authorization'))
    if (!isAuthorizedToken(token)) {
      logger.warn('auth:api:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })

  app.get('/api/health', (c) => {
    logger.debug('http:health', { authEnabled: CONFIG.authEnabled })
    return c.json({ status: 'ok', authEnabled: CONFIG.authEnabled })
  })

  app.get('/api/channels/lark', (c) => {
    return c.json(getLarkConfigStatus())
  })

  app.post('/api/channels/lark/inbound', async (c) => {
    try {
      const body = await c.req.json()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      const result = await invokeLarkEvent(coordinator, body, headers)
      return c.json(result ?? { ok: true })
    } catch (error) {
      logger.error('http:lark:inbound:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Invalid Lark inbound payload' }, 400)
    }
  })

  app.post('/api/channels/lark/card-action', async (c) => {
    try {
      const body = await c.req.json()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : null
      const openMessageId = typeof bodyRecord?.open_message_id === 'string' ? bodyRecord.open_message_id : undefined
      const action = bodyRecord?.action && typeof bodyRecord.action === 'object' ? bodyRecord.action as Record<string, unknown> : null
      const actionValue = action?.value && typeof action.value === 'object' ? action.value as Record<string, unknown> : null
      const sessionId = typeof actionValue?.sessionId === 'string' ? actionValue.sessionId : undefined
      const runId = typeof actionValue?.runId === 'string' ? actionValue.runId : undefined
      await writeChannelLog({
        sessionId,
        runId,
        channel: 'lark',
        direction: 'inbound',
        eventName: 'card-action.received',
        platformMessageId: openMessageId,
        payloadSummary: typeof actionValue?.actionType === 'string' ? actionValue.actionType : 'card-action',
        payload: {
          openMessageId,
          actionType: actionValue?.actionType,
          decision: actionValue?.decision,
        },
      })
      const result = await invokeLarkCardAction(coordinator, body, headers)
      return c.json(result ?? { ok: true })
    } catch (error) {
      logger.error('http:lark:card-action:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Invalid Lark card action payload' }, 400)
    }
  })

  app.post('/api/channels/lark/outbound', async (c) => {
    try {
      const body = await c.req.json()
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
      const conversationKey = typeof record?.conversationKey === 'string' && record.conversationKey.trim()
        ? record.conversationKey.trim()
        : null
      const content = typeof record?.content === 'string' ? record.content.trim() : ''
      const runId = typeof record?.runId === 'string' && record.runId.trim() ? record.runId.trim() : 'manual'
      const sessionId = typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined

      if (!conversationKey || !content) {
        return c.json({ error: 'conversationKey and content are required' }, 400)
      }

      const message = createLarkOutboundMessage(runId, sessionId, conversationKey, content)
      await writeChannelLog({
        sessionId: message.sessionId,
        runId: message.runId,
        channel: 'lark',
        direction: 'outbound',
        eventName: 'message.requested',
        conversationKey: message.conversationKey,
        payloadSummary: message.content,
      })
      const delivery = await sendLarkTextMessage(message.conversationKey, message.content)
      await writeChannelLog({
        sessionId: message.sessionId,
        runId: message.runId,
        channel: 'lark',
        direction: 'outbound',
        eventName: delivery.delivered ? 'message.delivered' : 'message.failed',
        conversationKey: message.conversationKey,
        payloadSummary: delivery.delivered ? 'delivered' : (delivery.error || 'failed'),
        payload: delivery,
      })
      return c.json({ ...delivery, message })
    } catch (error) {
      logger.error('http:lark:outbound:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Invalid Lark outbound payload' }, 400)
    }
  })

  app.get('/api/sessions', async (c) => {
    const startedAt = Date.now()
    try {
      const sessions = await listAllSessions()
      return c.json({ sessions })
    } catch (err) {
      logger.error('http:sessions:list:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ sessions: [], error: String(err) })
    }
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '50', 10)
      const before = c.req.query('before') || null
      logger.info('http:messages:start', {
        sessionId: shortId(id),
        limit,
        before: before ? shortId(before) : null,
      })
      const page = await getMessagesPage(id, { limit, before })
      logger.info('http:messages:success', {
        sessionId: shortId(id),
        limit,
        before: before ? shortId(before) : null,
        count: page.messages.length,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore ? shortId(page.nextBefore) : null,
        durationMs: Date.now() - startedAt,
      })
      return c.json(page)
    } catch (err) {
      logger.error('http:messages:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ messages: [], hasMore: false, nextBefore: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/transport-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const full = c.req.query('full') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionTransportLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow, full)
      return c.json(page)
    } catch (err) {
      logger.error('http:transport-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/runtime-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const full = c.req.query('full') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionRuntimeLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow, full)
      return c.json(page)
    } catch (err) {
      logger.error('http:runtime-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/channel-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const full = c.req.query('full') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionChannelLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow, full)
      return c.json(page)
    } catch (err) {
      logger.error('http:channel-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/persistent-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionPersistentLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow)
      return c.json(page)
    } catch (err) {
      logger.error('http:persistent-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/static-metadata', async (c) => {
    const startedAt = Date.now()
    try {
      const snapshot = await buildStaticMetadataSnapshot()
      logger.info('http:static-metadata:success', {
        durationMs: Date.now() - startedAt,
        groups: snapshot.groups.length,
      })
      return c.json(snapshot)
    } catch (err) {
      logger.error('http:static-metadata:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ generatedAt: Date.now(), groups: [], error: String(err) }, 500)
    }
  })

  app.use('/ws', async (c, next) => {
    const token = c.req.query('auth')
    if (!isAuthorizedToken(token)) {
      logger.warn('auth:ws:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.text('Unauthorized', 401)
    }
    await next()
  })

  app.get('/ws', createWebSocketHandler(upgradeWebSocket, coordinator))

  return app
}
