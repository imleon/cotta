export type KvRow = { key: string; value: string }

export function recordToRows(record: Record<string, unknown> | undefined): KvRow[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }))
}

export function rowsToRecord(rows: KvRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    const raw = row.value.trim()
    if (!raw) {
      out[key] = ''
      continue
    }
    try {
      out[key] = JSON.parse(raw)
    } catch {
      out[key] = raw
    }
  }
  return out
}

export function rowsToStringRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return out
}
