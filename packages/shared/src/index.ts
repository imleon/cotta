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
})

export type ProjectSummary = z.infer<typeof projectSummarySchema>

export const projectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type ProjectsResponse = z.infer<typeof projectsResponseSchema>

export const listVersionsEventSchema = z.object({
  epoch: z.string().uuid(),
  projectsVersion: z.number().int().nonnegative(),
  projectVersions: z.array(z.object({
    projectId: z.string(),
    version: z.number().int().nonnegative(),
  })),
})

export type ListVersionsEvent = z.infer<typeof listVersionsEventSchema>

export const sessionRunStateSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('idle'),
    activeTurnId: z.null(),
    lastTurn: z.object({
      id: z.string(),
      outcome: z.enum(['success', 'error']),
    }).optional(),
  }),
  z.object({
    phase: z.literal('running'),
    activeTurnId: z.string(),
    lastTurn: z.null().optional(),
  }),
  z.object({
    phase: z.literal('requires_action'),
    activeTurnId: z.string(),
    lastTurn: z.null().optional(),
  }),
])

export type SessionRunState = z.infer<typeof sessionRunStateSchema>

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  lastActivityAt: z.number().optional(),
  runState: sessionRunStateSchema,
})

export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const projectResponseSchema = z.object({
  project: projectSummarySchema,
})

export type ProjectResponse = z.infer<typeof projectResponseSchema>

export const createProjectRequestSchema = z.object({
  directoryPath: z.string().trim().min(1).refine((value) => {
    if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return false
    return value.split(/[\\/]+/).every((segment) => segment && segment !== '.' && segment !== '..')
  }, 'directoryPath must be a relative path inside the projects root'),
})

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>

export const createProjectResponseSchema = z.object({
  project: projectSummarySchema,
})

export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>

export const projectSessionsResponseSchema = z.object({
  project: projectSummarySchema,
  sessions: z.array(sessionSummarySchema),
  defaultSessionId: z.string().nullable(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type ProjectSessionsResponse = z.infer<typeof projectSessionsResponseSchema>

export const projectSessionsQuerySchema = z.object({
  projects: z.array(z.object({
    projectId: z.string(),
    limit: z.number().int().positive().max(10_000),
    selectedSessionId: z.string().optional(),
  })),
})

export type ProjectSessionsQuery = z.infer<typeof projectSessionsQuerySchema>

export const projectSessionsWindowSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  selectedSessionExists: z.boolean().optional(),
})

export type ProjectSessionsWindow = z.infer<typeof projectSessionsWindowSchema>

export const projectSessionsQueryResponseSchema = z.object({
  sessionsByProject: z.record(z.string(), projectSessionsWindowSchema),
})

export type ProjectSessionsQueryResponse = z.infer<typeof projectSessionsQueryResponseSchema>

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function timelineToolUseId(message: unknown, block: unknown): string | undefined {
  if (isRecord(block) && typeof block.tool_use_id === 'string') return block.tool_use_id
  return isRecord(message) && typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined
}

function containsToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function timelineOriginKind(value: Record<string, unknown>): string | undefined {
  const origin = value.origin
  if (isRecord(origin) && typeof origin.kind === 'string') return origin.kind
  if (typeof origin === 'string') return origin
  const message = isRecord(value.message) ? value.message : null
  return message && typeof message.origin === 'string' ? message.origin : undefined
}

function tagText(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))
  return match?.[1]?.trim() || null
}

export function timelineTaskNotificationToolUseId(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message) || typeof value.message.content !== 'string') return undefined
  const content = value.message.content.trim()
  if (!/^<task-notification(?:\s[^>]*)?>[\s\S]*<\/task-notification>$/.test(content)) return undefined
  if (!tagText(content, 'task-id')) return undefined
  return tagText(content, 'tool-use-id') ?? undefined
}

export function isTimelineTaskNotificationMessage(value: unknown): boolean {
  return timelineTaskNotificationToolUseId(value) !== undefined
}

export function isPrimaryTimelineUserMessage(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message)) return false
  const message = value.message
  if (message.role !== 'user' || value.isSynthetic === true || value.shouldQuery === false || isTimelineTaskNotificationMessage(value) || containsToolResult(message.content) || value.isSidechain === true) return false
  const originKind = timelineOriginKind(value)
  return originKind === 'human'
    || value.promptSource === 'typed'
    || (value.promptSource === 'sdk' && originKind !== 'task-notification')
    || (originKind == null && value.promptSource == null && value.isMeta !== true)
}

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

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

export const modelSelectionSchema = z.string().trim().min(1)
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type EffortLevel = z.infer<typeof effortLevelSchema>
export const defaultTurnOptionSchema = z.literal('default')
export type DefaultTurnOption = z.infer<typeof defaultTurnOptionSchema>
export const turnEffortSelectionSchema = z.union([effortLevelSchema, defaultTurnOptionSchema])
export type TurnEffortSelection = z.infer<typeof turnEffortSelectionSchema>

export const modelCatalogItemSchema = z.object({
  value: z.string(),
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(effortLevelSchema).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
})
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>

export const modelCatalogResponseSchema = z.object({
  models: z.array(modelCatalogItemSchema),
})
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>

export const appSettingsSchema = z.object({
  defaultPermissionMode: permissionModeSchema.optional(),
  defaultModel: modelSelectionSchema.nullable().optional(),
  defaultEffort: effortLevelSchema.nullable().optional(),
  modelCatalog: modelCatalogResponseSchema.optional(),
  showDebugNav: z.boolean().optional(),
}).catchall(z.unknown())
export type AppSettings = z.infer<typeof appSettingsSchema>

export const settingsResponseSchema = z.object({
  settings: appSettingsSchema,
})
export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const settingsUpdateRequestSchema = z.object({
  settings: appSettingsSchema,
})
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>

export const authUserSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})
export type AuthUser = z.infer<typeof authUserSchema>

export const authSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  user: authUserSchema.nullable(),
  githubConfigured: z.boolean(),
})
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>

export const githubDeviceStartResponseSchema = z.object({
  flowId: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string().optional(),
  expiresIn: z.number(),
  interval: z.number(),
})
export type GitHubDeviceStartResponse = z.infer<typeof githubDeviceStartResponseSchema>

export const githubDevicePollRequestSchema = z.object({
  flowId: z.string(),
})
export type GitHubDevicePollRequest = z.infer<typeof githubDevicePollRequestSchema>

export const githubDevicePollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number() }),
  z.object({ status: z.literal('slow_down'), interval: z.number() }),
  z.object({ status: z.literal('authorized'), user: authUserSchema }),
])
export type GitHubDevicePollResponse = z.infer<typeof githubDevicePollResponseSchema>

export const logoutResponseSchema = z.object({ ok: z.literal(true) })
export type LogoutResponse = z.infer<typeof logoutResponseSchema>

export const createTurnRequestSchema = z.object({
  text: z.string().trim().min(1),
  userMessageUuid: z.string().uuid(),
  permissionMode: permissionModeSchema.optional(),
  model: z.union([modelSelectionSchema, defaultTurnOptionSchema]).optional(),
  effort: turnEffortSelectionSchema.optional(),
})

export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>

export const sessionRuntimeResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  sessionId: z.string(),
  settings: z.object({
    permissionMode: permissionModeSchema,
    model: modelSelectionSchema.nullable(),
    effort: effortLevelSchema.nullable(),
  }),
  availablePermissionModes: z.array(permissionModeSchema),
  availableModels: z.array(modelCatalogItemSchema),
})

export type SessionRuntimeResponse = z.infer<typeof sessionRuntimeResponseSchema>

export const createTurnResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  userMessageUuid: z.string(),
})

export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>
