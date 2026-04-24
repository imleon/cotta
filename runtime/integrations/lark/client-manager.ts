import * as Lark from '@larksuiteoapi/node-sdk'
import type { ConfigRegistry } from '../../config/registry.js'
import {
  type LarkReceiveEvent,
  listLarkConnectors,
  parseConnectorConfig,
} from './helpers.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type WsClientLike = {
  start: (input: { eventDispatcher: Lark.EventDispatcher }) => Promise<void>
  stop?: () => Promise<unknown> | unknown
  close?: () => Promise<unknown> | unknown
  ws?: {
    close?: () => void
  }
}

export class LarkClientManager {
  private readonly clients = new Map<string, Lark.Client>()
  private readonly dispatchers = new Map<string, Lark.EventDispatcher>()
  private readonly wsClients = new Map<string, WsClientLike>()
  private readonly wsStartPromises = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      logger: Logger
      onReceiveMessage: (connectorId: string, data: LarkReceiveEvent) => Promise<void>
    },
  ) {}

  listLarkConnectorIds(): string[] {
    return listLarkConnectors(this.deps.configRegistry).map((connector) => connector.connectorId)
  }

  async startLongConnection(connectorId: string): Promise<void> {
    const existing = this.wsStartPromises.get(connectorId)
    if (existing) return await existing

    const wsClient = this.getWsClient(connectorId)
    const startPromise = wsClient.start({
      eventDispatcher: this.getOrCreateDispatcher(connectorId),
    }).then(() => {
      this.deps.logger.info('lark:ws:started', { connectorId })
    }).catch((error: unknown) => {
      this.wsStartPromises.delete(connectorId)
      throw error
    })

    this.wsStartPromises.set(connectorId, startPromise)
    return await startPromise
  }

  async stopAll(): Promise<void> {
    const stops: Array<Promise<unknown>> = []
    for (const wsClient of this.wsClients.values()) {
      try {
        if (typeof wsClient.stop === 'function') {
          stops.push(Promise.resolve(wsClient.stop()))
          continue
        }
        if (typeof wsClient.close === 'function') {
          stops.push(Promise.resolve(wsClient.close()))
          continue
        }
        if (typeof wsClient.ws?.close === 'function') {
          wsClient.ws.close()
        }
      } catch (error) {
        this.deps.logger.warn('lark:ws:stop:error', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await Promise.allSettled(stops)
  }

  getClient(connectorId: string): Lark.Client {
    return this.getOrCreateClient(connectorId)
  }

  getDispatcher(connectorId: string): Lark.EventDispatcher {
    return this.getOrCreateDispatcher(connectorId)
  }

  private getWsClient(connectorId: string): WsClientLike {
    const existing = this.wsClients.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const wsClient = new (Lark as any).WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    }) as WsClientLike // any: upstream SDK exports WSClient dynamically without stable TS surface
    this.wsClients.set(connectorId, wsClient)
    return wsClient
  }

  private getOrCreateClient(connectorId: string): Lark.Client {
    const existing = this.clients.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Lark.Domain.Feishu,
    })
    this.clients.set(connectorId, client)
    return client
  }

  private getOrCreateDispatcher(connectorId: string): Lark.EventDispatcher {
    const existing = this.dispatchers.get(connectorId)
    if (existing) return existing

    const connector = this.deps.configRegistry.getConnector(connectorId)
    const config = connector ? parseConnectorConfig(connector) : null
    if (!connector || !config) {
      throw new Error(`Lark connector not found or invalid: ${connectorId}`)
    }

    const dispatcher = new Lark.EventDispatcher({
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register({
      'im.message.receive_v1': (data: LarkReceiveEvent) => {
        void this.deps.onReceiveMessage(connectorId, data).catch((error) => {
          this.deps.logger.error('lark:message:handle:error', {
            connectorId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return { ok: true }
      },
      'im.message.message_read_v1': async () => undefined,
    })

    this.dispatchers.set(connectorId, dispatcher)
    return dispatcher
  }
}
