import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { RemoteBotStore } from './remote-bot-store.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-remote-bot-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  return { db, store: new RemoteBotStore(db) }
}

describe('RemoteBotStore', () => {
  it('stores bots, increments configuration versions, and enforces identities', async () => {
    const { db, store } = await setup()
    const created = store.create({ botId: 'bot', platform: 'feishu', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] }, 1)
    expect(created).toMatchObject({
      botId: 'bot',
      appSecret: 'secret',
      allProjects: false,
      projectIds: ['project'],
      enabled: true,
      configVersion: 1,
      selectedProjectId: null,
      selectedSessionId: null,
    })
    expect(store.getByApp('feishu', 'app')).toEqual(created)
    expect(store.update('bot', {}, 2)).toMatchObject({ configVersion: 1 })
    expect(store.update('bot', { allProjects: false, projectIds: ['other', 'project'] }, 3)).toMatchObject({ projectIds: ['other', 'project'], configVersion: 2 })
    expect(store.update('bot', { appSecret: 'next' }, 4)).toMatchObject({ appSecret: 'next', configVersion: 3 })
    expect(store.setEnabled('bot', false, 5)).toBe(true)
    expect(store.getBot('bot')).toMatchObject({ enabled: false, configVersion: 4 })
    expect(store.create({ platform: 'feishu', appId: 'other', appSecret: 'secret', allProjects: false, projectIds: ['project'] })).toMatchObject({ projectIds: ['project'] })
    db.close()
  })

  it('persists selection without changing configuration versions and clears invalid scope', async () => {
    const { db, store } = await setup()
    store.create({ botId: 'bot', platform: 'lark', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project', 'other'] }, 1)

    expect(store.setSelection('bot', 'project', null, 2)).toMatchObject({ selectedProjectId: 'project', selectedSessionId: null, configVersion: 1 })
    expect(store.setSelection('bot', 'project', 'session', 3)).toMatchObject({ selectedProjectId: 'project', selectedSessionId: 'session', configVersion: 1 })
    expect(new RemoteBotStore(db).getBot('bot')).toMatchObject({ selectedProjectId: 'project', selectedSessionId: 'session' })
    expect(() => store.setSelection('bot', null, 'session', 4)).toThrow('selected session requires a project')
    expect(store.update('bot', { appSecret: 'next' }, 5)).toMatchObject({ selectedProjectId: 'project', selectedSessionId: 'session', configVersion: 2 })
    expect(store.update('bot', { projectIds: ['other'] }, 6)).toMatchObject({ selectedProjectId: null, selectedSessionId: null, configVersion: 3 })
    store.setSelection('bot', 'other', 'next-session', 7)
    expect(store.update('bot', { appId: 'next-app' }, 8)).toMatchObject({ selectedProjectId: null, selectedSessionId: null, configVersion: 4 })
    db.close()
  })

  it('binds a p2p chat with display fields, overwrites on re-bind, and clears on unpair', async () => {
    const { db, store } = await setup()
    store.create({ botId: 'bot', platform: 'lark', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] }, 1)
    expect(store.bind('bot', 'open', 'chat', 'Owner', 'https://avatar/240', 100)).toMatchObject({
      pairedOpenId: 'open',
      pairedChatId: 'chat',
      pairedUserName: 'Owner',
      pairedUserAvatarUrl: 'https://avatar/240',
      configVersion: 1,
    })
    store.setSelection('bot', 'project', 'session', 150)
    expect(store.bind('bot', 'open2', 'chat2', 'Owner Two', null, 200)).toMatchObject({
      pairedOpenId: 'open2',
      pairedChatId: 'chat2',
      pairedUserName: 'Owner Two',
      pairedUserAvatarUrl: null,
      selectedProjectId: null,
      selectedSessionId: null,
      configVersion: 1,
    })
    store.setEnabled('bot', false, 250)
    expect(store.bind('bot', 'open3', 'chat3', 'Nope', null, 260)).toBeNull()
    store.setEnabled('bot', true, 270)
    store.setSelection('bot', 'project', 'session', 300)
    expect(store.unpair('bot', 400)).toBe(true)
    expect(store.getBot('bot')).toMatchObject({ pairedOpenId: null, pairedChatId: null, pairedUserName: null, pairedUserAvatarUrl: null, selectedProjectId: null, selectedSessionId: null })
    db.close()
  })

  it('isolates binding per bot', async () => {
    const { db, store } = await setup()
    store.create({ botId: 'first', platform: 'feishu', appId: 'first-app', appSecret: 'secret', allProjects: false, projectIds: ['first-project'] }, 1)
    store.create({ botId: 'second', platform: 'feishu', appId: 'second-app', appSecret: 'secret', allProjects: false, projectIds: ['second-project'] }, 1)
    expect(store.bind('second', 'open', 'chat', 'Owner', null, 100)).toMatchObject({ botId: 'second', pairedOpenId: 'open' })
    expect(store.getBot('first')).toMatchObject({ pairedOpenId: null })
    db.close()
  })
})
