import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { loadProviderAllowlist, resolveActiveProvider } from './model-provider.js'
import { SqliteSettingsStore } from './settings-store.js'

// loadProviderAllowlist splits on commas, so specifiers can't contain them (rules out data: URLs).
// Write throwaway ES module files and import them by file:// URL.
const dir = mkdtempSync(join(tmpdir(), 'cotta-provider-'))
const moduleUrl = (name: string, body: string) => {
  const path = join(dir, `${name}.mjs`)
  writeFileSync(path, body)
  return pathToFileURL(path).href
}
const validProvider = (id: string) => moduleUrl(id, `export default { id: ${JSON.stringify(id)}, envForTurn: async () => ({}) }`)

const original = process.env.COTTA_MODEL_PROVIDERS
afterEach(() => {
  if (original === undefined) delete process.env.COTTA_MODEL_PROVIDERS
  else process.env.COTTA_MODEL_PROVIDERS = original
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('loadProviderAllowlist', () => {
  it('is empty when unset or blank (stock behavior)', async () => {
    delete process.env.COTTA_MODEL_PROVIDERS
    expect((await loadProviderAllowlist()).size).toBe(0)
    process.env.COTTA_MODEL_PROVIDERS = ' , '
    expect((await loadProviderAllowlist()).size).toBe(0)
  })

  it('imports every specifier and indexes providers by id', async () => {
    process.env.COTTA_MODEL_PROVIDERS = `${validProvider('a')}, ${validProvider('b')}`
    const allowlist = await loadProviderAllowlist()
    expect([...allowlist.keys()].sort()).toEqual(['a', 'b'])
  })

  it('throws when a specifier does not default-export a valid ModelProvider', async () => {
    process.env.COTTA_MODEL_PROVIDERS = moduleUrl('bad', 'export default { id: "x" }')
    await expect(loadProviderAllowlist()).rejects.toThrow('must default-export a ModelProvider')
  })
})

describe('resolveActiveProvider', () => {
  it('returns null when no/unknown active id, and the provider when it matches the allowlist', async () => {
    process.env.COTTA_MODEL_PROVIDERS = validProvider('p')
    const allowlist = await loadProviderAllowlist()
    const db = createCottaDatabase(':memory:')
    try {
      const store = new SqliteSettingsStore(db)
      expect(resolveActiveProvider(allowlist, store)).toBeNull()
      store.setMany('global', { activeProviderId: 'p' })
      expect(resolveActiveProvider(allowlist, store)?.id).toBe('p')
      store.setMany('global', { activeProviderId: 'gone' })
      expect(resolveActiveProvider(allowlist, store)).toBeNull()
    } finally {
      db.close()
    }
  })
})
