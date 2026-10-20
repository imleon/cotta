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
 * display names immediately instead of the raw `default` sentinel.
 *
 * When `required` (the stock official-Anthropic path), a failure here is fatal: the web client's
 * lazy refresh would fail the same way, so we surface it at boot. When a provider is active its
 * upstream isn't authenticated until the user logs in via the web UI, so a boot failure is expected
 * — warn and defer to the post-login lazy refresh (POST /api/settings/model-catalog/refresh).
 */
export async function ensureModelCatalog(store: SettingsStore, provider: ModelCatalogProvider, opts: { required?: boolean } = {}): Promise<void> {
  const required = opts.required ?? true
  if (readSettings(store).modelCatalog) return
  try {
    store.setMany('global', { modelCatalog: await provider() })
  } catch (error) {
    if (!required) {
      console.warn('Model catalog unavailable at startup; deferring to post-login refresh.')
      return
    }
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
 * and stores config in the database (not env). On a TTY, prompt for the single allowed GitHub user and
 * persist it; without a TTY, abort with guidance. The createAuth guard is the final backstop.
 *
 * With `force`, re-run the interactive prompt even when config already exists (the
 * `cotta start --reconfigure-github` flag), pre-filling the current user so a blank answer keeps
 * it — this is also the recovery path if an operator locks themselves out of the allowlist.
 */
export async function ensureGithubConfig(store: SettingsStore, opts: { force?: boolean; prompt?: Prompt; isTTY?: boolean } = {}): Promise<void> {
  const existing = loadGithubConfig(store)
  const validUser = isSingleUser(existing.allowedUsers) ? existing.allowedUsers : null
  if (!opts.force && validUser) return
  const isTTY = opts.isTTY ?? stdin.isTTY
  if (!opts.prompt && !isTTY) {
    console.error(
      opts.force
        ? 'Cannot reconfigure GitHub login without an interactive terminal. Run `cotta start --reconfigure-github` from a TTY.'
        : existing.allowedUsers && !validUser
          ? `Stored GitHub allowed user "${existing.allowedUsers}" is invalid: Cotta now allows exactly one GitHub user. Run \`cotta start --reconfigure-github\` from an interactive terminal to fix it.`
          : 'GitHub login is not configured. Run `cotta start` in an interactive terminal to set it up.',
    )
    process.exit(1)
  }
  const rl = opts.prompt ? null : createInterface({ input: stdin, output: stdout })
  const prompt: Prompt = opts.prompt ?? ((question) => rl!.question(question))
  try {
    if (!opts.force) {
      console.log('Cotta uses GitHub sign-in restricted to a single user.\n')
    }
    const allowedUser = (await prompt(`GitHub username allowed to sign in (not email)${validUser ? ` [${validUser}]` : ''}: `)).trim() || validUser || ''
    if (!allowedUser) {
      console.error('A GitHub username is required.')
      process.exit(1)
    }
    if (!isSingleUser(allowedUser)) {
      console.error('Exactly one GitHub user is allowed.')
      process.exit(1)
    }
    // saveGithubConfig revokes every stored auth session atomically when the allowed user changes, so an operator
    // who only inspects the value keeps their session; the recovery path still locks out the previous user
    // whenever the allowed login actually changes.
    saveGithubConfig(store, { allowedUsers: allowedUser })
  } finally {
    rl?.close()
  }
}
