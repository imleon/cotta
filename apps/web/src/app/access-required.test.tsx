// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessRequired } from './access-required'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AccessRequired', () => {
  it('keeps the copied indicator for the full window after the latest click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ flowId: 'flow-1', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 60 }))),
    )
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccessRequired />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }))
    const codeButton = await screen.findByRole('button', { name: /ABCD-EFGH/ })

    vi.useFakeTimers()
    await act(async () => fireEvent.click(codeButton))
    expect(screen.getByRole('img', { name: 'Copied' })).toBeTruthy()

    await act(async () => vi.advanceTimersByTime(1000))
    await act(async () => fireEvent.click(codeButton))

    // The first click's timer would have fired here; the second click must reset it.
    await act(async () => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('img', { name: 'Copied' })).toBeTruthy()

    await act(async () => vi.advanceTimersByTime(600))
    expect(screen.getByRole('img', { name: 'Copy' })).toBeTruthy()
  })

  it('explains a forbidden account and lets the user start again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/poll')
          ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
          : new Response(JSON.stringify({ flowId: 'flow-1', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 0 })),
      ),
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccessRequired />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }))
    expect(await screen.findByText('This GitHub account is not the allowed Cotta user.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy()
  })
})
