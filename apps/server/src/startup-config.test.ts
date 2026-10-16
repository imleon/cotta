import { describe, expect, it, vi } from 'vitest'
import { loadGithubConfig, saveGithubConfig } from './auth.js'
import { createCottaDatabase } from './database.js'
import { SqliteSettingsStore } from './settings-store.js'
import { ensureGithubConfig } from './startup-config.js'

describe('GitHub config persistence', () => {
  it('round-trips client id and allowed user through the secrets scope', () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      expect(loadGithubConfig(store)).toEqual({ clientId: null, allowedUsers: null })
      saveGithubConfig(store, { clientId: 'client-123', allowedUsers: 'imleon' })
      expect(loadGithubConfig(store)).toEqual({ clientId: 'client-123', allowedUsers: 'imleon' })
      // Not exposed to the client via the global settings scope.
      expect(store.getAll('global').githubClientId).toBeUndefined()
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
      saveGithubConfig(store, { clientId: 'client-123', allowedUsers: 'imleon' })
      let prompted = false
      await ensureGithubConfig(store, {
        prompt: async () => {
          prompted = true
          return ''
        },
      })
      expect(prompted).toBe(false)
      expect(loadGithubConfig(store)).toEqual({ clientId: 'client-123', allowedUsers: 'imleon' })
    } finally {
      db.close()
    }
  })

  it('re-prompts and overwrites when force is on', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { clientId: 'old-client', allowedUsers: 'imleon' })
      const answers = ['new-client', 'teammate']
      await ensureGithubConfig(store, { force: true, prompt: async () => answers.shift() ?? '' })
      expect(loadGithubConfig(store)).toEqual({ clientId: 'new-client', allowedUsers: 'teammate' })
    } finally {
      db.close()
    }
  })

  it('re-prompts a legacy multi-user config even without force', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { clientId: 'client', allowedUsers: 'imleon,teammate' })
      const answers = ['new-client', 'imleon']
      await ensureGithubConfig(store, { prompt: async () => answers.shift() ?? '' })
      expect(loadGithubConfig(store)).toEqual({ clientId: 'new-client', allowedUsers: 'imleon' })
    } finally {
      db.close()
    }
  })

  it('clears existing sessions when reconfiguring the allowed user', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { clientId: 'old-client', allowedUsers: 'imleon' })
      store.setAuthSession('s1', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
      const answers = ['new-client', 'teammate']
      await ensureGithubConfig(store, { force: true, prompt: async () => answers.shift() ?? '' })
      expect(store.getAuthSession('s1')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('keeps existing sessions when forced reconfiguration leaves the allowed user unchanged', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { clientId: 'old-client', allowedUsers: 'imleon' })
      store.setAuthSession('s1', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: Date.now() + 60_000 })
      // Change only the client id; the allowed user is kept via a blank answer.
      const answers = ['new-client', '']
      await ensureGithubConfig(store, { force: true, prompt: async () => answers.shift() ?? '' })
      expect(loadGithubConfig(store)).toEqual({ clientId: 'new-client', allowedUsers: 'imleon' })
      expect(store.getAuthSession('s1')).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('keeps existing values on blank answers when force is on', async () => {
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      saveGithubConfig(store, { clientId: 'old-client', allowedUsers: 'imleon' })
      const answers = ['', '  teammate ']
      await ensureGithubConfig(store, { force: true, prompt: async () => answers.shift() ?? '' })
      expect(loadGithubConfig(store)).toEqual({ clientId: 'old-client', allowedUsers: 'teammate' })
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
      const answers = ['client', 'imleon,teammate']
      await expect(ensureGithubConfig(store, { force: true, prompt: async () => answers.shift() ?? '' })).rejects.toThrow('exit')
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
      saveGithubConfig(store, { clientId: 'client', allowedUsers: 'imleon,teammate' })
      await expect(ensureGithubConfig(store, { isTTY: false })).rejects.toThrow('exit')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('exactly one GitHub user'))
    } finally {
      error.mockRestore()
      exit.mockRestore()
      db.close()
    }
  })
})
