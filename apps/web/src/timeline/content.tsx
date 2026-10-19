import { contentLineCount, decodeComposerImage, localImageDestinationPathname, type TimelineBlock, unwrapMarkdownPayloadFences } from '@cotta/shared'
import { diffWordsWithSpace } from 'diff'
import {
  Children,
  type ComponentPropsWithoutRef,
  createContext,
  Fragment,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown'
import Zoom from 'react-medium-image-zoom'
import remarkGfm from 'remark-gfm'
import { fetchLocalMessageImage, type LocalImageConfirmation, LocalImageHttpError } from '../api'
import { type FileMutationResult, isRecord, type StructuredPatchHunk, shortText, type TimelineSource } from './core'
import { highlightCode, resolveHighlightLanguage, tokenizeCode } from './highlight'

export function safeDataPreview(value: unknown, space = 2): string {
  return (
    JSON.stringify(
      value,
      function (key, field) {
        return key === 'base64' ||
          (key === 'data' && isRecord(this) && (this.type === 'base64' || (this.type === 'image' && (typeof this.media_type === 'string' || typeof this.mimeType === 'string'))))
          ? '[base64 omitted]'
          : field
      },
      space,
    ) ?? ''
  )
}

function formatTimestamp(value: number | undefined, timeZone: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

function textFromReactNode(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textFromReactNode).join('')
  if (isValidElement<{ children?: ReactNode }>(value)) return textFromReactNode(value.props.children)
  return ''
}

function codeLanguage(className?: string): string | null {
  return className?.match(/language-([^\s]+)/)?.[1] ?? null
}

function guessCodeLanguage(code: string): string {
  const trimmed = code.trim()
  if (/^(export\s+\w+=|(?:npm|pnpm|yarn|curl|git|claude)\b|[\w./-]+\s*\\\n)/m.test(trimmed)) return 'bash'
  if (/^[[{]/.test(trimmed)) return 'json'
  if (/\b(import|export|const|let|function|type|interface)\b/.test(trimmed)) return 'ts'
  return 'text'
}

const highlightedCodeCache = new Map<string, string>()

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const { contentImages } = useContext(markdownRenderContext)
  const image = Children.toArray(children).find((child) => isValidElement<{ src?: unknown }>(child) && child.type === MarkdownImage)
  const imageSrc = isValidElement<{ src?: unknown }>(image) ? image.props.src : undefined
  if (typeof imageSrc === 'string' && (!isRemoteImageSource(imageSrc) || contentImages?.has(imageSrc))) return <span>{children}</span>
  const external = /^https?:\/\//.test(href ?? '')
  return (
    <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} {...props}>
      {children}
    </a>
  )
}

export function TimelineCodeActions({ language, wrapped, onToggleWrap, copyValue }: { language: string | null; wrapped: boolean; onToggleWrap: () => void; copyValue: string }) {
  const [copyStatus, setCopyStatus] = useState<'Copy' | 'Copied' | 'Failed'>('Copy')
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current)
    },
    [],
  )

  async function handleCopy() {
    try {
      await writeClipboard(copyValue)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Failed')
    }
    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current)
    copyStatusTimerRef.current = setTimeout(() => setCopyStatus('Copy'), 1400)
  }

  return (
    <div className="markdown-code-toolbar">
      {language ? <span className="markdown-code-language">{language}</span> : null}
      <button type="button" aria-label={wrapped ? 'Disable line wrap' : 'Enable line wrap'} data-tooltip={wrapped ? 'No wrap' : 'Wrap'} onClick={onToggleWrap}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 6h12M4 10h8a3 3 0 1 1 0 6H9" />
          <path d="m11 13-2 3 2 3" />
        </svg>
      </button>
      <button type="button" aria-label="Copy code" data-tooltip={copyStatus} onClick={handleCopy}>
        {copyStatus === 'Copied' ? (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m4 10.5 4 4L16 6" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="2" />
            <path d="M4 13V5a1 1 0 0 1 1-1h8" />
          </svg>
        )}
      </button>
    </div>
  )
}

function HighlightedCode({
  className,
  children,
  copyValue,
  defaultWrapped = true,
  wrapped: controlledWrapped,
  onWrappedChange,
  plain = false,
  actions = true,
  lineNumbers = false,
}: {
  className?: string
  children?: ReactNode
  copyValue?: string
  defaultWrapped?: boolean
  wrapped?: boolean
  onWrappedChange?: (wrapped: boolean) => void
  plain?: boolean
  actions?: boolean
  lineNumbers?: boolean
}) {
  const code = textFromReactNode(children).replace(/\n$/, '')
  const explicitLang = codeLanguage(className)
  const lang = resolveHighlightLanguage(explicitLang ?? guessCodeLanguage(code))
  const cacheKey = plain || !lang ? null : `${lang}\0${code}`
  const [html, setHtml] = useState<string | null>(() => (cacheKey && !lineNumbers ? (highlightedCodeCache.get(cacheKey) ?? null) : null))
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null)
  const [internalWrapped, setInternalWrapped] = useState(defaultWrapped)
  const wrapped = controlledWrapped ?? internalWrapped

  useEffect(() => {
    if (lineNumbers) {
      setHtml(null)
      setTokens(null)
      if (!lang) return
      let cancelled = false
      void tokenizeCode(code, lang)
        .then((value) => {
          if (!cancelled) setTokens(value?.tokens as HighlightToken[][] | null)
        })
        .catch(() => {
          if (!cancelled) setTokens(null)
        })
      return () => {
        cancelled = true
      }
    }
    setTokens(null)
    if (!cacheKey) {
      setHtml(null)
      return
    }
    const cached = highlightedCodeCache.get(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }
    setHtml(null)

    let cancelled = false
    void highlightCode(code, lang)
      .then((value) => {
        if (!value) return
        highlightedCodeCache.set(cacheKey, value)
        if (highlightedCodeCache.size > 200) {
          const oldest = highlightedCodeCache.keys().next().value
          if (oldest) highlightedCodeCache.delete(oldest)
        }
        if (!cancelled) setHtml(value)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, code, lang, lineNumbers])

  return (
    <div className="markdown-code-block" data-wrap={wrapped ? 'true' : 'false'}>
      {actions ? (
        <TimelineCodeActions
          language={explicitLang}
          wrapped={wrapped}
          copyValue={copyValue ?? code}
          onToggleWrap={() => {
            const next = !wrapped
            if (onWrappedChange) onWrappedChange(next)
            else setInternalWrapped(next)
          }}
        />
      ) : null}
      {lineNumbers ? (
        <div className="shiki-code">
          <pre className="shiki github-light" style={{ backgroundColor: 'var(--surface-raised)', color: '#24292e' }}>
            <code>
              {code.split('\n').map((line, index) => (
                <span className="line timeline-code-line" key={index}>
                  <span className="timeline-code-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="timeline-code-line-content">
                    {(tokens?.[index] ?? [{ content: line }]).map((token, tokenIndex) => (
                      <span style={tokenStyle(token)} key={tokenIndex}>
                        {token.content}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      ) : html ? (
        <div className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code className={className}>{children}</code>
        </pre>
      )}
    </div>
  )
}

export function TimelineCodeContent({
  value,
  language,
  copyValue,
  defaultWrapped = true,
  lineNumbers = false,
  wrapped,
  onWrappedChange,
  actions = true,
}: {
  value: string
  language?: string | null
  copyValue?: string
  defaultWrapped?: boolean
  lineNumbers?: boolean
  wrapped?: boolean
  onWrappedChange?: (wrapped: boolean) => void
  actions?: boolean
}) {
  return (
    <div data-timeline-content="code">
      <HighlightedCode
        className={language ? `language-${language}` : undefined}
        copyValue={copyValue}
        defaultWrapped={defaultWrapped}
        lineNumbers={lineNumbers}
        wrapped={wrapped}
        onWrappedChange={onWrappedChange}
        actions={actions}
      >
        {value}
      </HighlightedCode>
    </div>
  )
}

export function TimelineTextContent({ value, tone = 'default', italic = false, className }: { value: string; tone?: 'default' | 'muted' | 'error'; italic?: boolean; className?: string }) {
  return (
    <pre className={['timeline-tool-content-text', className].filter(Boolean).join(' ')} data-timeline-content="text" data-tone={tone} data-italic={italic ? 'true' : undefined}>
      {value}
    </pre>
  )
}

export type ContentImage = { mediaType: string; data: string }
export type LocalImageContext = { sessionId: string; messageUuid: string; projectPath: string; cwd: string; agentId?: string }

function isRemoteImageSource(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

function isLocalImageSource(src: string): boolean {
  return !src.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(src)
}

function localImagePath(src: string, cwd: string): string {
  if (src.startsWith('/')) return src
  const parts = `${cwd.replace(/\/+$/, '')}/${src}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return `/${resolved.join('/')}`
}

function pathInsideProject(path: string, projectPath: string): boolean {
  const root = projectPath.replace(/\/+$/, '') || '/'
  return root === '/' || path === root || path.startsWith(`${root}/`)
}

function formatImageSize(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const nextUrl = blob ? URL.createObjectURL(blob) : null
    setUrl(nextUrl)
    return () => {
      if (nextUrl) URL.revokeObjectURL(nextUrl)
    }
  }, [blob])
  return url
}

function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
  const url = useObjectUrl(blob)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!url) return <UnavailableContent kind="Image" reason="loading preview" inline />
  if (failedUrl === url) return <UnavailableContent kind="Image" reason="browser could not decode image" inline />
  return (
    <span className="timeline-content-image" data-timeline-content="image">
      <Zoom zoomImg={{ src: url, alt }} wrapElement="span">
        <img src={url} alt={alt} onError={() => setFailedUrl(url)} />
      </Zoom>
    </span>
  )
}

type MarkdownRenderContext = { codeActions: boolean; contentImages?: ReadonlyMap<string, ContentImage>; localImageContext?: LocalImageContext }
const markdownRenderContext = createContext<MarkdownRenderContext>({ codeActions: true })

/** Anonymous Detail/Share pages inject a resolver that maps a local image src to its token-bound GET endpoint; null = not an anon page. */
export const AnonImageContext = createContext<((rawSrc: string) => string | null) | null>(null)

function MarkdownImage({ src, alt, node: _node, ...props }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const { contentImages, localImageContext } = useContext(markdownRenderContext)
  const anonImageSrc = useContext(AnonImageContext)
  const image = typeof src === 'string' ? contentImages?.get(src) : undefined
  if (image) return <Base64ContentImage data={image.data} mediaType={image.mediaType} alt={alt ?? ''} inline />
  if (typeof src !== 'string') return <UnavailableContent kind="Image" reason="missing source" inline />
  if (isRemoteImageSource(src)) return <img src={src} alt={alt} {...props} />
  if (!isLocalImageSource(src)) return <UnavailableContent kind="Image" reason={anonImageSrc ? 'unavailable' : src} inline />
  if (anonImageSrc) {
    const resolved = anonImageSrc(src)
    return resolved ? <AnonLocalImage url={resolved} alt={alt ?? ''} /> : <UnavailableContent kind="Image" reason="unavailable" inline />
  }
  return localImageContext ? <LocalMarkdownImage src={src} alt={alt ?? ''} context={localImageContext} /> : <UnavailableContent kind="Image" reason={src} inline />
}

/** Anonymous-page local image: loads automatically, or — when the server asks for confirmation (out-of-project / large) —
 * waits for a click. Anonymous pages never show the path, size or failure reason. */
function AnonLocalImage({ url, alt }: { url: string; alt: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'confirmation' | 'unavailable' } | { status: 'loaded'; blob: Blob }>({ status: 'loading' })
  const load = useCallback(
    async (confirmed: boolean, signal?: AbortSignal) => {
      setState({ status: 'loading' })
      try {
        const response = await fetch(confirmed ? `${url}&confirmed=1` : url, { cache: 'no-store', signal })
        if (response.ok) setState({ status: 'loaded', blob: await response.blob() })
        else setState({ status: response.status === 409 && !confirmed ? 'confirmation' : 'unavailable' })
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setState({ status: 'unavailable' })
      }
    },
    [url],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(false, controller.signal)
    return () => controller.abort()
  }, [load])
  if (state.status === 'loaded') return <BlobImage blob={state.blob} alt={alt} />
  if (state.status === 'unavailable') return <UnavailableContent kind="Image" reason="unavailable" inline />
  return (
    <span className="timeline-local-image" data-timeline-content="local-image" data-state={state.status}>
      <button className="timeline-local-image-preview" type="button" disabled={state.status === 'loading'} aria-label={`Load image${alt ? `: ${alt}` : ''}`} onClick={() => void load(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <circle cx="9" cy="9.5" r="1.5" />
          <path d="m5.5 17 4.5-4.5 3 3 2-2 3.5 3.5" />
        </svg>
        {state.status === 'confirmation' ? <span className="timeline-local-image-notice">Click to load</span> : null}
      </button>
    </span>
  )
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
  return <>{children}</>
}

let mermaidLoader: Promise<typeof import('mermaid')['default']> | null = null
let mermaidRenderCount = 0

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', suppressErrorRendering: true })
    return m.default
  })
  return mermaidLoader
}

// Keeps the last settled result (diagram or fallback) while a new `code` renders, so streaming fences don't flash.
function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [result, setResult] = useState<{ svg: string } | 'failed' | null>(null)
  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++mermaidRenderCount}`
    void loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg }) => {
        if (!cancelled) setResult({ svg })
      })
      .catch(() => {
        // A half-streamed fence fails to parse; keep the last diagram instead of flipping back to code.
        if (!cancelled) setResult((previous) => (previous && previous !== 'failed' ? previous : 'failed'))
      })
    return () => {
      cancelled = true
    }
  }, [code])
  if (result === null || result === 'failed') return <>{fallback}</>
  // biome-ignore lint/security/noDangerouslySetInnerHtml: content is untrusted model output; safety relies on mermaid securityLevel 'strict' (DOMPurify-sanitized SVG)
  return <div className="markdown-mermaid" data-timeline-content="mermaid" dangerouslySetInnerHTML={{ __html: result.svg }} />
}

function MarkdownCode({ className, children }: ComponentPropsWithoutRef<'code'>) {
  const { codeActions } = useContext(markdownRenderContext)
  const childList = Children.toArray(children)
  const inline = !className && childList.every((child) => typeof child === 'string' && !child.includes('\n'))
  if (inline) return <code className={className}>{children}</code>
  const highlighted = (
    <HighlightedCode className={className} actions={codeActions}>
      {children}
    </HighlightedCode>
  )
  if (codeLanguage(className) === 'mermaid') return <MermaidBlock code={textFromReactNode(children).replace(/\n$/, '')} fallback={highlighted} />
  return highlighted
}

const markdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: MarkdownPre, code: MarkdownCode }

function LocalMarkdownImage({ src, alt, context }: { src: string; alt: string; context: LocalImageContext }) {
  const pathname = localImageDestinationPathname(src)
  const path = pathname ? localImagePath(pathname, context.cwd) : src
  const lexicallyExternal = !pathname || !pathInsideProject(path, context.projectPath)
  const [confirmation, setConfirmation] = useState<(({ size: number; external: false } | { size: number; external: true; resolvedPath: string }) & { identity: LocalImageConfirmation }) | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const requested = useRef(false)
  const loadingRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)

  useLayoutEffect(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    loadingRef.current = false
    requested.current = false
    setConfirmation(null)
    setBlob(null)
    setError(null)
    setLoading(false)
  }, [context.agentId, context.messageUuid, context.projectPath, context.sessionId, context.cwd, src])

  const load = useCallback(
    async (confirmed = false) => {
      if (loadingRef.current) return
      loadingRef.current = true
      setLoading(true)
      setError(null)
      const controller = new AbortController()
      controllerRef.current = controller
      requested.current = true
      try {
        setBlob(
          await fetchLocalMessageImage(
            context.sessionId,
            context.messageUuid,
            {
              src,
              confirmedExternal: confirmation?.external === true,
              confirmedLarge: confirmed && confirmation !== null,
              ...(confirmation ? { expectedConfirmation: confirmation.identity } : {}),
              ...(context.agentId ? { agentId: context.agentId } : {}),
            },
            controller.signal,
          ),
        )
      } catch (cause) {
        if (cause instanceof LocalImageHttpError && cause.code === 'image_confirmation_required' && typeof cause.size === 'number' && cause.confirmation) {
          if (cause.external === true) {
            if (typeof cause.resolvedPath === 'string') setConfirmation({ size: cause.size, external: true, resolvedPath: cause.resolvedPath, identity: cause.confirmation })
            else setError({ message: cause.message, retryable: true })
          } else setConfirmation({ size: cause.size, external: false, identity: cause.confirmation })
        } else if (cause instanceof LocalImageHttpError && cause.code === 'file_too_large')
          setError({ message: `Image is too large${typeof cause.size === 'number' ? ` (${formatImageSize(cause.size)}; maximum 25 MiB)` : ' (maximum 25 MiB)'}`, retryable: false })
        else if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError({ message: cause instanceof Error ? cause.message : String(cause), retryable: true })
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [confirmation, context.agentId, context.messageUuid, context.sessionId, src],
  )

  useEffect(() => {
    if (!lexicallyExternal && !requested.current) void load()
    return () => controllerRef.current?.abort()
  }, [lexicallyExternal, load])
  if (blob) return <BlobImage blob={blob} alt={alt} />
  const state = loading ? 'loading' : error ? 'error' : confirmation ? 'confirmation' : lexicallyExternal ? 'external' : 'pending'
  const action = error ? 'Retry loading' : confirmation ? 'Confirm loading' : 'Load'
  const displayPath = confirmation?.external ? confirmation.resolvedPath : path
  const preview = (
    <>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <circle cx="9" cy="9.5" r="1.5" />
        <path d="m5.5 17 4.5-4.5 3 3 2-2 3.5 3.5" />
      </svg>
      {confirmation ? <span className="timeline-local-image-notice">{formatImageSize(confirmation.size)} · Confirm to load</span> : null}
      {error ? <span role="alert">{error.message}</span> : null}
    </>
  )
  return (
    <span className="timeline-local-image" data-timeline-content="local-image" data-state={state}>
      {error && !error.retryable ? (
        <span className="timeline-local-image-preview">{preview}</span>
      ) : (
        <button className="timeline-local-image-preview" type="button" disabled={loading} aria-label={`${action} image: ${alt || displayPath}`} onClick={() => void load(true)}>
          {preview}
        </button>
      )}
      <span className="timeline-local-image-path">{displayPath}</span>
    </span>
  )
}

export const MarkdownContent = memo(function MarkdownContent({
  value,
  codeActions = true,
  contentImages,
  localImageContext,
}: {
  value: string
  codeActions?: boolean
  contentImages?: ReadonlyMap<string, ContentImage>
  localImageContext?: LocalImageContext
}) {
  return (
    <markdownRenderContext.Provider value={{ codeActions, contentImages, localImageContext }}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]} urlTransform={(url, key, node) => (key === 'src' && node.tagName === 'img' ? url : defaultUrlTransform(url))}>
        {value}
      </ReactMarkdown>
    </markdownRenderContext.Provider>
  )
})

export const TimelineMarkdownContent = memo(function TimelineMarkdownContent({
  value,
  codeActions = true,
  contentImages,
  localImageContext,
}: {
  value: string
  codeActions?: boolean
  contentImages?: ReadonlyMap<string, ContentImage>
  localImageContext?: LocalImageContext
}) {
  return (
    <div className="debug-markdown" data-timeline-content="markdown">
      <MarkdownContent value={unwrapMarkdownPayloadFences(value)} codeActions={codeActions} contentImages={contentImages} localImageContext={localImageContext} />
    </div>
  )
})

export function ToolMarkdownContent({ value }: { value: string }) {
  return <TimelineMarkdownContent value={value} codeActions={false} />
}

export async function writeClipboard(value: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // Fall back for HTTP origins or denied clipboard permissions.
  }

  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy failed')
}

export function TimelineTimestamp({
  value,
  timeZone,
  className = '',
  cwd,
  sessionId,
  sessionLabel,
  entrypoint,
  copyText,
  copyLabel,
  onViewRaw,
  viewRawLabel,
  onViewSubagents,
  subagentCount = 0,
  midActions,
  extraActions,
  source,
}: {
  value?: number
  timeZone: string
  className?: string
  cwd?: string | null
  sessionId?: string | null
  sessionLabel?: string
  entrypoint?: string
  copyText?: string | null
  copyLabel?: string
  onViewRaw?: () => void
  viewRawLabel?: string
  onViewSubagents?: () => void
  subagentCount?: number
  midActions?: ReactNode
  extraActions?: ReactNode
  source?: TimelineSource
}) {
  const [copyStatus, setCopyStatus] = useState<{ target: 'cwd' | 'session' | 'content'; label: 'Copied' | 'Copy failed' } | null>(null)
  const clearStatusRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = formatTimestamp(value, timeZone)

  useEffect(
    () => () => {
      if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
    },
    [],
  )

  if ((!label || !value) && !cwd && !sessionId && !copyText && !onViewRaw && !(onViewSubagents && subagentCount > 0) && !midActions && !extraActions && !source)
    return (
      <span className={[timelineMessageClass.timestamp, className, 'invisible'].filter(Boolean).join(' ')} aria-hidden="true">
        &nbsp;
      </span>
    )

  function showStatus(target: 'cwd' | 'session' | 'content', label: 'Copied' | 'Copy failed') {
    if (clearStatusRef.current) clearTimeout(clearStatusRef.current)
    setCopyStatus({ target, label })
    clearStatusRef.current = setTimeout(() => setCopyStatus(null), 1600)
  }

  const copiedIcon = (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
  const copyIcon =
    copyStatus?.target === 'content' && copyStatus.label === 'Copied' ? (
      copiedIcon
    ) : (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
    )

  async function handleCopy(target: 'cwd' | 'session' | 'content', value: string) {
    try {
      await writeClipboard(value)
      showStatus(target, 'Copied')
    } catch {
      showStatus(target, 'Copy failed')
    }
  }

  const actionClass = 'timeline-action-button inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit hover:bg-[var(--tl-surface-soft)]'
  const actionIconClass = 'h-3.5 w-3.5 max-sm:h-4 max-sm:w-4'
  const sessionTooltip = sessionId ? `${sessionLabel ?? `${(entrypoint || 'cli').toUpperCase()} Session`}:\n${sessionId}` : null
  const hasActions = Boolean(cwd || sessionId || copyText || onViewRaw || (onViewSubagents && subagentCount > 0) || midActions || extraActions)
  const itemClass = [timelineMessageClass.timestamp, className].filter(Boolean).join(' ')
  const actions = hasActions ? (
    <span className={itemClass}>
      {cwd ? (
        <button
          className={actionClass}
          style={{ borderRadius: 5 }}
          type="button"
          aria-label="Copy working directory"
          data-tooltip={copyStatus?.target === 'cwd' ? copyStatus.label : `CWD:\n${cwd}`}
          onClick={() => void handleCopy('cwd', cwd)}
        >
          {copyStatus?.target === 'cwd' && copyStatus.label === 'Copied' ? (
            copiedIcon
          ) : (
            <svg
              viewBox="64 32 560 560"
              className={actionIconClass}
              focusable="false"
              data-icon="FolderOutlined"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M88 448V160c0-22.1 17.9-40 40-40h138.7c8.7 0 17.1 2.8 24 8l38.4 28.8c9.7 7.3 21.5 11.2 33.6 11.2H480c22.1 0 40 17.9 40 40v64" strokeWidth="32" />
              <path d="M128 488h380.9c10.5 0 19.8-6.8 22.9-16.9l50-160c4.8-15.5-6.7-31.1-22.9-31.1H179.5c-10.5 0-19.8 6.8-22.9 16.9L106.6 456c-4.8 15.5 6.7 32 21.4 32Z" strokeWidth="32" />
            </svg>
          )}
        </button>
      ) : null}
      {sessionId ? (
        <button
          className={actionClass}
          style={{ borderRadius: 5 }}
          type="button"
          aria-label={`Copy ${sessionLabel ?? 'session ID'}`}
          data-tooltip={copyStatus?.target === 'session' ? copyStatus.label : sessionTooltip}
          onClick={() => void handleCopy('session', sessionId)}
        >
          {copyStatus?.target === 'session' && copyStatus.label === 'Copied' ? (
            copiedIcon
          ) : !entrypoint || entrypoint === 'cli' ? (
            <svg
              data-icon="terminal"
              viewBox="0 0 24 24"
              className={actionIconClass}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="m7 9 3 3-3 3m5 0h5" />
            </svg>
          ) : (
            <svg data-icon="browser" viewBox="0 0 24 24" className={`${actionIconClass} opacity-80`} fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.9" />
              <path d="m16.25 7.75-2.4 6.1-6.1 2.4 2.4-6.1 6.1-2.4Z" fill="currentColor" />
            </svg>
          )}
        </button>
      ) : null}
      {onViewSubagents && subagentCount > 0 ? (
        <button className={actionClass} style={{ borderRadius: 5 }} type="button" aria-label="View subagents" data-tooltip={`Subagents (${subagentCount})`} onClick={onViewSubagents}>
          <svg viewBox="0 0 24 24" className={actionIconClass} fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="5" r="2.25" />
            <circle cx="5" cy="19" r="2.25" />
            <circle cx="19" cy="19" r="2.25" />
            <path d="M12 7.25V12m0 0H6.5a1.5 1.5 0 0 0-1.5 1.5v3.25M12 12h5.5a1.5 1.5 0 0 1 1.5 1.5v3.25" />
          </svg>
        </button>
      ) : null}
      {midActions}
      {onViewRaw ? (
        <button className={actionClass} style={{ borderRadius: 5 }} type="button" aria-label={viewRawLabel} data-tooltip="Trace" onClick={onViewRaw}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="19" r="3" />
            <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
            <circle cx="18" cy="5" r="3" />
          </svg>
        </button>
      ) : null}
      {copyText ? (
        <button
          className={actionClass}
          style={{ borderRadius: 5 }}
          type="button"
          aria-label={copyLabel}
          data-tooltip={copyStatus?.target === 'content' ? copyStatus.label : 'Copy'}
          onClick={() => void handleCopy('content', copyText)}
        >
          {copyIcon}
        </button>
      ) : null}
      {extraActions}
      <span className="sr-only" aria-live="polite">
        {copyStatus?.label}
      </span>
    </span>
  ) : null

  return (
    <>
      {label && value ? (
        <span className={itemClass}>
          <time dateTime={new Date(value).toISOString()}>{label}</time>
        </span>
      ) : null}
      {actions}
      {source ? <span className={itemClass}>{source}</span> : null}
    </>
  )
}

export function blockTitle(kind: string): string {
  if (kind === 'user.message') return 'User'
  if (kind === 'user.image') return 'Image'
  if (kind === 'user.file') return 'File'
  if (kind === 'assistant.text' || kind === 'assistant.message') return 'Assistant'
  if (kind === 'assistant.task_notification') return 'Task notification'
  if (kind === 'assistant.tool_use') return 'Tool use'
  if (kind === 'tool.result') return 'Tool result'
  if (kind === 'error') return 'Error'
  if (kind.startsWith('stream.')) return 'Stream event'
  if (kind.startsWith('system.')) return 'System event'
  if (kind.startsWith('raw.')) return 'Raw event'
  return kind
}

/** When true, timeline disclosures (tool / thinking / file) render as static, non-expandable headers (e.g. public Share pages). */
export const CollapsedDisclosureContext = createContext(false)

export function DeferredDetails({
  className,
  ariaLabel,
  summary,
  renderBody,
  defaultOpen = false,
}: {
  className: string
  ariaLabel?: string
  summary: ReactNode
  renderBody: () => ReactNode
  defaultOpen?: boolean
}) {
  const collapsed = useContext(CollapsedDisclosureContext)
  const [open, setOpen] = useState(defaultOpen)
  const [hasOpened, setHasOpened] = useState(defaultOpen)
  useLayoutEffect(() => {
    if (!defaultOpen) return
    setOpen(true)
    setHasOpened(true)
  }, [defaultOpen])
  // Static header: show the summary only, with no expand affordance or body.
  if (collapsed) {
    return (
      <details className={className} aria-label={ariaLabel} data-collapsed="true">
        {summary}
      </details>
    )
  }
  return (
    <details
      className={className}
      aria-label={ariaLabel}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        if (event.currentTarget.open) setHasOpened(true)
      }}
    >
      {summary}
      {hasOpened ? renderBody() : null}
    </details>
  )
}

export const toolTimelineClass = {
  state: 'shrink-0 rounded-full bg-[var(--tl-surface-soft)] px-1.5 py-px text-[var(--text-xs)] font-extrabold uppercase tracking-[0.04em] text-[var(--tl-muted)]',
  stateError: 'bg-[var(--tl-danger-soft)] text-[var(--tl-danger)]',
  section: 'grid min-w-0 gap-1 px-3 py-2 text-[12px] leading-[1.6] text-[var(--tl-ink)] [&+&]:border-t [&+&]:border-[var(--tl-border-soft)]',
  sectionLabel: 'text-[var(--text-xs)] font-extrabold uppercase tracking-[0.08em] text-[var(--tl-muted)]',
  inputCode: 'tool-scrollbar m-0 max-h-[150px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono',
  inputKv: 'tool-scrollbar m-0 grid max-h-[150px] grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 overflow-auto px-3 py-2 text-[12px] leading-[1.6]',
  inputKey: 'font-mono text-[var(--tl-muted)]',
  resultCode: 'tool-scrollbar m-0 max-h-[150px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono',
  outputText: 'tool-scrollbar m-0 max-h-[150px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit]',
  result: 'tool-output min-w-0 max-w-full',
  resultError: 'border-[rgb(166_83_75_/_20%)] bg-[var(--tl-danger-soft)] text-[var(--tl-danger)]',
  pending: 'text-[var(--text-xs)] italic text-[var(--text-secondary)]',
}

export const timelineMessageClass = {
  rowUser: 'group flex min-w-0 items-end justify-end gap-[9px]',
  localCommandRow:
    'flex min-w-0 items-center justify-center gap-3 before:h-px before:w-16 before:max-w-[18vw] before:bg-[var(--tl-border-soft)] after:h-px after:w-16 after:max-w-[18vw] after:bg-[var(--tl-border-soft)]',
  localCommand: 'max-w-full truncate text-[13px] leading-[1.6] text-[color-mix(in_srgb,var(--tl-ink)_38%,var(--tl-muted))]',
  userStack: 'grid max-w-[min(76%,720px)] justify-items-end gap-1 max-[720px]:max-w-full max-[560px]:max-w-[min(86%,720px)]',
  userBubble:
    'max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[var(--radius-lg)] border border-[var(--tl-user-border)] bg-[var(--tl-user-soft)] px-3.5 py-2.5 text-[var(--text-base)] leading-[1.6] text-[var(--tl-ink)] shadow-[var(--tl-shadow-soft)]',
  timestamp:
    'inline-flex items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[13px] leading-[1.6] text-[var(--tl-muted)] opacity-0 transition-opacity duration-150 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.4]',
  timestampUser: 'flex-wrap justify-end pr-1 text-right group-hover:opacity-100 focus-within:opacity-100',
  timestampAssistant: 'block group-hover:opacity-100 focus-within:opacity-100',
  assistantFrame: 'group w-full max-w-none justify-self-stretch [&_.timeline-assistant-text]:px-1 [&_.timeline-assistant-text]:py-0.5 [&_.timeline-block]:shadow-none',
  assistantFrameBody: 'grid min-w-0 gap-4',
}

function primitiveSummary(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return shortText(String(value), 72)
  return null
}

function keyValueSummary(value: unknown): string | null {
  if (!isRecord(value)) return primitiveSummary(value)
  const priorityKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']
  for (const key of priorityKeys) {
    const summary = primitiveSummary(value[key])
    if (summary) return `${key}: ${summary}`
  }
  for (const [key, field] of Object.entries(value)) {
    const summary = primitiveSummary(field)
    if (summary) return `${key}: ${summary}`
  }
  return shortText(safeDataPreview(value, 0), 72)
}

export function toolInputSummary(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return shortText(safeDataPreview(value, 0), 72)
  return keyValueSummary(value)
}

export function TimelineKvContent({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className={toolTimelineClass.inputKv} data-timeline-content="kv">
      {Object.entries(value).map(([key, field]) => (
        <Fragment key={key}>
          <dt className={toolTimelineClass.inputKey}>{key}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{typeof field === 'string' ? field : (primitiveSummary(field) ?? safeDataPreview(field, 0))}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

const OTHER_OPTION = '\0other'

export function TimelineQuestionFormContent({
  questions,
  enabled = false,
  submitting = false,
  onSubmit,
  onCancel,
}: {
  questions: unknown
  enabled?: boolean
  submitting?: boolean
  onSubmit?: (answers: Record<string, string>, annotations: Record<string, { preview?: string; notes?: string }>) => void
  onCancel?: () => void
}) {
  const items = Array.isArray(questions) ? questions : []
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState<Record<number, string>>({})
  const complete =
    items.length > 0 &&
    items.every((_question, index) => {
      const selected = answers[index] ?? []
      return selected.length > 0 && (!selected.includes(OTHER_OPTION) || Boolean(otherText[index]?.trim()))
    })
  return (
    <form
      className="timeline-question-form"
      data-timeline-content="question_form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!enabled || submitting || !complete) return
        const entries = items.map((question, index) => {
          const value = isRecord(question) ? question : {}
          const key = typeof value.question === 'string' ? value.question : `Question ${index + 1}`
          return [key, (answers[index] ?? []).map((answer) => (answer === OTHER_OPTION ? otherText[index]!.trim() : answer)).join(', ')] as const
        })
        const annotations = Object.fromEntries(
          items.flatMap((question, index) => {
            const value = isRecord(question) ? question : {}
            const selected = answers[index] ?? []
            const preview =
              selected.length === 1 && isRecord((Array.isArray(value.options) ? value.options : []).find((option) => isRecord(option) && option.label === selected[0]))
                ? (value.options as Array<Record<string, unknown>>).find((option) => option.label === selected[0])?.preview
                : undefined
            const note = notes[index]?.trim()
            return typeof value.question === 'string' && (typeof preview === 'string' || note)
              ? [[value.question, { ...(typeof preview === 'string' ? { preview } : {}), ...(note ? { notes: note } : {}) }]]
              : []
          }),
        )
        onSubmit?.(Object.fromEntries(entries), annotations)
      }}
    >
      {items.map((question, questionIndex) => {
        const value = isRecord(question) ? question : {}
        const options = Array.isArray(value.options) ? value.options : []
        const multi = value.multiSelect === true
        const preview = !multi && options.some((option) => isRecord(option) && typeof option.preview === 'string')
        const selected = answers[questionIndex] ?? []
        const choose = (label: string, checked: boolean) => {
          setAnswers((current) => ({
            ...current,
            [questionIndex]: multi ? (checked ? [...(current[questionIndex] ?? []), label] : (current[questionIndex] ?? []).filter((item) => item !== label)) : [label],
          }))
          if (label === OTHER_OPTION ? !checked : !multi && selected.includes(OTHER_OPTION)) setOtherText((current) => ({ ...current, [questionIndex]: '' }))
        }
        return (
          <fieldset disabled={!enabled || submitting} key={questionIndex}>
            <legend>
              <span>{questionIndex + 1})</span>
              <strong>{typeof value.header === 'string' ? value.header : `Question ${questionIndex + 1}`}</strong>
              {typeof value.question === 'string' ? <span>{value.question}</span> : null}
            </legend>
            <div className="timeline-question-options">
              {[...options, ...(preview ? [] : [{ label: 'Other', value: OTHER_OPTION }])].map((option, optionIndex) => {
                const item = isRecord(option) ? option : {}
                const label = typeof item.label === 'string' ? item.label : `Option ${optionIndex + 1}`
                const answer = typeof item.value === 'string' ? item.value : label
                return (
                  <label className="timeline-question-option" key={optionIndex}>
                    <input type={multi ? 'checkbox' : 'radio'} name={`question-${questionIndex}`} checked={selected.includes(answer)} onChange={(event) => choose(answer, event.target.checked)} />
                    <span>
                      {label}
                      {typeof item.description === 'string' ? <small>{item.description}</small> : null}
                    </span>
                    {typeof item.preview === 'string' ? <pre>{item.preview}</pre> : null}
                    {answer === OTHER_OPTION && selected.includes(OTHER_OPTION) ? (
                      <input
                        className="timeline-question-other"
                        type="text"
                        aria-label={`Other answer for ${typeof value.question === 'string' ? value.question : `question ${questionIndex + 1}`}`}
                        value={otherText[questionIndex] ?? ''}
                        onChange={(event) => setOtherText((current) => ({ ...current, [questionIndex]: event.target.value }))}
                      />
                    ) : null}
                  </label>
                )
              })}
            </div>
            {preview ? (
              <input
                className="timeline-question-other timeline-question-notes"
                type="text"
                aria-label={`Notes for ${typeof value.question === 'string' ? value.question : `question ${questionIndex + 1}`}`}
                placeholder="Add notes on this design…"
                value={notes[questionIndex] ?? ''}
                onChange={(event) => setNotes((current) => ({ ...current, [questionIndex]: event.target.value }))}
              />
            ) : null}
          </fieldset>
        )
      })}
      {enabled ? (
        <div className="timeline-question-actions">
          <button type="submit" disabled={submitting || !complete}>
            Submit
          </button>
          <button type="button" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
    </form>
  )
}

export function TimelineQuestionAnswersContent({ answers, annotations }: { answers: unknown; annotations?: unknown }) {
  const answerRecord = isRecord(answers) ? answers : {}
  const annotationRecord = isRecord(annotations) ? annotations : {}
  return (
    <dl className="m-0 grid gap-y-2 px-3 py-2 text-[12px] leading-[1.6]" data-timeline-content="question_answers">
      {Object.entries(answerRecord).map(([question, answer], answerIndex) => (
        <Fragment key={question}>
          <dt className="min-w-0 font-medium text-[var(--tl-muted)] [overflow-wrap:anywhere]">
            <span className="font-mono">{answerIndex + 1}) </span>
            {question}
          </dt>
          <dd className="m-0 text-[var(--tl-ink)] [overflow-wrap:anywhere]">{typeof answer === 'string' ? answer : safeDataPreview(answer, 0)}</dd>
          {isRecord(annotationRecord[question]) && typeof annotationRecord[question].notes === 'string' ? (
            <dd className="m-0 text-[var(--tl-muted)] [overflow-wrap:anywhere]">{annotationRecord[question].notes}</dd>
          ) : null}
          {isRecord(annotationRecord[question]) && typeof annotationRecord[question].preview === 'string' ? (
            <pre className="m-0 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--tl-code-bg)] px-2 py-1 font-mono text-[var(--tl-ink)]">{annotationRecord[question].preview}</pre>
          ) : null}
        </Fragment>
      ))}
    </dl>
  )
}

export function ToolInputValue({ value }: { value: unknown }) {
  if (!isRecord(value) || Array.isArray(value))
    return (
      <pre className={toolTimelineClass.inputCode} data-timeline-content="input">
        {safeDataPreview(value)}
      </pre>
    )
  return <TimelineKvContent value={value} />
}

export function toolResultMarkdownText(value: unknown): string | null {
  if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') return value.text
  if (Array.isArray(value) && value.every((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')) return value.map((item) => item.text).join('\n')
  return null
}

export const decodeContentImage = decodeComposerImage

function safeHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

export function contentBlockIsRenderable(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some(contentBlockIsRenderable)
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string' && value.text.trim().length > 0
  if (value.type !== 'image') return true
  if (!isRecord(value.source)) return false
  if (value.source.type === 'base64') return !('error' in decodeContentImage(value.source.data, value.source.media_type))
  if (value.source.type === 'url') return safeHttpUrl(value.source.url) !== null
  return value.source.type === 'file' && typeof value.source.file_id === 'string' && value.source.file_id.length > 0
}

function UnavailableContent({ kind, reason, inline = false }: { kind: string; reason: string; inline?: boolean }) {
  const Element = inline ? 'span' : 'div'
  return (
    <Element className="timeline-content-unavailable" data-timeline-content="unavailable">
      Preview unavailable · {kind}: {reason}
    </Element>
  )
}

export function Base64ContentImage({ data, mediaType, alt = 'Content image', inline = false }: { data: unknown; mediaType: unknown; alt?: string; inline?: boolean }) {
  const decoded = useMemo(() => decodeContentImage(data, mediaType), [data, mediaType])
  const blob = useMemo(() => ('error' in decoded ? null : new Blob([decoded.bytes.buffer as ArrayBuffer], { type: decoded.mediaType })), [decoded])
  const url = useObjectUrl(blob)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if ('error' in decoded) return <UnavailableContent kind="Image" reason={decoded.error} inline={inline} />
  if (!url) return <UnavailableContent kind="Image" reason="loading preview" inline={inline} />
  if (failedUrl === url) return <UnavailableContent kind="Image" reason="browser could not decode image" inline={inline} />
  const Element = inline ? 'span' : 'div'
  return (
    <Element className="timeline-content-image" data-timeline-content="image">
      <Zoom zoomImg={{ src: url, alt }} wrapElement={inline ? 'span' : 'div'}>
        <img src={url} alt={alt} onError={() => setFailedUrl(url)} />
      </Zoom>
    </Element>
  )
}

function ImageContentBlock({ block }: { block: Record<string, unknown> }) {
  if (!isRecord(block.source)) return <UnavailableContent kind="Image" reason="missing source" />
  if (block.source.type === 'base64') return <Base64ContentImage data={block.source.data} mediaType={block.source.media_type} />
  if (block.source.type === 'url') {
    const url = safeHttpUrl(block.source.url)
    return url ? (
      <div className="timeline-content-metadata" data-timeline-content="metadata">
        Image link:{' '}
        <a href={url.href} target="_blank" rel="noreferrer">
          {url.host}
        </a>
      </div>
    ) : (
      <UnavailableContent kind="Image" reason="unsafe URL" />
    )
  }
  if (block.source.type === 'file')
    return typeof block.source.file_id === 'string' && block.source.file_id.length > 0 ? (
      <div className="timeline-content-metadata" data-timeline-content="metadata">
        Image file: {block.source.file_id}
      </div>
    ) : (
      <UnavailableContent kind="Image" reason="missing file_id" />
    )
  return <UnavailableContent kind="Image" reason={`unsupported source${typeof block.source.type === 'string' ? ` (${block.source.type})` : ''}`} />
}

function DocumentContentBlock({ block, code }: { block: Record<string, unknown>; code: boolean }) {
  const source = block.source
  let content: ReactNode
  if (!isRecord(source)) content = <UnavailableContent kind="Document" reason="missing source" />
  else if (source.type === 'text') content = <ContentBlockValue value={source.data ?? source.text} code={code} />
  else if (source.type === 'content') content = <ContentBlockValue value={source.content} code={code} />
  else if (source.type === 'base64') content = <UnavailableContent kind="Document" reason={`${typeof source.media_type === 'string' ? source.media_type : 'base64'} (${source.type})`} />
  else if (source.type === 'url') {
    const url = safeHttpUrl(source.url)
    content = url ? (
      <div className="timeline-content-unavailable" data-timeline-content="unavailable">
        Document unavailable: remote{' '}
        <a href={url.href} target="_blank" rel="noreferrer">
          {url.host}
        </a>
      </div>
    ) : (
      <UnavailableContent kind="Document" reason="unsafe URL" />
    )
  } else if (source.type === 'file') content = <UnavailableContent kind="Document" reason={typeof source.file_id === 'string' ? `file ${source.file_id}` : 'missing file_id'} />
  else content = <UnavailableContent kind="Document" reason={`unsupported source${typeof source.type === 'string' ? ` (${source.type})` : ''}`} />
  return (
    <section className="timeline-content-search-result" data-timeline-content="document">
      {typeof block.title === 'string' && block.title ? <strong>{block.title}</strong> : null}
      {typeof block.context === 'string' && block.context ? <ContentBlockValue value={block.context} code={code} /> : null}
      {content}
    </section>
  )
}

function SearchResultContentBlock({ block, code }: { block: Record<string, unknown>; code: boolean }) {
  const source = safeHttpUrl(block.source)
  return (
    <section className="timeline-content-search-result" data-timeline-content="search_result">
      {typeof block.title === 'string' ? <strong>{block.title}</strong> : null}
      {source ? (
        <a href={source.href} target="_blank" rel="noreferrer">
          {source.host}
        </a>
      ) : typeof block.source === 'string' ? (
        <span>{shortText(block.source, 160)}</span>
      ) : null}
      {'content' in block ? <ContentBlockValue value={block.content} code={code} /> : null}
    </section>
  )
}

export function ContentBlockValue({ value, code = false }: { value: unknown; code?: boolean }): ReactNode {
  if (typeof value === 'string') return code ? <TimelineCodeContent value={value} /> : <TimelineTextContent value={value} />
  if (Array.isArray(value)) return value.map((item, index) => <ContentBlockValue value={item} code={code} key={index} />)
  if (!isRecord(value))
    return (
      <pre className={toolTimelineClass.resultCode} data-timeline-content="code">
        {safeDataPreview(value)}
      </pre>
    )
  if (value.type === 'text')
    return typeof value.text === 'string' ? code ? <TimelineCodeContent value={value.text} /> : <ToolMarkdownContent value={value.text} /> : <UnavailableContent kind="Text" reason="missing text" />
  if (value.type === 'image') return <ImageContentBlock block={value} />
  if (value.type === 'document') return <DocumentContentBlock block={value} code={code} />
  if (value.type === 'file')
    return (
      <div className="timeline-content-metadata" data-timeline-content="metadata">
        File:{' '}
        {[value.name, value.filename, value.media_type, value.mime_type, value.file_id].filter((field): field is string => typeof field === 'string' && field.length > 0).join(' · ') ||
          'metadata unavailable'}
      </div>
    )
  if (value.type === 'search_result') return <SearchResultContentBlock block={value} code={code} />
  if (value.type === 'tool_reference')
    return (
      <div className="timeline-content-metadata" data-timeline-content="metadata">
        Tool: {typeof value.tool_name === 'string' ? value.tool_name : 'unknown'}
      </div>
    )
  if (typeof value.type === 'string') return <UnavailableContent kind="Content block" reason={`unsupported type (${value.type})`} />
  return (
    <pre className={toolTimelineClass.resultCode} data-timeline-content="code">
      {safeDataPreview(value)}
    </pre>
  )
}

export function ToolResultValue({ value, code = false }: { value: unknown; code?: boolean }) {
  return <ContentBlockValue value={value} code={code} />
}

function patchLineCounts(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
  return {
    added: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length, 0),
  }
}

type FileDiffRow = { key: string; lineNumber: number | null; marker: '+' | '-' | ''; text: string; kind: 'add' | 'remove' | 'context' | 'meta'; changedRange?: [number, number] }

type HighlightToken = { content: string; color?: string; fontStyle?: number }

export function timelineDiffCopyValue(hunks: StructuredPatchHunk[]): string {
  return patchRows(hunks)
    .map((row) => `${row.marker}${row.text}`)
    .join('\n')
}

const fileLanguageByExtension: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'csv',
  cxx: 'cpp',
  diff: 'diff',
  env: 'dotenv',
  go: 'go',
  graphql: 'graphql',
  hcl: 'hcl',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mk: 'make',
  mjs: 'js',
  mm: 'objective-c',
  php: 'php',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  proto: 'proto',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'sass',
  scala: 'scala',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  tf: 'terraform',
  tfvars: 'terraform',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

export function fileLanguage(filePath: string | null): string | null {
  const name = filePath?.split('/').at(-1)?.toLowerCase()
  if (!name) return null
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile' || name === 'gnumakefile') return 'make'
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv'
  const ext = name.match(/\.([^.]+)$/)?.[1]
  return ext ? (fileLanguageByExtension[ext] ?? null) : null
}

function diffRange(parts: Array<{ value: string; added?: boolean; removed?: boolean }>, side: 'add' | 'remove'): [number, number] | undefined {
  let offset = 0
  let start: number | null = null
  let end: number | null = null
  for (const part of parts) {
    const shown = side === 'add' ? !part.removed : !part.added
    if (shown && (side === 'add' ? part.added : part.removed)) {
      start ??= offset
      end = offset + part.value.length
    }
    if (shown) offset += part.value.length
  }
  return start === null || end === null || start === end ? undefined : [start, end]
}

function markDiffRows(rows: FileDiffRow[]): FileDiffRow[] {
  const next = rows.map((row) => ({ ...row }))
  for (let index = 0; index < next.length; ) {
    if (next[index]?.kind !== 'remove') {
      index += 1
      continue
    }
    const removeStart = index
    while (next[index]?.kind === 'remove') index += 1
    const addStart = index
    while (next[index]?.kind === 'add') index += 1
    for (let pair = 0; pair < Math.min(addStart - removeStart, index - addStart); pair += 1) {
      const remove = next[removeStart + pair]!
      const add = next[addStart + pair]!
      const parts = diffWordsWithSpace(remove.text, add.text)
      remove.changedRange = diffRange(parts, 'remove')
      add.changedRange = diffRange(parts, 'add')
    }
  }
  return next
}

function patchRows(hunks: StructuredPatchHunk[]): FileDiffRow[] {
  return markDiffRows(
    hunks.flatMap((hunk, hunkIndex) => {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      const rows: FileDiffRow[] = hunkIndex > 0 ? [{ key: `gap:${hunkIndex}`, lineNumber: null, marker: '', text: '...', kind: 'meta' }] : []
      for (const [lineIndex, line] of hunk.lines.entries()) {
        const prefix = line[0]
        if (line === '\\ No newline at end of file') continue
        if (prefix === '+') rows.push({ key: `${hunkIndex}:${lineIndex}`, lineNumber: newLine++, marker: '+', text: line.slice(1), kind: 'add' })
        else if (prefix === '-') rows.push({ key: `${hunkIndex}:${lineIndex}`, lineNumber: oldLine++, marker: '-', text: line.slice(1), kind: 'remove' })
        else {
          rows.push({ key: `${hunkIndex}:${lineIndex}`, lineNumber: newLine++, marker: '', text: prefix === ' ' ? line.slice(1) : line, kind: 'context' })
          oldLine += 1
        }
      }
      return rows
    }),
  )
}

const fileDiffTokenCache = new Map<string, HighlightToken[][]>()

function tokenStyle(token: HighlightToken): React.CSSProperties | undefined {
  return token.color ? { color: token.color } : undefined
}

function tokenParts(row: FileDiffRow, tokens: HighlightToken[] | undefined): Array<HighlightToken & { changed?: boolean }> {
  const source = tokens ?? [{ content: row.text }]
  const range = row.changedRange
  if (!range) return source.map((token) => ({ ...token, changed: false }))
  let offset = 0
  return source.flatMap((token) => {
    const parts = []
    let start = 0
    while (start < token.content.length) {
      const changed = offset + start >= range[0] && offset + start < range[1]
      let end = start + 1
      while (end < token.content.length && (offset + end >= range[0] && offset + end < range[1]) === changed) end += 1
      parts.push({ ...token, content: token.content.slice(start, end), changed })
      start = end
    }
    offset += token.content.length
    return parts
  })
}

export function TimelineDiffContent({
  hunks,
  filePath,
  wrapped: controlledWrapped,
  onWrappedChange,
  actions = true,
}: {
  hunks: StructuredPatchHunk[]
  filePath: string | null
  wrapped?: boolean
  onWrappedChange?: (wrapped: boolean) => void
  actions?: boolean
}) {
  const rows = patchRows(hunks)
  const code = rows.map((row) => row.text).join('\n')
  const copyText = rows.map((row) => `${row.marker}${row.text}`).join('\n')
  const displayLang = fileLanguage(filePath) ?? guessCodeLanguage(code)
  const lang = resolveHighlightLanguage(displayLang)
  const cacheKey = lang ? `${lang}\0${code}` : null
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(() => (cacheKey ? (fileDiffTokenCache.get(cacheKey) ?? null) : null))
  const [internalWrapped, setInternalWrapped] = useState(false)
  const wrapped = controlledWrapped ?? internalWrapped

  useEffect(() => {
    if (!cacheKey || !lang) {
      setTokens(null)
      return
    }
    const cached = fileDiffTokenCache.get(cacheKey)
    if (cached) {
      setTokens(cached)
      return
    }
    setTokens(null)
    let cancelled = false
    void tokenizeCode(code, lang)
      .then((value) => {
        if (!value) return
        const next = value.tokens as HighlightToken[][]
        fileDiffTokenCache.set(cacheKey, next)
        if (fileDiffTokenCache.size > 100) fileDiffTokenCache.delete(fileDiffTokenCache.keys().next().value!)
        if (!cancelled) setTokens(next)
      })
      .catch(() => {
        if (!cancelled) setTokens(null)
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, code, lang])

  return (
    <div className="markdown-code-block timeline-file-diff-code" data-timeline-content="diff" data-wrap={wrapped ? 'true' : 'false'}>
      {actions ? (
        <TimelineCodeActions language={displayLang} wrapped={wrapped} copyValue={copyText} onToggleWrap={() => (onWrappedChange ? onWrappedChange(!wrapped) : setInternalWrapped((value) => !value))} />
      ) : null}
      <div className="shiki-code">
        <pre className="shiki github-light" style={{ backgroundColor: 'var(--surface-raised)', color: '#24292e' }} tabIndex={0}>
          <code>
            {rows.map((row, rowIndex) => (
              <span className={`line timeline-file-diff-line timeline-file-diff-line-${row.kind}`} key={row.key}>
                <span className="timeline-file-diff-number">{row.lineNumber ?? ''}</span>
                <span className="timeline-file-diff-marker">{row.marker}</span>
                <span>
                  {tokenParts(row, row.kind === 'meta' ? undefined : tokens?.[rowIndex]).map((token, index) => (
                    <span className={token.changed ? 'timeline-file-diff-delta' : undefined} style={tokenStyle(token)} key={index}>
                      {token.content}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}

export function relativeFilePath(filePath: string | null, cwd: unknown): string | null {
  if (!filePath || typeof cwd !== 'string' || !filePath.startsWith(`${cwd.replace(/\/$/, '')}/`)) return filePath
  return filePath.slice(cwd.replace(/\/$/, '').length + 1)
}

export function FileToolResultValue({ block, fileMutation }: { block: TimelineBlock; fileMutation: FileMutationResult }) {
  const displayPath = relativeFilePath(fileMutation.filePath, fileMutation.cwd)
  const title = fileMutation.type === 'create' ? 'Create' : fileMutation.type === 'overwrite' ? 'Overwrite' : 'Update'
  const counts = fileMutation.type === 'create' ? { added: contentLineCount(fileMutation.content), removed: 0 } : patchLineCounts(fileMutation.hunks)
  const countItems = [
    counts.added > 0 || fileMutation.type === 'create' ? { kind: 'add' as const, value: `+${counts.added}` } : null,
    counts.removed > 0 ? { kind: 'remove' as const, value: `-${counts.removed}` } : null,
  ].filter((item): item is { kind: 'add' | 'remove'; value: string } => item !== null)
  const changes = countItems.map((item) => item.value).join(' ') || 'No textual changes'
  const detail = `(${displayPath} · ${changes})`
  const summary = `${title} ${detail}`
  return (
    <DeferredDetails
      className="timeline-file-result-details"
      summary={
        <summary>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
          <span title={summary}>
            <span>{title}</span>
            <span className="timeline-file-result-summary-detail">
              {' '}
              ({displayPath} ·{' '}
              {countItems.length > 0
                ? countItems.map((item, index) => (
                    <Fragment key={item.kind}>
                      {index > 0 ? ' ' : null}
                      <span className={item.kind === 'add' ? 'timeline-file-result-summary-add' : 'timeline-file-result-summary-remove'}>{item.value}</span>
                    </Fragment>
                  ))
                : changes}
              )
            </span>
          </span>
        </summary>
      }
      renderBody={() => (
        <TimelineContentStack>
          {fileMutation.type === 'create' ? (
            <TimelineCodeContent value={fileMutation.content} language={fileLanguage(fileMutation.filePath)} defaultWrapped={false} />
          ) : (
            <TimelineDiffContent hunks={fileMutation.hunks} filePath={fileMutation.filePath} />
          )}
        </TimelineContentStack>
      )}
    />
  )
}

export function TimelineContentStack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['timeline-tool-content-stack', className].filter(Boolean).join(' ')}>
      <div className="timeline-tool-content-scroll">{children}</div>
    </div>
  )
}
