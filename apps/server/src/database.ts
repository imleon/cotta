import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { databasePath } from './cotta-home.js'

const SCHEMA_VERSION = 44

/** On-disk root for a share's frozen image assets, co-located with the database file. */
export function shareAssetsRoot(token: string): string {
  return join(dirname(databasePath()), 'share-assets', token)
}

export function createCottaDatabase(dbPath = databasePath()): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  initializeSchema(db)
  return db
}

function createSettingsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE settings (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      expires_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `)
}

function createTurnMetaTables(db: DatabaseSync): void {
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
      away_summary TEXT,
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
    CREATE INDEX turn_meta_transcript_by_time_session
      ON turn_meta_transcript(primary_timestamp_ms, session_id);
    CREATE INDEX turn_meta_transcript_by_path_offset
      ON turn_meta_transcript(transcript_path, scan_byte_offset);
    CREATE UNIQUE INDEX turn_meta_transcript_by_duration_uuid
      ON turn_meta_transcript(transcript_path, duration_uuid)
      WHERE duration_uuid IS NOT NULL;
    CREATE INDEX turn_meta_transcript_by_session_offset
      ON turn_meta_transcript(session_id, transcript_path, primary_byte_offset);
    CREATE INDEX turn_meta_transcript_by_session_uuid
      ON turn_meta_transcript(session_id, transcript_path, primary_user_uuid);

    CREATE TABLE turn_meta_live (
      session_id TEXT NOT NULL,
      primary_user_uuid TEXT NOT NULL,
      result_uuid TEXT NOT NULL,
      result_subtype TEXT NOT NULL,
      is_error INTEGER NOT NULL CHECK (is_error IN (0, 1)),
      terminal_reason TEXT,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      duration_api_ms INTEGER CHECK (duration_api_ms IS NULL OR duration_api_ms >= 0),
      result_recorded_at_ms INTEGER NOT NULL CHECK (result_recorded_at_ms >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      PRIMARY KEY (session_id, primary_user_uuid),
      UNIQUE (session_id, result_uuid)
    );
  `)
}

function createSessionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_pins (
      session_id TEXT PRIMARY KEY,
      pinned_at_ms INTEGER NOT NULL CHECK (pinned_at_ms >= 0)
    );
    CREATE INDEX session_pins_by_time
      ON session_pins(pinned_at_ms DESC, session_id);

    CREATE TABLE session_subagents (
      session_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      owner_turn_id TEXT,
      is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0, 1)),
      parent_agent_id TEXT,
      agent_type TEXT,
      name TEXT,
      description TEXT,
      model TEXT,
      meta_path TEXT,
      meta_file_size INTEGER CHECK (meta_file_size IS NULL OR meta_file_size >= 0),
      meta_file_mtime_ms INTEGER CHECK (meta_file_mtime_ms IS NULL OR meta_file_mtime_ms >= 0),
      transcript_path TEXT,
      transcript_file_size INTEGER CHECK (transcript_file_size IS NULL OR transcript_file_size >= 0),
      transcript_file_mtime_ms INTEGER CHECK (transcript_file_mtime_ms IS NULL OR transcript_file_mtime_ms >= 0),
      usage_transcript_path TEXT,
      usage_parsed_byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (usage_parsed_byte_offset >= 0),
      usage_file_mtime_ms INTEGER CHECK (usage_file_mtime_ms IS NULL OR usage_file_mtime_ms >= 0),
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      meta_json TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
      PRIMARY KEY (session_id, subagent_id)
    );
    CREATE INDEX session_subagents_by_session_turn
      ON session_subagents(session_id, owner_turn_id, is_root);
    CREATE INDEX session_subagents_by_session_parent
      ON session_subagents(session_id, parent_agent_id);
  `)
}

function createTranscriptIndexTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE project_index (
      project_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL UNIQUE,
      last_activity_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    );

    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      current_project_id TEXT,
      current_cwd TEXT,
      transcript_path TEXT,
      file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
      file_mtime_ms INTEGER CHECK (file_mtime_ms IS NULL OR file_mtime_ms >= 0),
      last_visible_message_at_ms INTEGER CHECK (last_visible_message_at_ms IS NULL OR last_visible_message_at_ms >= 0),
      custom_title TEXT,
      ai_title TEXT,
      last_prompt TEXT,
      summary_hint TEXT,
      first_prompt TEXT,
      first_prompt_locked INTEGER CHECK (first_prompt_locked IS NULL OR first_prompt_locked IN (0, 1)),
      command_fallback TEXT,
      git_branch TEXT,
      is_sidechain INTEGER CHECK (is_sidechain IS NULL OR is_sidechain IN (0, 1)),
      entrypoint TEXT,
      session_kind TEXT,
      permission_mode TEXT,
      model TEXT,
      effort TEXT,
      turn_options_observed_at_ms INTEGER CHECK (turn_options_observed_at_ms IS NULL OR turn_options_observed_at_ms >= 0),
      task_snapshot_json TEXT CHECK (task_snapshot_json IS NULL OR json_valid(task_snapshot_json)),
      task_snapshot_version TEXT,
      task_snapshot_updated_at_ms INTEGER CHECK (task_snapshot_updated_at_ms IS NULL OR task_snapshot_updated_at_ms >= 0),
      context_usage_json TEXT CHECK (context_usage_json IS NULL OR json_valid(context_usage_json)),
      context_usage_updated_at_ms INTEGER CHECK (context_usage_updated_at_ms IS NULL OR context_usage_updated_at_ms >= 0),
      is_valid_session_id INTEGER NOT NULL DEFAULT 0 CHECK (is_valid_session_id IN (0, 1)),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      CHECK ((current_project_id IS NULL) = (current_cwd IS NULL))
    );
    CREATE INDEX project_index_by_activity
      ON project_index(last_activity_at_ms DESC, project_id);
    CREATE INDEX session_index_by_project
      ON session_index(current_project_id, session_id);
    CREATE INDEX session_index_by_project_activity
      ON session_index(current_project_id, COALESCE(last_visible_message_at_ms, file_mtime_ms) DESC, session_id);
  `)
}

function createRawTranscriptTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_raw_transcript_lines (
      session_id TEXT NOT NULL,
      byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      line_no INTEGER NOT NULL CHECK (line_no >= 1),
      uuid TEXT,
      type TEXT,
      timestamp_ms INTEGER,
      parent_uuid TEXT,
      is_sidechain INTEGER CHECK (is_sidechain IS NULL OR is_sidechain IN (0, 1)),
      user_type TEXT,
      entrypoint TEXT,
      cwd TEXT,
      version TEXT,
      git_branch TEXT,
      owner_turn_id TEXT,
      raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      PRIMARY KEY (session_id, byte_offset)
    );
    CREATE INDEX session_raw_transcript_lines_by_uuid
      ON session_raw_transcript_lines(session_id, uuid);
    CREATE INDEX session_raw_transcript_lines_by_session_line
      ON session_raw_transcript_lines(session_id, line_no);
    CREATE INDEX session_raw_transcript_lines_by_owner
      ON session_raw_transcript_lines(session_id, owner_turn_id, byte_offset);
  `)
}

function createTokenUsageTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE token_usage_stats (
      transcript_path TEXT NOT NULL,
      response_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      is_subagent INTEGER NOT NULL CHECK (is_subagent IN (0, 1)),
      timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
      model TEXT,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      cache_creation_input_tokens INTEGER NOT NULL CHECK (cache_creation_input_tokens >= 0),
      cache_read_input_tokens INTEGER NOT NULL CHECK (cache_read_input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      PRIMARY KEY (transcript_path, response_key)
    );
    CREATE INDEX token_usage_stats_by_time ON token_usage_stats(timestamp_ms);
    CREATE INDEX token_usage_stats_by_response ON token_usage_stats(response_key);
  `)
}

function createRemoteBotTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE remote_bots (
      bot_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('feishu', 'lark')),
      app_id TEXT NOT NULL,
      app_secret TEXT NOT NULL,
      all_projects INTEGER NOT NULL CHECK (all_projects IN (0, 1)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      config_version INTEGER NOT NULL CHECK (config_version >= 1),
      paired_open_id TEXT,
      paired_chat_id TEXT,
      selected_project_id TEXT,
      selected_session_id TEXT,
      paired_user_name TEXT,
      paired_user_avatar_url TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      UNIQUE (platform, app_id),
      CHECK ((paired_open_id IS NULL) = (paired_chat_id IS NULL)),
      CHECK (selected_session_id IS NULL OR selected_project_id IS NOT NULL)
    );
    CREATE TABLE remote_bot_projects (
      bot_id TEXT NOT NULL REFERENCES remote_bots(bot_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      PRIMARY KEY (bot_id, project_id)
    );
  `)
}

function createShareTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE shares (
      token TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      asset_manifest_json TEXT NOT NULL CHECK (json_valid(asset_manifest_json)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      UNIQUE (session_id, turn_id)
    );
    CREATE INDEX shares_session_id ON shares (session_id);
    CREATE INDEX shares_created_at ON shares (created_at_ms);
  `)
}

function createSessionSearchTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_search_documents (
      doc_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('title', 'sessionId', 'cwd', 'gitBranch', 'user', 'assistant')),
      owner_turn_id TEXT,
      message_uuid TEXT,
      content_block_index INTEGER CHECK (content_block_index IS NULL OR content_block_index >= 0),
      message_timestamp_ms INTEGER CHECK (message_timestamp_ms IS NULL OR message_timestamp_ms >= 0),
      logical_message_id TEXT,
      content TEXT NOT NULL,
      folded_content TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      UNIQUE (session_id, field, logical_message_id, content_block_index)
    );
    CREATE INDEX session_search_documents_by_session ON session_search_documents(session_id, field, message_timestamp_ms, doc_id);

    CREATE TABLE session_search_state (
      session_id TEXT PRIMARY KEY,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    );

    CREATE VIRTUAL TABLE session_search_fts USING fts5(
      content,
      content='session_search_documents',
      content_rowid='doc_id',
      tokenize='trigram'
    );

    CREATE TRIGGER session_search_documents_ai AFTER INSERT ON session_search_documents BEGIN
      INSERT INTO session_search_fts(rowid, content) VALUES (new.doc_id, new.content);
    END;
    CREATE TRIGGER session_search_documents_ad AFTER DELETE ON session_search_documents BEGIN
      INSERT INTO session_search_fts(session_search_fts, rowid, content) VALUES('delete', old.doc_id, old.content);
    END;
    CREATE TRIGGER session_search_documents_au AFTER UPDATE ON session_search_documents BEGIN
      INSERT INTO session_search_fts(session_search_fts, rowid, content) VALUES('delete', old.doc_id, old.content);
      INSERT INTO session_search_fts(rowid, content) VALUES (new.doc_id, new.content);
    END;
  `)
}

function initializeSchema(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
  if (version === SCHEMA_VERSION) return

  db.exec('BEGIN')
  try {
    if (version === 0) {
      createSettingsTables(db)
      createTurnMetaTables(db)
      createSessionTables(db)
      createTranscriptIndexTables(db)
      createRawTranscriptTables(db)
      createTokenUsageTables(db)
      createSessionSearchTables(db)
      createRemoteBotTables(db)
      createShareTables(db)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    } else if (version === 43) {
      createShareTables(db)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    } else
      throw new Error(
        `Unsupported Cotta database schema version ${version}; preserve the database and apply a one-time transactional migration to version ${SCHEMA_VERSION} based on the actual DDL differences`,
      )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
