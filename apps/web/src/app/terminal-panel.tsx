import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const TERMINAL_RESIZE_DEBOUNCE_MS = 100

type TerminalConnection = 'idle' | 'connecting' | 'connected' | 'failed'
type BubblewrapAvailability = 'checking' | 'available' | 'missing' | 'error'

type TerminalPanelProps = {
  className?: string
  open?: boolean
  onClose: () => void
  onConnectedChange?: (connected: boolean) => void
}

export function TerminalPanel({ className, open = true, onClose, onConnectedChange }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<((closeSocket?: boolean) => void) | null>(null)
  const openRef = useRef(open)
  const resizeRef = useRef<(() => void) | null>(null)
  const [connection, setConnection] = useState<TerminalConnection>('idle')
  const [connectRequest, setConnectRequest] = useState(0)
  const [bubblewrapAvailability, setBubblewrapAvailability] = useState<BubblewrapAvailability>('checking')
  const [status, setStatus] = useState<string | null>(null)
  const [inputFocused, setInputFocused] = useState(false)
  const [terminating, setTerminating] = useState(false)

  const cleanupConnection = (closeSocket = true) => {
    cleanupRef.current?.(closeSocket)
    cleanupRef.current = null
  }

  const resetToIdle = (message: string | null) => {
    cleanupConnection()
    setConnection('idle')
    setStatus(message)
    setTerminating(false)
  }

  const connect = () => {
    if (bubblewrapAvailability !== 'available') return
    cleanupConnection()
    setConnection('connecting')
    setConnectRequest((current) => current + 1)
    setStatus(null)
    setTerminating(false)
  }

  useLayoutEffect(() => {
    if (!connectRequest) return
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      fontFamily: getComputedStyle(host).fontFamily,
      fontSize: 12,
      fontWeight: '400',
      lineHeight: 1.15,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#2b2b2b',
        foreground: '#cccccc',
        cursor: '#aeafad',
        cursorAccent: '#181818',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#cd3131',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    setInputFocused(false)
    const onFocus = () => setInputFocused(true)
    const onBlur = (event: FocusEvent) => {
      if (!host.contains(event.relatedTarget as Node | null)) setInputFocused(false)
    }
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    let socket: WebSocket | null = null
    let sentDimensions: { cols: number; rows: number } | null = null
    let pendingDimensions: { cols: number; rows: number } | null = null
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null
    let observedSize: { width: number; height: number } | null = null
    let socketOpen = false
    let layoutReady = false
    let disposed = false
    const flushResize = () => {
      resizeTimeout = null
      const dimensions = pendingDimensions
      pendingDimensions = null
      if (!dimensions || !socketOpen || !socket || (sentDimensions?.cols === dimensions.cols && sentDimensions.rows === dimensions.rows)) return
      sentDimensions = dimensions
      socket.send(JSON.stringify({ type: 'resize', ...dimensions }))
    }
    const resize = () => {
      if (!openRef.current) return
      fitAddon.fit()
      pendingDimensions = { cols: terminal.cols, rows: terminal.rows }
      if (socketOpen && resizeTimeout === null) resizeTimeout = setTimeout(flushResize, TERMINAL_RESIZE_DEBOUNCE_MS)
    }
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    const dispose = (closeSocket = true) => {
      if (disposed) return
      disposed = true
      if (resizeTimeout !== null) clearTimeout(resizeTimeout)
      input.dispose()
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('focusout', onBlur)
      observer.disconnect()
      if (resizeRef.current === resize) resizeRef.current = null
      setInputFocused(false)
      if (closeSocket) socket?.close()
      terminal.dispose()
    }
    const createSocket = () => {
      if (disposed || socket || !layoutReady) return
      resize()
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`)
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        if (disposed) return
        socketOpen = true
        setConnection('connected')
        setStatus(null)
        onConnectedChange?.(true)
        flushResize()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: string; exitCode?: number; signal?: string | null }
            if (message.type === 'exit') {
              resetToIdle(`Terminal exited${message.exitCode === undefined ? '' : ` (${message.exitCode})`}${message.signal ? `: ${message.signal}` : ''}.`)
              onConnectedChange?.(false)
            }
          } catch {
            setStatus('Terminal sent an invalid response.')
          }
        } else if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data))
      }
      socket.onerror = () => {
        if (!disposed) {
          cleanupConnection()
          setConnection('failed')
          setStatus('Terminal connection failed.')
          setTerminating(false)
          onConnectedChange?.(false)
        }
      }
      socket.onclose = (event) => {
        if (disposed) return
        cleanupConnection(false)
        if (event.code === 1000) {
          setConnection('idle')
          setStatus('Terminal exited.')
        } else {
          setConnection('failed')
          setStatus((current) => (current ?? event.reason) || 'Terminal connection closed.')
        }
        setTerminating(false)
        onConnectedChange?.(false)
      }
    }
    resizeRef.current = resize
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.contentRect
      if (!size || (observedSize?.width === size.width && observedSize.height === size.height)) return
      observedSize = { width: size.width, height: size.height }
      layoutReady = true
      if (socket) resize()
      else createSocket()
    })
    observer.observe(host)
    cleanupRef.current = dispose
    return () => {
      if (cleanupRef.current === dispose) cleanupRef.current = null
      dispose()
    }
  }, [connectRequest])

  const terminate = async () => {
    setTerminating(true)
    try {
      const response = await fetch('/api/terminal', { method: 'DELETE' })
      if (!response.ok) throw new Error()
      cleanupConnection(false)
      setConnection('idle')
      setStatus('Terminal exited.')
      setTerminating(false)
      onConnectedChange?.(false)
    } catch {
      setStatus('Could not terminate terminal.')
      setTerminating(false)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetch('/api/terminal')
      .then(async (response) => {
        if (!response.ok) throw new Error()
        const body = (await response.json()) as { available?: unknown }
        if (typeof body.available !== 'boolean') throw new Error()
        if (!cancelled) {
          setBubblewrapAvailability(body.available ? 'available' : 'missing')
        }
      })
      .catch(() => {
        if (!cancelled) setBubblewrapAvailability('error')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => () => cleanupConnection(), [])

  useLayoutEffect(() => {
    openRef.current = open
    if (open) requestAnimationFrame(() => resizeRef.current?.())
  }, [open])

  const terminalActive = connection === 'connecting' || connection === 'connected'
  const canConnect = connection === 'idle' || connection === 'failed'

  return (
    <aside id="terminal-panel" className={`terminal-panel ${className ?? ''}`.trim()} data-connection={connection} aria-label="Terminal" hidden={!open}>
      <header className="terminal-panel-header workspace-main-header workspace-panel-header">
        <div className="project-title-block">
          <svg viewBox="0 0 24 24" className="project-card-folder-icon" aria-hidden="true" data-icon="TerminalOutlined">
            <path d="M3 3h18v13H3zM9 20h6M12 16v4M7 8l3 2.5L7 13m6 0h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="project-name">Terminal</span>
        </div>
        <button type="button" className="workspace-pane-toggle" onClick={onClose} aria-label="Close terminal" title="Close terminal">
          ×
        </button>
      </header>
      <div className="terminal-panel-body">
        {terminalActive ? (
          <div className="terminal-panel-controls">
            <div className="terminal-panel-status">
              <span className="terminal-panel-input-status" data-focused={inputFocused} role="img" aria-label={inputFocused ? 'Terminal input focused' : 'Terminal input unfocused'} />
              <span data-state={connection}>{status ? status.replace(/^Terminal /, '') : connection}</span>
            </div>
            <div className="terminal-panel-controls-end">
              {connection === 'connected' ? (
                <button type="button" className="terminal-panel-terminate" onClick={() => void terminate()} disabled={terminating}>
                  {terminating ? 'Exiting…' : 'Exit'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="terminal-panel-screen" data-active={terminalActive ? 'true' : 'false'} data-input-focused={inputFocused}>
          {canConnect ? (
            <div className="terminal-panel-connect-card">
              <strong>{connection === 'failed' ? 'Terminal disconnected' : bubblewrapAvailability === 'missing' ? 'Bubblewrap required' : 'Sandboxed Terminal'}</strong>
              <p>
                Connect to a <strong>Bubblewrap-sandboxed terminal</strong> (
                <a href="https://github.com/imleon/cotta" target="_blank" rel="noreferrer" aria-label="Learn more about Cotta Terminal">
                  learn more
                </a>
                ). Your home stays available; the rest of your system is isolated.
              </p>
              {bubblewrapAvailability === 'checking' ? <p className="terminal-panel-connect-status">Checking Bubblewrap…</p> : null}
              {bubblewrapAvailability === 'missing' ? (
                <p className="terminal-panel-connect-status">
                  Bubblewrap isn’t installed. It’s a standard Linux sandbox tool—ask your agent to install <code>bubblewrap</code>, then reopen Terminal.
                </p>
              ) : null}
              {bubblewrapAvailability === 'error' ? <p className="terminal-panel-connect-status">We couldn’t check Bubblewrap. Reopen Terminal and try again.</p> : null}
              {status ? <p className="terminal-panel-connect-status">{status}</p> : null}
              <button type="button" className="terminal-panel-connect" onClick={connect} disabled={bubblewrapAvailability !== 'available'}>
                Connect
              </button>
            </div>
          ) : null}
          <div ref={hostRef} className="terminal-panel-mount" aria-hidden={terminalActive ? undefined : true} />
        </div>
      </div>
    </aside>
  )
}
