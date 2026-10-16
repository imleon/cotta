export type ListCursorKind = 'projects' | 'project-sessions'

export type KeysetCursorKey = { sort: number | null; id: string }

type KeysetListCursor = {
  v: 2
  kind: ListCursorKind
  key: KeysetCursorKey
  projectId?: string
}

export class ListCursorError extends Error {
  constructor(readonly code: 'invalid' | 'stale') {
    super(code === 'invalid' ? 'Invalid list cursor' : 'List cursor is stale')
  }
}

function parseKeysetCursor(cursor: string): KeysetListCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<KeysetListCursor>
    const key = value.key as Partial<KeysetCursorKey> | undefined
    if (value.v !== 2 || (value.kind !== 'projects' && value.kind !== 'project-sessions') || !key || typeof key.id !== 'string') throw new Error()
    if (key.sort !== null && (typeof key.sort !== 'number' || !Number.isFinite(key.sort))) throw new Error()
    if (value.projectId !== undefined && typeof value.projectId !== 'string') throw new Error()
    return value as KeysetListCursor
  } catch {
    throw new ListCursorError('invalid')
  }
}

export function createKeysetListCursor(input: { kind: ListCursorKind; key: KeysetCursorKey; projectId?: string }): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      kind: input.kind,
      key: input.key,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    } satisfies KeysetListCursor),
    'utf8',
  ).toString('base64url')
}

export function resolveKeysetListCursor(input: { cursor: string; kind: ListCursorKind; projectId?: string }): KeysetCursorKey {
  const cursor = parseKeysetCursor(input.cursor)
  if (cursor.kind !== input.kind || cursor.projectId !== input.projectId) throw new ListCursorError('stale')
  return cursor.key
}
