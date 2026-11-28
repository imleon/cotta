import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export function claudeProcessEnv(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input,
    CLAUDE_CODE_ENTRYPOINT: 'cotta',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_AGENT_SDK_VERSION
  return env
}

/** Resolve only the service's PATH. Never download or silently substitute a runtime. */
export function resolveClaudeExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue
    const path = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')
    try {
      accessSync(path, constants.X_OK)
      const resolved = realpathSync(path)
      if (!statSync(resolved).isFile()) continue
      return resolved
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error
    }
  }
  throw new Error('Claude Code CLI was not found on the server PATH. Install claude and restart the server with its executable directory on PATH.')
}

let runtimeInfo: Promise<{ path: string; version: string }> | undefined
export function getClaudeCliRuntimeInfo(): Promise<{ path: string; version: string }> {
  runtimeInfo ??= Promise.resolve().then(() => {
    const path = resolveClaudeExecutable()
    return new Promise<{ path: string; version: string }>((resolve, reject) => {
      execFile(path, ['--version'], { env: claudeProcessEnv(), timeout: 10_000, maxBuffer: 16_384 }, (error, stdout) => {
        if (error) return reject(new Error(`Unable to read Claude Code CLI version (${error.code ?? 'process error'}).`))
        const version = stdout.trim().match(/^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s+\(Claude Code\)$/)?.[1]
        if (!version) return reject(new Error('The claude executable did not report a recognized Claude Code version.'))
        resolve({ path, version })
      })
    })
  })
  return runtimeInfo
}
