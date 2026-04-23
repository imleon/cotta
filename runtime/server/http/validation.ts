import type { Context, MiddlewareHandler } from 'hono'
import { ZodError, type ZodIssue, type ZodType } from 'zod'
import type { AppEnv } from './app-env.js'

/**
 * 统一的 API 错误响应契约。
 * - `code`：机器可读的错误码（snake_case）
 * - `message`：人类可读的摘要
 * - `issues`：校验错误时 Zod 的逐字段 issue 列表（可选）
 * - `details`：业务相关的补充信息（可选）
 */
export type ApiErrorBody = {
  error: string
  code: string
  message: string
  issues?: ZodIssue[]
  details?: Record<string, unknown>
}

export type HttpStatusCode =
  | 400 | 401 | 403 | 404 | 405 | 409 | 410 | 415 | 422 | 429
  | 500 | 501 | 502 | 503 | 504

export function sendError(
  c: Context<AppEnv>,
  status: HttpStatusCode,
  code: string,
  message: string,
  extra?: { details?: Record<string, unknown>; issues?: ZodIssue[] },
) {
  const body: ApiErrorBody = {
    error: code,
    code,
    message,
    ...(extra?.details ? { details: extra.details } : {}),
    ...(extra?.issues ? { issues: extra.issues } : {}),
  }
  return c.json(body, status)
}

export function sendValidationError(
  c: Context<AppEnv>,
  error: ZodError,
  source: 'body' | 'query' | 'params',
) {
  return sendError(c, 400, 'validation_error', `Invalid request ${source}`, {
    issues: error.issues,
  })
}

async function readJsonSafely(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/**
 * 校验 JSON body，通过后将解析后的对象写入 `c.var.validatedBody`。
 */
export function validateJsonBody<T>(schema: ZodType<T>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = await readJsonSafely(c)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return sendValidationError(c, parsed.error, 'body')
    }
    c.set('validatedBody', parsed.data as unknown)
    await next()
  }
}

/**
 * 校验 query string，通过后将解析后的对象写入 `c.var.validatedQuery`。
 */
export function validateQuery<T>(schema: ZodType<T>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries())
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return sendValidationError(c, parsed.error, 'query')
    }
    c.set('validatedQuery', parsed.data as unknown)
    await next()
  }
}

/**
 * 校验路径参数，通过后将解析后的对象写入 `c.var.validatedParams`。
 */
export function validateParams<T>(schema: ZodType<T>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.req.param() as Record<string, string>
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return sendValidationError(c, parsed.error, 'params')
    }
    c.set('validatedParams', parsed.data as unknown)
    await next()
  }
}

/**
 * 从 context 中取出已校验的 body / query / params，带上具体的静态类型。
 *
 * 使用方式：
 * ```ts
 * const body = getValidatedBody<MyBody>(c)
 * ```
 */
export function getValidatedBody<T>(c: Context<AppEnv>): T {
  return c.get('validatedBody') as T
}

export function getValidatedQuery<T>(c: Context<AppEnv>): T {
  return c.get('validatedQuery') as T
}

export function getValidatedParams<T>(c: Context<AppEnv>): T {
  return c.get('validatedParams') as T
}

/**
 * 将未知异常归一化为 500 错误响应。只有真正的内部异常才应走这里；
 * 可预期的业务错误应由路由主动 `sendError` 并指定更合适的 code/status。
 */
export function sendInternalError(
  c: Context<AppEnv>,
  code: string,
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error)
  return sendError(c, 500, code, message)
}
