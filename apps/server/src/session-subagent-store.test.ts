import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { type SessionSubagentMeta, SessionSubagentStore } from './session-subagent-store.js'

function meta(subagentId: string, parentAgentId: string | null = null): SessionSubagentMeta {
  return {
    sessionId: 'session',
    subagentId,
    parentAgentId,
    agentType: 'general-purpose',
    name: null,
    description: subagentId,
    model: null,
    metaPath: `/tmp/agent-${subagentId}.meta.json`,
    metaFileSize: 1,
    metaFileMtimeMs: 2,
    transcriptPath: `/tmp/agent-${subagentId}.jsonl`,
    transcriptFileSize: 3,
    transcriptFileMtimeMs: 4,
    observedAtMs: 5,
    metaJson: {},
  }
}

describe('SessionSubagentStore', () => {
  it('shows root placeholders and enriches only descendants reachable from roots', () => {
    const db = createCottaDatabase(':memory:')
    const store = new SessionSubagentStore(db)
    expect(
      store.recordRoots(
        'session',
        [
          { subagentId: 'root', ownerTurnId: 'turn' },
          { subagentId: 'other-root', ownerTurnId: 'other-turn' },
        ],
        false,
      ),
    ).toBe(true)
    expect(store.recordRoots('session', [{ subagentId: 'root', ownerTurnId: 'turn' }], false)).toBe(false)
    expect(store.countsByTurn('session')).toEqual(
      new Map([
        ['other-turn', 1],
        ['turn', 1],
      ]),
    )
    expect(store.listTurn('session', 'turn')).toEqual([expect.objectContaining({ subagentId: 'root', ownerTurnId: 'turn', isRoot: true, metadataReady: false, metaPath: null })])

    const entries = [meta('orphan'), meta('grandchild', 'child'), meta('child', 'root'), meta('root')]
    expect(store.reconcileMetadata('session', entries)).toBe(true)
    expect(
      store.reconcileMetadata(
        'session',
        entries.map((entry) => ({ ...entry, observedAtMs: 10 })),
      ),
    ).toBe(false)
    expect(store.countsByTurn('session')).toEqual(
      new Map([
        ['other-turn', 1],
        ['turn', 1],
      ]),
    )
    expect(store.listTurn('session', 'turn').map(({ subagentId, ownerTurnId }) => ({ subagentId, ownerTurnId }))).toEqual([
      { subagentId: 'root', ownerTurnId: 'turn' },
      { subagentId: 'child', ownerTurnId: 'turn' },
      { subagentId: 'grandchild', ownerTurnId: 'turn' },
    ])

    expect(store.reconcileMetadata('session', [])).toBe(true)
    expect(store.reconcileMetadata('session', [])).toBe(false)
    expect(store.listTurn('session', 'turn')).toEqual([expect.objectContaining({ subagentId: 'root', ownerTurnId: 'turn', metadataReady: false })])
    expect((db as DatabaseSync).prepare('SELECT COUNT(*) count FROM session_subagents').get()).toEqual({ count: 2 })
    db.close()
  })
})
