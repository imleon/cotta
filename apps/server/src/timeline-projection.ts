import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { isPrimaryTimelineUserMessage, isTimelineTaskNotificationMessage, timelineTaskNotificationToolUseId, timelineToolUseId } from '@cotta/shared'
import type { SessionTask, SessionTimelineResponse, TurnSummary } from '@cotta/shared'

type ProjectedSessionTimeline = Omit<SessionTimelineResponse, 'state' | 'awaySummary' | 'sessionMeta'>

type OrganizedTurn = TurnSummary & { messages: SessionMessage[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function messageTimestampMs(message: SessionMessage): number | undefined {
  return timestampMs('timestamp' in message ? message.timestamp : undefined)
}

function messageContent(message: SessionMessage): unknown {
  return isRecord(message.message) ? message.message.content : undefined
}

function isSyntheticUserMessage(message: SessionMessage): boolean {
  return message.type === 'user' && 'isSynthetic' in message && message.isSynthetic === true
}

function toolUseIds(message: SessionMessage): string[] {
  const content = messageContent(message)
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : [])
}

function toolResultIds(message: SessionMessage): string[] {
  const content = messageContent(message)
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_result') return []
    const id = timelineToolUseId(message, block)
    return id ? [id] : []
  })
}

function organizeSessionTurns(messages: SessionMessage[]): OrganizedTurn[] {
  const turns: OrganizedTurn[] = []
  const turnsByToolUseId = new Map<string, OrganizedTurn>()
  let current: OrganizedTurn | undefined

  for (const message of messages) {
    if (isSyntheticUserMessage(message)) continue
    const taskNotification = isTimelineTaskNotificationMessage(message)
    const linkedToolUseId = taskNotification
      ? timelineTaskNotificationToolUseId(message)
      : toolResultIds(message).find((id) => turnsByToolUseId.has(id))
    if (isPrimaryTimelineUserMessage(message) && !taskNotification) {
      current = {
        primaryUserUuid: message.uuid,
        primaryUserTimestampMs: messageTimestampMs(message),
        messages: [],
      }
      turns.push(current)
    }
    if (!current) continue

    const target = linkedToolUseId ? turnsByToolUseId.get(linkedToolUseId) ?? current : current
    if (message.type === 'user' || message.type === 'assistant') target.messages.push(message)
    for (const id of toolUseIds(message)) turnsByToolUseId.set(id, target)
  }

  return turns
}

function toolResultText(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item) => isRecord(item) && typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n')
}

function projectSessionTasks(messages: SessionMessage[], latestProjectedTurnId?: string): SessionTask[] {
  type PendingTask = Omit<SessionTask, 'taskId'> & { taskId: string | null; completedTurnId?: string }
  type PendingUpdate = { task: PendingTask; input: Record<string, unknown>; taskId: string; turnId?: string }
  const tasks: PendingTask[] = []
  const createsByToolUseId = new Map<string, PendingTask>()
  const updatesByToolUseId = new Map<string, PendingUpdate>()
  const latestByTaskId = new Map<string, PendingTask>()
  let currentTurnId: string | undefined

  for (const message of messages) {
    if (isPrimaryTimelineUserMessage(message)) currentTurnId = message.uuid
    if (!currentTurnId) continue
    const content = messageContent(message)
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isRecord(block)) continue
      if (message.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && isRecord(block.input)) {
        if (block.name === 'TaskCreate' && typeof block.input.subject === 'string') {
          const task = {
            key: block.id,
            taskId: null,
            subject: block.input.subject,
            ...(typeof block.input.activeForm === 'string' ? { activeForm: block.input.activeForm } : {}),
            status: 'pending' as const,
            blockedBy: [],
          }
          tasks.push(task)
          createsByToolUseId.set(block.id, task)
        } else if (block.name === 'TaskUpdate' && typeof block.input.taskId === 'string') {
          const task = latestByTaskId.get(block.input.taskId)
          if (task) updatesByToolUseId.set(block.id, { task, input: block.input, taskId: block.input.taskId, turnId: currentTurnId })
        }
        continue
      }

      if (message.type !== 'user' || block.type !== 'tool_result' || block.is_error === true) continue
      const toolUseId = timelineToolUseId(message, block)
      if (!toolUseId) continue
      const createdTask = createsByToolUseId.get(toolUseId)
      if (createdTask) {
        const taskId = toolResultText(block).match(/^Task #(\S+) created successfully:/)?.[1]
        if (!taskId) continue
        createdTask.taskId = taskId
        latestByTaskId.set(taskId, createdTask)
        continue
      }
      const update = updatesByToolUseId.get(toolUseId)
      if (!update || !toolResultText(block).startsWith(`Updated task #${update.taskId} `)) continue
      if (update.input.status === 'deleted') {
        const index = tasks.indexOf(update.task)
        if (index >= 0) tasks.splice(index, 1)
        latestByTaskId.delete(update.taskId)
        continue
      }
      if (update.input.status === 'pending' || update.input.status === 'in_progress' || update.input.status === 'completed') {
        update.task.status = update.input.status
        update.task.completedTurnId = update.input.status === 'completed' ? update.turnId : undefined
      }
      if (typeof update.input.subject === 'string') update.task.subject = update.input.subject
      if (typeof update.input.activeForm === 'string') update.task.activeForm = update.input.activeForm
      if (Array.isArray(update.input.addBlockedBy)) {
        for (const taskId of update.input.addBlockedBy) if (typeof taskId === 'string' && !update.task.blockedBy.includes(taskId)) update.task.blockedBy.push(taskId)
      }
      if (Array.isArray(update.input.addBlocks) && typeof update.input.taskId === 'string') {
        for (const taskId of update.input.addBlocks) {
          const blocked = typeof taskId === 'string' ? latestByTaskId.get(taskId) : undefined
          if (blocked && !blocked.blockedBy.includes(update.input.taskId)) blocked.blockedBy.push(update.input.taskId)
        }
      }
    }
  }

  return tasks
    .filter((task): task is PendingTask & { taskId: string } => task.taskId !== null)
    .filter((task) => task.status !== 'completed' || task.completedTurnId === latestProjectedTurnId)
    .map(({ completedTurnId: _, ...task }) => ({ ...task, blockedBy: task.blockedBy.filter((taskId) => latestByTaskId.get(taskId)?.status !== 'completed') }))
}

export function sessionMessagesForTurn(messages: SessionMessage[], turnId: string): SessionMessage[] | null {
  return organizeSessionTurns(messages).find((turn) => turn.primaryUserUuid === turnId)?.messages ?? null
}

export function projectSessionTimeline(
  sessionId: string,
  messages: SessionMessage[],
  options: { limitTurns: number; cursor: string | null },
): ProjectedSessionTimeline {
  const allTurns = organizeSessionTurns(messages)
  const tasks = projectSessionTasks(messages, allTurns.at(-1)?.primaryUserUuid)
  const endExclusive = options.cursor
    ? Math.max(0, allTurns.findIndex((turn) => turn.primaryUserUuid === options.cursor))
    : allTurns.length
  const start = Math.max(0, endExclusive - options.limitTurns)
  const turns = allTurns.slice(start, endExclusive)
  return {
    sessionId,
    turns,
    tasks,
    hasMore: start > 0,
    nextCursor: start > 0 ? allTurns[start]?.primaryUserUuid ?? null : null,
  }
}
