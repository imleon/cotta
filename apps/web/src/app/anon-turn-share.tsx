import { useQuery } from '@tanstack/react-query'
import { fetchShare, ShareUnavailableError } from '../api'
import { CollapsedDisclosureContext } from '../timeline/content'
import { AnonExportActions, AnonPageShell, AnonTurnTimeline, AnonUnavailable, CopyLinkAction, useAnonChrome } from './anon-turn-page'

export function AnonTurnShare({ token }: { token: string }) {
  useAnonChrome()
  const share = useQuery({ queryKey: ['share', token], queryFn: () => fetchShare(token), retry: (_count, error) => !(error instanceof ShareUnavailableError) })
  const turn = share.data?.turn
  return (
    // Share is a public snapshot: tool/thinking show their header only, no expansion.
    <CollapsedDisclosureContext.Provider value={true}>
      <AnonPageShell
        badge="Shared"
        actions={
          turn ? (
            <>
              <AnonExportActions turn={turn} />
              <CopyLinkAction />
            </>
          ) : null
        }
      >
        {share.isLoading ? <div className="panel muted">Loading…</div> : turn ? <AnonTurnTimeline turn={turn} imageEndpoint={{ kind: 'share', token }} /> : <AnonUnavailable />}
      </AnonPageShell>
    </CollapsedDisclosureContext.Provider>
  )
}
