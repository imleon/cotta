import type { DatabaseSync } from 'node:sqlite'
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TokenUsageDailyResponse, TokenUsageDay, TokenUsageRange, TokenUsageResponse } from '@cotta/shared'
import { type ParsedTranscriptLine, readCompleteTranscriptLines } from './session-raw-transcript-cache.js'

type RecordValue = Record<string, unknown>
type UsageRecord = {
  transcriptPath: string
  responseKey: string
  sessionId: string
  isSubagent: boolean
  timestampMs: number
  model: string | null
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalTokens: number
}
type UsageRow = {
  transcript_path: string
  response_key: string
  session_id: string
  is_subagent: number
  timestamp_ms: number
  model: string | null
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  total_tokens: number
}
type SubagentUsageRow = {
  transcript_path: string
  transcript_file_size: number
  transcript_file_mtime_ms: number
  usage_transcript_path: string | null
  usage_parsed_byte_offset: number
  usage_file_mtime_ms: number | null
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function token(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

const usageTokenFields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const satisfies readonly (keyof SDKAssistantMessage['message']['usage'])[]

function usageTokens(usage: RecordValue): [number, number, number, number] | null {
  const value = (field: (typeof usageTokenFields)[number]) => (Object.hasOwn(usage, field) ? token(usage[field]) : 0)
  const input = value('input_tokens')
  const create = value('cache_creation_input_tokens')
  const read = value('cache_read_input_tokens')
  const output = value('output_tokens')
  return input === null || create === null || read === null || output === null ? null : [input, create, read, output]
}

export function parseTokenUsageLine(line: ParsedTranscriptLine, input: { transcriptPath: string; sessionId: string; isSubagent: boolean }): UsageRecord | null {
  const value = line.value
  const message = isRecord(value.message) ? value.message : null
  const usage = message && isRecord(message.usage) ? message.usage : null
  if (value.type !== 'assistant' || !message || !usage) return null
  const tokens = usageTokens(usage)
  const timestampMs = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : Number.NaN
  if (!tokens || !Number.isFinite(timestampMs)) return null
  const [inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens] = tokens
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens
  if (!Number.isSafeInteger(totalTokens)) return null
  const messageId = typeof message.id === 'string' && message.id.length > 0 ? message.id : null
  if (!messageId) return null
  const responseKey = `claude-code:${messageId}`
  return {
    transcriptPath: input.transcriptPath,
    responseKey,
    sessionId: input.sessionId,
    isSubagent: input.isSubagent,
    timestampMs,
    model: typeof message.model === 'string' ? message.model : null,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalTokens,
  }
}

function localDate(formatter: Intl.DateTimeFormat, timestampMs: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(timestampMs).map(({ type, value }) => [type, value]))
  if (!parts.year || !parts.month || !parts.day) throw new Error('Failed to format token usage timestamp')
  return `${parts.year}-${parts.month}-${parts.day}`
}

function dateSequence(today: string, count: number): string[] {
  const [year = 0, month = 0, day = 0] = today.split('-').map(Number)
  const end = Date.UTC(year, month - 1, day)
  return Array.from({ length: count }, (_, index) => new Date(end - (count - index - 1) * 86_400_000).toISOString().slice(0, 10))
}

export class TokenUsageStore {
  constructor(private readonly db: DatabaseSync) {}

  private usageRows(conservativeStart: number): UsageRow[] {
    return this.db
      .prepare(`SELECT * FROM (
        SELECT MIN(transcript_path) transcript_path, response_key, MIN(session_id) session_id,
          MIN(is_subagent) is_subagent, MIN(timestamp_ms) timestamp_ms, MAX(model) model,
          MAX(input_tokens) input_tokens, MAX(cache_creation_input_tokens) cache_creation_input_tokens,
          MAX(cache_read_input_tokens) cache_read_input_tokens, MAX(output_tokens) output_tokens,
          MAX(input_tokens) + MAX(cache_creation_input_tokens) + MAX(cache_read_input_tokens) + MAX(output_tokens) total_tokens
        FROM token_usage_stats GROUP BY response_key
      ) WHERE timestamp_ms >= ?`)
      .all(conservativeStart) as UsageRow[]
  }

  ingestLines(transcriptPath: string, sessionId: string, isSubagent: boolean, lines: readonly ParsedTranscriptLine[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO token_usage_stats (
        transcript_path, response_key, session_id, is_subagent, timestamp_ms, model,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transcript_path, response_key) DO UPDATE SET
        session_id = excluded.session_id, is_subagent = excluded.is_subagent, timestamp_ms = excluded.timestamp_ms,
        model = excluded.model,
        input_tokens = MAX(token_usage_stats.input_tokens, excluded.input_tokens),
        cache_creation_input_tokens = MAX(token_usage_stats.cache_creation_input_tokens, excluded.cache_creation_input_tokens),
        cache_read_input_tokens = MAX(token_usage_stats.cache_read_input_tokens, excluded.cache_read_input_tokens),
        output_tokens = MAX(token_usage_stats.output_tokens, excluded.output_tokens),
        total_tokens = MAX(token_usage_stats.input_tokens, excluded.input_tokens)
          + MAX(token_usage_stats.cache_creation_input_tokens, excluded.cache_creation_input_tokens)
          + MAX(token_usage_stats.cache_read_input_tokens, excluded.cache_read_input_tokens)
          + MAX(token_usage_stats.output_tokens, excluded.output_tokens)
    `)
    for (const line of lines) {
      const record = parseTokenUsageLine(line, { transcriptPath, sessionId, isSubagent })
      if (!record) continue
      upsert.run(
        record.transcriptPath,
        record.responseKey,
        record.sessionId,
        record.isSubagent ? 1 : 0,
        record.timestampMs,
        record.model,
        record.inputTokens,
        record.cacheCreationInputTokens,
        record.cacheReadInputTokens,
        record.outputTokens,
        record.totalTokens,
      )
    }
  }

  deleteTranscript(transcriptPath: string): void {
    this.db.prepare('DELETE FROM token_usage_stats WHERE transcript_path = ?').run(transcriptPath)
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM token_usage_stats WHERE session_id = ?').run(sessionId)
  }

  async repairTranscript(transcriptPath: string, sessionId: string, fileSize: number): Promise<void> {
    const lines = await readCompleteTranscriptLines(transcriptPath, 0, fileSize)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM token_usage_stats WHERE session_id = ? AND is_subagent = 0').run(sessionId)
      this.ingestLines(transcriptPath, sessionId, false, lines)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async syncSubagents(sessionId: string, authoritative = false): Promise<void> {
    const rows = this.db
      .prepare(`SELECT transcript_path, transcript_file_size, transcript_file_mtime_ms, usage_transcript_path,
        usage_parsed_byte_offset, usage_file_mtime_ms FROM session_subagents
        WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_file_size IS NOT NULL AND transcript_file_mtime_ms IS NOT NULL`)
      .all(sessionId) as SubagentUsageRow[]
    const paths = rows.map((row) => row.transcript_path)
    this.db
      .prepare(`DELETE FROM token_usage_stats WHERE session_id = ? AND is_subagent = 1${paths.length ? ` AND transcript_path NOT IN (${paths.map(() => '?').join(', ')})` : ''}`)
      .run(sessionId, ...paths)
    for (const row of rows) {
      const pathMatched = row.usage_transcript_path === row.transcript_path
      const shrunk = row.transcript_file_size < row.usage_parsed_byte_offset
      const caughtUp = row.transcript_file_size <= row.usage_parsed_byte_offset
      const mtimeUnchanged = row.usage_file_mtime_ms === row.transcript_file_mtime_ms
      // Called on every hot poll; skip reopening files with no new complete content.
      if (!authoritative && pathMatched && caughtUp && mtimeUnchanged && !shrunk) continue
      // Same-size rewrite (offset at EOF but mtime advanced): content may have changed, reparse from zero.
      const sameSizeRewrite = pathMatched && caughtUp && !mtimeUnchanged && !shrunk
      const reset = authoritative || !pathMatched || shrunk || sameSizeRewrite
      const startOffset = reset ? 0 : row.usage_parsed_byte_offset
      const lines = await readCompleteTranscriptLines(row.transcript_path, startOffset, row.transcript_file_size)
      const lastLine = lines.at(-1)
      const parsedUntil = lastLine ? lastLine.offset + lastLine.byteLength : startOffset
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (reset) this.deleteTranscript(row.usage_transcript_path ?? row.transcript_path)
        this.ingestLines(row.transcript_path, sessionId, true, lines)
        this.db
          .prepare(`UPDATE session_subagents SET usage_transcript_path = ?, usage_parsed_byte_offset = ?, usage_file_mtime_ms = ?
            WHERE session_id = ? AND transcript_path = ?`)
          .run(row.transcript_path, parsedUntil, row.transcript_file_mtime_ms, sessionId, row.transcript_path)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  queryDaily(days: number, timeZone: string, now = Date.now()): TokenUsageDailyResponse {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const today = localDate(formatter, now)
    const dates = dateSequence(today, days)
    const firstDate = dates[0]
    const conservativeStart = now - (days * 24 + 26) * 60 * 60 * 1000
    const rows = this.usageRows(conservativeStart)
    const daily = new Map<string, TokenUsageDay>()
    for (const date of dates) daily.set(date, { date, uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 })
    for (const row of rows) {
      const date = localDate(formatter, row.timestamp_ms)
      if (!firstDate || date < firstDate || date > today) continue
      const bucket = daily.get(date)
      if (!bucket) continue
      bucket.uncachedInputTokens += row.input_tokens
      bucket.cacheCreationInputTokens += row.cache_creation_input_tokens
      bucket.cacheReadInputTokens += row.cache_read_input_tokens
      bucket.outputTokens += row.output_tokens
      bucket.totalTokens += row.total_tokens
    }
    return { days, timeZone, daily: [...daily.values()] }
  }

  query(range: TokenUsageRange, timeZone: string, now = Date.now()): TokenUsageResponse {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const today = localDate(formatter, now)
    const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : null
    const firstDate = days ? dateSequence(today, days)[0] : null
    const conservativeStart = days ? now - (days * 24 + 26) * 60 * 60 * 1000 : 0
    const totals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitRate: 0, sessions: 0, userMessages: 0 }
    for (const row of this.usageRows(conservativeStart)) {
      const date = localDate(formatter, row.timestamp_ms)
      if (firstDate && (date < firstDate || date > today)) continue
      totals.totalTokens += row.total_tokens
      totals.inputTokens += row.input_tokens + row.cache_creation_input_tokens + row.cache_read_input_tokens
      totals.outputTokens += row.output_tokens
      totals.cacheReadTokens += row.cache_read_input_tokens
    }
    totals.cacheHitRate = totals.inputTokens === 0 ? 0 : totals.cacheReadTokens / totals.inputTokens
    const turnRows = this.db.prepare('SELECT session_id, primary_timestamp_ms FROM turn_meta_transcript WHERE primary_timestamp_ms >= ?').all(conservativeStart) as Array<{
      session_id: string
      primary_timestamp_ms: number
    }>
    const sessions = new Set<string>()
    for (const turn of turnRows) {
      const date = localDate(formatter, turn.primary_timestamp_ms)
      if (firstDate && (date < firstDate || date > today)) continue
      sessions.add(turn.session_id)
      totals.userMessages += 1
    }
    totals.sessions = sessions.size
    return { range, timeZone, totals }
  }
}
