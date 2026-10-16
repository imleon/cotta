import { isAbsolute, resolve } from 'node:path'
import { localImageDestinationPathname, markdownPayloadLineIndices, normalizeMarkdownUri, pruneShareSnapshot, type TurnSummary, unwrapMarkdownPayloadFences } from '@cotta/shared'
import { type CompileContext, fromMarkdown, type Token } from 'mdast-util-from-markdown'

type JsonRecord = Record<string, unknown>
function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

// Source range of each image/definition destination, captured at parse time: mdast `url` is decoded (escapes, entities)
// and the node span also covers alt text and title, so neither can locate the destination text reliably.
const destinationRanges = new WeakMap<object, { start: number; end: number }>()
function enterDestination(this: CompileContext, token: Token): undefined {
  const node = this.stack.at(-1)
  if (node) destinationRanges.set(node, { start: token.start.offset, end: token.end.offset })
  this.buffer()
}
const destinationRangeExtension = { enter: { resourceDestinationString: enterDestination, definitionDestinationString: enterDestination } }

type ImageDestination = { url: string; start?: number; end?: number }

/** Every markdown image destination (inline, and reference via its definition) in one markdown string, with its source range. */
function imageDestinations(markdown: string): ImageDestination[] {
  const tree = fromMarkdown(markdown, { mdastExtensions: [destinationRangeExtension] })
  const definitions = new Map<string, JsonRecord>()
  const images: JsonRecord[] = []
  const visit = (node: unknown, collectDefinitions: boolean): void => {
    if (!record(node)) return
    if (collectDefinitions && node.type === 'definition' && typeof node.identifier === 'string' && typeof node.url === 'string') {
      const identifier = node.identifier.toUpperCase()
      if (!definitions.has(identifier)) definitions.set(identifier, node)
    }
    if (!collectDefinitions && node.type === 'image' && typeof node.url === 'string') images.push(node)
    if (!collectDefinitions && node.type === 'imageReference' && typeof node.identifier === 'string') {
      const definition = definitions.get(node.identifier.toUpperCase())
      if (definition?.url) images.push(definition)
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, collectDefinitions)
  }
  visit(tree, true)
  visit(tree, false)
  return images.map((node) => ({ url: node.url as string, ...destinationRanges.get(node) }))
}

/** Normalized destinations of every markdown image (inline + reference) in one markdown string. */
export function markdownImageDestinations(markdown: string): Set<string> {
  return new Set(imageDestinations(markdown).map(({ url }) => normalizeMarkdownUri(url)))
}

/** Image destinations of one text block as rendered (payload fences unwrapped), with ranges mapped back into the raw text. */
function textBlockImageDestinations(text: string): ImageDestination[] {
  const lines = text.split('\n')
  const kept = markdownPayloadLineIndices(text)
  const rawStart: number[] = []
  let offset = 0
  for (const line of lines) {
    rawStart.push(offset)
    offset += line.length + 1
  }
  // Unwrapping only drops whole lines and a destination never spans lines, so shift each by its own line's offset.
  const shifts: Array<{ start: number; shift: number }> = []
  offset = 0
  for (const index of kept) {
    shifts.push({ start: offset, shift: rawStart[index] - offset })
    offset += lines[index].length + 1
  }
  const shift = (position: number): number => {
    let line = shifts.length - 1
    while (shifts[line].start > position) line -= 1
    return shifts[line].shift
  }
  return imageDestinations(kept.map((index) => lines[index]).join('\n')).map((image) =>
    image.start === undefined || image.end === undefined ? image : { ...image, start: image.start + shift(image.start), end: image.end + shift(image.start) },
  )
}

/** Content blocks of a main assistant message — the only messages whose markdown images are served. */
function assistantContent(message: unknown): unknown[] | null {
  return record(message) && message.type === 'assistant' && record(message.message) && message.message.role === 'assistant' && Array.isArray(message.message.content) ? message.message.content : null
}

/** Maps each referenced local image (normalized src) to the cwd that resolves it, derived straight from the turn snapshot. Remote/unsafe srcs are excluded. */
function turnImageBindings(turn: TurnSummary): Map<string, string | undefined> {
  const fallbackCwd = turn.responseCwd ?? turn.userCwd
  const bindings = new Map<string, string | undefined>()
  for (const message of turn.messages) {
    const content = assistantContent(message)
    if (!content || !record(message)) continue
    const cwd = typeof message.cwd === 'string' && message.cwd.trim() ? message.cwd : fallbackCwd
    for (const block of content) {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      for (const src of markdownImageDestinations(unwrapMarkdownPayloadFences(block.text))) if (localImageDestinationPathname(src) && !bindings.has(src)) bindings.set(src, cwd)
    }
  }
  return bindings
}

/** Absolute filesystem path for a local image destination under cwd, or null if it can't be resolved safely. */
function resolveImagePath(pathname: string, cwd: string | undefined): string | null {
  if (isAbsolute(pathname)) return resolve(pathname)
  return cwd ? resolve(cwd, pathname) : null
}

/**
 * Resolves one requested src against a turn snapshot. Returns the absolute path to attempt, or null when the src
 * is not referenced by this turn — that null IS the authorization gate (a token can only reach its turn's own images).
 */
export function resolveTurnImagePath(turn: TurnSummary, rawSrc: string): string | null {
  const bindings = turnImageBindings(turn)
  const normalized = normalizeMarkdownUri(rawSrc)
  if (!bindings.has(normalized)) return null
  const pathname = localImageDestinationPathname(rawSrc)
  return pathname ? resolveImagePath(pathname, bindings.get(normalized)) : null
}

/** Enumerates every referenced local image in a turn with its resolved path (null = unresolvable → manifest placeholder). */
export function turnImagePaths(turn: TurnSummary): Array<{ src: string; path: string | null }> {
  return [...turnImageBindings(turn)].map(([src, cwd]) => {
    const pathname = localImageDestinationPathname(src)
    return { src, path: pathname ? resolveImagePath(pathname, cwd) : null }
  })
}

/** The opaque, path-free src a shared snapshot uses for its i-th referenced local image. Never a real filesystem path. */
export function shareImageKey(index: number): string {
  return `cotta-asset/${index}`
}

/**
 * Sanitizes a turn snapshot for public sharing: every referenced local-image src is replaced by its opaque share key
 * (so no filesystem path leaks into the shared markdown), and every cwd — turn-level userCwd/responseCwd and each
 * message's cwd — is dropped (so no absolute path leaks into the response body or renders into activity targets).
 * `keyBySrc` maps a normalized src → its key. Pure (deep-copies).
 */
export function sanitizeTurnForShare(turn: TurnSummary, keyBySrc: ReadonlyMap<string, string>): TurnSummary {
  const next = structuredClone(turn) as TurnSummary
  delete next.userCwd
  delete next.responseCwd
  for (const message of next.messages) {
    if (!record(message)) continue
    delete message.cwd
    for (const block of assistantContent(message) ?? []) {
      if (record(block) && block.type === 'text' && typeof block.text === 'string') block.text = rewriteImageDestinations(block.text, keyBySrc)
    }
  }
  relativizeTurnPaths(next, turn)
  pruneShareSnapshot(next)
  return next
}

/** Replaces each owning message's cwd prefix in tool input/result paths with a relative path, before cwd is unused. */
function relativizeTurnPaths(next: TurnSummary, source: TurnSummary): void {
  for (let i = 0; i < next.messages.length; i += 1) {
    const original = source.messages[i]
    const cwd = record(original) && typeof original.cwd === 'string' && original.cwd.trim() ? original.cwd.replace(/\/$/, '') : null
    const message = next.messages[i]
    if (!cwd || !record(message)) continue
    // Only tool fields carry cwd-prefixed paths that render in headers; conversational text is left for the Markdown export.
    const content = record(message.message) ? message.message.content : null
    if (Array.isArray(content)) for (const block of content) if (record(block) && (block.type === 'tool_use' || block.type === 'tool_result')) stripCwdPrefix(block, cwd)
    if (Object.hasOwn(message, 'tool_use_result')) message.tool_use_result = stripCwdPrefix(message.tool_use_result, cwd)
    if (Object.hasOwn(message, 'toolUseResult')) message.toolUseResult = stripCwdPrefix(message.toolUseResult, cwd)
  }
}

/** Drops every `${cwd}/` occurrence from each string in a value (recursing into objects/arrays), returning the rewritten value. */
function stripCwdPrefix(value: unknown, cwd: string): unknown {
  if (typeof value === 'string') return value.split(`${cwd}/`).join('')
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = stripCwdPrefix(value[i], cwd)
    return value
  }
  if (!record(value)) return value
  for (const key of Object.keys(value)) value[key] = stripCwdPrefix(value[key], cwd)
  return value
}

/** Splices each keyed image destination's exact source range with its share key; everything else stays byte-identical. */
function rewriteImageDestinations(text: string, keyBySrc: ReadonlyMap<string, string>): string {
  const edits = new Map<number, { end: number; key: string }>()
  for (const { url, start, end } of textBlockImageDestinations(text)) {
    const key = keyBySrc.get(normalizeMarkdownUri(url))
    if (key && start !== undefined && end !== undefined) edits.set(start, { end, key })
  }
  let output = text
  for (const [start, { end, key }] of [...edits].sort(([a], [b]) => b - a)) output = output.slice(0, start) + key + output.slice(end)
  return output
}
