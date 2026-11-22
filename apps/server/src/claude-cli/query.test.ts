import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKUserMessage } from './types.js'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./executable.js', async (original) => ({ ...(await original<typeof import('./executable.js')>()), resolveClaudeExecutable: () => '/system/claude' }))

import { claudeArguments, forceCloseOwnedClaudeProcesses, isOwnedClaudeProcess, query } from './query.js'

const queries: Query[] = []
afterEach(async () => {
  await Promise.all(queries.splice(0).map((query) => query.close()))
  spawnMock.mockReset()
})

function promptQueue() {
  let waiting: ((value: IteratorResult<SDKUserMessage>) => void) | undefined
  return {
    prompt: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            waiting = resolve
          }),
      }),
    },
    push: (uuid: string) => {
      if (!waiting) throw new Error('Prompt reader is not ready')
      waiting({ done: false, value: { type: 'user', uuid, session_id: 'session', parent_tool_use_id: null, message: { role: 'user', content: 'hello' } } })
      waiting = undefined
    },
    ready: () => waiting !== undefined,
  }
}

async function fakeCli() {
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child!: ChildProcessWithoutNullStreams
  spawnMock.mockImplementation(() => {
    child = spawn(
      process.execPath,
      [
        '-e',
        `
      const readline = require('node:readline'); let prompts=0;
      const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const frame=JSON.parse(line);
        if(frame.type==='control_request') {
          const request=frame.request;
          const response=request.subtype==='initialize'?{models:[{value:'native'}],commands:[{name:'native'}],extra:{kept:true},prompts}:request.subtype==='get_context_usage'?{categories:[],totalTokens:0,maxTokens:100,percentage:0}:{};
          send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}});
          if(request.subtype==='apply_flag_settings')send({type:'flags_echo',settings:request.settings});
        } else if(frame.type==='user') { prompts++;send(frame);send({type:'result',subtype:'success',prompts}); }
      }).on('close',()=>process.exit(0));
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
    )
    return child
  })
  return () => child
}

describe('persistent CLI query', () => {
  it('keeps a closing child registered through errors and removes it at exit, before stdio close', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams
    spawnMock.mockReturnValue(child)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const runtime = query({ prompt: (async function* () {})(), options: { cwd: '/tmp' } })
    const initialization = expect(runtime.initializationResult()).rejects.toThrow()
    try {
      const closing = runtime.close()
      child.emit('error', new Error('write failure'))
      expect(isOwnedClaudeProcess(child.pid!)).toBe(true)
      forceCloseOwnedClaudeProcesses()
      expect(kill).toHaveBeenCalledWith(-child.pid!, 'SIGKILL')
      child.emit('exit', 0, null)
      expect(isOwnedClaudeProcess(child.pid!)).toBe(false)
      kill.mockClear()
      forceCloseOwnedClaudeProcesses()
      expect(kill).not.toHaveBeenCalled()
      child.emit('close', 0, null)
      await closing
      await initialization
    } finally {
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      await initialization
      kill.mockRestore()
    }
  })

  it.skipIf(process.platform !== 'linux')('force-reaps active and already-closing CLI tool groups without killing an external process', async () => {
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const children: ChildProcessWithoutNullStreams[] = []
    const external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    spawnMock.mockImplementation(() => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        const {spawn}=require('node:child_process');
        const tool=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
        process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const frame=JSON.parse(line);
          process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{models:[],toolPid:tool.pid}}})+'\\n');
        });
      `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
      )
      children.push(child)
      return child
    })
    try {
      const active = query({ prompt: (async function* () {})(), options: { cwd: '/tmp' } })
      const closing = query({ prompt: (async function* () {})(), options: { cwd: '/tmp' } })
      queries.push(active, closing)
      const catalogs = await Promise.all([active.initializationResult(), closing.initializationResult()])
      const closed = closing.close()
      expect(isOwnedClaudeProcess(closing.pid!)).toBe(true)
      forceCloseOwnedClaudeProcesses()
      await Promise.all([active.close(), closed])
      expect(children.map((child) => child.signalCode)).toEqual(['SIGKILL', 'SIGKILL'])
      for (const catalog of catalogs) {
        await vi.waitFor(() => {
          try {
            expect(readFileSync(`/proc/${catalog.toolPid}/stat`, 'utf8').split(' ')[2]).toBe('Z')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        })
      }
      expect(isOwnedClaudeProcess(active.pid!)).toBe(false)
      expect(isOwnedClaudeProcess(closing.pid!)).toBe(false)
      expect(() => process.kill(external.pid!, 0)).not.toThrow()
    } finally {
      external.kill('SIGKILL')
      for (const child of children) if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL')
    }
  })

  it('initializes with zero prompts, preserves full catalog, reuses one PID for two turns and releases ownership after close', async () => {
    const child = await fakeCli()
    const queue = promptQueue()
    const runtime = query({ prompt: queue.prompt, options: { cwd: '/tmp', sessionId: 'session', includePartialMessages: true } })
    queries.push(runtime)
    expect(isOwnedClaudeProcess(runtime.pid!)).toBe(true)
    await expect(runtime.initializationResult()).resolves.toMatchObject({ commands: [{ name: 'native' }], extra: { kept: true }, prompts: 0 })
    const reader = runtime[Symbol.asyncIterator]()
    for (let turn = 1; turn <= 2; turn++) {
      await vi.waitFor(() => expect(queue.ready()).toBe(true))
      queue.push(`user-${turn}`)
      expect((await reader.next()).value.uuid).toBe(`user-${turn}`)
      expect((await reader.next()).value).toMatchObject({ type: 'result', prompts: turn })
    }
    await runtime.applyFlagSettings({ model: 'default', effortLevel: null })
    expect((await reader.next()).value).toEqual({ type: 'flags_echo', settings: { model: 'default', effortLevel: null } })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await runtime.close()
    expect(child().exitCode).toBe(0)
    expect(isOwnedClaudeProcess(runtime.pid!)).toBe(false)
  })

  it('filters inherited host identity without changing provider precedence or native configuration discovery', async () => {
    await fakeCli()
    const runtime = query({
      prompt: (async function* () {})(),
      options: {
        cwd: '/project',
        resume: 'existing',
        permissionMode: 'plan',
        model: 'native-model',
        effort: 'high',
        allowDangerouslySkipPermissions: true,
        env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: 'old', ANTHROPIC_BASE_URL: 'https://provider.example', ANTHROPIC_AUTH_TOKEN: 'secret' },
      },
    })
    queries.push(runtime)
    await runtime.initializationResult()
    const [path, args, options] = spawnMock.mock.calls[0]!
    expect(path).toBe('/system/claude')
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--resume',
      'existing',
      '--model',
      'native-model',
      '--effort',
      'high',
      '--permission-mode',
      'plan',
      '--allow-dangerously-skip-permissions',
    ])
    expect(options.cwd).toBe('/project')
    expect(options.env).toEqual({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://provider.example',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      CLAUDE_CODE_ENTRYPOINT: 'cotta',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    })
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--bare')
    expect(args).not.toContain('--system-prompt')
  })

  it('rejects contradictory new/resume identities rather than choosing one', () => {
    expect(() => claudeArguments({ cwd: '/tmp', sessionId: 'a', resume: 'b' })).toThrow('both sessionId and resume')
  })

  it('closes the prompt iterator cleanly when the query closes while waiting for input', async () => {
    await fakeCli()
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const runtime = query({
      prompt: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
          return: returned,
        }),
      },
      options: { cwd: '/tmp', sessionId: 'session' },
    })
    queries.push(runtime)
    await runtime.initializationResult()
    await runtime.close()
    await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce())
  })

  it('streams multiple persistent turns without retaining prior inputs on close', async () => {
    await fakeCli()
    const waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
    const queue: SDKUserMessage[] = []
    const push = (message: SDKUserMessage) => {
      const waiter = waiters.shift()
      if (waiter) waiter({ done: false, value: message })
      else queue.push(message)
    }
    const runtime = query({
      prompt: {
        [Symbol.asyncIterator]: () => ({
          next: () => (queue.length > 0 ? Promise.resolve({ done: false, value: queue.shift()! }) : new Promise<IteratorResult<SDKUserMessage>>((resolve) => waiters.push(resolve))),
        }),
      },
      options: { cwd: '/tmp', sessionId: 'session' },
    })
    queries.push(runtime)
    await runtime.initializationResult()
    const output = runtime[Symbol.asyncIterator]()
    for (let i = 0; i < 5; i += 1) {
      push({ type: 'user', message: { role: 'user', content: `turn-${i}` }, parent_tool_use_id: null, session_id: 'session' })
      expect((await output.next()).value).toMatchObject({ type: 'user', message: { content: `turn-${i}` } })
      expect((await output.next()).value).toMatchObject({ type: 'result', subtype: 'success', prompts: i + 1 })
    }
    await runtime.close()
    expect((await output.next()).done).toBe(true)
  })

  it('ends the output iterator cleanly when closed before initialization completes', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 987654322,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams
    spawnMock.mockReturnValue(child)
    const runtime = query({ prompt: (async function* () {})(), options: { cwd: '/tmp' } })
    const initialization = expect(runtime.initializationResult()).rejects.toThrow('closed')
    const output = runtime[Symbol.asyncIterator]()
    const closing = runtime.close()
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await closing
    await initialization
    await expect(output.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
