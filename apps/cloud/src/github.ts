// Cotta's own GitHub OAuth App (identity only, no scopes) — the same app the daemon's device-flow login uses.
export const GITHUB_CLIENT_ID = 'Ov23liMLUPsdQ154njI3'

export type GitHubDeviceCode = { deviceCode: string; userCode: string; verificationUri: string; expiresInS: number; intervalS: number }
export type GitHubTokenPoll = { status: 'approved'; accessToken: string } | { status: 'pending' } | { status: 'slow_down'; intervalS: number } | { status: 'expired' } | { status: 'denied' }
export type GitHubUser = { id: number; login: string }

/** The three GitHub calls the device-flow login needs; injected so tests never reach GitHub. */
export type GitHubClient = {
  startDeviceFlow(): Promise<GitHubDeviceCode>
  pollToken(deviceCode: string): Promise<GitHubTokenPoll>
  user(accessToken: string): Promise<GitHubUser>
}

export class GitHubError extends Error {}

export function createGitHubClient(fetchImpl: typeof fetch = fetch): GitHubClient {
  async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cotta-cloud' },
      body: new URLSearchParams(body),
    })
    if (!response.ok) throw new GitHubError(`GitHub ${new URL(url).pathname} failed: ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  }

  return {
    async startDeviceFlow() {
      const body = await form('https://github.com/login/device/code', { client_id: GITHUB_CLIENT_ID, scope: '' })
      if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string' || typeof body.verification_uri !== 'string') throw new GitHubError('Unexpected device code response')
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresInS: Number(body.expires_in) || 900,
        intervalS: Number(body.interval) || 5,
      }
    },
    async pollToken(deviceCode) {
      const body = await form('https://github.com/login/oauth/access_token', { client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      if (typeof body.access_token === 'string') return { status: 'approved', accessToken: body.access_token }
      switch (body.error) {
        case 'authorization_pending':
          return { status: 'pending' }
        case 'slow_down':
          return { status: 'slow_down', intervalS: Number(body.interval) || 10 }
        case 'expired_token':
          return { status: 'expired' }
        case 'access_denied':
          return { status: 'denied' }
        default:
          throw new GitHubError(`GitHub token poll failed: ${String(body.error)}`)
      }
    },
    async user(accessToken) {
      const response = await fetchImpl('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'cotta-cloud' },
      })
      if (!response.ok) throw new GitHubError(`GitHub user lookup failed: ${response.status}`)
      const body = (await response.json()) as { id?: unknown; login?: unknown }
      if (typeof body.id !== 'number' || typeof body.login !== 'string') throw new GitHubError('Unexpected GitHub user response')
      return { id: body.id, login: body.login }
    },
  }
}
