import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const create = vi.fn()
  const patch = vi.fn()
  const cardCreate = vi.fn()
  const cardUpdate = vi.fn()
  const elementContent = vi.fn()
  const elementCreate = vi.fn()
  const start = vi.fn()
  const close = vi.fn()
  const getConnectionStatus = vi.fn()
  const clientOptions: unknown[] = []
  const wsOptions: unknown[] = []
  const dispatchers: Record<string, (event: never) => unknown>[] = []

  return { create, patch, cardCreate, cardUpdate, elementContent, elementCreate, start, close, getConnectionStatus, clientOptions, wsOptions, dispatchers }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 0, Lark: 1 },
  Client: class {
    im = { v1: { message: { create: sdk.create, patch: sdk.patch } } }
    cardkit = { v1: { card: { create: sdk.cardCreate, update: sdk.cardUpdate }, cardElement: { content: sdk.elementContent, create: sdk.elementCreate } } }
    constructor(options: unknown) {
      sdk.clientOptions.push(options)
    }
  },
  WSClient: class {
    constructor(options: unknown) {
      sdk.wsOptions.push(options)
    }
    start = sdk.start
    close = sdk.close
    getConnectionStatus = sdk.getConnectionStatus
  },
  EventDispatcher: class {
    register(handlers: Record<string, (event: never) => unknown>) {
      sdk.dispatchers.push(handlers)
      return this
    }
  },
}))

import { LarkSdkAdapter } from './lark-sdk-adapter.js'

const noop = vi.fn()

function adapter(platform: 'feishu' | 'lark' = 'feishu', handlers: Partial<ConstructorParameters<typeof LarkSdkAdapter>[0]> = {}) {
  return new LarkSdkAdapter({
    appId: 'cli_test',
    appSecret: 'secret',
    platform,
    onMessage: noop,
    onMenu: noop,
    onCardAction: noop,
    ...handlers,
  })
}

describe('LarkSdkAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.clientOptions.length = 0
    sdk.wsOptions.length = 0
    sdk.dispatchers.length = 0
    sdk.create.mockResolvedValue({ data: { message_id: 'om_sent' } })
    sdk.patch.mockResolvedValue({})
    sdk.cardCreate.mockResolvedValue({ data: { card_id: 'card_sent' } })
    sdk.cardUpdate.mockResolvedValue({})
    sdk.elementContent.mockResolvedValue({})
    sdk.elementCreate.mockResolvedValue({})
    sdk.start.mockResolvedValue(undefined)
    sdk.getConnectionStatus.mockReturnValue({ state: 'connected', reconnectAttempts: 0 })
  })

  it.each([
    ['feishu', 0],
    ['lark', 1],
  ] as const)('configures the %s domain for API and WebSocket clients', (platform, domain) => {
    adapter(platform)

    expect(sdk.clientOptions).toEqual([{ appId: 'cli_test', appSecret: 'secret', domain }])
    expect(sdk.wsOptions).toEqual([{ appId: 'cli_test', appSecret: 'secret', domain }])
  })

  it('passes connection lifecycle callbacks to the SDK', () => {
    const callbacks = { onReady: vi.fn(), onError: vi.fn(), onReconnecting: vi.fn(), onReconnected: vi.fn() }
    adapter('feishu', callbacks)

    expect(sdk.wsOptions[0]).toEqual(expect.objectContaining(callbacks))
  })

  it('normalizes message, menu, and Card 2.0 action payloads', async () => {
    const onMessage = vi.fn()
    const onMenu = vi.fn()
    const onCardAction = vi.fn()
    adapter('feishu', { onMessage, onMenu, onCardAction })
    const handlers = sdk.dispatchers[0]
    expect(handlers).toBeDefined()

    await handlers?.['im.message.receive_v1']?.({
      event_id: 'evt-message',
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: { message_id: 'om_in', create_time: '1', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}' },
    } as never)
    await handlers?.['application.bot.menu_v6']?.({ event_id: 'evt-menu', event_key: 'sessions', operator: { operator_id: { open_id: 'ou_sender' } } } as never)
    await handlers?.['card.action.trigger']?.({
      event_id: 'evt-card',
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_sender' },
      action: { tag: 'button', value: { op: 'refresh' } },
    } as never)

    expect(onMessage).toHaveBeenCalledWith({
      eventId: 'evt-message',
      senderOpenId: 'ou_sender',
      chatId: 'oc_chat',
      chatType: 'p2p',
      messageId: 'om_in',
      messageType: 'text',
      content: '{"text":"hello"}',
    })
    expect(onMenu).toHaveBeenCalledWith({ eventId: 'evt-menu', eventKey: 'sessions', operatorOpenId: 'ou_sender' })
    expect(onCardAction).toHaveBeenCalledWith({
      eventId: 'evt-card',
      messageId: 'om_card',
      chatId: 'oc_chat',
      operatorOpenId: 'ou_sender',
      action: { tag: 'button', value: { op: 'refresh' } },
    })
  })

  it('sends text and Card 2.0 JSON, updates by message_id, and owns the WS lifecycle', async () => {
    const subject = adapter()
    const card = { schema: '2.0', body: { elements: [] } }

    await expect(subject.sendText('oc_chat', 'hello', 'event-text')).resolves.toBe('om_sent')
    await expect(subject.sendCard('oc_chat', card, 'event-card')).resolves.toBe('om_sent')
    await subject.updateCard('om_card', card)
    await subject.start()
    expect(subject.connected()).toBe(true)
    subject.close()

    expect(sdk.create).toHaveBeenNthCalledWith(1, {
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'text', content: '{"text":"hello"}', uuid: 'event-text' },
    })
    expect(sdk.create).toHaveBeenNthCalledWith(2, {
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'interactive', content: JSON.stringify(card), uuid: 'event-card' },
    })
    expect(sdk.patch).toHaveBeenCalledWith({ path: { message_id: 'om_card' }, data: { content: JSON.stringify(card) } })
    expect(sdk.start).toHaveBeenCalledWith({ eventDispatcher: expect.any(Object) })
    expect(sdk.close).toHaveBeenCalledOnce()
  })

  it('creates, sends, streams, appends, and replaces CardKit entities with stable mutation identity', async () => {
    const subject = adapter()
    const card = { schema: '2.0', body: { elements: [] } }
    const elements = [{ tag: 'markdown', element_id: 'answer', content: 'Done' }]

    await expect(subject.createAndSendCard('oc_chat', card, 'event-card')).resolves.toEqual({ cardId: 'card_sent', messageId: 'om_sent' })
    await subject.streamCardElement('card_sent', 'answer', 'Hello', 'turn:stream:1', 1)
    await subject.appendCardElements('card_sent', elements, 'turn:append:2', 2)
    await subject.updateCardEntity('card_sent', card, 'turn:settle:3', 3)

    expect(sdk.cardCreate).toHaveBeenCalledWith({ data: { type: 'card_json', data: JSON.stringify(card) } })
    expect(sdk.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: 'card_sent' } }), uuid: 'event-card' },
    })
    expect(sdk.elementContent).toHaveBeenCalledWith({
      path: { card_id: 'card_sent', element_id: 'answer' },
      data: { content: 'Hello', uuid: 'turn:stream:1', sequence: 1 },
    })
    expect(sdk.elementCreate).toHaveBeenCalledWith({
      path: { card_id: 'card_sent' },
      data: { type: 'append', elements: JSON.stringify(elements), uuid: 'turn:append:2', sequence: 2 },
    })
    expect(sdk.cardUpdate).toHaveBeenCalledWith({
      path: { card_id: 'card_sent' },
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, uuid: 'turn:settle:3', sequence: 3 },
    })
  })

  it('keeps official event ids as UUIDs and hashes oversized ids to the 50-character limit', async () => {
    const subject = adapter()
    await subject.sendText('oc_chat', 'hello', 'evt_123')
    await subject.sendCard('oc_chat', {}, 'x'.repeat(51))

    expect(sdk.create.mock.calls[0]?.[0].data.uuid).toBe('evt_123')
    expect(sdk.create.mock.calls[1]?.[0].data.uuid).toMatch(/^[0-9a-f]{50}$/)
  })

  it('returns card action responses and acknowledges failures', async () => {
    const response = { toast: { type: 'info' as const, content: 'Done' }, card: { type: 'raw' as const, data: { schema: '2.0' } } }
    adapter('feishu', { onCardAction: async () => response })
    const event = {
      event_id: 'evt-card',
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_sender' },
      action: { tag: 'button' },
    } as never

    await expect(sdk.dispatchers[0]?.['card.action.trigger']?.(event)).resolves.toEqual(response)

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    adapter('feishu', { onCardAction: async () => Promise.reject(new Error('failed')) })
    await expect(sdk.dispatchers[1]?.['card.action.trigger']?.(event)).resolves.toEqual({})
    expect(error).toHaveBeenCalledWith('Lark card action failed', expect.any(Error))
    error.mockRestore()
  })

  it('rejects nonzero OpenAPI response codes', async () => {
    const subject = adapter()
    sdk.create.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.sendText('oc_chat', 'hello')).rejects.toThrow('Lark message send failed (230001: invalid)')
    sdk.patch.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.updateCard('om_card', { schema: '2.0' })).rejects.toThrow('Lark card update failed (230001)')
    sdk.cardCreate.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.createAndSendCard('oc_chat', {})).rejects.toThrow('Lark card entity create failed (230001: invalid)')
    sdk.elementContent.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.streamCardElement('card', 'element', 'text', 'mutation', 1)).rejects.toThrow('Lark card element stream failed (230001: invalid)')
    sdk.elementCreate.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.appendCardElements('card', [], 'mutation', 2)).rejects.toThrow('Lark card elements append failed (230001: invalid)')
    sdk.cardUpdate.mockResolvedValueOnce({ code: 230001, msg: 'invalid' })
    await expect(subject.updateCardEntity('card', {}, 'mutation', 3)).rejects.toThrow('Lark card entity update failed (230001: invalid)')
  })

  it('rejects malformed SDK payloads instead of inventing identities', () => {
    adapter()
    const handler = sdk.dispatchers[0]?.['card.action.trigger']
    expect(handler).toBeDefined()

    expect(() => handler?.({ context: {}, operator: {}, action: { tag: 'button' } } as never)).toThrow('context.open_message_id')
  })
})
