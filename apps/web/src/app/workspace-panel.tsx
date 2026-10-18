import type {
  AppSettings,
  AskUserQuestionDecisionRequest,
  RawSessionTask,
  SessionRuntimeResponse,
  SessionSummary,
  SessionTimelineResponse,
  ToolApprovalDecisionRequest,
  ToolApprovalRequest,
} from '@cotta/shared'
import { type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { respondToQuestion, respondToToolApproval } from '../api'
import { authoritativeTurnPhase, CliStaticSparkIcon, SessionTaskList, SessionTimeline, type TimelineControlSignal, type TranscriptSignal, type TurnPhase } from '../timeline'
import { PermissionApprovalCard } from './permission-approval'
import { ExplorerPanel, type ProjectFileTabs } from './project-files'
import { clampProjectFilePreviewWidth, resizeProjectFilesPane } from './project-files-layout'
import { ComposerLottieButton, type PendingSubmission, type ToastState, TurnComposer } from './turn-composer'
import { UsageOverview } from './usage-overview'
import {
  clampWorkspaceExplorerWidth,
  WORKSPACE_EXPLORER_CLOSE_WIDTH,
  WORKSPACE_EXPLORER_DEFAULT_WIDTH,
  WORKSPACE_EXPLORER_MIN_WIDTH,
  workspaceExplorerLayout,
  workspaceExplorerWidthMax,
} from './workspace-explorer-layout'

export function WorkspacePaneToggleIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="SideExpandOutlined">
      <path
        d="M22 4a1 1 0 0 0-1-1H3a1 1 0 0 0 0 2h18a1 1 0 0 0 1-1Zm-11.111 7c.614 0 1.111.448 1.111 1s-.498 1-1.111 1H3.11C2.497 13 2 12.552 2 12s.497-1 1.111-1h7.778ZM12 20c0-.552-.498-1-1.111-1H3.11C2.497 19 2 19.448 2 20s.497 1 1.111 1h7.778c.614 0 1.111-.448 1.111-1Zm3.41-3.136a1.117 1.117 0 0 1 0-1.729l4.951-3.917c.675-.534 1.639-.026 1.639.865v7.834c0 .89-.964 1.4-1.639.865l-4.951-3.918Z"
        fill="currentColor"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="SideFoldOutlined">
      <path
        d="M22 4a1 1 0 0 0-1-1H3a1 1 0 0 0 0 2h18a1 1 0 0 0 1-1Zm-1.111 7c.614 0 1.111.448 1.111 1s-.497 1-1.111 1H13.11c-.613 0-1.11-.448-1.11-1s.498-1 1.111-1h7.778ZM22 20c0-.552-.497-1-1.111-1H13.11c-.614 0-1.111.448-1.111 1s.498 1 1.111 1h7.778c.614 0 1.111-.448 1.111-1ZM8.59 16.864a1.117 1.117 0 0 0 0-1.729l-4.95-3.916c-.676-.535-1.64-.027-1.64.864v7.834c0 .89.964 1.4 1.639.865l4.951-3.918Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function WorkspacePanel({
  chatHeader,
  githubLogin,
  explorerOpen,
  explorerPaneWidth,
  onExplorerPaneWidthChange,
  onExplorerOpenChange,
  projectId,
  projectName,
  projectPath,
  currentCwd,
  transcriptSignal,
  timelineControlSignal,
  timelineInstanceNonce,
  selectedSession,
  selectedSessionId,
  setSelectedSessionId,
  refreshSessionLists,
  searchAnchorTurnId = null,
  searchTarget = null,
  onSearchTargetHandled = () => {},
  onJumpToLatest = () => {},
  onSessionCreated,
  settings,
  sessionRuntime,
  projectDirectoryUnavailable,
  onForkSession,
  onNotify,
}: {
  chatHeader: ReactNode
  githubLogin: string | null
  explorerOpen: boolean
  explorerPaneWidth: number | null
  onExplorerPaneWidthChange: (width: number | null) => void
  onExplorerOpenChange: (open: boolean) => void
  projectId: string | null
  projectName: string | undefined
  projectPath?: string | null
  currentCwd: string | null
  transcriptSignal: TranscriptSignal | null
  timelineControlSignal?: TimelineControlSignal | null
  timelineInstanceNonce?: number
  selectedSession: SessionSummary | undefined
  selectedSessionId: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  refreshSessionLists: (projectIds: string[], selectedSessionId?: string | null) => void
  searchAnchorTurnId?: string | null
  searchTarget?: { kind: 'message'; turnId: string; messageUuid: string; blockIndex?: number; queryNonce: number } | { kind: 'jump-latest'; queryNonce: number } | null
  onSearchTargetHandled?: () => void
  onJumpToLatest?: () => void
  onSessionCreated: (projectId: string, sessionId: string) => void
  settings: AppSettings
  sessionRuntime: SessionRuntimeResponse | null
  projectDirectoryUnavailable: boolean
  onForkSession: (projectId: string, sessionId: string, upToMessageId: string) => Promise<unknown>
  onNotify: (toast: ToastState) => void
}) {
  const [liveTurn, setLiveTurn] = useState<{ sessionId: string; userMessageUuid: string } | null>(null)
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null)
  const [latestTurnPhase, setLatestTurnPhase] = useState<{ sessionId: string; phase: TurnPhase | null } | null>(null)
  const [turnOptions, setTurnOptions] = useState<{ projectId: string; sessionId: string; meta: SessionTimelineResponse['turnOptions'] } | null>(null)
  const [answeringApprovalId, setAnsweringApprovalId] = useState<string | null>(null)
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null)
  const answeringApprovalIdRef = useRef<string | null>(null)
  const answeredQuestionIdRef = useRef<string | null>(null)
  const [contextUsage, setContextUsage] = useState<{ sessionId: string; value: SessionTimelineResponse['contextUsage'] } | null>(null)
  const [pendingPermission, setPendingPermission] = useState<{ sessionId: string; value: SessionTimelineResponse['pendingPermission'] } | null>(null)
  const [activity, setActivity] = useState<{ sessionId: string; value: SessionTimelineResponse['activity'] } | null>(null)
  const [tasks, setTasks] = useState<{ sessionId: string; value: RawSessionTask[] | null } | null>(null)
  const [explorerPaneResizing, setExplorerPaneResizing] = useState(false)
  const [filesLayout, setFilesLayout] = useState<{ paneWidth: number; previewWidth: number } | null>(null)
  const [outerFilesPreviewWidth, setOuterFilesPreviewWidth] = useState<number | null>(null)
  const [openFiles, setOpenFiles] = useState<ProjectFileTabs>({})
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const workspaceRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const update = () => setWorkspaceWidth(workspace.getBoundingClientRect().width)
    update()
    if (!('ResizeObserver' in window)) return
    const observer = new ResizeObserver(update)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset live session state whenever the project changes
  useEffect(() => {
    setLatestTurnPhase(null)
    setLiveTurn(null)
    setContextUsage(null)
    setPendingPermission(null)
    setActivity(null)
    setTasks(null)
  }, [projectId])

  function refreshSessionListsForCurrentProject(targetProjectId = projectId, targetSessionId?: string | null) {
    if (targetProjectId) refreshSessionLists([targetProjectId], targetSessionId)
  }

  async function answerApproval(approval: ToolApprovalRequest, decision: ToolApprovalDecisionRequest) {
    if (!timelineSessionId || answeringApprovalId === approval.requestId) return
    setAnsweringApprovalId(approval.requestId)
    try {
      await respondToToolApproval(timelineSessionId, approval.requestId, decision)
      refreshSessionListsForCurrentProject(projectId, timelineSessionId)
    } catch (error) {
      setAnsweringApprovalId((current) => (current === approval.requestId ? null : current))
      onNotify({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    }
  }

  function handleLiveTurnChange(sessionId: string, userMessageUuid: string | null) {
    if (sessionId !== timelineSessionId) return
    setLiveTurn(userMessageUuid ? { sessionId, userMessageUuid } : null)
  }

  const selectedPending = pendingSubmission?.projectId === projectId && (pendingSubmission.sessionId === selectedSessionId || !selectedSessionId) ? pendingSubmission : null
  const composerPendingTurnId = pendingSubmission && (pendingSubmission.phase === 'submitting' || selectedPending) ? pendingSubmission.submissionUuid : null
  const timelineSessionId = selectedPending?.sessionId ?? selectedSessionId
  const handleLatestTurnPhaseChange = useCallback(
    (phase: TurnPhase | null) => {
      if (!timelineSessionId) return
      setLatestTurnPhase((current) => (current?.sessionId === timelineSessionId && current.phase === phase ? current : { sessionId: timelineSessionId, phase }))
    },
    [timelineSessionId],
  )
  const handlePendingPermissionChange = useCallback(
    (value: SessionTimelineResponse['pendingPermission']) => {
      if (!timelineSessionId) return
      setPendingPermission((current) => (current?.sessionId === timelineSessionId && current.value === value ? current : { sessionId: timelineSessionId, value }))
    },
    [timelineSessionId],
  )
  const handleActivityChange = useCallback(
    (value: SessionTimelineResponse['activity']) => {
      if (!timelineSessionId) return
      setActivity((current) =>
        current?.sessionId === timelineSessionId && current.value.owner === value.owner && current.value.phase === value.phase && current.value.activeTurnId === value.activeTurnId
          ? current
          : { sessionId: timelineSessionId, value },
      )
    },
    [timelineSessionId],
  )
  const handleTasksChange = useCallback(
    (value: RawSessionTask[] | null) => {
      if (timelineSessionId) setTasks({ sessionId: timelineSessionId, value })
    },
    [timelineSessionId],
  )
  const selectedPendingTurn = selectedPending?.kind === 'turn' ? selectedPending.turn : null
  const provisionalSlash = selectedPending?.kind === 'slash' ? selectedPending : null
  const liveUserMessageUuid = liveTurn?.sessionId === timelineSessionId ? liveTurn.userMessageUuid : null
  const historyEnabled = Boolean(selectedSession && selectedSession.id === timelineSessionId)
  const selectedPendingApproval = pendingPermission?.sessionId === timelineSessionId ? pendingPermission.value : null
  const selectedActivity = activity?.sessionId === timelineSessionId ? activity.value : null
  const selectedTasks = tasks?.sessionId === timelineSessionId ? tasks.value : null
  const answerQuestion = useCallback(
    async (requestId: string, decision: AskUserQuestionDecisionRequest) => {
      if (!timelineSessionId || answeringApprovalIdRef.current === requestId || answeredQuestionIdRef.current === requestId) return
      answeringApprovalIdRef.current = requestId
      setAnsweringApprovalId(requestId)
      try {
        await respondToQuestion(timelineSessionId, requestId, decision)
        answeredQuestionIdRef.current = requestId
        setAnsweredQuestionId(requestId)
      } catch (error) {
        onNotify({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
      } finally {
        answeringApprovalIdRef.current = null
        setAnsweringApprovalId((current) => (current === requestId ? null : current))
      }
    },
    [onNotify, timelineSessionId],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the answered marker whenever a different approval request is selected
  useEffect(() => {
    answeredQuestionIdRef.current = null
    setAnsweredQuestionId(null)
  }, [selectedPendingApproval?.requestId])
  const selectedTurnOptions = turnOptions?.projectId === projectId && turnOptions.sessionId === timelineSessionId ? turnOptions.meta : null
  const selectedContextUsage = contextUsage?.sessionId === timelineSessionId ? contextUsage.value : sessionRuntime?.sessionId === timelineSessionId ? sessionRuntime.contextUsage : null

  useEffect(() => {
    if (!selectedSessionId && selectedPending && selectedSession) setSelectedSessionId(selectedPending.sessionId)
  }, [selectedPending, selectedSession, selectedSessionId, setSelectedSessionId])

  function beginExplorerPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    const workspace = workspaceRef.current
    if (!workspace) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const bounds = workspace.getBoundingClientRect()
    let proposedWidth = bounds.right - event.clientX
    const initialFilesLayout = filesLayout
    const updateWidth = (requestedWidth: number) => {
      if (initialFilesLayout) {
        const layout = resizeProjectFilesPane({
          paneWidth: initialFilesLayout.paneWidth,
          previewWidth: initialFilesLayout.previewWidth,
          requestedPaneWidth: Math.min(workspaceExplorerWidthMax(bounds.width), requestedWidth),
        })
        setFilesLayout(layout)
        setOuterFilesPreviewWidth(layout.previewWidth)
        onExplorerPaneWidthChange(layout.paneWidth)
        return
      }
      onExplorerPaneWidthChange(requestedWidth <= WORKSPACE_EXPLORER_CLOSE_WIDTH ? 0 : clampWorkspaceExplorerWidth(requestedWidth, bounds.width))
    }
    setExplorerPaneResizing(true)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return
      proposedWidth = bounds.right - moveEvent.clientX
      updateWidth(proposedWidth)
    }

    function finishResize(collapse: boolean) {
      setExplorerPaneResizing(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      if (collapse && proposedWidth <= WORKSPACE_EXPLORER_CLOSE_WIDTH) {
        onExplorerOpenChange(false)
        onExplorerPaneWidthChange(WORKSPACE_EXPLORER_DEFAULT_WIDTH)
      } else {
        updateWidth(proposedWidth)
      }
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId === pointerId) finishResize(true)
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId === pointerId) finishResize(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  const explorerLayout = workspaceExplorerLayout(workspaceWidth)
  const handlePreviewLayoutChange = (requestedLayout: { paneWidth: number; previewWidth: number }) => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width
    if (!workspaceWidth || workspaceExplorerLayout(workspaceWidth) !== 'side') {
      setOuterFilesPreviewWidth(clampProjectFilePreviewWidth(requestedLayout.previewWidth, filesLayout?.paneWidth ?? requestedLayout.paneWidth))
      return
    }
    const paneWidth = clampWorkspaceExplorerWidth(requestedLayout.paneWidth, workspaceWidth)
    const previewWidth = clampProjectFilePreviewWidth(requestedLayout.previewWidth, paneWidth)
    setFilesLayout({ paneWidth, previewWidth })
    setOuterFilesPreviewWidth(previewWidth)
    onExplorerPaneWidthChange(paneWidth)
  }

  return (
    <section
      ref={workspaceRef}
      className="detail-panel workspace-main-panel"
      data-explorer-open={explorerOpen}
      data-explorer-layout={explorerLayout}
      data-explorer-resizing={explorerPaneResizing ? 'true' : 'false'}
      style={explorerPaneWidth === null ? undefined : ({ '--workspace-explorer-width': `${explorerPaneWidth}px` } as CSSProperties)}
    >
      <div className="workspace-chat-column">
        <div className="workspace-chat-header">{chatHeader}</div>
        <div className="workspace-timeline">
          {projectId && timelineSessionId ? (
            <SessionTimeline
              key={`${timelineSessionId}:${searchAnchorTurnId ?? ''}:${timelineInstanceNonce ?? 0}`}
              projectId={projectId}
              projectName={projectName}
              projectPath={projectPath}
              sessionId={timelineSessionId}
              sessionTitle={selectedSession?.title}
              timeZone={settings.timeZone}
              historyEnabled={historyEnabled}
              transcriptSignal={transcriptSignal}
              timelineControlSignal={timelineControlSignal}
              showDebugSource={settings.showDebugNav}
              sharingEnabled={!!settings.publicBaseUrl}
              pendingTurn={selectedPendingTurn}
              provisionalSlash={provisionalSlash}
              pendingPhase={selectedPending?.phase}
              answeringQuestionId={answeringApprovalId ?? answeredQuestionId}
              onAnswerQuestion={answerQuestion}
              onLiveTurnChange={handleLiveTurnChange}
              onPendingTurnReconciled={(sessionId, submissionUuid) =>
                setPendingSubmission((current) => (current?.sessionId === sessionId && current.submissionUuid === submissionUuid ? null : current))
              }
              onLatestTurnPhaseChange={handleLatestTurnPhaseChange}
              onSessionListStale={refreshSessionListsForCurrentProject}
              onTurnOptionsChange={(meta) => setTurnOptions({ projectId, sessionId: timelineSessionId, meta })}
              onContextUsageChange={(value) => setContextUsage({ sessionId: timelineSessionId, value })}
              onPendingPermissionChange={handlePendingPermissionChange}
              onActivityChange={handleActivityChange}
              onTasksChange={handleTasksChange}
              searchAnchorTurnId={searchAnchorTurnId}
              searchTarget={searchTarget}
              onSearchTargetHandled={onSearchTargetHandled}
              onJumpToLatest={onJumpToLatest}
              onForkSession={historyEnabled ? (upToMessageId) => onForkSession(projectId, timelineSessionId, upToMessageId) : undefined}
              onNotify={onNotify}
            />
          ) : projectId ? (
            <div className="timeline-empty-state">{`What should we work on in ${projectName ?? 'this project'}?`}</div>
          ) : (
            <div className="timeline-home">
              {githubLogin ? (
                <div className="workspace-next-up">
                  <CliStaticSparkIcon />
                  <span>{`What's up next, ${githubLogin}?`}</span>
                </div>
              ) : null}
              <UsageOverview timeZone={settings.timeZone} />
            </div>
          )}
        </div>
        <div className="workspace-composer-region">
          <ComposerLottieButton />
          {selectedPendingApproval && selectedPendingApproval.toolName !== 'AskUserQuestion' ? (
            <PermissionApprovalCard
              key={selectedPendingApproval.requestId}
              approval={selectedPendingApproval}
              answering={answeringApprovalId === selectedPendingApproval.requestId}
              onAnswer={(approval, decision) => void answerApproval(approval, decision)}
            />
          ) : null}
          {selectedTasks ? <SessionTaskList key={timelineSessionId} tasks={selectedTasks} /> : null}
          <TurnComposer
            projectId={projectId}
            selectedSessionId={selectedSessionId}
            selectedSession={selectedSession}
            activity={selectedActivity}
            liveSessionId={timelineSessionId}
            liveUserMessageUuid={liveUserMessageUuid}
            latestTurnPhase={authoritativeTurnPhase(selectedPending?.phase ?? null, latestTurnPhase?.sessionId === timelineSessionId ? latestTurnPhase.phase : null)}
            pendingTurnId={composerPendingTurnId}
            setSelectedSessionId={setSelectedSessionId}
            setPendingTurn={setPendingSubmission}
            refreshSessionLists={refreshSessionListsForCurrentProject}
            onSessionCreated={onSessionCreated}
            settings={settings}
            sessionRuntime={sessionRuntime}
            projectDirectoryUnavailable={projectDirectoryUnavailable}
            turnOptions={selectedTurnOptions}
            externalPermissionMode={selectedTurnOptions?.permissionMode ?? null}
            contextUsage={selectedContextUsage}
            onBeforeSubmit={searchAnchorTurnId ? onJumpToLatest : undefined}
            onNotify={onNotify}
          />
        </div>
      </div>
      {explorerOpen ? (
        // biome-ignore lint/a11y/useSemanticElements: pointer-driven resize handle; <hr> cannot carry the drag affordance
        <div
          className="workspace-explorer-resize-handle"
          role="separator"
          aria-label="Resize explorer pane"
          aria-orientation="vertical"
          aria-valuemin={WORKSPACE_EXPLORER_MIN_WIDTH}
          aria-valuemax={workspaceRef.current ? workspaceExplorerWidthMax(workspaceRef.current.getBoundingClientRect().width) : undefined}
          aria-valuenow={explorerPaneWidth ?? undefined}
          onPointerDown={beginExplorerPaneResize}
        />
      ) : null}
      {explorerOpen ? (
        <ExplorerPanel
          projectId={projectId}
          projectName={projectName}
          currentCwd={currentCwd}
          openFiles={openFiles}
          onOpenFilesChange={setOpenFiles}
          previewWidth={outerFilesPreviewWidth}
          onPreviewLayoutChange={handlePreviewLayoutChange}
          onFilesLayoutChange={setFilesLayout}
          onClose={() => onExplorerOpenChange(false)}
        />
      ) : null}
    </section>
  )
}
