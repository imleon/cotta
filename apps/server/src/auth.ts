import type { Context, Next } from 'hono'

function bearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match?.[1] ?? null
}

export function createTokenAuthMiddleware(expectedToken: string | undefined) {
  return async (c: Context, next: Next) => {
    if (!expectedToken || c.req.path === '/api/health') {
      await next()
      return
    }

    const token = c.req.query('token') ?? bearerToken(c.req.header('authorization'))
    if (token !== expectedToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    await next()
  }
}
