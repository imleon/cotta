import type { Logger } from '../logger.js'

/**
 * AppEnv 定义 Hono 应用的类型上下文：
 * - `Variables`：每个请求可通过 `c.get/c.set` 访问的运行时变量
 * - `Bindings`：绑定到应用实例的全局依赖（目前为空，预留）
 *
 * 所有路由必须声明为 `Hono<AppEnv>`，以消除 `Hono<any>` 带来的类型漏洞。
 */
export type AppEnv = {
  Variables: {
    requestId: string
    logger: Logger
    validatedBody: unknown
    validatedQuery: unknown
    validatedParams: unknown
  }
  Bindings: Record<string, never>
}
