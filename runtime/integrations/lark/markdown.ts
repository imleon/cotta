const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch
    return ''
  })
}

function optimizeMarkdownCore(text: string): string {
  const mark = '___CB_'
  const codeBlocks: string[] = []
  let result = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = '') => {
    const block = match.slice(String(prefix).length)
    return `${prefix}${mark}${codeBlocks.push(block) - 1}___`
  })

  if (/^#{1,6} /m.test(text)) {
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
  }

  result = result.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')
  result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')
  result = result.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n$1')

  codeBlocks.forEach((block, index) => {
    result = result.replace(`${mark}${index}___`, `\n${block}\n`)
  })

  result = result.replace(/\n{3,}/g, '\n\n')
  return result
}

import { createLogger } from '../../core/logger.js'

const logger = createLogger('lark-markdown')

export function optimizeLarkMarkdownStyle(text: string): string {
  if (!text.trim()) return text
  try {
    return stripInvalidImageKeys(optimizeMarkdownCore(text))
  } catch (error) {
    logger.warn('optimize-markdown-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return text
  }
}
