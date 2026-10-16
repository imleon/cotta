import { randomUUID } from 'node:crypto'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionDecisionRequest, ProjectSummary, SessionSummary, SessionTimelineResponse, ToolApprovalDecisionRequest, ToolApprovalRequest } from '@cotta/shared'
import { decodeLarkCardAction, type LarkCardAction } from './lark-card-action.js'
import { askUserQuestionList, type LarkTurnReply, projectLarkResultCard, projectLarkSessionCard, projectLarkTurnCard, projectLarkTurnMessages, type QuestionNav } from './lark-card-projection.js'
import type { LarkCardActionEvent, LarkCardActionResponse, LarkMenuEvent, LarkMessageEvent } from './lark-sdk-adapter.js'
import { SessionExternallyOwnedError, SessionTurnInProgressError } from './live-turn-manager.js'
import { projectGitContext } from './project-files-git.js'
import { ProjectReadModelError, readProjectSession, readProjectSessions, readProjectTimeline, TimelineAnchorStaleError } from './project-read-model.js'
import type { RemoteBot, RemoteBotStore } from './remote-bot-store.js'
import type { ProjectRoutesInput } from './routes/project-routes-shared.js'
import { TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { submitTurn } from './submit-turn.js'
import { readSettings } from './turn-options.js'

const SESSION_PAGE_SIZE = 5
const EVENT_RESULT_TTL_MS = 60 * 60 * 1000
const BACKGROUND_TASK_DISCOVERY_GRACE_MS = 1000
export const LIST_SESSIONS = 'LIST_SESSIONS'
const UNAUTHORIZED_MESSAGE = "This chat isn't authorized."
const INVALID_MESSAGE = 'Send a non-empty text message.'
const EXTERNALLY_OWNED_MESSAGE = 'This session is currently active outside Cotta. Wait for it to finish and try again.'
const TURN_IN_PROGRESS_MESSAGE = 'This session already has a Turn in progress. Wait for it to finish and try again.'

type LarkClient = {
  sendText(chatId: string, text: string, uuid?: string): Promise<string>
  sendCard(chatId: string, card: object, uuid?: string): Promise<string>
  createAndSendCard(chatId: string, card: object, uuid?: string): Promise<{ cardId: string; messageId: string }>
  updateCardEntity(cardId: string, card: object, uuid: string, sequence: number): Promise<void>
}

export type EventFailureReason =
  | 'bot_not_found'
  | 'card_expired_or_invalid'
  | 'configuration_changed'
  | 'group_not_supported'
  | 'invalid_action'
  | 'invalid_message'
  | 'project_not_found'
  | 'read_failed'
  | 'session_externally_owned'
  | 'session_not_found'
  | 'session_turn_in_progress'
  | 'turn_not_found'
  | 'unauthorized'
  | 'unknown_menu'

export type EventResult = ({ ok: true; messageId?: string } | { ok: false; reason: EventFailureReason; messageId?: string }) & { callback?: LarkCardActionResponse }

function actionToken(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const token = (value as Record<string, unknown>).token
  return typeof token === 'string' ? token : null
}

function isTurnStreamEvent(value: unknown, sessionId: string, turnId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  if (typeof event.session_id === 'string' && event.session_id !== sessionId) return false
  const bound = [event.user_message_uuid, ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])].filter((uuid): uuid is string => typeof uuid === 'string')
  if (bound.length > 0 && !bound.includes(turnId)) return false
  if (event.type === 'result' || event.type === 'cotta_live_turn_failed') return true
  if (event.type === 'system' && (event.subtype === 'task_notification' || event.subtype === 'background_tasks_changed')) return true
  if (event.parent_agent_id != null || event.isSidechain === true) return false
  if (event.type === 'user') return event.uuid === turnId || contentBlocksContainToolResult(event)
  return (event.type === 'assistant' || event.type === 'stream_event') && event.parent_tool_use_id === null
}

function contentBlocksContainToolResult(event: Record<string, unknown>): boolean {
  const message = event.message
  if (!message || typeof message !== 'object') return false
  const content = (message as Record<string, unknown>).content
  return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result')
}

function permissionDecision(action: LarkCardAction): ToolApprovalDecisionRequest {
  if (action.operation === 'allow') return { decision: 'allow' }
  if (action.operation === 'allow_suggestion') return { decision: 'allow_suggestion' }
  return { decision: 'deny', message: 'Denied by user' }
}

function questionAnswer(pending: ToolApprovalRequest, questionIndex: number, optionIndex: number): { key: string; label: string } | null {
  const questions = Array.isArray(pending.input.questions) ? pending.input.questions : []
  const question = questions[questionIndex] as Record<string, unknown> | undefined
  const options = question && Array.isArray(question.options) ? question.options : []
  const option = options[optionIndex] as Record<string, unknown> | undefined
  const key = question && typeof question.question === 'string' ? question.question : ''
  const label = option && typeof option.label === 'string' ? option.label : ''
  return key && label ? { key, label } : null
}

function questionIsMultiSelect(pending: ToolApprovalRequest, questionIndex: number): boolean {
  const questions = Array.isArray(pending.input.questions) ? pending.input.questions : []
  const question = questions[questionIndex] as Record<string, unknown> | undefined
  return question?.multiSelect === true
}

export class LarkRemoteService {
  private readonly inFlight = new Map<string, Promise<EventResult>>()
  private readonly recentResults = new Map<string, { result: EventResult; expiresAtMs: number }>()
  private readonly questionCards = new Map<string, { requestId: string; nav: QuestionNav; rerender: () => void }>()
  private submitTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly botId: string,
    private readonly store: RemoteBotStore,
    private readonly client: LarkClient,
    private readonly readInput: ProjectRoutesInput,
    private readonly now: () => number = Date.now,
  ) {}

  onMessage(event: LarkMessageEvent): Promise<EventResult> {
    return this.once(event.eventId, async (bot) => {
      if (event.chatType !== 'p2p') {
        await this.client.sendText(event.chatId, "Group chats aren't supported yet. Message the bot in a direct chat.", event.eventId)
        return { ok: false, reason: 'group_not_supported' }
      }
      const text = event.messageType === 'text' ? this.textContent(event.content) : null
      if (!this.authorized(bot, event.senderOpenId, event.chatId)) {
        await this.client.sendText(event.chatId, UNAUTHORIZED_MESSAGE, event.eventId)
        return { ok: false, reason: 'unauthorized' }
      }
      if (!text) {
        await this.client.sendText(event.chatId, INVALID_MESSAGE, event.eventId)
        return { ok: false, reason: 'invalid_message' }
      }
      if (!bot.selectedProjectId) return this.sendSessionList(bot, event.chatId, event.eventId)
      return this.serializeSubmit(async () => {
        const current = this.store.getBot(this.botId)
        if (!current?.selectedProjectId) return { ok: false, reason: 'project_not_found' }
        const project = await this.readInput.claudeCodeApi.getProject(current.selectedProjectId)
        if (!project || !this.validProject(current, project.id)) {
          this.store.setSelection(current.botId, null, null, this.now())
          return { ok: false, reason: 'project_not_found' }
        }
        return this.submitMessage(current, project, text, event)
      })
    })
  }

  onMenu(event: LarkMenuEvent): Promise<EventResult> {
    return this.once(event.eventId, async (bot) => {
      if (event.eventKey !== LIST_SESSIONS) return { ok: false, reason: 'unknown_menu' }
      if (!this.authorized(bot, event.operatorOpenId)) return { ok: false, reason: 'unauthorized' }
      return this.sendSessionList(bot, bot.pairedChatId as string, event.eventId)
    })
  }

  onCardAction(event: LarkCardActionEvent): Promise<EventResult> {
    return this.once(event.eventId, async (bot) => {
      if (!this.authorized(bot, event.operatorOpenId, event.chatId)) return { ok: false, reason: 'unauthorized' }
      let token: string | null
      if (event.action.tag === 'select_static') token = typeof event.action.option === 'string' ? event.action.option : null
      else if (event.action.tag === 'button' || event.action.tag === 'interactive_container') token = actionToken(event.action.value)
      else return { ok: false, reason: 'invalid_action' }
      const action = token ? decodeLarkCardAction(token, bot.appSecret, this.now()) : null
      if (!action) return { ok: false, reason: 'card_expired_or_invalid' }
      if (!this.validBinding(bot, action)) return { ok: false, reason: 'configuration_changed' }
      const project = await this.readInput.claudeCodeApi.getProject(action.projectId)
      if (!project) return { ok: false, reason: 'project_not_found' }
      try {
        if (action.card === 'sessions') return await this.handleSessions(bot, project, event, action)
        if (action.card === 'permission') return await this.handlePermission(action)
        return await this.handleTurn(bot, project, action)
      } catch (error) {
        if (error instanceof TimelineAnchorStaleError) return { ok: false, reason: 'turn_not_found' }
        if (error instanceof TranscriptUnavailableError) return { ok: false, reason: 'read_failed' }
        if (error instanceof ProjectReadModelError) {
          if (error.code === 'project_not_found') return { ok: false, reason: 'project_not_found' }
          if (error.code === 'session_not_found') return { ok: false, reason: 'session_not_found' }
          return { ok: false, reason: 'read_failed' }
        }
        throw error
      }
    })
  }

  private async sendSessionList(bot: RemoteBot, chatId: string, eventId?: string): Promise<EventResult> {
    const selectedProject = bot.selectedProjectId ? await this.readInput.claudeCodeApi.getProject(bot.selectedProjectId) : null
    const current = selectedProject && this.validProject(bot, selectedProject.id) ? selectedProject : undefined
    if (bot.selectedProjectId && !current) this.store.setSelection(bot.botId, null, null, this.now())
    const projects = await this.projects(bot, current)
    const project = current ?? projects[0]
    if (!project) return { ok: false, reason: 'project_not_found' }
    const [response, git] = await Promise.all([
      readProjectSessions(this.readInput, { projectId: project.id, limit: SESSION_PAGE_SIZE, cursor: null }),
      project.path ? projectGitContext(project.path) : null,
    ])
    const branch = git?.branch ?? null
    const settings = readSettings(this.readInput.settingsStore)
    const selectedSession = current ? this.selectedSessionState(bot, project.id).session : undefined
    const projected = projectLarkSessionCard(response, projects, this.identity(bot, project.id), branch, settings.showDebugNav !== false, selectedSession, settings.timeZone)
    const messageId = await this.client.sendCard(chatId, projected.card, eventId)
    return { ok: true, messageId }
  }

  private async handleSessions(bot: RemoteBot, project: ProjectSummary, event: LarkCardActionEvent, action: LarkCardAction): Promise<EventResult> {
    if (action.operation === 'open' && action.sessionId && action.loadedCount !== undefined) {
      const initialSession = readProjectSession(this.readInput, action.projectId, action.sessionId)
      if (!initialSession) return { ok: false, reason: 'session_not_found' }
      const [response, projects, git] = await Promise.all([this.timeline(action.projectId, initialSession.id), this.projects(bot, project), project.path ? projectGitContext(project.path) : null])
      const session = readProjectSession(this.readInput, action.projectId, action.sessionId)
      if (!session) return { ok: false, reason: 'session_not_found' }
      const sessions = await readProjectSessions(this.readInput, { projectId: action.projectId, limit: action.loadedCount || SESSION_PAGE_SIZE, cursor: null })
      const settings = readSettings(this.readInput.settingsStore)
      const card = projectLarkSessionCard(
        sessions,
        projects,
        this.identity(bot, action.projectId, action.createdAtMs),
        git?.branch ?? null,
        settings.showDebugNav !== false,
        session,
        settings.timeZone,
      ).card
      this.store.setSelection(bot.botId, action.projectId, action.sessionId, this.now())
      const messageId = await this.client.sendCard(
        event.chatId,
        projectLarkTurnCard(
          session,
          project.name,
          response,
          this.identity(bot, action.projectId),
          settings.timeZone,
          this.navigation(session.id, response.turns.at(-1)?.primaryUserUuid),
          settings.showDebugNav !== false,
        ).card,
        event.eventId,
      )
      return { ok: true, messageId, callback: { card: { type: 'raw', data: card } } }
    }
    const creating = action.operation === 'new'
    if (!creating && action.operation !== 'refresh' && action.operation !== 'more' && action.operation !== 'select_project') return { ok: false, reason: 'invalid_action' }
    if (creating) this.store.setSelection(bot.botId, action.projectId, null, this.now())
    const loaded = action.loadedCount ?? SESSION_PAGE_SIZE
    const limit = action.operation === 'more' ? loaded + SESSION_PAGE_SIZE : action.operation === 'select_project' || loaded === 0 ? SESSION_PAGE_SIZE : loaded
    const selectedSession = creating ? undefined : this.selectedSessionState(bot, action.projectId).session
    const [response, projects, git] = await Promise.all([
      readProjectSessions(this.readInput, { projectId: action.projectId, limit, cursor: null }),
      this.projects(bot, project),
      project.path ? projectGitContext(project.path) : null,
    ])
    const settings = readSettings(this.readInput.settingsStore)
    const card = projectLarkSessionCard(
      response,
      projects,
      this.identity(bot, action.projectId, action.createdAtMs),
      git?.branch ?? null,
      settings.showDebugNav !== false,
      selectedSession,
      settings.timeZone,
    ).card
    return {
      ok: true,
      callback: {
        card: { type: 'raw', data: card },
        ...(creating ? { toast: { type: 'success' as const, content: 'New session ready. Send a message to start.' } } : {}),
      },
    }
  }

  private async handleTurn(bot: RemoteBot, project: ProjectSummary, action: LarkCardAction): Promise<EventResult> {
    if (action.operation === 'refresh_result' && action.sessionId && action.turnId) {
      const session = readProjectSession(this.readInput, action.projectId, action.sessionId)
      if (!session) return { ok: false, reason: 'session_not_found' }
      const response = await this.timeline(action.projectId, action.sessionId, action.turnId)
      const turn = response.turns.at(-1)
      if (!turn || turn.primaryUserUuid !== action.turnId) return { ok: false, reason: 'turn_not_found' }
      const replies = projectLarkTurnMessages(turn.messages as SessionMessage[], turn.primaryUserUuid).replies
      return {
        ok: true,
        callback: {
          card: {
            type: 'raw',
            data: projectLarkResultCard(session.title, project.name, session.id, turn.primaryUserUuid, replies, this.identity(bot, project.id, action.createdAtMs), false, {
              session,
              response,
              timeZone: readSettings(this.readInput.settingsStore).timeZone,
              showDebugNav: readSettings(this.readInput.settingsStore).showDebugNav !== false,
            }),
          },
        },
      }
    }
    if (!['refresh', 'first_turn', 'previous_turn', 'next_turn', 'latest_turn'].includes(action.operation) || !action.sessionId || (action.operation !== 'refresh' && !action.turnId))
      return { ok: false, reason: 'invalid_action' }
    const session = readProjectSession(this.readInput, action.projectId, action.sessionId)
    if (!session) return { ok: false, reason: 'session_not_found' }
    let targetTurnId = action.turnId ?? null
    if (action.operation !== 'refresh') {
      if (!this.readInput.transcriptSyncer) throw new Error('transcript syncer unavailable')
      await this.readInput.transcriptSyncer(action.projectId, session.id)
      const navigation = this.navigation(session.id, action.turnId)
      if (!navigation) return { ok: false, reason: 'turn_not_found' }
      if (action.operation === 'first_turn') targetTurnId = navigation.firstTurnId
      else if (action.operation === 'previous_turn') targetTurnId = navigation.previousTurnId
      else if (action.operation === 'next_turn') targetTurnId = navigation.nextTurnId
      else targetTurnId = navigation.latestTurnId
      if (!targetTurnId || targetTurnId === action.turnId)
        return {
          ok: true,
          callback: { toast: { type: 'info', content: action.operation === 'first_turn' || action.operation === 'previous_turn' ? 'This is the first Turn.' : 'This is the latest Turn.' } },
        }
    }
    const response = await this.timeline(action.projectId, session.id, targetTurnId)
    const turnId = response.turns.at(-1)?.primaryUserUuid
    if (targetTurnId && turnId !== targetTurnId) return { ok: false, reason: 'turn_not_found' }
    const settings = readSettings(this.readInput.settingsStore)
    const card = projectLarkTurnCard(
      session,
      project.name,
      response,
      this.identity(bot, action.projectId, action.createdAtMs),
      settings.timeZone,
      this.navigation(session.id, turnId),
      settings.showDebugNav !== false,
    ).card
    return { ok: true, callback: { card: { type: 'raw', data: card } } }
  }

  private async handlePermission(action: LarkCardAction): Promise<EventResult> {
    if (!action.sessionId || !action.requestId || !action.toolUseID) return { ok: false, reason: 'invalid_action' }
    const session = readProjectSession(this.readInput, action.projectId, action.sessionId)
    if (!session) return { ok: false, reason: 'session_not_found' }
    const runState = this.readInput.liveTurnManager.sessionRunState(action.sessionId)
    const pending = runState?.phase === 'requires_action' ? runState.pendingPermission : undefined
    const stale = { ok: true as const, callback: { toast: { type: 'info' as const, content: 'This request was already handled or has expired.' } } }
    if (!pending || pending.requestId !== action.requestId || pending.toolUseID !== action.toolUseID) return stale
    const isQuestion = pending.toolName === 'AskUserQuestion' && askUserQuestionList(pending) !== null
    if (isQuestion && action.operation === 'answer') return this.toggleAnswer(action, pending)
    const decision =
      pending.toolName === 'AskUserQuestion'
        ? action.operation === 'submit_answers'
          ? this.submitQuestionAnswers(action, pending)
          : { behavior: 'cancelled' as const, toolUseID: pending.toolUseID }
        : undefined
    const answered =
      pending.toolName === 'AskUserQuestion'
        ? decision && this.readInput.liveTurnManager.respondToQuestion?.(action.sessionId, action.requestId, decision)
        : this.readInput.liveTurnManager.respondToPermission?.(action.sessionId, action.requestId, permissionDecision(action))
    if (!answered || answered.status !== 'answered') return answered?.status === 'invalid_update' ? { ok: false, reason: 'invalid_action' } : stale
    return { ok: true, callback: { toast: { type: 'success', content: 'Response submitted.' } } }
  }

  private toggleAnswer(action: LarkCardAction, pending: ToolApprovalRequest): EventResult {
    const stale = { ok: true as const, callback: { toast: { type: 'info' as const, content: 'This request was already handled or has expired.' } } }
    const entry = this.questionCards.get(`${action.sessionId}:${action.turnId}`)
    if (!entry || entry.requestId !== pending.requestId) return stale
    const answer = action.optionIndex !== undefined ? questionAnswer(pending, action.questionIndex ?? 0, action.optionIndex) : null
    if (!answer) return { ok: false, reason: 'invalid_action' }
    const current = entry.nav.answers.get(answer.key) ?? []
    if (questionIsMultiSelect(pending, action.questionIndex ?? 0)) {
      const next = current.includes(answer.label) ? current.filter((label) => label !== answer.label) : [...current, answer.label]
      if (next.length > 0) entry.nav.answers.set(answer.key, next)
      else entry.nav.answers.delete(answer.key)
    } else {
      entry.nav.answers.set(answer.key, [answer.label])
    }
    entry.rerender()
    return { ok: true, callback: { toast: { type: 'success', content: 'Saved.' } } }
  }

  private submitQuestionAnswers(action: LarkCardAction, pending: ToolApprovalRequest): AskUserQuestionDecisionRequest {
    const entry = this.questionCards.get(`${action.sessionId}:${action.turnId}`)
    const selections = entry && entry.requestId === pending.requestId ? entry.nav.answers : new Map<string, string[]>()
    const answers = Object.fromEntries(Array.from(selections, ([key, labels]) => [key, labels.join(', ')]))
    return { behavior: 'completed', toolUseID: pending.toolUseID, answers }
  }

  private async submitMessage(bot: RemoteBot, project: ProjectSummary, text: string, event: LarkMessageEvent): Promise<EventResult> {
    const sessionId = bot.selectedSessionId ?? randomUUID()
    const resume = bot.selectedSessionId !== null
    const selected = resume ? this.selectedSessionState(bot, project.id) : { session: undefined, active: null }
    if (selected.active) {
      const message = selected.active === 'running' ? TURN_IN_PROGRESS_MESSAGE : 'This session is waiting for input in Cotta Web. Complete the Permission or AskUserQuestion there, then try again.'
      const messageId = await this.client.sendText(event.chatId, message, event.eventId)
      return { ok: false, reason: 'session_turn_in_progress', messageId }
    }
    const session = selected.session ?? null
    if (resume && !session) return { ok: false, reason: 'session_not_found' }
    const turnId = randomUUID()
    const title = session?.title ?? text
    const messages: SessionMessage[] = []
    let replies: LarkTurnReply[] = []
    let renderedReplies: LarkTurnReply[] = []
    let renderedPending: ToolApprovalRequest | undefined
    let questionNav: QuestionNav | null = null
    let sequence = 1
    let tail = Promise.resolve()
    let stopped = false
    let deltaTimer: ReturnType<typeof setTimeout> | null = null
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null
    const identity = this.identity(bot, project.id)
    const initial = projectLarkResultCard(title, project.name, sessionId, turnId, replies, identity, true)
    const { cardId, messageId } = await this.client.createAndSendCard(event.chatId, initial, event.eventId)
    const mutate = (operation: (sequence: number) => Promise<void>) => {
      const nextSequence = sequence++
      tail = tail.then(() => operation(nextSequence)).catch((error) => console.error('Lark result card stream failed', error))
    }
    const updateCard = (next: LarkTurnReply[]) => {
      const projected = projectLarkResultCard(title, project.name, sessionId, turnId, next, identity, true, undefined, renderedPending, questionNav ?? undefined)
      const uuidPrefix = event.eventId ?? turnId
      mutate((currentSequence) => this.client.updateCardEntity(cardId, projected, `${uuidPrefix}:${currentSequence}`, currentSequence))
    }
    const cardKey = `${sessionId}:${turnId}`
    const rerender = () => {
      flushDelta()
      updateCard(renderedReplies)
    }
    const reconcilePending = () => {
      const runState = this.readInput.liveTurnManager.sessionRunState(sessionId)
      const pending = runState?.phase === 'requires_action' && runState.activeUserMessageUuid === turnId ? runState.pendingPermission : undefined
      if (pending?.requestId === renderedPending?.requestId) return
      renderedPending = pending
      const list = pending?.toolName === 'AskUserQuestion' ? askUserQuestionList(pending) : null
      if (pending && list) {
        questionNav = { answers: new Map<string, string[]>() }
        this.questionCards.set(cardKey, { requestId: pending.requestId, nav: questionNav, rerender })
      } else {
        questionNav = null
        this.questionCards.delete(cardKey)
      }
      flushDelta()
      updateCard(renderedReplies)
    }
    const reconcile = (next: LarkTurnReply[], stream = false) => {
      renderedReplies = next
      if (stream) {
        if (!deltaTimer)
          deltaTimer = setTimeout(() => {
            deltaTimer = null
            updateCard(renderedReplies)
          }, 500)
        return
      }
      if (deltaTimer) clearTimeout(deltaTimer)
      deltaTimer = null
      updateCard(next)
    }
    const flushDelta = () => {
      if (!deltaTimer) return
      clearTimeout(deltaTimer)
      deltaTimer = null
      updateCard(renderedReplies)
    }
    let mainSettled = false
    let failureReplies: LarkTurnReply[] | null = null
    const settle = () => {
      const uuidPrefix = event.eventId ?? turnId
      mutate(async (currentSequence) => {
        let response: SessionTimelineResponse | undefined
        let finalReplies = failureReplies ?? renderedReplies
        try {
          response = await this.timeline(project.id, sessionId, turnId)
          const turn = response.turns.at(-1)
          if (turn?.primaryUserUuid !== turnId) response = undefined
          else if (!failureReplies) finalReplies = projectLarkTurnMessages(turn.messages as SessionMessage[], turnId).replies
        } catch (error) {
          console.error('Lark result timeline settle failed', error)
        }
        const finalSession = readProjectSession(this.readInput, project.id, sessionId) ??
          session ?? { id: sessionId, title, projectId: project.id, lastActivityAt: this.now(), occupiedBy: 'cotta', occupiedStatus: 'idle', kind: null }
        const settings = readSettings(this.readInput.settingsStore)
        await this.client.updateCardEntity(
          cardId,
          projectLarkResultCard(
            title,
            project.name,
            sessionId,
            turnId,
            finalReplies,
            identity,
            false,
            response ? { session: finalSession, response, timeZone: settings.timeZone, showDebugNav: settings.showDebugNav !== false } : undefined,
          ),
          `${uuidPrefix}:${currentSequence}`,
          currentSequence,
        )
      })
    }
    let unsubscribe = () => {}
    const stop = () => {
      if (stopped) return
      stopped = true
      this.questionCards.delete(cardKey)
      if (discoveryTimer) clearTimeout(discoveryTimer)
      discoveryTimer = null
      unsubscribe()
    }
    const discoverBackgroundTasks = () => {
      if ((this.readInput.liveTurnManager.liveBackgroundTasks?.(sessionId)?.length ?? 0) > 0) return
      discoveryTimer = setTimeout(() => {
        discoveryTimer = null
        stop()
      }, BACKGROUND_TASK_DISCOVERY_GRACE_MS)
      discoveryTimer.unref?.()
    }
    unsubscribe = this.readInput.liveTurnManager.subscribe(sessionId, (message) => {
      const runState = this.readInput.liveTurnManager.sessionRunState(sessionId)
      if (stopped) return
      if (message.type === 'cotta_run_state_changed') {
        if (!mainSettled) reconcilePending()
        return
      }
      if ((!mainSettled && runState?.activeUserMessageUuid !== turnId && runState?.lastTurn?.id !== turnId) || !isTurnStreamEvent(message, sessionId, turnId)) return
      if (mainSettled) {
        if (message.type !== 'system') return
        settle()
        if (message.subtype !== 'background_tasks_changed') return
        if ((this.readInput.liveTurnManager.liveBackgroundTasks?.(sessionId)?.length ?? 0) === 0) stop()
        else if (discoveryTimer) {
          clearTimeout(discoveryTimer)
          discoveryTimer = null
        }
        return
      }
      if (message.type === 'stream_event') {
        const eventValue = message.event as unknown as { type?: string; delta?: { type?: string; text?: string } }
        const delta = eventValue.type === 'content_block_delta' && eventValue.delta?.type === 'text_delta' ? eventValue.delta.text : undefined
        if (!delta) return
        const last = renderedReplies.at(-1)
        reconcile(last?.kind === 'markdown' ? [...renderedReplies.slice(0, -1), { kind: 'markdown', content: last.content + delta }] : [...renderedReplies, { kind: 'markdown', content: delta }], true)
        return
      }
      if (message.type === 'system') return
      if (message.type === 'assistant' || message.type === 'user') messages.push(message as SessionMessage)
      const next = projectLarkTurnMessages(messages, turnId, message.type === 'assistant').replies
      if (message.type === 'assistant' || message.type === 'user') {
        replies = next
        reconcile(next)
        return
      }
      flushDelta()
      replies = renderedReplies
      mainSettled = true
      if (message.type === 'cotta_live_turn_failed') failureReplies = [{ kind: 'markdown', content: `**Failed**\n\n${message.error}` }]
      else if (message.type === 'result' && message.subtype !== 'success') {
        const detail = 'errors' in message && Array.isArray(message.errors) && message.errors.length > 0 ? message.errors.join('\n') : 'Turn failed.'
        failureReplies = [{ kind: 'markdown', content: `**Failed**\n\n${detail}` }]
      }
      settle()
      discoverBackgroundTasks()
    })
    try {
      const result = await submitTurn(this.readInput, { projectId: project.id, sessionId, resume, text, userMessageUuid: turnId })
      this.store.setSelection(bot.botId, result.projectId, result.sessionId, this.now())
      return { ok: true, messageId }
    } catch (error) {
      stop()
      if (deltaTimer) clearTimeout(deltaTimer)
      await tail.catch((streamError) => console.error('Lark result card stream failed', streamError))
      const stable = error instanceof SessionExternallyOwnedError || error instanceof SessionTurnInProgressError
      const detail =
        error instanceof SessionExternallyOwnedError
          ? EXTERNALLY_OWNED_MESSAGE
          : error instanceof SessionTurnInProgressError
            ? TURN_IN_PROGRESS_MESSAGE
            : error instanceof Error
              ? error.message
              : String(error)
      const errorReply = [{ kind: 'markdown' as const, content: `**Failed**\n\n${detail}` }]
      const currentSequence = sequence++
      try {
        await this.client.updateCardEntity(
          cardId,
          projectLarkResultCard(title, project.name, sessionId, turnId, errorReply, identity, false),
          `${event.eventId ?? turnId}:${currentSequence}`,
          currentSequence,
        )
      } catch (notificationError) {
        console.error('Lark result card failure update failed', notificationError)
        if (stable) await this.client.sendText(event.chatId, detail, `${event.eventId ?? turnId}:failure-text`).catch((textError) => console.error('Lark failure text send failed', textError))
      }
      if (error instanceof SessionExternallyOwnedError) return { ok: false, reason: 'session_externally_owned', messageId }
      if (error instanceof SessionTurnInProgressError) return { ok: false, reason: 'session_turn_in_progress', messageId }
      throw error
    }
  }

  private serializeSubmit(run: () => Promise<EventResult>): Promise<EventResult> {
    const result = this.submitTail.then(run, run)
    this.submitTail = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private validProject(bot: RemoteBot, projectId: string): boolean {
    return bot.allProjects || bot.projectIds.includes(projectId)
  }

  private selectedSessionState(bot: RemoteBot, projectId: string): { session?: SessionSummary; active: 'running' | 'waiting' | null } {
    if (bot.selectedProjectId !== projectId || !bot.selectedSessionId) return { active: null }
    const session = readProjectSession(this.readInput, projectId, bot.selectedSessionId) ?? undefined
    const phase = this.readInput.liveTurnManager.sessionRunState(bot.selectedSessionId)?.phase
    const active = phase === 'running' ? 'running' : phase === 'requires_action' ? 'waiting' : null
    if (!session && !active) this.store.setSelection(bot.botId, null, null, this.now())
    return { session, active }
  }

  private navigation(sessionId: string, turnId: string | undefined) {
    if (!turnId) return undefined
    if (!this.readInput.rawTranscriptCache) throw new Error('raw transcript cache unavailable')
    return this.readInput.rawTranscriptCache.adjacentTurnIds(sessionId, turnId, { excludeLocalCommandTurns: true }) ?? undefined
  }

  private async timeline(projectId: string, sessionId: string, turnId: string | null = null): Promise<SessionTimelineResponse> {
    return (await readProjectTimeline(this.readInput, {
      projectId,
      sessionId,
      limitTurns: 1,
      cursor: null,
      fromTurnId: null,
      anchorTurnId: turnId,
      pendingSubmissionUuid: null,
      waitContext: false,
      acknowledgeCompletedTurn: false,
      excludeLocalCommandTurns: true,
    })) as SessionTimelineResponse
  }

  private identity(bot: RemoteBot, projectId: string, createdAtMs = this.now()) {
    const origin = readSettings(this.readInput.settingsStore).publicBaseUrl
    const detail = origin && this.readInput.detailTokenKey ? { origin, key: this.readInput.detailTokenKey } : undefined
    return { botId: bot.botId, configVersion: bot.configVersion, projectId, createdAtMs, renderedAtMs: this.now(), secret: bot.appSecret, ...(detail ? { detail } : {}) }
  }

  private async projects(bot: RemoteBot, current?: ProjectSummary): Promise<ProjectSummary[]> {
    const recent = (await this.readInput.claudeCodeApi.listProjects({ limit: bot.allProjects ? 10 : 10_000 })).projects.filter((project) => bot.allProjects || bot.projectIds.includes(project.id))
    return current && !recent.some((project) => project.id === current.id) ? [current, ...recent.slice(0, 9)] : recent.slice(0, 10)
  }

  private authorized(bot: RemoteBot, openId: string, chatId?: string): boolean {
    return bot.enabled && bot.pairedOpenId === openId && (chatId === undefined || bot.pairedChatId === chatId)
  }

  private validBinding(bot: RemoteBot, action: LarkCardAction): boolean {
    return action.botId === bot.botId && action.configVersion === bot.configVersion && (bot.allProjects || bot.projectIds.includes(action.projectId))
  }

  private textContent(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as { text?: unknown }
      return typeof parsed.text === 'string' ? parsed.text.trim() : null
    } catch {
      return null
    }
  }

  private once(eventId: string | undefined, run: (bot: RemoteBot) => Promise<EventResult>): Promise<EventResult> {
    const bot = this.store.getBot(this.botId)
    if (!bot) return Promise.resolve({ ok: false, reason: 'bot_not_found' })
    if (!eventId) return run(bot)
    const id = `${bot.platform}:${bot.appId}:${eventId}`
    const now = this.now()
    for (const [key, cached] of this.recentResults) if (cached.expiresAtMs <= now) this.recentResults.delete(key)
    const recent = this.recentResults.get(id)
    if (recent) return Promise.resolve(recent.result)
    const existing = this.inFlight.get(id)
    if (existing) return existing
    const promise = run(bot)
      .then((result) => {
        this.recentResults.set(id, { result, expiresAtMs: this.now() + EVENT_RESULT_TTL_MS })
        return result
      })
      .finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, promise)
    return promise
  }
}
