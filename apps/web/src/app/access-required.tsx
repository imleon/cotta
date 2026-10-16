import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { pollGitHubDeviceLogin, startGitHubDeviceLogin } from '../api'
import logoUrl from '../assets/logo.svg'
import { writeClipboard } from '../timeline/content'

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M4 13V5a1 1 0 0 1 1-1h8" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 10.5 4 4L16 6" />
    </svg>
  )
}

export function AccessRequired() {
  const queryClient = useQueryClient()
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number>(undefined)

  useEffect(() => {
    if (!flow) return
    let stopped = false
    let timer: number
    const poll = async () => {
      try {
        const response = await pollGitHubDeviceLogin(flow.flowId)
        if (stopped) return
        if (response.status === 'authorized') {
          await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
          return
        }
        timer = window.setTimeout(poll, response.interval * 1000)
      } catch (error) {
        if (stopped) return
        setError(error instanceof Error ? error.message : String(error))
        setFlow(null)
      }
    }
    timer = window.setTimeout(poll, flow.interval * 1000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [flow, queryClient])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  async function startLogin() {
    setError(null)
    setStarting(true)
    try {
      setFlow(await startGitHubDeviceLogin())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  async function copyCode() {
    if (!flow) return
    try {
      await writeClipboard(flow.userCode)
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <img className="login-logo" src={logoUrl} alt="Cotta" />
        <h2 className="login-title">Claude Code on Web</h2>
        {flow ? (
          <div className="login-device-flow">
            <p className="muted">Open GitHub and enter the code:</p>
            <button type="button" className="login-code" onClick={copyCode} title="Copy code">
              <span>{flow.userCode}</span>
              <span className="login-code-copy" role="img" aria-label={copied ? 'Copied' : 'Copy'}>
                {copied ? <CheckIcon /> : <CopyIcon />}
              </span>
            </button>
            <a className="login-primary" href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer">
              <GitHubMark />
              Open GitHub to authorize
            </a>
            <p className="muted login-waiting">
              <span className="login-spinner" aria-hidden="true" /> Waiting for authorization…
            </p>
          </div>
        ) : (
          <button type="button" className="login-primary" onClick={startLogin} disabled={starting}>
            {starting ? <span className="login-spinner" aria-hidden="true" /> : <GitHubMark />}
            {starting ? 'Starting…' : 'Sign in with GitHub'}
          </button>
        )}
        {error ? <div className="panel error">{error}</div> : null}
      </div>
    </main>
  )
}
