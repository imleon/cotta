import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliTransport } from './transport.js'

const transports: CliTransport[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()))
})

function fakeChild(options: ConstructorParameters<typeof CliTransport>[1] = {}) {
  const frames: Record<string, unknown>[] = []
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        frames.push(JSON.parse(chunk.toString()))
        callback()
      },
    }),
    kill: vi.fn(() => {
      child.emit('close', null, 'SIGTERM')
      return true
    }),
  })
  child.stdin.on('finish', () => child.emit('close', 0, null))
  const transport = new CliTransport(child, { closeGraceMs: 20, ...options })
  transports.push(transport)
  const receive = (frame: unknown) => child.stdout.push(`${JSON.stringify(frame)}\n`)
  const ack = (id: unknown, response: unknown = {}) => receive({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  return { child, transport, frames, receive, ack }
}

describe('CliTransport', () => {
  it('frames split UTF-8, coalesced lines and CRLF without dropping unknown events', async () => {
    const { transport, child } = fakeChild()
    const bytes = Buffer.from('{"type":"future","text":"中文"}\r\n{"type":"result"}\n')
    for (const byte of bytes) child.stdout.push(Buffer.from([byte]))
    const reader = transport[Symbol.asyncIterator]()
    expect((await reader.next()).value).toEqual({ type: 'future', text: '中文' })
    expect((await reader.next()).value).toEqual({ type: 'result' })
  })

  it('correlates out-of-order ACKs while business frames stay separate', async () => {
    const { transport, frames, ack, receive } = fakeChild()
    const first = transport.request({ subtype: 'initialize' })
    const second = transport.request({ subtype: 'interrupt' })
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    receive({ type: 'assistant', message: { content: [] } })
    ack(frames[1]?.request_id, { second: true })
    ack(frames[0]?.request_id, { first: true })
    await expect(first).resolves.toEqual({ first: true })
    await expect(second).resolves.toEqual({ second: true })
    expect((await transport[Symbol.asyncIterator]().next()).value.type).toBe('assistant')
  })

  it('does not block the reader on permissions; interrupt ACK does not cancel them', async () => {
    let signal!: AbortSignal
    let resolve!: (value: { behavior: 'allow'; toolUseID: string }) => void
    const canUseTool = vi.fn((_name, _input, options) => {
      signal = options.signal
      return new Promise<{ behavior: 'allow'; toolUseID: string }>((done) => {
        resolve = done
      })
    })
    const { transport, receive, frames, ack } = fakeChild({ canUseTool })
    receive({
      type: 'control_request',
      request_id: 'permission-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' }, tool_use_id: 'tool-1', title: 'Run', display_name: 'Shell', permission_suggestions: [] },
    })
    const interrupt = transport.request({ subtype: 'interrupt' })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    ack(frames[0]?.request_id)
    await interrupt
    expect(signal.aborted).toBe(false)
    resolve({ behavior: 'allow', toolUseID: 'tool-1' })
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames[1]).toMatchObject({ type: 'control_response', response: { request_id: 'permission-1', response: { behavior: 'allow', toolUseID: 'tool-1', updatedInput: { command: 'pwd' } } } })
    expect(canUseTool.mock.calls[0]?.[2]).toMatchObject({ requestId: 'permission-1', toolUseID: 'tool-1', title: 'Run', displayName: 'Shell' })
  })

  it('cancels exactly the matching permission and ignores its late completion', async () => {
    const signals: AbortSignal[] = []
    const resolvers: Array<(value: { behavior: 'deny'; message: string }) => void> = []
    const { receive, frames } = fakeChild({
      canUseTool: (_name, _input, options) => {
        signals.push(options.signal)
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })
    for (const id of ['first', 'second']) receive({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {}, tool_use_id: id } })
    receive({ type: 'control_cancel_request', request_id: 'first' })
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    for (const resolve of resolvers) resolve({ behavior: 'deny', message: 'done' })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames[0]).toMatchObject({ response: { request_id: 'second' } })
  })

  it('times out controls, sends cancellation and ignores late ACKs', async () => {
    const { transport, frames, ack } = fakeChild({ controlTimeoutMs: 10 })
    await expect(transport.request({ subtype: 'initialize' })).rejects.toThrow('timed out: initialize')
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames[1]).toEqual({ type: 'control_cancel_request', request_id: frames[0]?.request_id })
    ack(frames[0]?.request_id)
  })

  it.each([
    ['bad JSON', '{broken}\n'],
    ['invalid envelope', '{}\n'],
    ['oversize', `${JSON.stringify({ type: 'future', text: 'x'.repeat(100) })}\n`],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
  ])('fails explicitly on %s and settles controls', async (_name, payload) => {
    const { transport, child } = fakeChild({ maxFrameBytes: 80 })
    const request = transport.request({ subtype: 'x' })
    const rejected = expect(request).rejects.toThrow()
    const next = expect(transport[Symbol.asyncIterator]().next()).rejects.toThrow()
    child.stdout.push(payload)
    await rejected
    await next
  })

  it('delivers buffered terminal results before surfacing a subsequent process error', async () => {
    const { child, transport, receive } = fakeChild()
    receive({ type: 'result', subtype: 'error_during_execution' })
    child.emit('close', 1, null)
    const output = transport[Symbol.asyncIterator]()
    expect((await output.next()).value).toEqual({ type: 'result', subtype: 'error_during_execution' })
    await expect(output.next()).rejects.toThrow('exited (1)')
  })

  it('rejects incomplete EOF rather than dropping the final frame', async () => {
    const { child, transport } = fakeChild()
    child.stdout.push('{"type":"result"}')
    child.stdout.push(null)
    await expect(transport[Symbol.asyncIterator]().next()).rejects.toThrow('Incomplete')
  })

  it('serializes writes and waits for writable completion under backpressure', async () => {
    const { child, transport } = fakeChild()
    const callbacks: Array<() => void> = []
    const writes: string[] = []
    child.stdin = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString())
        callbacks.push(callback)
      },
    })
    child.stdin.on('finish', () => child.emit('close', 0, null))
    const first = transport.write({ type: 'one' })
    const second = transport.write({ type: 'two' })
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    callbacks.shift()?.()
    await first
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    callbacks.shift()?.()
    await second
  })

  it('drains a real fake child stderr, retains bounded redacted errors, and waits for exit', async () => {
    const child = spawn(process.execPath, ['-e', `process.stderr.write('x'.repeat(100000)+' secret-value'); process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(7),30));`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const transport = new CliTransport(child, { redactValues: ['secret-value'], closeGraceMs: 200 })
    transports.push(transport)
    const output = transport[Symbol.asyncIterator]().next()
    child.stdin.end()
    await expect(output).rejects.toThrow('[REDACTED]')
    await transport.closed
    expect(child.exitCode).toBe(7)
    await transport.close()
  })

  it('force-closes synchronously without resolving closed until the child closes', async () => {
    const { child, transport } = fakeChild()
    child.stdin.removeAllListeners('finish')
    vi.mocked(child.kill).mockImplementation(() => true)
    const closed = vi.fn()
    void transport.closed.then(closed)
    const closing = transport.close()
    try {
      transport.forceClose()
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      await Promise.resolve()
      expect(closed).not.toHaveBeenCalled()
      child.emit('exit', null, 'SIGKILL')
      child.emit('close', null, 'SIGKILL')
      await closing
      expect(closed).toHaveBeenCalledOnce()
    } finally {
      child.emit('close', null, 'SIGKILL')
    }
  })

  it('never signals a PID again after exit while stdio close is still pending', async () => {
    const { child, transport } = fakeChild({ processGroup: true, closeGraceMs: 10 })
    Object.assign(child, { pid: 987654321 })
    child.stdin.removeAllListeners('finish')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const closing = transport.close()
      child.emit('exit', 0, null)
      expect(kill).toHaveBeenCalledExactlyOnceWith(-987654321, 'SIGKILL')
      transport.forceClose()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(kill).toHaveBeenCalledTimes(1)
      child.emit('close', 0, null)
      await closing
      transport.forceClose()
      expect(kill).toHaveBeenCalledTimes(1)
    } finally {
      child.emit('close', 0, null)
      kill.mockRestore()
    }
  })

  it('waits for actual close and escalates termination when EOF is ignored', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const transport = new CliTransport(child, { closeGraceMs: 30 })
    transports.push(transport)
    await transport.close()
    expect(child.signalCode).toBe('SIGTERM')
  })

  it.skipIf(process.platform !== 'linux')('kills its remaining process-group tools after graceful CLI exit, without touching other groups', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});tool.unref();process.stdout.write(JSON.stringify({type:'tool_pid',pid:tool.pid})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    )
    const transport = new CliTransport(child, { processGroup: true, closeGraceMs: 100 })
    transports.push(transport)
    try {
      const pid = (await transport[Symbol.asyncIterator]().next()).value.pid as number
      await transport.close()
      await vi.waitFor(() => {
        let state: string
        try {
          state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] ?? ''
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        expect(state).toBe('Z')
      })
      expect(() => process.kill(other.pid!, 0)).not.toThrow()
    } finally {
      other.kill('SIGKILL')
    }
  })

  it('settles pending controls and permissions on spawn failure', async () => {
    const { child, transport, receive } = fakeChild({
      canUseTool: (_name, _input, options) => new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'closed' }))),
    })
    receive({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't' } })
    const request = expect(transport.request({ subtype: 'initialize' })).rejects.toThrow('Unable to run')
    child.emit('error', new Error('ENOENT'))
    await request
    await transport.close()
  })

  it('resolves close when spawn emits error without a follow-up close event', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }),
      kill: vi.fn(() => false),
    })
    const transport = new CliTransport(child, { closeGraceMs: 5_000 })
    const request = expect(transport.request({ subtype: 'initialize' })).rejects.toThrow('Unable to run')
    child.emit('error', new Error('ENOENT'))
    await request
    await transport.close()
  })

  it('allows valid multi-image user frames above 16 MiB within the composer body limit', async () => {
    const { transport, frames } = fakeChild()
    // Three 4.5 MiB images base64-encode to ~18 MiB, which passes request validation and must pass transport framing.
    const largeImageFrame = { type: 'user', payload: 'A'.repeat(18 * 1024 * 1024) }
    await expect(transport.write(largeImageFrame)).resolves.toBeUndefined()
    expect(frames).toHaveLength(1)
    await transport.close()
  })

  it('ends cleanly without failing if stdout hits EOF mid-frame during intentional close', async () => {
    const { child, transport } = fakeChild()
    child.stdin.removeAllListeners('finish')
    child.stdout.push('{"type":"assistant","partial":')
    const closing = transport.close()
    child.stdout.push(null)
    child.emit('close', null, 'SIGKILL')
    await closing
    await expect(transport[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
  })
})
