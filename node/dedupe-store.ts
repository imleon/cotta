export class DedupeStore {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = 5000,
  ) {}

  checkAndMark(key?: string): boolean {
    if (!key) return false
    const now = Date.now()
    this.cleanup(now)
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (typeof oldest === 'string') {
        this.seen.delete(oldest)
      }
    }
    return false
  }

  cleanup(now: number = Date.now()): void {
    for (const [key, seenAt] of this.seen.entries()) {
      if (now - seenAt > this.ttlMs) {
        this.seen.delete(key)
        continue
      }
      break
    }
  }
}
