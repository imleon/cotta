import { stat } from 'node:fs/promises'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { isPrimaryTimelineUserMessage, type TurnSummary } from '@cotta/shared'
import { readCompleteTranscriptLines } from './session-raw-transcript-cache.js'
import { projectSessionTimeline } from './timeline-projection.js'
import { materializeTranscriptTurnOwnership } from './transcript-turn-ownership.js'

export async function projectSubagentTranscript(agentId: string, transcriptPath: string): Promise<{ version: string; turns: TurnSummary[] } | null> {
  const info = await stat(transcriptPath)
  const lines = await readCompleteTranscriptLines(transcriptPath, 0, info.size)
  const messagesByOffset = new Map(lines.map((line) => [line.offset, line.value as SessionMessage]))
  const owned = materializeTranscriptTurnOwnership(
    lines.map((line) => ({ session_id: agentId, byte_offset: line.offset, raw_json: line.raw })),
    new Map(),
    { allowSidechainPrimary: true },
  )
  const responseCwdByTurn = new Map<string, string>()
  const entrypointByTurn = new Map<string, string>()
  for (const line of owned) {
    const message = messagesByOffset.get(line.byte_offset)
    const uuid = message && 'uuid' in message && typeof message.uuid === 'string' ? message.uuid : null
    if (line.owner_turn_id && uuid !== line.owner_turn_id && message && 'cwd' in message && typeof message.cwd === 'string' && message.cwd.trim())
      responseCwdByTurn.set(line.owner_turn_id, message.cwd)
  }
  const primaryTurnIds = new Set<string>()
  const primaryTurns = owned.flatMap((line) => {
    const message = messagesByOffset.get(line.byte_offset)
    const uuid = message && 'uuid' in message && typeof message.uuid === 'string' ? message.uuid : null
    const timestamp = message && 'timestamp' in message && typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN
    if (!message || !uuid || primaryTurnIds.has(uuid) || line.owner_turn_id !== uuid || !isPrimaryTimelineUserMessage(message, { allowSidechain: true })) return []
    primaryTurnIds.add(uuid)
    if ('entrypoint' in message && typeof message.entrypoint === 'string') entrypointByTurn.set(uuid, message.entrypoint)
    return [
      {
        uuid,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        ...('cwd' in message && typeof message.cwd === 'string' && message.cwd.trim() ? { userCwd: message.cwd } : {}),
        ...(responseCwdByTurn.get(uuid) ? { responseCwd: responseCwdByTurn.get(uuid) } : {}),
      },
    ]
  })
  const fallbackTurnId = primaryTurns.length === 0 && owned.some((line) => messagesByOffset.has(line.byte_offset)) ? `subagent:${agentId}:root` : null
  const ownedMessages = owned.flatMap((line) => {
    const message = messagesByOffset.get(line.byte_offset)
    const ownerTurnId = fallbackTurnId ?? line.owner_turn_id
    return ownerTurnId && message ? [{ ownerTurnId, message }] : []
  })
  const turns = projectSessionTimeline(agentId, fallbackTurnId ? [{ uuid: fallbackTurnId, timestamp: null }] : primaryTurns, ownedMessages)
    .turns.map((turn) => ({
      ...turn,
      ...(entrypointByTurn.get(turn.primaryUserUuid) ? { entrypoint: entrypointByTurn.get(turn.primaryUserUuid) } : {}),
    }))
    .filter((turn) => !fallbackTurnId || turn.messages.length > 0)
  return turns.length > 0 ? { version: `${info.size}:${Math.trunc(info.mtimeMs)}`, turns } : null
}
