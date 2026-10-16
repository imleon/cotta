import { isPrimaryTimelineUserMessage, parseTimelineTaskNotification, timelineLocalCommand, timelineLocalCommandFeedback, timelineToolUseId } from '@cotta/shared'

type JsonRecord = Record<string, unknown>

export type TranscriptOwnershipLine = {
  session_id: string
  byte_offset: number
  raw_json: string
}

export type MaterializedTranscriptOwnership = TranscriptOwnershipLine & {
  owner_turn_id: string | null
}

export type TranscriptOwnershipSeedLine = TranscriptOwnershipLine & {
  uuid: string | null
  owner_turn_id: string | null
}

type SessionOwnershipState = {
  currentPrimary: string | null
  ownersByUuid: Map<string, string | null>
  ownersByToolUseId: Map<string, string | null>
  localCommandRoots: Set<string>
}

export type TranscriptOwnershipState = Map<string, SessionOwnershipState>

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function content(value: JsonRecord): unknown[] {
  return record(value.message) && Array.isArray(value.message.content) ? value.message.content : []
}

function toolResultIds(value: JsonRecord): string[] {
  return content(value).flatMap((block) => (record(block) && block.type === 'tool_result' ? (timelineToolUseId(value, block) ?? []) : []))
}

function sessionState(states: TranscriptOwnershipState, sessionId: string): SessionOwnershipState {
  const state = states.get(sessionId) ?? {
    currentPrimary: null,
    ownersByUuid: new Map<string, string | null>(),
    ownersByToolUseId: new Map<string, string | null>(),
    localCommandRoots: new Set<string>(),
  }
  states.set(sessionId, state)
  return state
}

function parseLine(line: TranscriptOwnershipLine): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line.raw_json)
    return record(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function seedTranscriptTurnOwnershipState(lines: TranscriptOwnershipSeedLine[], states: TranscriptOwnershipState = new Map()): TranscriptOwnershipState {
  for (const line of [...lines].sort((a, b) => a.session_id.localeCompare(b.session_id) || a.byte_offset - b.byte_offset)) {
    const state = sessionState(states, line.session_id)
    if (typeof line.owner_turn_id !== 'string') continue
    if (line.uuid) {
      state.ownersByUuid.set(line.uuid, line.owner_turn_id)
      if (line.uuid === line.owner_turn_id) state.currentPrimary = line.uuid
    }
    const value = parseLine(line)
    if (!value) continue
    if (line.uuid && line.uuid === line.owner_turn_id && timelineLocalCommand(value)) state.localCommandRoots.add(line.uuid)
    for (const block of content(value)) {
      if (record(block) && block.type === 'tool_use' && typeof block.id === 'string') state.ownersByToolUseId.set(block.id, line.owner_turn_id)
    }
  }
  return states
}

export function materializeTranscriptTurnOwnership(
  lines: TranscriptOwnershipLine[],
  states: TranscriptOwnershipState = new Map(),
  options: { allowSidechainPrimary?: boolean } = {},
): MaterializedTranscriptOwnership[] {
  return [...lines]
    .sort((a, b) => a.session_id.localeCompare(b.session_id) || a.byte_offset - b.byte_offset)
    .map((line) => {
      const value = parseLine(line)
      const state = sessionState(states, line.session_id)

      let owner: string | null = null
      if (value) {
        const uuid = typeof value.uuid === 'string' ? value.uuid : null
        const command = timelineLocalCommand(value)
        const feedback = timelineLocalCommandFeedback(value)
        if (command && uuid) {
          owner = uuid
          state.currentPrimary = uuid
          state.localCommandRoots.add(uuid)
        } else if (feedback && typeof value.parentUuid === 'string' && state.localCommandRoots.has(value.parentUuid)) {
          owner = state.ownersByUuid.get(value.parentUuid) ?? null
        } else if (isPrimaryTimelineUserMessage(value, { allowSidechain: options.allowSidechainPrimary }) && uuid) {
          owner = uuid
          state.currentPrimary = uuid
        } else {
          const taskNotification = parseTimelineTaskNotification(value)
          const linkedToolUseIds = taskNotification
            ? taskNotification.kind === 'valid' && taskNotification.notification.toolUseId
              ? [taskNotification.notification.toolUseId]
              : []
            : toolResultIds(value)
          const linkedOwners = new Set(linkedToolUseIds.map((id) => state.ownersByToolUseId.get(id)).filter((item): item is string => typeof item === 'string'))
          if (linkedOwners.size > 1) owner = null
          else if (linkedOwners.size === 1) owner = linkedOwners.values().next().value!
          else if (typeof value.parentUuid === 'string' && state.ownersByUuid.has(value.parentUuid)) owner = state.ownersByUuid.get(value.parentUuid) ?? null
          else owner = state.currentPrimary
        }

        if (uuid) state.ownersByUuid.set(uuid, owner)
        for (const block of content(value)) {
          if (record(block) && block.type === 'tool_use' && typeof block.id === 'string') state.ownersByToolUseId.set(block.id, owner)
        }
      }

      return { ...line, owner_turn_id: owner }
    })
}
