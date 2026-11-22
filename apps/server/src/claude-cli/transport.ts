import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { COMPOSER_TURN_BODY_MAX_BYTES } from '@cotta/shared'
import type { CanUseToolOptions, PermissionResult, PermissionUpdate, SDKMessage } from './types.js'

// Must exceed COMPOSER_TURN_BODY_MAX_BYTES (20 MiB decoded images -> ~26.7 MiB base64 + JSON envelope).
const MAX_FRAME_BYTES = COMPOSER_TURN_BODY_MAX_BYTES + 2 * 1024 * 1024
const MAX_STDERR_CHARS = 8_192
const CONTROL_TIMEOUT_MS = 30_000

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type TransportOptions = {
  canUseTool?: (name: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult>
  controlTimeoutMs?: number
  closeGraceMs?: number
  maxFrameBytes?: number
  redactValues?: string[]
  processGroup?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** One reader owns stdout for the lifetime of the child, including initialization. */
export class CliTransport implements AsyncIterable<SDKMessage> {
  private readonly pending = new Map<string, Pending>()
  private readonly callbacks = new Map<string, AbortController>()
  private readonly messages: SDKMessage[] = []
  private readonly waiters: Array<{ resolve: (value: IteratorResult<SDKMessage>) => void; reject: (error: Error) => void }> = []
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private frame = ''
  private stderr = ''
  private failure: Error | null = null
  private writeTail: Promise<void> = Promise.resolve()
  private closing: Promise<void> | null = null
  private exited = false
  private childExited = false
  readonly closed: Promise<void>

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly options: TransportOptions = {},
  ) {
    let resolveClosed!: () => void
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve
    })
    const finishClosed = () => {
      this.exited = true
      this.rejectPending(new Error('Claude Code CLI exited.'))
      this.abortCallbacks()
      this.flushWaiters()
      resolveClosed()
    }
    child.once('close', (code, signal) => {
      if (!this.closing && !this.failure && (code !== 0 || signal)) this.fail(new Error(`Claude Code CLI exited (${signal ?? code}).${this.stderr ? ` ${this.safe(this.stderr)}` : ''}`))
      finishClosed()
    })
    // A detached group belongs exclusively to this runtime. Reap its tools even
    // when the CLI exits gracefully and descendants no longer hold its stdio.
    child.once('exit', () => {
      this.childExited = true
      if (this.options.processGroup) this.signalProcessGroup('SIGKILL')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.failure) return
      try {
        this.frame += this.decoder.decode(chunk, { stream: true })
        let newline = this.frame.indexOf('\n')
        while (newline !== -1) {
          const line = this.frame.slice(0, newline).replace(/\r$/, '')
          this.frame = this.frame.slice(newline + 1)
          this.checkFrameSize(line)
          if (!line) throw new Error('Empty Claude Code CLI protocol frame.')
          this.receive(JSON.parse(line))
          newline = this.frame.indexOf('\n')
        }
        this.checkFrameSize(this.frame)
      } catch (error) {
        this.fail(new Error(`Invalid Claude Code CLI stream: ${error instanceof SyntaxError ? 'malformed JSON' : this.safe(String(error))}`))
      }
    })
    child.stdout.on('end', () => {
      if (this.failure || this.closing) return
      try {
        this.frame += this.decoder.decode()
        if (this.frame.length) throw new Error('Incomplete Claude Code CLI frame at EOF.')
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS)
    })
    child.stdout.on('error', (error) => this.fail(new Error(`Claude Code CLI stdout failed: ${this.safe(error.message)}`)))
    child.stderr.on('error', (error) => this.fail(new Error(`Claude Code CLI stderr failed: ${this.safe(error.message)}`)))
    child.stdin.on('error', (error) => {
      if (!this.closing) this.fail(new Error(`Claude Code CLI stdin failed: ${this.safe(error.message)}`))
    })
    child.once('error', (error) => {
      this.fail(new Error(`Unable to run Claude Code CLI: ${this.safe(error.message)}`))
      if (child.pid === undefined) finishClosed()
    })
  }

  private safe(text: string): string {
    for (const value of this.options.redactValues ?? []) if (value.length > 3) text = text.split(value).join('[REDACTED]')
    return text.replace(/(?:Bearer\s+|sk-ant-)[^\s"\\]+/gi, '[REDACTED]').slice(-MAX_STDERR_CHARS)
  }
  private checkFrameSize(frame: string): void {
    if (Buffer.byteLength(frame) > (this.options.maxFrameBytes ?? MAX_FRAME_BYTES)) throw new Error('Claude Code CLI protocol frame exceeds the size limit.')
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  private abortCallbacks(): void {
    for (const callback of this.callbacks.values()) callback.abort()
    this.callbacks.clear()
  }
  private flushWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure)
      else waiter.resolve({ done: true, value: undefined })
    }
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.rejectPending(error)
    this.abortCallbacks()
    this.flushWaiters()
    void this.close()
  }

  write(value: Record<string, unknown>): Promise<void> {
    if (this.failure || this.closing || this.exited) return Promise.reject(this.failure ?? new Error('Claude Code CLI transport is closed.'))
    let line: string
    try {
      line = `${JSON.stringify(value)}\n`
      this.checkFrameSize(line)
    } catch (error) {
      return Promise.reject(error)
    }
    // Waiting for the write callback bounds outstanding data and honors writable backpressure.
    const writing = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.failure || this.exited) return reject(this.failure ?? new Error('Claude Code CLI exited.'))
          this.child.stdin.write(line, (error) => (error ? reject(new Error(`Claude Code CLI write failed: ${this.safe(error.message)}`)) : resolve()))
        }),
    )
    this.writeTail = writing.catch((error: Error) => {
      if (!this.closing) this.fail(error)
    })
    return writing
  }

  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failure || this.closing || this.exited) return Promise.reject(this.failure ?? new Error('Claude Code CLI transport is closed.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Claude Code CLI control request timed out: ${String(request.subtype)}`))
        void this.write({ type: 'control_cancel_request', request_id: requestId }).catch(() => {})
      }, this.options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      void this.write({ type: 'control_request', request_id: requestId, request }).catch((error: Error) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  private receive(value: unknown): void {
    const frame = record(value)
    if (!frame || typeof frame.type !== 'string') throw new Error('Claude Code CLI frame is missing its type.')
    if (frame.type === 'control_response') {
      const response = record(frame.response)
      if (!response || typeof response.request_id !== 'string' || !['success', 'error'].includes(String(response.subtype))) throw new Error('Invalid Claude Code CLI control response.')
      const pending = this.pending.get(response.request_id)
      if (!pending) return // Timed-out/cancelled requests can still receive a late response.
      clearTimeout(pending.timer)
      this.pending.delete(response.request_id)
      if (response.subtype === 'error') pending.reject(new Error(`Claude Code CLI control failed: ${this.safe(typeof response.error === 'string' ? response.error : 'unspecified error')}`))
      else if (response.response !== undefined && !record(response.response)) pending.reject(new Error('Invalid Claude Code CLI control response body.'))
      else pending.resolve(record(response.response) ?? {})
      return
    }
    if (frame.type === 'control_cancel_request') {
      if (typeof frame.request_id !== 'string') throw new Error('Invalid Claude Code CLI cancellation.')
      this.callbacks.get(frame.request_id)?.abort()
      this.callbacks.delete(frame.request_id)
      return
    }
    if (frame.type === 'control_request') {
      const request = record(frame.request)
      if (typeof frame.request_id !== 'string' || !request || typeof request.subtype !== 'string') throw new Error('Invalid Claude Code CLI control request.')
      if (this.callbacks.has(frame.request_id)) throw new Error('Duplicate Claude Code CLI control request ID.')
      void this.respond(frame.request_id, request)
      return
    }
    if (frame.type === 'keep_alive') return
    const message = frame as SDKMessage
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ done: false, value: message })
    else this.messages.push(message)
  }

  private async respond(requestId: string, request: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    this.callbacks.set(requestId, controller)
    try {
      if (request.subtype !== 'can_use_tool') throw new Error(`Unsupported Claude Code CLI control request: ${String(request.subtype)}`)
      if (!this.options.canUseTool) throw new Error('No tool permission handler is registered.')
      const input = record(request.input)
      if (typeof request.tool_name !== 'string' || typeof request.tool_use_id !== 'string' || !input) throw new Error('Invalid can_use_tool request.')
      const result = await this.options.canUseTool(request.tool_name, input, {
        signal: controller.signal,
        requestId,
        toolUseID: request.tool_use_id,
        ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions as PermissionUpdate[] } : {}),
        ...(typeof request.title === 'string' ? { title: request.title } : {}),
        ...(typeof request.display_name === 'string' ? { displayName: request.display_name } : {}),
        ...(typeof request.description === 'string' ? { description: request.description } : {}),
      })
      // The CLI expects allow.updatedInput even when Cotta only approves unchanged input.
      const response = result.behavior === 'allow' ? { ...result, updatedInput: result.updatedInput ?? input } : result
      if (!controller.signal.aborted && !this.closing && !this.exited) await this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    } catch (error) {
      if (!controller.signal.aborted && !this.closing && !this.exited) {
        await this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: this.safe(error instanceof Error ? error.message : String(error)) } }).catch(() => {})
      }
    } finally {
      if (this.callbacks.get(requestId) === controller) this.callbacks.delete(requestId)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.messages.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        if (this.failure) return Promise.reject(this.failure)
        if (this.exited) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }

  private signalProcessGroup(signal: NodeJS.Signals): void {
    if (this.child.pid === undefined) return
    try {
      process.kill(-this.child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.fail(new Error(`Unable to terminate Claude Code CLI: ${this.safe(String(error))}`))
    }
  }

  private sendSignal(signal: NodeJS.Signals): void {
    if (this.childExited || this.exited) return
    if (this.options.processGroup) this.signalProcessGroup(signal)
    else this.child.kill(signal)
  }

  /** Synchronous shutdown escalation; closed still waits for the child's stdio. */
  forceClose(): void {
    void this.close()
    this.sendSignal('SIGKILL')
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.exited) return this.closed
    this.rejectPending(new Error('Claude Code CLI transport closed.'))
    this.abortCallbacks()
    const grace = this.options.closeGraceMs ?? 1_500
    const terminate = setTimeout(() => this.sendSignal('SIGTERM'), grace)
    const kill = setTimeout(() => this.sendSignal('SIGKILL'), grace * 2)
    this.closing = this.closed.finally(() => {
      clearTimeout(terminate)
      clearTimeout(kill)
    })
    void this.writeTail.then(() => {
      if (!this.exited && !this.child.stdin.destroyed) this.child.stdin.end()
    })
    return this.closing
  }
}
