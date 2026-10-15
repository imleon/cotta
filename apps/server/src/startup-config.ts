import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { isSingleUser } from '@cotta/shared'
import { loadGithubConfig, saveGithubConfig } from './auth.js'
import type { ModelCatalogProvider } from './model-catalog.js'
import type { SettingsStore } from './settings-store.js'
import { readSettings } from './turn-options.js'

type Prompt = (question: string) => Promise<string>

/**
 * Seeds the model catalog on first startup so the composer and Settings show real model
 * display names immediately instead of the raw `default` sentinel. The catalog is a hard
 * startup dependency: if the SDK can't produce it here, the web client's lazy refresh would
 * fail the same way, so we let the error surface at boot rather than hide it.
 */
export async function ensureModelCatalog(store: SettingsStore, provider: ModelCatalogProvider): Promise<void> {
  if (readSettings(store).modelCatalog) return
  try {
    store.setMany('global', { modelCatalog: await provider() })
  } catch (error) {
    console.error(
      'Failed to load the model catalog from the Claude Agent SDK on startup. ' +
        'This usually means the SDK is unauthenticated or the claude binary is unavailable. ' +
        'Fix SDK access and restart Cotta.',
    )
    throw error
  }
}

/**
 * Ensures GitHub login config exists before the server starts. Cotta is GitHub-login-only
 * and stores config in the database (not env). On a TTY, prompt for the two required values and
 * persist them; without a TTY, abort with guidance. The createAuth guard is the final backstop.
 *
 * With `force`, re-run the interactive prompt even when config already exists (the
 * `--reconfigure-github` startup flag), pre-filling the current values so a blank answer keeps
 * them — this is also the recovery path if an operator locks themselves out of the allowlist.
 */
export async function ensureGithubConfig(store: SettingsStore, opts: { force?: boolean; prompt?: Prompt; isTTY?: boolean } = {}): Promise<void> {
  const existing = loadGithubConfig(store)
  const validUser = isSingleUser(existing.allowedUsers) ? existing.allowedUsers : null
  if (!opts.force && existing.clientId && validUser) return
  const isTTY = opts.isTTY ?? stdin.isTTY
  if (!opts.prompt && !isTTY) {
    console.error(
      opts.force
        ? 'Cannot reconfigure GitHub login without an interactive terminal. Run with --reconfigure-github from a TTY.'
        : existing.allowedUsers && !validUser
          ? `Stored GitHub allowed user "${existing.allowedUsers}" is invalid: Cotta now allows exactly one GitHub user. Run with --reconfigure-github from an interactive terminal to fix it.`
          : 'GitHub login is not configured. Run Cotta once in an interactive terminal to set it up.',
    )
    process.exit(1)
  }
  const rl = opts.prompt ? null : createInterface({ input: stdin, output: stdout })
  const prompt: Prompt = opts.prompt ?? ((question) => rl!.question(question))
  try {
    if (!opts.force) {
      console.log('Cotta uses GitHub sign-in restricted to a single user via your own OAuth App.')
      console.log('Create one at https://github.com/settings/developers (New OAuth App), enable Device Flow, then enter its details below.\n')
    }
    const clientId = (await prompt(`GitHub OAuth App Client ID (starts with "Ov23li")${existing.clientId ? ` [${existing.clientId}]` : ''}: `)).trim() || existing.clientId || ''
    const allowedUser = (await prompt(`GitHub username allowed to sign in (not email)${validUser ? ` [${validUser}]` : ''}: `)).trim() || validUser || ''
    if (!clientId || !allowedUser) {
      console.error('Both values are required.')
      process.exit(1)
    }
    if (!isSingleUser(allowedUser)) {
      console.error('Exactly one GitHub user is allowed.')
      process.exit(1)
    }
    // saveGithubConfig revokes every stored auth session atomically when the allowed user changes, so an operator
    // who only inspects values or edits the client ID keeps their session; the recovery path still
    // locks out the previous user whenever the allowed login actually changes.
    saveGithubConfig(store, { clientId, allowedUsers: allowedUser })
  } finally {
    rl?.close()
  }
}
