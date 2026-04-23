import type { Hono } from 'hono'
import type { LarkIntegrationService } from '../../../integrations/lark/service.js'
import type { AppEnv } from '../app-env.js'

export function registerLarkRoutes(app: Hono<AppEnv>, input: {
  larkIntegration: LarkIntegrationService
}) {
  app.post('/api/channels/lark/inbound', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      const result = await input.larkIntegration.handleInbound(body)
      return c.json(result.payload, result.status as 200 | 400 | 500)
    } catch (error) {
      c.get('logger').error('http:lark:inbound:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Failed to handle lark inbound' }, 500)
    }
  })

  app.post('/api/channels/lark/card-action', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      const result = await input.larkIntegration.handleCardAction(body)
      return c.json(result.payload, result.status as 200 | 400 | 500)
    } catch (error) {
      c.get('logger').error('http:lark:card-action:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Failed to handle lark card action' }, 500)
    }
  })

  app.post('/api/channels/lark/outbound', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      const conversationKey = typeof body?.conversationKey === 'string' ? body.conversationKey.trim() : ''
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (!conversationKey || !text) {
        return c.json({ error: 'conversationKey and text are required' }, 400)
      }
      await input.larkIntegration.sendTextToConversation(conversationKey, text)
      return c.json({ ok: true })
    } catch (error) {
      c.get('logger').error('http:lark:outbound:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to send lark outbound message' }, 500)
    }
  })
}
