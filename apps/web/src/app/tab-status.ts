import type { SessionStatus } from '@cotta/shared'
import faviconSvg from '../assets/favicon.svg?raw'

export type TabStatus = 'running' | 'waiting'

// Same tokens as the session rail status dot.
const BADGE_TOKEN: Record<TabStatus, string> = { running: '--interactive-default', waiting: '--status-waiting' }

function readRootToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function tabStatus(status: SessionStatus | undefined): TabStatus | null {
  if (status === 'waiting') return 'waiting'
  if (status === 'busy' || status === 'background') return 'running'
  return null
}

export function faviconHref(status: TabStatus | null, readToken: (name: string) => string = readRootToken): string {
  const badge = status ? `<circle cx="700" cy="408" r="82" fill="${readToken(BADGE_TOKEN[status])}" stroke="#FFF8F2" stroke-width="30"/>` : ''
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg.replace('</svg>', `${badge}</svg>`))}`
}
