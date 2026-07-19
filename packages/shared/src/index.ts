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
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type ProjectSessionsResponse = z.infer<typeof projectSessionsResponseSchema>

export const timelineBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  sourceEventIds: z.array(z.string()),
  apiMessageId: z.string().optional(),
  contentBlockId: z.string().optional(),
  toolUseId: z.string().optional(),
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

export const sessionTimelineStateSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  version: z.string(),
  signature: z.string(),
  lastActivityAt: z.number().optional(),
  fileSize: z.number().optional(),
  generatedAt: z.number(),
})

export type SessionTimelineState = z.infer<typeof sessionTimelineStateSchema>

export const sessionTimelineStateResponseSchema = z.object({
  state: sessionTimelineStateSchema,
})

export type SessionTimelineStateResponse = z.infer<typeof sessionTimelineStateResponseSchema>

export const sessionTimelineResponseSchema = z.object({
  sessionId: z.string(),
  turns: z.array(turnSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  state: sessionTimelineStateSchema,
})

export type SessionTimelineResponse = z.infer<typeof sessionTimelineResponseSchema>

export const rawSessionMessageSchema = z.unknown()

export type RawSessionMessage = z.infer<typeof rawSessionMessageSchema>

export const sessionRawMessagesResponseSchema = z.object({
  sessionId: z.string(),
  messages: z.array(rawSessionMessageSchema),
})

export type SessionRawMessagesResponse = z.infer<typeof sessionRawMessagesResponseSchema>

export const persistedLiveEventSchema = z.object({
  id: z.number(),
  projectId: z.string(),
  sessionId: z.string(),
  eventType: z.string(),
  source: z.string(),
  recordedAtMs: z.number(),
  payload: z.unknown(),
})

export type PersistedLiveEvent = z.infer<typeof persistedLiveEventSchema>

export const sessionLiveEventsResponseSchema = z.object({
  sessionId: z.string(),
  events: z.array(persistedLiveEventSchema),
})

export type SessionLiveEventsResponse = z.infer<typeof sessionLiveEventsResponseSchema>

export const createTurnRequestSchema = z.object({
  text: z.string().trim().min(1),
  userMessageUuid: z.string().uuid(),
})

export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>

export const createTurnResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  userMessageUuid: z.string(),
})

export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>

export type SessionStreamEvent =
  | {
      type: 'live.turn.started'
      projectId: string
      sessionId: string
      userMessageUuid: string
      turn: TurnSummary
    }
  | {
      type: 'live.raw'
      projectId: string
      sessionId: string
      userMessageUuid: string
      raw: unknown
    }
  | {
      type: 'live.timeline.block'
      projectId: string
      sessionId: string
      userMessageUuid: string
      block: TimelineBlock
    }
  | {
      type: 'live.turn.completed'
      projectId: string
      sessionId: string
      userMessageUuid: string
      completedAt: number
      raw: unknown
    }
  | {
      type: 'live.turn.failed'
      projectId: string
      sessionId: string
      userMessageUuid: string
      completedAt: number
      error: string
    }
  | {
      type: 'live.turn.interrupted'
      projectId: string
      sessionId: string
      userMessageUuid: string
      completedAt: number
    }

