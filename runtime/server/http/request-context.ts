import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './app-env.js'
import type { Logger } from '../logger.js'

/**
 * 为每个请求注入稳定的 `requestId` 与 `logger`，供路由 handler 与下游使用。
 *
 * - 若客户端提供了 `X-Request-Id` header，则复用；否则生成 UUID。
 * - `c.res.headers` 会回显 `X-Request-Id`，便于端到端追踪。
 */
export function createRequestContextMiddleware(input: {
  logger: Logger
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')?.trim()
    const requestId = incoming && incoming.length > 0 ? incoming : randomUUID()
    c.set('requestId', requestId)
    c.set('logger', input.logger)
    c.header('X-Request-Id', requestId)
    await next()
  }
}
