import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectSummary } from '@cotta/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCottaDatabase } from './database.js'
import { decodeLarkCardAction, encodeLarkCardAction, type LarkCardAction } from './lark-card-action.js'
import { LarkRemoteService, LIST_SESSIONS } from './lark-remote-service.js'
import { SessionExternallyOwnedError, SessionTurnInProgressError } from './live-turn-manager.js'
import { ProjectReadModelError } from './project-read-model.js'
import { RemoteBotStore } from './remote-bot-store.js'
import type { ProjectRoutesInput } from './routes/project-routes-shared.js'
import { memoryRawTranscriptCache, memoryTranscriptIndex, messages, project, sessions, timelineState } from './routes/project-routes-test-helpers.js'
import { TranscriptUnavailableError } from './session-raw-transcript-cache.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function setup(scope: { allProjects: boolean; projectIds: string[] } = { allProjects: false, projectIds: [project.id] }) {
  const root = await mkdtemp(join(tmpdir(), 'cotta-lark-service-'))
  roots.push(root)
  const dbPath = join(root, 'cotta.sqlite')
  const db = createCottaDatabase(dbPath)
  const store = new RemoteBotStore(db)
  store.create({ botId: 'bot', platform: 'feishu', appId: 'app', appSecret: 'secret', ...scope }, 1)
  const client = {
    sendText: vi.fn(async (_chatId: string, _text: string) => 'text'),
    sendCard: vi.fn(async (_chatId: string, _card: object) => 'card'),
    updateCard: vi.fn(async (_messageId: string, _card: object) => {}),
    createAndSendCard: vi.fn(async (_chatId: string, _card: object) => ({ cardId: 'card-entity', messageId: 'card-message' })),
    streamCardElement: vi.fn(async () => {}),
    appendCardElements: vi.fn(async () => {}),
    updateCardEntity: vi.fn(async () => {}),
  }
  const readInput = {
    claudeCodeApi: {
      listProjects: async () => ({ projects: [project], hasMore: false, nextCursor: null }),
      getProject: async (projectId: string) => (projectId === project.id ? project : null),
      listProjectSessions: async (projectId: string) => (projectId === project.id ? { project, sessions, defaultSessionId: sessions[0]?.id ?? null, hasMore: false, nextCursor: null } : null),
    },
    transcriptIndex: memoryTranscriptIndex(),
    transcriptSyncer: vi.fn(async () => {}),
    rawTranscriptCache: memoryRawTranscriptCache(messages),
    timelineVersionReader: () => timelineState.version,
    modelCatalogProvider: {},
    settingsStore: {
      getAll: () => ({ timeZone: 'Pacific/Honolulu' }),
      setMany: () => {},
      getAuthSession: () => null,
      setAuthSession: () => {},
      deleteAuthSession: () => {},
    },
    liveTurnManager: {
      ensureRuntime: () => {},
      sessionRunState: () => null,
      runtimeTurnProjection: () => null,
      clearRuntimeTurnProjection: () => {},
      startTurn: async () => {
        throw new Error('not implemented')
      },
      acknowledgeCompletedTurn: () => false,
      interrupt: async () => false,
      liveBackgroundTasks: () => null,
      subscribe: () => () => {},
    },
  } as unknown as ProjectRoutesInput
  return { db, dbPath, store, client, readInput, service: new LarkRemoteService('bot', store, client, readInput, () => 1_000) }
}

function cardToken(action: Partial<LarkCardAction> = {}): string {
  return encodeLarkCardAction({ version: 1, botId: 'bot', configVersion: 1, projectId: project.id, card: 'sessions', operation: 'refresh', loadedCount: 5, createdAtMs: 1_000, ...action }, 'secret')
}

async function pair(store: RemoteBotStore, _service: LarkRemoteService): Promise<void> {
  store.bind('bot', 'owner', 'chat', 'Owner', null, 500)
}

function projectSummary(index: number): ProjectSummary {
  return { id: `project-${index}`, name: `Project ${index}`, path: `/tmp/project-${index}`, lastActivityAt: 1_000 - index }
}

describe('LarkRemoteService', () => {
  it('handles missing bots, groups, authorization, and invalid messages in a safe order', async () => {
    const { db, store, client, service } = await setup()
    await expect(
      service.onMessage({ eventId: 'group', senderOpenId: 'owner', chatId: 'group', chatType: 'group', messageId: 'm1', messageType: 'text', content: JSON.stringify({ text: 'hi' }) }),
    ).resolves.toMatchObject({ reason: 'group_not_supported' })
    store.bind('bot', 'owner', 'chat', 'Owner', null, 500)
    await expect(service.onMessage({ eventId: 'unauthorized', senderOpenId: 'other', chatId: 'chat', chatType: 'p2p', messageId: 'm3', messageType: 'image', content: '{}' })).resolves.toMatchObject({
      reason: 'unauthorized',
    })
    await expect(service.onMessage({ eventId: 'ordinary', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'm4', messageType: 'image', content: '{}' })).resolves.toMatchObject({
      reason: 'invalid_message',
    })
    await expect(
      service.onMessage({
        eventId: 'message-menu',
        senderOpenId: 'owner',
        chatId: 'chat',
        chatType: 'p2p',
        messageId: 'm4',
        messageType: 'text',
        content: JSON.stringify({ text: 'Browse Sessions' }),
      }),
    ).resolves.toMatchObject({ ok: true, messageId: 'card' })
    expect(client.sendText.mock.calls.map(([, text]) => text)).toEqual([
      "Group chats aren't supported yet. Message the bot in a direct chat.",
      "This chat isn't authorized.",
      'Send a non-empty text message.',
    ])
    expect(client.sendCard).toHaveBeenCalledOnce()
    store.delete('bot')
    const sends = client.sendText.mock.calls.length
    await expect(
      service.onMessage({ eventId: 'missing', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'm5', messageType: 'text', content: JSON.stringify({ text: 'hello' }) }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bot_not_found',
    })
    expect(client.sendText).toHaveBeenCalledTimes(sends)
    db.close()
  })

  it('handles the fixed menu event and deduplicates in flight and for one hour in memory', async () => {
    const { db, dbPath, store, client, readInput, service } = await setup()
    const listProjectSessions = vi.spyOn(readInput.claudeCodeApi, 'listProjectSessions')
    const getProject = vi.spyOn(readInput.claudeCodeApi, 'getProject')
    store.bind('bot', 'owner', 'chat', 'Owner', null, 500)

    await expect(service.onMenu({ eventId: 'wrong-menu', eventKey: 'sessions', operatorOpenId: 'owner' })).resolves.toEqual({ ok: false, reason: 'unknown_menu' })
    const [first, second] = await Promise.all([
      service.onMenu({ eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' }),
      service.onMenu({ eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' }),
    ])
    expect(first).toEqual(second)
    expect(client.sendCard).toHaveBeenCalledOnce()
    expect(client.sendCard).toHaveBeenCalledWith('chat', expect.any(Object), 'menu')
    expect(listProjectSessions).toHaveBeenCalledWith(project.id, { limit: 5, cursor: null })

    const card = client.sendCard.mock.calls[0]?.[1] as unknown as { body: { elements: Array<{ tag: string; behaviors?: Array<{ value: { token?: string } }> }> } }
    const token = card.body.elements.find((element) => element.tag === 'interactive_container')?.behaviors?.[0]?.value.token
    expect(token).toBeTypeOf('string')
    const opened = await service.onCardAction({
      eventId: 'open',
      messageId: 'session-card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'interactive_container', value: { token } },
    })
    expect(opened).toMatchObject({ ok: true, callback: { card: { type: 'raw' } } })
    expect(client.sendCard).toHaveBeenCalledTimes(2)
    expect((client.sendCard.mock.calls[1][1] as { header: object }).header).toEqual({
      template: 'blue',
      title: { tag: 'plain_text', content: sessions[0]?.title },
      icon: { tag: 'standard_icon', token: 'submit-feedback_outlined' },
      subtitle: { tag: 'plain_text', content: project.name },
    })
    const selectedList = opened.callback?.card?.data as { body: { elements: Array<{ tag: string; background_style?: string }> } } | undefined
    expect(selectedList?.body.elements.find(({ tag }) => tag === 'interactive_container')?.background_style).toBe('session-item-selected')
    expect(listProjectSessions).toHaveBeenLastCalledWith(project.id, { limit: 2, cursor: null })
    expect(getProject).toHaveBeenCalledTimes(1)

    const refreshed = await service.onCardAction({
      eventId: 'refresh-turn',
      messageId: 'turn-card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'refresh', sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
    })
    const refreshedTurn = refreshed.callback?.card?.data as { header: object; body: { elements: object[] } }
    expect(refreshedTurn.header).toEqual((client.sendCard.mock.calls[1][1] as { header: object }).header)
    expect(JSON.stringify(refreshedTurn.body.elements)).toContain('✻ Worked')

    const previous = await service.onCardAction({
      eventId: 'previous-turn',
      messageId: 'turn-card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'previous_turn', sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
    })
    const firstTurn = await service.onCardAction({
      eventId: 'first-turn',
      messageId: 'turn-card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'first_turn', sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
    })
    const latest = await service.onCardAction({
      eventId: 'latest-turn',
      messageId: 'turn-card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'latest_turn', sessionId: sessions[0]?.id, turnId: 'user-1' }) } },
    })
    expect(readInput.transcriptSyncer).toHaveBeenCalledWith(project.id, sessions[0]?.id)
    expect(client.updateCard).not.toHaveBeenCalled()
    expect(client.sendCard).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(previous.callback?.card?.data)).toContain('First prompt')
    expect(JSON.stringify(firstTurn.callback?.card?.data)).toContain('First prompt')
    expect(JSON.stringify(latest.callback?.card?.data)).toContain('Second prompt')

    for (const operation of ['first_turn', 'previous_turn'] as const)
      await expect(
        service.onCardAction({
          eventId: `first-${operation}`,
          messageId: 'turn-card',
          chatId: 'chat',
          operatorOpenId: 'owner',
          action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation, sessionId: sessions[0]?.id, turnId: 'user-1' }) } },
        }),
      ).resolves.toEqual({ ok: true, callback: { toast: { type: 'info', content: 'This is the first Turn.' } } })
    for (const operation of ['next_turn', 'latest_turn'] as const)
      await expect(
        service.onCardAction({
          eventId: `latest-${operation}`,
          messageId: 'turn-card',
          chatId: 'chat',
          operatorOpenId: 'owner',
          action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation, sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
        }),
      ).resolves.toEqual({ ok: true, callback: { toast: { type: 'info', content: 'This is the latest Turn.' } } })
    expect(client.updateCard).not.toHaveBeenCalled()

    await expect(service.onMenu({ eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })).resolves.toEqual(first)
    expect(client.sendCard).toHaveBeenCalledTimes(2)

    const rebuilt = new LarkRemoteService('bot', store, client, readInput, () => 1_000)
    await expect(rebuilt.onMenu({ eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })).resolves.toEqual(first)
    expect(client.sendCard).toHaveBeenCalledTimes(3)

    db.close()
    const reopenedDb = createCottaDatabase(dbPath)
    const afterRestart = new LarkRemoteService('bot', new RemoteBotStore(reopenedDb), client, readInput, () => 1_000)
    await expect(afterRestart.onMenu({ eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })).resolves.toEqual(first)
    expect(client.sendCard).toHaveBeenCalledTimes(4)
    reopenedDb.close()
  })

  it('expires in-memory event results after one hour', async () => {
    const { db, store, client, readInput } = await setup()
    let now = 1_000
    const service = new LarkRemoteService('bot', store, client, readInput, () => now)
    store.bind('bot', 'owner', 'chat', 'Owner', null, 500)
    const event = { eventId: 'menu', eventKey: LIST_SESSIONS, operatorOpenId: 'owner' }

    await service.onMenu(event)
    now += 60 * 60 * 1000 - 1
    await service.onMenu(event)
    expect(client.sendCard).toHaveBeenCalledOnce()
    now += 1
    await service.onMenu(event)
    expect(client.sendCard).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('rejects stale Turn anchors with a visible not-found result', async () => {
    const { db, store, service } = await setup()
    await pair(store, service)

    await expect(
      service.onCardAction({
        eventId: 'stale-turn',
        messageId: 'turn-card',
        chatId: 'chat',
        operatorOpenId: 'owner',
        action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'refresh', sessionId: sessions[0]?.id, turnId: 'old-local-command' }) } },
      }),
    ).resolves.toEqual({ ok: false, reason: 'turn_not_found' })
    db.close()
  })

  it('maps card read errors precisely and rethrows unknown errors', async () => {
    const cases = [
      [new ProjectReadModelError('project_not_found'), 'project_not_found'],
      [new ProjectReadModelError('session_not_found'), 'session_not_found'],
      [new ProjectReadModelError('session_raw_transcript_unavailable'), 'read_failed'],
      [new ProjectReadModelError('timeline_metadata_unavailable'), 'read_failed'],
      [new TranscriptUnavailableError(sessions[0]!.id), 'read_failed'],
    ] as const
    for (const [error, reason] of cases) {
      const { db, store, readInput, service } = await setup()
      await pair(store, service)
      readInput.transcriptSyncer = vi.fn(async () => {
        throw error
      })
      await expect(
        service.onCardAction({
          messageId: 'turn-card',
          chatId: 'chat',
          operatorOpenId: 'owner',
          action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'previous_turn', sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
        }),
      ).resolves.toEqual({ ok: false, reason })
      db.close()
    }
    const { db, store, readInput, service } = await setup()
    await pair(store, service)
    readInput.transcriptSyncer = vi.fn(async () => {
      throw new Error('unknown')
    })
    await expect(
      service.onCardAction({
        messageId: 'turn-card',
        chatId: 'chat',
        operatorOpenId: 'owner',
        action: { tag: 'button', value: { token: cardToken({ card: 'turn', operation: 'previous_turn', sessionId: sessions[0]?.id, turnId: 'user-2' }) } },
      }),
    ).rejects.toThrow('unknown')
    db.close()
  })

  it('rejects Open actions without a loaded session count', async () => {
    const { db, store, client, service } = await setup()
    await pair(store, service)
    const token = encodeLarkCardAction(
      { version: 1, botId: 'bot', configVersion: 1, projectId: project.id, card: 'sessions', operation: 'open', sessionId: sessions[0]?.id, createdAtMs: 1_000 },
      'secret',
    )

    await expect(
      service.onCardAction({ eventId: 'missing-count', messageId: 'session-card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'interactive_container', value: { token } } }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_action' })
    expect(client.sendCard).not.toHaveBeenCalled()
    db.close()
  })

  it('opens a selected session from an empty fetched window using the default page size', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    const listProjectSessions = vi.spyOn(readInput.claudeCodeApi, 'listProjectSessions')
    const token = cardToken({ operation: 'open', sessionId: sessions[0]?.id, loadedCount: 0 })

    await expect(
      service.onCardAction({ eventId: 'empty-window', messageId: 'session-card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'interactive_container', value: { token } } }),
    ).resolves.toMatchObject({ ok: true, callback: { card: { type: 'raw' } } })
    expect(listProjectSessions).toHaveBeenCalledWith(project.id, { limit: 5, cursor: null })
    expect(client.sendCard).toHaveBeenCalledOnce()
    db.close()
  })

  it('does not send a Turn card when selected-list preparation fails', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    readInput.claudeCodeApi.listProjectSessions = vi.fn(async () => {
      throw new Error('list failed')
    })

    await expect(
      service.onCardAction({
        eventId: 'open-failed',
        messageId: 'session-card',
        chatId: 'chat',
        operatorOpenId: 'owner',
        action: { tag: 'interactive_container', value: { token: cardToken({ operation: 'open', sessionId: sessions[0]?.id }) } },
      }),
    ).rejects.toThrow('list failed')
    expect(client.sendCard).not.toHaveBeenCalled()
    db.close()
  })

  it('opens a valid session outside the session list page', async () => {
    const { db, store, client, readInput } = await setup()
    const fetchedSessions = sessions.slice(0, 1)
    const listProjectSessions = vi.spyOn(readInput.claudeCodeApi, 'listProjectSessions').mockResolvedValue({
      project,
      sessions: fetchedSessions,
      defaultSessionId: fetchedSessions[0]?.id ?? null,
      hasMore: true,
      nextCursor: 'next',
    })
    const service = new LarkRemoteService('bot', store, client, { ...readInput, transcriptIndex: memoryTranscriptIndex('session-older') }, () => 1_000)
    store.bind('bot', 'owner', 'chat', 'Owner', null, 500)
    const token = encodeLarkCardAction(
      { version: 1, botId: 'bot', configVersion: 1, projectId: project.id, card: 'sessions', operation: 'open', sessionId: 'session-older', loadedCount: 5, createdAtMs: 1_000 },
      'secret',
    )

    const opened = await service.onCardAction({ eventId: 'old', messageId: 'session-card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'interactive_container', value: { token } } })
    expect(opened).toMatchObject({ ok: true, callback: { card: { type: 'raw' } } })
    const selectedList = opened.callback?.card?.data as { body: { elements: Array<{ tag: string; background_style?: string; behaviors?: Array<{ value: { token: string } }> }> } } | undefined
    const rows = selectedList?.body.elements.filter(({ tag }) => tag === 'interactive_container') ?? []
    const actions = rows.map((row) => decodeLarkCardAction(row.behaviors?.[0]?.value.token as string, 'secret', 1_000))
    expect(rows).toHaveLength(fetchedSessions.length + 1)
    expect(actions.map((action) => action?.sessionId)).toEqual([...fetchedSessions.map(({ id }) => id), 'session-older'])
    expect(actions.every((action) => action?.loadedCount === fetchedSessions.length)).toBe(true)
    expect(rows.at(-1)?.background_style).toBe('session-item-selected')
    expect(client.sendCard).toHaveBeenCalledOnce()
    expect(listProjectSessions).toHaveBeenCalledWith(project.id, { limit: 5, cursor: null })
    db.close()
  })

  it('uses the latest ten authorized projects and retains a selected project that falls out', async () => {
    const allowed = [project, ...Array.from({ length: 11 }, (_, index) => projectSummary(index + 2))]
    const { db, store, client, readInput, service } = await setup({ allProjects: false, projectIds: allowed.map(({ id }) => id) })
    readInput.claudeCodeApi.listProjects = vi.fn(async () => ({ projects: allowed.slice(1), hasMore: false, nextCursor: null }))
    const listProjectSessions = vi.fn(async (id: string) => ({
      project: allowed.find(({ id: candidate }) => candidate === id) ?? project,
      sessions: [],
      defaultSessionId: null,
      hasMore: false,
      nextCursor: null,
    }))
    readInput.claudeCodeApi.listProjectSessions = listProjectSessions
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]?.id ?? null, 1_000)

    await service.onMenu({ eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })
    const initial = client.sendCard.mock.calls[0]?.[1] as {
      body: { elements: Array<{ tag: string; initial_option?: string; background_style?: string; options?: Array<{ value: string }> }> }
    }
    const selector = initial.body.elements.find(({ tag }) => tag === 'select_static')
    expect(selector?.initial_option).toBe(project.name)
    expect(selector?.options?.map(({ value }) => decodeLarkCardAction(value, 'secret', 1_000)?.projectId)).toEqual([project.id, ...allowed.slice(1, 10).map(({ id }) => id)])
    expect(initial.body.elements.find(({ tag }) => tag === 'interactive_container')?.background_style).toBe('session-item-selected')
    expect(listProjectSessions).toHaveBeenCalledWith(project.id, { limit: 5, cursor: null })
    expect(store.getBot('bot')).toMatchObject({ selectedProjectId: project.id, selectedSessionId: sessions[0]?.id })

    const result = await service.onCardAction({ messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'button', value: { token: cardToken() } } })
    const refreshed = result.callback?.card?.data as { body: { elements: Array<{ tag: string; options?: Array<{ value: string }> }> } }
    const options = refreshed.body.elements.find(({ tag }) => tag === 'select_static')?.options ?? []
    expect(options).toHaveLength(10)
    expect(options.map(({ value }) => decodeLarkCardAction(value, 'secret', 1_000)?.projectId)).toEqual([project.id, ...allowed.slice(1, 10).map(({ id }) => id)])
    db.close()
  })

  it('clears a selected project only after its authoritative lookup fails', async () => {
    const { db, store, readInput, service } = await setup({ allProjects: false, projectIds: [project.id, 'missing'] })
    const listProjectSessions = vi.spyOn(readInput.claudeCodeApi, 'listProjectSessions')
    await pair(store, service)
    store.setSelection('bot', 'missing', 'session-missing', 1_000)

    await service.onMenu({ eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })

    expect(store.getBot('bot')).toMatchObject({ selectedProjectId: null, selectedSessionId: null })
    expect(listProjectSessions).toHaveBeenCalledWith(project.id, { limit: 5, cursor: null })
    db.close()
  })

  it('supports future projects for all-project scope and resets each project selection to five sessions', async () => {
    const future = projectSummary(2)
    const { db, store, client, readInput, service } = await setup({ allProjects: true, projectIds: [] })
    readInput.claudeCodeApi.listProjects = vi.fn(async () => ({ projects: [project, future], hasMore: false, nextCursor: null }))
    readInput.claudeCodeApi.getProject = vi.fn(async (id: string) => (id === future.id ? future : id === project.id ? project : null))
    const list = vi.fn(async (id: string, _options: { limit?: number }) => {
      const selected = id === future.id ? future : id === project.id ? project : null
      return selected ? { project: selected, sessions: [], defaultSessionId: null, hasMore: false, nextCursor: null } : null
    })
    readInput.claudeCodeApi.listProjectSessions = list
    await pair(store, service)

    await service.onMenu({ eventKey: LIST_SESSIONS, operatorOpenId: 'owner' })
    const selector = (card: unknown) =>
      (card as { body: { elements: Array<{ tag: string; initial_option?: string; options?: Array<{ text: { content: string }; value: string }> }> } }).body.elements.find(
        ({ tag }) => tag === 'select_static',
      )
    const initial = selector(client.sendCard.mock.calls[0]?.[1])
    const futureToken = initial?.options?.find(({ text }) => text.content === future.name)?.value

    const selectedFuture = await service.onCardAction({ messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'select_static', option: futureToken } })
    const futureCard = selector(selectedFuture.callback?.card?.data)
    const projectToken = futureCard?.options?.find(({ text }) => text.content === project.name)?.value
    const selectedProject = await service.onCardAction({ messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'select_static', option: projectToken } })

    expect(list.mock.calls).toEqual([
      [project.id, { limit: 5, cursor: null }],
      [future.id, { limit: 5, cursor: null }],
      [project.id, { limit: 5, cursor: null }],
    ])
    expect(client.updateCard).not.toHaveBeenCalled()
    expect(futureCard?.initial_option).toBe(future.name)
    expect(selector(selectedProject.callback?.card?.data)?.initial_option).toBe(project.name)
    db.close()
  })

  it('reprojects New without the previous session highlight', async () => {
    const { db, store, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)

    const result = await service.onCardAction({
      messageId: 'card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button', value: { token: cardToken({ operation: 'new' }) } },
    })
    const card = result.callback?.card?.data as { body: { elements: Array<{ background_style?: string }> } }

    expect(result.callback?.toast).toEqual({ type: 'success', content: 'New session ready. Send a message to start.' })
    expect(card.body.elements.some(({ background_style }) => background_style === 'session-item-selected')).toBe(false)
    expect(store.getBot('bot')).toMatchObject({ selectedProjectId: project.id, selectedSessionId: null })
    db.close()
  })

  it('clears stale sessions on list refresh but preserves active unindexed sessions', async () => {
    const { db, store, readInput, service } = await setup()
    await pair(store, service)
    const action = (operation: 'refresh' | 'more') => ({
      messageId: 'card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'button' as const, value: { token: cardToken({ operation }) } },
    })

    for (const operation of ['refresh', 'more'] as const) {
      store.setSelection('bot', project.id, 'missing', 1_000)
      readInput.liveTurnManager.sessionRunState = vi.fn(() => null)
      await expect(service.onCardAction(action(operation))).resolves.toMatchObject({ ok: true, callback: { card: { type: 'raw' } } })
      expect(store.getBot('bot')).toMatchObject({ selectedProjectId: null, selectedSessionId: null })
    }
    for (const phase of ['running', 'requires_action'] as const) {
      store.setSelection('bot', project.id, 'missing', 1_000)
      readInput.liveTurnManager.sessionRunState = vi.fn(() => ({ phase, activeUserMessageUuid: 'turn', lastTurn: null }))
      await service.onCardAction(action('refresh'))
      expect(store.getBot('bot')).toMatchObject({ selectedProjectId: project.id, selectedSessionId: 'missing' })
    }
    db.close()
  })

  it('rejects rapid resubmission without losing an active unindexed session', async () => {
    for (const [phase, text] of [
      ['running', 'This session already has a Turn in progress. Wait for it to finish and try again.'],
      ['requires_action', 'This session is waiting for input in Cotta Web. Complete the Permission or AskUserQuestion there, then try again.'],
    ] as const) {
      const { db, store, client, readInput, service } = await setup()
      await pair(store, service)
      store.setSelection('bot', project.id, 'unindexed', 1_000)
      readInput.liveTurnManager.sessionRunState = vi.fn(() => ({ phase, activeUserMessageUuid: 'turn', lastTurn: null }))
      readInput.liveTurnManager.startTurn = vi.fn()
      readInput.liveTurnManager.subscribe = vi.fn(() => vi.fn())

      await expect(
        service.onMessage({
          eventId: `resubmit-${phase}`,
          senderOpenId: 'owner',
          chatId: 'chat',
          chatType: 'p2p',
          messageId: 'message',
          messageType: 'text',
          content: JSON.stringify({ text: 'again' }),
        }),
      ).resolves.toEqual({ ok: false, reason: 'session_turn_in_progress', messageId: 'text' })
      expect(client.sendText).toHaveBeenLastCalledWith('chat', text, `resubmit-${phase}`)
      expect(client.createAndSendCard).not.toHaveBeenCalled()
      expect(readInput.liveTurnManager.subscribe).not.toHaveBeenCalled()
      expect(readInput.liveTurnManager.startTurn).not.toHaveBeenCalled()
      expect(store.getBot('bot')).toMatchObject({ selectedProjectId: project.id, selectedSessionId: 'unindexed' })
      db.close()
    }
  })

  it('clears an inactive unindexed session instead of creating a replacement', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, 'unindexed', 1_000)
    readInput.liveTurnManager.sessionRunState = vi.fn(() => ({ phase: 'idle' as const, activeUserMessageUuid: null }))
    readInput.liveTurnManager.startTurn = vi.fn()

    await expect(
      service.onMessage({ eventId: 'stale-submit', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'again' }) }),
    ).resolves.toEqual({ ok: false, reason: 'session_not_found' })
    expect(store.getBot('bot')).toMatchObject({ selectedProjectId: null, selectedSessionId: null })
    expect(client.createAndSendCard).not.toHaveBeenCalled()
    expect(readInput.liveTurnManager.startTurn).not.toHaveBeenCalled()
    db.close()
  })

  it('rejects unauthorized or missing selected projects before reading sessions', async () => {
    const { db, store, readInput, service } = await setup()
    await pair(store, service)
    const list = vi.spyOn(readInput.claudeCodeApi, 'listProjectSessions')
    const selected = (projectId: string) => ({
      messageId: 'card',
      chatId: 'chat',
      operatorOpenId: 'owner',
      action: { tag: 'select_static', option: cardToken({ projectId, operation: 'select_project' }) },
    })

    await expect(service.onCardAction(selected('not-authorized'))).resolves.toEqual({ ok: false, reason: 'configuration_changed' })
    store.update('bot', { projectIds: [project.id, 'missing'] }, 2)
    await expect(
      service.onCardAction({ ...selected('missing'), action: { tag: 'select_static', option: cardToken({ projectId: 'missing', operation: 'select_project', configVersion: 2 }) } }),
    ).resolves.toEqual({
      ok: false,
      reason: 'project_not_found',
    })
    expect(list).not.toHaveBeenCalled()
    db.close()
  })

  it('dispatches strictly by action tag and rejects tag-field confusion', async () => {
    const { db, store, service } = await setup()
    await pair(store, service)
    const token = cardToken()
    const event = (action: object) => ({ messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action })

    await expect(service.onCardAction(event({ tag: 'select_static', value: { token } }))).resolves.toMatchObject({ reason: 'card_expired_or_invalid' })
    await expect(service.onCardAction(event({ tag: 'button', option: token }))).resolves.toMatchObject({ reason: 'card_expired_or_invalid' })
    await expect(service.onCardAction(event({ tag: 'unknown', option: token, value: { token } }))).resolves.toEqual({ ok: false, reason: 'invalid_action' })
    db.close()
  })

  it('releases failed event claims so platform retries can run', async () => {
    const { db, client, service } = await setup()
    client.sendText.mockRejectedValueOnce(new Error('temporary'))
    const event = { eventId: 'retry', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'm', messageType: 'image', content: '{}' }

    await expect(service.onMessage(event)).rejects.toThrow('temporary')
    await expect(service.onMessage(event)).resolves.toMatchObject({ reason: 'unauthorized' })
    expect(client.sendText).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('streams only the current main Turn with bounded full-card updates and monotonic sequences', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({ eventId: 'submit', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'continue' }) })
    const turnId = (readInput.liveTurnManager.startTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userMessageUuid as string
    const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
    subscriber?.(main('assistant', { uuid: 'activity', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/a' } }] } }))
    activeTurnId = 'another-turn'
    subscriber?.(main('assistant', { uuid: 'ignored', message: { role: 'assistant', content: [{ type: 'text', text: 'wrong turn' }] } }))
    activeTurnId = turnId
    subscriber?.({ ...main('assistant'), uuid: 'sidechain', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain' }] } })
    subscriber?.({
      type: 'user',
      uuid: 'tool-result',
      session_id: sessions[0]!.id,
      parent_tool_use_id: 'read',
      parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'failed', is_error: true }] },
    })
    subscriber?.(main('assistant', { uuid: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }))
    subscriber?.(main('result', { subtype: 'success' }))

    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(4))
    const updateCalls = client.updateCardEntity.mock.calls as unknown as Array<[string, object, string, number]>
    expect(client.appendCardElements).not.toHaveBeenCalled()
    expect(client.streamCardElement).not.toHaveBeenCalled()
    expect(updateCalls.map((call) => call[3])).toEqual([1, 2, 3, 4])
    expect(updateCalls.every((call) => Buffer.byteLength(JSON.stringify(call[1]), 'utf8') < 30_000)).toBe(true)
    expect(JSON.stringify(updateCalls.at(-1)?.[1])).not.toMatch(/wrong turn|sidechain|First Turn|Previous Turn|Next Turn|Latest Turn/)
    db.close()
  })

  it('handles a failed final card update without another mutation', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })
    await service.onMessage({
      eventId: 'failed-final-update',
      senderOpenId: 'owner',
      chatId: 'chat',
      chatType: 'p2p',
      messageId: 'message',
      messageType: 'text',
      content: JSON.stringify({ text: 'continue' }),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.updateCardEntity.mockRejectedValueOnce(new Error('update failed'))

    subscriber?.({ type: 'result', subtype: 'success', session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null })

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('Lark result card stream failed', expect.objectContaining({ message: 'update failed' })))
    consoleError.mockRestore()
    db.close()
  })

  it('keeps streaming when background tasks start before the main result', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return unsubscribe
    })
    let activeTurnId: string | null = null
    readInput.liveTurnManager.liveBackgroundTasks = vi.fn(() => [{ taskId: 'task-1', taskType: 'agent' }])
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })
    await service.onMessage({
      eventId: 'early-background',
      senderOpenId: 'owner',
      chatId: 'chat',
      chatType: 'p2p',
      messageId: 'message',
      messageType: 'text',
      content: JSON.stringify({ text: 'continue' }),
    })
    const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })

    subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'agent' }] }))
    subscriber?.(main('assistant', { uuid: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: 'Done after starting task' }] } }))
    subscriber?.(main('result', { subtype: 'success' }))

    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(2))
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(JSON.stringify(client.updateCardEntity.mock.calls)).toContain('Done after starting task')
    db.close()
  })

  it('keeps a settled card subscribed until background tasks finish', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return unsubscribe
    })
    let activeTurnId: string | null = null
    let backgroundTasks: Array<{ taskId: string; taskType: string }> = []
    readInput.liveTurnManager.liveBackgroundTasks = vi.fn(() => backgroundTasks)
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({
      eventId: 'background-submit',
      senderOpenId: 'owner',
      chatId: 'chat',
      chatType: 'p2p',
      messageId: 'message',
      messageType: 'text',
      content: JSON.stringify({ text: 'continue' }),
    })
    const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    backgroundTasks = [{ taskId: 'task-1', taskType: 'agent' }]
    subscriber?.(main('result', { subtype: 'success' }))

    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(1))
    expect(unsubscribe).not.toHaveBeenCalled()
    const firstUpdate = (client.updateCardEntity.mock.calls as unknown as Array<[string, { config: { streaming_mode?: boolean } }, string, number]>)[0]
    expect(firstUpdate?.[1].config.streaming_mode).toBe(false)

    subscriber?.(main('system', { subtype: 'task_notification' }))
    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(2))
    expect(unsubscribe).not.toHaveBeenCalled()

    backgroundTasks = []
    subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [] }))
    expect(unsubscribe).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(3))
    const updates = client.updateCardEntity.mock.calls as unknown as Array<[string, { config: { streaming_mode?: boolean } }, string, number]>
    expect(updates.map((call) => call[3])).toEqual([1, 2, 3])
    expect(updates.at(-1)?.[1].config.streaming_mode).toBe(false)
    expect(JSON.stringify(updates.at(-1)?.[1])).not.toContain('Waiting for 1 background task to finish')
    consoleError.mockRestore()
    db.close()
  })

  it('tracks background tasks after every terminal outcome and preserves failures', async () => {
    for (const terminal of ['success', 'error', 'failure'] as const) {
      for (const initialTasks of [null, [], [{ taskId: 'task-1', taskType: 'agent' }]] as const) {
        const { db, store, client, readInput, service } = await setup()
        await pair(store, service)
        store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
        let subscriber: ((message: unknown) => void) | undefined
        const unsubscribe = vi.fn()
        readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
          subscriber = callback
          return unsubscribe
        })
        let activeTurnId: string | null = null
        let backgroundTasks: null | Array<{ taskId: string; taskType: string }> = initialTasks ? [...initialTasks] : initialTasks
        readInput.liveTurnManager.liveBackgroundTasks = vi.fn(() => backgroundTasks)
        readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
        readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
          activeTurnId = userMessageUuid
          return { sessionId, userMessageUuid }
        })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        await service.onMessage({
          eventId: `matrix-${terminal}-${initialTasks === null ? 'unknown' : initialTasks.length ? 'nonempty' : 'empty'}`,
          senderOpenId: 'owner',
          chatId: 'chat',
          chatType: 'p2p',
          messageId: 'message',
          messageType: 'text',
          content: JSON.stringify({ text: 'continue' }),
        })
        if (terminal !== 'failure')
          readInput.transcriptSyncer = vi.fn(async () => {
            throw new Error('timeline unavailable')
          })
        const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
        if (terminal === 'success') subscriber?.(main('result', { subtype: 'success' }))
        else if (terminal === 'error') subscriber?.(main('result', { subtype: 'error_during_execution', errors: ['SDK failed'] }))
        else subscriber?.(main('cotta_live_turn_failed', { error: 'Runtime failed' }))

        await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(1))
        expect(unsubscribe).not.toHaveBeenCalled()
        if (terminal !== 'success') {
          const updates = client.updateCardEntity.mock.calls as unknown as Array<[string, object, string, number]>
          expect(JSON.stringify(updates[0]?.[1])).toContain(terminal === 'error' ? 'SDK failed' : 'Runtime failed')
        }

        if (!initialTasks?.length) {
          backgroundTasks = [{ taskId: 'task-1', taskType: 'agent' }]
          subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'agent' }] }))
          await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(2))
          expect(unsubscribe).not.toHaveBeenCalled()
        }
        subscriber?.(main('system', { subtype: 'task_notification', task_id: 'task-1', status: 'completed' }))
        await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(initialTasks?.length ? 2 : 3))
        expect(unsubscribe).not.toHaveBeenCalled()
        backgroundTasks = []
        subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [] }))
        expect(unsubscribe).toHaveBeenCalledOnce()
        await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(initialTasks?.length ? 3 : 4))
        const sequences = (client.updateCardEntity.mock.calls as unknown as Array<[string, object, string, number]>).map((call) => call[3])
        expect(sequences).toEqual(sequences.map((_, index) => index + 1))
        consoleError.mockRestore()
        db.close()
      }
    }
  })

  it('stops terminal subscriptions after the background discovery grace', async () => {
    vi.useFakeTimers()
    try {
      for (const terminal of ['success', 'error', 'failure'] as const) {
        for (const initialTasks of [null, []] as const) {
          const { db, store, readInput, service } = await setup()
          await pair(store, service)
          store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
          let subscriber: ((message: unknown) => void) | undefined
          const unsubscribe = vi.fn()
          readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
            subscriber = callback
            return unsubscribe
          })
          let activeTurnId: string | null = null
          readInput.liveTurnManager.liveBackgroundTasks = vi.fn(() => initialTasks)
          readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
          readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
            activeTurnId = userMessageUuid
            return { sessionId, userMessageUuid }
          })
          await service.onMessage({
            eventId: `grace-${terminal}-${initialTasks === null ? 'unknown' : 'empty'}`,
            senderOpenId: 'owner',
            chatId: 'chat',
            chatType: 'p2p',
            messageId: 'message',
            messageType: 'text',
            content: JSON.stringify({ text: 'continue' }),
          })
          const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
          if (terminal === 'success') subscriber?.(main('result', { subtype: 'success' }))
          else if (terminal === 'error') subscriber?.(main('result', { subtype: 'error_during_execution', errors: ['SDK failed'] }))
          else subscriber?.(main('cotta_live_turn_failed', { error: 'Runtime failed' }))

          await vi.advanceTimersByTimeAsync(999)
          expect(unsubscribe).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(1)
          expect(unsubscribe).toHaveBeenCalledOnce()
          db.close()
        }
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the discovery grace when a background task appears', async () => {
    vi.useFakeTimers()
    try {
      const { db, store, readInput, service } = await setup()
      await pair(store, service)
      store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
      let subscriber: ((message: unknown) => void) | undefined
      const unsubscribe = vi.fn()
      readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
        subscriber = callback
        return unsubscribe
      })
      let activeTurnId: string | null = null
      let backgroundTasks: Array<{ taskId: string; taskType: string }> = []
      readInput.liveTurnManager.liveBackgroundTasks = vi.fn(() => backgroundTasks)
      readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
      readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
        activeTurnId = userMessageUuid
        return { sessionId, userMessageUuid }
      })
      await service.onMessage({
        eventId: 'cancel-grace',
        senderOpenId: 'owner',
        chatId: 'chat',
        chatType: 'p2p',
        messageId: 'message',
        messageType: 'text',
        content: JSON.stringify({ text: 'continue' }),
      })
      const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
      subscriber?.(main('result', { subtype: 'success' }))
      backgroundTasks = [{ taskId: 'task-1', taskType: 'agent' }]
      subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'agent' }] }))

      await vi.advanceTimersByTimeAsync(1_000)
      expect(unsubscribe).not.toHaveBeenCalled()
      backgroundTasks = []
      subscriber?.(main('system', { subtype: 'background_tasks_changed', tasks: [] }))
      expect(unsubscribe).toHaveBeenCalledOnce()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps text deltas when timeline settle fails', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({
      eventId: 'delta-submit',
      senderOpenId: 'owner',
      chatId: 'chat',
      chatType: 'p2p',
      messageId: 'message',
      messageType: 'text',
      content: JSON.stringify({ text: 'continue' }),
    })
    const turnId = (readInput.liveTurnManager.startTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userMessageUuid as string
    const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
    readInput.transcriptSyncer = vi.fn(async () => {
      throw new Error('timeline unavailable')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscriber?.(main('user', { uuid: turnId, message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } }))
    subscriber?.(main('stream_event', { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'delta only' } } }))
    subscriber?.(main('result', { subtype: 'success' }))

    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(3))
    const updates = client.updateCardEntity.mock.calls as unknown as Array<[string, { config: { streaming_mode?: boolean } }, string, number]>
    expect(updates.at(-1)?.[1].config.streaming_mode).toBe(false)
    expect(JSON.stringify(updates.at(-1)?.[1])).toContain('delta only')
    consoleError.mockRestore()
    db.close()
  })

  it('keeps the Failed reply when timeline settle reads the turn', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    let subscriber: ((message: unknown) => void) | undefined
    readInput.liveTurnManager.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    readInput.liveTurnManager.sessionRunState = vi.fn(() => (activeTurnId ? { phase: 'running' as const, activeUserMessageUuid: activeTurnId, lastTurn: null } : null))
    readInput.liveTurnManager.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({
      eventId: 'settle-failure',
      senderOpenId: 'owner',
      chatId: 'chat',
      chatType: 'p2p',
      messageId: 'message',
      messageType: 'text',
      content: JSON.stringify({ text: 'continue' }),
    })
    const turnId = (readInput.liveTurnManager.startTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userMessageUuid as string
    // Timeline settle reads the just-synced turn with a benign assistant reply (no failure info in transcript).
    readInput.rawTranscriptCache!.loadTimelineWindow = vi.fn(() => ({
      primaryTurns: [{ uuid: turnId, timestamp: 1_000 }],
      ownedMessages: [
        { ownerTurnId: turnId, message: { type: 'user', uuid: turnId, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'continue' } } },
        {
          ownerTurnId: turnId,
          message: {
            type: 'assistant',
            uuid: 'assistant-settle',
            session_id: sessions[0]!.id,
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { id: 'msg_settle', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Benign transcript answer' }] },
          },
        },
      ],
      hasMore: false,
      hasNewer: false,
      nextCursor: null,
      snapshotFromTurnId: null,
      anchorTurnId: turnId,
      version: timelineState.version,
      fileSize: timelineState.fileSize!,
    })) as never
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const main = (type: string, extra: object = {}) => ({ type, session_id: sessions[0]!.id, parent_tool_use_id: null, parent_agent_id: null, ...extra })
    subscriber?.(main('cotta_live_turn_failed', { error: 'Runtime failed' }))

    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalledTimes(1))
    const serialized = JSON.stringify(client.updateCardEntity.mock.calls)
    expect(serialized).toContain('Runtime failed')
    expect(serialized).not.toContain('Benign transcript answer')
    consoleError.mockRestore()
    db.close()
  })

  it('returns and caches stable submit conflicts after updating the created card', async () => {
    for (const [error, reason, detail] of [
      [new SessionExternallyOwnedError(), 'session_externally_owned', 'This session is currently active outside Cotta. Wait for it to finish and try again.'],
      [new SessionTurnInProgressError(), 'session_turn_in_progress', 'This session already has a Turn in progress. Wait for it to finish and try again.'],
    ] as const) {
      const { db, store, client, readInput, service } = await setup()
      await pair(store, service)
      store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
      readInput.liveTurnManager.startTurn = vi.fn(async () => {
        throw error
      })
      const event = { eventId: `stable-${reason}`, senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'continue' }) }

      const first = await service.onMessage(event)
      await expect(service.onMessage(event)).resolves.toEqual(first)
      expect(first).toEqual({ ok: false, reason, messageId: 'card-message' })
      expect(client.createAndSendCard).toHaveBeenCalledOnce()
      expect(client.updateCardEntity).toHaveBeenCalledOnce()
      const updates = client.updateCardEntity.mock.calls as unknown as Array<[string, object, string, number]>
      expect(JSON.stringify(updates[0]?.[1])).toContain(`**Failed**\\n\\n${detail}`)
      db.close()
    }
  })

  it('falls back to deterministic text for stable conflicts and logs if both notifications fail', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    readInput.liveTurnManager.startTurn = vi.fn(async () => {
      throw new SessionExternallyOwnedError()
    })
    client.updateCardEntity.mockRejectedValueOnce(new Error('update failed'))
    client.sendText.mockRejectedValueOnce(new Error('text failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      service.onMessage({
        eventId: 'stable-fallback',
        senderOpenId: 'owner',
        chatId: 'chat',
        chatType: 'p2p',
        messageId: 'message',
        messageType: 'text',
        content: JSON.stringify({ text: 'continue' }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'session_externally_owned', messageId: 'card-message' })
    expect(client.sendText).toHaveBeenLastCalledWith('chat', 'This session is currently active outside Cotta. Wait for it to finish and try again.', 'stable-fallback:failure-text')
    expect(consoleError).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
    db.close()
  })

  it('preserves the submit error when the failure card update also fails', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    readInput.liveTurnManager.startTurn = vi.fn(async () => {
      throw new Error('submit failed')
    })
    client.updateCardEntity.mockRejectedValueOnce(new Error('update failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      service.onMessage({ eventId: 'failed-submit', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'continue' }) }),
    ).rejects.toThrow('submit failed')
    expect(consoleError).toHaveBeenCalledWith('Lark result card failure update failed', expect.objectContaining({ message: 'update failed' }))
    consoleError.mockRestore()
    db.close()
  })

  it('rejects forwarded cards before reading project data', async () => {
    const { db, store, service } = await setup()
    store.bind('bot', 'owner', 'chat', 'Owner', null, 500)
    await expect(service.onCardAction({ eventId: 'forward', messageId: 'card', chatId: 'other', operatorOpenId: 'owner', action: { tag: 'button', value: {} } })).resolves.toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    db.close()
  })

  it('answers in-card Permission and reports stale requests', async () => {
    const { db, store, readInput, service } = await setup()
    await pair(store, service)
    const lm = readInput.liveTurnManager as unknown as {
      sessionRunState: () => unknown
      respondToPermission: ReturnType<typeof vi.fn>
      respondToQuestion: ReturnType<typeof vi.fn>
    }
    lm.respondToPermission = vi.fn(() => ({ status: 'answered' }))
    lm.respondToQuestion = vi.fn(() => ({ status: 'answered' }))

    const permissionToken = cardToken({ card: 'permission', operation: 'allow', sessionId: 'session-newest', requestId: 'req', toolUseID: 'tool' })
    lm.sessionRunState = () => ({ phase: 'requires_action', activeUserMessageUuid: 'user-2', pendingPermission: { requestId: 'req', toolUseID: 'tool', toolName: 'Bash', input: {} } })
    await expect(
      service.onCardAction({ eventId: 'perm', messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'button', value: { token: permissionToken } } }),
    ).resolves.toMatchObject({ ok: true, callback: { toast: { type: 'success' } } })
    expect(lm.respondToPermission).toHaveBeenCalledWith('session-newest', 'req', { decision: 'allow' })

    lm.sessionRunState = () => null
    await expect(
      service.onCardAction({ eventId: 'stale', messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'button', value: { token: permissionToken } } }),
    ).resolves.toMatchObject({ ok: true, callback: { toast: { type: 'info' } } })
    db.close()
  })

  it('accumulates multi-question answers in-card and submits them together', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    const respondToQuestion = vi.fn(() => ({ status: 'answered' as const }))
    const lm = readInput.liveTurnManager as unknown as Record<string, unknown>
    lm.respondToQuestion = respondToQuestion
    let subscriber: ((message: unknown) => void) | undefined
    lm.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
    }
    let phase: 'running' | 'requires_action' = 'running'
    lm.sessionRunState = vi.fn(() =>
      activeTurnId ? (phase === 'requires_action' ? { phase, activeUserMessageUuid: activeTurnId, pendingPermission: pending } : { phase, activeUserMessageUuid: activeTurnId, lastTurn: null }) : null,
    )
    lm.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({ eventId: 'submit-mq', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'go' }) })
    const turnId = (lm.startTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userMessageUuid as string
    phase = 'requires_action'
    subscriber?.({ type: 'cotta_run_state_changed', session_id: sessions[0]!.id })
    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalled())

    const answer = (questionIndex: number, optionIndex: number) =>
      cardToken({ card: 'permission', operation: 'answer', sessionId: sessions[0]!.id, turnId, requestId: 'req', toolUseID: 'tool', questionIndex, optionIndex })
    const submit = cardToken({ card: 'permission', operation: 'submit_answers', sessionId: sessions[0]!.id, turnId, requestId: 'req', toolUseID: 'tool' })
    const act = (eventId: string, token: string) => service.onCardAction({ eventId, messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'button', value: { token } } })

    await expect(act('a1', answer(0, 0))).resolves.toMatchObject({ ok: true, callback: { toast: { type: 'success' } } })
    await expect(act('a2', answer(1, 1))).resolves.toMatchObject({ ok: true })
    expect(respondToQuestion).not.toHaveBeenCalled()
    await expect(act('submit', submit)).resolves.toMatchObject({ ok: true, callback: { toast: { type: 'success' } } })
    expect(respondToQuestion).toHaveBeenCalledWith(sessions[0]!.id, 'req', { behavior: 'completed', toolUseID: 'tool', answers: { Q1: 'A', Q2: 'D' } })
    db.close()
  })

  it('toggles multi-select options and submits only answered questions', async () => {
    const { db, store, client, readInput, service } = await setup()
    await pair(store, service)
    store.setSelection('bot', project.id, sessions[0]!.id, 1_000)
    const respondToQuestion = vi.fn(() => ({ status: 'answered' as const }))
    const lm = readInput.liveTurnManager as unknown as Record<string, unknown>
    lm.respondToQuestion = respondToQuestion
    let subscriber: ((message: unknown) => void) | undefined
    lm.subscribe = vi.fn((_sessionId: string, callback: (message: unknown) => void) => {
      subscriber = callback
      return vi.fn()
    })
    let activeTurnId: string | null = null
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Q1', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
    }
    let phase: 'running' | 'requires_action' = 'running'
    lm.sessionRunState = vi.fn(() =>
      activeTurnId ? (phase === 'requires_action' ? { phase, activeUserMessageUuid: activeTurnId, pendingPermission: pending } : { phase, activeUserMessageUuid: activeTurnId, lastTurn: null }) : null,
    )
    lm.startTurn = vi.fn(async ({ sessionId, userMessageUuid }: { sessionId: string; userMessageUuid: string }) => {
      activeTurnId = userMessageUuid
      return { sessionId, userMessageUuid }
    })

    await service.onMessage({ eventId: 'submit-ms', senderOpenId: 'owner', chatId: 'chat', chatType: 'p2p', messageId: 'message', messageType: 'text', content: JSON.stringify({ text: 'go' }) })
    const turnId = (lm.startTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].userMessageUuid as string
    phase = 'requires_action'
    subscriber?.({ type: 'cotta_run_state_changed', session_id: sessions[0]!.id })
    await vi.waitFor(() => expect(client.updateCardEntity).toHaveBeenCalled())

    const answer = (questionIndex: number, optionIndex: number) =>
      cardToken({ card: 'permission', operation: 'answer', sessionId: sessions[0]!.id, turnId, requestId: 'req', toolUseID: 'tool', questionIndex, optionIndex })
    const submit = cardToken({ card: 'permission', operation: 'submit_answers', sessionId: sessions[0]!.id, turnId, requestId: 'req', toolUseID: 'tool' })
    const act = (eventId: string, token: string) => service.onCardAction({ eventId, messageId: 'card', chatId: 'chat', operatorOpenId: 'owner', action: { tag: 'button', value: { token } } })

    // Q1 multi-select: pick A and B, then toggle A off → leaves B. Q2 left unanswered.
    await act('a', answer(0, 0))
    await act('b', answer(0, 1))
    await act('a-off', answer(0, 0))
    await expect(act('submit', submit)).resolves.toMatchObject({ ok: true, callback: { toast: { type: 'success' } } })
    expect(respondToQuestion).toHaveBeenCalledWith(sessions[0]!.id, 'req', { behavior: 'completed', toolUseID: 'tool', answers: { Q1: 'B' } })
    db.close()
  })
})
