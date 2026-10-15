# Cotta

Web-first dashboard for your Claude Code projects and sessions. Cotta serves a web UI and an
API from a single local process, reading your existing Claude Code transcripts so you can browse,
continue, and manage sessions from the browser.

## Prerequisites

- **Node.js ≥ 22.5** — Cotta uses the built-in `node:sqlite` module, added in 22.5.0.
- **Claude Code CLI, installed and logged in** — Cotta drives sessions through the Claude Agent SDK
  using your machine's existing Claude Code credentials (`~/.claude`). Install and sign in to
  Claude Code first.
- **A GitHub OAuth App (Device Flow)** — sign-in is restricted to a single GitHub user via your own
  OAuth App. Create one at <https://github.com/settings/developers> → **New OAuth App**, then enable
  **Device Flow** in its settings. You'll need its **Client ID** (starts with `Ov23li`).

## Install

```bash
npm install -g ./cotta-<version>.tgz
```

No native build toolchain is required on common platforms — the terminal's pty dependency ships
prebuilt binaries.

## First run

Run `cotta` in an interactive terminal. On first launch it prompts for your OAuth App Client ID and
the single GitHub username allowed to sign in, then stores them (in the local database, not env):

```bash
cotta
```

When it prints `Cotta server listening on http://127.0.0.1:3000`, open that URL, sign in via the
GitHub device flow, and you're in.

To change the OAuth App or allowed user later, either use **Settings → Change account** in the UI,
or restart with:

```bash
cotta --reconfigure-github
```

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose Cotta to other machines. |
| `PORT` | `3000` | Listen port. |
| `COTTA_DB_PATH` | `data/cotta.sqlite` (relative to cwd) | SQLite read-model path. **Set an absolute path** so the database doesn't move when you run `cotta` from different directories. |
| `COTTA_COOKIE_SECURE` | unset | Set `true` when serving over HTTPS so the session cookie is marked Secure. |
| `COTTA_TERMINAL_ORIGIN` | unset | Allowed Origin for the terminal WebSocket. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Cotta reads Claude Code transcripts and session state. |

Cotta creates the database and its directory on first start; no manual migration is needed.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
