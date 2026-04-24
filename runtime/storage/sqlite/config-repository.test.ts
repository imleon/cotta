import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteDatabase } from './db.js'
import { SqliteConfigRepository } from './config-repository.js'

const tempDirs: string[] = []

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cotta-config-repo-test-'))
  tempDirs.push(dir)
  return join(dir, `${name}.sqlite`)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function getCreatedAt(db: ReturnType<typeof createSqliteDatabase>, table: 'connectors' | 'agents' | 'channels', idColumn: string, id: string): number {
  const row = db.prepare(`SELECT created_at AS createdAt FROM ${table} WHERE ${idColumn} = ?`).get(id) as { createdAt?: number } | undefined
  return row?.createdAt ?? -1
}

describe('SqliteConfigRepository channel binding', () => {
  it('binds a session to a channel atomically by clearing prior holders first', () => {
    const db = createSqliteDatabase(createTempDbPath('binding'))
    const repository = new SqliteConfigRepository(db)
    repository.replaceRuntimeConfig({
      connectors: [
        {
          connectorId: 'connector-1',
          connectorType: 'lark',
          connectorConfig: { appId: 'app', appSecret: 'secret' },
        },
      ],
      agents: [
        {
          agentId: 'agent-1',
          projectDir: '/tmp/project',
          modelJson: { model: 'claude-sonnet' },
        },
      ],
      channels: [
        {
          channelId: 'channel-1',
          channelKey: 'chat-1',
          connectorId: 'connector-1',
          agentId: 'agent-1',
          enabled: true,
          currentSdkSessionId: 'session-1',
        },
        {
          channelId: 'channel-2',
          channelKey: 'chat-2',
          connectorId: 'connector-1',
          agentId: 'agent-1',
          enabled: true,
        },
      ],
    })

    repository.bindChannelToSession('channel-2', 'session-1')

    expect(repository.getChannelCurrentSdkSessionId('channel-1')).toBeNull()
    expect(repository.getChannelCurrentSdkSessionId('channel-2')).toBe('session-1')
    expect(repository.listChannels().find((channel) => channel.channelId === 'channel-1')?.currentSdkSessionId).toBeUndefined()
    expect(repository.listChannels().find((channel) => channel.channelId === 'channel-2')?.currentSdkSessionId).toBe('session-1')

    db.close()
  })

  it('fails fast when persisted JSON is malformed instead of silently falling back', () => {
    const db = createSqliteDatabase(createTempDbPath('invalid-json'))
    const repository = new SqliteConfigRepository(db)
    db.exec(`
      INSERT INTO connectors (
        connector_id,
        connector_type,
        connector_config_json,
        created_at,
        updated_at
      ) VALUES (
        'connector-bad',
        'lark',
        '{bad json',
        1,
        1
      );
    `)

    expect(() => repository.listConnectors()).toThrow(
      'Invalid persisted JSON object in connectors.connector-bad.connector_config_json',
    )

    db.close()
  })

  it('persists lark inbound receipts and cleans up expired rows', () => {
    const db = createSqliteDatabase(createTempDbPath('lark-inbound-receipts'))
    const repository = new SqliteConfigRepository(db)

    repository.recordLarkInboundReceipt('connector-1', 'chat-1', 'message-1', {
      processedAt: 2_000,
      retentionMs: 500,
    })
    repository.recordLarkInboundReceipt('connector-1', 'chat-1', 'message-2', {
      processedAt: 3_000,
      retentionMs: 500,
    })

    expect(repository.hasLarkInboundReceipt('connector-1', 'chat-1', 'message-1')).toBe(false)
    expect(repository.hasLarkInboundReceipt('connector-1', 'chat-1', 'message-2')).toBe(true)

    db.close()
  })

  it('preserves created_at for existing rows while deleting removed config rows', () => {
    const db = createSqliteDatabase(createTempDbPath('preserve-created-at'))
    const repository = new SqliteConfigRepository(db)
    repository.replaceRuntimeConfig({
      connectors: [
        {
          connectorId: 'connector-1',
          connectorType: 'lark',
          connectorConfig: { appId: 'app-1', appSecret: 'secret-1' },
        },
        {
          connectorId: 'connector-2',
          connectorType: 'lark',
          connectorConfig: { appId: 'app-2', appSecret: 'secret-2' },
        },
      ],
      agents: [
        {
          agentId: 'agent-1',
          projectDir: '/tmp/project-a',
          modelJson: { model: 'claude-sonnet' },
        },
        {
          agentId: 'agent-2',
          projectDir: '/tmp/project-b',
          modelJson: { model: 'claude-opus' },
        },
      ],
      channels: [
        {
          channelId: 'channel-1',
          channelKey: 'chat-1',
          connectorId: 'connector-1',
          agentId: 'agent-1',
          enabled: true,
        },
        {
          channelId: 'channel-2',
          channelKey: 'chat-2',
          connectorId: 'connector-2',
          agentId: 'agent-2',
          enabled: true,
        },
      ],
    })

    const connectorCreatedAt = getCreatedAt(db, 'connectors', 'connector_id', 'connector-1')
    const agentCreatedAt = getCreatedAt(db, 'agents', 'agent_id', 'agent-1')
    const channelCreatedAt = getCreatedAt(db, 'channels', 'channel_id', 'channel-1')

    repository.replaceRuntimeConfig({
      connectors: [
        {
          connectorId: 'connector-1',
          connectorType: 'lark',
          connectorConfig: { appId: 'app-1b', appSecret: 'secret-1b' },
        },
      ],
      agents: [
        {
          agentId: 'agent-1',
          projectDir: '/tmp/project-a-next',
          modelJson: { model: 'claude-sonnet' },
        },
      ],
      channels: [
        {
          channelId: 'channel-1',
          channelKey: 'chat-1-next',
          connectorId: 'connector-1',
          agentId: 'agent-1',
          enabled: false,
        },
      ],
    })

    expect(getCreatedAt(db, 'connectors', 'connector_id', 'connector-1')).toBe(connectorCreatedAt)
    expect(getCreatedAt(db, 'agents', 'agent_id', 'agent-1')).toBe(agentCreatedAt)
    expect(getCreatedAt(db, 'channels', 'channel_id', 'channel-1')).toBe(channelCreatedAt)
    expect(repository.listConnectors().map((item) => item.connectorId)).toEqual(['connector-1'])
    expect(repository.listAgents().map((item) => item.agentId)).toEqual(['agent-1'])
    expect(repository.listChannels().map((item) => item.channelId)).toEqual(['channel-1'])

    db.close()
  })
})
