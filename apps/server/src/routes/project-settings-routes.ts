import { homedir } from 'node:os'
import { githubConfigSchema, isSingleUser, modelCatalogResponseSchema, settingsResponseSchema, settingsUpdateRequestSchema } from '@cotta/shared'
import type { Hono } from 'hono'
import { loadGithubConfig, saveGithubConfig } from '../auth.js'
import { projectPathFromId } from '../claude-code-api.js'
import { normalizeModelEffortSelection, readSettings } from '../turn-options.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'

export function registerProjectSettingsRoutes(app: Hono, input: ProjectRoutesInput): void {
  app.get('/api/settings', (c) => c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) })))

  app.get('/api/settings/github', (c) => {
    if (!input.settingsStore) return c.json({ error: 'settings_store_unavailable' }, 500)
    const cfg = loadGithubConfig(input.settingsStore)
    return c.json(githubConfigSchema.parse({ allowedUsers: cfg.allowedUsers ?? '' }))
  })

  app.put('/api/settings/github', async (c) => {
    try {
      if (!input.settingsStore) return c.json({ error: 'settings_store_unavailable' }, 500)
      const body = githubConfigSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid_github_config' }, 400)
      const allowedUsers = body.data.allowedUsers.trim()
      if (!isSingleUser(allowedUsers)) return c.json({ error: 'invalid_github_config' }, 400)
      // saveGithubConfig persists the config and revokes every stored auth session atomically when the allowed login changes.
      saveGithubConfig(input.settingsStore, { allowedUsers })
      return c.json(githubConfigSchema.parse({ allowedUsers }))
    } catch (error) {
      console.error('settings:github-update failed', error)
      return c.json({ error: 'github_config_update_failed' }, 500)
    }
  })

  app.put('/api/settings', async (c) => {
    try {
      const body = settingsUpdateRequestSchema.safeParse(await c.req.json())
      if (!body.success) return c.json({ error: 'invalid_settings_update' }, 400)
      const settings = {
        ...body.data.settings,
        ...(body.data.settings.autoCompactPercent === null ? { autoCompactPercent: undefined } : {}),
        ...(body.data.settings.publicBaseUrl === null ? { publicBaseUrl: undefined } : {}),
      }
      const currentSettings = readSettings(input.settingsStore)
      const normalized =
        settings.defaultModel === undefined
          ? settings
          : (() => {
              const pair = normalizeModelEffortSelection({ model: settings.defaultModel, effort: settings.defaultEffort! }, { ...currentSettings, ...settings })
              return { ...settings, defaultModel: pair.model, defaultEffort: pair.effort }
            })()
      input.settingsStore?.setMany('global', normalized)
      return c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) }))
    } catch (error) {
      console.error('settings:update failed', error)
      return c.json({ error: 'settings_update_failed' }, 500)
    }
  })

  app.post('/api/settings/model-catalog/refresh', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const cwd = projectId ? projectPathFromId(projectId) : homedir()
      if (projectId && !cwd) return c.json({ error: 'invalid_project_id' }, 400)
      if (projectId && !(await input.claudeCodeApi.getProject(projectId))) return c.json({ error: 'project_not_found' }, 404)
      input.settingsStore?.setMany('global', { modelCatalog: await input.modelCatalogProvider(cwd ?? undefined) })
      return c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) }))
    } catch (error) {
      console.error('settings:model-catalog-refresh failed', error)
      return c.json({ error: 'model_catalog_refresh_failed' }, 500)
    }
  })

  app.get('/api/model-catalog', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const cwd = projectId ? projectPathFromId(projectId) : homedir()
      if (projectId && !cwd) return c.json({ error: 'invalid_project_id' }, 400)
      if (projectId && !(await input.claudeCodeApi.getProject(projectId))) return c.json({ error: 'project_not_found' }, 404)
      return c.json(modelCatalogResponseSchema.parse(await input.modelCatalogProvider(cwd ?? undefined)))
    } catch (error) {
      console.error('model-catalog:list failed', error)
      return c.json({ error: 'model_catalog_failed' }, 500)
    }
  })
}
