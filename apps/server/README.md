# Cotta

Web-first dashboard for your Claude Code projects and sessions. Cotta serves a web UI and an
API from a single local process, reading your existing Claude Code transcripts so you can browse,
continue, and manage sessions from the browser.

## Prerequisites

- **Node.js ≥ 22.13** — Cotta uses the built-in `node:sqlite` module, which runs without a flag starting in 22.13.0.
- **Claude Code CLI, installed and logged in** — Cotta drives sessions through the Claude Agent SDK
  using your machine's existing Claude Code credentials (`~/.claude`). Install and sign in to
  Claude Code first.
- **A GitHub account** — sign-in uses GitHub Device Flow and is restricted to a single GitHub user.

## Install

```bash
npm install -g ./cotta-<version>.tgz
```

No native build toolchain is required on common platforms — the terminal's pty dependency ships
prebuilt binaries.

## First run

Run `cotta start` in an interactive terminal. On first launch it prompts for the single GitHub
username allowed to sign in, stores it (in the local database, not env), then starts the server in
the background:

```bash
cotta start
```

When it prints `Cotta started at http://127.0.0.1:3000`, open that URL, sign in via the
GitHub device flow, and you're in.

To change the allowed user later, either use **Settings → Change account** in the UI,
or restart with:

```bash
cotta stop
cotta start --reconfigure-github
```

## Commands

```bash
cotta start            # start in the background
cotta start -f         # run in the foreground
cotta status           # show status (exit 3 when not running)
cotta stop             # stop the server
cotta restart          # restart in the background
cotta uninstall        # stop, delete ~/.cotta, and run npm uninstall -g cotta (refuses while COTTA_DB_PATH is set)
```

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose Cotta to other machines. |
| `PORT` | `3000` | Listen port. |
| `COTTA_DB_PATH` | `~/.cotta/cotta.sqlite` | SQLite read-model path. The pidfile (`cotta.pid`), daemon log (`cotta.log`) and share assets live in the same directory. |
| `COTTA_COOKIE_SECURE` | unset | Set `true` when serving over HTTPS so the session cookie is marked Secure. |
| `COTTA_TERMINAL_ORIGIN` | unset | Allowed Origin for the terminal WebSocket. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Cotta reads Claude Code transcripts and session state. |

Cotta creates the database and its directory on first start; no manual migration is needed.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
