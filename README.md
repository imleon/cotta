# Cotta v2

Cotta v2 is a Web-first Claude Code Project Dashboard.

The MVP goal is to let Claude Code project/session work continue outside the terminal: discover Claude Code projects and sessions through official APIs, render historical and live session timelines, continue existing sessions, create new sessions inside existing projects, and interrupt a running turn.

See:

- `docs/product-goal-v2.md` — product goal and MVP boundaries
- `docs/development-plan-v2-mvp.md` — phased development plan
- `docs/agent-sdk-capability-spike.md` — Agent SDK capability findings

## MVP architecture

```text
apps/server      Hono + Claude Agent SDK + HTTP/SSE
apps/web         React + Vite + TanStack Query
packages/shared  Shared API, event, and timeline types
```

## Current skeleton

```bash
npm install
npm run build
npm test
```

Run the server:

```bash
npm run dev
```

The API server listens on `127.0.0.1:3000` by default. This is intentional for remote development: the Vite web dev server is the remote-facing entrypoint and proxies `/api` to the local API server. Override only when you intentionally want to expose the API server directly:

```bash
HOST=0.0.0.0 PORT=3001 npm run dev
```

Optional token protection:

```bash
COTTA_AUTH_TOKEN=dev-secret npm run dev
```

When `COTTA_AUTH_TOKEN` is set, API and SSE requests must include either `?token=dev-secret` or `Authorization: Bearer dev-secret`. `/api/health` remains unauthenticated for health checks.

Run the web app:

```bash
npm run dev:web
```

`npm run dev:web` listens on `0.0.0.0:5173`, so for remote development open the Web UI from your local browser with the remote development machine's IP and the same token when auth is enabled:

```text
http://<remote-host>:5173/?token=dev-secret
```
