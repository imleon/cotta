import type { BuildInfoResponse, HealthResponse } from '@cotta/shared'
import type { Hono } from 'hono'
import { cottaAgentSdkVersion, cottaGitCommit, cottaVersion } from '../cotta-home.js'

const version = cottaVersion()
const commit = cottaGitCommit()
const agentSdkVersion = cottaAgentSdkVersion()

export function registerHealthRoute(app: Hono): void {
  // Public (auth bypass): liveness only, no build details.
  app.get('/api/health', (c) => {
    const response: HealthResponse = {
      ok: true,
      service: 'cotta-server',
    }
    return c.json(response)
  })
  app.get('/api/build-info', (c) => {
    const response: BuildInfoResponse = {
      version,
      commit,
      agentSdkVersion,
      uptimeSeconds: Math.floor(process.uptime()),
    }
    return c.json(response)
  })
}
