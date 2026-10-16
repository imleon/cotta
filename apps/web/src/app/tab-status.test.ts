import { describe, expect, it } from 'vitest'
import { faviconHref, tabStatus } from './tab-status'

describe('tab status', () => {
  it('maps session activity to tab status', () => {
    expect(tabStatus('waiting')).toBe('waiting')
    expect(tabStatus('busy')).toBe('running')
    expect(tabStatus('background')).toBe('running')
    expect(tabStatus('idle')).toBeNull()
    expect(tabStatus(undefined)).toBeNull()
  })

  it('colors the favicon badge from the session rail status tokens only while active', () => {
    const readToken = (name: string) => `var-${name}`
    expect(decodeURIComponent(faviconHref(null, readToken))).not.toContain('<circle')
    expect(decodeURIComponent(faviconHref('running', readToken))).toContain('fill="var---interactive-default"')
    expect(decodeURIComponent(faviconHref('waiting', readToken))).toContain('fill="var---status-waiting"')
  })
})
