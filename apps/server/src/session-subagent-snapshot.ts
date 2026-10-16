import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionSubagentMeta } from './session-subagent-store.js'

type JsonRecord = Record<string, unknown>

class RetryableMetadataReadError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

export function sessionSubagentDir(sessionId: string, transcriptPath: string): string {
  return join(dirname(transcriptPath), sessionId, 'subagents')
}

async function metaFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^agent-(.+)\.meta\.json$/.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function optionalStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function readSessionSubagentSnapshotOnce(sessionId: string, transcriptPath: string): Promise<SessionSubagentMeta[]> {
  const observedAtMs = Date.now()
  const entries: SessionSubagentMeta[] = []
  for (const metaPath of await metaFiles(sessionSubagentDir(sessionId, transcriptPath))) {
    const match = /(?:^|\/)agent-(.+)\.meta\.json$/.exec(metaPath)
    const subagentId = match?.[1]
    if (!subagentId) continue
    const transcriptPath = metaPath.replace(/\.meta\.json$/, '.jsonl')
    let info: Awaited<ReturnType<typeof stat>>
    let raw: string
    let transcript: Awaited<ReturnType<typeof optionalStat>>
    try {
      ;[info, raw, transcript] = await Promise.all([stat(metaPath), readFile(metaPath, 'utf8'), optionalStat(transcriptPath)])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RetryableMetadataReadError(`Metadata disappeared while reading: ${metaPath}`, { cause: error })
      throw error
    }
    let meta: unknown
    try {
      meta = JSON.parse(raw)
    } catch (error) {
      throw new RetryableMetadataReadError(`Invalid subagent metadata JSON: ${metaPath}`, { cause: error })
    }
    if (!isRecord(meta)) throw new RetryableMetadataReadError(`Invalid subagent metadata object: ${metaPath}`)
    entries.push({
      sessionId,
      subagentId,
      parentAgentId: stringField(meta, 'parentAgentId'),
      agentType: stringField(meta, 'agentType'),
      name: stringField(meta, 'name'),
      description: stringField(meta, 'description'),
      model: stringField(meta, 'model'),
      metaPath,
      metaFileSize: info.size,
      metaFileMtimeMs: Math.trunc(info.mtimeMs),
      transcriptPath: transcript ? transcriptPath : null,
      transcriptFileSize: transcript?.size ?? null,
      transcriptFileMtimeMs: transcript?.mtimeMs ?? null,
      observedAtMs,
      metaJson: meta,
    })
  }
  return entries
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function readSessionSubagentSnapshot(sessionId: string, transcriptPath: string, options: { retryDelayMs?: number } = {}): Promise<SessionSubagentMeta[]> {
  const root = sessionSubagentDir(sessionId, transcriptPath)
  try {
    return await readSessionSubagentSnapshotOnce(sessionId, transcriptPath)
  } catch (error) {
    if (!(error instanceof RetryableMetadataReadError)) throw new Error(`Failed to read subagent metadata for ${sessionId} at ${root}`, { cause: error })
    await sleep(options.retryDelayMs ?? 25)
    try {
      return await readSessionSubagentSnapshotOnce(sessionId, transcriptPath)
    } catch (retryError) {
      throw new Error(`Failed to read subagent metadata for ${sessionId} at ${root}`, { cause: retryError })
    }
  }
}
