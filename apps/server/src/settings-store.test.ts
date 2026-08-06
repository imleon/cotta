import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { SqliteSettingsStore } from './settings-store.js'

describe('SqliteSettingsStore', () => {
  it('stores global settings and auth sessions on a shared database', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cotta-settings-')), 'cotta.sqlite')
    const db = createCottaDatabase(path, join(await mkdtemp(join(tmpdir(), 'cotta-legacy-settings-')), 'settings.sqlite'))
    const store = new SqliteSettingsStore(db)

    store.setMany('global', { showDebugNav: false, defaultModel: 'sonnet' })
    store.setMany('global', { defaultModel: 'opus' })
    expect(store.getAll()).toEqual({ showDebugNav: false, defaultModel: 'opus' })

    store.setAuthSession('auth', { user: { login: 'login', name: 'Name', avatarUrl: null }, expiresAt: 123 })
    expect(store.getAuthSession('auth')).toEqual({ user: { login: 'login', name: 'Name', avatarUrl: null }, expiresAt: 123 })
    store.setAuthSession('auth', { user: { login: 'next', name: null, avatarUrl: 'avatar' }, expiresAt: 456 })
    expect(store.getAuthSession('auth')).toEqual({ user: { login: 'next', name: null, avatarUrl: 'avatar' }, expiresAt: 456 })
    store.deleteAuthSession('auth')
    expect(store.getAuthSession('auth')).toBeNull()

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()).toEqual({ name: 'settings' })
    db.close()
  })
})
