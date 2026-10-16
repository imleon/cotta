import { describe, expect, it, vi } from 'vitest'
import { type Pty, TerminalRegistry } from './terminal-registry.js'

function fakePty() {
  let data = (_value: string) => {}
  let exit = (_value: { exitCode: number; signal?: number }) => {}
  return {
    pty: {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(listener) {
        data = listener
        return { dispose() {} }
      },
      onExit(listener) {
        exit = listener
        return { dispose() {} }
      },
    } satisfies Pty,
    data: (value: string) => data(value),
    exit: (value: { exitCode: number; signal?: number }) => exit(value),
  }
}

function socket() {
  let onClose: (() => void) | undefined
  return {
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    once: vi.fn((_event: string, listener: () => void) => {
      onClose = listener
    }),
    emitClose: () => onClose?.(),
  } as unknown as import('ws').WebSocket & { emitClose(): void }
}

describe('TerminalRegistry', () => {
  it('uses one sandboxed home-directory PTY, forwards input and resize, rejects a second socket, and closes it', () => {
    const ptyProcess = fakePty()
    const create = vi.fn(() => ptyProcess.pty)
    const registry = new TerminalRegistry(
      create,
      () => process.cwd(),
      () => true,
    )
    const first = socket()
    const terminal = registry.attach(first, { cols: 120, rows: 40 })
    terminal.write('pwd\n')
    terminal.resize(120, 40)
    terminal.resize(120, 40)
    ptyProcess.data('output')
    const second = socket()
    expect(() => registry.attach(second)).toThrow('terminal already connected')
    registry.close()

    expect(terminal.existing).toBe(false)
    expect(create).toHaveBeenCalledWith(
      'bwrap',
      expect.arrayContaining([
        '--unshare-all',
        '--share-net',
        '--die-with-parent',
        '--new-session',
        '--bind',
        process.cwd(),
        process.cwd(),
        '--chdir',
        process.cwd(),
        '--',
        process.env.SHELL || '/bin/sh',
        '-i',
      ]),
      expect.objectContaining({ cwd: process.cwd(), cols: 120, rows: 40 }),
    )
    expect(ptyProcess.pty.write).toHaveBeenCalledWith('pwd\n')
    expect(ptyProcess.pty.resize).toHaveBeenCalledTimes(1)
    expect(ptyProcess.pty.resize).toHaveBeenCalledWith(120, 40)
    expect(first.send).toHaveBeenCalledWith(Buffer.from('output'), { binary: true })
    expect(second.send).not.toHaveBeenCalled()
    expect(first.close).toHaveBeenCalledWith(1001, 'server shutting down')
    expect(ptyProcess.pty.kill).toHaveBeenCalledTimes(1)
  })

  it('releases pending socket reservations on socket close, terminate, and server close', () => {
    const create = vi.fn(() => fakePty().pty)
    const registry = new TerminalRegistry(
      create,
      () => process.cwd(),
      () => true,
    )
    const first = socket()
    registry.reserve(first)
    expect(() => registry.reserve(socket())).toThrow('terminal already connected')

    first.emitClose()
    const second = socket()
    registry.reserve(second)
    expect(registry.terminate()).toBe(true)
    expect(second.close).toHaveBeenCalledWith(1000, 'terminal terminated')

    const third = socket()
    registry.reserve(third)
    registry.close()
    expect(third.close).toHaveBeenCalledWith(1001, 'server shutting down')
    expect(create).not.toHaveBeenCalled()
  })

  it('expires socket reservations that never attach', () => {
    vi.useFakeTimers()
    try {
      const registry = new TerminalRegistry(
        () => fakePty().pty,
        () => process.cwd(),
        () => true,
      )
      const first = socket()
      registry.reserve(first)

      vi.advanceTimersByTime(10 * 1000)

      expect(first.close).toHaveBeenCalledWith(1008, 'terminal initialization timed out')
      expect(() => registry.reserve(socket())).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces the first resize from every attachment and expires detached terminals', () => {
    vi.useFakeTimers()
    const ptyProcess = fakePty()
    const create = vi.fn(() => ptyProcess.pty)
    const registry = new TerminalRegistry(
      create,
      () => process.cwd(),
      () => true,
    )
    const first = registry.attach(socket())
    first.resize(80, 24)
    first.detach()
    const second = registry.attach(socket(), { cols: 120, rows: 40 })
    second.resize(80, 24)
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(create).toHaveBeenCalledOnce()
    expect(ptyProcess.pty.resize).toHaveBeenCalledTimes(2)
    expect(ptyProcess.pty.kill).not.toHaveBeenCalled()

    second.detach()
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(ptyProcess.pty.kill).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores late output from a terminated PTY after a replacement attaches', () => {
    const oldPty = fakePty()
    const newPty = fakePty()
    const create = vi.fn().mockReturnValueOnce(oldPty.pty).mockReturnValueOnce(newPty.pty)
    const registry = new TerminalRegistry(
      create,
      () => process.cwd(),
      () => true,
    )
    const oldSocket = socket()
    registry.attach(oldSocket)
    registry.terminate()
    const newSocket = socket()
    registry.attach(newSocket)

    oldPty.data('late output')
    newPty.data('current output')

    expect(newSocket.send).toHaveBeenCalledTimes(1)
    expect(newSocket.send).toHaveBeenCalledWith(Buffer.from('current output'), { binary: true })
  })

  it('closes before output would exceed the buffered limit', () => {
    const ptyProcess = fakePty()
    const registry = new TerminalRegistry(
      () => ptyProcess.pty,
      () => process.cwd(),
      () => true,
    )
    const client = socket()
    Object.defineProperty(client, 'bufferedAmount', { value: 1024 * 1024 - 1 })
    registry.attach(client)

    ptyProcess.data('ab')

    expect(client.close).toHaveBeenCalledWith(1013, 'terminal output buffer exceeded')
    expect(client.send).not.toHaveBeenCalled()
  })

  it('reports bubblewrap availability and rejects terminal creation without it', () => {
    const available = vi.fn(() => false)
    const registry = new TerminalRegistry(
      () => fakePty().pty,
      () => process.cwd(),
      available,
    )

    expect(registry.available()).toBe(false)
    expect(() => registry.attach(socket())).toThrow('bubblewrap is unavailable')
    expect(available).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-directory home directory', () => {
    const registry = new TerminalRegistry(
      () => fakePty().pty,
      () => '/dev/null',
      () => true,
    )
    expect(() => registry.attach(socket())).toThrow('terminal cwd is not a directory: /dev/null')
  })

  it('terminates once after the PTY exits', () => {
    const ptyProcess = fakePty()
    const registry = new TerminalRegistry(
      () => ptyProcess.pty,
      () => process.cwd(),
      () => true,
    )
    const client = socket()
    registry.attach(client)

    ptyProcess.exit({ exitCode: 7, signal: 9 })
    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: 'exit', exitCode: 7, signal: 9 }))
    expect(registry.terminate()).toBe(false)
  })
})
