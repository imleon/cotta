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

Run the web app:

```bash
npm run dev:web
```
