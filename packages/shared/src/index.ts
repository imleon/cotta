import { normalizeUri } from 'micromark-util-sanitize-uri'
import { SaxesParser } from 'saxes'
import { z } from 'zod'

type BacktickFence = { length: number; info: string }

function backtickFence(line: string): BacktickFence | null {
  const match = line.replace(/\r$/, '').match(/^ {0,3}(`{3,})([^`]*)$/)
  return match ? { length: match[1].length, info: match[2].trim().split(/\s+/, 1)[0].toLowerCase() } : null
}

function backtickFenceClose(line: string, length: number): boolean {
  return new RegExp(`^ {0,3}\`{${length},}[ \\t]*\\r?$`).test(line)
}

function skipBacktickFence(lines: string[], start: number, length: number): number {
  for (let index = start + 1; index < lines.length; index += 1) if (backtickFenceClose(lines[index], length)) return index
  return lines.length - 1
}

function markdownPayloadFenceEnd(lines: string[], start: number, length: number): { end: number; nested: boolean } | null {
  let nested = false
  for (let index = start; index < lines.length; index += 1) {
    if (backtickFenceClose(lines[index], length)) return { end: index, nested }
    const fence = backtickFence(lines[index])
    if (fence) {
      nested = true
      index = skipBacktickFence(lines, index, fence.length)
    }
  }
  return null
}

/** Indices of the `\n`-separated lines unwrapMarkdownPayloadFences keeps — it only ever drops whole fence lines. */
export function markdownPayloadLineIndices(value: string): number[] {
  const lines = value.split('\n')
  const kept: number[] = []
  const keep = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) kept.push(index)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const fence = backtickFence(lines[index])
    if (!fence) {
      kept.push(index)
      continue
    }
    if (fence.info === 'md' || fence.info === 'markdown') {
      const end = markdownPayloadFenceEnd(lines, index + 1, fence.length)
      if (end?.nested) {
        keep(index + 1, end.end)
        index = end.end
        continue
      }
    }
    const end = skipBacktickFence(lines, index, fence.length)
    keep(index, end + 1)
    index = end
  }
  return kept
}

export function unwrapMarkdownPayloadFences(value: string): string {
  const lines = value.split('\n')
  return markdownPayloadLineIndices(value)
    .map((index) => lines[index])
    .join('\n')
}

export const normalizeMarkdownUri = normalizeUri

export function localImageDestinationPathname(destination: string): string | null {
  const separator = destination.search(/[?#]/)
  try {
    const pathname = decodeURIComponent(separator < 0 ? destination : destination.slice(0, separator))
    return pathname && !pathname.includes('\0') && !pathname.includes('\\') && !/^[A-Za-z]:/.test(pathname) && !/^(?:data|blob|https?):/i.test(pathname) ? pathname : null
  } catch {
    return null
  }
}

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
  worktreeName: z.string().optional(),
})

export type ProjectSummary = z.infer<typeof projectSummarySchema>

export const projectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type ProjectsResponse = z.infer<typeof projectsResponseSchema>

export const remotePlatformSchema = z.enum(['feishu', 'lark'])
export type RemotePlatform = z.infer<typeof remotePlatformSchema>
const remoteBotAppIdSchema = z
  .string()
  .trim()
  .regex(/^cli_[0-9a-fA-F]{16}$/)

const remoteBotScopeSchema = z
  .object({
    allProjects: z.boolean(),
    projectIds: z.array(z.string().min(1)),
  })
  .refine(({ allProjects, projectIds }) => (allProjects ? projectIds.length === 0 : projectIds.length > 0) && new Set(projectIds).size === projectIds.length)

export const remoteBotSchema = z
  .object({
    botId: z.string(),
    platform: remotePlatformSchema,
    appId: z.string(),
    ...remoteBotScopeSchema.shape,
    enabled: z.boolean(),
    hasSecret: z.boolean(),
    paired: z.boolean(),
    pairedUserName: z.string().nullable(),
    pairedUserAvatarUrl: z.string().nullable(),
    connectionStatus: z.enum(['disabled', 'unpaired', 'connecting', 'connected', 'error']),
  })
  .refine(({ allProjects, projectIds }) => remoteBotScopeSchema.safeParse({ allProjects, projectIds }).success)
export type RemoteBot = z.infer<typeof remoteBotSchema>

export const remoteBotsResponseSchema = z.object({ bots: z.array(remoteBotSchema) })
export type RemoteBotsResponse = z.infer<typeof remoteBotsResponseSchema>

export const createRemoteBotRequestSchema = z
  .object({
    platform: remotePlatformSchema,
    appId: remoteBotAppIdSchema,
    appSecret: z.string().trim().min(1),
    ...remoteBotScopeSchema.shape,
    enabled: z.boolean().optional(),
  })
  .refine(({ allProjects, projectIds }) => remoteBotScopeSchema.safeParse({ allProjects, projectIds }).success)
export type CreateRemoteBotRequest = z.infer<typeof createRemoteBotRequestSchema>

export const updateRemoteBotRequestSchema = z
  .object({
    platform: remotePlatformSchema.optional(),
    appId: remoteBotAppIdSchema.optional(),
    appSecret: z.string().optional(),
    allProjects: z.boolean().optional(),
    projectIds: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(({ allProjects, projectIds }, context) => {
    if ((allProjects === undefined) !== (projectIds === undefined)) context.addIssue({ code: 'custom', message: 'allProjects and projectIds must be provided together' })
    else if (allProjects !== undefined && !remoteBotScopeSchema.safeParse({ allProjects, projectIds }).success) context.addIssue({ code: 'custom', message: 'invalid project scope' })
  })
export type UpdateRemoteBotRequest = z.infer<typeof updateRemoteBotRequestSchema>

export const remoteBotResponseSchema = z.object({ bot: remoteBotSchema })
export type RemoteBotResponse = z.infer<typeof remoteBotResponseSchema>
export const remoteBotBindRequestSchema = z.object({
  chatId: z
    .string()
    .trim()
    .regex(/^oc_[0-9a-zA-Z]+$/),
})
export type RemoteBotBindRequest = z.infer<typeof remoteBotBindRequestSchema>
export const remoteBotResolveResponseSchema = z.object({ name: z.string(), avatarUrl: z.string().nullable() })
export type RemoteBotResolveResponse = z.infer<typeof remoteBotResolveResponseSchema>
export const remoteBotMutationResponseSchema = z.object({ ok: z.literal(true) })
export type RemoteBotMutationResponse = z.infer<typeof remoteBotMutationResponseSchema>

export const listVersionsEventSchema = z.object({
  epoch: z.string().uuid(),
  projectsVersion: z.number().int().nonnegative(),
  projectVersions: z.array(
    z.object({
      projectId: z.string(),
      version: z.number().int().nonnegative(),
    }),
  ),
  sessionVersions: z.array(
    z.object({
      projectId: z.string(),
      sessionId: z.string(),
      version: z.string(),
      snapshot: z.boolean().optional(),
    }),
  ),
  subagentVersions: z.array(
    z.object({
      projectId: z.string(),
      sessionId: z.string(),
      version: z.number().int().nonnegative(),
      snapshot: z.boolean().optional(),
    }),
  ),
  sessionChanges: z.array(
    z.union([
      z.object({
        projectId: z.string(),
        sessionId: z.string(),
        kind: z.literal('changed'),
        version: z.string(),
        reset: z.literal(false),
        invalidateFromTurnId: z.string().nullable(),
      }),
      z.object({
        projectId: z.string(),
        sessionId: z.string(),
        kind: z.literal('changed'),
        version: z.string(),
        reset: z.literal(true),
        invalidateFromTurnId: z.null(),
      }),
      z.object({
        projectId: z.string(),
        sessionId: z.string(),
        kind: z.literal('removed'),
      }),
    ]),
  ),
})

export type ListVersionsEvent = z.infer<typeof listVersionsEventSchema>

const permissionUpdateDestinationSchema = z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
const permissionRuleSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
})
const permissionRulesUpdateSchema = z.object({
  type: z.enum(['addRules', 'replaceRules', 'removeRules']),
  rules: z.array(permissionRuleSchema),
  behavior: z.enum(['allow', 'deny', 'ask']),
  destination: permissionUpdateDestinationSchema,
})
const permissionDirectoriesUpdateSchema = z.object({
  type: z.enum(['addDirectories', 'removeDirectories']),
  directories: z.array(z.string()),
  destination: permissionUpdateDestinationSchema,
})
export const permissionUpdateSchema = z.union([
  permissionRulesUpdateSchema,
  z.object({ type: z.literal('setMode'), mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']), destination: permissionUpdateDestinationSchema }),
  permissionDirectoriesUpdateSchema,
])
export type PermissionUpdate = z.infer<typeof permissionUpdateSchema>

export const toolApprovalRequestSchema = z.object({
  requestId: z.string(),
  toolUseID: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  suggestions: z.array(permissionUpdateSchema).optional(),
})
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>

// Shared permission/question copy derivation, used by both the Web composer and the Lark card.
function approvalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function permissionModeLabel(value: string): string {
  if (value === 'acceptEdits') return 'accept edits'
  if (value === 'bypassPermissions') return 'bypass permissions'
  if (value === 'dontAsk') return 'don’t ask'
  return value
}

function permissionDestinationLabel(value: unknown): string {
  if (value === 'session') return 'for this session'
  if (value === 'userSettings') return 'in user settings'
  if (value === 'projectSettings') return 'in project settings'
  if (value === 'localSettings') return 'in local settings'
  if (value === 'cliArg') return 'from CLI arguments'
  return ''
}

function permissionRuleList(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const rules = value.flatMap((rule) => {
    const item = approvalRecord(rule)
    if (!item || typeof item.toolName !== 'string') return []
    return item.ruleContent ? `${item.toolName} ${item.ruleContent}` : item.toolName
  })
  return rules.length > 0 ? rules.join(', ') : null
}

function permissionDirectoryList(value: unknown): string | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).join(', ') || null : null
}

export function approvalSuggestionLabel(value: unknown): string {
  const suggestion = approvalRecord(value)
  const destination = permissionDestinationLabel(suggestion?.destination)
  const suffix = destination ? ` ${destination}` : ''
  if (suggestion?.type === 'setMode' && typeof suggestion.mode === 'string') return `Yes, and switch to ${permissionModeLabel(suggestion.mode)}${suffix}`
  if ((suggestion?.type === 'addRules' || suggestion?.type === 'replaceRules' || suggestion?.type === 'removeRules') && typeof suggestion.behavior === 'string') {
    const rules = permissionRuleList(suggestion.rules)
    const verb = suggestion.type === 'addRules' ? 'add' : suggestion.type === 'replaceRules' ? 'replace' : 'remove'
    return `Yes, and ${verb} ${suggestion.behavior} rules${rules ? ` for ${rules}` : ''}${suffix}`
  }
  if (suggestion?.type === 'addDirectories' || suggestion?.type === 'removeDirectories') {
    const directories = permissionDirectoryList(suggestion.directories)
    return `Yes, and ${suggestion.type === 'addDirectories' ? 'add' : 'remove'} directories${directories ? ` ${directories}` : ''}${suffix}`
  }
  return 'Yes, and apply suggested permission change'
}

function approvalPathBaseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? value
}

export function approvalTarget(approval: ToolApprovalRequest): string | null {
  if (approval.description) return approval.description
  const filePath = approval.input.file_path
  return typeof filePath === 'string' && filePath ? approvalPathBaseName(filePath) : null
}

export function approvalTitle(approval: ToolApprovalRequest): string {
  if (approval.toolName === 'ExitPlanMode') return 'Claude has written up a plan and is ready to execute. Would you like to proceed?'
  if (approval.title) return approval.title
  const target = approvalTarget(approval)
  if (approval.toolName === 'Edit' && target) return `Do you want to make this edit to ${target}?`
  if (approval.toolName === 'Write' && target) return `Do you want to write to ${target}?`
  if (approval.toolName === 'Read') return target ? `Do you want to allow reading ${target}?` : 'Do you want to allow this file read?'
  if (approval.toolName === 'Glob' || approval.toolName === 'Grep') return 'Do you want to allow this file search?'
  if (approval.toolName === 'Bash') return 'Do you want to run this command?'
  if (approval.toolName === 'WebFetch') return 'Do you want to fetch this URL?'
  return `Do you want to allow ${approval.displayName ?? approval.toolName}?`
}

export function approvalDescription(approval: ToolApprovalRequest, title: string): string | null {
  return approval.description && !title.includes(approval.description) ? approval.description : null
}

export const sessionRunStateSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('idle'),
    activeUserMessageUuid: z.null(),
    lastTurn: z
      .object({
        id: z.string(),
        outcome: z.enum(['success', 'error']),
      })
      .optional(),
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
    pendingPermission: toolApprovalRequestSchema.optional(),
  }),
])

export type SessionRunState = z.infer<typeof sessionRunStateSchema>

export const sessionStatusSchema = z.enum(['idle', 'busy', 'waiting', 'background'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionActivitySchema = z.object({
  owner: z.enum(['cotta', 'external']).nullable(),
  phase: sessionStatusSchema,
  activeTurnId: z.string().nullable(),
})
export type SessionActivity = z.infer<typeof sessionActivitySchema>

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  lastActivityAt: z.number().optional(),
  occupiedBy: z.enum(['cotta', 'external']).nullable(),
  occupiedStatus: sessionStatusSchema,
  lastTurnOutcome: z.enum(['success', 'error']).optional(),
  hasRunningShell: z.boolean().optional(),
  hasRuntime: z.boolean().optional(),
  kind: z.string().nullable(),
  currentCwd: z.string().nullable().optional(),
  lastPrompt: z.string().nullable().optional(),
})

export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const sessionPinSchema = z.object({
  pinnedAtMs: z.number().int().nonnegative(),
  project: projectSummarySchema,
  session: sessionSummarySchema,
})
export type SessionPin = z.infer<typeof sessionPinSchema>

export const sessionPinsResponseSchema = z.object({ pins: z.array(sessionPinSchema) })
export type SessionPinsResponse = z.infer<typeof sessionPinsResponseSchema>

export const sessionPinUpdateRequestSchema = z.object({ pinned: z.boolean() })
export const sessionPinUpdateResponseSchema = z.object({ ok: z.literal(true) })
export type SessionPinUpdateResponse = z.infer<typeof sessionPinUpdateResponseSchema>

export const gitFileStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored', 'conflicted'])
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>

export const projectFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative().optional(),
  gitStatus: gitFileStatusSchema.optional(),
})
export type ProjectFileEntry = z.infer<typeof projectFileEntrySchema>

export const projectFilesResponseSchema = z.object({
  path: z.string(),
  entries: z.array(projectFileEntrySchema),
  truncated: z.boolean(),
  gitStatusTruncated: z.boolean(),
})
export type ProjectFilesResponse = z.infer<typeof projectFilesResponseSchema>

export const projectFileResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  revision: z.string(),
})
export type ProjectFileResponse = z.infer<typeof projectFileResponseSchema>

export const structuredPatchHunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(z.string()),
})
export type StructuredPatchHunk = z.infer<typeof structuredPatchHunkSchema>

export const projectFileChangeSchema = z.object({
  path: z.string(),
  status: gitFileStatusSchema,
})
export type ProjectFileChange = z.infer<typeof projectFileChangeSchema>

export const projectGitWorktreeSchema = z.object({ path: z.string(), name: z.string().optional() })
export type ProjectGitWorktree = z.infer<typeof projectGitWorktreeSchema>

export const projectFilesGitResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), changes: z.array(projectFileChangeSchema), truncated: z.boolean(), branch: z.string().nullable(), worktree: projectGitWorktreeSchema.nullable() }),
  z.object({ available: z.literal(false), reason: z.enum(['not_git_repository', 'git_unavailable']) }),
])
export type ProjectFilesGitResponse = z.infer<typeof projectFilesGitResponseSchema>

export const projectFileDiffResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), path: z.string(), hunks: z.array(structuredPatchHunkSchema), truncated: z.boolean() }),
  z.object({ kind: z.literal('conflicted'), path: z.string() }),
  z.object({ kind: z.literal('deleted'), path: z.string() }),
  z.object({ kind: z.literal('untracked'), path: z.string() }),
])
export type ProjectFileDiffResponse = z.infer<typeof projectFileDiffResponseSchema>

export const projectFilesVersionEventSchema = z.object({ projectId: z.string(), version: z.number().int().nonnegative(), snapshot: z.boolean().optional(), contentOnly: z.literal(true).optional() })
export type ProjectFilesVersionEvent = z.infer<typeof projectFilesVersionEventSchema>

export const renameSessionRequestSchema = z.object({
  title: z.string().trim().min(1),
})

export const renameSessionResponseSchema = z.object({
  ok: z.literal(true),
})
export type RenameSessionResponse = z.infer<typeof renameSessionResponseSchema>

export const forkSessionRequestSchema = z.object({
  upToMessageId: z.string().trim().min(1).optional(),
})

export const forkSessionResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
})
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>

export const deleteSessionRequestSchema = z.object({
  confirmationSessionId: z.string().trim().min(1),
})

export const deleteSessionResponseSchema = z.object({
  ok: z.literal(true),
})
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>

export const projectSessionsResponseSchema = z.object({
  project: projectSummarySchema,
  sessions: z.array(sessionSummarySchema),
  defaultSessionId: z.string().nullable(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export type ProjectSessionsResponse = z.infer<typeof projectSessionsResponseSchema>

export const projectSessionsQuerySchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      limit: z.number().int().positive().max(10_000),
      selectedSessionId: z.string().optional(),
    }),
  ),
})

export const rawSessionTaskSchema = z.object({
  id: z.string(),
  subject: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  blockedBy: z.array(z.string()),
})
export type RawSessionTask = z.infer<typeof rawSessionTaskSchema>

export const COOKING_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  "Beboppin'",
  'Befuddling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Bunning',
  'Burrowing',
  'Calculating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Cerebrating',
  'Channeling',
  'Channelling',
  'Choreographing',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Dilly-dallying',
  'Discombobulating',
  'Doing',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Envisioning',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambéing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Gitifying',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honking',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Ionizing',
  'Jitterbugging',
  'Julienning',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Metamorphosing',
  'Misting',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Nebulizing',
  'Nesting',
  'Newspapering',
  'Noodling',
  'Nucleating',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Photosynthesizing',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Processing',
  'Proofing',
  'Propagating',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Recombobulating',
  'Reticulating',
  'Roosting',
  'Ruminating',
  'Sautéing',
  'Scampering',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Sublimating',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Working',
  'Wrangling',
  'Zesting',
  'Zigzagging',
] as const
export const TURN_DONE_VERBS = ['Thought', 'Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'] as const

export function stableVerb<T extends readonly string[]>(turnId: string, verbs: T): T[number] {
  let hash = 0
  for (const char of turnId) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return verbs[Math.abs(hash) % verbs.length]!
}

export function stableTurnVerb(turnId: string): string {
  return stableVerb(turnId, TURN_DONE_VERBS)
}

export function timelineToolIsHidden(name: string, hasError: boolean): boolean {
  return ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(name) || (!hasError && (name === 'TodoWrite' || name === 'ListAgents'))
}

export function turnCookingLabel(turnId: string): string {
  return `${stableVerb(turnId, COOKING_VERBS)}…`
}

export function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s` : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}

export function turnPendingAgentLabel(turn: Pick<TurnSummary, 'pendingBackgroundAgentCount'>): string | null {
  const pending = turn.pendingBackgroundAgentCount ?? 0
  return pending > 0 ? `Waiting for ${pending} background ${pending === 1 ? 'task' : 'tasks'} to finish` : null
}

export function turnDurationLabel(turn: Pick<TurnSummary, 'primaryUserUuid' | 'durationMs' | 'pendingBackgroundAgentCount'>): string | null {
  return turnPendingAgentLabel(turn) ?? (turn.durationMs === undefined ? null : `${stableTurnVerb(turn.primaryUserUuid)} for ${formatTurnDuration(turn.durationMs)}`)
}

export function turnActiveTaskLabel(tasks: readonly RawSessionTask[] | null | undefined): string | undefined {
  const task = tasks?.find((item) => item.status === 'in_progress')
  return task ? `${(task.activeForm?.trim() || task.subject).replace(/(?:\.\.\.|…)$/, '')}…` : undefined
}

export const projectSessionsWindowSchema = z.object({
  project: projectSummarySchema.optional(),
  sessions: z.array(sessionSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  selectedSessionExists: z.boolean().optional(),
  selectedSessionDetail: sessionSummarySchema.nullable().optional(),
})

export type ProjectSessionsWindow = z.infer<typeof projectSessionsWindowSchema>

export const projectSessionsQueryResponseSchema = z.object({
  sessionsByProject: z.record(z.string(), projectSessionsWindowSchema),
})

export type ProjectSessionsQueryResponse = z.infer<typeof projectSessionsQueryResponseSchema>

export const projectSessionSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  cursor: z.string().trim().min(1).optional(),
})
export type ProjectSessionSearchRequest = z.infer<typeof projectSessionSearchRequestSchema>

export const projectSessionSearchMatchFieldSchema = z.enum(['title', 'sessionId', 'cwd', 'gitBranch', 'user', 'assistant'])
export type ProjectSessionSearchMatchField = z.infer<typeof projectSessionSearchMatchFieldSchema>

export const projectSessionSearchMatchRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((value) => value.end > value.start, { message: 'search match range end must be greater than start' })
export type ProjectSessionSearchMatchRange = z.infer<typeof projectSessionSearchMatchRangeSchema>

export const projectSessionSearchLocatorSchema = z.object({
  turnId: z.string(),
  messageUuid: z.string(),
  blockIndex: z.number().int().nonnegative(),
})
export type ProjectSessionSearchLocator = z.infer<typeof projectSessionSearchLocatorSchema>

export const projectSessionSearchMatchSchema = z.object({
  field: projectSessionSearchMatchFieldSchema,
  snippet: z.string(),
  ranges: z.array(projectSessionSearchMatchRangeSchema),
  messageTimestampMs: z.number().int().nonnegative().optional(),
  locator: projectSessionSearchLocatorSchema.optional(),
})
export type ProjectSessionSearchMatch = z.infer<typeof projectSessionSearchMatchSchema>

export const projectSessionSearchResultSchema = z.object({
  project: projectSummarySchema,
  session: sessionSummarySchema,
  matches: z.array(projectSessionSearchMatchSchema),
  messageMatchCount: z.number().int().nonnegative(),
  truncatedMatches: z.boolean(),
})
export type ProjectSessionSearchResult = z.infer<typeof projectSessionSearchResultSchema>

export const projectSessionSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(projectSessionSearchResultSchema),
  totalSessions: z.number().int().nonnegative(),
  totalMatches: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})
export type ProjectSessionSearchResponse = z.infer<typeof projectSessionSearchResponseSchema>

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

export const sessionRawTranscriptLineSchema = z.object({
  session_id: z.string(),
  byte_offset: z.number().int().nonnegative(),
  byte_length: z.number().int().positive(),
  line_no: z.number().int().positive(),
  uuid: z.string().nullable(),
  type: z.string().nullable(),
  timestamp_ms: z.number().int().nullable(),
  parent_uuid: z.string().nullable(),
  is_sidechain: z.number().int().nullable(),
  user_type: z.string().nullable(),
  entrypoint: z.string().nullable(),
  cwd: z.string().nullable(),
  version: z.string().nullable(),
  git_branch: z.string().nullable(),
  owner_turn_id: z.string().nullable(),
  raw_json: z.string(),
  created_at_ms: z.number().int().nonnegative(),
})
export type SessionRawTranscriptLine = z.infer<typeof sessionRawTranscriptLineSchema>

export const turnSummarySchema = z.object({
  primaryUserUuid: z.string(),
  primaryUserTimestampMs: z.number().optional(),
  userCwd: z.string().optional(),
  responseCwd: z.string().optional(),
  durationMs: z.number().optional(),
  durationTimestampMs: z.number().optional(),
  entrypoint: z.string().optional(),
  pendingBackgroundAgentCount: z.number().int().nonnegative().optional(),
  subagentCount: z.number().int().nonnegative().optional(),
  awaySummary: z.string().nullable().optional(),
  shareEligible: z.boolean().optional(),
  messages: z.array(rawSessionMessageSchema),
})

export type TurnSummary = z.infer<typeof turnSummarySchema>

/** Anonymous Turn Detail payload: a single source Turn plus the viewer-facing render context. No project/session/control identity. */
export const detailResponseSchema = z.object({
  turn: turnSummarySchema,
})
export type DetailResponse = z.infer<typeof detailResponseSchema>

/** One active share in the authenticated management list. Enrichment fields are derived from the stored snapshot (and the session index for the title) — absent when unavailable. */
export const shareSummarySchema = z.object({
  token: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  createdAtMs: z.number(),
  sessionTitle: z.string().optional(),
  projectName: z.string().optional(),
  promptPreview: z.string().optional(),
  awaySummary: z.string().optional(),
  entrypoint: z.string().optional(),
})
export type ShareSummary = z.infer<typeof shareSummarySchema>

export const shareListResponseSchema = z.object({
  shares: z.array(shareSummarySchema),
  nextCursor: z.string().nullable(),
})
export type ShareListResponse = z.infer<typeof shareListResponseSchema>

export const createShareResponseSchema = z.object({ token: z.string() })
export type CreateShareResponse = z.infer<typeof createShareResponseSchema>

/** Extracts plain text from a raw user/assistant message's content (string, or array of blocks — text blocks only). */
function conversationText(message: unknown): string | null {
  if (!isRecord(message)) return null
  const inner = isRecord(message.message) ? message.message : null
  if (!inner) return null
  const content = inner.content
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join('\n\n')
  return text || null
}

// Markdown image syntax ![alt](dest) / ![alt](<dest>) — used to drop local images while keeping remote URLs.
const markdownImage = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g

function stripLocalImages(markdown: string): string {
  return markdown.replace(markdownImage, (match, _alt, dest) => (localImageDestinationPathname(String(dest)) === null ? match : ''))
}

/**
 * Byte-identical conversation projection for public export (Copy / Download Markdown).
 * Timeline order, user + assistant conversational text only — no thinking, tools, subagents, or operational items.
 * Keeps remote image URLs in the prose; drops local images.
 */
export function projectTurnMarkdown(turn: TurnSummary): string {
  const parts: string[] = []
  for (const message of turn.messages) {
    if (!isRecord(message) || (message.type !== 'user' && message.type !== 'assistant')) continue
    if (message.type === 'user' && 'isSynthetic' in message && message.isSynthetic === true) continue
    const text = conversationText(message)
    if (text) parts.push(stripLocalImages(unwrapMarkdownPayloadFences(text)).trim())
  }
  return parts.filter(Boolean).join('\n\n')
}

/** First real user prompt text of a Turn, single-lined and trimmed — the human-readable label for a share. Null when the Turn has no user prose. */
export function turnPromptPreview(turn: TurnSummary): string | null {
  for (const message of turn.messages) {
    if (!isRecord(message) || message.type !== 'user') continue
    if ('isSynthetic' in message && message.isSynthetic === true) continue
    const text = conversationText(message)
    if (text) return stripLocalImages(unwrapMarkdownPayloadFences(text)).replace(/\s+/g, ' ').trim() || null
  }
  return null
}

// --- Share snapshot pruning -------------------------------------------------
// A shared Turn is rendered collapsed: every tool/thinking disclosure shows only its header. So the snapshot only needs
// the fields those headers read; all bodies (file contents, command output, prompts, diffs, thinking text) are dropped.
// This is a privacy boundary, not an optimization: whatever stays here is readable at GET /api/share/:token. Headers are
// still rendered by the web tool views, so some fields can't be deleted — a missing shape flips a header to "ERROR" or
// loses its path/counts. Those keep a shape-preserving placeholder instead. The parity test in apps/web asserts every
// tool header is byte-identical before and after pruning. New tools default to the generic prune (name + title key only).

/** Line count of a file blob: a trailing newline does not count as a line. */
export function contentLineCount(value: string): number {
  if (value.length === 0) return 0
  const lines = value.split(/\r\n|\r|\n/)
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

/** A single `+`/`-`/context line, truncated to its first character so patchLineCounts still sums +N/-M but no text leaks. */
function prunePatchLines(lines: unknown): string[] {
  return Array.isArray(lines) ? lines.map((line) => (typeof line === 'string' ? line.slice(0, 1) : '')) : []
}

/** Prunes one Edit/Write/overwrite structuredPatch to the shape fileMutationResult accepts, keeping only +/- counts. */
function pruneStructuredPatch(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((hunk) =>
    isRecord(hunk) ? { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: prunePatchLines(hunk.lines) } : hunk,
  ) as Array<Record<string, unknown>>
}

/** The input keys each tool's collapsed header reads. Everything else in `input` is body-only and dropped. */
const SHARE_INPUT_KEYS: Record<string, string[]> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path', 'content'],
  Bash: ['command', 'description', 'run_in_background', 'dangerouslyDisableSandbox'],
  Agent: ['subagent_type', 'description'],
  Skill: ['skill'],
  SendMessage: ['to'],
  AskUserQuestion: ['questions'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  TaskOutput: ['task_id'],
  TaskStop: ['task_id', 'shell_id'],
  ExitPlanMode: ['planFilePath'],
  Glob: ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description'],
  Grep: ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description'],
}

/**
 * Tool names whose Share header reads a toolUseResult shape, so pruneToolUseResult must keep a skeleton for them.
 * The web guardrail test cross-checks this against the tool dispatch so a new result-dependent tool can't silently
 * fall through to `{}` and flip its header to ERROR. EnterPlanMode reads only results.length, so it needs no skeleton.
 */
export const SHARE_RESULT_SHAPE_TOOLS = ['Read', 'Edit', 'Write', 'Agent', 'SendMessage', 'WebSearch', 'TaskOutput', 'TaskStop'] as const

/** Tool names the Share snapshot prunes with a per-tool input whitelist (vs. the generic toolInputSummary fallback). */
export function shareWhitelistedTools(): string[] {
  return Object.keys(SHARE_INPUT_KEYS)
}
// Fallback: a generic/unknown tool header shows toolInputSummary, which scans these keys in order then any primitive.
const SHARE_GENERIC_INPUT_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']

/** Keeps only the AskUserQuestion `header` of each question; question/options text is body-only. */
function pruneQuestions(value: unknown): unknown {
  return Array.isArray(value) ? value.map((q) => (isRecord(q) ? { header: q.header } : q)) : value
}

const SHARE_PRIMITIVE = (value: unknown): boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/**
 * Prunes a non-whitelisted tool's input. An mcp__server__tool header renders no input at all, so keep nothing. Every
 * other unknown tool's header shows toolInputSummary — at most one `key: value` primitive — so keep only that one field
 * (the key toolInputSummary would pick), dropping all other arguments. A tool with no primitive field keeps nothing;
 * its generic header then previews `{}` instead of 72 chars of raw JSON, a deliberate trade of exact parity for no leak.
 */
function pruneGenericToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (/^mcp__/.test(name)) return {}
  const key = SHARE_GENERIC_INPUT_KEYS.find((candidate) => SHARE_PRIMITIVE(input[candidate])) ?? Object.keys(input).find((candidate) => SHARE_PRIMITIVE(input[candidate]))
  return key ? { [key]: input[key] } : {}
}

/** Prunes a tool_use `input` to the keys its header needs, with paths already relativized upstream. */
function pruneToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const whitelist = SHARE_INPUT_KEYS[name]
  if (!whitelist) return pruneGenericToolInput(name, input)
  const next: Record<string, unknown> = {}
  for (const key of whitelist) {
    if (!(key in input)) continue
    if (name === 'Write' && key === 'content') next[key] = typeof input[key] === 'string' ? '' : input[key]
    else if (name === 'AskUserQuestion' && key === 'questions') next[key] = pruneQuestions(input[key])
    else next[key] = input[key]
  }
  return next
}

/** Prunes the shared `toolUseResult` to the skeleton each header checks; drops stdout/content/prompts/answers. */
function pruneToolUseResult(name: string, output: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'Read':
      return isRecord(output.file) && output.type === 'text' && typeof output.file.content === 'string'
        ? { type: 'text', file: { filePath: output.file.filePath, content: '\n'.repeat(contentLineCount(output.file.content)) } }
        : {}
    case 'Edit':
      return { structuredPatch: pruneStructuredPatch(output.structuredPatch) }
    case 'Write':
      return output.type === 'create' && typeof output.content === 'string'
        ? { type: 'create', content: '\n'.repeat(contentLineCount(output.content)), structuredPatch: pruneStructuredPatch(output.structuredPatch) }
        : { structuredPatch: pruneStructuredPatch(output.structuredPatch) }
    case 'Agent':
      return { isAsync: output.isAsync === true }
    case 'SendMessage':
      return { success: output.success }
    case 'WebSearch':
      return { results: Array.isArray(output.results) ? [] : output.results }
    case 'TaskOutput':
      // taskOutputValue requires a `task` record first; without one the live header is ERROR. Keep a timeout stub, or a
      // well-formed stub only when the original had a valid `task`, so a malformed result stays ERROR in the snapshot too.
      if (output.retrieval_status === 'timeout') return { retrieval_status: 'timeout', task: {} }
      return isRecord(output.task) && typeof output.task.prompt === 'string' && typeof output.task.result === 'string' ? { task: { prompt: '', result: '' } } : {}
    default:
      // SendMessage/TaskStop/etc. only test presence or a boolean; an empty record preserves that without any body.
      return {}
  }
}

/** Maps tool_use_id → tool name across a turn, so a tool_result's result can be pruned by the tool it answers. */
function toolNamesByUseId(messages: unknown[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    const content = isRecord(message) && isRecord(message.message) ? message.message.content : null
    if (!Array.isArray(content)) continue
    for (const block of content) if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') names.set(block.id, block.name)
  }
  return names
}

/** Shortens an assistant thinking block's text to one character: non-empty keeps coalescing/framing, but no text leaks. */
function pruneThinkingText(text: unknown): string {
  return typeof text === 'string' && text.length > 0 ? text.slice(0, 1) : '…'
}

/** Whether a tool_result content blob renders (mirrors the web contentBlockIsRenderable image/text rules). */
function shareResultIsRenderable(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some(shareResultIsRenderable)
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string' && value.text.trim().length > 0
  if (value.type !== 'image') return true
  return isRecord(value.source) && typeof (value.source as Record<string, unknown>).data === 'string'
}

/**
 * Prunes a share snapshot in place (operate on an already-cloned Turn) to only the fields the collapsed Share headers
 * read: tool_use `input` is cut to its header keys, `toolUseResult` to a shape-preserving skeleton, thinking text to one
 * character, and tool_result `content` is dropped (Read keeps only a renderable/unsupported placeholder its header needs).
 * Top-level conversational `message.content` strings are left intact so projectTurnMarkdown export is unchanged.
 * Always-visible primary user and assistant text blocks are kept in full.
 */
export function pruneShareSnapshot(turn: TurnSummary): void {
  const names = toolNamesByUseId(turn.messages)
  for (const message of turn.messages) {
    if (!isRecord(message) || !isRecord(message.message)) continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_use' && typeof block.name === 'string' && isRecord(block.input)) block.input = pruneToolInput(block.name, block.input)
      else if (block.type === 'thinking') block.thinking = pruneThinkingText(block.thinking)
      else if (block.type === 'tool_result') {
        const name = typeof block.tool_use_id === 'string' ? names.get(block.tool_use_id) : undefined
        if (name && isRecord(timelineToolUseResult(message))) {
          const pruned = pruneToolUseResult(name, timelineToolUseResult(message) as Record<string, unknown>)
          if (Object.hasOwn(message, 'tool_use_result')) message.tool_use_result = pruned
          if (Object.hasOwn(message, 'toolUseResult')) message.toolUseResult = pruned
        }
        // Only the Read header reads content (image vs unsupported); keep a placeholder matching that flag, drop everything else.
        if ('content' in block) block.content = name === 'Read' && shareResultIsRenderable(block.content) ? [{ type: 'text', text: 'x' }] : []
      }
    }
  }
}

/** UTC export base name for a turn: turn-YYYYMMDDTHHMMSSZ (no extension). */
export function turnExportFilename(turn: TurnSummary): string {
  const ms = turn.primaryUserTimestampMs ?? turn.durationTimestampMs ?? Date.now()
  const stamp = new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `turn-${stamp}`
}

export function hasTerminalEvidence(turn: TurnSummary): boolean {
  return turn.durationMs !== undefined || turn.messages.some((message) => isRecord(message) && (message.type === 'result' || message.type === 'cotta_live_turn_failed'))
}

export function effectiveActiveTurnId(activity: SessionActivity, latestTurn?: TurnSummary): string | null {
  if (activity.activeTurnId !== null) return activity.activeTurnId
  return activity.owner === 'external' && activity.phase === 'busy' && latestTurn && !hasTerminalEvidence(latestTurn) ? latestTurn.primaryUserUuid : null
}

export const sessionTimelineStateSchema = z.object({
  sessionId: z.string(),
  version: z.string(),
  fileSize: z.number().optional(),
})

export type SessionTimelineState = z.infer<typeof sessionTimelineStateSchema>

export const liveBackgroundTaskSchema = z.object({
  taskId: z.string(),
  taskType: z.string(),
  ambient: z.boolean().optional(),
})
export type LiveBackgroundTask = z.infer<typeof liveBackgroundTaskSchema>

/**
 * Server-authoritative share eligibility for a settled main Agent Turn.
 * Any turn with terminal completion evidence is shareable. The session's latest turn additionally
 * requires no live activity (Cotta or external CLI), background task, or pending interaction — those
 * are session-level signals that only point at the latest turn; historical turns are already frozen.
 */
export function computeShareEligible(input: {
  turn: TurnSummary
  activity: SessionActivity
  pendingPermission: ToolApprovalRequest | null
  liveBackgroundTasks: readonly LiveBackgroundTask[] | null
  isSessionLatest: boolean
}): boolean {
  if (!hasTerminalEvidence(input.turn)) return false
  if (!input.isSessionLatest) return true
  return input.activity.phase === 'idle' && input.pendingPermission === null && (input.liveBackgroundTasks === null || input.liveBackgroundTasks.length === 0)
}

export const sessionContextUsageSchema = z.object({
  model: z.string().nullable().default(null),
  categories: z.array(
    z.object({
      name: z.string(),
      tokens: z.number(),
      kind: z.enum(['used', 'free', 'buffer', 'deferred']),
      isDeferred: z.boolean().optional(),
    }),
  ),
  totalTokens: z.number(),
  autoCompactThreshold: z.number().nullable().default(null),
  maxTokens: z.number(),
  percentage: z.number(),
  updatedAtMs: z.number(),
})
export type SessionContextUsage = z.infer<typeof sessionContextUsageSchema>

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

export const modelSelectionSchema = z.string().trim().min(1)
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type EffortLevel = z.infer<typeof effortLevelSchema>
export const EFFORT_ORDER: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']
export const defaultTurnOptionSchema = z.literal('default')
export type DefaultTurnOption = z.infer<typeof defaultTurnOptionSchema>

export const runtimeTurnProjectionSchema = z.discriminatedUnion('kind', [
  z.object({ submissionUuid: z.string(), kind: z.literal('visible'), visibleTurnUuid: z.string() }),
  z.object({ submissionUuid: z.string(), kind: z.literal('terminal-only') }),
])
export type RuntimeTurnProjection = z.infer<typeof runtimeTurnProjectionSchema>

export const sessionTimelineResponseSchema = z.object({
  sessionId: z.string(),
  turns: z.array(turnSummarySchema),
  runtimeTurnProjection: runtimeTurnProjectionSchema.nullable(),
  turnOptions: z.object({
    permissionMode: permissionModeSchema.nullable(),
    model: z.string().nullable(),
    effort: effortLevelSchema.nullable(),
  }),
  contextUsage: sessionContextUsageSchema.nullable(),
  liveBackgroundTasks: z.array(liveBackgroundTaskSchema).nullable(),
  runState: sessionRunStateSchema.nullable(),
  activity: sessionActivitySchema,
  pendingPermission: toolApprovalRequestSchema.nullable(),
  hasMore: z.boolean(),
  hasNewer: z.boolean(),
  nextCursor: z.string().nullable(),
  snapshotFromTurnId: z.string().nullable(),
  anchorTurnId: z.string().nullable(),
  state: sessionTimelineStateSchema,
  tasks: z.array(rawSessionTaskSchema).nullable(),
})

export const sessionTimelineControlResponseSchema = sessionTimelineResponseSchema.pick({
  sessionId: true,
  turnOptions: true,
  contextUsage: true,
  liveBackgroundTasks: true,
  runState: true,
  activity: true,
  pendingPermission: true,
  state: true,
  tasks: true,
})

export type SessionTimelineResponse = z.infer<typeof sessionTimelineResponseSchema>
export type SessionTimelineControlResponse = z.infer<typeof sessionTimelineControlResponseSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function timelineToolUseId(message: unknown, block: unknown): string | undefined {
  if (isRecord(block) && typeof block.tool_use_id === 'string') return block.tool_use_id
  return isRecord(message) && typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined
}

export function timelineToolUseResult(message: unknown): unknown {
  if (!isRecord(message)) return undefined
  if (Object.hasOwn(message, 'tool_use_result')) return message.tool_use_result
  return Object.hasOwn(message, 'toolUseResult') ? message.toolUseResult : undefined
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

function topLevelTags(text: string): Map<string, string> {
  const tags = new Map<string, string>()
  let rest = text
  while (rest.trim()) {
    const open = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?>/.exec(rest)
    if (!open) return new Map()
    const tag = open[1]!
    const close = `</${tag}>`
    const end = rest.indexOf(close, open[0].length)
    if (end < 0) return new Map()
    tags.set(tag, rest.slice(open[0].length, end).trim())
    rest = rest.slice(end + close.length)
  }
  return tags
}

export type TimelineLocalCommand = { commandName: string; commandArgs?: string }
export type TimelineLocalCommandFeedback = { kind: 'stdout' | 'stderr'; text: string }

export function isSlashLookingInput(text: string): boolean {
  return /^\/[^\s/]+(?:\s|$)/u.test(text.trim())
}

function localCommandContent(value: Record<string, unknown>): string | null {
  if (value.type === 'user' && isRecord(value.message) && value.message.role === 'user' && typeof value.message.content === 'string') return value.message.content
  if (value.type === 'assistant' && typeof value.local_command_source === 'string') return value.local_command_source
  return value.type === 'system' && value.subtype === 'local_command' && typeof value.content === 'string' ? value.content : null
}

export function timelineLocalCommand(value: unknown): TimelineLocalCommand | null {
  if (!isRecord(value)) return null
  const content = localCommandContent(value)
  if (!content) return null
  const tags = topLevelTags(content)
  const commandName = tags.get('command-name')
  const sourcedUser = value.type === 'user' && (value.promptSource != null || timelineOriginKind(value) != null)
  if (!sourcedUser && commandName?.startsWith('/') && tags.get('command-message') === commandName.slice(1)) {
    const commandArgs = tags.get('command-args')?.trim()
    return { commandName, ...(commandArgs ? { commandArgs } : {}) }
  }
  if (value.type !== 'assistant' && (value.type !== 'system' || value.subtype !== 'local_command')) return null
  const bare = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(content.trim())
  return bare ? { commandName: `/${bare[1]!}`, ...(bare[2]?.trim() ? { commandArgs: bare[2].trim() } : {}) } : null
}

const localCommandFeedback = /^\s*<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1B) is the ANSI SGR introducer we intentionally match to strip color codes
const ansiSgr = /\x1B\[[0-?]*[ -/]*m/g
const invisibleCharacters = /[\p{Cc}\p{Cf}]/gu

export function timelineLocalCommandFeedback(value: unknown): TimelineLocalCommandFeedback | null {
  if (!isRecord(value)) return null
  const content = localCommandContent(value)
  if (!content || (value.type === 'user' && value.userType !== 'external')) return null
  const match = localCommandFeedback.exec(content)
  if (!match || /<\/?local-command-(?:stdout|stderr)>/.test(match[2]!)) return null
  return { kind: match[1] as TimelineLocalCommandFeedback['kind'], text: match[2]! }
}

function normalizedLocalCommandFeedback(value: TimelineLocalCommandFeedback): string {
  return value.text.replace(ansiSgr, '').replace(invisibleCharacters, ' ').replace(/\s+/gu, ' ').trim()
}

export function timelineLocalCommandFeedbackSummary(value: TimelineLocalCommandFeedback): string | null {
  const normalized = normalizedLocalCommandFeedback(value)
  if (!normalized) return null
  const characters = [...normalized]
  return characters.length <= 80 ? normalized : `${characters.slice(0, 79).join('')}…`
}

export function timelineLocalCommandFeedbackIsError(value: TimelineLocalCommandFeedback): boolean {
  return value.kind === 'stderr' || /^(?:error|failed)\b/iu.test(normalizedLocalCommandFeedback(value))
}

const localCommandCaveat = /^\s*<local-command-caveat>(?:(?!<\/?local-command-caveat>)[\s\S])*<\/local-command-caveat>\s*$/

export function isTimelineLocalCommandCaveatMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'user' &&
    value.isMeta === true &&
    !(typeof value.sourceToolUseID === 'string' && value.sourceToolUseID.trim()) &&
    isRecord(value.message) &&
    value.message.role === 'user' &&
    typeof value.message.content === 'string' &&
    localCommandCaveat.test(value.message.content)
  )
}

const timelineInterruptMarkerTexts = new Map([
  ['[Request interrupted by user]', 'Request interrupted by user'],
  ['[Request interrupted by user for tool use]', 'Request interrupted by user for tool use'],
])

export function timelineInterruptMarker(value: unknown): { text: string } | null {
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message) || value.message.role !== 'user') return null
  const content = value.message.content
  const text =
    Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0].type === 'text' && typeof content[0].text === 'string'
      ? timelineInterruptMarkerTexts.get(content[0].text)
      : undefined
  if (typeof value.interruptedMessageId === 'string' && value.interruptedMessageId.trim()) return { text: text ?? 'Request interrupted by user' }
  return value.userType === 'external' && text ? { text } : null
}

export type TimelineTaskNotification = {
  text: string
  taskId: string
  taskIds: string[]
  toolUseId: string | null
  outputFile: string | null
  status: string | null
  summary: string | null
  note: string | null
  result: string | null
}

export type TimelineTaskNotificationParse = { kind: 'valid'; notification: TimelineTaskNotification; explicit: boolean; structuralFallback: boolean } | { kind: 'invalid' }

const taskNotificationFields = new Set(['task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note', 'result'])

export function parseTimelineTaskNotification(value: unknown): TimelineTaskNotificationParse | null {
  if (!isRecord(value) || value.type !== 'user') return null
  const explicit = timelineOriginKind(value) === 'task-notification'
  if (!isRecord(value.message) || value.message.role !== 'user' || typeof value.message.content !== 'string') return explicit ? { kind: 'invalid' } : null
  const text = value.message.content.trim()
  if (!explicit && (value.promptSource != null || timelineOriginKind(value) != null || !text.startsWith('<'))) return null

  const fields = new Map<string, string[]>()
  const stack: string[] = []
  const fieldStack: Array<{ name: string; index: number } | null> = []
  let root = false
  let invalid = false

  const parser = new SaxesParser()
  parser.on('opentag', ({ name }) => {
    if (stack.length === 0) {
      if (root || name !== 'task-notification') invalid = true
      root = true
    }
    const values = fields.get(name) ?? []
    const field = stack.length === 1 && taskNotificationFields.has(name) ? { name, index: values.push('') - 1 } : null
    if (field) fields.set(name, values)
    stack.push(name)
    fieldStack.push(field)
  })
  const collectText = (textPart: string) => {
    let field: { name: string; index: number } | null = null
    for (let index = fieldStack.length - 1; index >= 0; index -= 1) {
      if (fieldStack[index]) {
        field = fieldStack[index]
        break
      }
    }
    if (field) fields.get(field.name)![field.index] += textPart
  }
  parser.on('text', collectText)
  parser.on('cdata', collectText)
  parser.on('closetag', ({ name }) => {
    if (stack.pop() !== name) invalid = true
    fieldStack.pop()
  })
  parser.on('error', () => {
    invalid = true
  })
  try {
    parser.write(text).close()
  } catch {
    invalid = true
  }

  const field = (name: string) =>
    fields
      .get(name)
      ?.find((value) => value.trim())
      ?.trim() || null
  const taskIds = (fields.get('task-id') ?? []).map((id) => id.trim()).filter(Boolean)
  if (invalid || !root || stack.length > 0 || taskIds.length === 0) return explicit ? { kind: 'invalid' } : null
  const toolUseIds = (fields.get('tool-use-id') ?? []).map((id) => id.trim()).filter(Boolean)
  const notification = {
    text,
    taskId: taskIds[0]!,
    taskIds,
    toolUseId: toolUseIds.length === 1 ? toolUseIds[0]! : null,
    outputFile: field('output-file'),
    status: field('status'),
    summary: field('summary'),
    note: field('note'),
    result: field('result'),
  }
  return { kind: 'valid', notification, explicit, structuralFallback: !explicit && notification.toolUseId !== null }
}

export function timelineTaskNotificationToolUseId(value: unknown): string | undefined {
  const parsed = parseTimelineTaskNotification(value)
  return parsed?.kind === 'valid' ? (parsed.notification.toolUseId ?? undefined) : undefined
}

export function timelineTaskNotification(value: unknown): { taskId: string; status: 'completed' | 'failed' | 'stopped' } | null {
  const parsed = parseTimelineTaskNotification(value)
  const notification = parsed?.kind === 'valid' ? parsed.notification : null
  return notification && (notification.status === 'completed' || notification.status === 'failed' || notification.status === 'stopped')
    ? { taskId: notification.taskId, status: notification.status }
    : null
}

export function isTimelineTaskNotificationMessage(value: unknown): boolean {
  const parsed = parseTimelineTaskNotification(value)
  return parsed?.kind === 'invalid' || (parsed?.kind === 'valid' && (parsed.explicit || parsed.structuralFallback))
}

export function isPrimaryTimelineUserMessage(value: unknown, options: { allowSidechain?: boolean } = {}): boolean {
  if (!isRecord(value) || value.type !== 'user' || !isRecord(value.message)) return false
  const message = value.message
  const originKind = timelineOriginKind(value)
  if (
    message.role !== 'user' ||
    value.parent_tool_use_id != null ||
    value.parent_agent_id != null ||
    value.isSynthetic === true ||
    value.isMeta === true ||
    value.shouldQuery === false ||
    originKind === 'peer' ||
    isTimelineTaskNotificationMessage(value) ||
    containsToolResult(message.content) ||
    (!options.allowSidechain && value.isSidechain === true)
  )
    return false
  return originKind === 'human' || value.promptSource === 'typed' || value.promptSource === 'sdk' || (originKind == null && value.promptSource == null)
}

export const sessionRawMessagesResponseSchema = z.object({
  sessionId: z.string(),
  lines: z.array(sessionRawTranscriptLineSchema),
})

export type SessionRawMessagesResponse = z.infer<typeof sessionRawMessagesResponseSchema>

export const turnSubagentNodeSchema = z.object({
  agentId: z.string(),
  metadataReady: z.boolean(),
  parentAgentId: z.string().nullable(),
  agentType: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  transcriptVersion: z.string().nullable(),
  transcriptModifiedAtMs: z.number().int().nonnegative().nullable(),
})
export type TurnSubagentNode = z.infer<typeof turnSubagentNodeSchema>

export const turnSubagentsTreeResponseSchema = z.object({
  sessionId: z.string(),
  ownerTurnId: z.string(),
  tree: z.array(turnSubagentNodeSchema),
})
export type TurnSubagentsTreeResponse = z.infer<typeof turnSubagentsTreeResponseSchema>

export const turnSubagentTranscriptResponseSchema = z.object({
  sessionId: z.string(),
  ownerTurnId: z.string(),
  agentId: z.string(),
  transcript: z
    .object({
      version: z.string(),
      turns: z.array(turnSummarySchema),
    })
    .nullable(),
})
export type TurnSubagentTranscriptResponse = z.infer<typeof turnSubagentTranscriptResponseSchema>

export const modelCatalogItemSchema = z
  .object({
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
  .passthrough()
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>

export const modelCatalogResponseSchema = z
  .object({
    models: z.array(modelCatalogItemSchema),
  })
  .passthrough()
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>

function modelIds(model: ModelCatalogItem): string[] {
  return [model.value, model.resolvedModel].filter((value): value is string => Boolean(value))
}

function baseModelId(model: string): string {
  return model.replace(/\[[^\]]+\]$/, '')
}

function isOneMillionModel(model: ModelCatalogItem): boolean {
  return modelIds(model).some((id) => /\[1m\]$/.test(id))
}

export function matchingCatalogModel(models: ModelCatalogItem[], model: string, settings?: Pick<AppSettings, 'useOneMillionContext'>): ModelCatalogItem | undefined {
  const base = baseModelId(model)
  const candidates = models.filter((item) => modelIds(item).some((id) => id === model || baseModelId(id) === base))
  if (candidates.length <= 1) return candidates[0]
  const oneMillion = candidates.find(isOneMillionModel)
  const standard = candidates.find((item) => !isOneMillionModel(item))
  return settings?.useOneMillionContext === false ? (standard ?? oneMillion) : (oneMillion ?? standard)
}

export function supportedEffortLevels(model?: ModelCatalogItem): EffortLevel[] {
  const supported = model?.supportsEffort ? (model.supportedEffortLevels ?? []) : []
  return EFFORT_ORDER.filter((level) => supported.includes(level))
}

export function downgradeEffort(effort: EffortLevel, supported: EffortLevel[]): EffortLevel | null {
  if (supported.includes(effort)) return effort
  const start = EFFORT_ORDER.indexOf(effort)
  const lowerOrEqual = start >= 0 ? EFFORT_ORDER.slice(start + 1) : EFFORT_ORDER
  return lowerOrEqual.find((level) => supported.includes(level)) ?? EFFORT_ORDER.find((level) => supported.includes(level)) ?? null
}

export function modelSupportsEffort(model?: ModelCatalogItem): boolean {
  return supportedEffortLevels(model).length > 0
}

export function normalizeModelEffortSelection(
  input: { model: ModelSelection | DefaultTurnOption | null; effort: EffortLevel | null },
  settings?: Pick<AppSettings, 'modelCatalog' | 'useOneMillionContext'>,
): { model: ModelSelection | DefaultTurnOption | null; effort: EffortLevel | null } {
  if (input.model == null) return { model: null, effort: null }
  const catalogModel = settings?.modelCatalog ? matchingCatalogModel(settings.modelCatalog.models, input.model, settings) : undefined
  if (!catalogModel) return input
  const supported = supportedEffortLevels(catalogModel)
  if (!supported.length) return { model: catalogModel.value, effort: null }
  return { model: catalogModel.value, effort: input.effort ? downgradeEffort(input.effort, supported) : 'medium' }
}

export function mergeTranscriptModelEffort(input: {
  currentModel: ModelSelection | DefaultTurnOption | null
  currentEffort: EffortLevel | null
  observedModel?: ModelSelection | null
  observedEffort?: EffortLevel | null
  settings?: AppSettings
}): { model: ModelSelection | DefaultTurnOption; effort: EffortLevel | null } {
  const catalog = input.settings?.modelCatalog
  const currentModel = input.currentModel ?? input.settings?.defaultModel ?? 'default'
  const currentEffort = input.currentModel != null ? input.currentEffort : (input.settings?.defaultEffort ?? 'medium')
  const observedCatalogModel = input.observedModel && catalog ? matchingCatalogModel(catalog.models, input.observedModel, input.settings) : undefined
  const targetModel = observedCatalogModel?.value ?? input.observedModel ?? currentModel
  const targetCatalogModel = catalog ? matchingCatalogModel(catalog.models, targetModel, input.settings) : undefined
  const targetSupported = supportedEffortLevels(targetCatalogModel)
  if (targetCatalogModel && !targetSupported.length) return { model: targetModel, effort: null }
  if (input.observedEffort) return { model: targetModel, effort: targetSupported.length ? downgradeEffort(input.observedEffort, targetSupported) : input.observedEffort }
  if (!targetCatalogModel) return { model: targetModel, effort: currentEffort }
  if (currentEffort) return { model: targetModel, effort: downgradeEffort(currentEffort, targetSupported) }
  const currentCatalogModel = catalog ? matchingCatalogModel(catalog.models, currentModel, input.settings) : undefined
  if (currentCatalogModel && modelSupportsEffort(currentCatalogModel)) return { model: targetModel, effort: null }
  return { model: targetModel, effort: targetSupported.includes('medium') ? 'medium' : (targetSupported[0] ?? null) }
}

export const sessionContextUsageResponseSchema = z.object({
  contextUsage: sessionContextUsageSchema.nullable(),
})
export type SessionContextUsageResponse = z.infer<typeof sessionContextUsageResponseSchema>

export const tokenUsageRangeSchema = z.enum(['today', '7d', '30d', 'all'])
export type TokenUsageRange = z.infer<typeof tokenUsageRangeSchema>

export const tokenUsageDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
})
export type TokenUsageDay = z.infer<typeof tokenUsageDaySchema>

export const tokenUsageDailyResponseSchema = z.object({
  days: z.number().int().min(1).max(371),
  timeZone: z.string(),
  daily: z.array(tokenUsageDaySchema).min(1).max(371),
})
export type TokenUsageDailyResponse = z.infer<typeof tokenUsageDailyResponseSchema>

export const tokenUsageResponseSchema = z.object({
  range: tokenUsageRangeSchema,
  timeZone: z.string(),
  totals: z.object({
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheHitRate: z.number().min(0).max(1),
    sessions: z.number().int().nonnegative(),
    userMessages: z.number().int().nonnegative(),
  }),
})
export type TokenUsageResponse = z.infer<typeof tokenUsageResponseSchema>

const timeZoneSchema = z.string().transform((timeZone, context) => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid IANA time zone' })
    return z.NEVER
  }
})

/** Canonical http(s) Origin: scheme + host + optional port only. Rejects path, query, fragment and credentials. */
const allowedOriginSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    context.addIssue({ code: 'custom', message: 'must be a canonical http(s) origin (scheme, host, optional port only)' })
  }
})

export const appSettingsSchema = z
  .object({
    // When unset in the DB, fall back to the host's own IANA time zone rather than a hardcoded region.
    timeZone: timeZoneSchema.default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    defaultPermissionMode: permissionModeSchema.default('default'),
    defaultModel: z.preprocess((value) => (value === undefined ? 'default' : value), modelSelectionSchema.nullable()),
    defaultEffort: z.preprocess((value) => (value === undefined ? 'medium' : value), effortLevelSchema.nullable()),
    modelCatalog: modelCatalogResponseSchema.optional(),
    useOneMillionContext: z.boolean().default(true),
    autoCompactPercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    showDebugNav: z.boolean().default(false),
    publicBaseUrl: allowedOriginSchema.optional(),
  })
  .catchall(z.unknown())
export type AppSettings = z.infer<typeof appSettingsSchema>

export const settingsResponseSchema = z.object({
  settings: appSettingsSchema,
})
export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const appSettingsUpdateSchema = z
  .object({
    timeZone: timeZoneSchema.optional(),
    defaultPermissionMode: permissionModeSchema.optional(),
    defaultModel: modelSelectionSchema.nullable().optional(),
    defaultEffort: effortLevelSchema.nullable().optional(),
    useOneMillionContext: z.boolean().optional(),
    autoCompactPercent: z.number().int().min(1).max(100).nullable().optional(),
    showDebugNav: z.boolean().optional(),
    publicBaseUrl: allowedOriginSchema.nullable().optional(),
  })
  .refine(({ defaultModel, defaultEffort }) => (defaultModel === undefined) === (defaultEffort === undefined), 'defaultModel and defaultEffort must be updated together')
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>

export const settingsUpdateRequestSchema = z.object({
  settings: appSettingsUpdateSchema,
})
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

export const githubDevicePollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number() }),
  z.object({ status: z.literal('slow_down'), interval: z.number() }),
  z.object({ status: z.literal('authorized'), user: authUserSchema }),
])
export type GitHubDevicePollResponse = z.infer<typeof githubDevicePollResponseSchema>

export const logoutResponseSchema = z.object({ ok: z.literal(true) })
export type LogoutResponse = z.infer<typeof logoutResponseSchema>

export const githubConfigSchema = z.object({ clientId: z.string(), allowedUsers: z.string() })
export type GitHubConfig = z.infer<typeof githubConfigSchema>

/** Cotta allows exactly one GitHub user: one non-blank token without whitespace or commas. */
export function isSingleUser(value: string | null | undefined): boolean {
  return /^[^\s,]+$/.test(value?.trim() ?? '')
}

/** Comparable form of a GitHub login (GitHub logins are case-insensitive); null when blank. */
export function normalizeAllowedUser(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null
}

export const storedTurnOptionsSchema = z.object({
  permissionMode: permissionModeSchema,
  model: modelSelectionSchema.nullable(),
  effort: effortLevelSchema.nullable(),
})
export type StoredTurnOptions = z.infer<typeof storedTurnOptionsSchema>

export const turnOptionsUpdateRequestSchema = z
  .object({
    permissionMode: permissionModeSchema.optional(),
    model: modelSelectionSchema.nullable().optional(),
    effort: effortLevelSchema.nullable().optional(),
  })
  .refine(({ model, effort }) => (model === undefined) === (effort === undefined), 'model and effort must be updated together')
  .refine(({ permissionMode, model }) => permissionMode !== undefined || model !== undefined, 'at least one turn options field must be updated')
export type TurnOptionsUpdateRequest = z.infer<typeof turnOptionsUpdateRequestSchema>

export const COMPOSER_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const COMPOSER_IMAGES_MAX_BYTES = 20 * 1024 * 1024
export const COMPOSER_IMAGES_MAX_COUNT = 10
export const COMPOSER_TURN_BODY_MAX_BYTES = 30 * 1024 * 1024

const composerImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export type ComposerImageMediaType = z.infer<typeof composerImageMediaTypeSchema>
export type ComposerImage = { mediaType: ComposerImageMediaType; data: string }

function base64Bytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function detectComposerImageMediaType(bytes: Uint8Array): ComposerImageMediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function inspectComposerImage(image: { mediaType?: string | null; data: string }): { byteLength: number; mediaType: ComposerImageMediaType } | { error: string } {
  const parsedMediaType = composerImageMediaTypeSchema.safeParse(image.mediaType)
  if (!parsedMediaType.success) return { error: 'unsupported image type' }
  if (!image.data || image.data.length % 4 !== 0) return { error: 'invalid image data' }
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0
  const byteLength = (image.data.length / 4) * 3 - padding
  if (byteLength > COMPOSER_IMAGE_MAX_BYTES) return { error: 'image exceeds 5 MiB' }
  const contentEnd = image.data.length - padding
  for (let index = 0; index < image.data.length; index += 1) {
    const code = image.data.charCodeAt(index)
    const base64Character = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47
    if (index < contentEnd ? !base64Character : code !== 61) return { error: 'invalid image data' }
  }
  const detectedMediaType = detectComposerImageMediaType(base64Bytes(image.data.slice(0, 16)) ?? new Uint8Array())
  return detectedMediaType === parsedMediaType.data ? { byteLength, mediaType: detectedMediaType } : { error: 'image signature does not match its type' }
}

export function decodeComposerImage(data: unknown, mediaType: unknown): { bytes: Uint8Array; mediaType: ComposerImageMediaType } | { error: string } {
  if (typeof data !== 'string' || (mediaType !== null && mediaType !== undefined && typeof mediaType !== 'string')) return { error: 'invalid image data' }
  const inspected = inspectComposerImage({ data, mediaType: mediaType as string | null | undefined })
  if ('error' in inspected) return inspected
  const bytes = base64Bytes(data)
  return bytes ? { bytes, mediaType: inspected.mediaType } : { error: 'invalid image data' }
}

export const composerImageSchema = z.object({ mediaType: composerImageMediaTypeSchema, data: z.string().max(Math.ceil(COMPOSER_IMAGE_MAX_BYTES / 3) * 4) })

export function buildComposerMessageContent(
  text: string,
  images: ComposerImage[],
): string | Array<{ type: 'image'; source: { type: 'base64'; media_type: ComposerImageMediaType; data: string } } | { type: 'text'; text: string }> {
  const trimmed = text.trim()
  if (!images.length) return trimmed
  return [
    ...images.map(({ mediaType, data }) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data } })),
    ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
  ]
}

export const createTurnRequestSchema = z
  .object({
    sessionId: z.string().uuid().optional(),
    text: z.string().trim().min(1).optional(),
    images: z.array(composerImageSchema).max(COMPOSER_IMAGES_MAX_COUNT).optional(),
    userMessageUuid: z.string().uuid(),
  })
  .superRefine(({ text, images }, context) => {
    if (text === undefined && !images?.length) context.addIssue({ code: 'custom', message: 'turn requires text or images' })
    if (text && images?.length && isSlashLookingInput(text)) context.addIssue({ code: 'custom', message: 'slash commands cannot include images', path: ['images'] })
    let totalBytes = 0
    for (const [index, image] of (images ?? []).entries()) {
      const inspected = inspectComposerImage(image)
      if ('error' in inspected) context.addIssue({ code: 'custom', message: inspected.error, path: ['images', index, 'data'] })
      else totalBytes += inspected.byteLength
    }
    if (totalBytes > COMPOSER_IMAGES_MAX_BYTES) context.addIssue({ code: 'custom', message: 'images exceed 20 MiB total', path: ['images'] })
  })

export const toolApprovalDecisionRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('allow') }),
  z.strictObject({ decision: z.literal('allow_suggestion') }),
  z.strictObject({ decision: z.literal('deny'), message: z.string().optional() }),
])
export type ToolApprovalDecisionRequest = z.infer<typeof toolApprovalDecisionRequestSchema>

export const askUserQuestionDecisionRequestSchema = z.discriminatedUnion('behavior', [
  z.strictObject({
    behavior: z.literal('completed'),
    toolUseID: z.string(),
    answers: z.record(z.string(), z.string()),
    annotations: z
      .record(
        z.string(),
        z.strictObject({
          preview: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
  }),
  z.strictObject({ behavior: z.literal('cancelled'), toolUseID: z.string() }),
])
export type AskUserQuestionDecisionRequest = z.infer<typeof askUserQuestionDecisionRequestSchema>

export const toolApprovalDecisionResponseSchema = z.object({ ok: z.literal(true) })
export type ToolApprovalDecisionResponse = z.infer<typeof toolApprovalDecisionResponseSchema>

export const sessionRuntimeResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  sessionId: z.string(),
  settings: z.object({
    permissionMode: permissionModeSchema,
    model: modelSelectionSchema.nullable(),
    effort: effortLevelSchema.nullable(),
  }),
  initializationResult: z.unknown().nullable(),
  contextUsage: sessionContextUsageSchema.nullable(),
})

export type SessionRuntimeResponse = z.infer<typeof sessionRuntimeResponseSchema>

export const restartSessionRuntimeResponseSchema = z.object({ ok: z.literal(true), restarted: z.boolean() })
export type RestartSessionRuntimeResponse = z.infer<typeof restartSessionRuntimeResponseSchema>

export const createTurnResponseSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
  userMessageUuid: z.string(),
})

export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>
