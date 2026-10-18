import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { CottaAuth } from './auth.js'
import { type Pty, TerminalRegistry } from './terminal-registry.js'
import { attachTerminalWebSocket, isAllowedTerminalOrigin } from './terminal-websocket.js'

const servers: import('node:http').Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function pty(): Pty {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }
}

/**
 * Starts a terminal WS server and attempts an upgrade.
 * `origin`: the browser Origin header. `undefined` (default) means "same host as the request", which the
 * CSWSH gate accepts — so business-logic tests don't need to care about it. Pass a string to simulate a
 * cross-origin page. `options.host` / `options.xForwardedHost` override the Host the server sees.
 */
async function start(
  origin?: string | null,
  path = '/api/terminal',
  options: { host?: string; xForwardedHost?: string; auth?: Pick<CottaAuth, 'terminalAuthorized'>; cookie?: string; available?: boolean } = {},
) {
  const server = createServer()
  servers.push(server)
  const createdPty = pty()
  let dimensions: { cols: number; rows: number } | undefined
  const registry = new TerminalRegistry(
    (_file, _args, ptyOptions) => {
      dimensions = { cols: ptyOptions.cols, rows: ptyOptions.rows }
      return createdPty
    },
    () => process.cwd(),
    () => options.available ?? true,
  )
  attachTerminalWebSocket({ server, auth: options.auth ?? { terminalAuthorized: () => true }, registry })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as import('node:net').AddressInfo
  // Default: the Origin's host matches the request Host, i.e. a same-origin (legitimate) page.
  const effectiveOrigin = origin === null ? undefined : (origin ?? `http://127.0.0.1:${port}`)
  return await new Promise<{ code: number } | { client: WebSocket; pty: Pty; dimensions: () => { cols: number; rows: number } | undefined; port: number }>((resolve) => {
    const headers = {
      ...(effectiveOrigin ? { Origin: effectiveOrigin } : {}),
      ...(options.host ? { Host: options.host } : {}),
      ...(options.xForwardedHost ? { 'X-Forwarded-Host': options.xForwardedHost } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    }
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, Object.keys(headers).length ? { headers } : undefined)
    client.once('open', () => resolve({ client, pty: createdPty, dimensions: () => dimensions, port }))
    client.once('unexpected-response', (_request, response) => resolve({ code: response.statusCode ?? 0 }))
    client.once('error', () => {})
  })
}

describe('isAllowedTerminalOrigin', () => {
  it('accepts only when the Origin host matches the request host', () => {
    expect(isAllowedTerminalOrigin('https://cotta.example.com', 'cotta.example.com')).toBe(true)
    expect(isAllowedTerminalOrigin('http://localhost:5173', 'localhost:5173')).toBe(true)
    // Cross-origin: a page served elsewhere connecting to this host.
    expect(isAllowedTerminalOrigin('https://evil.example.com', 'cotta.example.com')).toBe(false)
    // Port must match (part of host).
    expect(isAllowedTerminalOrigin('http://localhost:5173', 'localhost:5174')).toBe(false)
    expect(isAllowedTerminalOrigin('https://cotta.example.com:443', 'cotta.example.com')).toBe(false)
  })

  it('fails closed on missing or malformed Origin / host', () => {
    expect(isAllowedTerminalOrigin(undefined, 'cotta.example.com')).toBe(false)
    expect(isAllowedTerminalOrigin('https://cotta.example.com', undefined)).toBe(false)
    expect(isAllowedTerminalOrigin('not-a-url', 'cotta.example.com')).toBe(false)
    expect(isAllowedTerminalOrigin('https://cotta.example.com/path', 'cotta.example.com')).toBe(false)
  })
})

describe('terminal websocket upgrade', () => {
  it('rejects upgrades without an Origin, or whose Origin host differs from the request host', async () => {
    expect(await start(null)).toEqual({ code: 403 })
    expect(await start('http://example.com')).toEqual({ code: 403 })
  })

  it('accepts a same-origin page (Origin host matches Host) with signed-cookie auth', async () => {
    const auth = { terminalAuthorized: vi.fn((cookie) => cookie === 'cotta_session=signed') }
    const accepted = await start(undefined, undefined, { auth, cookie: 'cotta_session=signed' })
    if (!('client' in accepted)) throw new Error('terminal upgrade was rejected')
    accepted.client.close()
    expect(await start(undefined, undefined, { auth, cookie: 'cotta_session=invalid' })).toEqual({ code: 401 })
  })

  it('matches the Origin against X-Forwarded-Host when a reverse proxy sets it', async () => {
    // Behind a proxy, the browser-facing host is cotta.example.com; the Origin must match that, not the loopback Host.
    const proxied = { host: '127.0.0.1:9999', xForwardedHost: 'cotta.example.com' }
    const accepted = await start('https://cotta.example.com', undefined, proxied)
    if (!('client' in accepted)) throw new Error('terminal upgrade was rejected behind proxy')
    accepted.client.close()
    // An Origin matching only the internal Host (not the forwarded host) is rejected.
    expect(await start('http://127.0.0.1:9999', undefined, proxied)).toEqual({ code: 403 })
  })

  it('closes cleanly when terminal creation fails after initial resize', async () => {
    const result = await start(undefined, undefined, { available: false })
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    const close = new Promise<{ code: number; reason: Buffer }>((resolve) => result.client.once('close', (code, reason) => resolve({ code, reason })))
    result.client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    expect(await close).toEqual({ code: 1011, reason: Buffer.from('terminal unavailable') })
  })

  it('rejects project terminal paths', async () => {
    expect(await start(undefined, '/api/projects/project/terminal')).toEqual({ code: 404 })
  })

  it('creates the PTY only from the first browser resize', async () => {
    const result = await start()
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    expect(result.dimensions()).toBeUndefined()

    result.client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await vi.waitFor(() => expect(result.dimensions()).toEqual({ cols: 120, rows: 40 }))
    result.client.close()
  })

  it('rejects a second upgraded socket before either socket creates a PTY', async () => {
    const first = await start()
    if (!('client' in first)) throw new Error('terminal upgrade was rejected')
    const second = new WebSocket(`ws://127.0.0.1:${first.port}/api/terminal`, { headers: { Origin: `http://127.0.0.1:${first.port}` } })
    second.once('error', () => {})
    const close = new Promise<{ code: number; reason: Buffer }>((resolve) => second.once('close', (code, reason) => resolve({ code, reason })))

    expect(await close).toEqual({ code: 1008, reason: Buffer.from('terminal already connected') })
    expect(first.dimensions()).toBeUndefined()
    first.client.close()
  })

  it('accepts browser text frames for terminal input and resize', async () => {
    const result = await start()
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    result.client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await vi.waitFor(() => expect(result.dimensions()).toEqual({ cols: 120, rows: 40 }))
    result.client.send(JSON.stringify({ type: 'input', data: 'pwd\n' }))
    result.client.send(JSON.stringify({ type: 'resize', cols: 121, rows: 41 }))
    await vi.waitFor(() => {
      expect(result.pty.write).toHaveBeenCalledWith('pwd\n')
      expect(result.pty.resize).toHaveBeenCalledWith(121, 41)
    })
    result.client.close()
  })
})
