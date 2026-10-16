import type { SubmitState } from '../timeline/core'

export const UNKNOWN_SUBMISSION_RECOVERY_MS = 10_000
export type ComposerActionMode = 'loading' | 'stop' | 'submit'

export function composerSubmitBlocked(input: { externallyOwned: boolean; projectDirectoryUnavailable: boolean }): boolean {
  return input.externallyOwned || input.projectDirectoryUnavailable
}

export function composerSessionBusy(session: { occupiedBy: 'cotta' | 'external' | null; occupiedStatus: 'idle' | 'busy' | 'waiting' | 'background' } | null | undefined): boolean {
  return session?.occupiedBy === 'cotta' && session.occupiedStatus !== 'idle' && session.occupiedStatus !== 'background'
}

export function composerActionMode(input: { submitState: SubmitState; canStop: boolean }): ComposerActionMode {
  if (input.submitState === 'submitting' || input.submitState === 'stopping') return 'loading'
  return input.submitState === 'busy' && input.canStop ? 'stop' : 'submit'
}

export function composerControlLabel(input: { projectDirectoryUnavailable: boolean; externallyOwned: boolean }): string | null {
  return input.projectDirectoryUnavailable ? 'Project directory is no longer available' : input.externallyOwned ? 'Controlled by an external Claude Code client' : null
}
