import type { Definition, Nodes } from 'mdast'
import { type CompileContext, fromMarkdown, type Token } from 'mdast-util-from-markdown'

type Range = { start: number; end: number }
type Prefix = Range & { text: string; remainder: string; owner?: object }

function columns(text: string): number {
  let width = 0
  for (const char of text) width += char === '\t' ? 4 - (width % 4) : 1
  return width
}

function range(node: Nodes): Range {
  // All nodes here come directly from fromMarkdown, which always supplies offsets.
  return { start: node.position!.start.offset!, end: node.position!.end.offset! }
}

function hasNestedQuote(node: Nodes, inList = false): boolean {
  const stack = [{ node, inList }]
  while (stack.length) {
    const { node, inList } = stack.pop()!
    if (node.type === 'blockquote' && inList) return true
    if ('children' in node) {
      for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index], inList: inList || node.type === 'list' })
    }
  }
  return false
}

function* walk(node: Nodes): Generator<Nodes> {
  const stack = [node]
  while (stack.length) {
    const current = stack.pop()!
    yield current
    if ('children' in current) {
      for (let index = current.children.length - 1; index >= 0; index--) stack.push(current.children[index])
    }
  }
}

/** Record actual container prefixes, not guessed indentation: lazy lines have no prefix. */
function parse(content: string) {
  const prefixes: Prefix[] = []
  let line = 0
  let visualEnd = 0
  let sourceEnd = -1
  const consumed = new Set<object>()
  function prefix(this: CompileContext, token: Token) {
    if (line !== token.start.line) {
      line = token.start.line
      visualEnd = 0
      consumed.clear()
    }
    const type = token.type === 'blockQuotePrefix' ? 'blockquote' : 'listItem'
    const containers = this.stack.filter((node) => node.type === type)
    const owner = token.type === 'listItemPrefix' ? containers.at(-1) : containers.find((node) => !consumed.has(node))
    const container = token.type !== 'linePrefix'
    // Trailing blank-line indentation can arrive after its list item has closed.
    if (container && !owner) return
    if (container) consumed.add(owner!)
    const { start, end } = token
    const lineStart = Math.max(content.lastIndexOf('\n', start.offset - 1), content.lastIndexOf('\r', start.offset - 1)) + 1
    // One tab can span multiple containers. Preserve its unconsumed virtual spaces.
    const visualStart = start.offset === sourceEnd ? visualEnd : columns(content.slice(lineStart, start.offset))
    const text = this.sliceSerialize(token, true)
    visualEnd = visualStart + text.length
    sourceEnd = end.offset
    const remainder = ' '.repeat(Math.max(0, columns(content.slice(lineStart, end.offset)) - visualEnd))
    prefixes.push({ start: start.offset, end: end.offset, text, remainder, ...(container ? { owner } : {}) })
  }
  const tree = fromMarkdown(content, { mdastExtensions: [{ enter: { listItemPrefix: prefix, listItemIndent: prefix, blockQuotePrefix: prefix, linePrefix: prefix } }] })
  function unwrap(node: Nodes): string {
    const { start, end } = range(node)
    let cursor = start
    let result = ''
    let remainder = ''
    for (const prefix of prefixes) {
      if (prefix.start < start || prefix.end > end) continue
      if (prefix.start > cursor) result += remainder + content.slice(cursor, prefix.start)
      // Expand only parser-recognized syntax prefixes at their original columns.
      // Code payload tabs remain verbatim, including a partly consumed tab's remainder.
      if (prefix.owner !== node) result += prefix.text
      remainder = prefix.remainder
      cursor = prefix.end
    }
    return result + remainder + content.slice(cursor, end)
  }
  return { tree, unwrap }
}

function quote(content: string): string {
  return `> ${content.replace(/(\r\n|\n|\r)/g, '$1> ')}`
}

function item(content: string, marker: string): string {
  if (!content.trim()) return marker
  return `${marker} ${content.replace(/(\r\n|\n|\r)(?=.)/g, `$1${' '.repeat(marker.length + 1)}`)}`
}

function split(content: string, liftQuotes: boolean): string[] {
  type Task = { kind: 'split'; content: string; liftQuotes: boolean; quoteDepth: number } | { kind: 'emit'; content: string; quoteDepth: number }
  const tasks: Task[] = [{ kind: 'split', content, liftQuotes, quoteDepth: 0 }]
  const parts: string[] = []
  while (tasks.length) {
    const task = tasks.pop()!
    if (task.kind === 'emit') {
      let text = task.content
      for (let depth = 0; depth < task.quoteDepth; depth++) text = quote(text)
      parts.push(text)
      continue
    }
    const { content, liftQuotes, quoteDepth } = task
    const { tree, unwrap } = parse(content)
    const next: Task[] = []
    const append = (text: string) => {
      if (text.trim()) next.push({ kind: 'emit', content: text, quoteDepth })
    }
    let cursor = 0
    for (const node of tree.children) {
      const affected = hasNestedQuote(node)
      if (!affected && !(liftQuotes && node.type === 'blockquote')) continue
      const { start, end } = range(node)
      append(content.slice(cursor, start))
      if (node.type === 'list') {
        let pending = ''
        let previousEnd = start
        for (const [index, child] of node.children.entries()) {
          const childRange = range(child)
          const original = content.slice(childRange.start, childRange.end)
          const marker = node.ordered ? `${node.start! + index}.` : original[0]
          const body = unwrap(child)
          const bodyTree = fromMarkdown(body)
          const boundary = bodyTree.children.find((block) => block.type === 'blockquote' || hasNestedQuote(block))
          // Keep the original tight/loose item separators; split only at a lifted boundary.
          if (pending) pending += content.slice(previousEnd, childRange.start - child.position!.start.column + 1)
          previousEnd = childRange.end
          if (!boundary) {
            pending += item(body, marker)
            continue
          }
          const cut = range(boundary).start
          pending += item(body.slice(0, cut), marker)
          append(pending)
          pending = ''
          next.push({ kind: 'split', content: body.slice(cut), liftQuotes: true, quoteDepth })
        }
        append(pending)
      } else if (node.type === 'blockquote') {
        if (affected) next.push({ kind: 'split', content: unwrap(node), liftQuotes: false, quoteDepth: quoteDepth + 1 })
        else append(content.slice(start, end))
      }
      cursor = end
    }
    append(content.slice(cursor))
    // Reverse the scheduled work so each subtree is emitted before its following siblings.
    for (let index = next.length - 1; index >= 0; index--) tasks.push(next[index])
  }
  return parts
}

// Escape decoded destinations/titles without introducing new Markdown syntax or line breaks.
function linkValue(value: string): string {
  return value.replace(/[&<>"\\\r\n]/g, (char) => `&#${char.charCodeAt(0)};`)
}

/** Lark drops blockquotes inside lists. Lift only those list subtrees into separate Markdown elements. */
export function splitLarkMarkdown(content: string): string[] {
  const labels = new WeakMap<object, Range>()
  function label(this: CompileContext, token: Token) {
    labels.set(this.stack[this.stack.length - 2], { start: token.start.offset, end: token.end.offset })
  }
  const tree = fromMarkdown(content, { mdastExtensions: [{ enter: { labelText: label } }] })
  if (!hasNestedQuote(tree)) return [content]
  const definitions = new Map<string, Definition>()
  for (const node of walk(tree)) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
  }
  // Resolve references against the original document before splitting or budget truncation.
  // Replace only reference suffixes, keeping labels (including nested images) byte-for-byte.
  const edits: Array<Range & { text: string }> = []
  for (const node of walk(tree)) {
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = definitions.get(node.identifier)!
      const title = definition.title == null ? '' : ` "${linkValue(definition.title)}"`
      edits.push({ start: labels.get(node)!.end + 1, end: range(node).end, text: `(<${linkValue(definition.url)}>${title})` })
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end)
  return split(content, false)
}
