import type { BuildInfoResponse, HealthResponse } from '@cotta/shared'
import type { Hono } from 'hono'
import { getClaudeCliRuntimeInfo } from '../claude-cli/executable.js'
import { cottaGitCommit, cottaVersion } from '../cotta-home.js'

const version = cottaVersion()
const commit = cottaGitCommit()

export function registerHealthRoute(app: Hono): void {
  // Public (auth bypass): liveness only, no build details.
  app.get('/api/health', (c) => {
    const response: HealthResponse = {
      ok: true,
      service: 'cotta-server',
    }
    return c.json(response)
  })
  app.get('/api/build-info', async (c) => {
    // The executable helper caches its probe, including failures, for this server process.
    const cli = await getClaudeCliRuntimeInfo().catch(() => null)
    const response: BuildInfoResponse = {
      version,
      commit,
      claudeCodeCliVersion: cli?.version ?? null,
      uptimeSeconds: Math.floor(process.uptime()),
    }
    return c.json(response)
  })
}
