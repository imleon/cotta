import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { createShare, DetailUnavailableError, fetchDetail } from '../api'
import { AnonExportActions, AnonPageShell, AnonTurnTimeline, AnonUnavailable, useAnonChrome } from './anon-turn-page'

/** Creates (or reuses) a share for this turn via the bearer Detail token, then opens it in a new tab. */
function ShareAction({ token }: { token: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function share() {
    // Open the tab synchronously (user gesture) to avoid popup blocking; navigate it once the share exists.
    const tab = window.open('about:blank', '_blank')
    setBusy(true)
    setError(null)
    try {
      const { token: shareToken } = await createShare({ detailToken: token })
      const url = `${window.location.origin}/share/${shareToken}`
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
    } catch (err) {
      tab?.close()
      setError(err instanceof Error ? err.message : 'Share failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className="detail-anon-action timeline-action-button" aria-label="Share" data-tooltip={busy ? 'Sharing…' : 'Share'} disabled={busy} onClick={() => void share()}>
        <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="15" cy="4.5" r="2.2" />
          <circle cx="5" cy="10" r="2.2" />
          <circle cx="15" cy="15.5" r="2.2" />
          <path d="m7 8.9 6-3.3M7 11.1l6 3.3" />
        </svg>
      </button>
      {error ? <span className="detail-anon-error">{error}</span> : null}
    </>
  )
}

export function AnonTurnDetail({ token }: { token: string }) {
  useAnonChrome()
  const detail = useQuery({ queryKey: ['detail', token], queryFn: () => fetchDetail(token), retry: (_count, error) => !(error instanceof DetailUnavailableError) })
  const turn = detail.data?.turn
  const actions = turn ? (
    <>
      <AnonExportActions turn={turn} />
      {turn.shareEligible ? <ShareAction token={token} /> : null}
    </>
  ) : null
  return (
    <AnonPageShell badge="Detail" actions={actions}>
      {detail.isLoading ? <div className="panel muted">Loading…</div> : turn ? <AnonTurnTimeline turn={turn} imageEndpoint={{ kind: 'detail', token }} /> : <AnonUnavailable />}
    </AnonPageShell>
  )
}
