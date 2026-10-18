import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { WebSocketServer } from 'ws'
import type { CottaAuth } from './auth.js'
import type { TerminalRegistry } from './terminal-registry.js'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_COLS = 1000
const MAX_ROWS = 1000

function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address
  return isIP(ipv4) === 4 && ipv4.split('.')[0] === '127'
}

export function parseTerminalOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const origin = new URL(value)
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.origin !== value || origin.username || origin.password || origin.search || origin.hash) throw new Error()
    return value
  } catch {
    throw new Error('terminal origin must be a canonical http(s) origin')
  }
}

/** First comma token of a possibly-list-valued forwarded header, trimmed. */
function firstHeaderToken(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || undefined
}

/**
 * Same-origin WebSocket gate (CSWSH defense). A legitimate page is served by this host, so its browser-set
 * Origin header's host matches the request's own Host. A cross-site page's Origin host never will. We compare
 * the Origin's host against the request host (X-Forwarded-Host when a reverse proxy sets it, else Host) — no
 * configured origin needed. Missing/malformed Origin or host fails closed.
 */
export function isAllowedTerminalOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin || !requestHost) return false
  try {
    const canonical = parseTerminalOrigin(origin)
    return !!canonical && new URL(canonical).host === requestHost
  } catch {
    return false
  }
}

function reject(socket: import('node:stream').Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

type TerminalDimensions = { cols: number; rows: number }

function dimensions(value: unknown): value is TerminalDimensions {
  if (!value || typeof value !== 'object') return false
  const { cols, rows } = value as { cols?: unknown; rows?: unknown }
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    cols <= MAX_COLS &&
    rows >= 1 &&
    rows <= MAX_ROWS
  )
}

export function attachTerminalWebSocket(input: { server: import('node:http').Server; auth: Pick<CottaAuth, 'terminalAuthorized'>; registry: TerminalRegistry }): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES })
  input.server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head)
  })

  async function upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    if (request.method !== 'GET') return reject(socket, 405, 'Method Not Allowed')
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/terminal') return reject(socket, 404, 'Not Found')
    if (!isLoopback((socket as import('node:net').Socket).remoteAddress)) return reject(socket, 403, 'Forbidden')
    const requestHost = firstHeaderToken(request.headers['x-forwarded-host']) ?? request.headers.host
    if (!isAllowedTerminalOrigin(request.headers.origin, requestHost)) return reject(socket, 403, 'Forbidden')
    if (!input.auth.terminalAuthorized(request.headers.cookie)) return reject(socket, 401, 'Unauthorized')
    wss.handleUpgrade(request, socket, head, (websocket) => {
      let reservation: ReturnType<TerminalRegistry['reserve']>
      try {
        reservation = input.registry.reserve(websocket)
      } catch (error) {
        return websocket.close(
          error instanceof Error && error.message === 'terminal already connected' ? 1008 : 1011,
          error instanceof Error && error.message === 'terminal already connected' ? error.message : 'terminal unavailable',
        )
      }
      let terminal: ReturnType<TerminalRegistry['attach']> | undefined
      // ws emits 'error' (e.g. RangeError on a frame exceeding maxPayload); an unhandled 'error' event crashes the process.
      websocket.on('error', () => websocket.close(1011, 'terminal error'))
      websocket.on('message', (data, isBinary) => {
        if (isBinary) return websocket.close(1003, 'invalid terminal message')
        const text = Buffer.isBuffer(data) ? data.toString() : Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data).toString()
        try {
          const message: unknown = JSON.parse(text)
          if (!message || typeof message !== 'object') throw new Error()
          if ((message as { type?: unknown }).type === 'resize' && dimensions(message)) {
            if (terminal) return terminal.resize(message.cols, message.rows)
            try {
              terminal = reservation.attach(message)
              return
            } catch {
              return websocket.close(1011, 'terminal unavailable')
            }
          }
          if ((message as { type?: unknown }).type === 'input' && typeof (message as { data?: unknown }).data === 'string' && terminal) return terminal.write((message as { data: string }).data)
        } catch {}
        websocket.close(1003, 'invalid terminal message')
      })
    })
  }
}
