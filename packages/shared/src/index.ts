import { z } from 'zod'

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('cotta-server'),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export type ProjectSummary = {
  id: string
  name: string
  path?: string
  lastActivityAt?: number
  sessionCount?: number
}

export type SessionSummary = {
  id: string
  title: string
  projectId: string
  lastActivityAt?: number
  rawStatus?: string
  displayStatus?: string
}

export type TurnSummary = {
  id: string
  sessionId: string
  title?: string
  startedAt?: number
  completedAt?: number
  rawStatus?: string
  displayStatus?: string
}

export type TimelineBlock = {
  id: string
  kind: string
  sourceEventIds: string[]
  data: unknown
}

export type SessionStreamEvent = {
  type: 'session.event'
  projectId: string
  sessionId: string
  event: unknown
}
