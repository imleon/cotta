import { createHash } from 'node:crypto'
import * as lark from '@larksuiteoapi/node-sdk'

export type LarkPlatform = 'feishu' | 'lark'

type MessageEvent = Parameters<NonNullable<lark.EventHandles['im.message.receive_v1']>>[0]
type MenuEvent = Parameters<NonNullable<lark.EventHandles['application.bot.menu_v6']>>[0]
type CardActionEvent = lark.RawCardActionEvent & { event_id?: string }

export type LarkMessageEvent = {
  eventId?: string
  senderOpenId: string
  chatId: string
  chatType: string
  messageId: string
  messageType: string
  content: string
}

export type LarkMenuEvent = {
  eventId?: string
  eventKey: string
  operatorOpenId: string
}

export type LarkCardActionEvent = {
  eventId?: string
  messageId: string
  chatId: string
  operatorOpenId: string
  action: NonNullable<lark.RawCardActionEvent['action']>
}

export type LarkCardActionResponse = {
  toast?: { type: 'info' | 'success' | 'error' | 'warning'; content: string }
  card?: { type: 'raw'; data: object }
}

export type LarkSdkAdapterOptions = {
  appId: string
  appSecret: string
  platform: LarkPlatform
  onMessage: (event: LarkMessageEvent) => unknown | Promise<unknown>
  onMenu: (event: LarkMenuEvent) => unknown | Promise<unknown>
  onCardAction: (event: LarkCardActionEvent) => LarkCardActionResponse | Promise<LarkCardActionResponse>
  onReady?: () => void
  onError?: (error: Error) => void
  onReconnecting?: () => void
  onReconnected?: () => void
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`Missing Lark event field: ${name}`)
  return value
}

function messageUuid(eventId: string): string {
  return eventId.length <= 50 ? eventId : createHash('sha256').update(eventId).digest('hex').slice(0, 50)
}

export class LarkSdkAdapter {
  private readonly client: lark.Client
  private readonly wsClient: lark.WSClient
  private readonly dispatcher: lark.EventDispatcher

  constructor(options: LarkSdkAdapterOptions) {
    const domain = options.platform === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark
    this.client = new lark.Client({ appId: options.appId, appSecret: options.appSecret, domain })
    this.wsClient = new lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      domain,
      onReady: options.onReady,
      onError: options.onError,
      onReconnecting: options.onReconnecting,
      onReconnected: options.onReconnected,
    })
    this.dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event: MessageEvent) =>
        options.onMessage({
          eventId: event.event_id,
          senderOpenId: required(event.sender.sender_id?.open_id, 'sender.sender_id.open_id'),
          chatId: event.message.chat_id,
          chatType: event.message.chat_type,
          messageId: event.message.message_id,
          messageType: event.message.message_type,
          content: event.message.content,
        }),
      'application.bot.menu_v6': (event: MenuEvent) =>
        options.onMenu({
          eventId: event.event_id,
          eventKey: required(event.event_key, 'event_key'),
          operatorOpenId: required(event.operator?.operator_id?.open_id, 'operator.operator_id.open_id'),
        }),
      'card.action.trigger': (event: CardActionEvent) => {
        const action = {
          eventId: event.event_id,
          messageId: required(event.context?.open_message_id ?? event.open_message_id, 'context.open_message_id'),
          chatId: required(event.context?.open_chat_id ?? event.open_chat_id, 'context.open_chat_id'),
          operatorOpenId: required(event.operator?.open_id, 'operator.open_id'),
          action: event.action ?? {},
        }
        return Promise.resolve()
          .then(() => options.onCardAction(action))
          .catch((error) => {
            console.error('Lark card action failed', error)
            return {}
          })
      },
    })
  }

  async sendText(receiveId: string, text: string, uuid?: string): Promise<string> {
    return this.send(receiveId, 'text', { text }, uuid)
  }

  async sendCard(receiveId: string, card: object, uuid?: string): Promise<string> {
    return this.send(receiveId, 'interactive', card, uuid)
  }

  async createAndSendCard(receiveId: string, card: object, uuid?: string): Promise<{ cardId: string; messageId: string }> {
    const created = await this.client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } })
    this.checkResponse(created, 'Lark card entity create')
    const cardId = required(created.data?.card_id, 'response.data.card_id')
    const messageId = await this.send(receiveId, 'interactive', { type: 'card', data: { card_id: cardId } }, uuid)
    return { cardId, messageId }
  }

  async streamCardElement(cardId: string, elementId: string, content: string, uuid: string, sequence: number): Promise<void> {
    const response = await this.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, uuid: messageUuid(uuid), sequence },
    })
    this.checkResponse(response, 'Lark card element stream')
  }

  async appendCardElements(cardId: string, elements: object[], uuid: string, sequence: number): Promise<void> {
    const response = await this.client.cardkit.v1.cardElement.create({
      path: { card_id: cardId },
      data: { type: 'append', elements: JSON.stringify(elements), uuid: messageUuid(uuid), sequence },
    })
    this.checkResponse(response, 'Lark card elements append')
  }

  async updateCardEntity(cardId: string, card: object, uuid: string, sequence: number): Promise<void> {
    const response = await this.client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, uuid: messageUuid(uuid), sequence },
    })
    this.checkResponse(response, 'Lark card entity update')
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    const response = await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } })
    if (response.code !== undefined && response.code !== 0) throw new Error(`Lark card update failed (${response.code})`)
  }

  start(): Promise<void> {
    return this.wsClient.start({ eventDispatcher: this.dispatcher })
  }

  close(): void {
    this.wsClient.close()
  }

  connected(): boolean {
    return this.wsClient.getConnectionStatus()?.state === 'connected'
  }

  private async send(receiveId: string, msgType: string, content: object, uuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content), ...(uuid ? { uuid: messageUuid(uuid) } : {}) },
    })
    this.checkResponse(response, 'Lark message send')
    return required(response.data?.message_id, 'response.data.message_id')
  }

  private checkResponse(response: { code?: number; msg?: string }, operation: string): void {
    if (response.code !== undefined && response.code !== 0) throw new Error(`${operation} failed (${response.code}${response.msg ? `: ${response.msg}` : ''})`)
  }
}
