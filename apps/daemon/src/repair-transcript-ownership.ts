import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { databasePath } from './cotta-home.js'
import { createCottaDatabase } from './database.js'
import { SessionSearchStore } from './session-search-store.js'
import { type RepairTranscriptOwnershipResult, repairTranscriptOwnershipRows } from './transcript-ownership-repair.js'

export type { RepairTranscriptOwnershipResult } from './transcript-ownership-repair.js'

export function repairTranscriptOwnership(db: DatabaseSync): RepairTranscriptOwnershipResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = repairTranscriptOwnershipRows(db)
    const searchStore = new SessionSearchStore(db)
    const sessions = db.prepare('SELECT DISTINCT session_id FROM session_raw_transcript_lines ORDER BY session_id').all() as Array<{ session_id: string }>
    for (const { session_id } of sessions) searchStore.rebuildSession(session_id)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = databasePath()
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`)
    process.exitCode = 1
  } else {
    const db = createCottaDatabase(dbPath)
    try {
      const result = repairTranscriptOwnership(db)
      console.log(`Repaired transcript ownership: sessions=${result.sessions} rows=${result.rows} changed=${result.changed}`)
    } finally {
      db.close()
    }
  }
}
