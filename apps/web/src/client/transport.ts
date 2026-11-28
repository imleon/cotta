/**
 * The single network boundary between the web UI and one Cotta backend instance.
 *
 * Every request the UI makes — HTTP, server-sent events, WebSockets and URLs handed to the browser
 * (e.g. image `src`) — goes through a transport bound to one target. Today the only implementation is
 * same-origin (the backend that served the page). Later transports (a specific machine over SSH, or the
 * Relay) implement the same interface; components never inspect which one they have, and there is no
 * global, mutable "active endpoint".
 */
export type CottaTransport = {
  /** Performs an HTTP request against an absolute backend path such as `/api/projects`. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Opens a server-sent event stream for an absolute backend path. */
  eventSource(path: string): EventSource
  /** Opens a WebSocket for an absolute backend path. */
  webSocket(path: string): WebSocket
  /** Turns an absolute backend path into a URL the browser can load directly (e.g. `<img src>`). */
  resolveUrl(path: string): string
}

export function createSameOriginTransport(): CottaTransport {
  return {
    // Resolve the globals at call time so test stubs installed after module load are honoured, and
    // forward exactly the arguments given so the request is identical to a direct `fetch` call.
    fetch: (path, init) => (init === undefined ? fetch(path) : fetch(path, init)),
    eventSource: (path) => new EventSource(path),
    webSocket: (path) => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`),
    resolveUrl: (path) => path,
  }
}

/** The backend that served this page. Immutable: binding to another target means creating another transport. */
export const sameOriginTransport: CottaTransport = createSameOriginTransport()
