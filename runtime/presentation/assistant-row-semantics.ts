export const THINKING_ROW_TITLE = '思考'

export function extractThinkingSubtitle(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const headingMatch = text.match(/^#{1,6}\s+(.+?)\s*#*\s*(?:\n|$)/)
  if (headingMatch?.[1]) return headingMatch[1].trim()

  const boldMatch = text.match(/^\*\*(.+?)\*\*(?:\s|:|：|\n|$)/)
  if (boldMatch?.[1]) return boldMatch[1].trim()

  return ''
}
