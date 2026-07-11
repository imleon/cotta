import { z } from 'zod'

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('cotta-server'),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  lastActivityAt: z.number().optional(),
  sessionCount: z.number().optional(),
})

export type ProjectSummary = z.infer<typeof projectSummarySchema>

export const projectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
})

export type ProjectsResponse = z.infer<typeof projectsResponseSchema>

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  lastActivityAt: z.number().optional(),
  rawStatus: z.string().optional(),
  displayStatus: z.string().optional(),
})

export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const projectResponseSchema = z.object({
  project: projectSummarySchema,
})

export type ProjectResponse = z.infer<typeof projectResponseSchema>

export const projectSessionsResponseSchema = z.object({
  project: projectSummarySchema,
  sessions: z.array(sessionSummarySchema),
  defaultSessionId: z.string().nullable(),
})

export type ProjectSessionsResponse = z.infer<typeof projectSessionsResponseSchema>

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
