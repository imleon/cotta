// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchAuthSession } from '../api'
import { SettingsPanel } from './settings-panel'

beforeAll(() => {
  // jsdom does not implement the native <dialog> modal methods the editor uses.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const authedSession = { authenticated: true as const, user: { login: 'imleon', name: null, avatarUrl: null } }
const baseSettings = {
  timeZone: 'UTC',
  defaultPermissionMode: 'default' as const,
  defaultModel: 'default' as const,
  defaultEffort: 'medium' as const,
  useOneMillionContext: true,
  autoCompactPercent: undefined,
  showDebugNav: false,
}

describe('SettingsPanel', () => {
  it('lists IANA time zones and saves the selected value', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: { timeZone: 'America/New_York' } }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    const select = screen.getByRole('combobox', { name: 'Time zone' })
    expect((select as HTMLSelectElement).value).toBe('UTC')
    expect(screen.getByRole('option', { name: 'UTC' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /America\/New_York/ })).toBeTruthy()
    await userEvent.selectOptions(select, 'America/New_York')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ settings: { timeZone: 'America/New_York' } }) })))
  })

  it('keeps the editor disabled while a stale GitHub config is being refetched', async () => {
    let resolveConfig: ((value: Response) => void) | undefined
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/settings/github')
        return new Promise<Response>((resolve) => {
          resolveConfig = resolve
        })
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient()
    queryClient.setQueryData(['github-config'], { allowedUsers: 'stale-user' })

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel settings={baseSettings} authSession={authedSession} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    const save = screen.getByRole('button', { name: 'Save' })
    const allowedInput = screen.getByLabelText('Allowed user') as HTMLInputElement

    // Refetch is in flight: inputs and save are disabled, so stale cache cannot be submitted.
    expect(allowedInput.disabled).toBe(true)
    expect((save as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(save)
    expect(fetchMock).not.toHaveBeenCalledWith('/api/settings/github', expect.objectContaining({ method: 'PUT' }))

    resolveConfig?.(new Response(JSON.stringify({ allowedUsers: 'fresh-user' }), { status: 200 }))
    await waitFor(() => expect((screen.getByLabelText('Allowed user') as HTMLInputElement).value).toBe('fresh-user'))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('refreshes the auth session instead of calling onLogout after saving GitHub config', async () => {
    const onLogout = vi.fn()
    const authFetches: string[] = []
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/settings/github' && init?.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ allowedUsers: 'teammate' }), { status: 200 }))
      if (url === '/api/settings/github') return Promise.resolve(new Response(JSON.stringify({ allowedUsers: 'imleon' }), { status: 200 }))
      if (url === '/api/auth/session') {
        authFetches.push(url)
        return Promise.resolve(new Response(JSON.stringify({ authenticated: false, user: null }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient()
    queryClient.setQueryDefaults(['auth-session'], { queryFn: fetchAuthSession })
    queryClient.setQueryData(['auth-session'], authedSession)

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel settings={baseSettings} authSession={authedSession} onLogout={onLogout} />
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    await waitFor(() => expect((screen.getByLabelText('Allowed user') as HTMLInputElement).value).toBe('imleon'))
    const allowed = screen.getByLabelText('Allowed user') as HTMLInputElement
    await userEvent.clear(allowed)
    await userEvent.type(allowed, 'teammate')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/github', expect.objectContaining({ method: 'PUT' })))
    await waitFor(() => expect(authFetches.length).toBeGreaterThan(0))
    expect(onLogout).not.toHaveBeenCalled()
  })

  it('discards cancelled edits on reopen and blocks multi-word users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ allowedUsers: 'imleon' }), { status: 200 }))),
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={authedSession} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    await waitFor(() => expect((screen.getByLabelText('Allowed user') as HTMLInputElement).value).toBe('imleon'))
    await userEvent.type(screen.getByLabelText('Allowed user'), '-garbage')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    await waitFor(() => expect((screen.getByLabelText('Allowed user') as HTMLInputElement).value).toBe('imleon'))

    const allowed = screen.getByLabelText('Allowed user')
    await userEvent.type(allowed, ' teammate')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/exactly one GitHub username/)).toBeTruthy()
  })

  it('keeps a GitHub save error inside the editor until it is dismissed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'PUT' ? new Response(JSON.stringify({ error: 'github_config_update_failed' }), { status: 500 }) : new Response(JSON.stringify({ allowedUsers: 'imleon' }), { status: 200 }),
        ),
      ),
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={authedSession} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText(/github_config_update_failed/)
      await act(async () => vi.advanceTimersByTime(5000))
      expect(screen.getByText(/github_config_update_failed/)).toBeTruthy()
      expect(document.querySelector('.settings-toast')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the public base URL input until sharing is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    const toggle = screen.getByRole('switch', { name: 'Enable sharing' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByLabelText('Public base URL')).toBeNull()

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const input = screen.getByLabelText('Public base URL')
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })

  it('switches sharing back off when the URL is left empty on blur', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: {} }), { status: 200 }))))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    const toggle = screen.getByRole('switch', { name: 'Enable sharing' })
    await userEvent.click(toggle)
    const input = screen.getByLabelText('Public base URL')
    await userEvent.click(input)
    await userEvent.tab() // blur with no input
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByLabelText('Public base URL')).toBeNull()
  })

  it('flags an invalid public base URL on blur without saving it', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: {} }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={baseSettings} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    const toggle = screen.getByRole('switch', { name: 'Enable sharing' })
    await userEvent.click(toggle)
    const input = screen.getByLabelText('Public base URL') as HTMLInputElement
    await userEvent.type(input, 'https://cotta.example.com/path')
    await userEvent.tab()

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/canonical http\(s\) origin/)).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('true') // stays on so the user can fix it
    expect(fetchMock).not.toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }))

    // Correcting the value clears the error and saves.
    await userEvent.clear(input)
    await userEvent.type(input, 'https://cotta.example.com')
    await userEvent.tab()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ settings: { publicBaseUrl: 'https://cotta.example.com' } }) })))
    expect(screen.queryByText(/canonical http\(s\) origin/)).toBeNull()
  })

  it('shows the URL pre-filled when a public base URL is already set', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={{ ...baseSettings, publicBaseUrl: 'https://cotta.example.com' }} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('switch', { name: 'Enable sharing' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('Public base URL') as HTMLInputElement).value).toBe('https://cotta.example.com')
  })

  it('clears the public base URL when sharing is turned off', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: {} }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPanel settings={{ ...baseSettings, publicBaseUrl: 'https://cotta.example.com' }} authSession={undefined} onLogout={vi.fn()} />
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('switch', { name: 'Enable sharing' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ settings: { publicBaseUrl: null } }) })))
    expect(screen.queryByLabelText('Public base URL')).toBeNull()
  })
})
