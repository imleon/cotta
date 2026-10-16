import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { type CottaAuth } from './auth.js'
import { type Pty, TerminalRegistry } from './terminal-registry.js'
import { attachTerminalWebSocket, parseTerminalOrigin } from './terminal-websocket.js'

const servers: import('node:http').Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function pty(): Pty {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }
}

async function start(
  origin: string | undefined,
  path = '/api/terminal',
  options: { terminalOrigin?: string; auth?: Pick<CottaAuth, 'terminalAuthorized'>; cookie?: string; available?: boolean } = {},
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
  attachTerminalWebSocket({
    server,
    auth: options.auth ?? { terminalAuthorized: () => true },
    registry,
    terminalOrigin: options.terminalOrigin,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as import('node:net').AddressInfo
  return await new Promise<{ code: number } | { client: WebSocket; pty: Pty; dimensions: () => { cols: number; rows: number } | undefined; port: number }>((resolve) => {
    const headers = { ...(origin ? { Origin: origin } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) }
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, Object.keys(headers).length ? { headers } : undefined)
    client.once('open', () => resolve({ client, pty: createdPty, dimensions: () => dimensions, port }))
    client.once('unexpected-response', (_request, response) => resolve({ code: response.statusCode ?? 0 }))
    client.once('error', () => {})
  })
}

describe('terminal websocket upgrade', () => {
  it('rejects upgrades without a loopback Origin before terminal creation', async () => {
    expect(await start(undefined)).toEqual({ code: 403 })
    expect(await start('http://example.com')).toEqual({ code: 403 })
  })

  it('accepts loopback IPv6 origins', async () => {
    const result = await start('http://[::1]:5173')
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    result.client.close()
  })

  it('closes cleanly when terminal creation fails after initial resize', async () => {
    const result = await start('http://localhost:5173', undefined, { available: false })
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    const close = new Promise<{ code: number; reason: Buffer }>((resolve) => result.client.once('close', (code, reason) => resolve({ code, reason })))
    result.client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    expect(await close).toEqual({ code: 1011, reason: Buffer.from('terminal unavailable') })
  })

  it('accepts only the configured canonical remote origin with signed-cookie auth', async () => {
    const auth = { terminalAuthorized: vi.fn((cookie) => cookie === 'cotta_session=signed') }
    const options = { terminalOrigin: 'https://terminal.example.com', auth, cookie: 'cotta_session=signed' }
    expect(await start('http://localhost:5173', undefined, options)).toEqual({ code: 403 })
    const accepted = await start('https://terminal.example.com', undefined, options)
    if (!('client' in accepted)) throw new Error('terminal upgrade was rejected')
    accepted.client.close()
    expect(await start('https://terminal.example.com/', undefined, options)).toEqual({ code: 403 })
    expect(await start('https://terminal.example.com:443', undefined, options)).toEqual({ code: 403 })
    expect(await start('https://other.example.com', undefined, options)).toEqual({ code: 403 })
    expect(await start('https://terminal.example.com', undefined, { ...options, cookie: 'cotta_session=invalid' })).toEqual({ code: 401 })
  })

  it('strictly validates configured terminal origins', () => {
    expect(parseTerminalOrigin(undefined)).toBeUndefined()
    expect(parseTerminalOrigin('https://terminal.example.com')).toBe('https://terminal.example.com')
    for (const value of ['ftp://terminal.example.com', 'https://terminal.example.com/', 'https://user@terminal.example.com', 'https://terminal.example.com?x=1', 'https://terminal.example.com#x']) {
      expect(() => parseTerminalOrigin(value)).toThrow('COTTA_TERMINAL_ORIGIN must be a canonical http(s) origin')
    }
  })

  it('rejects project terminal paths', async () => {
    expect(await start('http://localhost:5173', '/api/projects/project/terminal')).toEqual({ code: 404 })
  })

  it('creates the PTY only from the first browser resize', async () => {
    const result = await start('http://localhost:5173')
    if (!('client' in result)) throw new Error('terminal upgrade was rejected')
    expect(result.dimensions()).toBeUndefined()

    result.client.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await vi.waitFor(() => expect(result.dimensions()).toEqual({ cols: 120, rows: 40 }))
    result.client.close()
  })

  it('rejects a second upgraded socket before either socket creates a PTY', async () => {
    const first = await start('http://localhost:5173')
    if (!('client' in first)) throw new Error('terminal upgrade was rejected')
    const second = new WebSocket(`ws://127.0.0.1:${first.port}/api/terminal`, { headers: { Origin: 'http://localhost:5173' } })
    second.once('error', () => {})
    const close = new Promise<{ code: number; reason: Buffer }>((resolve) => second.once('close', (code, reason) => resolve({ code, reason })))

    expect(await close).toEqual({ code: 1008, reason: Buffer.from('terminal already connected') })
    expect(first.dimensions()).toBeUndefined()
    first.client.close()
  })

  it('accepts browser text frames for terminal input and resize', async () => {
    const result = await start('http://localhost:5173')
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
