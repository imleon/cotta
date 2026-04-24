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
})
