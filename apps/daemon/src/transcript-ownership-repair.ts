import type { DatabaseSync } from 'node:sqlite'
import { materializeTranscriptTurnOwnership } from './transcript-turn-ownership.js'

export type RepairTranscriptOwnershipResult = {
  sessions: number
  rows: number
  changed: number
}

export function repairTranscriptOwnershipRows(db: DatabaseSync): RepairTranscriptOwnershipResult {
  const sessions = db.prepare('SELECT DISTINCT session_id FROM session_raw_transcript_lines ORDER BY session_id').all() as Array<{ session_id: string }>
  const selectLines = db.prepare(`
    SELECT session_id, byte_offset, raw_json, owner_turn_id
    FROM session_raw_transcript_lines WHERE session_id = ? ORDER BY byte_offset
  `)
  const updateOwner = db.prepare(`
    UPDATE session_raw_transcript_lines SET owner_turn_id = ?
    WHERE session_id = ? AND byte_offset = ?
  `)
  let rows = 0
  let changed = 0

  for (const { session_id } of sessions) {
    const cached = selectLines.all(session_id) as Array<{ session_id: string; byte_offset: number; raw_json: string; owner_turn_id: string | null }>
    const previousOwners = new Map(cached.map((row) => [row.byte_offset, row.owner_turn_id]))
    rows += cached.length
    for (const line of materializeTranscriptTurnOwnership(cached)) {
      if ((previousOwners.get(line.byte_offset) ?? null) !== line.owner_turn_id) {
        updateOwner.run(line.owner_turn_id, line.session_id, line.byte_offset)
        changed += 1
      }
    }
  }

  return { sessions: sessions.length, rows, changed }
}
