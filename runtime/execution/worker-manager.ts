import type { AgentTemplate } from '../orchestration/types.js'
import type { WorkerHandle } from './types.js'

export type WorkerStartMode = 'new' | 'resume'

export interface WorkerFactory {
  start(input: {
    sessionId: string
    agent: AgentTemplate
    mode: WorkerStartMode
  }): Promise<WorkerHandle>
}

export class WorkerManager {
  private readonly active = new Map<string, WorkerHandle>()
  private readonly starting = new Map<string, Promise<WorkerHandle>>()

  constructor(private readonly factory: WorkerFactory) {}

  get(sessionId: string): WorkerHandle | null {
    return this.active.get(sessionId) ?? null
  }

  list(): WorkerHandle[] {
    return [...this.active.values()]
  }

  remove(sessionId: string): void {
    this.active.delete(sessionId)
    this.starting.delete(sessionId)
  }

  async start(sessionId: string, agent: AgentTemplate, mode: WorkerStartMode): Promise<WorkerHandle> {
    const existing = this.active.get(sessionId)
    if (existing) return existing

    const inflight = this.starting.get(sessionId)
    if (inflight) return inflight

    const promise = this.factory.start({ sessionId, agent, mode })
      .then((handle) => {
        this.active.set(sessionId, handle)
        this.starting.delete(sessionId)
        return handle
      })
      .catch((error: unknown) => {
        this.starting.delete(sessionId)
        throw error
      })

    this.starting.set(sessionId, promise)
    return promise
  }

  async stop(sessionId: string): Promise<boolean> {
    const existing = this.active.get(sessionId)
    if (!existing) {
      const inflight = this.starting.get(sessionId)
      if (!inflight) return false

      try {
        const handle = await inflight
        await handle.close()
        this.remove(sessionId)
        return true
      } catch {
        this.remove(sessionId)
        return false
      }
    }

    await existing.close()
    this.remove(sessionId)
    return true
  }
}
