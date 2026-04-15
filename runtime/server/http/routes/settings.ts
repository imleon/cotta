import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_RUNTIME_SETTINGS_PATH, resolveRuntimeConfigPath } from '../../../config/load.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type SettingsResponse = {
  path: string
  exists: boolean
  updatedAt: number | null
  raw: string
}

function resolveEditableSettingsPath(): string {
  // If user explicitly sets a runtime settings path, edit that file. Otherwise
  // default to `settings.json` in cwd.
  return resolveRuntimeConfigPath() ?? DEFAULT_RUNTIME_SETTINGS_PATH
}

async function safeWriteFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

export function registerSettingsRoutes(app: Hono<any, any, any>, input: { logger: Logger }) {
  app.get('/api/settings', async (c) => {
    const settingsPath = resolveEditableSettingsPath()
    try {
      const raw = await readFile(settingsPath, 'utf-8')
      const meta = await stat(settingsPath).catch(() => null)
      const updatedAt = meta ? meta.mtimeMs : null
      const payload: SettingsResponse = { path: settingsPath, exists: true, updatedAt, raw }
      return c.json(payload)
    } catch (error) {
      // If settings file doesn't exist, return an empty object template.
      const message = error instanceof Error ? error.message : String(error)
      input.logger.warn('http:settings:read:miss', { path: settingsPath, error: message })
      const payload: SettingsResponse = {
        path: settingsPath,
        exists: false,
        updatedAt: null,
        raw: '{\n  "connectors": [],\n  "channels": [],\n  "agents": []\n}\n',
      }
      return c.json(payload)
    }
  })

  app.put('/api/settings', async (c) => {
    const settingsPath = resolveEditableSettingsPath()
    const startedAt = Date.now()
    try {
      const body = await c.req.json().catch(() => null) as any
      const raw = typeof body?.raw === 'string' ? body.raw : ''
      if (!raw.trim()) return c.json({ error: 'raw is required' }, 400)

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Invalid JSON' }, 400)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return c.json({ error: 'Invalid settings: expected a JSON object' }, 400)
      }

      // Normalize to pretty JSON for stable diffs.
      const normalizedRaw = JSON.stringify(parsed, null, 2) + '\n'
      await safeWriteFileAtomic(settingsPath, normalizedRaw)
      const meta = await stat(settingsPath).catch(() => null)
      input.logger.info('http:settings:write:success', {
        path: settingsPath,
        durationMs: Date.now() - startedAt,
        bytes: normalizedRaw.length,
      })
      return c.json({
        ok: true,
        path: settingsPath,
        updatedAt: meta ? meta.mtimeMs : null,
      })
    } catch (error) {
      input.logger.error('http:settings:write:error', {
        path: settingsPath,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to save settings' }, 500)
    }
  })
}
