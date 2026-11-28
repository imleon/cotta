import { isPrimaryTimelineUserMessage } from '@cotta/shared'

type JsonRecord = Record<string, unknown>

export type PromptExtraction = { firstPrompt?: string; commandFallback?: string; locked?: boolean }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const requestMarkup = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/
const commandName = /<command-name>(.*?)<\/command-name>/
const bashInput = /<bash-input>([\s\S]*?)<\/bash-input>/

function truncatePrompt(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200).trim()}…` : text
}

export function extractPromptCandidate(value: JsonRecord, currentCommandFallback: string | null): PromptExtraction {
  if (value.type !== 'user' || value.isMeta === true || value.isCompactSummary === true || !isPrimaryTimelineUserMessage(value)) return {}
  const message = isRecord(value.message) ? value.message : null
  const content = message?.content
  const texts: string[] = []
  let hasImage = false
  if (typeof content === 'string') texts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_result') return {}
      if (block.type === 'image') hasImage = true
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  let commandFallback: string | undefined
  for (const raw of texts) {
    const text = raw.replaceAll('\n', ' ').trim()
    if (!text) continue
    const command = commandName.exec(text)
    if (command) {
      if (!currentCommandFallback && !commandFallback) commandFallback = command[1]
      continue
    }
    const bash = bashInput.exec(text)
    if (bash) return { firstPrompt: `! ${bash[1].trim()}`, commandFallback, locked: true }
    if (requestMarkup.test(text)) continue
    return { firstPrompt: truncatePrompt(text), commandFallback, locked: true }
  }
  if (hasImage) return { firstPrompt: 'Image prompt', commandFallback, locked: true }
  return commandFallback ? { commandFallback } : {}
}
