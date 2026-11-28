import type { SessionRuntimeResponse } from '@cotta/shared'
import { type ComponentProps, useEffect, useState } from 'react'
import { SessionRuntimeHttpError } from '../api'
import { useMachineApi } from '../client/machine-scope'
import { WorkspacePanel } from './workspace-panel'

type WorkspacePanelProps = ComponentProps<typeof WorkspacePanel>

export type SessionPaneProps = Omit<WorkspacePanelProps, 'sessionRuntime' | 'projectDirectoryUnavailable' | 'timelineInstanceNonce'> & {
  /** Bumped when this session's runtime is restarted: the runtime is ensured again and the Timeline remounts. */
  restartNonce: number
}

/**
 * One session in the main area. It owns the state that belongs to its session — the ensured runtime and whether its
 * project directory is unavailable — so several panes can show different sessions side by side. Results are tied to
 * the session and restart they were requested for, so a late response never lands on another session.
 */
export function SessionPane({ restartNonce, ...props }: SessionPaneProps) {
  const api = useMachineApi()
  const { projectId, selectedSessionId: sessionId, selectedSession } = props
  const sessionAvailable = Boolean(selectedSession)
  const externallyOwned = selectedSession?.occupiedBy === 'external'
  const [runtime, setRuntime] = useState<{ sessionId: string; restartNonce: number; value: SessionRuntimeResponse } | null>(null)
  const [unavailable, setUnavailable] = useState<{ projectId: string; sessionId: string; restartNonce: number } | null>(null)

  useEffect(() => {
    // An externally owned session is driven by the CLI; Cotta does not hold a runtime for it.
    if (!projectId || !sessionId || !sessionAvailable || externallyOwned) return
    let cancelled = false
    api
      .ensureSessionRuntime(sessionId)
      .then((value) => {
        if (!cancelled) setRuntime({ sessionId, restartNonce, value })
      })
      .catch((error: unknown) => {
        if (!cancelled && error instanceof SessionRuntimeHttpError && error.code === 'project_directory_unavailable') setUnavailable({ projectId, sessionId, restartNonce })
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, sessionId, sessionAvailable, externallyOwned, restartNonce])

  const sessionRuntime = !externallyOwned && runtime?.sessionId === sessionId && runtime.restartNonce === restartNonce ? runtime.value : null
  const projectDirectoryUnavailable = unavailable !== null && unavailable.projectId === projectId && unavailable.sessionId === sessionId && unavailable.restartNonce === restartNonce

  return <WorkspacePanel {...props} sessionRuntime={sessionRuntime} projectDirectoryUnavailable={projectDirectoryUnavailable} timelineInstanceNonce={restartNonce} />
}
