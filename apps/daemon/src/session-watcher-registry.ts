import { type SessionSubagentWatcher, watchSessionSubagents } from './session-subagent-watcher.js'
import { type SessionTaskWatcher, watchSessionTasks } from './session-task-watcher.js'

type Watcher = SessionTaskWatcher | SessionSubagentWatcher

type Entry = {
  callbacks: Set<() => void | Promise<void>>
  watcher: Watcher | null
  starting: Promise<void>
}

export class SessionWatcherRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly watchers = { watchSessionTasks, watchSessionSubagents }) {}

  acquireTask(sessionId: string, onChange: () => void | Promise<void>): Promise<() => void> {
    return this.acquire(`task:${sessionId}`, onChange, (notify) => this.watchers.watchSessionTasks(sessionId, notify))
  }

  acquireSubagent(sessionId: string, transcriptPath: string, onChange: () => void | Promise<void>): Promise<() => void> {
    return this.acquire(`subagent:${sessionId}:${transcriptPath}`, onChange, (notify) => this.watchers.watchSessionSubagents(sessionId, transcriptPath, notify))
  }

  private async acquire(key: string, onChange: () => void | Promise<void>, start: (notify: () => Promise<void>) => Promise<Watcher | null>): Promise<() => void> {
    let entry = this.entries.get(key)
    if (entry) entry.callbacks.add(onChange)
    else {
      const created: Entry = { callbacks: new Set([onChange]), watcher: null, starting: Promise.resolve() }
      entry = created
      this.entries.set(key, created)
      created.starting = start(async () => {
        await Promise.all([...created.callbacks].map((callback) => callback()))
      })
        .then((watcher) => {
          created.watcher = watcher
          if (!watcher || created.callbacks.size === 0 || this.entries.get(key) !== created) this.closeEntry(key, created)
        })
        .catch((error) => {
          if (this.entries.get(key) === created) this.entries.delete(key)
          throw error
        })
    }
    await entry.starting
    let released = false
    return () => {
      if (released) return
      released = true
      entry.callbacks.delete(onChange)
      if (entry.callbacks.size === 0 && entry.watcher) this.closeEntry(key, entry)
      else if (entry.callbacks.size === 0 && this.entries.get(key) === entry) this.entries.delete(key)
    }
  }

  close(): void {
    for (const [key, entry] of this.entries) this.closeEntry(key, entry)
  }

  private closeEntry(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key)
    entry.watcher?.close()
    entry.watcher = null
  }
}
