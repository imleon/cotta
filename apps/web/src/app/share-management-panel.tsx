import type { ShareSummary } from '@cotta/shared'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { listShares, revokeShare } from '../api'
import { ProjectFolderIcon } from './session-history'

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`
}

/** Coarse relative age ("just now", "5m ago", "3d ago"); hover shows the absolute time. */
function relativeAge(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo ago`
  return `${Math.floor(s / 31536000)}y ago`
}

type OpenTurn = (sessionId: string, turnId: string) => void

function ShareRow({ share, onRevoked, onOpenTurn }: { share: ShareSummary; onRevoked: (token: string) => void; onOpenTurn: OpenTurn }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [revoking, setRevoking] = useState(false)

  async function confirmRevoke() {
    setRevoking(true)
    try {
      await revokeShare(share.token)
      dialogRef.current?.close()
      onRevoked(share.token)
    } finally {
      setRevoking(false)
    }
  }

  const subtitle = share.awaySummary || share.promptPreview
  const createdAt = new Date(share.createdAtMs)

  return (
    <li className="share-row">
      <button type="button" className="share-row-link" onClick={() => onOpenTurn(share.sessionId, share.turnId)}>
        <span className="share-row-icon" aria-hidden="true">
          <ProjectFolderIcon open={false} />
        </span>
        <span className="share-row-text">
          <span className="share-row-head">
            {share.projectName ? (
              <>
                <span className="share-row-project">{share.projectName}</span>
                <span className="share-row-sep" aria-hidden="true">
                  /
                </span>
              </>
            ) : null}
            <span className="share-row-title">{share.sessionTitle || share.promptPreview || share.turnId}</span>
            {share.entrypoint === 'cli' ? <span className="share-row-source">CLI</span> : null}
          </span>
          {subtitle ? (
            <span className="share-row-sub" title={subtitle}>
              {subtitle}
            </span>
          ) : null}
        </span>
      </button>
      <div className="share-row-actions">
        <span className="share-row-time" title={createdAt.toLocaleString()}>
          shared {relativeAge(share.createdAtMs)}
        </span>
        <a className="timeline-action-button" href={shareUrl(share.token)} target="_blank" rel="noreferrer noopener" aria-label="Open share page" data-tooltip="Open share page">
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="15" cy="4.5" r="2.2" />
            <circle cx="5" cy="10" r="2.2" />
            <circle cx="15" cy="15.5" r="2.2" />
            <path d="m7 8.9 6-3.3M7 11.1l6 3.3" />
          </svg>
        </a>
        <button type="button" className="timeline-action-button share-row-revoke" aria-label="Revoke" data-tooltip="Revoke" onClick={() => dialogRef.current?.showModal()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M8 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2h5a1 1 0 1 1 0 2h-1v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6H3a1 1 0 0 1 0-2h5ZM6 6v14h12V6H6Zm4 3a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z" />
          </svg>
        </button>
      </div>
      {/** biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop click-to-close mirrors existing delete dialog */}
      <dialog ref={dialogRef} className="share-management-dialog" onClick={(event) => event.target === dialogRef.current && dialogRef.current?.close()}>
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <h3>Revoke share</h3>
          <p className="muted">The public URL and any copied images become permanently unavailable. This cannot be undone.</p>
          <div className="share-management-dialog-actions">
            <button type="button" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={revoking} onClick={() => void confirmRevoke()}>
              {revoking ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        </form>
      </dialog>
    </li>
  )
}

export function ShareManagementPanel({ onOpenTurn }: { onOpenTurn: OpenTurn }) {
  const [cursor, setCursor] = useState<string | null>(null)
  const [items, setItems] = useState<ShareSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useQuery({
    queryKey: ['shares', cursor],
    queryFn: async () => {
      const page = await listShares(cursor)
      setItems((prev) => (cursor === null ? page.shares : [...prev, ...page.shares.filter((s) => !prev.some((p) => p.token === s.token))]))
      setNextCursor(page.nextCursor)
      setLoaded(true)
      return page
    },
  })

  function onRevoked(token: string) {
    setItems((prev) => prev.filter((share) => share.token !== token))
  }

  return (
    <section className="detail-panel settings-panel" aria-label="Shares">
      <div className="settings-section">
        <h2>Shares</h2>
        <p className="muted">Share a turn with anyone through a public link, and revoke access the moment you need to.</p>
      </div>
      {loaded && items.length === 0 ? (
        <p className="muted">No active shares.</p>
      ) : (
        <ul className="share-list">
          {items.map((share) => (
            <ShareRow share={share} onRevoked={onRevoked} onOpenTurn={onOpenTurn} key={share.token} />
          ))}
        </ul>
      )}
      {nextCursor ? (
        <button type="button" className="settings-origin-add" onClick={() => setCursor(nextCursor)}>
          Load more
        </button>
      ) : null}
    </section>
  )
}
