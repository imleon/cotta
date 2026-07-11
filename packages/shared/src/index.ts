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

export const timelineBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  sourceEventIds: z.array(z.string()),
  data: z.unknown(),
})

export type TimelineBlock = z.infer<typeof timelineBlockSchema>

export const turnSummarySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  rawStatus: z.string().optional(),
  displayStatus: z.string().optional(),
  blocks: z.array(timelineBlockSchema),
})

export type TurnSummary = z.infer<typeof turnSummarySchema>

export const sessionTimelineResponseSchema = z.object({
  sessionId: z.string(),
  turns: z.array(turnSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type SessionTimelineResponse = z.infer<typeof sessionTimelineResponseSchema>

export type SessionStreamEvent = {
  type: 'session.event'
  projectId: string
  sessionId: string
  event: unknown
}
