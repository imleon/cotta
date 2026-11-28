import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Database } from './app.js'

/** A node:sqlite stand-in for the D1 binding with the real migrations applied, for fast in-process tests. */
export function testDatabase(): Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'))
  return {
    raw,
    prepare(sql) {
      return {
        bind(...values) {
          const params = values as SQLInputValue[]
          return {
            first: async <T>() => (raw.prepare(sql).get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: raw.prepare(sql).all(...params) as T[] }),
            run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...params).changes) } }),
          }
        },
      }
    },
  }
}
