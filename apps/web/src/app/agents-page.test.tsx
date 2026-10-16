// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from './agents-page'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPage(setStatus = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentsPage setStatus={setStatus} />
    </QueryClientProvider>,
  )
  return setStatus
}

describe('AgentsPage', () => {
  it('shows the create form for an empty list and creates a bot', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects?')) return Promise.resolve(new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Cotta' }], hasMore: false, nextCursor: null }), { status: 200 }))
      if (url === '/api/remote-bots' && (!init || !init.method)) return Promise.resolve(new Response(JSON.stringify({ bots: [] }), { status: 200 }))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            bot: {
              botId: 'bot-1',
              platform: 'feishu',
              appId: 'cli_0123456789abcdef',
              allProjects: false,
              projectIds: ['project-1'],
              enabled: true,
              hasSecret: true,
              paired: false,
              pairedUserName: null,
              pairedUserAvatarUrl: null,
              connectionStatus: 'unpaired',
            },
          }),
          { status: 201 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Create bot' })).toBeTruthy()
    const appId = await screen.findByLabelText('App ID')
    expect(screen.getByText(/stored in plaintext/)).toBeTruthy()
    expect(screen.getByText(/LIST_SESSIONS/)).toBeTruthy()
    await userEvent.type(appId, 'cli_0123456789abcdef')
    await userEvent.type(screen.getByLabelText('App Secret'), 'secret')
    await userEvent.click(screen.getByLabelText('Selected projects'))
    await userEvent.click(screen.getByLabelText('Cotta'))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/remote-bots',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ platform: 'feishu', appId: 'cli_0123456789abcdef', appSecret: 'secret', allProjects: false, projectIds: ['project-1'], enabled: true }),
        }),
      ),
    )
    await waitFor(() => expect((screen.getByLabelText('App Secret') as HTMLInputElement).value).toBe(''))
  })

  it('requires at least one selected project', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/projects?')) return Promise.resolve(new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Cotta' }], hasMore: false, nextCursor: null }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ bots: [] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const setStatus = renderPage()

    await userEvent.type(await screen.findByLabelText('App ID'), 'cli_0123456789abcdef')
    await userEvent.type(screen.getByLabelText('App Secret'), 'secret')
    await userEvent.click(screen.getByLabelText('Selected projects'))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(setStatus).toHaveBeenCalledWith({ message: 'App ID, project access, and Secret are required for new bots.', tone: 'error' })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/remote-bots', expect.objectContaining({ method: 'POST' }))
  })

  it('disables saving when projects fail to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(url.startsWith('/api/projects?') ? new Response(null, { status: 500 }) : new Response(JSON.stringify({ bots: [] }), { status: 200 }))),
    )
    renderPage()

    expect(((await screen.findByRole('button', { name: 'Save changes' })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Projects failed to load/)).toBeTruthy()
  })

  it('keeps unsaved edits when the bot query refetches', async () => {
    const bot = {
      botId: 'bot-1',
      platform: 'lark',
      appId: 'saved-app',
      allProjects: false,
      projectIds: ['project-1'],
      enabled: true,
      hasSecret: true,
      paired: false,
      pairedUserName: null,
      pairedUserAvatarUrl: null,
      connectionStatus: 'connected',
    }
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/projects?')) return Promise.resolve(new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Cotta' }], hasMore: false, nextCursor: null }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ bots: [bot] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    const appId = await screen.findByLabelText('App ID')
    await waitFor(() => expect((appId as HTMLInputElement).value).toBe('saved-app'))
    expect((screen.getByLabelText('Selected projects') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('All projects including future') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Cotta') as HTMLInputElement).checked).toBe(true)
    await userEvent.click(screen.getByLabelText('All projects including future'))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/remote-bots/bot-1', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"allProjects":true,"projectIds":[]') })),
    )
    await userEvent.clear(appId)
    await userEvent.type(appId, 'unsaved-app')
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect((screen.getByLabelText('App ID') as HTMLInputElement).value).toBe('unsaved-app'))
    expect((screen.getByLabelText('App Secret') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByText('Connected')).toHaveLength(2)
  })

  it('resolves a chat id to a preview then binds on confirm', async () => {
    const bot = {
      botId: 'bot-1',
      platform: 'lark',
      appId: 'saved-app',
      allProjects: true,
      projectIds: [],
      enabled: true,
      hasSecret: true,
      paired: false,
      pairedUserName: null,
      pairedUserAvatarUrl: null,
      connectionStatus: 'connected',
    }
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/projects?')) return Promise.resolve(new Response(JSON.stringify({ projects: [], hasMore: false, nextCursor: null }), { status: 200 }))
      if (url.endsWith('/resolve')) return Promise.resolve(new Response(JSON.stringify({ name: 'Owner', avatarUrl: 'https://avatar/240' }), { status: 200 }))
      if (url.endsWith('/bind'))
        return Promise.resolve(new Response(JSON.stringify({ bot: { ...bot, paired: true, pairedUserName: 'Owner', pairedUserAvatarUrl: 'https://avatar/240' } }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ bots: [bot] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    const chatInput = await screen.findByLabelText('Chat ID')
    await userEvent.type(chatInput, 'oc_abc')
    await userEvent.tab()

    expect(await screen.findByText('Owner')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm bind' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/remote-bots/bot-1/bind', expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatId: 'oc_abc' }) })))
  })

  it('shows the bound user with avatar when paired', async () => {
    const bot = {
      botId: 'bot-1',
      platform: 'lark',
      appId: 'saved-app',
      allProjects: true,
      projectIds: [],
      enabled: true,
      hasSecret: true,
      paired: true,
      pairedUserName: 'Owner',
      pairedUserAvatarUrl: 'https://avatar/240',
      connectionStatus: 'connected',
    }
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/projects?')) return Promise.resolve(new Response(JSON.stringify({ projects: [], hasMore: false, nextCursor: null }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ bots: [bot] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    expect(await screen.findByText('Owner')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unpair chat' })).toBeTruthy()
    expect(screen.queryByLabelText('Chat ID')).toBeNull()
  })
})
