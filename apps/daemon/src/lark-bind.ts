import * as lark from '@larksuiteoapi/node-sdk'
import type { LarkPlatform } from './lark-sdk-adapter.js'

export type BindTarget = { openId: string; name: string; avatarUrl: string | null }
export type BindCredentials = { appId: string; appSecret: string; platform: LarkPlatform }

export class BindError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BindError'
  }
}

function checkCode(response: { code?: number; msg?: string }, operation: string): void {
  if (response.code !== undefined && response.code !== 0) throw new BindError(`${operation} failed (${response.code}${response.msg ? `: ${response.msg}` : ''})`)
}

// Resolve the single human counterpart of a p2p chat into an auth identity + display fields.
// chat-members-list returns the human in data.items[] and excludes the bot itself, so a p2p
// DM yields exactly one item; 0 means a wrong id / bot not in the chat, >1 means it isn't a p2p DM.
export async function resolveBindTarget({ appId, appSecret, platform }: BindCredentials, chatId: string): Promise<BindTarget> {
  const client = new lark.Client({ appId, appSecret, domain: platform === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark })
  const members = await client.im.v1.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: 'open_id' } })
  checkCode(members, 'Lark chat members list')
  const items = members.data?.items ?? []
  if (items.length !== 1) throw new BindError('chat_members_unexpected')
  const openId = items[0].member_id
  if (!openId) throw new BindError('chat_members_unexpected')
  const memberName = items[0].name ?? openId
  // ponytail: contact fetch is display-only — if scope/privacy denies it, degrade to the member
  // name + null avatar rather than aborting; the auth key (open_id) is already captured.
  try {
    const user = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } })
    checkCode(user, 'Lark contact user get')
    return { openId, name: user.data?.user?.name ?? memberName, avatarUrl: user.data?.user?.avatar?.avatar_240 ?? null }
  } catch {
    return { openId, name: memberName, avatarUrl: null }
  }
}
