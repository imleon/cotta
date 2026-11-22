import { spawn } from 'node:child_process'
import type { ModelCatalogResponse } from '@cotta/shared'
import { claudeProcessEnv, resolveClaudeExecutable } from './executable.js'
import { CliTransport } from './transport.js'
import type { Query, QueryOptions, SDKControlGetContextUsageResponse, SDKUserMessage } from './types.js'

// Includes closing transports that are no longer in the session runtime map.
const ownedProcesses = new Map<number, CliTransport>()
export function isOwnedClaudeProcess(pid: number): boolean {
  return ownedProcesses.has(pid)
}

export function forceCloseOwnedClaudeProcesses(): void {
  for (const transport of ownedProcesses.values()) transport.forceClose()
}

export function claudeArguments(options: QueryOptions): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']
  if (options.includePartialMessages) args.push('--include-partial-messages')
  if (options.sessionId && options.resume) throw new Error('A Claude Code runtime cannot use both sessionId and resume.')
  if (options.sessionId) args.push('--session-id', options.sessionId)
  if (options.resume) args.push('--resume', options.resume)
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions')
  // No --bare, settings override, or system-prompt override: native discovery is authoritative.
  return args
}

/** Persistent print-mode CLI; result frames end turns, never the input stream. */
export function query({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: QueryOptions }): Query {
  const args = claudeArguments(options)
  const env = claudeProcessEnv(options.env)
  const child = spawn(resolveClaudeExecutable(), args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  const transport = new CliTransport(child, {
    canUseTool: options.canUseTool,
    processGroup: process.platform !== 'win32',
    redactValues: Object.entries(env)
      .filter(([key]) => /token|secret|password|api.?key/i.test(key))
      .map(([, value]) => value ?? ''),
  })
  // Register synchronously; an error or close request does not prove the child exited.
  if (child.pid !== undefined) ownedProcesses.set(child.pid, transport)
  child.once('exit', () => {
    if (child.pid !== undefined) ownedProcesses.delete(child.pid)
  })
  const initialized = transport.request({ subtype: 'initialize', hooks: {}, sdkMcpServers: [] }).then((result) => {
    if (!Array.isArray(result.models)) throw new Error('Claude Code CLI initialize did not return a model catalog.')
    return result as ModelCatalogResponse
  })
  let closed = false
  let closeRequested = false
  let wakeClosed: (() => void) | null = null
  const markClosed = () => {
    closed = true
    const wake = wakeClosed
    wakeClosed = null
    wake?.()
  }
  void transport.closed.then(markClosed)
  const input = prompt[Symbol.asyncIterator]()
  const nextInput = (): Promise<IteratorResult<SDKUserMessage>> => {
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        wakeClosed = null
        action()
      }
      wakeClosed = () => finish(() => resolve({ done: true, value: undefined }))
      input.next().then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      )
    })
  }
  let inputFailure: Error | null = null
  // Observe failures immediately even when the caller has not attached a business reader yet.
  void (async () => {
    try {
      await initialized
      for (;;) {
        const next = await nextInput()
        if (next.done || closed) break
        await transport.write(next.value)
      }
    } catch (error) {
      if (!closeRequested) inputFailure = error instanceof Error ? error : new Error(String(error))
      await transport.close()
    } finally {
      void input.return?.().catch(() => {})
    }
  })()
  return {
    pid: child.pid,
    initializationResult: () => initialized,
    interrupt: async () => {
      await initialized
      await transport.request({ subtype: 'interrupt' })
    },
    setPermissionMode: async (mode) => {
      await initialized
      await transport.request({ subtype: 'set_permission_mode', mode })
    },
    applyFlagSettings: async (settings) => {
      await initialized
      await transport.request({ subtype: 'apply_flag_settings', settings })
    },
    getContextUsage: async (settings) => {
      await initialized
      return (await transport.request({ subtype: 'get_context_usage', ...settings })) as SDKControlGetContextUsageResponse
    },
    close: () => {
      closeRequested = true
      markClosed()
      return transport.close()
    },
    [Symbol.asyncIterator]: () => {
      const output = transport[Symbol.asyncIterator]()
      return {
        next: async () => {
          const result = await output.next()
          if (result.done && inputFailure) throw inputFailure
          return result
        },
      }
    },
  }
}
