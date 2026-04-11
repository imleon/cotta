import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChannelConversationRef, ChannelInboundMessage, SessionBinding } from '../shared/message-types.js'

const SESSION_BINDINGS_PATH = './data/session-bindings.json'

type BindingExtras = Partial<Pick<SessionBinding, 'lastRunId' | 'activeInteractionId' | 'lastInboundPlatformMessageId'>>
type BindingRef = ChannelConversationRef & Pick<Partial<SessionBinding>, 'chatType'>

type StoredBindings = {
  bindings?: SessionBinding[]
}

function keyFor(ref: ChannelConversationRef): string {
  return `${ref.channel}:${ref.conversationKey}`
}

export class SessionBindingStore {
  private readonly bindings = new Map<string, SessionBinding>()
  private readonly ready: Promise<void>

  constructor() {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(SESSION_BINDINGS_PATH, 'utf-8')
      const parsed = JSON.parse(text) as StoredBindings
      for (const binding of Array.isArray(parsed.bindings) ? parsed.bindings : []) {
        if (!binding || typeof binding !== 'object') continue
        if (typeof binding.channel !== 'string') continue
        if (typeof binding.conversationKey !== 'string') continue
        if (typeof binding.sessionId !== 'string') continue
        if (typeof binding.updatedAt !== 'number' || !Number.isFinite(binding.updatedAt)) continue
        this.bindings.set(keyFor(binding), binding)
      }
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
      if (code !== 'ENOENT') throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(SESSION_BINDINGS_PATH), { recursive: true })
    await writeFile(SESSION_BINDINGS_PATH, `${JSON.stringify({ bindings: [...this.bindings.values()] })}\n`, 'utf-8')
  }

  async list(channel?: ChannelConversationRef['channel']): Promise<SessionBinding[]> {
    await this.ready
    const values = [...this.bindings.values()]
    return typeof channel === 'string' ? values.filter((binding) => binding.channel === channel) : values
  }

  async get(ref: ChannelConversationRef): Promise<SessionBinding | null> {
    await this.ready
    return this.bindings.get(keyFor(ref)) ?? null
  }

  async upsert(binding: SessionBinding): Promise<SessionBinding> {
    await this.ready
    this.bindings.set(keyFor(binding), binding)
    await this.persist()
    return binding
  }

  async delete(ref: ChannelConversationRef): Promise<boolean> {
    await this.ready
    const deleted = this.bindings.delete(keyFor(ref))
    if (deleted) {
      await this.persist()
    }
    return deleted
  }

  async bindSession(ref: BindingRef, sessionId: string, extras: BindingExtras = {}): Promise<SessionBinding> {
    await this.ready
    const current = this.bindings.get(keyFor(ref))
    const next: SessionBinding = {
      ...current,
      ...ref,
      sessionId,
      updatedAt: Date.now(),
      ...(ref.chatType ? { chatType: ref.chatType } : {}),
      ...(extras.lastRunId ? { lastRunId: extras.lastRunId } : {}),
      ...(extras.activeInteractionId ? { activeInteractionId: extras.activeInteractionId } : {}),
      ...(extras.lastInboundPlatformMessageId ? { lastInboundPlatformMessageId: extras.lastInboundPlatformMessageId } : {}),
    }
    this.bindings.set(keyFor(ref), next)
    await this.persist()
    return next
  }

  async touchByInbound(message: ChannelInboundMessage, extras: BindingExtras = {}): Promise<SessionBinding | null> {
    await this.ready
    const current = this.bindings.get(keyFor(message))
    if (!current) return null
    const next: SessionBinding = {
      ...current,
      ...(message.userKey ? { userKey: message.userKey } : {}),
      ...(message.chatType ? { chatType: message.chatType } : {}),
      updatedAt: Date.now(),
      ...(extras.lastRunId ? { lastRunId: extras.lastRunId } : {}),
      ...(extras.activeInteractionId ? { activeInteractionId: extras.activeInteractionId } : {}),
      ...(extras.lastInboundPlatformMessageId ? { lastInboundPlatformMessageId: extras.lastInboundPlatformMessageId } : {}),
    }
    this.bindings.set(keyFor(message), next)
    await this.persist()
    return next
  }
}
