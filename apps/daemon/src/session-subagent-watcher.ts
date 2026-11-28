import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sessionSubagentDir } from './session-subagent-snapshot.js'

export type SessionSubagentWatcher = {
  close(): void
}

async function watchedDirectories(root: string): Promise<string[]> {
  let ancestor = root
  for (;;) {
    try {
      if ((await stat(ancestor)).isDirectory()) break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return []
    ancestor = parent
  }
  return [ancestor]
}

export async function watchSessionSubagents(sessionId: string, transcriptPath: string, onChange: () => void | Promise<void>): Promise<SessionSubagentWatcher> {
  const root = sessionSubagentDir(sessionId, transcriptPath)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = Promise.resolve()
  const watchers = new Map<string, FSWatcher>()

  const syncWatchers = async () => {
    const next = new Set(await watchedDirectories(root))
    for (const [dir, watcher] of watchers) {
      if (next.has(dir)) continue
      watcher.close()
      watchers.delete(dir)
    }
    for (const dir of next) {
      if (closed || watchers.has(dir)) continue
      const watcher = watch(dir, (event, fileName) => {
        const name = typeof fileName === 'string' ? fileName : null
        if (!name || name.endsWith('.meta.json') || name.endsWith('.jsonl')) schedule()
        else if (event === 'rename')
          void stat(join(dir, name))
            .then((info) => info.isDirectory() && schedule())
            .catch(() => {})
      })
      watcher.on('error', (error) => console.error(`session-subagent-watcher:watch failed for ${sessionId}`, error))
      watchers.set(dir, watcher)
    }
  }

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      running = running
        .then(syncWatchers)
        .then(() => onChange())
        .catch((error) => console.error(`session-subagent-watcher:refresh failed for ${sessionId}`, error))
    }, 50)
    timer.unref?.()
  }

  try {
    await syncWatchers()
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close()
    throw new Error(`Failed to initialize subagent watcher for ${sessionId} at ${root}`, { cause: error })
  }

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
