import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { loadGithubConfig, saveGithubConfig } from '../auth.js'
import { createApp } from '../index.js'
import { memorySettingsStore, modelCatalog, project } from './project-routes-test-helpers.js'

const liveTurnManagerStub = {
  ensureRuntime: () => {},
  sessionRunState: () => null,
  runtimeTurnProjection: () => null,
  clearRuntimeTurnProjection: () => {},
  startTurn: async () => {
    throw new Error('not implemented')
  },
  acknowledgeCompletedTurn: () => false,
  interrupt: async () => false,
  subscribe: () => () => {},
}

const claudeCodeApiStub = {
  async listProjects() {
    return { projects: [project], hasMore: false, nextCursor: null }
  },
  async getProject() {
    return project
  },
  async listProjectSessions() {
    return null
  },
  async deleteSession() {
    return false
  },
  async renameSession() {
    return false
  },
  async forkSession() {
    return null
  },
  async getSessionTimelineState() {
    return null
  },
}

describe('project settings routes', () => {
  it('reads, saves, and refreshes global settings', async () => {
    const settingsStore = memorySettingsStore({ timeZone: 'Etc/UTC', defaultPermissionMode: 'plan' })
    const modelCatalogProvider = vi.fn(async () => modelCatalog)
    const app = createApp({
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',

      settingsStore,
      modelCatalogProvider,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    })

    expect(await (await app.request('/api/settings')).json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'plan', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false },
    })

    const permission = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultPermissionMode: 'default' } }),
    })
    expect(permission.status).toBe(200)
    expect(await permission.json()).toEqual({ settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false } })

    const timeZone = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { timeZone: 'Etc/UTC' } }),
    })
    expect(timeZone.status).toBe(200)
    expect((await timeZone.json()).settings.timeZone).toBe('UTC')
    expect(settingsStore.getAll().timeZone).toBe('UTC')

    const invalidTimeZone = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { timeZone: 'Not/A_Time_Zone' } }),
    })
    expect(invalidTimeZone.status).toBe(400)

    const incompleteModel = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultModel: 'gateway/my-model' } }),
    })
    expect(incompleteModel.status).toBe(400)
    expect(await incompleteModel.json()).toEqual({ error: 'invalid_settings_update' })

    const saved = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultModel: 'gateway/my-model', defaultEffort: 'high', useOneMillionContext: true, autoCompactPercent: 80 } }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'gateway/my-model', defaultEffort: 'high', useOneMillionContext: true, autoCompactPercent: 80, showDebugNav: false },
    })

    const invalidAutoCompactPercent = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { autoCompactPercent: 101 } }),
    })
    expect(invalidAutoCompactPercent.status).toBe(400)

    const resetAutoCompactPercent = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { autoCompactPercent: null } }),
    })
    expect(resetAutoCompactPercent.status).toBe(200)
    expect(await resetAutoCompactPercent.json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'gateway/my-model', defaultEffort: 'high', useOneMillionContext: true, showDebugNav: false },
    })

    const explicitDefault = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true } }),
    })
    expect(explicitDefault.status).toBe(200)
    expect(await explicitDefault.json()).toEqual({ settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false } })

    const reset = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true } }),
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false } })
    expect(await (await app.request('/api/settings')).json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false },
    })

    const refreshed = await app.request('/api/settings/model-catalog/refresh', { method: 'POST' })
    expect(refreshed.status).toBe(200)
    expect(modelCatalogProvider).toHaveBeenLastCalledWith(homedir())
    expect(await refreshed.json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false, modelCatalog },
    })

    const listed = await app.request('/api/model-catalog')
    expect(listed.status).toBe(200)
    expect(modelCatalogProvider).toHaveBeenLastCalledWith(homedir())
    expect(await listed.json()).toEqual(modelCatalog)

    const noEffortDefault = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { defaultModel: 'no-effort-model', defaultEffort: 'medium' } }),
    })
    expect(noEffortDefault.status).toBe(200)
    expect(await noEffortDefault.json()).toEqual({
      settings: { timeZone: 'UTC', defaultPermissionMode: 'default', defaultModel: 'no-effort-model', defaultEffort: null, useOneMillionContext: true, showDebugNav: false, modelCatalog },
    })
  })

  it('rejects model-catalog requests for an unregistered projectId', async () => {
    const modelCatalogProvider = vi.fn(async () => modelCatalog)
    const app = createApp({
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',
      settingsStore: memorySettingsStore({}),
      modelCatalogProvider,
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    })

    const forged = Buffer.from('/etc', 'utf8').toString('base64url')
    const listed = await app.request(`/api/model-catalog?projectId=${forged}`)
    expect(listed.status).toBe(404)
    const refreshed = await app.request(`/api/settings/model-catalog/refresh?projectId=${forged}`, { method: 'POST' })
    expect(refreshed.status).toBe(404)
    expect(modelCatalogProvider).not.toHaveBeenCalled()
  })

  it('reads, validates, and persists GitHub login config', async () => {
    const settingsStore = memorySettingsStore()
    saveGithubConfig(settingsStore, { clientId: 'client-123', allowedUsers: 'imleon' })
    const seedSessions = () => {
      settingsStore.setAuthSession('device-a', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
      settingsStore.setAuthSession('device-b', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
    }
    const app = createApp({
      transcriptIndex: { getSession: () => null },
      timelineVersionReader: () => 'timeline-missing',
      settingsStore,
      modelCatalogProvider: vi.fn(async () => modelCatalog),
      liveTurnManager: liveTurnManagerStub,
      claudeCodeApi: claudeCodeApiStub,
    })

    const current = await app.request('/api/settings/github')
    expect(current.status).toBe(200)
    expect(await current.json()).toEqual({ clientId: 'client-123', allowedUsers: 'imleon' })

    // Changing the allowed user revokes every session on all devices, atomically with the config write.
    seedSessions()
    const saved = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: '  new-client  ', allowedUsers: '  teammate  ' }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ clientId: 'new-client', allowedUsers: 'teammate' })
    expect(loadGithubConfig(settingsStore)).toEqual({ clientId: 'new-client', allowedUsers: 'teammate' })
    expect(settingsStore.getAuthSession('device-a')).toBeNull()
    expect(settingsStore.getAuthSession('device-b')).toBeNull()

    // Editing only the client id keeps the same allowed user, so existing sessions survive.
    seedSessions()
    const clientOnly = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'another-client', allowedUsers: 'teammate' }),
    })
    expect(clientOnly.status).toBe(200)
    expect(settingsStore.getAuthSession('device-a')).not.toBeNull()
    expect(settingsStore.getAuthSession('device-b')).not.toBeNull()

    const multiUser = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client', allowedUsers: 'imleon,teammate' }),
    })
    expect(multiUser.status).toBe(400)
    expect(await multiUser.json()).toEqual({ error: 'invalid_github_config' })

    const spaced = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client', allowedUsers: 'imleon teammate' }),
    })
    expect(spaced.status).toBe(400)

    const trailingComma = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client', allowedUsers: 'imleon,' }),
    })
    expect(trailingComma.status).toBe(400)

    const blank = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: '', allowedUsers: 'imleon' }),
    })
    expect(blank.status).toBe(400)

    const malformed = await app.request('/api/settings/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_github_config' })

    // A rejected update neither persists nor touches sessions.
    expect(loadGithubConfig(settingsStore)).toEqual({ clientId: 'another-client', allowedUsers: 'teammate' })
    expect(settingsStore.getAuthSession('device-a')).not.toBeNull()
  })
})
