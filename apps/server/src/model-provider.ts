import type { AuthUser } from '@cotta/shared'
import type { Context, Hono } from 'hono'
import type { ModelCatalogProvider } from './model-catalog.js'

/**
 * Extension point for routing cotta to a non-default model backend without any of that backend's
 * code living in this (public) repo. An out-of-tree package default-exports a ModelProvider and is
 * loaded at startup via the COTTA_PROVIDER_MODULE env var; with no provider, cotta keeps its stock
 * official-Anthropic behavior. The interface is deliberately narrow and all members but `id` and
 * `envForTurn` are optional.
 */
export interface ModelProvider {
  /** Stable identifier, surfaced to the web client as `loginMethod` so it renders this provider's login. */
  readonly id: string

  /**
   * Env vars merged into the Claude Code CLI process (e.g. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
   * pointing at a local gateway). Resolved once when a session runtime is spawned, not per turn: a
   * runtime is a long-lived CLI process whose env is fixed at spawn and reused across turns. Values
   * must therefore stay valid for the runtime's lifetime — credential refresh belongs in the gateway,
   * not in a short-lived token returned here.
   */
  envForTurn(ctx?: { sessionId?: string }): Promise<Record<string, string>>

  /** Replaces defaultModelCatalogProvider when present (e.g. the gateway's own /v1/models). */
  modelCatalogProvider?: ModelCatalogProvider

  /**
   * Mounts the provider's login routes. Cotta's web login screen only supports the device-flow
   * contract (the one GitHub login uses), so these routes MUST implement it:
   *   - POST /api/auth/<id>/start → body matching `deviceLoginStartSchema` (@cotta/shared):
   *       { flowId, userCode, verificationUri, verificationUriComplete?, expiresIn, interval }
   *     (the user opens verificationUri and enters userCode).
   *   - POST /api/auth/<id>/poll  → body matching `deviceLoginPollSchema`, called every `interval`s
   *       until it returns { status: 'authorized', user }. On authorize the route calls
   *       `establishSession(c, user)` to mint cotta's signed session cookie — cotta keeps owning
   *       session security; the provider only supplies the login flow and the resolved identity.
   * Routes must be under /api/auth/ to be reachable pre-auth. A route name or response shape that
   * deviates from this contract breaks the login page (404 / zod parse error) at login time, not at
   * build time. When this is set, cotta skips GitHub login entirely (no allowlist) and the web client
   * renders this provider's login screen (advertised via `loginMethod`).
   */
  registerAuthRoutes?(app: Hono, ctx: { establishSession(c: Context, user: AuthUser): void }): void
}

/** Loads the configured provider module, or null when none is set. */
export async function loadModelProvider(): Promise<ModelProvider | null> {
  const modulePath = process.env.COTTA_PROVIDER_MODULE
  if (!modulePath) return null
  const loaded = (await import(modulePath)) as { default?: ModelProvider }
  if (!loaded.default?.id || typeof loaded.default.envForTurn !== 'function') {
    throw new Error(`COTTA_PROVIDER_MODULE "${modulePath}" must default-export a ModelProvider ({ id, envForTurn })`)
  }
  return loaded.default
}
