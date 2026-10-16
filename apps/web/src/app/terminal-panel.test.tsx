// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchProjectFile, ProjectFileHttpError } from '../api'
import { ExplorerPanel, type ProjectFileTabs } from './project-files'
import { TerminalPanel } from './terminal-panel'

const terminalMocks = vi.hoisted(() => ({
  terminals: [] as Array<{
    open: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onData: ReturnType<typeof vi.fn>
    cols: number
    rows: number
  }>,
  sockets: [] as Array<{
    url: string
    close: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    readyState: number
    onopen: (() => void) | null
    onmessage: ((event: MessageEvent) => void) | null
    onerror: (() => void) | null
    onclose: ((event: CloseEvent) => void) | null
  }>,
  fit: vi.fn(),
  resizeObservers: [] as Array<{ callback: ResizeObserverCallback }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    open = vi.fn()
    write = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() })
    constructor() {
      terminalMocks.terminals.push(this)
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = terminalMocks.fit
  },
}))

vi.mock('../api', () => ({
  fetchProjectFile: vi.fn().mockResolvedValue({ path: 'README.md', content: '# Demo\n', size: 7, revision: '1' }),
  fetchProjectFileDiff: vi.fn().mockResolvedValue({ kind: 'text', hunks: [], truncated: false }),
  fetchProjectFileImage: vi.fn(),
  fetchProjectFiles: vi.fn().mockResolvedValue({ path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }], truncated: false }),
  fetchProjectFilesGit: vi.fn().mockResolvedValue({ available: true, changes: [], truncated: false, branch: 'main', worktree: { path: '/repo/cotta-worktree', name: 'cotta-worktree' } }),
  ProjectFileHttpError: class ProjectFileHttpError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code)
    }
  },
}))

beforeEach(() => {
  terminalMocks.terminals.length = 0
  terminalMocks.sockets.length = 0
  terminalMocks.fit.mockClear()
  terminalMocks.resizeObservers.length = 0
  vi.mocked(fetchProjectFile).mockResolvedValue({ path: 'README.md', content: '# Demo\n', size: 7, revision: '1' })
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.EventSource = class EventSource {
    onmessage: ((event: MessageEvent) => void) | null = null
    close() {}
  } as unknown as typeof EventSource
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      terminalMocks.resizeObservers.push({ callback })
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.WebSocket = class WebSocket {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    readyState = WebSocket.OPEN
    binaryType = 'blob'
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    close = vi.fn(() => {
      this.readyState = WebSocket.CLOSED
    })
    send = vi.fn()
    constructor(readonly url: string) {
      terminalMocks.sockets.push(this)
    }
  } as unknown as typeof WebSocket
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: true, active: false }) }))
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

async function establishTerminal() {
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(terminalMocks.sockets).toHaveLength(0)
  await act(async () => {})
  act(() => terminalMocks.resizeObservers.at(-1)!.callback([{ contentRect: { width: 400, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver))
  return { socket: terminalMocks.sockets.at(-1)!, terminal: terminalMocks.terminals.at(-1)! }
}

function renderPane(openFiles: ProjectFileTabs, onOpenFilesChange = vi.fn(), currentCwd: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ExplorerPanel
        projectId="project"
        projectName="Project"
        currentCwd={currentCwd}
        openFiles={openFiles}
        onOpenFilesChange={onOpenFilesChange}
        previewWidth={null}
        onPreviewLayoutChange={vi.fn()}
        onFilesLayoutChange={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  )
  return onOpenFilesChange
}

describe('TerminalPanel', () => {
  it('uses the top-level terminal panel container', () => {
    render(<TerminalPanel onClose={vi.fn()} />)

    expect(screen.getByLabelText('Terminal').className).toContain('terminal-panel')
    expect(screen.getByLabelText('Terminal').id).toBe('terminal-panel')
  })

  it('opens idle and closes without terminating the terminal', async () => {
    const onClose = vi.fn()
    render(<TerminalPanel onClose={onClose} />)

    const connect = screen.getByRole('button', { name: 'Connect' })
    expect(connect).toBeTruthy()
    expect(screen.getByText('Sandboxed Terminal')).toBeTruthy()
    expect(screen.getByText('Checking Bubblewrap…')).toBeTruthy()
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
    expect(terminalMocks.sockets).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/terminal')
  })
})

describe('project file tabs', () => {
  it('exposes close as a separate button', async () => {
    const onOpenFilesChange = renderPane({ project: { tabs: [{ name: 'README.md', path: 'README.md', type: 'file' }], selectedPath: 'README.md' } })

    await userEvent.click(screen.getByRole('button', { name: 'Close README.md' }))

    expect(onOpenFilesChange).toHaveBeenCalledWith({ project: { tabs: [], selectedPath: null } })
  })

  it('clears stale deleted status after the file is restored', async () => {
    const onOpenFilesChange = renderPane({ project: { tabs: [{ name: 'README.md', path: 'README.md', type: 'file', gitStatus: 'deleted' }], selectedPath: 'README.md' } })

    await waitFor(() =>
      expect(onOpenFilesChange).toHaveBeenLastCalledWith({ project: { tabs: [{ name: 'README.md', path: 'README.md', type: 'file', gitStatus: undefined }], selectedPath: 'README.md' } }),
    )
  })

  it('clears stale deleted status when a binary file is restored', async () => {
    vi.mocked(fetchProjectFile).mockRejectedValueOnce(new ProjectFileHttpError(415, 'file_not_text'))
    const onOpenFilesChange = renderPane({ project: { tabs: [{ name: 'archive.zip', path: 'archive.zip', type: 'file', gitStatus: 'deleted' }], selectedPath: 'archive.zip' } })

    await waitFor(() =>
      expect(onOpenFilesChange).toHaveBeenLastCalledWith({ project: { tabs: [{ name: 'archive.zip', path: 'archive.zip', type: 'file', gitStatus: undefined }], selectedPath: 'archive.zip' } }),
    )
  })

  it('keeps Directory height non-negative in a short pane', async () => {
    renderPane({ project: { tabs: [], selectedPath: null } })
    const sections = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.project-file-sections')
      expect(element).toBeTruthy()
      return element!
    })
    vi.spyOn(sections, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect)
    const handle = screen.getByRole('separator', { name: 'Resize Directory and Changes' })
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })

    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 0 })

    expect(sections.style.getPropertyValue('--project-file-directory-height')).toBe('96px')
  })

  it('stops resizing Directory after pointer cancellation', async () => {
    renderPane({ project: { tabs: [], selectedPath: null } })
    const sections = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.project-file-sections')
      expect(element).toBeTruthy()
      return element!
    })
    vi.spyOn(sections, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 500 } as DOMRect)
    const handle = screen.getByRole('separator', { name: 'Resize Directory and Changes' })
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })

    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 200 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 })

    expect(sections.style.getPropertyValue('--project-file-directory-height')).toBe('200px')
  })

  it('shows the Explorer header and files context from git polling data', async () => {
    renderPane({ project: { tabs: [], selectedPath: null } })

    expect(screen.getByText('Explorer')).toBeTruthy()
    expect(await screen.findByLabelText('Branch: main')).toBeTruthy()
    expect(await screen.findByLabelText('Worktree: cotta-worktree')).toBeTruthy()
  })

  it('shows Bubblewrap as a warning when it is missing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ available: false, active: false }) } as Response)
    render(<TerminalPanel onClose={vi.fn()} />)

    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    const message = await screen.findByText(/Bubblewrap isn’t installed/)

    expect(screen.getByText('Bubblewrap required')).toBeTruthy()
    expect(message.getAttribute('data-tone')).toBeNull()
    expect(connect.disabled).toBe(true)
    await userEvent.click(connect)
    expect(terminalMocks.sockets).toHaveLength(0)
  })

  it.each([() => Promise.reject(new Error('offline')), () => Promise.resolve({ ok: false } as Response), () => Promise.resolve({ ok: true, json: async () => ({}) } as Response)])(
    'shows an error when Bubblewrap availability cannot be checked',
    async (response) => {
      vi.mocked(globalThis.fetch).mockImplementationOnce(response)
      render(<TerminalPanel onClose={vi.fn()} />)

      const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
      const message = await screen.findByText('We couldn’t check Bubblewrap. Reopen Terminal and try again.')

      expect(message.getAttribute('data-tone')).toBeNull()
      expect(connect.disabled).toBe(true)
      expect(terminalMocks.sockets).toHaveLength(0)
    },
  )

  it('connects Terminal, forwards input and resize, writes output, and cleans up', async () => {
    const onConnectedChange = vi.fn()
    render(<TerminalPanel onClose={vi.fn()} onConnectedChange={onConnectedChange} />)

    const { socket, terminal } = await establishTerminal()
    expect(socket.url).toBe(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`)
    const body = document.querySelector('.terminal-panel-header + .terminal-panel-body')
    expect(body?.querySelector('.terminal-panel-controls + .terminal-panel-screen')).toBeTruthy()
    act(() => socket.onopen?.())
    expect(onConnectedChange).toHaveBeenCalledWith(true)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))
    act(() => socket.onopen?.())
    expect(socket.send).toHaveBeenCalledTimes(1)
    act(() => terminal.onData.mock.calls[0][0]('pwd\r'))
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'pwd\r' }))
    act(() => socket.onmessage?.({ data: new Uint8Array([112, 119, 100]).buffer } as MessageEvent))
    expect(terminal.write).toHaveBeenCalledWith(new Uint8Array([112, 119, 100]))
    expect(screen.getByLabelText('Terminal input unfocused')).toBeTruthy()
    expect(document.querySelector('.terminal-panel-screen')?.getAttribute('data-input-focused')).toBe('false')

    const mount = document.querySelector('.terminal-panel-mount')!
    act(() => mount.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(screen.getByLabelText('Terminal input focused')).toBeTruthy()
    expect(document.querySelector('.terminal-panel-screen')?.getAttribute('data-input-focused')).toBe('true')

    act(() => mount.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(screen.getByLabelText('Terminal input unfocused')).toBeTruthy()
    expect(document.querySelector('.terminal-panel-screen')?.getAttribute('data-input-focused')).toBe('false')

    cleanup()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(onConnectedChange).not.toHaveBeenCalledWith(false)
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })

  it('ignores resize observer notifications for unchanged host dimensions', async () => {
    render(<TerminalPanel onClose={vi.fn()} />)
    const { socket } = await establishTerminal()
    act(() => socket.onopen?.())
    const fitCalls = terminalMocks.fit.mock.calls.length

    act(() => terminalMocks.resizeObservers.at(-1)!.callback([{ contentRect: { width: 400, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver))

    expect(terminalMocks.fit).toHaveBeenCalledTimes(fitCalls)
  })

  it('sends a resize after the host content box changes', async () => {
    render(<TerminalPanel onClose={vi.fn()} />)
    const { socket, terminal } = await establishTerminal()
    vi.useFakeTimers()
    try {
      act(() => socket.onopen?.())
      socket.send.mockClear()
      const fitCalls = terminalMocks.fit.mock.calls.length
      terminal.cols = 81

      act(() => terminalMocks.resizeObservers.at(-1)!.callback([{ contentRect: { width: 500, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver))
      act(() => vi.runAllTimers())

      expect(terminalMocks.fit).toHaveBeenCalledTimes(fitCalls + 1)
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 81, rows: 24 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live terminal connection while hidden', async () => {
    const onConnectedChange = vi.fn()
    const { rerender } = render(<TerminalPanel onClose={vi.fn()} onConnectedChange={onConnectedChange} />)
    const { socket, terminal } = await establishTerminal()
    act(() => socket.onopen?.())

    rerender(<TerminalPanel open={false} onClose={vi.fn()} onConnectedChange={onConnectedChange} />)

    expect(screen.getByLabelText('Terminal').hidden).toBe(true)
    expect(socket.close).not.toHaveBeenCalled()
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminalMocks.sockets).toHaveLength(1)

    rerender(<TerminalPanel open onClose={vi.fn()} onConnectedChange={onConnectedChange} />)

    expect(screen.getByLabelText('Terminal').hidden).toBe(false)
    expect(terminalMocks.sockets).toHaveLength(1)
    expect(onConnectedChange).toHaveBeenLastCalledWith(true)
  })

  it('terminates the global terminal and returns to Connect', async () => {
    const onClose = vi.fn()
    const onConnectedChange = vi.fn()
    render(<TerminalPanel onClose={onClose} onConnectedChange={onConnectedChange} />)
    const { socket } = await establishTerminal()
    act(() => socket.onopen?.())

    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/terminal', { method: 'DELETE' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
    expect(onConnectedChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('keeps Terminal open when termination fails', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true, active: false }) } as Response)
      .mockResolvedValueOnce({ ok: false } as Response)
    render(<TerminalPanel onClose={vi.fn()} />)
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    await waitFor(() => expect(connect.disabled).toBe(false))
    const { socket } = await establishTerminal()
    act(() => socket.onopen?.())

    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    expect(await screen.findByText('Could not terminate terminal.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Exit' })).toBeTruthy()
  })

  it('returns to Connect when the terminal exits', async () => {
    const onConnectedChange = vi.fn()
    render(<TerminalPanel onClose={vi.fn()} onConnectedChange={onConnectedChange} />)
    const { socket } = await establishTerminal()
    act(() => socket.onopen?.())

    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'exit', exitCode: 0 }) } as MessageEvent))

    expect(onConnectedChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('Terminal exited (0).')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('returns to Connect when another client terminates the terminal', async () => {
    const onConnectedChange = vi.fn()
    render(<TerminalPanel onClose={vi.fn()} onConnectedChange={onConnectedChange} />)
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    await waitFor(() => expect(connect.disabled).toBe(false))
    const { socket } = await establishTerminal()

    act(() => socket.onclose?.({ code: 1000, reason: 'terminal terminated' } as CloseEvent))

    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.getByText('Terminal exited.')).toBeTruthy()
    expect(onConnectedChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps the terminal connection error after disconnect', async () => {
    render(<TerminalPanel onClose={vi.fn()} />)
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    await waitFor(() => expect(connect.disabled).toBe(false))
    const { socket } = await establishTerminal()

    act(() => socket.onerror?.())

    const message = await screen.findByText('Terminal connection failed.')
    expect(screen.getByText('Terminal disconnected')).toBeTruthy()
    expect(message.getAttribute('data-tone')).toBeNull()
  })

  it('shows the server close reason after disconnect', async () => {
    render(<TerminalPanel onClose={vi.fn()} />)
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    await waitFor(() => expect(connect.disabled).toBe(false))
    const { socket } = await establishTerminal()

    act(() => socket.onclose?.({ code: 1011, reason: 'terminal unavailable' } as CloseEvent))

    expect(screen.getByText('terminal unavailable')).toBeTruthy()
  })

  it('ignores errors from a disposed terminal socket', async () => {
    render(<TerminalPanel onClose={vi.fn()} />)
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    await waitFor(() => expect(connect.disabled).toBe(false))
    const { socket } = await establishTerminal()

    cleanup()
    act(() => socket.onerror?.())

    expect(screen.queryByText('Terminal connection failed.')).toBeNull()
  })
})
