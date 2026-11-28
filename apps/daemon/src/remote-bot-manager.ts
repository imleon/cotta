import type { RemoteBot } from '@cotta/shared'
import { type EventFailureReason, LarkRemoteService } from './lark-remote-service.js'
import { type LarkCardActionResponse, LarkSdkAdapter, type LarkSdkAdapterOptions } from './lark-sdk-adapter.js'
import type { RemoteBotStore } from './remote-bot-store.js'
import type { ProjectRoutesInput } from './routes/project-routes-shared.js'

type Adapter = Pick<LarkSdkAdapter, 'appendCardElements' | 'close' | 'connected' | 'createAndSendCard' | 'sendCard' | 'sendText' | 'start' | 'streamCardElement' | 'updateCard' | 'updateCardEntity'>
type AdapterFactory = (options: LarkSdkAdapterOptions) => Adapter

type Connection = {
  adapter: Adapter
  configVersion: number
}

const cardActionErrors: Record<EventFailureReason, string> = {
  bot_not_found: 'This bot is disabled or its configuration has changed. Reopen the card from the bot menu.',
  card_expired_or_invalid: 'This card has expired. Reopen it from the bot menu.',
  configuration_changed: 'This bot is disabled or its configuration has changed. Reopen the card from the bot menu.',
  group_not_supported: 'This card action is invalid. Reopen the card from the bot menu.',
  invalid_action: 'This card action is invalid. Reopen the card from the bot menu.',
  invalid_message: 'This card action is invalid. Reopen the card from the bot menu.',
  project_not_found: 'This project is no longer available.',
  read_failed: 'Unable to refresh this card right now. Try Refresh again.',
  session_externally_owned: 'This session is currently active outside Cotta. Wait for it to finish and try again.',
  session_not_found: 'This session is no longer available.',
  session_turn_in_progress: 'This session already has a Turn in progress.',
  turn_not_found: 'This Turn is no longer available. Refresh the card.',
  unauthorized: "You don't have permission to use this card.",
  unknown_menu: 'This card action is invalid. Reopen the card from the bot menu.',
}

function cardActionResponse(result: Awaited<ReturnType<LarkRemoteService['onCardAction']>>): LarkCardActionResponse {
  return result.ok ? (result.callback ?? {}) : { toast: { type: 'error', content: cardActionErrors[result.reason] } }
}

export class RemoteBotManager {
  private readonly connections = new Map<string, Connection>()
  private readonly statuses = new Map<string, RemoteBot['connectionStatus']>()
  private pending = Promise.resolve()
  private closed = false

  constructor(
    private readonly store: RemoteBotStore,
    private readonly readInput: ProjectRoutesInput,
    private readonly createAdapter: AdapterFactory = (options) => new LarkSdkAdapter(options),
  ) {}

  start(): Promise<void> {
    return this.reconcile()
  }

  reconcile(botId?: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    const operation = this.pending.then(() => (this.closed ? undefined : this.reconcileNow(botId)))
    this.pending = operation.catch(() => {})
    return operation
  }

  connectionStatus(botId: string): RemoteBot['connectionStatus'] {
    const bot = this.store.getBot(botId)
    if (!bot?.enabled) return 'disabled'
    const status = this.statuses.get(botId) ?? 'error'
    return status === 'connected' && !bot.pairedOpenId ? 'unpaired' : status
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pending
    for (const connection of this.connections.values()) connection.adapter.close()
    this.connections.clear()
    this.statuses.clear()
  }

  private async reconcileNow(botId?: string): Promise<void> {
    if (botId) {
      await this.reconcileBot(botId)
      return
    }
    const bots = this.store.listBots()
    const botIds = new Set(bots.map((bot) => bot.botId))
    for (const [id, connection] of this.connections) {
      if (botIds.has(id)) continue
      connection.adapter.close()
      this.connections.delete(id)
      this.statuses.delete(id)
    }
    await Promise.allSettled(bots.map((bot) => this.reconcileBot(bot.botId)))
  }

  private async reconcileBot(botId: string): Promise<void> {
    const bot = this.store.getBot(botId)
    const current = this.connections.get(botId)
    if (!bot?.enabled) {
      current?.adapter.close()
      this.connections.delete(botId)
      this.statuses.delete(botId)
      return
    }
    if (current?.configVersion === bot.configVersion) return
    current?.adapter.close()
    this.connections.delete(botId)
    this.statuses.set(botId, 'connecting')

    let service: LarkRemoteService
    const currentConfig = () => !this.closed && this.store.getBot(botId)?.configVersion === bot.configVersion
    const setStatus = (status: RemoteBot['connectionStatus']) => {
      if (currentConfig()) this.statuses.set(botId, status)
    }
    const forward = <T>(run: () => Promise<T>): Promise<T | { ok: false; reason: EventFailureReason }> => (currentConfig() ? run() : Promise.resolve({ ok: false, reason: 'configuration_changed' }))
    const adapter = this.createAdapter({
      appId: bot.appId,
      appSecret: bot.appSecret,
      platform: bot.platform,
      onMessage: (event) => forward(() => service.onMessage(event)),
      onMenu: (event) => forward(() => service.onMenu(event)),
      onCardAction: (event) => forward(() => service.onCardAction(event)).then(cardActionResponse),
      onReady: () => setStatus('connected'),
      onError: () => setStatus('error'),
      onReconnecting: () => setStatus('connecting'),
      onReconnected: () => setStatus('connected'),
    })
    service = new LarkRemoteService(botId, this.store, adapter, this.readInput)
    try {
      await adapter.start()
      this.connections.set(botId, { adapter, configVersion: bot.configVersion })
    } catch (error) {
      adapter.close()
      setStatus('error')
      throw error
    }
  }
}
