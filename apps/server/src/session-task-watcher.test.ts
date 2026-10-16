import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchSessionTasks } from './session-task-watcher.js'

const roots: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('watchSessionTasks', () => {
  it('rewatches a task directory recreated within the debounce window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-task-watcher-'))
    roots.push(root)
    process.env.CLAUDE_CONFIG_DIR = root
    const taskDir = join(root, 'tasks', 'session')
    await mkdir(taskDir, { recursive: true })
    const onChange = vi.fn()
    const watcher = await watchSessionTasks('session', onChange)

    await rm(taskDir, { recursive: true })
    await mkdir(taskDir)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()

    await writeFile(join(taskDir, '2.json'), '{}')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    watcher?.close()
  })

  it('watches an absent task directory through its ancestor and switches after creation and deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-task-watcher-'))
    roots.push(root)
    process.env.CLAUDE_CONFIG_DIR = root
    const taskDir = join(root, 'tasks', 'session')
    await mkdir(join(root, 'tasks'), { recursive: true })
    const onChange = vi.fn()
    const watcher = await watchSessionTasks('session', onChange)

    await mkdir(taskDir)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()

    await writeFile(join(taskDir, '1.json'), '{}')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()

    await rm(taskDir, { recursive: true })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()

    await mkdir(taskDir)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()

    await writeFile(join(taskDir, '2.json'), '{}')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    watcher?.close()
  })
})
