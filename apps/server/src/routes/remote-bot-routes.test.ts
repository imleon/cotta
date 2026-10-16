import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from '../database.js'
import { createApp } from '../index.js'
import { RemoteBotStore } from '../remote-bot-store.js'

vi.mock('../lark-bind.js', () => ({
  resolveBindTarget: vi.fn(async () => ({ openId: 'ou_owner', name: 'Owner', avatarUrl: 'https://avatar/240' })),
}))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cotta-remote-bot-routes-'))
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  const store = new RemoteBotStore(db)
  const reconcile = vi.fn()
  const app = createApp({
    transcriptIndex: {
      getSession: () => null,
      getProject: () => null,
      listProjectsPage: () => ({ items: [], hasMore: false, nextKey: null }),
      listProjectSessionsPage: () => ({ items: [], hasMore: false, nextKey: null }),
    },
    timelineVersionReader: () => '',
    remoteBotStore: store,
    reconcileRemoteBots: reconcile,
    remoteBotConnectionStatus: () => 'unpaired',
    remoteBotProjectExists: (projectId) => projectId === 'project',
  })
  return { app, db, store, reconcile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const json = (value: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

describe('remote bot routes', () => {
  it('creates, lists, updates, pairs, unpairs, and deletes without exposing secrets', async () => {
    const { app, db, reconcile, cleanup } = setup()
    const created = await app.request('/api/remote-bots', {
      method: 'POST',
      ...json({ platform: 'feishu', appId: 'cli_0123456789abcdef', appSecret: 'secret', allProjects: false, projectIds: ['project'], enabled: true }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { bot: { botId: string } }
    expect(body.bot).toMatchObject({ appId: 'cli_0123456789abcdef', allProjects: false, projectIds: ['project'], hasSecret: true, connectionStatus: 'unpaired' })
    expect(body.bot).not.toHaveProperty('appSecret')
    expect(body.bot).not.toHaveProperty('menuEventId')

    const listed = await (await app.request('/api/remote-bots')).json()
    expect(listed).toEqual({ bots: [expect.objectContaining({ botId: body.bot.botId, hasSecret: true })] })

    const updated = await app.request(`/api/remote-bots/${body.bot.botId}`, { method: 'PUT', ...json({ appSecret: '', enabled: false }) })
    expect(await updated.json()).toEqual({ bot: expect.objectContaining({ enabled: false, hasSecret: true, connectionStatus: 'disabled' }) })
    expect(db.prepare('SELECT app_secret FROM remote_bots').get()).toEqual({ app_secret: 'secret' })

    expect((await app.request(`/api/remote-bots/${body.bot.botId}/bind`, { method: 'POST', ...json({ chatId: 'oc_abc' }) })).status).toBe(409)
    await app.request(`/api/remote-bots/${body.bot.botId}`, { method: 'PUT', ...json({ enabled: true }) })
    const resolved = (await (await app.request(`/api/remote-bots/${body.bot.botId}/resolve`, { method: 'POST', ...json({ chatId: 'oc_abc' }) })).json()) as { name: string; avatarUrl: string | null }
    expect(resolved).toEqual({ name: 'Owner', avatarUrl: 'https://avatar/240' })
    const bound = (await (await app.request(`/api/remote-bots/${body.bot.botId}/bind`, { method: 'POST', ...json({ chatId: 'oc_abc' }) })).json()) as {
      bot: { paired: boolean; pairedUserName: string | null }
    }
    expect(bound.bot).toMatchObject({ paired: true, pairedUserName: 'Owner', pairedUserAvatarUrl: 'https://avatar/240' })
    expect((await app.request(`/api/remote-bots/${body.bot.botId}/unpair`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/remote-bots/${body.bot.botId}`, { method: 'DELETE' })).status).toBe(200)
    expect(reconcile).toHaveBeenCalledTimes(6)
    db.close()
    cleanup()
  })

  it('persists create and update when connection startup fails', async () => {
    const { app, db, store, reconcile, cleanup } = setup()
    reconcile.mockRejectedValue(new Error('bad credentials'))

    const created = await app.request('/api/remote-bots', {
      method: 'POST',
      ...json({ platform: 'feishu', appId: 'cli_0123456789abcdef', appSecret: 'secret', allProjects: false, projectIds: ['project'] }),
    })
    expect(created.status).toBe(201)
    const botId = store.listBots()[0]?.botId as string
    const updated = await app.request(`/api/remote-bots/${botId}`, { method: 'PUT', ...json({ appId: 'cli_fedcba9876543210' }) })
    expect(updated.status).toBe(200)
    expect(store.getBot(botId)?.appId).toBe('cli_fedcba9876543210')
    db.close()
    cleanup()
  })

  it('validates scopes and projects while allowing shared projects', async () => {
    const { app, db, store, cleanup } = setup()
    expect((await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'lark', appId: 'invalid', allProjects: false, projectIds: ['project'] }) })).status).toBe(400)
    expect(
      (await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'lark', appId: 'cli_0000000000000000', appSecret: 's', allProjects: true, projectIds: ['project'] }) })).status,
    ).toBe(400)
    expect((await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'lark', appId: 'cli_0000000000000000', appSecret: 's', allProjects: false, projectIds: [] }) })).status).toBe(
      400,
    )
    expect(
      (await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'lark', appId: 'cli_1111111111111111', appSecret: 's', allProjects: false, projectIds: ['missing'] }) })).status,
    ).toBe(404)
    await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'lark', appId: 'cli_1111111111111111', appSecret: 's', allProjects: false, projectIds: ['project'] }) })
    expect(
      (await app.request('/api/remote-bots', { method: 'POST', ...json({ platform: 'feishu', appId: 'cli_2222222222222222', appSecret: 's', allProjects: false, projectIds: ['project'] }) })).status,
    ).toBe(201)
    const botId = store.listBots()[0]?.botId as string
    expect((await app.request(`/api/remote-bots/${botId}`, { method: 'PUT', ...json({ allProjects: false }) })).status).toBe(400)
    expect((await app.request(`/api/remote-bots/${botId}`, { method: 'PUT', ...json({ allProjects: false, projectIds: ['project', 'project'] }) })).status).toBe(400)
    expect((await app.request(`/api/remote-bots/${botId}`, { method: 'PUT', ...json({ allProjects: false, projectIds: ['missing'] }) })).status).toBe(404)
    db.close()
    cleanup()
  })
})
