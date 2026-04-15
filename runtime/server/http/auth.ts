import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

type Logger = {
  warn: (event: string, fields?: Record<string, unknown>) => void
}

type AuthConfig = {
  authEnabled: boolean
  authToken: string
}

export function getBearerToken(header?: string | null): string | null {
  if (!header) return null
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : null
}

export function isAuthorizedToken(config: AuthConfig, token?: string | null): boolean {
  if (!config.authEnabled) return true
  if (!token) return false

  const expected = Buffer.from(config.authToken)
  const actual = Buffer.from(token)
  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}

export function createApiAuthMiddleware(input: {
  config: AuthConfig
  logger: Logger
  allowPaths: Set<string>
}): MiddlewareHandler {
  return async (c, next) => {
    if (!input.config.authEnabled || input.allowPaths.has(c.req.path)) {
      await next()
      return
    }

    const token = getBearerToken(c.req.header('authorization'))
    if (!isAuthorizedToken(input.config, token)) {
      input.logger.warn('auth:api:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }
}

export function createWsAuthMiddleware(input: {
  config: AuthConfig
  logger: Logger
}): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.query('auth')
    if (!isAuthorizedToken(input.config, token)) {
      input.logger.warn('auth:ws:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.text('Unauthorized', 401)
    }
    await next()
  }
}

