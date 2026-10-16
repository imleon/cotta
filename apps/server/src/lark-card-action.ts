import { createHmac, timingSafeEqual } from 'node:crypto'

const ACTION_VERSION = 1
const MAX_ACTION_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_TOKEN_BYTES = 4096

export type LarkCardAction = {
  version: 1
  botId: string
  configVersion: number
  projectId: string
  card: 'sessions' | 'turn' | 'permission'
  operation:
    | 'refresh'
    | 'refresh_result'
    | 'more'
    | 'open'
    | 'new'
    | 'select_project'
    | 'first_turn'
    | 'previous_turn'
    | 'next_turn'
    | 'latest_turn'
    | 'allow'
    | 'deny'
    | 'allow_suggestion'
    | 'answer'
    | 'cancel'
    | 'submit_answers'
  sessionId?: string
  loadedCount?: number
  turnId?: string
  requestId?: string
  toolUseID?: string
  optionIndex?: number
  questionIndex?: number
  createdAtMs: number
}

type EncodedAction = {
  v: 1
  b: string
  c: number
  p: string
  k: 'sessions' | 'turn' | 'permission'
  o: LarkCardAction['operation']
  s?: string
  n?: number
  r?: string
  q?: string
  u?: string
  i?: number
  j?: number
  t: number
}

const OPERATIONS: LarkCardAction['operation'][] = [
  'refresh',
  'refresh_result',
  'more',
  'open',
  'new',
  'select_project',
  'first_turn',
  'previous_turn',
  'next_turn',
  'latest_turn',
  'allow',
  'deny',
  'allow_suggestion',
  'answer',
  'cancel',
  'submit_answers',
]

function encoded(action: LarkCardAction): EncodedAction {
  return {
    v: ACTION_VERSION,
    b: action.botId,
    c: action.configVersion,
    p: action.projectId,
    k: action.card,
    o: action.operation,
    ...(action.sessionId ? { s: action.sessionId } : {}),
    ...(action.loadedCount !== undefined ? { n: action.loadedCount } : {}),
    ...(action.turnId ? { r: action.turnId } : {}),
    ...(action.requestId ? { q: action.requestId } : {}),
    ...(action.toolUseID ? { u: action.toolUseID } : {}),
    ...(action.optionIndex !== undefined ? { i: action.optionIndex } : {}),
    ...(action.questionIndex !== undefined ? { j: action.questionIndex } : {}),
    t: action.createdAtMs,
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseAction(value: unknown): LarkCardAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const action = value as Partial<EncodedAction>
  const configVersion = action.c
  const createdAtMs = action.t
  const operation = action.o
  if (
    action.v !== ACTION_VERSION ||
    !nonEmpty(action.b) ||
    !Number.isSafeInteger(configVersion) ||
    configVersion === undefined ||
    configVersion < 1 ||
    !nonEmpty(action.p) ||
    (action.k !== 'sessions' && action.k !== 'turn' && action.k !== 'permission') ||
    !operation ||
    !OPERATIONS.includes(operation as LarkCardAction['operation']) ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs === undefined ||
    createdAtMs < 0 ||
    (action.s !== undefined && !nonEmpty(action.s)) ||
    (action.n !== undefined && (!Number.isSafeInteger(action.n) || action.n < 0)) ||
    (action.r !== undefined && !nonEmpty(action.r)) ||
    (action.q !== undefined && !nonEmpty(action.q)) ||
    (action.u !== undefined && !nonEmpty(action.u)) ||
    (action.i !== undefined && (!Number.isSafeInteger(action.i) || action.i < 0)) ||
    (action.j !== undefined && (!Number.isSafeInteger(action.j) || action.j < 0))
  )
    return null
  return {
    version: ACTION_VERSION,
    botId: action.b,
    configVersion,
    projectId: action.p,
    card: action.k,
    operation: operation as LarkCardAction['operation'],
    ...(action.s ? { sessionId: action.s } : {}),
    ...(action.n !== undefined ? { loadedCount: action.n } : {}),
    ...(action.r ? { turnId: action.r } : {}),
    ...(action.q ? { requestId: action.q } : {}),
    ...(action.u ? { toolUseID: action.u } : {}),
    ...(action.i !== undefined ? { optionIndex: action.i } : {}),
    ...(action.j !== undefined ? { questionIndex: action.j } : {}),
    createdAtMs,
  }
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

export function encodeLarkCardAction(action: LarkCardAction, secret: string): string {
  if (!secret) throw new Error('Lark card action secret is required')
  const payload = Buffer.from(JSON.stringify(encoded(action)), 'utf8').toString('base64url')
  return `${payload}.${signature(payload, secret).toString('base64url')}`
}

export function decodeLarkCardAction(token: string, secret: string, now = Date.now()): LarkCardAction | null {
  if (!secret || !token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return null
  const separator = token.indexOf('.')
  if (separator <= 0 || token.indexOf('.', separator + 1) !== -1) return null
  const payload = token.slice(0, separator)
  const actual = Buffer.from(token.slice(separator + 1), 'base64url')
  const expected = signature(payload, secret)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const action = parseAction(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    if (!action || action.createdAtMs > now || now - action.createdAtMs > MAX_ACTION_AGE_MS) return null
    return action
  } catch {
    return null
  }
}
