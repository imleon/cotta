import { afterEach, describe, expect, it, vi } from 'vitest'

const { access, realpath, stat, exec } = vi.hoisted(() => ({ access: vi.fn(), realpath: vi.fn(), stat: vi.fn(), exec: vi.fn() }))
vi.mock('node:fs', () => ({ constants: { X_OK: 1 }, accessSync: access, realpathSync: realpath, statSync: stat }))
vi.mock('node:child_process', () => ({ execFile: exec }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  access.mockReset()
  realpath.mockReset()
  stat.mockReset()
  exec.mockReset()
})

describe('Claude CLI executable', () => {
  it.each([undefined, 'sdk-ts', 'cotta'])('sets the cotta entrypoint without mutating inherited %s identity', async (entrypoint) => {
    const { claudeProcessEnv } = await import('./executable.js')
    const input = { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: entrypoint, CLAUDECODE: '1', CLAUDE_AGENT_SDK_VERSION: 'old', ANTHROPIC_BASE_URL: 'https://provider.example' }
    const original = { ...input }
    const env = claudeProcessEnv(input)
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('cotta')
    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('CLAUDE_AGENT_SDK_VERSION')
    expect(env.ANTHROPIC_BASE_URL).toBe(input.ANTHROPIC_BASE_URL)
    expect(input).toEqual(original)
  })

  it('resolves the installed executable and caches version probes', async () => {
    vi.stubEnv('PATH', '/missing:/installed')
    access.mockImplementation((path) => {
      if (path === '/missing/claude') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    realpath.mockReturnValue('/installed/claude-real')
    stat.mockReturnValue({ isFile: () => true })
    exec.mockImplementation((_path, _args, _options, callback) => callback(null, '2.1.322 (Claude Code)\n'))
    const { getClaudeCliRuntimeInfo } = await import('./executable.js')
    const first = getClaudeCliRuntimeInfo()
    expect(getClaudeCliRuntimeInfo()).toBe(first)
    await expect(first).resolves.toEqual({ path: '/installed/claude-real', version: '2.1.322' })
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[1]).toEqual(['--version'])
  })

  it('skips a directory named claude on PATH and continues searching', async () => {
    vi.stubEnv('PATH', '/dir-entry:/installed')
    realpath.mockImplementation((path) => (path === '/dir-entry/claude' ? '/dir-entry/claude' : '/installed/claude-real'))
    stat.mockImplementation((path) => ({ isFile: () => path !== '/dir-entry/claude' }))
    const { resolveClaudeExecutable } = await import('./executable.js')
    expect(resolveClaudeExecutable()).toBe('/installed/claude-real')
  })

  it('caches an explicit missing executable error instead of falling back', async () => {
    vi.stubEnv('PATH', '/missing')
    access.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const { getClaudeCliRuntimeInfo } = await import('./executable.js')
    const first = getClaudeCliRuntimeInfo()
    await expect(first).rejects.toThrow('not found on the server PATH')
    expect(getClaudeCliRuntimeInfo()).toBe(first)
    expect(exec).not.toHaveBeenCalled()
  })

  it('rejects a different executable that happens to have the same name', async () => {
    vi.stubEnv('PATH', '/installed')
    realpath.mockReturnValue('/installed/claude')
    stat.mockReturnValue({ isFile: () => true })
    exec.mockImplementation((_path, _args, _options, callback) => callback(null, 'another tool 1.2.3'))
    const { getClaudeCliRuntimeInfo } = await import('./executable.js')
    await expect(getClaudeCliRuntimeInfo()).rejects.toThrow('recognized Claude Code version')
  })
})
