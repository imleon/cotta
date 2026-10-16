// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageOverview } from './usage-overview'

const response = {
  range: '30d',
  timeZone: 'UTC',
  totals: { totalTokens: 115, inputTokens: 80, outputTokens: 20, cacheReadTokens: 15, cacheHitRate: 0.1875, sessions: 2, userMessages: 5 },
}
const zeroDay = { uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 }
const calendarDays = 26 * 7
const dailyResponse = {
  days: calendarDays,
  timeZone: 'UTC',
  daily: Array.from({ length: calendarDays }, (_, index) => ({ ...zeroDay, date: new Date(Date.UTC(2026, 2, 3 + index)).toISOString().slice(0, 10) })),
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  callback: ResizeObserverCallback
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }
}

beforeEach(() => {
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderOverview(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <UsageOverview timeZone="Asia/Shanghai" />
    </QueryClientProvider>,
  )
}

describe('UsageOverview', () => {
  it('renders summary metrics in a fixed 26-column daily calendar', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    renderOverview()

    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('Total tokens')).toBeTruthy()
    expect(screen.getByRole('figure', { name: 'Daily activity' })).toBeTruthy()
    expect(screen.getByText('18.8%')).toBeTruthy()
    const calendar = screen.getByRole('grid', { name: 'Daily token usage calendar' })
    const lastDate = Date.parse(dailyResponse.daily.at(-1)!.date)
    const expectedCellCount = 25 * 7 + new Date(lastDate).getUTCDay() + 1
    const cells = calendar.querySelectorAll<HTMLElement>('[role="gridcell"]')
    expect(cells).toHaveLength(expectedCellCount)
    expect(calendar.getAttribute('aria-colcount')).toBe('26')
    expect(calendar.getAttribute('aria-rowcount')).toBe('7')
    expect(calendar.querySelectorAll('[role="row"]')).toHaveLength(7)
    expect(cells[0]?.parentElement?.getAttribute('role')).toBe('row')
    const tabStops = calendar.querySelectorAll<HTMLElement>('[tabindex="0"]')
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]?.dataset.date).toBe(dailyResponse.daily.at(-1)!.date)
    expect(tabStops[0]?.getAttribute('aria-label')).toContain('tokens')
    expect(tabStops[0]?.getAttribute('aria-colindex')).toBe('26')
    expect(tabStops[0]?.parentElement?.getAttribute('aria-rowindex')).toBe(String(new Date(lastDate).getUTCDay() + 1))
    expect(calendar.getAttribute('style')).toContain('--usage-weeks: 26')
    expect(calendar.getAttribute('style')).toContain('--usage-calendar-min-width: 388px')
    expect(calendar.getAttribute('style')).toContain('--usage-calendar-max-width: 596px')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/api/token-usage/daily?days=${calendarDays}&timeZone=Asia%2FShanghai`))).toBe(true)
  })

  it('keeps the newest edge pinned through resize without overriding manual scroll', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))),
    )
    renderOverview()

    const calendar = await screen.findByRole('grid', { name: 'Daily token usage calendar' })
    const scrollport = calendar.parentElement!
    Object.defineProperties(scrollport, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 600 },
    })
    const observer = ResizeObserverMock.instances.at(-1)!
    observer.callback([], observer as unknown as ResizeObserver)
    expect(scrollport.scrollLeft).toBe(300)

    fireEvent.pointerDown(scrollport)
    scrollport.scrollLeft = 100
    fireEvent.scroll(scrollport)
    scrollport.dispatchEvent(new Event('scrollend'))
    Object.defineProperty(scrollport, 'scrollWidth', { configurable: true, value: 700 })
    observer.callback([], observer as unknown as ResizeObserver)
    expect(scrollport.scrollLeft).toBe(100)
  })

  it('renders cell tooltips in the document overlay and keeps them inside the viewport', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    renderOverview()

    const cell = (await screen.findByRole('grid', { name: 'Daily token usage calendar' })).querySelector<HTMLElement>('[tabindex="0"]')!
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ x: 1, y: 1, top: 1, left: 1, right: 22, bottom: 14, width: 21, height: 13, toJSON: () => ({}) })
    fireEvent.focus(cell)

    const tooltip = await screen.findByText(/tokens$/, { selector: '.usage-cell-tooltip' })
    vi.spyOn(tooltip, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON: () => ({}) })
    fireEvent.scroll(window)
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.textContent).toContain(new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(Date.parse(cell.dataset.date!)))
    expect(tooltip.textContent).toContain('tokens')
    await waitFor(() => expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8))
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(20)

    fireEvent.blur(cell)
    await waitFor(() => expect(document.querySelector('.usage-cell-tooltip')).toBeNull())
  })

  it('closes a portal tooltip when its anchor leaves the scrollport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))),
    )
    renderOverview()

    const calendar = await screen.findByRole('grid', { name: 'Daily token usage calendar' })
    const scrollport = calendar.parentElement!
    const cell = calendar.querySelector<HTMLElement>('[tabindex="0"]')!
    vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 120, width: 300, height: 120, toJSON: () => ({}) })
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 20, top: 20, left: 100, right: 121, bottom: 33, width: 21, height: 13, toJSON: () => ({}) })
    fireEvent.mouseEnter(cell)
    expect(await screen.findByText(/tokens$/, { selector: '.usage-cell-tooltip' })).toBeTruthy()

    vi.mocked(cell.getBoundingClientRect).mockReturnValue({ x: -30, y: 20, top: 20, left: -30, right: -9, bottom: 33, width: 21, height: 13, toJSON: () => ({}) })
    fireEvent.scroll(scrollport)
    await waitFor(() => expect(document.querySelector('.usage-cell-tooltip')).toBeNull())
    expect(cell.hasAttribute('aria-describedby')).toBe(false)
  })

  it('keeps overlapping hover and focus tooltips until both interactions end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))),
    )
    renderOverview()

    const cells = (await screen.findByRole('grid', { name: 'Daily token usage calendar' })).querySelectorAll<HTMLElement>('.usage-heatmap-cell')
    const hovered = cells[0]!
    const focused = cells[1]!
    const visibleRect = { x: 100, y: 20, top: 20, left: 100, right: 121, bottom: 33, width: 21, height: 13, toJSON: () => ({}) }
    vi.spyOn(hovered, 'getBoundingClientRect').mockReturnValue(visibleRect)
    vi.spyOn(focused, 'getBoundingClientRect').mockReturnValue(visibleRect)
    fireEvent.mouseEnter(hovered)
    expect((await screen.findByText(/tokens$/, { selector: '.usage-cell-tooltip' })).textContent).toContain(hovered.dataset.date)

    fireEvent.focus(focused)
    expect(document.querySelector('.usage-cell-tooltip')?.textContent).toContain(focused.dataset.date)
    fireEvent.blur(focused)
    expect(document.querySelector('.usage-cell-tooltip')?.textContent).toContain(hovered.dataset.date)

    fireEvent.mouseLeave(hovered)
    await waitFor(() => expect(document.querySelector('.usage-cell-tooltip')).toBeNull())
  })

  it('uses one roving tab stop and moves focus by day and week', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))),
    )
    renderOverview()

    const calendar = await screen.findByRole('grid', { name: 'Daily token usage calendar' })
    const cells = [...calendar.querySelectorAll<HTMLElement>('.usage-heatmap-cell')].sort((left, right) => Number(left.dataset.cellIndex) - Number(right.dataset.cellIndex))
    const newest = cells.at(-1)
    if (!newest) throw new Error('Expected a newest activity cell')
    newest.focus()
    fireEvent.keyDown(newest, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(cells.at(-8))
    expect(calendar.querySelectorAll('[tabindex="0"]')).toHaveLength(1)

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cells.at(-9))
    const current = document.activeElement as HTMLElement
    const currentWeekday = new Date(`${current.dataset.date}T00:00:00Z`).getUTCDay()
    const currentRow = cells.filter((cell) => new Date(`${cell.dataset.date}T00:00:00Z`).getUTCDay() === currentWeekday)
    fireEvent.keyDown(current, { key: 'Home' })
    expect(document.activeElement).toBe(currentRow[0])
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(currentRow.at(-1))
    fireEvent.keyDown(document.activeElement!, { key: 'End', ctrlKey: true })
    expect(document.activeElement).toBe(newest)
  })

  it('clears the tooltip when the active cell is removed', async () => {
    const shortened = { ...dailyResponse, daily: dailyResponse.daily.slice(0, -1) }
    let dailyRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        if (url.includes('/daily?')) return Promise.resolve(new Response(JSON.stringify(++dailyRequests > 1 ? shortened : dailyResponse), { status: 200 }))
        return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }))
      }),
    )
    renderOverview()

    const cell = (await screen.findByRole('grid', { name: 'Daily token usage calendar' })).querySelector<HTMLElement>('[tabindex="0"]')!
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 20, top: 20, left: 100, right: 121, bottom: 33, width: 21, height: 13, toJSON: () => ({}) })
    fireEvent.focus(cell)
    expect(await screen.findByText(/tokens$/, { selector: '.usage-cell-tooltip' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))

    await waitFor(() => expect(document.querySelector('.usage-cell-tooltip')).toBeNull())
  })

  it('clears the tooltip when a refresh leaves the calendar in error', async () => {
    let dailyRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        if (url.includes('/daily?') && ++dailyRequests > 1) return Promise.resolve(new Response('failed', { status: 500 }))
        return Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))
      }),
    )
    renderOverview()

    const cell = (await screen.findByRole('grid', { name: 'Daily token usage calendar' })).querySelector<HTMLElement>('[tabindex="0"]')!
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 20, top: 20, left: 100, right: 121, bottom: 33, width: 21, height: 13, toJSON: () => ({}) })
    fireEvent.focus(cell)
    expect(await screen.findByText(/tokens$/, { selector: '.usage-cell-tooltip' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))

    await screen.findByText(/Failed to refresh activity/)
    expect(screen.getByRole('grid', { name: 'Daily token usage calendar' })).toBeTruthy()
    expect(document.querySelector('.usage-cell-tooltip')).toBeTruthy()
  })

  it('does not refetch cached usage when remounted within the same date and timezone', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = renderOverview(client)
    await screen.findByText('Total tokens')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    first.unmount()

    renderOverview(client)
    await screen.findByText('Total tokens')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('posts refresh before refetching summary and calendar and stays pending throughout', async () => {
    let resolveRefresh!: () => void
    const refreshPending = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return refreshPending.then(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderOverview()

    const refresh = await screen.findByRole('button', { name: 'Refresh usage' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await userEvent.click(refresh)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/token-usage/refresh', { method: 'POST' })
    expect(screen.getByRole('button', { name: 'Refreshing usage' }).hasAttribute('disabled')).toBe(true)
    resolveRefresh()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/daily?'))).toHaveLength(2)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh usage' }).hasAttribute('disabled')).toBe(false))
  })

  it('shows a refresh error and does not refetch GET queries when the POST fails', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response('failed', { status: 500 }))
      return Promise.resolve(new Response(JSON.stringify(url.includes('/daily?') ? dailyResponse : response), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderOverview()

    await userEvent.click(await screen.findByRole('button', { name: 'Refresh usage' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Refresh failed')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('changes only the summary range and offers retry after errors', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(url.includes('/daily?') ? new Response(JSON.stringify(dailyResponse), { status: 200 }) : new Response('failed', { status: 500 })))
    vi.stubGlobal('fetch', fetchMock)
    renderOverview()

    expect(await screen.findByRole('alert')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('range=7d'))).toBe(true))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/daily?'))).toHaveLength(1)
  })
})
