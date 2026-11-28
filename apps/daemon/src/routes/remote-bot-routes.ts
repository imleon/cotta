import type { DatabaseSync } from 'node:sqlite'
import {
  createRemoteBotRequestSchema,
  type RemoteBot,
  remoteBotBindRequestSchema,
  remoteBotMutationResponseSchema,
  remoteBotResolveResponseSchema,
  remoteBotResponseSchema,
  remoteBotsResponseSchema,
  updateRemoteBotRequestSchema,
} from '@cotta/shared'
import type { Hono } from 'hono'
import { resolveBindTarget } from '../lark-bind.js'
import { RemoteBotStore, type RemoteBot as StoredRemoteBot } from '../remote-bot-store.js'

export type RemoteBotReconcile = (botId?: string) => unknown | Promise<unknown>
export type RemoteBotConnectionStatus = (botId: string) => RemoteBot['connectionStatus']
export type RemoteBotProjectExists = (projectId: string) => boolean | Promise<boolean>

function publicBot(bot: StoredRemoteBot, connectionStatus?: RemoteBotConnectionStatus): RemoteBot {
  const paired = bot.pairedOpenId !== null
  return {
    botId: bot.botId,
    platform: bot.platform,
    appId: bot.appId,
    allProjects: bot.allProjects,
    projectIds: bot.projectIds,
    enabled: bot.enabled,
    hasSecret: bot.appSecret.length > 0,
    paired,
    pairedUserName: paired ? bot.pairedUserName : null,
    pairedUserAvatarUrl: paired ? bot.pairedUserAvatarUrl : null,
    connectionStatus: !bot.enabled ? 'disabled' : (connectionStatus?.(bot.botId) ?? 'unpaired'),
  }
}

function conflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

export function registerRemoteBotRoutes(app: Hono, store: RemoteBotStore, reconcile?: RemoteBotReconcile, connectionStatus?: RemoteBotConnectionStatus, projectExists?: RemoteBotProjectExists): void {
  const responseBot = (bot: StoredRemoteBot) => publicBot(bot, connectionStatus)
  app.get('/api/remote-bots', (c) => c.json(remoteBotsResponseSchema.parse({ bots: store.listBots().map(responseBot) })))

  app.post('/api/remote-bots', async (c) => {
    const parsed = createRemoteBotRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_remote_bot' }, 400)
    if (projectExists && !(await Promise.all(parsed.data.projectIds.map(projectExists))).every(Boolean)) return c.json({ error: 'project_not_found' }, 404)
    try {
      const bot = store.create(parsed.data)
      await Promise.resolve(reconcile?.(bot.botId)).catch(() => {})
      return c.json(remoteBotResponseSchema.parse({ bot: responseBot(bot) }), 201)
    } catch (error) {
      if (conflict(error)) return c.json({ error: 'remote_bot_conflict' }, 409)
      throw error
    }
  })

  app.put('/api/remote-bots/:botId', async (c) => {
    const parsed = updateRemoteBotRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_remote_bot_update' }, 400)
    if (parsed.data.projectIds && projectExists && !(await Promise.all(parsed.data.projectIds.map(projectExists))).every(Boolean)) return c.json({ error: 'project_not_found' }, 404)
    try {
      const update = { ...parsed.data, ...(parsed.data.appSecret?.trim() ? { appSecret: parsed.data.appSecret } : { appSecret: undefined }) }
      const bot = store.update(c.req.param('botId'), update)
      if (!bot) return c.json({ error: 'remote_bot_not_found' }, 404)
      await Promise.resolve(reconcile?.(bot.botId)).catch(() => {})
      return c.json(remoteBotResponseSchema.parse({ bot: responseBot(bot) }))
    } catch (error) {
      if (conflict(error)) return c.json({ error: 'remote_bot_conflict' }, 409)
      throw error
    }
  })

  app.delete('/api/remote-bots/:botId', async (c) => {
    if (!store.delete(c.req.param('botId'))) return c.json({ error: 'remote_bot_not_found' }, 404)
    await reconcile?.()
    return c.json(remoteBotMutationResponseSchema.parse({ ok: true }))
  })

  app.post('/api/remote-bots/:botId/resolve', async (c) => {
    const parsed = remoteBotBindRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_remote_bot_bind' }, 400)
    const bot = store.getBot(c.req.param('botId'))
    if (!bot) return c.json({ error: 'remote_bot_not_found' }, 404)
    if (!bot.enabled || bot.appSecret.length === 0) return c.json({ error: 'remote_bot_not_bindable' }, 409)
    try {
      const { name, avatarUrl } = await resolveBindTarget(bot, parsed.data.chatId)
      return c.json(remoteBotResolveResponseSchema.parse({ name, avatarUrl }))
    } catch {
      return c.json({ error: 'remote_bot_bind_failed' }, 502)
    }
  })

  app.post('/api/remote-bots/:botId/bind', async (c) => {
    const botId = c.req.param('botId')
    const parsed = remoteBotBindRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_remote_bot_bind' }, 400)
    const bot = store.getBot(botId)
    if (!bot) return c.json({ error: 'remote_bot_not_found' }, 404)
    if (!bot.enabled || bot.appSecret.length === 0) return c.json({ error: 'remote_bot_not_bindable' }, 409)
    let target: Awaited<ReturnType<typeof resolveBindTarget>>
    try {
      target = await resolveBindTarget(bot, parsed.data.chatId)
    } catch {
      return c.json({ error: 'remote_bot_bind_failed' }, 502)
    }
    const bound = store.bind(botId, target.openId, parsed.data.chatId, target.name, target.avatarUrl)
    if (!bound) return c.json({ error: 'remote_bot_not_bindable' }, 409)
    await Promise.resolve(reconcile?.(botId)).catch(() => {})
    return c.json(remoteBotResponseSchema.parse({ bot: responseBot(bound) }))
  })

  app.post('/api/remote-bots/:botId/unpair', async (c) => {
    const botId = c.req.param('botId')
    if (!store.unpair(botId)) return c.json({ error: 'remote_bot_not_found' }, 404)
    await reconcile?.(botId)
    return c.json(remoteBotMutationResponseSchema.parse({ ok: true }))
  })
}

export function createRemoteBotStore(db: DatabaseSync): RemoteBotStore {
  return new RemoteBotStore(db)
}
