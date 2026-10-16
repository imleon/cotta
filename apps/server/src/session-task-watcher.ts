import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { sessionTaskDir } from './session-task-snapshot.js'

export type SessionTaskWatcher = {
  close(): void
}

async function watchedDirectory(root: string): Promise<string | null> {
  let ancestor = root
  for (;;) {
    try {
      if ((await stat(ancestor)).isDirectory()) return ancestor
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return null
    ancestor = parent
  }
}

export async function watchSessionTasks(sessionId: string, onChange: () => void | Promise<void>): Promise<SessionTaskWatcher | null> {
  const dir = sessionTaskDir(sessionId)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = Promise.resolve()
  let watcher: FSWatcher | null = null
  let watchedDir: string | null = null
  let forceRewatch = false

  const syncWatcher = async () => {
    const next = await watchedDirectory(dir)
    if (!forceRewatch && watchedDir === next) return
    forceRewatch = false
    watcher?.close()
    watcher = null
    watchedDir = next
    if (closed || !next) return
    watcher = watch(next, (event, fileName) => {
      const name = typeof fileName === 'string' ? fileName : null
      if ((next === dir && event === 'rename') || !name) forceRewatch = true
      if (next === dir || !name || (event === 'rename' && name === relative(next, dir).split(sep)[0])) schedule()
    })
    watcher.on('error', (error) => console.error(`session-task-watcher:watch failed for ${sessionId}`, error))
  }

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      running = running
        .then(syncWatcher)
        .then(() => onChange())
        .catch((error) => console.error(`session-task-watcher:refresh failed for ${sessionId}`, error))
    }, 50)
    timer.unref?.()
  }

  try {
    await syncWatcher()
  } catch (error) {
    throw new Error(`Failed to initialize task watcher for ${sessionId} at ${dir}`, { cause: error })
  }

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
      watcher = null
    },
  }
}
