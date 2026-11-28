import { createCloudApp, type Database } from './app.js'
import { createGitHubClient } from './github.js'

type WorkerEnv = { DB: D1Database; ASSETS: Fetcher }

export default {
  fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Response | Promise<Response> {
    // Static pages (the interim activation page) are served by the assets binding before the Worker runs; everything
    // that reaches here is API.
    return createCloudApp({ db: env.DB as unknown as Database, github: createGitHubClient() }).fetch(request, env, context)
  },
} satisfies ExportedHandler<WorkerEnv>
