function protectCodeBlocks(text: string): { protectedText: string; restore: (value: string) => string } {
  const blocks: string[] = []
  const protectedText = text.replace(/```[\s\S]*?```/g, (match) => {
    const index = blocks.push(match) - 1
    return `__COTTA_CODE_BLOCK_${index}__`
  })
  return {
    protectedText,
    restore(value: string) {
      return value.replace(/__COTTA_CODE_BLOCK_(\d+)__/g, (_token, rawIndex) => {
        const index = Number(rawIndex)
        return Number.isInteger(index) && blocks[index] ? blocks[index] : _token
      })
    },
  }
}

function optimizeMarkdownCore(text: string): string {
  let result = text

  const hasH1toH3 = /^#{1,3} /m.test(result)
  if (hasH1toH3) {
    result = result.replace(/^#{2,6} (.+)$/gm, '##### $1')
    result = result.replace(/^# (.+)$/gm, '#### $1')
  }

  result = result.replace(/([^\n])\n(\|.+\|\n\|[-: ]+\|)/g, '$1\n\n$2')
  result = result.replace(/(\|[-: ]+\|(?:\n\|.*\|)+)(\n[^\n])/g, '$1\n\n$2')
  result = result.replace(/([^\n])\n(```)/g, '$1\n\n$2')
  result = result.replace(/(```)\n([^\n])/g, '$1\n\n$2')
  result = result.replace(/\n{3,}/g, '\n\n')

  return result.trim()
}

export function optimizeLarkMarkdownStyle(text: string): string {
  if (!text.trim()) return text
  const { protectedText, restore } = protectCodeBlocks(text)
  return restore(optimizeMarkdownCore(protectedText))
}
