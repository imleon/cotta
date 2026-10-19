import { type AskUserQuestionDecisionRequest, contentLineCount, type TimelineBlock, type ToolApprovalRequest } from '@cotta/shared'
import { Fragment, type ReactNode } from 'react'
import {
  type ContentImage,
  contentBlockIsRenderable,
  DeferredDetails,
  decodeContentImage,
  fileLanguage,
  relativeFilePath,
  safeDataPreview,
  TimelineCodeContent,
  TimelineContentStack,
  TimelineKvContent,
  TimelineQuestionAnswersContent,
  TimelineQuestionFormContent,
  TimelineTextContent,
  ToolInputValue,
  ToolMarkdownContent,
  ToolResultValue,
  toolInputSummary,
  toolResultMarkdownText,
  toolTimelineClass,
} from './content'
import { isRecord, shortText, type TimelineSource, textFromData, toolDataField, toolDataString, toolResultIsError, toolResultValue } from './core'

function bashDetail(value: unknown): string | null {
  if (!isRecord(value)) return null
  const command = typeof value.command === 'string' && value.command.trim() ? value.command : null
  const description = typeof value.description === 'string' && value.description.trim() ? value.description : null
  const metadata = [
    value.run_in_background === true ? 'Background' : null,
    value.dangerouslyDisableSandbox === true ? 'Outside sandbox' : null,
    description ?? (command ? shortText(command, 120) : null),
  ].filter((item): item is string => item !== null)
  return metadata.length > 0 ? metadata.join(' · ') : null
}

function bashResultText(value: unknown): string {
  return toolResultMarkdownText(value) ?? (typeof value === 'string' ? value : safeDataPreview(value))
}

export function toolCallLabels(hasError: boolean, pendingPermission?: boolean): ReactNode {
  return (
    <>
      {hasError ? <span className="timeline-tool-error-label">ERROR</span> : null}
      {pendingPermission ? <span className="timeline-tool-permission-label">PermissionRequired</span> : null}
    </>
  )
}

function ToolCallDetails({
  toolName,
  title,
  detail,
  hasError = false,
  pendingPermission,
  defaultOpen,
  children,
}: {
  toolName: string
  title: string
  detail?: string | null
  hasError?: boolean
  pendingPermission?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={`Tool call ${toolName}`}
      defaultOpen={defaultOpen ?? pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{toolName}</strong>
              {detail ? <span className="timeline-file-result-summary-detail"> {detail}</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => children}
    />
  )
}

export function TimelineBashCommandContent({ command }: { command: string }) {
  return (
    <div className="timeline-tool-bash-command" data-timeline-content="bash_command">
      <TimelineCodeContent value={`$ ${command.replaceAll('\n', '\n  ')}`} language="bash" copyValue={command} defaultWrapped={false} />
    </div>
  )
}

function resultText(result: TimelineBlock): string {
  return bashResultText(toolResultValue(result))
}

function toolUseResult(result: TimelineBlock | undefined): unknown {
  return result && isRecord(result.data) ? result.data.toolUseResult : undefined
}

function hasToolUseResult(result: TimelineBlock): boolean {
  return isRecord(result.data) && result.data.toolUseResult !== undefined
}

function agentDetail(input: unknown, output: unknown): string | null {
  if (!isRecord(input)) return null
  const detail = [
    typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : null,
    isRecord(output) && output.isAsync === true ? 'Background' : null,
    typeof input.description === 'string' && input.description ? input.description : null,
  ].filter((value): value is string => value !== null)
  return detail.length > 0 ? detail.join(' · ') : null
}

function agentTitle(input: unknown, output: unknown): string {
  const detail = agentDetail(input, output)
  return detail ? `Agent (${detail})` : 'Agent'
}

function agentTextBlocks(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return ''
  return value.content.flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

function agentSyncResultText(result: TimelineBlock): string {
  return agentTextBlocks(toolUseResult(result)) || resultText(result)
}

function agentResultIsAsync(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.isAsync === true
}

export function AgentToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const prompt = isRecord(input) && typeof input.prompt === 'string' ? input.prompt : ''
  const error = results.find(toolResultIsError)
  if (error) {
    return (
      <TimelineContentStack>
        <TimelineTextContent value={prompt} />
        <TimelineTextContent value={resultText(error)} tone="error" />
      </TimelineContentStack>
    )
  }
  if (results.length === 0)
    return (
      <TimelineContentStack>
        <TimelineTextContent value={prompt} />
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      </TimelineContentStack>
    )
  const output = toolUseResult(results[0])
  return (
    <TimelineContentStack>
      {agentResultIsAsync(output) ? (
        <TimelineKvContent value={output} />
      ) : (
        <>
          <TimelineTextContent value={prompt} />
          <ToolMarkdownContent value={agentSyncResultText(results[0])} />
        </>
      )}
    </TimelineContentStack>
  )
}

function AgentToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const detail = agentDetail(input, toolUseResult(results.find(toolResultIsError) ?? results[0]))
  const title = agentTitle(input, toolUseResult(results.find(toolResultIsError) ?? results[0]))
  const hasError = results.some(toolResultIsError)
  return (
    <ToolCallDetails toolName="Agent" title={title} detail={detail ? `(${detail})` : null} hasError={hasError} pendingPermission={pendingPermission}>
      <AgentToolContent input={input} results={results} />
    </ToolCallDetails>
  )
}

function skillName(input: unknown): string {
  return isRecord(input) && typeof input.skill === 'string' && input.skill ? input.skill : 'unknown'
}

function skillMetaText(block: TimelineBlock): string {
  return isRecord(block.data) && typeof block.data.text === 'string' ? block.data.text : (textFromData(block.data) ?? safeDataPreview(block.data))
}

function skillResultValue(result: TimelineBlock): unknown {
  return isRecord(result.data) && 'toolUseResult' in result.data ? result.data.toolUseResult : toolResultValue(result)
}

function skillInputKv(input: unknown, result: TimelineBlock | undefined): Record<string, unknown> {
  const value: Record<string, unknown> = isRecord(input) && !Array.isArray(input) ? { ...input } : { skill: skillName(input) }
  const output = result ? skillResultValue(result) : null
  if (isRecord(output) && !Array.isArray(output)) Object.assign(value, output)
  else if (output !== null) value.result = output
  return value
}

export function SkillToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const error = results.find(toolResultIsError)
  if (error)
    return (
      <>
        <TimelineKvContent value={skillInputKv(input, undefined)} />
        <TimelineTextContent value={resultText(error)} tone="error" />
      </>
    )
  const result = results.find((item) => item.kind === 'tool.result')
  const messages = results.filter((item) => item.kind === 'skill.meta')
  return (
    <>
      <TimelineKvContent value={skillInputKv(input, result)} />
      {!result ? <TimelineTextContent value="Waiting for skill result…" tone="muted" italic /> : null}
      {messages.map((message) => (
        <ToolMarkdownContent value={skillMetaText(message)} key={message.id} />
      ))}
    </>
  )
}

function SkillToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const name = skillName(input)
  const hasError = results.some(toolResultIsError)
  const title = `Skill (${name})`
  return (
    <ToolCallDetails toolName="Skill" title={title} detail={`(${name})`} hasError={hasError} pendingPermission={pendingPermission}>
      <TimelineContentStack>
        <SkillToolContent input={input} results={results} />
      </TimelineContentStack>
    </ToolCallDetails>
  )
}

export function BashToolContent({ command, results }: { command: string | null; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  return (
    <TimelineContentStack>
      {command ? <TimelineBashCommandContent command={command} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for execution result…" tone="muted" italic />
      ) : hasError ? (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
      ) : (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="muted" key={result.id} />)
      )}
    </TimelineContentStack>
  )
}

function BashToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : null
  const detail = bashDetail(input)
  const baseTitle = detail ? `Bash (${detail})` : 'Bash'
  const hasError = results.some(toolResultIsError)
  const title = hasError ? `${baseTitle} ERROR` : baseTitle
  return (
    <ToolCallDetails toolName="Bash" title={title} detail={detail ? `(${detail})` : null} hasError={hasError} pendingPermission={pendingPermission}>
      <BashToolContent command={command} results={results} />
    </ToolCallDetails>
  )
}

export function EditWriteToolContent({ toolName, input, filePath, results }: { toolName: 'Edit' | 'Write'; input: Record<string, unknown>; filePath: string | null; results: TimelineBlock[] }) {
  return (
    <TimelineContentStack>
      {toolName === 'Write' ? <TimelineCodeContent value={input.content as string} language={fileLanguage(filePath)} defaultWrapped={false} /> : <TimelineKvContent value={input} />}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone={toolResultIsError(result) ? 'error' : 'default'} key={result.id} />)
      )}
    </TimelineContentStack>
  )
}

function EditWriteToolCallView({ toolName, toolUse, results, pendingPermission }: { toolName: 'Edit' | 'Write'; toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const hasError = results.some(toolResultIsError)
  const pending = results.length === 0
  const title = pending ? (toolName === 'Edit' ? 'Editing' : 'Writing') : toolName === 'Edit' ? 'Update' : 'Write'
  if (!isRecord(input) || (toolName === 'Write' && typeof input.content !== 'string'))
    return <StaticLightToolRow toolName={toolName} title={title} error={hasError} pendingPermission={pendingPermission} />
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const displayPath = relativeFilePath(filePath, toolDataString(toolUse, 'cwd'))
  const detail = displayPath ? ` (${displayPath})` : ''
  const summary = `${title}${detail}${hasError ? ' ERROR' : ''}`
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={`Tool call ${toolName}`}
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={summary}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong>
              <span className="timeline-file-result-summary-detail">{detail}</span>
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <EditWriteToolContent toolName={toolName} input={input} filePath={filePath} results={results} />}
    />
  )
}

function readTextFile(data: Record<string, unknown>): { filePath: string; content: string } | null {
  if (!isRecord(data.toolUseResult)) return null
  const output = data.toolUseResult
  if (output.type !== 'text' || !isRecord(output.file) || typeof output.file.filePath !== 'string' || typeof output.file.content !== 'string') return null
  return { filePath: output.file.filePath, content: output.file.content }
}

function readFileResult(result: TimelineBlock): { filePath: string; content: string } | null {
  return isRecord(result.data) ? readTextFile(result.data) : null
}

export function readResultContentImage(data: Record<string, unknown>): ContentImage | null {
  if (readTextFile(data)) return null
  const content = Array.isArray(data.content) ? data.content : [data.content]
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source) || block.source.type !== 'base64') continue
    if ('error' in decodeContentImage(block.source.data, block.source.media_type) || typeof block.source.data !== 'string' || typeof block.source.media_type !== 'string') continue
    return { data: block.source.data, mediaType: block.source.media_type }
  }
  if (!isRecord(data.toolUseResult) || data.toolUseResult.type !== 'image' || !isRecord(data.toolUseResult.file)) return null
  const { base64, type } = data.toolUseResult.file
  if ('error' in decodeContentImage(base64, type) || typeof base64 !== 'string' || typeof type !== 'string') return null
  return { data: base64, mediaType: type }
}

function readResultValue(result: TimelineBlock): unknown {
  if (!isRecord(result.data)) return undefined
  if (contentBlockIsRenderable(result.data.content)) return result.data.content
  const image = readResultContentImage(result.data)
  return image ? { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } } : undefined
}

function readResultIsUnsupported(result: TimelineBlock): boolean {
  if (toolResultIsError(result) || readFileResult(result)) return false
  return !contentBlockIsRenderable(readResultValue(result))
}

function toolInputFilePath(toolUse: TimelineBlock): string | null {
  const input = toolDataField(toolUse, 'input')
  return isRecord(input) && typeof input.file_path === 'string' ? input.file_path : null
}

function StaticLightToolRow({ toolName, title, detail, error = false, pendingPermission }: { toolName: string; title: string; detail?: string | null; error?: boolean; pendingPermission?: boolean }) {
  const summary = `${title}${detail ? ` ${detail}` : ''}${error ? ' ERROR' : ''}`
  return (
    // biome-ignore lint/a11y/useSemanticElements: static stand-in for the <details> tool card; <fieldset> would add form semantics and UA border/padding
    <div className="timeline-file-result-details timeline-file-result-static" role="group" aria-label={`Tool call ${toolName}`}>
      <span className="timeline-file-result-summary" title={summary}>
        <span className="timeline-file-result-summary-text">
          <strong className="font-medium">{title}</strong>
          {detail ? <span className="timeline-file-result-summary-detail"> {detail}</span> : null}
        </span>
        {toolCallLabels(error, pendingPermission)}
      </span>
    </div>
  )
}

export function ReadToolContent({ results }: { results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  return (
    <TimelineContentStack>
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : hasError ? (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
      ) : (
        results.map((result) => {
          const file = readFileResult(result)
          return file ? (
            <TimelineCodeContent value={file.content} language={fileLanguage(file.filePath)} defaultWrapped={false} key={result.id} />
          ) : (
            <ToolResultValue value={readResultValue(result)} key={result.id} />
          )
        })
      )}
    </TimelineContentStack>
  )
}

function ReadToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const hasError = results.some(toolResultIsError)
  const files = hasError ? [] : results.map(readFileResult)
  const validFiles = files.filter((value): value is { filePath: string; content: string } => value !== null)
  const file = validFiles[0] ?? null
  const filePath = toolInputFilePath(toolUse)
  const displayPath = relativeFilePath(filePath, toolDataString(toolUse, 'cwd'))
  const lineCount = file ? contentLineCount(file.content) : null
  const pending = results.length === 0
  const title = pending ? 'Reading' : 'Read'
  const detail = [displayPath, lineCount === null ? null : `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`].filter(Boolean).join(' · ')
  const unsupported = results.some(readResultIsUnsupported)
  const summary = `${title}${detail ? ` (${detail})` : ''}${hasError || unsupported ? ' ERROR' : ''}`
  if (!hasError && unsupported) return <UnsupportedFileToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call Read"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={summary}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong>
              {detail ? <span className="timeline-file-result-summary-detail"> ({detail})</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <ReadToolContent results={results} />}
    />
  )
}

function unsupportedMessage(toolName: string): string {
  return `Unsupported ${toolName} result`
}

function sendMessageResultIsError(result: TimelineBlock): boolean {
  const output = toolUseResult(result)
  return toolResultIsError(result) || (isRecord(output) && output.success === false)
}

function sendMessageResultIsUnsupported(result: TimelineBlock): boolean {
  const output = toolUseResult(result)
  return hasToolUseResult(result) && !sendMessageResultIsError(result) && (!isRecord(output) || typeof output.success !== 'boolean')
}

export function SendMessageToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const unsupported = results.some(sendMessageResultIsUnsupported)
  return (
    <TimelineContentStack>
      {isRecord(input) ? <TimelineKvContent value={input} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : unsupported ? (
        <TimelineTextContent value={unsupportedMessage('SendMessage')} tone="error" />
      ) : (
        results.map((result) => {
          const output = toolUseResult(result)
          return isRecord(output) ? (
            <TimelineKvContent value={output} key={result.id} />
          ) : (
            <TimelineTextContent value={resultText(result)} tone={sendMessageResultIsError(result) ? 'error' : 'default'} key={result.id} />
          )
        })
      )}
    </TimelineContentStack>
  )
}

function SendMessageToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const to = isRecord(input) && typeof input.to === 'string' && input.to ? input.to : null
  const detail = to ? `(To: @${to})` : null
  const title = detail ? `SendMessage ${detail}` : 'SendMessage'
  const hasError = results.some(sendMessageResultIsError) || results.some(sendMessageResultIsUnsupported)
  return (
    <ToolCallDetails toolName="SendMessage" title={title} detail={detail} hasError={hasError} pendingPermission={pendingPermission}>
      <SendMessageToolContent input={input} results={results} />
    </ToolCallDetails>
  )
}

function askUserQuestionSummary(input: unknown, pending: boolean): { label: string; detail: string | null; title: string } {
  const headers =
    isRecord(input) && Array.isArray(input.questions)
      ? input.questions.flatMap((question) => (isRecord(question) && typeof question.header === 'string' && question.header ? [question.header] : []))
      : []
  const label = pending ? 'AskingUserQuestion' : 'AskUserQuestion'
  const detail = headers.length > 0 ? `(${headers.join(', ')})` : null
  return { label, detail, title: detail ? `${label} ${detail}` : label }
}

export function AskUserQuestionToolContent({
  input,
  results,
  questionRequest,
  submitting = false,
  onAnswerQuestion,
}: {
  input: unknown
  results: TimelineBlock[]
  questionRequest?: ToolApprovalRequest | null
  submitting?: boolean
  onAnswerQuestion?: (requestId: string, decision: AskUserQuestionDecisionRequest) => void
}) {
  const questions = isRecord(input) ? input.questions : []
  const error = results.find(toolResultIsError)
  const output = toolUseResult(results[0])
  const interactive = results.length === 0 ? questionRequest : null
  return (
    <TimelineContentStack className="timeline-question-content-stack">
      <TimelineQuestionFormContent
        key={interactive?.requestId}
        questions={interactive?.input.questions ?? questions}
        enabled={Boolean(interactive)}
        submitting={submitting}
        onSubmit={(answers, annotations) =>
          interactive &&
          onAnswerQuestion?.(interactive.requestId, { behavior: 'completed', toolUseID: interactive.toolUseID, answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) })
        }
        onCancel={() => interactive && onAnswerQuestion?.(interactive.requestId, { behavior: 'cancelled', toolUseID: interactive.toolUseID })}
      />
      {error ? (
        <TimelineTextContent value={resultText(error)} tone="error" />
      ) : results.length > 0 && isRecord(output) ? (
        <TimelineQuestionAnswersContent answers={output.answers} annotations={output.annotations} />
      ) : null}
    </TimelineContentStack>
  )
}

function AskUserQuestionToolCallView({
  toolUse,
  results,
  pendingPermission,
  questionRequest,
  submitting,
  onAnswerQuestion,
}: {
  toolUse: TimelineBlock
  results: TimelineBlock[]
  pendingPermission?: boolean
  questionRequest?: ToolApprovalRequest | null
  submitting?: boolean
  onAnswerQuestion?: (requestId: string, decision: AskUserQuestionDecisionRequest) => void
}) {
  const input = toolDataField(toolUse, 'input')
  const summary = askUserQuestionSummary(input, results.length === 0)
  const hasError = results.some(toolResultIsError)
  return (
    <ToolCallDetails toolName={summary.label} title={summary.title} detail={summary.detail} hasError={hasError} pendingPermission={pendingPermission}>
      <AskUserQuestionToolContent input={input} results={results} questionRequest={questionRequest} submitting={submitting} onAnswerQuestion={onAnswerQuestion} />
    </ToolCallDetails>
  )
}

function webFetchUrl(input: unknown): string | null {
  return isRecord(input) && typeof input.url === 'string' && input.url ? input.url : null
}

function webFetchResultText(result: TimelineBlock): string {
  const output = toolUseResult(result)
  const text = isRecord(output) && 'result' in output ? output.result : output
  return (typeof text === 'string' ? text : toolResultMarkdownText(text)) || resultText(result)
}

export function WebFetchToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  return (
    <TimelineContentStack>
      {isRecord(input) ? <TimelineKvContent value={input} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : hasError ? (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
      ) : (
        results.map((result) => <ToolMarkdownContent value={webFetchResultText(result)} key={result.id} />)
      )}
    </TimelineContentStack>
  )
}

function WebFetchToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const url = webFetchUrl(input)
  const title = url ? `${results.length === 0 ? 'Fetching' : 'Fetched'} Web (${url})` : 'WebFetch'
  const hasError = results.some(toolResultIsError)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call WebFetch"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{url ? (results.length === 0 ? 'Fetching Web' : 'Fetched Web') : 'WebFetch'}</strong>
              {url ? <span className="timeline-file-result-summary-detail"> ({url})</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <WebFetchToolContent input={input} results={results} />}
    />
  )
}

function webSearchResultItems(result: TimelineBlock): unknown[] | null {
  const output = toolUseResult(result)
  if (!isRecord(output) || !Array.isArray(output.results)) return null
  return output.results.flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : [item]))
}

function webSearchItemFields(item: unknown): { title: string; url: string; summary: string } {
  if (!isRecord(item)) return { title: typeof item === 'string' ? item : safeDataPreview(item, 0), url: '', summary: '' }
  return {
    title: typeof item.title === 'string' ? item.title : '',
    url: typeof item.url === 'string' ? item.url : '',
    summary: typeof item.snippet === 'string' ? item.snippet : typeof item.content === 'string' ? item.content : '',
  }
}

function WebSearchResultsContent({ items }: { items: unknown[] }) {
  return (
    <ol className="timeline-web-search-results" data-timeline-content="web_search">
      {items.map((item, index) => {
        const { title, url, summary } = webSearchItemFields(item)
        const label = title || url || summary || safeDataPreview(item, 0)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: results are a fixed list from one recorded WebSearch output and may lack unique urls
          <li className="timeline-web-search-result" key={index}>
            <div className="timeline-web-search-result-title">{label}</div>
            {url ? (
              <a className="timeline-web-search-result-url" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : null}
            {summary ? <div className="timeline-web-search-result-snippet">{summary}</div> : null}
          </li>
        )
      })}
    </ol>
  )
}

function webSearchResultIsUnsupported(result: TimelineBlock): boolean {
  return hasToolUseResult(result) && !toolResultIsError(result) && webSearchResultItems(result) === null
}

export function WebSearchToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  const unsupported = results.some(webSearchResultIsUnsupported)
  return (
    <TimelineContentStack>
      {isRecord(input) ? <TimelineKvContent value={input} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : hasError ? (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
      ) : unsupported ? (
        <TimelineTextContent value={unsupportedMessage('WebSearch')} tone="error" />
      ) : (
        results.map((result) => {
          const items = webSearchResultItems(result)
          return items ? <WebSearchResultsContent items={items} key={result.id} /> : <TimelineTextContent value={resultText(result)} key={result.id} />
        })
      )}
    </TimelineContentStack>
  )
}

function WebSearchToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const query = isRecord(input) && typeof input.query === 'string' && input.query ? input.query : null
  const label = results.length === 0 ? 'Searching Web' : 'Searched Web'
  const title = `${label}${query ? ` (${query})` : ''}`
  const hasError = results.some(toolResultIsError) || results.some(webSearchResultIsUnsupported)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call WebSearch"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{label}</strong>
              {query ? <span className="timeline-file-result-summary-detail"> ({query})</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <WebSearchToolContent input={input} results={results} />}
    />
  )
}

function taskOutputValue(result: TimelineBlock): { prompt?: string; result: string; timeout: boolean } | null {
  const output = toolUseResult(result)
  if (!isRecord(output) || !isRecord(output.task)) return null
  if (output.retrieval_status === 'timeout') return { result: '"retrieval_status": "timeout"', timeout: true }
  return typeof output.task.prompt === 'string' && typeof output.task.result === 'string' ? { prompt: output.task.prompt, result: output.task.result, timeout: false } : null
}

function taskOutputResultIsUnsupported(result: TimelineBlock): boolean {
  return hasToolUseResult(result) && taskOutputValue(result) === null
}

export function TaskOutputToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  const values = hasError ? [] : results.map(taskOutputValue)
  const unsupported = results.some(taskOutputResultIsUnsupported)
  return (
    <TimelineContentStack>
      {isRecord(input) && (results.length === 0 || hasError || unsupported) ? <TimelineKvContent value={input} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : hasError ? (
        results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
      ) : unsupported ? (
        <TimelineTextContent value={unsupportedMessage('TaskOutput')} tone="error" />
      ) : (
        values.map((value, index) =>
          value ? (
            <Fragment key={results[index]!.id}>
              {value.prompt ? <TimelineTextContent value={value.prompt} /> : null}
              {value.timeout ? <TimelineTextContent value={value.result} /> : <ToolMarkdownContent value={value.result} />}
            </Fragment>
          ) : (
            <TimelineTextContent value={resultText(results[index]!)} key={results[index]!.id} />
          ),
        )
      )}
    </TimelineContentStack>
  )
}

function TaskOutputToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const taskId = isRecord(input) && typeof input.task_id === 'string' && input.task_id ? input.task_id : null
  const name = results.length === 0 ? 'Waiting for task output' : 'TaskOutput'
  const title = `${name}${taskId ? ` (${taskId})` : ''}`
  const hasError = results.some(toolResultIsError) || results.some(taskOutputResultIsUnsupported)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call TaskOutput"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{name}</strong>
              {taskId ? <span className="timeline-file-result-summary-detail"> ({taskId})</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <TaskOutputToolContent input={input} results={results} />}
    />
  )
}

function taskStopResultIsUnsupported(result: TimelineBlock): boolean {
  return hasToolUseResult(result) && !toolResultIsError(result) && !isRecord(toolUseResult(result))
}

export function TaskStopToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const unsupported = results.some(taskStopResultIsUnsupported)
  return (
    <TimelineContentStack>
      {isRecord(input) ? <TimelineKvContent value={input} /> : null}
      {results.length === 0 ? (
        <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
      ) : unsupported ? (
        <TimelineTextContent value={unsupportedMessage('TaskStop')} tone="error" />
      ) : (
        results.map((result) => {
          if (toolResultIsError(result)) return <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />
          const output = toolUseResult(result)
          return isRecord(output) ? <TimelineKvContent value={output} key={result.id} /> : <TimelineTextContent value={resultText(result)} key={result.id} />
        })
      )}
    </TimelineContentStack>
  )
}

function TaskStopToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const taskId = isRecord(input) && typeof (input.task_id ?? input.shell_id) === 'string' && (input.task_id ?? input.shell_id) ? String(input.task_id ?? input.shell_id) : null
  const label = results.length === 0 ? 'TaskStopping' : 'TaskStop'
  const title = `${label}${taskId ? ` (${taskId})` : ''}`
  const hasError = results.some(toolResultIsError) || results.some(taskStopResultIsUnsupported)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call TaskStop"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{label}</strong>
              {taskId ? <span className="timeline-file-result-summary-detail"> ({taskId})</span> : null}
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <TaskStopToolContent input={input} results={results} />}
    />
  )
}

export function EnterPlanModeToolContent({ results }: { results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  return (
    <TimelineContentStack>
      {results.map((result) => (hasError ? <TimelineTextContent value={resultText(result)} tone="error" key={result.id} /> : <ToolMarkdownContent value={resultText(result)} key={result.id} />))}
    </TimelineContentStack>
  )
}

function EnterPlanModeToolCallView({ results, pendingPermission }: { results: TimelineBlock[]; pendingPermission?: boolean }) {
  if (results.length === 0) return <StaticLightToolRow toolName="EnterPlanMode" title="Entering plan mode" pendingPermission={pendingPermission} />
  const hasError = results.some(toolResultIsError)
  const title = hasError ? 'EnterPlanMode' : 'Entered plan mode'
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel="Tool call EnterPlanMode"
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong>
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <EnterPlanModeToolContent results={results} />}
    />
  )
}

function exitPlanModeResultIsError(result: TimelineBlock): boolean {
  return toolResultIsError(result) && (!isRecord(result.data) || result.data.toolDenialKind !== 'user-rejected')
}

export function ExitPlanModeToolContent({ plan, results }: { plan: string | null; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  return (
    <TimelineContentStack className={!hasError ? 'timeline-exit-plan-unbounded-content-stack' : undefined}>
      {results.length === 0 || hasError ? (
        plan ? (
          hasError ? (
            <ToolMarkdownContent value={plan} />
          ) : (
            <div className="timeline-assistant-text">
              <ToolMarkdownContent value={plan} />
            </div>
          )
        ) : null
      ) : null}
      {hasError
        ? results.map((result) => <TimelineTextContent value={resultText(result)} tone={exitPlanModeResultIsError(result) ? 'error' : undefined} key={result.id} />)
        : results.map((result) => (
            <div className="timeline-assistant-text" key={result.id}>
              <ToolMarkdownContent value={resultText(result)} />
            </div>
          ))}
    </TimelineContentStack>
  )
}

function ExitPlanModeToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const input = toolDataField(toolUse, 'input')
  const plan = isRecord(input) && typeof input.plan === 'string' ? input.plan : null
  const planFilePath = isRecord(input) && typeof input.planFilePath === 'string' && input.planFilePath ? input.planFilePath : null
  const title = `ExitPlanMode${planFilePath ? ` (${planFilePath})` : ''}`
  const hasError = results.some(toolResultIsError)
  const hasVisibleError = results.some(exitPlanModeResultIsError)
  // Product semantics: user-rejected ExitPlanMode feedback is a revision request, not an error badge/tone.
  return (
    <DeferredDetails
      key={hasError ? 'error' : 'open'}
      className="timeline-file-result-details"
      ariaLabel="Tool call ExitPlanMode"
      defaultOpen={!hasError}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">ExitPlanMode</strong>
              {planFilePath ? <span className="timeline-file-result-summary-detail"> ({planFilePath})</span> : null}
            </span>
            {toolCallLabels(hasVisibleError)}
            {pendingPermission ? <span className="timeline-tool-permission-label">ApprovalRequired</span> : null}
          </span>
        </summary>
      }
      renderBody={() => <ExitPlanModeToolContent plan={plan} results={results} />}
    />
  )
}

export function UnsupportedFileToolContent({ toolName, input, filePath, results }: { toolName: string; input: unknown; filePath: string | null; results: TimelineBlock[] }) {
  const messages = results.map((result) => <TimelineTextContent value={unsupportedMessage(toolName)} tone="error" key={result.id} />)
  if (toolName === 'Edit' && isRecord(input))
    return (
      <TimelineContentStack>
        <TimelineKvContent value={input} />
        {messages}
      </TimelineContentStack>
    )
  if (toolName === 'Write' && isRecord(input) && typeof input.content === 'string')
    return (
      <TimelineContentStack>
        <TimelineCodeContent value={input.content} language={fileLanguage(filePath)} defaultWrapped={false} />
        {messages}
      </TimelineContentStack>
    )
  return <TimelineContentStack>{messages}</TimelineContentStack>
}

function UnsupportedFileToolCallView({ toolUse, results, pendingPermission }: { toolUse: TimelineBlock; results: TimelineBlock[]; pendingPermission?: boolean }) {
  const toolName = toolDataString(toolUse, 'name') ?? 'Tool'
  const input = toolDataField(toolUse, 'input')
  const path = toolInputFilePath(toolUse)
  const detail = path ? `(${relativeFilePath(path, toolDataString(toolUse, 'cwd'))})` : null
  const title = toolName === 'Edit' ? 'Update' : toolName
  const summary = `${title}${detail ? ` ${detail}` : ''} ERROR`
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={`Tool call ${toolName}`}
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={summary}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{title}</strong>
              {detail ? <span className="timeline-file-result-summary-detail"> {detail}</span> : null}
            </span>
            {toolCallLabels(true, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <UnsupportedFileToolContent toolName={toolName} input={input} filePath={path} results={results} />}
    />
  )
}

function mcpToolIdentity(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return null
  const server = match[1]!
  return { server: `${server[0]!.toUpperCase()}${server.slice(1)}`, tool: match[2]! }
}

function mcpToolResultText(result: TimelineBlock): string {
  const value = toolUseResult(result)
  return (typeof value === 'string' ? value : toolResultMarkdownText(value)) || resultText(result)
}

export function McpToolContent({ input, results }: { input: unknown; results: TimelineBlock[] }) {
  const hasError = results.some(toolResultIsError)
  const output =
    results.length === 0 ? (
      <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
    ) : hasError ? (
      results.map((result) => <TimelineTextContent value={resultText(result)} tone="error" key={result.id} />)
    ) : (
      results.map((result) => <ToolMarkdownContent value={mcpToolResultText(result)} key={result.id} />)
    )
  return (
    <TimelineContentStack>
      {isRecord(input) ? <TimelineKvContent value={input} /> : null}
      {output}
    </TimelineContentStack>
  )
}

function McpToolCallView({
  identity,
  toolUse,
  results,
  pendingPermission,
}: {
  identity: { server: string; tool: string }
  toolUse: TimelineBlock
  results: TimelineBlock[]
  pendingPermission?: boolean
}) {
  const input = toolDataField(toolUse, 'input')
  const label = `${results.length === 0 ? 'Calling' : 'Called'} MCP ${identity.server}`
  const title = `${label} (${identity.tool})`
  const hasError = results.some(toolResultIsError)
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={title}
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{label}</strong>
              <span className="timeline-file-result-summary-detail"> ({identity.tool})</span>
            </span>
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => <McpToolContent input={input} results={results} />}
    />
  )
}

export function ToolCallBlockView({
  toolUse,
  results,
  pendingPermission,
  questionRequest,
  submittingQuestion,
  onAnswerQuestion,
}: {
  toolUse: TimelineBlock | null
  results: TimelineBlock[]
  source?: TimelineSource
  pendingPermission?: boolean
  questionRequest?: ToolApprovalRequest | null
  submittingQuestion?: boolean
  onAnswerQuestion?: (requestId: string, decision: AskUserQuestionDecisionRequest) => void
}) {
  const toolName = toolDataString(toolUse, 'name') ?? 'Tool result'
  const hasError = results.some(toolResultIsError)
  if (toolUse && toolName === 'Agent') return <AgentToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'Skill') return <SkillToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'Bash') return <BashToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'Read') return <ReadToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'SendMessage') return <SendMessageToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'AskUserQuestion')
    return (
      <AskUserQuestionToolCallView
        toolUse={toolUse}
        results={results}
        pendingPermission={pendingPermission}
        questionRequest={questionRequest}
        submitting={submittingQuestion}
        onAnswerQuestion={onAnswerQuestion}
      />
    )
  if (toolUse && toolName === 'WebFetch') return <WebFetchToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'WebSearch') return <WebSearchToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'TaskOutput') return <TaskOutputToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'TaskStop') return <TaskStopToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'EnterPlanMode') return <EnterPlanModeToolCallView results={results} pendingPermission={pendingPermission} />
  if (toolUse && toolName === 'ExitPlanMode') return <ExitPlanModeToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  const mcpIdentity = toolUse ? mcpToolIdentity(toolName) : null
  if (toolUse && mcpIdentity) return <McpToolCallView identity={mcpIdentity} toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && (toolName === 'Edit' || toolName === 'Write') && !hasError && results.some(hasToolUseResult))
    return <UnsupportedFileToolCallView toolUse={toolUse} results={results} pendingPermission={pendingPermission} />
  if (toolUse && (toolName === 'Edit' || toolName === 'Write')) return <EditWriteToolCallView toolName={toolName} toolUse={toolUse} results={results} pendingPermission={pendingPermission} />

  const toolInput = toolDataField(toolUse, 'input')
  const summary = toolInputSummary(toolInput)
  const title = `${toolName}${summary ? ` (${summary})` : ''}`
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      ariaLabel={`Tool call ${toolName}`}
      defaultOpen={pendingPermission}
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span className="timeline-file-result-summary" title={title}>
            <span className="timeline-file-result-summary-text">
              <strong className="font-medium">{toolName}</strong>
              {summary ? <span className="timeline-file-result-summary-detail"> ({summary})</span> : null}
            </span>
            {!toolUse ? <span className={[toolTimelineClass.state, toolTimelineClass.stateError].join(' ')}>Unmatched</span> : null}
            {results.length === 0 ? <span className={toolTimelineClass.state}>Pending</span> : null}
            {toolCallLabels(hasError, pendingPermission)}
          </span>
        </summary>
      }
      renderBody={() => (
        <TimelineContentStack>
          {toolUse ? <ToolInputValue value={toolInput} /> : null}
          {results.length === 0 ? (
            <TimelineTextContent value="Waiting for tool result…" tone="muted" italic />
          ) : (
            results.map((result) =>
              toolResultIsError(result) ? <TimelineTextContent value={resultText(result)} tone="error" key={result.id} /> : <ToolResultValue value={toolResultValue(result)} key={result.id} />,
            )
          )}
        </TimelineContentStack>
      )}
    />
  )
}
