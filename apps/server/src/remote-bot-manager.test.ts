import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from './database.js'
import { LarkRemoteService } from './lark-remote-service.js'
import type { LarkSdkAdapterOptions } from './lark-sdk-adapter.js'
import { RemoteBotManager } from './remote-bot-manager.js'
import { RemoteBotStore } from './remote-bot-store.js'

function setup(start = vi.fn().mockResolvedValue(undefined)) {
  const root = mkdtempSync(join(tmpdir(), 'cotta-remote-bot-manager-'))
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  const store = new RemoteBotStore(db)
  const adapters: Array<{
    options: LarkSdkAdapterOptions
    start: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    connected: ReturnType<typeof vi.fn>
    sendText: ReturnType<typeof vi.fn>
    sendCard: ReturnType<typeof vi.fn>
    createAndSendCard: ReturnType<typeof vi.fn>
    streamCardElement: ReturnType<typeof vi.fn>
    appendCardElements: ReturnType<typeof vi.fn>
    updateCard: ReturnType<typeof vi.fn>
    updateCardEntity: ReturnType<typeof vi.fn>
  }> = []
  const manager = new RemoteBotManager(store, {} as never, (options) => {
    const adapter = {
      options,
      start,
      close: vi.fn(),
      connected: vi.fn().mockReturnValue(true),
      sendText: vi.fn(),
      sendCard: vi.fn(),
      createAndSendCard: vi.fn(),
      streamCardElement: vi.fn(),
      appendCardElements: vi.fn(),
      updateCard: vi.fn(),
      updateCardEntity: vi.fn(),
    }
    adapters.push(adapter)
    return adapter
  })
  return { db, store, manager, adapters, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('RemoteBotManager', () => {
  it('starts enabled bots, binds callbacks, and reconciles config changes', async () => {
    const { db, store, manager, adapters, cleanup } = setup()
    const bot = store.create({ botId: 'bot', platform: 'feishu', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] })

    await manager.start()
    expect(adapters).toHaveLength(1)
    expect(adapters[0]?.start).toHaveBeenCalledOnce()
    expect(manager.connectionStatus(bot.botId)).toBe('connecting')
    adapters[0]?.options.onReady?.()
    expect(manager.connectionStatus(bot.botId)).toBe('unpaired')
    await expect(adapters[0]?.options.onMessage({ senderOpenId: 'user', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: '{}' })).resolves.toEqual({
      ok: false,
      reason: 'unauthorized',
    })

    await manager.reconcile(bot.botId)
    expect(adapters).toHaveLength(1)
    store.update(bot.botId, { appSecret: 'new-secret' })
    await manager.reconcile(bot.botId)
    expect(adapters[0]?.close).toHaveBeenCalledOnce()
    expect(adapters).toHaveLength(2)
    await expect(adapters[0]?.options.onMessage({ senderOpenId: 'user', chatId: 'chat', chatType: 'p2p', messageId: 'stale', messageType: 'text', content: '{}' })).resolves.toEqual({
      ok: false,
      reason: 'configuration_changed',
    })
    await expect(adapters[0]?.options.onCardAction({ messageId: 'card', chatId: 'chat', operatorOpenId: 'user', action: {} })).resolves.toEqual({
      toast: { type: 'error', content: 'This bot is disabled or its configuration has changed. Reopen the card from the bot menu.' },
    })

    store.setEnabled(bot.botId, false)
    await manager.reconcile(bot.botId)
    expect(adapters[1]?.close).toHaveBeenCalledOnce()
    expect(manager.connectionStatus(bot.botId)).toBe('disabled')
    await manager.close()
    db.close()
    cleanup()
  })

  it('maps card failures to error toasts and preserves success callbacks', async () => {
    const { db, store, manager, adapters, cleanup } = setup()
    store.create({ botId: 'bot', platform: 'feishu', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] })
    const cardAction = vi.spyOn(LarkRemoteService.prototype, 'onCardAction')
    await manager.start()
    const event = { messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: {} }

    cardAction.mockResolvedValueOnce({ ok: false, reason: 'card_expired_or_invalid' })
    await expect(adapters[0]?.options.onCardAction(event)).resolves.toEqual({
      toast: { type: 'error', content: 'This card has expired. Reopen it from the bot menu.' },
    })
    cardAction.mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
    await expect(adapters[0]?.options.onCardAction(event)).resolves.toEqual({
      toast: { type: 'error', content: 'Unable to refresh this card right now. Try Refresh again.' },
    })
    const callback = { toast: { type: 'info' as const, content: 'Already latest' }, card: { type: 'raw' as const, data: { schema: '2.0' } } }
    cardAction.mockResolvedValueOnce({ ok: true, callback })
    await expect(adapters[0]?.options.onCardAction(event)).resolves.toEqual(callback)

    cardAction.mockRestore()
    await manager.close()
    db.close()
    cleanup()
  })

  it('tracks SDK state and isolates bot startup failures', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('bad credentials')).mockResolvedValue(undefined)
    const { db, store, manager, adapters, cleanup } = setup(start)
    const failed = store.create({ botId: 'failed', platform: 'feishu', appId: 'bad', appSecret: 'secret', allProjects: false, projectIds: ['project'] })
    const healthy = store.create({ botId: 'healthy', platform: 'lark', appId: 'good', appSecret: 'secret', allProjects: false, projectIds: ['other-project'] })
    const pairedAt = healthy.createdAtMs + 1
    store.bind(healthy.botId, 'owner', 'chat', 'Owner', null, pairedAt)

    await expect(manager.start()).resolves.toBeUndefined()
    expect(manager.connectionStatus(failed.botId)).toBe('error')
    expect(manager.connectionStatus(healthy.botId)).toBe('connecting')
    adapters[1]?.options.onReady?.()
    expect(manager.connectionStatus(healthy.botId)).toBe('connected')
    adapters[1]?.options.onReconnecting?.()
    expect(manager.connectionStatus(healthy.botId)).toBe('connecting')
    adapters[1]?.options.onError?.(new Error('disconnected'))
    expect(manager.connectionStatus(healthy.botId)).toBe('error')
    adapters[1]?.options.onReconnected?.()
    expect(manager.connectionStatus(healthy.botId)).toBe('connected')
    await manager.close()
    await manager.reconcile(healthy.botId)
    expect(adapters).toHaveLength(2)
    db.close()
    cleanup()
  })

  it('closes a connection when its bot is deleted', async () => {
    const { db, store, manager, adapters, cleanup } = setup()
    store.create({ botId: 'bot', platform: 'lark', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] })
    await manager.start()
    store.delete('bot')
    await manager.reconcile()
    expect(adapters[0]?.close).toHaveBeenCalledOnce()
    await manager.close()
    db.close()
    cleanup()
  })
})
