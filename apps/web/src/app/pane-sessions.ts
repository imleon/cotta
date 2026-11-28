import type { ProjectSummary, SessionSummary } from '@cotta/shared'
import { useQueries } from '@tanstack/react-query'
import { useMachineApi } from '../client/machine-scope'

export type PaneSessionRef = { projectId: string; sessionId: string }
export type PaneSessionInfo = { project: ProjectSummary | null; session: SessionSummary | null }

export const paneSessionQueryKeys = {
  all: ['pane-session'] as const,
  project: (projectId: string) => ['pane-session', projectId] as const,
  session: (projectId: string, sessionId: string) => ['pane-session', projectId, sessionId] as const,
}

/**
 * Summaries of sessions shown in panes other than the focused one. The focused pane reads the shell's selection; the
 * others may belong to collapsed or unloaded projects (for example after a reload restores the layout), so each asks
 * for its own session. Invalidate `paneSessionQueryKeys.project` when the list stream reports a change there.
 */
export function usePaneSessionInfo(sessions: readonly PaneSessionRef[]): Map<string, PaneSessionInfo> {
  const api = useMachineApi()
  const results = useQueries({
    queries: sessions.map(({ projectId, sessionId }) => ({
      queryKey: paneSessionQueryKeys.session(projectId, sessionId),
      queryFn: async (): Promise<PaneSessionInfo> => {
        const response = await api.queryProjectSessions([{ projectId, limit: 1, selectedSessionId: sessionId }])
        const window = response.sessionsByProject[projectId]
        return {
          project: window?.project ?? null,
          session: window?.selectedSessionDetail ?? window?.sessions.find((session) => session.id === sessionId) ?? null,
        }
      },
      retry: false,
    })),
  })
  const info = new Map<string, PaneSessionInfo>()
  sessions.forEach(({ sessionId }, index) => {
    const data = results[index]?.data
    if (data) info.set(sessionId, data)
  })
  return info
}
