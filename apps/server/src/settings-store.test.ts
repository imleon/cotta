import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { SqliteSettingsStore } from './settings-store.js'

describe('SqliteSettingsStore', () => {
  it('stores global settings and auth sessions on a shared database', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cotta-settings-')), 'cotta.sqlite')
    const db = createCottaDatabase(path)
    const store = new SqliteSettingsStore(db)

    store.setMany('global', { showDebugNav: false, defaultModel: 'sonnet' })
    store.setMany('global', { defaultModel: 'opus' })
    expect(store.getAll()).toEqual({ showDebugNav: false, defaultModel: 'opus' })
    store.setMany('global', { showDebugNav: undefined })
    expect(store.getAll()).toEqual({ defaultModel: 'opus' })

    store.setMany('global', { showDebugNav: false })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => store.setMany('global', { defaultModel: 'sonnet', broken: circular })).toThrow()
    expect(store.getAll()).toEqual({ defaultModel: 'opus', showDebugNav: false })

    store.setAuthSession('auth', { user: { login: 'login', name: 'Name', avatarUrl: null }, expiresAt: 123 })
    expect(store.getAuthSession('auth')).toEqual({ user: { login: 'login', name: 'Name', avatarUrl: null }, expiresAt: 123 })
    store.setAuthSession('auth', { user: { login: 'next', name: null, avatarUrl: 'avatar' }, expiresAt: 456 })
    expect(store.getAuthSession('auth')).toEqual({ user: { login: 'next', name: null, avatarUrl: 'avatar' }, expiresAt: 456 })
    store.deleteAuthSession('auth')
    expect(store.getAuthSession('auth')).toBeNull()

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()).toEqual({ name: 'settings' })
    db.close()
  })

  it('clears auth sessions atomically with a config write and rolls both back on failure', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cotta-settings-')), 'cotta.sqlite')
    const db = createCottaDatabase(path)
    const store = new SqliteSettingsStore(db)

    store.setMany('secrets', { githubAllowedUsers: 'imleon' })
    store.setAuthSession('a', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: 123 })
    store.setAuthSession('b', { user: { login: 'imleon', name: null, avatarUrl: null }, expiresAt: 456 })

    store.setMany('secrets', { githubAllowedUsers: 'teammate' }, { clearAuthSessions: true })
    expect(store.getAll('secrets').githubAllowedUsers).toBe('teammate')
    expect(store.getAuthSession('a')).toBeNull()
    expect(store.getAuthSession('b')).toBeNull()

    store.setAuthSession('c', { user: { login: 'teammate', name: null, avatarUrl: null }, expiresAt: 789 })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => store.setMany('secrets', { githubAllowedUsers: 'broken', bad: circular }, { clearAuthSessions: true })).toThrow()
    // Config write and session deletion both rolled back.
    expect(store.getAll('secrets').githubAllowedUsers).toBe('teammate')
    expect(store.getAuthSession('c')).not.toBeNull()

    db.close()
  })
})
