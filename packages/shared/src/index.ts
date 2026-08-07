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
  sessionChanges: z.array(z.object({
    projectId: z.string(),
    sessionId: z.string(),
    kind: z.enum(['changed', 'removed']),
  })),
})

export type ListVersionsEvent = z.infer<typeof listVersionsEventSchema>

export const sessionRunStateSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('idle'),
    activeUserMessageUuid: z.null(),
    lastTurn: z.object({
      id: z.string(),
      outcome: z.enum(['success', 'error']),
    }).optional(),
  }),
  z.object({
    phase: z.literal('running'),
    activeUserMessageUuid: z.string(),
    lastTurn: z.null().optional(),
  }),
  z.object({
    phase: z.literal('requires_action'),
    activeUserMessageUuid: z.string(),
    lastTurn: z.null().optional(),
  }),
])

export type SessionRunState = z.infer<typeof sessionRunStateSchema>

export const sessionStatusSchema = z.enum(['idle', 'busy', 'waiting'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  lastActivityAt: z.number().optional(),
  status: sessionStatusSchema,
  hasRunningShell: z.boolean().optional(),
  kind: z.string().nullable(),
  entrypoint: z.string().nullable(),
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

export const renameSessionRequestSchema = z.object({
  title: z.string().trim().min(1),
})
export type RenameSessionRequest = z.infer<typeof renameSessionRequestSchema>

export const renameSessionResponseSchema = z.object({
  ok: z.literal(true),
})
export type RenameSessionResponse = z.infer<typeof renameSessionResponseSchema>

export const forkSessionRequestSchema = z.object({
  upToMessageId: z.string().uuid().optional(),
})
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>

export const forkSessionResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
})
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>

export const deleteSessionRequestSchema = z.object({
  confirmationSessionId: z.string().trim().min(1),
})
export type DeleteSessionRequest = z.infer<typeof deleteSessionRequestSchema>

export const deleteSessionResponseSchema = z.object({
  ok: z.literal(true),
})
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>

export const projectDirectoriesResponseSchema = z.object({
  parent: z.string(),
  directories: z.array(z.object({
    name: z.string(),
    path: z.string(),
  })),
})

export type ProjectDirectoriesResponse = z.infer<typeof projectDirectoriesResponseSchema>

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

export const rawSessionMessageSchema = z.unknown()
export type RawSessionMessage = z.infer<typeof rawSessionMessageSchema>

export const turnSummarySchema = z.object({
  primaryUserUuid: z.string(),
  primaryUserTimestampMs: z.number().optional(),
  durationMs: z.number().optional(),
  durationTimestampMs: z.number().optional(),
  pendingBackgroundAgentCount: z.number().int().nonnegative().optional(),
  awaySummary: z.string().nullable().optional(),
  messages: z.array(rawSessionMessageSchema),
})

export type TurnSummary = z.infer<typeof turnSummarySchema>

export const sessionTimelineStateSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  version: z.string(),
  signature: z.string(),
  fileSize: z.number().optional(),
  generatedAt: z.number(),
})

export type SessionTimelineState = z.infer<typeof sessionTimelineStateSchema>

export const sessionTimelineStateResponseSchema = z.object({
  state: sessionTimelineStateSchema,
})

export type SessionTimelineStateResponse = z.infer<typeof sessionTimelineStateResponseSchema>

export const sessionTaskSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  subject: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  blockedBy: z.array(z.string()),
})

export type SessionTask = z.infer<typeof sessionTaskSchema>

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

export const sessionTimelineResponseSchema = z.object({
  sessionId: z.string(),
  turns: z.array(turnSummarySchema),
  tasks: z.array(sessionTaskSchema),
  sessionMeta: z.object({
    permissionMode: permissionModeSchema.nullable(),
    model: z.string().nullable(),
    effort: effortLevelSchema.nullable(),
  }),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  state: sessionTimelineStateSchema,
})

export type SessionTimelineResponse = z.infer<typeof sessionTimelineResponseSchema>

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
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message) || typeof value.message.content !== 'string') return false
  const content = value.message.content.trim()
  if (!/^<task-notification(?:\s[^>]*)?>[\s\S]*<\/task-notification>$/.test(content)) return false
  if (!tagText(content, 'task-id')) return false
  const originKind = timelineOriginKind(value)
  return originKind === 'task-notification' || (originKind == null && value.promptSource == null && timelineTaskNotificationToolUseId(value) !== undefined)
}

export function isPrimaryTimelineUserMessage(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message)) return false
  const message = value.message
  const originKind = timelineOriginKind(value)
  if (message.role !== 'user' || value.isSynthetic === true || value.shouldQuery === false || originKind === 'task-notification' || containsToolResult(message.content) || value.isSidechain === true) return false
  return originKind === 'human'
    || value.promptSource === 'typed'
    || value.promptSource === 'sdk'
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
}).passthrough()
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>

export const modelCatalogResponseSchema = z.object({
  models: z.array(modelCatalogItemSchema),
}).passthrough()
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>

export const sessionObservationEventKindSchema = z.enum(['snapshot', 'create', 'change', 'delete'])
export const sessionObservationSortSchema = z.enum([
  'id', 'eventKind', 'observedAtMs', 'fileName', 'filePath', 'filePid', 'fileMtimeMs', 'fileSizeBytes', 'rawJson', 'parseError',
  'payloadPid', 'procStart', 'sessionId', 'cwd', 'startedAtMs', 'updatedAtMs', 'statusUpdatedAtMs', 'version', 'peerProtocol',
  'kind', 'entrypoint', 'name', 'nameSource', 'status', 'waitingFor', 'tempo', 'state', 'detail', 'needs', 'agent',
  'messagingSocketPath', 'jobId', 'parkedJobId', 'bridgeSessionId', 'logPath', 'tmux', 'pidAlive', 'procStartMatches',
])
export type SessionObservationSort = z.infer<typeof sessionObservationSortSchema>

export const sessionObservationSchema = z.object({
  id: z.number().int(),
  eventKind: sessionObservationEventKindSchema,
  observedAtMs: z.number(),
  fileName: z.string(),
  filePath: z.string(),
  filePid: z.number().int().nullable(),
  fileMtimeMs: z.number().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  rawJson: z.string(),
  parseError: z.string().nullable(),
  payloadPid: z.number().int().nullable(),
  procStart: z.string().nullable(),
  sessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  startedAtMs: z.number().nullable(),
  updatedAtMs: z.number().nullable(),
  statusUpdatedAtMs: z.number().nullable(),
  version: z.string().nullable(),
  peerProtocol: z.number().int().nullable(),
  kind: z.string().nullable(),
  entrypoint: z.string().nullable(),
  name: z.string().nullable(),
  nameSource: z.string().nullable(),
  status: z.string().nullable(),
  waitingFor: z.string().nullable(),
  tempo: z.string().nullable(),
  state: z.string().nullable(),
  detail: z.string().nullable(),
  needs: z.string().nullable(),
  agent: z.string().nullable(),
  messagingSocketPath: z.string().nullable(),
  jobId: z.string().nullable(),
  parkedJobId: z.string().nullable(),
  bridgeSessionId: z.string().nullable(),
  logPath: z.string().nullable(),
  tmux: z.string().nullable(),
  pidAlive: z.boolean().nullable(),
  procStartMatches: z.boolean().nullable(),
})
export type SessionObservation = z.infer<typeof sessionObservationSchema>

export const sessionObservationsResponseSchema = z.object({
  observations: z.array(sessionObservationSchema),
  sessionIds: z.array(z.string().nullable()),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
  sort: sessionObservationSortSchema,
  direction: z.enum(['asc', 'desc']),
})
export type SessionObservationsResponse = z.infer<typeof sessionObservationsResponseSchema>

export const turnMetaTranscriptRowSchema = z.object({
  id: z.number().int(),
  projectKey: z.string(),
  transcriptPath: z.string(),
  sessionId: z.string(),
  primaryUserUuid: z.string(),
  primaryTimestampMs: z.number().int(),
  primaryByteOffset: z.number().int(),
  primaryEntrypoint: z.string().nullable(),
  permissionMode: permissionModeSchema.nullable(),
  model: z.string().nullable(),
  effort: effortLevelSchema.nullable(),
  awaySummary: z.string().nullable(),
  durationUuid: z.string().nullable(),
  durationParentUuid: z.string().nullable(),
  durationTimestampMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  durationMessageCount: z.number().int().nullable(),
  durationLineNo: z.number().int().nullable(),
  durationByteOffset: z.number().int().nullable(),
  durationByteLength: z.number().int().nullable(),
  durationIsSidechain: z.boolean().nullable(),
  durationIsMeta: z.boolean().nullable(),
  durationUserType: z.string().nullable(),
  durationEntrypoint: z.string().nullable(),
  durationCwd: z.string().nullable(),
  durationVersion: z.string().nullable(),
  durationGitBranch: z.string().nullable(),
  durationSlug: z.string().nullable(),
  durationPendingBackgroundAgentCount: z.number().int().nullable(),
  durationSessionKind: z.string().nullable(),
  durationForkedFromJson: z.string().nullable(),
  durationPendingWorkflowCount: z.number().int().nullable(),
  durationPayloadJson: z.string().nullable(),
  fileMtimeMs: z.number().int(),
  fileSize: z.number().int(),
  scanByteOffset: z.number().int(),
  scanLineNo: z.number().int(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
})
export type TurnMetaTranscriptRow = z.infer<typeof turnMetaTranscriptRowSchema>

export const turnMetaTranscriptResponseSchema = z.object({
  entries: z.array(turnMetaTranscriptRowSchema),
  sessionIds: z.array(z.string()),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
})
export type TurnMetaTranscriptResponse = z.infer<typeof turnMetaTranscriptResponseSchema>

export const sessionInfoResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  version: z.string(),
  signature: z.string(),
  generatedAt: z.number(),
  summary: z.string(),
  lastModified: z.number(),
  fileSize: z.number().optional(),
  customTitle: z.string().optional(),
  firstPrompt: z.string().optional(),
  gitBranch: z.string().optional(),
  cwd: z.string().optional(),
  tag: z.string().optional(),
  createdAt: z.number().optional(),
})
export type SessionInfoResponse = z.infer<typeof sessionInfoResponseSchema>

export const appSettingsSchema = z.object({
  defaultPermissionMode: permissionModeSchema.optional(),
  defaultModel: modelSelectionSchema.nullable().default(null),
  defaultEffort: effortLevelSchema.nullable().default(null),
  modelCatalog: modelCatalogResponseSchema.optional(),
  useOneMillionContext: z.boolean().default(true),
  showDebugNav: z.boolean().optional(),
}).catchall(z.unknown())
export type AppSettings = z.infer<typeof appSettingsSchema>

export const settingsResponseSchema = z.object({
  settings: appSettingsSchema,
})
export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const appSettingsUpdateSchema = z.object({
  defaultPermissionMode: permissionModeSchema.optional(),
  defaultModel: modelSelectionSchema.nullable().optional(),
  defaultEffort: effortLevelSchema.nullable().optional(),
  useOneMillionContext: z.boolean().optional(),
  showDebugNav: z.boolean().optional(),
}).refine(
  ({ defaultModel, defaultEffort }) => (defaultModel === undefined) === (defaultEffort === undefined),
  'defaultModel and defaultEffort must be updated together',
)
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>

export const settingsUpdateRequestSchema = z.object({
  settings: appSettingsUpdateSchema,
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

export const sessionMetaSchema = z.object({
  permissionMode: permissionModeSchema,
  model: modelSelectionSchema.nullable(),
  effort: effortLevelSchema.nullable(),
})
export type SessionMeta = z.infer<typeof sessionMetaSchema>

export const sessionMetaUpdateRequestSchema = z.object({
  permissionMode: permissionModeSchema.optional(),
  model: modelSelectionSchema.nullable().optional(),
  effort: effortLevelSchema.nullable().optional(),
}).refine(
  ({ model, effort }) => (model === undefined) === (effort === undefined),
  'model and effort must be updated together',
).refine(
  ({ permissionMode, model }) => permissionMode !== undefined || model !== undefined,
  'at least one session meta field must be updated',
)
export type SessionMetaUpdateRequest = z.infer<typeof sessionMetaUpdateRequestSchema>

export const createTurnRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  text: z.string().trim().min(1),
  userMessageUuid: z.string().uuid(),
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
})

export type SessionRuntimeResponse = z.infer<typeof sessionRuntimeResponseSchema>

export const createTurnResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  userMessageUuid: z.string(),
})

export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>
