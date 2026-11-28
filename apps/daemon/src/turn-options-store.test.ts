import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { TurnOptionsStore } from './turn-options-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-turn-options-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  return { db, store: new TurnOptionsStore(db) }
}

describe('TurnOptionsStore', () => {
  it('stores and loads turn options', async () => {
    const { db, store: options } = await store()

    options.setSessionTurnOptions('session', { permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }, 100)

    expect(options.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })
    db.close()
  })

  it('patches permission independently from model and effort', async () => {
    const { db, store: options } = await store()

    options.setSessionTurnOptions('session', { model: 'claude-opus-5', effort: 'high' }, 100)
    options.setSessionTurnOptions('session', { permissionMode: 'plan' }, 101)
    expect(options.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })

    options.setSessionTurnOptions('session', { model: 'claude-sonnet-5', effort: 'medium' }, 102)
    expect(options.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'medium' })
    db.close()
  })

  it('ignores older observations and accepts newer ones', async () => {
    const { db, store: options } = await store()

    expect(options.setSessionTurnOptions('session', { permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }, 100)).toBe(true)
    expect(options.setSessionTurnOptions('session', { permissionMode: 'default', model: null, effort: null }, 99)).toBe(false)
    expect(options.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })

    expect(options.setSessionTurnOptions('session', { permissionMode: 'acceptEdits', model: 'claude-sonnet-5', effort: 'xhigh' }, 101)).toBe(true)
    expect(options.getSessionTurnOptions('session')).toEqual({ permissionMode: 'acceptEdits', model: 'claude-sonnet-5', effort: 'xhigh' })
    db.close()
  })

  it('versions only observed turn-options changes', async () => {
    const { db, store: options } = await store()

    options.setSessionTurnOptions('session', { permissionMode: 'plan' }, 100)
    expect(options.timelineVersion('project', 'session')).toBe('turn-options=100:plan::')

    db.prepare('UPDATE session_index SET context_usage_json = ?, context_usage_updated_at_ms = ?, updated_at_ms = ? WHERE session_id = ?').run(
      '{"categories":[],"totalTokens":10,"autoCompactThreshold":null,"maxTokens":200,"percentage":5}',
      200,
      200,
      'session',
    )
    expect(options.timelineVersion('project', 'session')).toBe('turn-options=100:plan::')

    options.setSessionTurnOptions('session', { permissionMode: 'acceptEdits' }, 100)
    expect(options.timelineVersion('project', 'session')).toBe('turn-options=100:acceptEdits::')
    db.close()
  })

  it('records the mode left when entering plan and clears it when plan ends', async () => {
    const { db, store: options } = await store()

    options.setSessionTurnOptions('session', { permissionMode: 'plan' }, 100, 'acceptEdits')
    expect(options.getPrePlanPermissionMode('session')).toBe('acceptEdits')

    options.setSessionTurnOptions('session', { permissionMode: 'bypassPermissions' }, 101)
    options.setSessionTurnOptions('session', { permissionMode: 'plan' }, 102)
    expect(options.getPrePlanPermissionMode('session')).toBe('bypassPermissions')

    options.setSessionTurnOptions('session', { permissionMode: 'plan' }, 103)
    options.setSessionTurnOptions('session', { model: 'claude-opus-5', effort: 'high' }, 104)
    expect(options.getPrePlanPermissionMode('session')).toBe('bypassPermissions')

    expect(options.setSessionTurnOptions('session', { permissionMode: 'default' }, 99)).toBe(false)
    expect(options.getPrePlanPermissionMode('session')).toBe('bypassPermissions')

    options.setSessionTurnOptions('implicit', { model: 'claude-opus-5', effort: 'high' }, 100)
    options.setSessionTurnOptions('implicit', { permissionMode: 'plan' }, 101, 'auto')
    expect(options.getPrePlanPermissionMode('implicit')).toBe('auto')

    options.setSessionTurnOptions('default-plan', { permissionMode: 'plan' }, 100, 'plan')
    expect(options.getPrePlanPermissionMode('default-plan')).toBeNull()

    options.setSessionTurnOptions('session', { permissionMode: 'acceptEdits' }, 105)
    expect(options.getPrePlanPermissionMode('session')).toBeNull()
    expect(options.getPrePlanPermissionMode('missing')).toBeNull()
    db.close()
  })
})
