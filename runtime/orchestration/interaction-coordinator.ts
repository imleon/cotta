import type { RunRegistry } from './run-registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { PendingActionRecord } from './types.js'
import type { WorkerOutputEvent } from '../execution/types.js'

type ControlTransactionEvent = Extract<WorkerOutputEvent, { kind: 'control_transaction' }>

export class InteractionCoordinator {
  constructor(
    private readonly deps: {
      runRegistry: RunRegistry
      sessionRegistry: SessionRegistry
    },
  ) {}

  onControlTransaction(event: ControlTransactionEvent): void {
    const runId = event.transaction.runId
    if (!runId) return

    if (event.phase === 'awaiting_user') {
      this.deps.runRegistry.setStatus(runId, 'requires_action')
      this.deps.runRegistry.setPendingAction(runId, this.toPendingAction(event.transaction.interaction))
      this.deps.sessionRegistry.setStatus(event.sessionId, 'requires_action')
      return
    }

    if (
      event.phase === 'responded'
      || event.phase === 'completed'
      || event.phase === 'cancel_requested'
      || event.phase === 'cancelled'
      || event.phase === 'failed'
    ) {
      this.deps.runRegistry.setPendingAction(runId, undefined)
    }
  }

  private toPendingAction(
    interaction: ControlTransactionEvent['transaction']['interaction'],
  ): PendingActionRecord | undefined {
    if (!interaction) return undefined
    if (interaction.kind === 'permission') {
      return {
        kind: 'can_use_tool',
        tool: interaction.toolName,
        reason: interaction.decisionReason,
        requestId: interaction.id,
      }
    }
    return {
      kind: 'elicitation',
      server: interaction.serverName,
      question: interaction.message,
      requestId: interaction.id,
    }
  }
}

