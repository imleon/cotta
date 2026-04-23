import type { AgentTemplate } from './types.js'
import type { SessionRegistry } from './session-registry.js'
import type { WorkerHandle, WorkerOutputEvent } from '../execution/types.js'
import type { WorkerManager, WorkerStartMode } from '../execution/worker-manager.js'
import { computeWorkerConfigSignature } from './worker-config-signature.js'

export class WorkerSupervisor {
  private readonly attachedWorkers = new Set<string>()

  constructor(
    private readonly deps: {
      workerManager: WorkerManager
      sessionRegistry: SessionRegistry
    },
    private readonly callbacks: {
      onWorkerEvent: (event: WorkerOutputEvent) => Promise<void>
    },
  ) {}

  getWorker(sessionId: string): WorkerHandle | null {
    return this.deps.workerManager.get(sessionId)
  }

  async ensureWorker(
    sessionId: string,
    agent: AgentTemplate,
    mode: WorkerStartMode,
  ): Promise<WorkerHandle> {
    const desiredSig = computeWorkerConfigSignature(agent)
    const existing = this.deps.workerManager.get(sessionId)
    if (existing) {
      const session = this.deps.sessionRegistry.get(sessionId)
      const currentSig = session?.workerConfigSig
      if (currentSig && currentSig !== desiredSig) {
        // Don't rebuild in the middle of an active run; defer until idle.
        if (session?.activeRunId || (session?.sessionStatus && session.sessionStatus !== 'idle')) {
          return existing
        }

        console.info('[worker-supervisor] config changed; rebuilding worker', {
          sessionId,
          // This is canonical JSON (not a hash). Avoid logging raw config (may contain secrets).
          fromType: currentSig.length === 64 && /^[0-9a-f]+$/i.test(currentSig) ? 'sha256-legacy' : 'json',
          toType: 'json',
        })
        await this.stopWorker(sessionId)
      } else if (!currentSig) {
        // Backfill the signature for existing sessions.
        this.deps.sessionRegistry.setWorkerConfigSig(sessionId, desiredSig)
      }

      this.attachWorkerOutputIfNeeded(existing)
      return existing
    }

    const handle = await this.deps.workerManager.start(sessionId, agent, mode)
    this.deps.sessionRegistry.attachWorker(sessionId, handle.workerRef)
    this.deps.sessionRegistry.setWorkerConfigSig(sessionId, desiredSig)
    this.attachWorkerOutputIfNeeded(handle)
    return handle
  }

  async stopWorker(sessionId: string): Promise<boolean> {
    const stopped = await this.deps.workerManager.stop(sessionId)
    this.deps.sessionRegistry.detachWorker(sessionId)
    return stopped
  }

  private attachWorkerOutputIfNeeded(handle: WorkerHandle): void {
    if (this.attachedWorkers.has(handle.workerRef)) return
    this.attachedWorkers.add(handle.workerRef)

    void (async () => {
      try {
        for await (const event of handle.output) {
          await this.callbacks.onWorkerEvent(event)
        }
      } finally {
        this.attachedWorkers.delete(handle.workerRef)
        this.deps.workerManager.remove(handle.sessionId)
        this.deps.sessionRegistry.detachWorker(handle.sessionId)
      }
    })()
  }
}
