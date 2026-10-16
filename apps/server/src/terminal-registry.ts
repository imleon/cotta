import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { WebSocket } from 'ws'

const MAX_BUFFERED_BYTES = 1024 * 1024
const MAX_REPLAY_BYTES = 256 * 1024
const DETACHED_TTL_MS = 30 * 60 * 1000
const RESERVATION_TTL_MS = 10 * 1000
const DEFAULT_DIMENSIONS = { cols: 80, rows: 24 }

export type Pty = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export type PtyFactory = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => Pty

type TerminalRecord = {
  pty: Pty
  socket: WebSocket | null
  cols: number
  rows: number
  replay: Buffer
  detachedTimer: ReturnType<typeof setTimeout> | null
}

export function bubblewrapAvailable(): boolean {
  const result = spawnSync('bwrap', ['--version'], { shell: false, stdio: 'ignore' })
  return !result.error && result.status === 0
}

function bubblewrapArgs(home: string, shell: string): string[] {
  return [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/sbin',
    '/sbin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/etc/passwd',
    '/etc/passwd',
    '--ro-bind',
    '/etc/group',
    '/etc/group',
    '--ro-bind',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--ro-bind',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--ro-bind',
    '/etc/ssl/certs',
    '/etc/ssl/certs',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    home,
    home,
    '--chdir',
    home,
    '--',
    shell,
    '-i',
  ]
}

type TerminalAttachment = { existing: boolean; write(data: string): void; resize(cols: number, rows: number): void; detach(): void }

export class TerminalRegistry {
  private terminal: TerminalRecord | null = null
  private pendingSocket: WebSocket | null = null

  constructor(
    private readonly createPty: PtyFactory = (file, args, options) => pty.spawn(file, args, options),
    private readonly homeDirectory: () => string = homedir,
    private readonly isBubblewrapAvailable: () => boolean = bubblewrapAvailable,
  ) {}

  available(): boolean {
    return this.isBubblewrapAvailable()
  }

  reserve(socket: WebSocket): { attach(initialDimensions?: { cols: number; rows: number }): TerminalAttachment; detach(): void } {
    if (this.pendingSocket || this.terminal?.socket) throw new Error('terminal already connected')
    this.pendingSocket = socket
    let attachment: TerminalAttachment | undefined
    let expired = false
    const timeout = setTimeout(() => {
      if (this.pendingSocket !== socket) return
      expired = true
      this.pendingSocket = null
      socket.close(1008, 'terminal initialization timed out')
    }, RESERVATION_TTL_MS)
    timeout.unref()
    const detach = () => {
      clearTimeout(timeout)
      attachment?.detach()
      if (this.pendingSocket === socket) this.pendingSocket = null
    }
    socket.once('close', detach)
    return {
      attach: (initialDimensions = DEFAULT_DIMENSIONS) => {
        if (expired) throw new Error('terminal reservation expired')
        clearTimeout(timeout)
        attachment ??= this.attach(socket, initialDimensions)
        return attachment
      },
      detach,
    }
  }

  attach(socket: WebSocket, initialDimensions = DEFAULT_DIMENSIONS): TerminalAttachment {
    let record = this.terminal
    const existing = Boolean(record)
    if ((this.pendingSocket && this.pendingSocket !== socket) || record?.socket) throw new Error('terminal already connected')
    if (!record) {
      if (!this.available()) throw new Error('bubblewrap is unavailable')
      const cwd = this.homeDirectory()
      if (!statSync(cwd).isDirectory()) throw new Error(`terminal cwd is not a directory: ${cwd}`)
      const shell = process.env.SHELL || '/bin/sh'
      const pty = this.createPty('bwrap', bubblewrapArgs(cwd, shell), { cwd, env: { ...process.env, TERM: 'xterm-256color' }, ...initialDimensions })
      const created: TerminalRecord = { pty, socket: null, ...initialDimensions, replay: Buffer.alloc(0), detachedTimer: null }
      record = created
      this.terminal = created
      pty.onData((data) => this.sendOutput(created, data))
      pty.onExit(({ exitCode, signal }) => {
        if (this.terminal !== created) return
        created.socket?.send(JSON.stringify({ type: 'exit', exitCode, signal }))
        this.remove(created)
      })
    }
    if (record.detachedTimer) {
      clearTimeout(record.detachedTimer)
      record.detachedTimer = null
    }
    if (this.pendingSocket === socket) this.pendingSocket = null
    record.socket = socket
    if (existing && record.replay.byteLength > 0) socket.send(record.replay, { binary: true })
    let resized = false
    return {
      existing,
      write: (data) => {
        if (this.terminal === record && record.socket === socket) record.pty.write(data)
      },
      resize: (cols, rows) => {
        if (this.terminal !== record || record.socket !== socket || (resized && record.cols === cols && record.rows === rows)) return
        resized = true
        record.cols = cols
        record.rows = rows
        record.pty.resize(cols, rows)
      },
      detach: () => {
        if (this.terminal !== record || record.socket !== socket) return
        record.socket = null
        record.detachedTimer = setTimeout(() => this.terminate(), DETACHED_TTL_MS)
        record.detachedTimer.unref()
      },
    }
  }

  terminate(): boolean {
    const record = this.terminal
    const pendingSocket = this.pendingSocket
    if (!record && !pendingSocket) return false
    this.pendingSocket = null
    pendingSocket?.close(1000, 'terminal terminated')
    if (!record) return true
    record.socket?.close(1000, 'terminal terminated')
    this.remove(record)
    record.pty.kill()
    return true
  }

  close(): void {
    const record = this.terminal
    const pendingSocket = this.pendingSocket
    this.pendingSocket = null
    pendingSocket?.close(1001, 'server shutting down')
    if (!record) return
    record.socket?.close(1001, 'server shutting down')
    this.remove(record)
    record.pty.kill()
  }

  private remove(record: TerminalRecord): void {
    if (this.terminal !== record) return
    if (record.detachedTimer) clearTimeout(record.detachedTimer)
    record.detachedTimer = null
    record.socket = null
    this.terminal = null
  }

  private sendOutput(record: TerminalRecord, data: string): void {
    if (this.terminal !== record) return
    const bytes = Buffer.from(data)
    record.replay = Buffer.concat([record.replay, bytes]).subarray(Math.max(0, record.replay.byteLength + bytes.byteLength - MAX_REPLAY_BYTES))
    const socket = record.socket
    if (!socket) return
    if (socket.bufferedAmount + bytes.byteLength > MAX_BUFFERED_BYTES) {
      socket.close(1013, 'terminal output buffer exceeded')
      return
    }
    socket.send(bytes, { binary: true })
  }
}
