import { createHash } from 'node:crypto'

export type ListCursorKind = 'projects' | 'project-sessions'

type ListCursor = {
  v: 1
  kind: ListCursorKind
  epoch: string
  offset: number
  prefixHash: string
  projectId?: string
}

export class ListCursorError extends Error {
  constructor(readonly code: 'invalid' | 'stale') {
    super(code === 'invalid' ? 'Invalid list cursor' : 'List cursor is stale')
  }
}

function hashPrefix(ids: string[], offset: number): string {
  return createHash('sha256').update(JSON.stringify(ids.slice(0, offset))).digest('base64url')
}

function parseCursor(cursor: string): ListCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ListCursor>
    if (value.v !== 1 || (value.kind !== 'projects' && value.kind !== 'project-sessions') || typeof value.epoch !== 'string' || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.prefixHash !== 'string') throw new Error()
    if (value.projectId !== undefined && typeof value.projectId !== 'string') throw new Error()
    return value as ListCursor
  } catch {
    throw new ListCursorError('invalid')
  }
}

export function createListCursor(input: {
  kind: ListCursorKind
  epoch: string
  ids: string[]
  offset: number
  projectId?: string
}): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: input.kind,
    epoch: input.epoch,
    offset: input.offset,
    prefixHash: hashPrefix(input.ids, input.offset),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  } satisfies ListCursor), 'utf8').toString('base64url')
}

export function resolveListCursor(input: {
  cursor: string
  kind: ListCursorKind
  epoch: string
  ids: string[]
  projectId?: string
}): number {
  const cursor = parseCursor(input.cursor)
  if (cursor.kind !== input.kind || cursor.epoch !== input.epoch || cursor.projectId !== input.projectId || cursor.offset > input.ids.length) {
    throw new ListCursorError('stale')
  }
  if (hashPrefix(input.ids, cursor.offset) !== cursor.prefixHash) throw new ListCursorError('stale')
  return cursor.offset
}
