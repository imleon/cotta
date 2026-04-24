import type { ExternalAdminWsEvent, SessionEvent } from '../../contract/runtime'

export function isExternalAdminWsEvent(value: unknown): value is ExternalAdminWsEvent {
  if (!value || typeof value !== 'object') return false
  const type = (value as Record<string, unknown>).type
  if (typeof type !== 'string') return false
  if (type.startsWith('session.')) return true
  return type === 'ws.notice' && typeof (value as Record<string, unknown>).message === 'string'
}

export function isSessionEventWire(value: unknown): value is SessionEvent {
  return isExternalAdminWsEvent(value) && value.type.startsWith('session.')
}
