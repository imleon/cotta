import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionSubagentSnapshot } from './session-subagent-snapshot.js'

const roots: string[] = []

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readSessionSubagentSnapshot', () => {
  it('extracts indexed fields and preserves the complete metadata object', async () => {
    const root = await tempRoot('cotta-subagent-snapshot-')
    const sessionId = 'session-1'
    const transcriptPath = join(root, 'project', `${sessionId}.jsonl`)
    const dir = join(root, 'project', sessionId, 'subagents')
    const meta = {
      agentType: 'general-purpose',
      description: 'Check',
      parentAgentId: 'parent-1',
      model: 'sonnet',
      name: 'reviewer',
      isFork: true,
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-a1.meta.json'), JSON.stringify(meta))
    await writeFile(join(dir, 'agent-a1.jsonl'), '{not relevant}\n')
    await writeFile(join(dir, 'notes.meta.json'), '{}')

    const result = await readSessionSubagentSnapshot(sessionId, transcriptPath)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId,
      subagentId: 'a1',
      parentAgentId: 'parent-1',
      agentType: 'general-purpose',
      name: 'reviewer',
      description: 'Check',
      model: 'sonnet',
      metaPath: join(dir, 'agent-a1.meta.json'),
      metaJson: meta,
    })
    expect(result[0]?.metaFileSize).toBeGreaterThan(0)
    expect(result[0]?.metaFileMtimeMs).toBeGreaterThan(0)
    expect(result[0]?.transcriptPath).toBe(join(dir, 'agent-a1.jsonl'))
    expect(result[0]?.transcriptFileSize).toBeGreaterThan(0)
    expect(result[0]?.observedAtMs).toBeGreaterThan(0)
  })

  it('ignores nested metadata', async () => {
    const root = await tempRoot('cotta-subagent-snapshot-')
    const sessionId = 'session-1'
    const transcriptPath = join(root, 'project', `${sessionId}.jsonl`)
    const nested = join(root, 'project', sessionId, 'subagents', 'nested')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'agent-child.meta.json'), JSON.stringify({ parentAgentId: 'root' }))

    const result = await readSessionSubagentSnapshot(sessionId, transcriptPath)
    expect(result).toEqual([])
  })

  it('returns an empty successful scan when the subagents directory is absent', async () => {
    const root = await tempRoot('cotta-subagent-snapshot-')
    const result = await readSessionSubagentSnapshot('session-1', join(root, 'project', 'session-1.jsonl'))

    expect(result).toEqual([])
  })

  it('fails visibly when metadata remains malformed', async () => {
    const root = await tempRoot('cotta-subagent-snapshot-')
    const sessionId = 'session-1'
    const transcriptPath = join(root, 'project', `${sessionId}.jsonl`)
    const dir = join(root, 'project', sessionId, 'subagents')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-a1.meta.json'), '{')

    await expect(readSessionSubagentSnapshot(sessionId, transcriptPath, { retryDelayMs: 0 })).rejects.toThrow(`Failed to read subagent metadata for ${sessionId} at ${dir}`)
  })
})
