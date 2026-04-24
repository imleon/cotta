import type {
  SessionPersistentLogEntry,
  SessionSdkRawLogEntry,
} from '../contract/runtime'

export interface SessionMessagesResponse {
  messages?: unknown[]
  hasMore?: boolean
  nextBefore?: string | null
}

export interface AgentDescriptor {
  agentId: string
  projectDir?: string
}

export interface AgentsResponse {
  defaultAgentId?: string
  agents?: AgentDescriptor[]
}

export interface SdkRawLogsResponse {
  items?: SessionSdkRawLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

export interface PersistentLogsResponse {
  items?: SessionPersistentLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

export interface StatusResponse {
  generatedAt?: number
  runtime?: {
    version?: string
    host: string
    port: number
    authEnabled: boolean
    nodeVersion: string
    pid: number
    platform: string
    startedAt: number
    uptimeSec: number
  }
  agents?: Array<{
    agent: {
      agentId: string
      projectDir: string
      model?: string
      permissionMode?: string
      allowTools?: string[]
      allowSkills?: string[]
      mcpSummary?: {
        count: number
        servers: Array<{
          name: string
          enabled?: boolean
        }>
      }
      envSummary?: {
        keys: string[]
        count: number
      }
      promptConfigSummary?: {
        configured: boolean
        keyCount: number
        version?: string
      }
    }
    counts: {
      sessions: number
      activeSessions: number
      channels: number
    }
    sessions: Array<{
      sessionId: string
      title: string
      summary?: string
      updatedAt: number
      channelId?: string
      runtime?: {
        sessionStatus?: string
      }
    }>
  }>
  error?: string
}
