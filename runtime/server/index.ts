import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'fs'
import { CONFIG } from './config.js'
import { createWebRoutes } from './web.js'
import { bootstrapColdStart, createRuntime } from '../app/index.js'
import { createServerContext } from './context.js'

async function main() {
  const runtime = createRuntime()
  await bootstrapColdStart(runtime)

  const context = createServerContext({ runtime })
  await context.start()

  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const webRoutes = createWebRoutes(upgradeWebSocket, context)
  app.route('/', webRoutes)
  app.use('/*', serveStatic({ root: './web/dist' }))

  app.get('*', (c) => {
    const index = './web/dist/index.html'
    if (existsSync(index)) {
      return c.html(readFileSync(index, 'utf-8'))
    }
    return c.text('Frontend not built. Run: npm run build:web', 404)
  })

  const server = serve({ fetch: app.fetch, port: CONFIG.port, hostname: CONFIG.host }, (info) => {
    console.log(`Cotta running at http://${info.address}:${info.port}`)
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await context.stop()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  injectWebSocket(server)
}

void main()
