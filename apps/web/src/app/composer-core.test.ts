import { describe, expect, it } from 'vitest'
import { sessionExternallyOwned, submitStateFor } from '../timeline/core'
import { composerActionMode, composerControlLabel, composerSessionBusy, composerSubmitBlocked } from './composer-core'

const session = (overrides = {}) => ({ occupiedBy: null, ...overrides })

describe('composer PRD 02 states', () => {
  it('10/11: only exposes stop for an active Web turn and blocks external owners without treating shell-only as submit-blocking', () => {
    const webBusy = submitStateFor({ submitting: false, stopping: false, latestPhase: 'rendering' })
    expect(composerActionMode({ submitState: webBusy, canStop: true })).toBe('stop')
    expect(composerActionMode({ submitState: webBusy, canStop: false })).toBe('submit')
    const external = session({ occupiedBy: 'external' })
    expect(sessionExternallyOwned(external)).toBe(true)
    expect(composerSubmitBlocked({ externallyOwned: sessionExternallyOwned(external), projectDirectoryUnavailable: false })).toBe(true)
    expect(composerControlLabel({ projectDirectoryUnavailable: false, externallyOwned: true })).toBe('Controlled by an external Claude Code client')

    const local = session({ occupiedBy: 'cotta' })
    expect(sessionExternallyOwned(local)).toBe(false)
    expect(composerSessionBusy({ occupiedBy: 'cotta', occupiedStatus: 'busy' })).toBe(true)
    expect(composerSessionBusy({ occupiedBy: 'cotta', occupiedStatus: 'idle' })).toBe(false)
    expect(composerSessionBusy({ occupiedBy: 'cotta', occupiedStatus: 'background' })).toBe(false)
    expect(composerSubmitBlocked({ externallyOwned: sessionExternallyOwned(local), projectDirectoryUnavailable: false })).toBe(false)
  })

  it('12: blocks submit when the project directory is unavailable', () => {
    const submitBlocked = composerSubmitBlocked({ externallyOwned: false, projectDirectoryUnavailable: true })

    expect(submitBlocked).toBe(true)
    expect(composerControlLabel({ projectDirectoryUnavailable: true, externallyOwned: false })).toBe('Project directory is no longer available')
  })
})
