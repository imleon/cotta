import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 3

function databasePath(): string {
  return resolve(process.cwd(), process.env.COTTA_DB_PATH ?? 'data/cotta.sqlite')
}

export function createCottaDatabase(dbPath = databasePath()): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
  if (version >= SCHEMA_VERSION) return
  if (version === 1) {
    db.exec(`
      ALTER TABLE turn_meta_transcript ADD COLUMN scan_line_no INTEGER NOT NULL DEFAULT 0 CHECK (scan_line_no >= 0);
      PRAGMA user_version = 2;
    `)
  }
  if (version === 1 || version === 2) {
    db.exec(`
      UPDATE turn_meta_transcript
      SET scan_byte_offset = 0, scan_line_no = 0
      WHERE transcript_path IN (
        SELECT transcript_path FROM turn_meta_transcript
        WHERE primary_entrypoint = 'cli' AND duration_uuid IS NULL
      );
      PRAGMA user_version = 3;
    `)
    return
  }
  db.exec(`
    CREATE TABLE turn_meta_transcript (
      id INTEGER PRIMARY KEY,

      project_key TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      primary_user_uuid TEXT NOT NULL,

      primary_timestamp_ms INTEGER NOT NULL,
      primary_byte_offset INTEGER NOT NULL CHECK (primary_byte_offset >= 0),
      primary_entrypoint TEXT,

      duration_uuid TEXT,
      duration_parent_uuid TEXT,
      duration_timestamp_ms INTEGER,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      duration_message_count INTEGER CHECK (duration_message_count IS NULL OR duration_message_count >= 0),
      duration_line_no INTEGER CHECK (duration_line_no IS NULL OR duration_line_no >= 1),
      duration_byte_offset INTEGER CHECK (duration_byte_offset IS NULL OR duration_byte_offset >= 0),
      duration_byte_length INTEGER CHECK (duration_byte_length IS NULL OR duration_byte_length > 0),

      duration_is_sidechain INTEGER CHECK (duration_is_sidechain IS NULL OR duration_is_sidechain IN (0, 1)),
      duration_is_meta INTEGER CHECK (duration_is_meta IS NULL OR duration_is_meta IN (0, 1)),
      duration_user_type TEXT,
      duration_entrypoint TEXT,
      duration_cwd TEXT,
      duration_version TEXT,
      duration_git_branch TEXT,
      duration_slug TEXT,
      duration_pending_background_agent_count INTEGER CHECK (duration_pending_background_agent_count IS NULL OR duration_pending_background_agent_count >= 0),
      duration_session_kind TEXT,
      duration_forked_from_json TEXT CHECK (duration_forked_from_json IS NULL OR json_valid(duration_forked_from_json)),
      duration_pending_workflow_count INTEGER CHECK (duration_pending_workflow_count IS NULL OR duration_pending_workflow_count >= 0),
      duration_payload_json TEXT CHECK (duration_payload_json IS NULL OR json_valid(duration_payload_json)),

      file_mtime_ms INTEGER NOT NULL CHECK (file_mtime_ms >= 0),
      file_size INTEGER NOT NULL CHECK (file_size >= 0),
      scan_byte_offset INTEGER NOT NULL CHECK (scan_byte_offset >= 0),
      scan_line_no INTEGER NOT NULL DEFAULT 0 CHECK (scan_line_no >= 0),

      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),

      UNIQUE (transcript_path, primary_user_uuid)
    );

    CREATE INDEX turn_meta_transcript_by_session_time
      ON turn_meta_transcript(project_key, session_id, primary_timestamp_ms);

    CREATE INDEX turn_meta_transcript_by_path_offset
      ON turn_meta_transcript(transcript_path, scan_byte_offset);

    CREATE UNIQUE INDEX turn_meta_transcript_by_duration_uuid
      ON turn_meta_transcript(transcript_path, duration_uuid)
      WHERE duration_uuid IS NOT NULL;

    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
}
