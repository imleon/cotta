/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch
    return ''
  })
}

function optimizeMarkdownCore(text: string, cardVersion = 2): string {
  const mark = '___CB_'
  const codeBlocks: string[] = []
  let result = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = '') => {
    const block = match.slice(String(prefix).length)
    return `${prefix}${mark}${codeBlocks.push(block) - 1}___`
  })

  const hasHeadings = /^#{1,6} /m.test(text)
  if (hasHeadings) {
    // Lark renders headings noticeably larger than the web UI. Flatten them into
    // bold body text so the visual size stays closer to the web experience.
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
  }

  if (cardVersion >= 2) {
    result = result.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')

    result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')
    result = result.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n$1')
    result = result.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (match, _table, offset) => {
      const after = result.slice(offset + match.length).replace(/^\n+/, '')
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return match
      return `${match}\n`
    })

    codeBlocks.forEach((block, index) => {
      result = result.replace(`${mark}${index}___`, `\n${block}\n`)
    })
  } else {
    codeBlocks.forEach((block, index) => {
      result = result.replace(`${mark}${index}___`, block)
    })
  }

  result = result.replace(/\n{3,}/g, '\n\n')
  return result
}

export function optimizeLarkMarkdownStyle(text: string): string {
  if (!text.trim()) return text

  try {
    return stripInvalidImageKeys(optimizeMarkdownCore(text, 2))
  } catch {
    return text
  }
}
