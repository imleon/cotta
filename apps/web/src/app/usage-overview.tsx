import type { TokenUsageDay, TokenUsageRange } from '@cotta/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchDailyUsage, fetchUsage, refreshUsage } from '../api'

const ranges: Array<{ value: TokenUsageRange; label: string; accessibleLabel: string }> = [
  { value: 'today', label: 'Today', accessibleLabel: 'Today' },
  { value: '7d', label: '7D', accessibleLabel: '7 days' },
  { value: '30d', label: '30D', accessibleLabel: '30 days' },
  { value: 'all', label: 'All', accessibleLabel: 'All time' },
]
const dayMs = 86_400_000
const calendarWeeks = 26
const calendarDayCount = calendarWeeks * 7
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat()
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' })

function usageBoundary(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function dateMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year!, month! - 1, day!)
}

function dateString(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function activityLevel(tokens: number): number {
  if (tokens === 0) return 0
  if (tokens < 10_000_000) return 1
  if (tokens < 100_000_000) return 2
  if (tokens < 1_000_000_000) return 3
  return 4
}

function calendarDays(values: TokenUsageDay[]) {
  if (values.length === 0) return { cells: [], rows: [], weeks: 0, months: [] }
  const byDate = new Map(values.map((value) => [value.date, value]))
  const last = dateMs(values.at(-1)!.date)
  const first = last - ((calendarWeeks - 1) * 7 + new Date(last).getUTCDay()) * dayMs
  const cells: Array<{ date: string; tokens: number; weekday: number; weekdayLabel: string; week: number; label: string }> = []
  const months: Array<{ label: string; week: number }> = []
  const seenMonths = new Set<string>()
  for (let timestamp = first; timestamp <= last; timestamp += dayMs) {
    const date = dateString(timestamp)
    const tokens = byDate.get(date)?.totalTokens ?? 0
    const day = new Date(timestamp)
    const week = Math.floor((timestamp - first) / (7 * dayMs))
    const month = date.slice(0, 7)
    if (!seenMonths.has(month)) {
      seenMonths.add(month)
      months.push({ label: day.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' }), week })
    }
    const weekdayLabel = weekday.format(day)
    cells.push({ date, tokens, weekday: day.getUTCDay(), weekdayLabel, week, label: `${date}, ${weekdayLabel}, ${integer.format(tokens)} tokens` })
  }
  const rows: Array<Array<{ cell: (typeof cells)[number]; index: number }>> = Array.from({ length: 7 }, () => [])
  for (const [index, cell] of cells.entries()) rows[cell.weekday]?.push({ cell, index })
  return { cells, rows, weeks: calendarWeeks, months }
}

type ActiveTooltip = { anchor: HTMLElement; date: string; tokens: number }
type TooltipSource = 'focus' | 'hover'

function ActivityHeatmap({ values, loading, error, refreshError, onRetry }: { values: TokenUsageDay[]; loading: boolean; error: boolean; refreshError: boolean; onRetry: () => void }) {
  const calendar = useMemo(() => calendarDays(values), [values])
  const newestDate = calendar.cells.at(-1)?.date ?? null
  const [tabStopDate, setTabStopDate] = useState<string | null>(null)
  const [activeTooltip, setActiveTooltip] = useState<(ActiveTooltip & { source: TooltipSource }) | null>(null)
  const interactionsRef = useRef<Record<TooltipSource, ActiveTooltip | null>>({ focus: null, hover: null })
  const scrollportRef = useRef<HTMLDivElement>(null)
  const calendarRef = useRef<HTMLDivElement>(null)
  const pinnedToNewestRef = useRef(true)
  const userScrollActiveRef = useRef(false)
  const userScrollTimeoutRef = useRef<number | null>(null)
  const lastScrolledDateRef = useRef<string | null>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const activeTabStop = tabStopDate && calendar.cells.some((cell) => cell.date === tabStopDate) ? tabStopDate : newestDate

  const scrollToNewest = useCallback(() => {
    const scrollport = scrollportRef.current
    if (!scrollport) return
    scrollport.scrollLeft = Math.max(0, scrollport.scrollWidth - scrollport.clientWidth)
  }, [])

  const setTooltipInteraction = useCallback((source: TooltipSource, active: ActiveTooltip | null) => {
    interactionsRef.current[source] = active
    if (active) setActiveTooltip({ ...active, source })
    else {
      const fallbackSource = source === 'focus' ? 'hover' : 'focus'
      const fallback = interactionsRef.current[fallbackSource]
      setActiveTooltip(fallback ? { ...fallback, source: fallbackSource } : null)
    }
  }, [])

  const clearTooltipAnchor = useCallback((anchor: HTMLElement) => {
    for (const source of ['focus', 'hover'] as const) {
      if (interactionsRef.current[source]?.anchor === anchor) interactionsRef.current[source] = null
    }
    setActiveTooltip((current) => {
      if (current?.anchor !== anchor) return current
      const fallbackSource = interactionsRef.current.focus ? 'focus' : interactionsRef.current.hover ? 'hover' : null
      const fallback = fallbackSource ? interactionsRef.current[fallbackSource] : null
      return fallback && fallbackSource ? { ...fallback, source: fallbackSource } : null
    })
  }, [])

  const showTooltip = useCallback(
    (source: TooltipSource, anchor: HTMLElement) => {
      const cell = calendar.cells[Number(anchor.dataset.cellIndex)]
      if (cell) setTooltipInteraction(source, { anchor, date: cell.date, tokens: cell.tokens })
    },
    [calendar.cells, setTooltipInteraction],
  )

  const handleMouseEnter = useCallback((event: React.MouseEvent<HTMLElement>) => showTooltip('hover', event.currentTarget), [showTooltip])
  const handleMouseLeave = useCallback(
    (event: React.MouseEvent<HTMLElement>) => setTooltipInteraction('hover', interactionsRef.current.hover?.anchor === event.currentTarget ? null : interactionsRef.current.hover),
    [setTooltipInteraction],
  )
  const handleFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      setTabStopDate(event.currentTarget.dataset.date ?? null)
      showTooltip('focus', event.currentTarget)
    },
    [showTooltip],
  )
  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => setTooltipInteraction('focus', interactionsRef.current.focus?.anchor === event.currentTarget ? null : interactionsRef.current.focus),
    [setTooltipInteraction],
  )
  const moveFocus = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const index = Number(event.currentTarget.dataset.cellIndex)
      const current = calendar.cells[index]
      if (!current) return
      const currentRow = calendar.rows[current.weekday] ?? []
      const nextIndex =
        event.key === 'Home'
          ? event.ctrlKey
            ? 0
            : (currentRow[0]?.index ?? Number.NaN)
          : event.key === 'End'
            ? event.ctrlKey
              ? calendar.cells.length - 1
              : (currentRow.at(-1)?.index ?? Number.NaN)
            : event.key === 'ArrowLeft'
              ? index - 7
              : event.key === 'ArrowRight'
                ? index + 7
                : event.key === 'ArrowUp' && current.weekday > 0
                  ? index - 1
                  : event.key === 'ArrowDown' && current.weekday < 6
                    ? index + 1
                    : Number.NaN
      if (!Number.isInteger(nextIndex)) return
      const next = calendar.cells[nextIndex]
      if (!next) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') pinnedToNewestRef.current = nextIndex === calendar.cells.length - 1
      setTabStopDate(next.date)
      calendarRef.current?.querySelector<HTMLElement>(`[data-cell-index="${nextIndex}"]`)?.focus()
    },
    [calendar.cells],
  )
  const beginUserScroll = useCallback(() => {
    userScrollActiveRef.current = true
    if (userScrollTimeoutRef.current !== null) {
      window.clearTimeout(userScrollTimeoutRef.current)
      userScrollTimeoutRef.current = null
    }
  }, [])
  const endUserScroll = useCallback(() => {
    userScrollActiveRef.current = false
    if (userScrollTimeoutRef.current !== null) window.clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = null
  }, [])
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!userScrollActiveRef.current) return
      const scrollport = event.currentTarget
      pinnedToNewestRef.current = scrollport.scrollWidth - scrollport.clientWidth - scrollport.scrollLeft <= 1
      if (userScrollTimeoutRef.current !== null) window.clearTimeout(userScrollTimeoutRef.current)
      userScrollTimeoutRef.current = window.setTimeout(endUserScroll, 150)
    },
    [endUserScroll],
  )

  useEffect(() => () => endUserScroll(), [endUserScroll])

  useLayoutEffect(() => {
    if (!newestDate || lastScrolledDateRef.current === newestDate) return
    if (pinnedToNewestRef.current) scrollToNewest()
    lastScrolledDateRef.current = newestDate
  }, [newestDate, scrollToNewest])

  useLayoutEffect(() => {
    const scrollport = scrollportRef.current
    const calendarElement = calendarRef.current
    if (!scrollport || !calendarElement) return
    const keepNewestVisible = () => {
      if (pinnedToNewestRef.current) scrollToNewest()
    }
    const observer = new ResizeObserver(keepNewestVisible)
    observer.observe(scrollport)
    observer.observe(calendarElement)
    window.addEventListener('resize', keepNewestVisible)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', keepNewestVisible)
    }
  }, [newestDate, scrollToNewest])

  useLayoutEffect(() => {
    const byDate = new Map(calendar.cells.map((cell) => [cell.date, cell.tokens]))
    for (const source of ['focus', 'hover'] as const) {
      const interaction = interactionsRef.current[source]
      if (!interaction) continue
      if (error || !interaction.anchor.isConnected || !byDate.has(interaction.date)) interactionsRef.current[source] = null
      else interactionsRef.current[source] = { ...interaction, tokens: byDate.get(interaction.date)! }
    }
    setActiveTooltip((current) => {
      if (!current) return null
      const next = interactionsRef.current[current.source]
      if (!next) return null
      return current.anchor === next.anchor && current.tokens === next.tokens ? current : { ...next, source: current.source }
    })
  }, [calendar.cells, error])

  useLayoutEffect(() => {
    if (!activeTooltip) return
    const scrollport = scrollportRef.current
    if (!scrollport) return
    let frame: number | null = null
    const position = () => {
      const tooltip = tooltipRef.current
      if (!tooltip || !activeTooltip.anchor.isConnected) return
      const anchor = activeTooltip.anchor.getBoundingClientRect()
      const clip = scrollport.getBoundingClientRect()
      const page = scrollport.closest('.usage-page')?.getBoundingClientRect()
      const outsideScrollport = clip.width > 0 && clip.height > 0 && (anchor.right <= clip.left || anchor.left >= clip.right || anchor.bottom <= clip.top || anchor.top >= clip.bottom)
      const outsidePage = page && page.width > 0 && page.height > 0 ? anchor.right <= page.left || anchor.left >= page.right || anchor.bottom <= page.top || anchor.top >= page.bottom : false
      const outsideViewport = anchor.right <= 0 || anchor.left >= window.innerWidth || anchor.bottom <= 0 || anchor.top >= window.innerHeight
      if (outsideScrollport || outsidePage || outsideViewport) {
        clearTooltipAnchor(activeTooltip.anchor)
        return
      }
      const tooltipSize = tooltip.getBoundingClientRect()
      const gap = 6
      const margin = 8
      const below = anchor.top < tooltipSize.height + gap + margin
      const minLeft = tooltipSize.width / 2 + margin
      const maxLeft = Math.max(minLeft, window.innerWidth - tooltipSize.width / 2 - margin)
      const preferredTop = below ? anchor.bottom + gap : anchor.top - tooltipSize.height - gap
      const maxTop = Math.max(margin, window.innerHeight - tooltipSize.height - margin)
      tooltip.style.left = `${Math.min(Math.max(anchor.left + anchor.width / 2, minLeft), maxLeft)}px`
      tooltip.style.top = `${Math.min(Math.max(preferredTop, margin), maxTop)}px`
    }
    const schedulePosition = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        position()
      })
    }
    position()
    const mutationObserver = new MutationObserver(schedulePosition)
    const pageElement = scrollport.closest('.usage-page')
    if (pageElement) mutationObserver.observe(pageElement, { childList: true, subtree: true })
    window.addEventListener('resize', schedulePosition)
    window.addEventListener('scroll', schedulePosition, true)
    window.addEventListener('pointermove', schedulePosition)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedulePosition)
      window.removeEventListener('scroll', schedulePosition, true)
      window.removeEventListener('pointermove', schedulePosition)
    }
  }, [activeTooltip, clearTooltipAnchor])

  return (
    <figure className="usage-chart-card usage-activity-card" aria-label="Daily activity">
      {loading && values.length === 0 ? (
        <div className="usage-chart-state" role="status">
          Loading activity…
        </div>
      ) : null}
      {error ? (
        <div className="usage-chart-state error" role="alert">
          Failed to load activity.{' '}
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {!error && values.length > 0 ? (
        <div
          className="usage-heatmap-scroll"
          ref={scrollportRef}
          onScroll={handleScroll}
          onScrollEnd={endUserScroll}
          onWheel={beginUserScroll}
          onPointerDown={beginUserScroll}
          onTouchStart={beginUserScroll}
        >
          <div
            className="usage-calendar-months"
            style={
              {
                '--usage-weeks': calendar.weeks,
                '--usage-calendar-min-width': `${calendar.weeks * 13 + (calendar.weeks - 1) * 2}px`,
                '--usage-calendar-max-width': `${calendar.weeks * 21 + (calendar.weeks - 1) * 2}px`,
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            {calendar.months.map((month) => (
              <span className="usage-calendar-month" style={{ gridColumn: month.week + 1 }} key={`${month.label}:${month.week}`}>
                {month.label}
              </span>
            ))}
          </div>
          <div
            className="usage-calendar"
            style={
              {
                '--usage-weeks': calendar.weeks,
                '--usage-calendar-min-width': `${calendar.weeks * 13 + (calendar.weeks - 1) * 2}px`,
                '--usage-calendar-max-width': `${calendar.weeks * 21 + (calendar.weeks - 1) * 2}px`,
              } as React.CSSProperties
            }
            role="grid"
            aria-label="Daily token usage calendar"
            aria-colcount={calendar.weeks}
            aria-rowcount={7}
            ref={calendarRef}
          >
            {calendar.rows.map((row, rowIndex) => (
              <span className="usage-calendar-row" role="row" aria-rowindex={rowIndex + 1} style={{ gridRow: rowIndex + 1 }} key={rowIndex}>
                {row.map(({ cell, index }) => (
                  <span
                    className="usage-heatmap-cell"
                    data-level={activityLevel(cell.tokens)}
                    data-date={cell.date}
                    data-cell-index={index}
                    style={{ gridColumn: cell.week + 1 }}
                    key={cell.date}
                    role="gridcell"
                    aria-label={cell.label}
                    aria-colindex={cell.week + 1}
                    tabIndex={cell.date === activeTabStop ? 0 : -1}
                    onKeyDown={moveFocus}
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                  />
                ))}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {refreshError ? (
        <span className="usage-chart-refresh-error" role="alert">
          Failed to refresh activity
        </span>
      ) : null}
      <div className="usage-heat-legend" aria-label="Token ranges">
        {['0', '<10M', '<100M', '<1B', '≥1B'].map((label, level) => (
          <span className="usage-heat-key" key={label}>
            <i data-level={level} />
            {label}
          </span>
        ))}
      </div>
      {activeTooltip
        ? createPortal(
            <span ref={tooltipRef} className="usage-cell-tooltip" aria-hidden="true">
              {activeTooltip.date} · {weekday.format(dateMs(activeTooltip.date))}
              <br />
              {compact.format(activeTooltip.tokens)} tokens
            </span>,
            document.body,
          )
        : null}
    </figure>
  )
}

export function UsageOverview({ timeZone }: { timeZone: string }) {
  const [range, setRange] = useState<TokenUsageRange>('30d')
  const [, setNow] = useState(Date.now)
  const today = usageBoundary(timeZone)
  useEffect(() => {
    const refreshBoundary = () => setNow(Date.now())
    const interval = window.setInterval(refreshBoundary, 60_000)
    window.addEventListener('focus', refreshBoundary)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshBoundary)
    }
  }, [timeZone])
  const summaryQuery = useQuery({ queryKey: ['usage', range, timeZone, today], queryFn: () => fetchUsage(range, timeZone), retry: false, refetchOnMount: false })
  const calendarQuery = useQuery({ queryKey: ['usage-daily', calendarDayCount, timeZone, today], queryFn: () => fetchDailyUsage(calendarDayCount, timeZone), retry: false, refetchOnMount: false })
  const refreshMutation = useMutation({
    mutationFn: refreshUsage,
    onSuccess: async () => {
      await Promise.allSettled([summaryQuery.refetch(), calendarQuery.refetch()])
    },
  })
  const retryCalendar = useCallback(() => void calendarQuery.refetch(), [calendarQuery.refetch])

  const data = summaryQuery.data
  const calendar = calendarQuery.data
  const refreshing = refreshMutation.isPending

  return (
    <section className="usage-page" aria-labelledby="usage-heading">
      <header className="usage-header">
        <h1 id="usage-heading" className="sr-only">
          Token usage
        </h1>
        <div className="usage-header-actions">
          <button
            className="usage-refresh"
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label={refreshing ? 'Refreshing usage' : 'Refresh usage'}
            title="Refresh usage"
          >
            {refreshing ? (
              <span className="turn-spinner" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="RefreshOutlined">
                <path
                  d="M9.93 4.273a8 8 0 0 1 8.683 3.224h-3.11a1 1 0 0 0 0 2h5.496a1 1 0 0 0 1.001-1V3a1 1 0 1 0-2 0v3a10 10 0 1 0 .66 11 1 1 0 0 0-1.732-1A8 8 0 1 1 9.93 4.273Z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
          {refreshMutation.isError ? (
            <span className="usage-refresh-error" role="alert">
              Refresh failed
            </span>
          ) : null}
          <fieldset className="usage-range">
            <legend className="sr-only">Date range</legend>
            {ranges.map((item) => (
              <button type="button" key={item.value} aria-label={item.accessibleLabel} aria-pressed={range === item.value} onClick={() => setRange(item.value)}>
                {item.label}
              </button>
            ))}
          </fieldset>
        </div>
      </header>
      {summaryQuery.isLoading ? (
        <div className="usage-state" role="status">
          Loading usage…
        </div>
      ) : summaryQuery.isLoadingError ? (
        <div className="usage-state error" role="alert">
          Failed to load usage.{' '}
          <button type="button" onClick={() => void summaryQuery.refetch()}>
            Try again
          </button>
        </div>
      ) : data ? (
        <dl className="usage-kpis">
          {[
            { label: 'Total tokens', value: compact.format(data.totals.totalTokens), detail: `${integer.format(data.totals.totalTokens)} tokens` },
            { label: 'Input tokens', value: compact.format(data.totals.inputTokens), detail: `${integer.format(data.totals.inputTokens)} tokens` },
            { label: 'Output tokens', value: compact.format(data.totals.outputTokens), detail: `${integer.format(data.totals.outputTokens)} tokens` },
            { label: 'Cache read', value: compact.format(data.totals.cacheReadTokens), detail: `${integer.format(data.totals.cacheReadTokens)} tokens` },
            { label: 'Cache hit rate', value: `${(data.totals.cacheHitRate * 100).toFixed(1)}%`, detail: 'Share of input tokens' },
            { label: 'Sessions', value: integer.format(data.totals.sessions), detail: 'Active in this period' },
            { label: 'User messages', value: integer.format(data.totals.userMessages), detail: 'Primary turns' },
          ].map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
              <span>{item.detail}</span>
            </div>
          ))}
        </dl>
      ) : null}
      {summaryQuery.isRefetchError ? (
        <div className="usage-refresh-error" role="alert">
          Failed to refresh usage
        </div>
      ) : null}
      <ActivityHeatmap values={calendar?.daily ?? []} loading={calendarQuery.isLoading} error={calendarQuery.isLoadingError} refreshError={calendarQuery.isRefetchError} onRetry={retryCalendar} />
    </section>
  )
}
