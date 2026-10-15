import { describe, expect, it, vi } from 'vitest'
import { loadGithubConfig, saveGithubConfig } from './auth.js'
import { createCottaDatabase } from './database.js'
import { SqliteSettingsStore } from './settings-store.js'
import { ensureGithubConfig, ensureModelCatalog } from './startup-config.js'

describe('GitHub config persistence', () => {
  it('round-trips the allowed user through the secrets scope', () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: null })
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'imleon' })
      // Not exposed to the client via the global settings scope.
      expect(store.getAll('global').githubAllowedUsers).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('ensureGithubConfig', () => {
  it('skips the prompt when config exists and force is off', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      let prompted = false
      await ensureGithubConfig(store, {
        prompt: async () => {
          prompted = true
          return ''
        },
      })
      expect(prompted).toBe(false)
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'imleon' })
    } finally {
      db.close()
    }
  })

  it('re-prompts and overwrites when force is on', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      await ensureGithubConfig(store, { force: true, prompt: async () => 'teammate' })
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'teammate' })
    } finally {
      db.close()
    }
  })

  it('re-prompts a legacy multi-user config even without force', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon,teammate' })
      await ensureGithubConfig(store, { prompt: async () => 'imleon' })
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'imleon' })
    } finally {
      db.close()
    }
  })

  it('clears existing sessions when reconfiguring the allowed user', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      store.setAuthSession('s1', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
      await ensureGithubConfig(store, { force: true, prompt: async () => 'teammate' })
      expect(store.getAuthSession('s1')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('keeps existing sessions when forced reconfiguration leaves the allowed user unchanged', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      store.setAuthSession('s1', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
      // A blank answer keeps the current allowed user, so no session is revoked.
      await ensureGithubConfig(store, { force: true, prompt: async () => '' })
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'imleon' })
      expect(store.getAuthSession('s1')).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('trims the new user answer when force is on', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon' })
      await ensureGithubConfig(store, { force: true, prompt: async () => '  teammate ' })
      expect(loadGithubConfig(store)).toEqual({ allowedUsers: 'teammate' })
    } finally {
      db.close()
    }
  })

  it('rejects more than one allowed user', async () => {
    const db = createCottaDatabase(':memory:')
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit')
    }) as never)
    try {
      const store = new SqliteSettingsStore(db)
      await expect(ensureGithubConfig(store, { force: true, prompt: async () => 'imleon,teammate' })).rejects.toThrow('exit')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      exit.mockRestore()
      db.close()
    }
  })

  it('explains an invalid legacy allowed user instead of reporting "not configured" without a TTY', async () => {
    const db = createCottaDatabase(':memory:')
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit')
    }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { allowedUsers: 'imleon,teammate' })
      await expect(ensureGithubConfig(store, { isTTY: false })).rejects.toThrow('exit')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('exactly one GitHub user'))
    } finally {
      error.mockRestore()
      exit.mockRestore()
      db.close()
    }
  })
})

describe('ensureModelCatalog', () => {
  const catalog = { models: [{ value: 'default', displayName: 'Claude Code default', description: 'Default model' }] }

  it('seeds the catalog when missing', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      const provider = vi.fn(async () => catalog)
      await ensureModelCatalog(store, provider)
      expect(provider).toHaveBeenCalledTimes(1)
      expect(store.getAll('global').modelCatalog).toEqual(catalog)
    } finally {
      db.close()
    }
  })

  it('skips the provider when a catalog already exists', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      store.setMany('global', { modelCatalog: catalog })
      const provider = vi.fn(async () => ({ models: [] }))
      await ensureModelCatalog(store, provider)
      expect(provider).not.toHaveBeenCalled()
      expect(store.getAll('global').modelCatalog).toEqual(catalog)
    } finally {
      db.close()
    }
  })

  it('lets a provider failure surface instead of swallowing it', async () => {
    const db = createCottaDatabase(':memory:')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new SqliteSettingsStore(db)
      const provider = vi.fn(async () => {
        throw new Error('sdk unavailable')
      })
      await expect(ensureModelCatalog(store, provider)).rejects.toThrow('sdk unavailable')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('model catalog'))
      expect(store.getAll('global').modelCatalog).toBeUndefined()
    } finally {
      error.mockRestore()
      db.close()
    }
  })
})
