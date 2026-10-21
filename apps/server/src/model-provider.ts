import type { Hono } from 'hono'
import type { ModelCatalogProvider } from './model-catalog.js'
import type { SettingsStore } from './settings-store.js'
import { readSettings } from './turn-options.js'

/**
 * Extension point for routing cotta to a non-default model backend without any of that backend's
 * code living in this (public) repo. Out-of-tree packages default-export a ModelProvider; the set of
 * trusted modules is an operator-only list (COTTA_MODEL_PROVIDERS, comma-separated ESM
 * specifiers), and the web UI only ever selects among them by `id` — the importable path is never a
 * web-writable value. With no entries, cotta keeps its stock official-Anthropic behavior.
 *
 * A provider only picks a model backend; it never gates access. GitHub login stays cotta's sole
 * access gate. The interface is deliberately narrow — only `id` and `envForTurn` are required.
 */
export interface ModelProvider {
  /** Stable identifier; the web UI selects the active provider by this id. */
  readonly id: string

  /** Human-readable name for the Settings dropdown; falls back to `id`. */
  readonly label?: string

  /**
   * Env vars merged into the Claude Code CLI process (e.g. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
   * pointing at a local gateway). Resolved once when a session runtime is spawned, not per turn: a
   * runtime is a long-lived CLI process whose env is fixed at spawn and reused across turns. Values
   * must therefore stay valid for the runtime's lifetime — credential refresh belongs in the backend,
   * not in a short-lived token returned here.
   */
  envForTurn(ctx?: { sessionId?: string }): Promise<Record<string, string>>

  /** Replaces defaultModelCatalogProvider when present (e.g. the backend's own /v1/models). */
  modelCatalogProvider?: ModelCatalogProvider

  /**
   * Mounts the provider's connect routes, used to authenticate the model backend (not cotta). They
   * are gated (the user is already GitHub-logged-in) and live under /api/provider/<id>/connect/. The
   * web client drives them with the device-flow contract (deviceLoginStartSchema +
   * deviceConnectPollSchema in @cotta/shared): POST .../start returns a code + URL, POST .../poll is
   * called until it returns { status: 'authorized' }. Connecting never mints a cotta session.
   */
  registerConnectRoutes?(app: Hono): void

  /** Whether the backend is connected (for the Settings status line). */
  connectionStatus?(): Promise<{ connected: boolean }>
}

function isModelProvider(value: unknown): value is ModelProvider {
  const p = value as Partial<ModelProvider> | undefined
  return typeof p?.id === 'string' && typeof p?.envForTurn === 'function'
}

/**
 * Imports every specifier in COTTA_MODEL_PROVIDERS and indexes the providers by id. Empty/unset →
 * empty map (stock behavior). A specifier that doesn't default-export a valid ModelProvider throws —
 * an operator misconfiguration should fail loudly at boot, not silently drop a backend.
 */
export async function loadProviderAllowlist(): Promise<Map<string, ModelProvider>> {
  const raw = process.env.COTTA_MODEL_PROVIDERS
  const specifiers = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const providers = new Map<string, ModelProvider>()
  for (const specifier of specifiers) {
    const loaded = (await import(specifier)) as { default?: unknown }
    if (!isModelProvider(loaded.default)) {
      throw new Error(`COTTA_MODEL_PROVIDERS entry "${specifier}" must default-export a ModelProvider ({ id, envForTurn })`)
    }
    providers.set(loaded.default.id, loaded.default)
  }
  return providers
}

/** The provider the operator-selected `activeProviderId` resolves to, or null when none/unknown. */
export function resolveActiveProvider(allowlist: Map<string, ModelProvider>, store: SettingsStore): ModelProvider | null {
  const activeId = readSettings(store).activeProviderId
  return (activeId && allowlist.get(activeId)) || null
}

/**
 * Mounts the allowlist's connect routes plus the gated provider-selection API. Registered after the
 * auth middleware, so everything here requires a GitHub-logged-in user. The active provider id is the
 * only web-writable value; the importable specifier never is.
 */
export function registerProviderRoutes(app: Hono, input: { allowlist: Map<string, ModelProvider>; settingsStore?: SettingsStore }): void {
  const { allowlist, settingsStore } = input
  for (const provider of allowlist.values()) provider.registerConnectRoutes?.(app)

  app.get('/api/providers', async (c) => {
    const activeId = settingsStore ? (readSettings(settingsStore).activeProviderId ?? null) : null
    const providers = await Promise.all(
      [...allowlist.values()].map(async (p) => ({
        id: p.id,
        label: p.label ?? p.id,
        // No connect flow => nothing to connect (e.g. an env-only backend), so report connected.
        // A transient connectionStatus() failure must not 500 the whole endpoint, or the Settings
        // provider section (and the only UI to switch back to the Claude Code CLI) would disappear.
        connected: p.connectionStatus
          ? await p.connectionStatus().then(
              (s) => s.connected,
              () => false,
            )
          : true,
      })),
    )
    return c.json({ providers, activeId })
  })

  app.put('/api/providers/active', async (c) => {
    if (!settingsStore) return c.json({ error: 'settings_store_unavailable' }, 500)
    const body = (await c.req.json().catch(() => null)) as { id?: string | null } | null
    const id = body?.id ?? null
    if (id !== null && !allowlist.has(id)) return c.json({ error: 'unknown_provider' }, 400)
    settingsStore.setMany('global', { activeProviderId: id ?? undefined })
    return c.json({ ok: true })
  })
}
