import { type FSWatcher, watch } from 'chokidar'

export type ProjectFilesWatchEvent = { version: number; contentOnly?: true }

type WatchPath = string | { path: string; contentOnlyOnChange: true }

type Entry = {
  callbacks: Set<(event: ProjectFilesWatchEvent) => void>
  contentOnlyOnChange: boolean
  ready: Promise<void>
  timer: ReturnType<typeof setTimeout> | null
  pendingContentOnly: boolean
  watcher: FSWatcher
}

const DEBOUNCE_MS = 100

function ignored(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules')
}

export class ProjectFilesWatcherRegistry {
  private readonly entries = new Map<string, Entry>()
  private version = 0

  async acquire(paths: readonly WatchPath[] | WatchPath, onChange: (event: ProjectFilesWatchEvent) => void): Promise<{ release: () => void; version: number }> {
    const watchedPaths = new Map<string, boolean>()
    for (const entry of typeof paths === 'string' || 'path' in paths ? [paths] : paths) {
      const path = typeof entry === 'string' ? entry : entry.path
      watchedPaths.set(path, Boolean(watchedPaths.get(path) || (typeof entry !== 'string' && entry.contentOnlyOnChange)))
    }
    let released = false
    const notify = (event: ProjectFilesWatchEvent) => onChange(event)
    const release = () => {
      if (released) return
      released = true
      for (const path of watchedPaths.keys()) {
        const entry = this.entries.get(path)
        if (!entry) continue
        entry.callbacks.delete(notify)
        if (entry.callbacks.size !== 0) continue
        if (entry.timer) clearTimeout(entry.timer)
        this.entries.delete(path)
        void entry.watcher.close()
      }
    }

    try {
      for (const [path, contentOnlyOnChange] of watchedPaths) {
        let entry = this.entries.get(path)
        if (!entry) {
          const watchGitMetadata = path.split(/[\\/]/).includes('.git')
          const watcher = watch(path, { depth: 0, ignoreInitial: true, ignored: watchGitMetadata ? (candidate) => candidate.split(/[\\/]/).includes('node_modules') : ignored }).on('error', (error) =>
            console.error(`project-files-watcher:watch failed for ${path}`, error),
          )
          const nextEntry: Entry = {
            callbacks: new Set(),
            contentOnlyOnChange,
            ready: new Promise<void>((resolve, reject) => {
              watcher.once('ready', resolve)
              watcher.once('error', reject)
            }),
            timer: null,
            pendingContentOnly: false,
            watcher,
          }
          watcher.on('all', (event) => {
            const contentOnly = nextEntry.contentOnlyOnChange && event === 'change'
            if (!contentOnly && !watchGitMetadata && event === 'change') return
            nextEntry.pendingContentOnly = nextEntry.timer ? nextEntry.pendingContentOnly && contentOnly : contentOnly
            if (nextEntry.timer) clearTimeout(nextEntry.timer)
            nextEntry.timer = setTimeout(() => {
              nextEntry.timer = null
              this.version += 1
              const notification = { version: this.version, ...(nextEntry.pendingContentOnly ? { contentOnly: true as const } : {}) }
              for (const callback of nextEntry.callbacks) callback(notification)
            }, DEBOUNCE_MS)
            nextEntry.timer.unref?.()
          })
          this.entries.set(path, nextEntry)
          void nextEntry.ready.catch(() => {
            if (this.entries.get(path) === nextEntry) this.entries.delete(path)
            void watcher.close()
          })
          entry = nextEntry
        }
        await entry.ready
        entry.callbacks.add(notify)
      }
    } catch (error) {
      release()
      throw error
    }

    return { release, version: this.version }
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      void entry.watcher.close()
    }
    this.entries.clear()
  }
}
