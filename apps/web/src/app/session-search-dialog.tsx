import type { ProjectSessionSearchMatch, ProjectSessionSearchResult } from '@cotta/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { searchProjectSessions } from '../api'
import { formatAge } from '../format-age'
import { ProjectFolderIcon } from './session-history'

type LocatedSearchMatch = ProjectSessionSearchMatch & { locator: NonNullable<ProjectSessionSearchMatch['locator']> }
type MetadataField = Exclude<ProjectSessionSearchMatch['field'], 'user' | 'assistant'>
type MetadataMatch = ProjectSessionSearchMatch & { field: MetadataField }
type SearchSelection = { kind: 'metadata'; result: ProjectSessionSearchResult } | { kind: 'message'; result: ProjectSessionSearchResult; match: LocatedSearchMatch }

type FlattenedItem = SearchSelection & { id: string }

const metadataFieldLabels: Record<MetadataField, string> = {
  title: 'Title',
  sessionId: 'Session ID',
  cwd: 'Working directory',
  gitBranch: 'Git branch',
}

const LOAD_MORE_THRESHOLD_PX = 24

function userVisibleLength(value: string): number {
  return Array.from(value.trim()).length
}

function clipRange(range: { start: number; end: number }, length: number): { start: number; end: number } | null {
  const start = Math.max(0, Math.min(length, Math.trunc(range.start)))
  const end = Math.max(0, Math.min(length, Math.trunc(range.end)))
  return end > start ? { start, end } : null
}

function normalizeRanges(ranges: ProjectSessionSearchMatch['ranges'], length: number): Array<{ start: number; end: number }> {
  const clipped = ranges.map((range) => clipRange(range, length)).filter((range): range is { start: number; end: number } => range !== null)
  clipped.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of clipped) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end) merged.push(range)
    else previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

function highlightSnippet(snippet: string, ranges: ProjectSessionSearchMatch['ranges']): ReactNode {
  const safeRanges = normalizeRanges(ranges, snippet.length)
  if (safeRanges.length === 0) return snippet
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of safeRanges) {
    if (range.start > cursor) parts.push(<span key={`text-${cursor}`}>{snippet.slice(cursor, range.start)}</span>)
    parts.push(
      <mark className="session-search-highlight" key={`mark-${range.start}`}>
        {snippet.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  }
  if (cursor < snippet.length) parts.push(<span key="tail">{snippet.slice(cursor)}</span>)
  return parts
}

function isMetadataMatch(match: ProjectSessionSearchMatch): match is MetadataMatch {
  return !match.locator && match.field !== 'user' && match.field !== 'assistant'
}

function flattenResults(results: ProjectSessionSearchResult[]): FlattenedItem[] {
  return results.flatMap((result) => {
    const metadata = result.matches.find(isMetadataMatch)
    const items: FlattenedItem[] = []
    if (metadata) items.push({ kind: 'metadata', result, id: `${result.session.id}:metadata` })
    for (const match of result.matches) {
      if (!match.locator) continue
      const locatedMatch = match as LocatedSearchMatch
      items.push({ kind: 'message', result, match: locatedMatch, id: `${result.session.id}:${locatedMatch.locator.turnId}:${locatedMatch.locator.messageUuid}:${locatedMatch.locator.blockIndex}` })
    }
    return items
  })
}

export function SessionSearchDialog({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (selection: SearchSelection) => void | Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const queryReady = userVisibleLength(trimmedQuery) >= 2
  const search = useInfiniteQuery({
    queryKey: ['session-search', trimmedQuery],
    queryFn: ({ pageParam }) => searchProjectSessions(trimmedQuery, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : null),
    enabled: open && queryReady,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const pages = search.data?.pages ?? []
  const results = useMemo(() => {
    const bySessionId = new Map<string, ProjectSessionSearchResult>()
    for (const page of pages) {
      for (const result of page.results) bySessionId.set(result.session.id, result)
    }
    return [...bySessionId.values()]
  }, [pages])
  const items = useMemo(() => flattenResults(results), [results])
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const activeIndex = items.findIndex((item) => item.id === activeItemId)
  const activeItem = items[activeIndex < 0 ? 0 : activeIndex] ?? null
  useEffect(() => {
    if (activeItem && activeItem.id !== activeItemId) setActiveItemId(activeItem.id)
  }, [activeItem, activeItemId])
  const searchError = search.error instanceof Error ? search.error.message : 'Search failed'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!activeItemId) return
    document.getElementById(activeItemId)?.scrollIntoView({ block: 'nearest' })
  }, [activeItemId])

  function loadMore() {
    if (!search.hasNextPage || search.isFetchingNextPage) return
    void search.fetchNextPage()
  }

  async function submit(selection: SearchSelection) {
    const itemId =
      selection.kind === 'metadata'
        ? `${selection.result.session.id}:metadata`
        : `${selection.result.session.id}:${selection.match.locator.turnId}:${selection.match.locator.messageUuid}:${selection.match.locator.blockIndex}`
    setSubmittingId(itemId)
    try {
      await onSelect(selection)
    } finally {
      setSubmittingId(null)
    }
  }

  async function submitActive() {
    if (!activeItem || submittingId) return
    await submit(activeItem)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      if (items.length === 0) return
      event.preventDefault()
      setActiveItemId(items[(Math.max(0, activeIndex) + 1) % items.length]?.id ?? null)
      return
    }
    if (event.key === 'ArrowUp') {
      if (items.length === 0) return
      event.preventDefault()
      setActiveItemId(items[((activeIndex < 0 ? 0 : activeIndex) - 1 + items.length) % items.length]?.id ?? null)
      return
    }
    if (
      event.key === 'Enter' &&
      document.activeElement !== inputRef.current &&
      !(document.activeElement instanceof HTMLButtonElement && document.activeElement.classList.contains('session-search-option'))
    )
      return
    if (event.key === 'Enter' && activeItem) {
      event.preventDefault()
      void submitActive()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="session-search-dialog"
      aria-labelledby="session-search-title"
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="session-search-shell">
        <div className="session-search-header">
          <h2 id="session-search-title">Search</h2>
          <button className="session-search-close" type="button" onClick={onClose} aria-label="Close search">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5 15 15M15 5 5 15" />
            </svg>
          </button>
        </div>
        <div className="session-search-input-row">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5" />
            <path d="m12.2 12.2 4.3 4.3" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveItemId(null)
            }}
            placeholder="Search sessions and messages"
            aria-label="Search sessions"
            aria-controls={listboxId}
            aria-activedescendant={activeItem ? activeItem.id : undefined}
          />
          {query ? (
            <button
              className="session-search-clear"
              type="button"
              onClick={() => {
                setQuery('')
                setActiveItemId(null)
                inputRef.current?.focus()
              }}
              aria-label="Clear search"
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="session-search-body">
          {!queryReady ? null : search.isPending ? (
            <div className="session-search-state">Searching…</div>
          ) : search.isError && pages.length === 0 ? (
            <div className="session-search-state session-search-error" role="status">
              <strong>Search failed.</strong>
              <p>{searchError}</p>
              <button type="button" onClick={() => void search.refetch()}>
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="session-search-state" role="status">
              No results for “{trimmedQuery}”.
            </div>
          ) : (
            <>
              <div className="session-search-results-meta">
                {pages[0]?.totalMatches ?? 0} message matches in {pages[0]?.totalSessions ?? 0} sessions
              </div>
              <div
                className="session-search-results"
                id={listboxId}
                role="listbox"
                aria-label="Search results"
                onScroll={(event) => {
                  const element = event.currentTarget
                  if (element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_THRESHOLD_PX) loadMore()
                }}
              >
                {results.map((result) => {
                  const metadata = result.matches.find(isMetadataMatch)
                  const messages = result.matches.filter((match): match is LocatedSearchMatch => Boolean(match.locator))
                  return (
                    <section className="session-search-group" key={result.session.id} aria-label={result.session.title}>
                      <div className="session-search-group-header">
                        <div className="session-search-title" title={`${result.project.name} / ${result.session.title}`}>
                          <span className="session-search-project-icon" aria-hidden="true">
                            <ProjectFolderIcon open={false} />
                          </span>
                          <span className="session-search-project-name">{result.project.name}</span>
                          <span aria-hidden="true">/</span>
                          <strong>{result.session.title}</strong>
                        </div>
                      </div>
                      <div className="session-search-options">
                        {metadata ? (
                          <button
                            id={`${result.session.id}:metadata`}
                            className={`session-search-option ${activeItem?.id === `${result.session.id}:metadata` ? 'active' : ''}`}
                            type="button"
                            role="option"
                            aria-selected={activeItem?.id === `${result.session.id}:metadata`}
                            onMouseEnter={() => setActiveItemId(`${result.session.id}:metadata`)}
                            onClick={() => void submit({ kind: 'metadata', result })}
                            disabled={submittingId !== null}
                          >
                            <span className="session-search-snippet">{highlightSnippet(metadata.snippet, metadata.ranges)}</span>
                            <span className="session-search-timestamp session-search-tag">{metadataFieldLabels[metadata.field]}</span>
                          </button>
                        ) : null}
                        {messages.map((match) => {
                          const id = `${result.session.id}:${match.locator.turnId}:${match.locator.messageUuid}:${match.locator.blockIndex}`
                          const active = activeItem?.id === id
                          return (
                            <button
                              id={id}
                              className={`session-search-option ${active ? 'active' : ''}`}
                              type="button"
                              role="option"
                              aria-selected={active}
                              key={id}
                              onMouseEnter={() => setActiveItemId(id)}
                              onClick={() => void submit({ kind: 'message', result, match })}
                              disabled={submittingId !== null}
                            >
                              <span className="session-search-snippet">{highlightSnippet(match.snippet, match.ranges)}</span>
                              {match.messageTimestampMs !== undefined ? <time className="session-search-timestamp">{formatAge(match.messageTimestampMs)}</time> : null}
                            </button>
                          )
                        })}
                      </div>
                      {result.truncatedMatches ? <p className="session-search-truncated">More matches in this session. Refine your search.</p> : null}
                    </section>
                  )
                })}
                {search.isFetchingNextPage ? (
                  <div className="session-search-footer">Loading…</div>
                ) : search.isFetchNextPageError ? (
                  <div className="session-search-footer">
                    <button type="button" onClick={loadMore}>
                      Retry loading more results
                    </button>
                  </div>
                ) : search.hasNextPage ? (
                  <div className="session-search-footer">
                    <button type="button" onClick={loadMore}>
                      Load more results
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}
