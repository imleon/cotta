import { localImageDestinationPathname, projectTurnMarkdown, type TurnSummary, turnExportFilename } from '@cotta/shared'
import { type ReactNode, useEffect, useState } from 'react'
import logoUrl from '../assets/logo.svg'
import { AnonImageContext, writeClipboard } from '../timeline/content'
import { groupAssistantResponseFrames, groupTimelineBlocks, isPrimaryInputBlock, projectTimelineTurn, turnFooterState } from '../timeline/core'
import { AssistantResponseFrameView, PrimaryInputView, TimelineRenderItemView } from '../timeline/renderers'

const VIEWER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Token-bound anonymous image endpoint for the current page's link type. */
export type AnonImageEndpoint = { kind: 'detail' | 'share'; token: string }

/** Builds a resolver mapping a local image src to its anonymous GET endpoint, rejecting unsafe srcs up front. */
function anonImageResolver(endpoint: AnonImageEndpoint): (rawSrc: string) => string | null {
  return (rawSrc) => (localImageDestinationPathname(rawSrc) ? `/api/${endpoint.kind}/${encodeURIComponent(endpoint.token)}/asset?src=${encodeURIComponent(rawSrc)}` : null)
}

/** Renders a single source/snapshot Turn read-only: reuses the Timeline render pipeline, no interaction callbacks. */
export function AnonTurnTimeline({ turn, imageEndpoint }: { turn: TurnSummary; imageEndpoint?: AnonImageEndpoint }) {
  const blocks = projectTimelineTurn(turn)
  const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(blocks, false, turn.durationTimestampMs))
  const lastAssistantFrameId = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')?.id
  const footerState = turnFooterState({ turn: { ...turn, pendingBackgroundAgentCount: undefined }, phase: 'settled', cooking: false, primaryOnly: blocks.every(isPrimaryInputBlock) })
  return (
    <AnonImageContext.Provider value={imageEndpoint ? anonImageResolver(imageEndpoint) : null}>
      <section className="session-workspace-view">
        <section className="timeline-panel">
          <article className="turn-card">
            <div className="timeline-blocks">
              {displayItems.map((item) =>
                item.type === 'assistant-response-frame' ? (
                  <AssistantResponseFrameView
                    item={item}
                    turnBlocks={blocks}
                    timestamp={item.id === lastAssistantFrameId && turn.durationMs !== undefined ? turn.durationTimestampMs : undefined}
                    timeZone={VIEWER_TIME_ZONE}
                    footerState={item.id === lastAssistantFrameId ? footerState : null}
                    phase="settled"
                    source={null}
                    showSource={false}
                    key={item.id}
                  />
                ) : item.type === 'primary-input' ? (
                  <PrimaryInputView blocks={item.blocks} timestamp={turn.primaryUserTimestampMs} timeZone={VIEWER_TIME_ZONE} showSource={false} key={item.id} />
                ) : (
                  <TimelineRenderItemView
                    item={item.item}
                    timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.primaryUserTimestampMs : undefined}
                    timeZone={VIEWER_TIME_ZONE}
                    showSource={false}
                    key={item.item.type === 'block' ? `${item.item.block.kind}:${turn.primaryUserUuid}` : turn.primaryUserUuid}
                  />
                ),
              )}
            </div>
          </article>
        </section>
      </section>
    </AnonImageContext.Provider>
  )
}

export function AnonUnavailable() {
  return (
    <div className="detail-anon-unavailable">
      <img className="app-sidebar-brand-logo" src={logoUrl} alt="Cotta" />
      <p>This link is unavailable.</p>
    </div>
  )
}

/** Sets document title and noindex,nofollow for the anonymous page lifetime. */
export function useAnonChrome() {
  useEffect(() => {
    const previous = document.title
    document.title = 'Cotta'
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'robots'
      document.head.appendChild(meta)
    }
    meta.content = 'noindex, nofollow'
    return () => {
      document.title = previous
    }
  }, [])
}

/** Copy / Download Markdown toolbar sharing one byte-identical projection. */
export function AnonExportActions({ turn }: { turn: TurnSummary }) {
  const [copied, setCopied] = useState(false)
  const markdown = projectTurnMarkdown(turn)
  const filename = `${turnExportFilename(turn)}.md`
  async function copy() {
    await writeClipboard(markdown)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  function download() {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="detail-anon-actions">
      <button type="button" className="detail-anon-action timeline-action-button" aria-label="Copy Markdown" data-tooltip={copied ? 'Copied' : 'Copy Markdown'} onClick={() => void copy()}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      </button>
      <button type="button" className="detail-anon-action timeline-action-button" aria-label="Download Markdown" data-tooltip="Download Markdown" onClick={download}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      </button>
    </div>
  )
}

/** Copies the current page URL to the clipboard — the Share action on an already-public page. */
export function CopyLinkAction() {
  const [copied, setCopied] = useState(false)
  async function copyLink() {
    await writeClipboard(window.location.href)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button type="button" className="detail-anon-action timeline-action-button" aria-label="Copy link" data-tooltip={copied ? 'Copied' : 'Copy link'} onClick={() => void copyLink()}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="15" cy="4.5" r="2.2" />
        <circle cx="5" cy="10" r="2.2" />
        <circle cx="15" cy="15.5" r="2.2" />
        <path d="m7 8.9 6-3.3M7 11.1l6 3.3" />
      </svg>
    </button>
  )
}

/** Shared anonymous page shell: Cotta mark header with a kind badge and optional actions, then body. */
export function AnonPageShell({ badge, actions, children }: { badge: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="detail-anon">
      <header className="detail-anon-header">
        <span className="app-sidebar-brand-lockup">
          <img className="app-sidebar-brand-logo" src={logoUrl} alt="Cotta" />
          <span className="app-sidebar-brand-tagline">Claude Code on Web</span>
        </span>
        <span className="detail-anon-badge">{badge}</span>
        {actions ? <div className="detail-anon-header-actions">{actions}</div> : null}
      </header>
      {children}
    </main>
  )
}
