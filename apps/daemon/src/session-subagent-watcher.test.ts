import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchSessionSubagents } from './session-subagent-watcher.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('watchSessionSubagents', () => {
  it('observes the first subagent created after the watcher starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-watcher-missing-'))
    roots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    const subagentsDir = join(root, 'session', 'subagents')
    await writeFile(transcriptPath, '')
    const onChange = vi.fn()
    const watcher = await watchSessionSubagents('session', transcriptPath, onChange)
    expect(watcher).not.toBeNull()

    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(subagentsDir, 'agent-a.meta.json'), '{}')
    await writeFile(join(subagentsDir, 'agent-a.jsonl'), '{}\n')

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    watcher?.close()
  })

  it('observes top-level metadata changes and ignores nested writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-subagent-watcher-'))
    roots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    const subagentsDir = join(root, 'session', 'subagents')
    const nestedDir = join(subagentsDir, 'nested')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(transcriptPath, '')
    const onChange = vi.fn()
    const watcher = await watchSessionSubagents('session', transcriptPath, onChange)
    expect(watcher).not.toBeNull()

    await writeFile(join(subagentsDir, 'agent-a.meta.json'), '{}')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce())

    onChange.mockClear()
    await writeFile(join(nestedDir, 'agent-b.meta.json'), '{}')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(onChange).not.toHaveBeenCalled()
    watcher?.close()
  })
})
