import { defineConfig } from 'tsup'

// Bundles the server (TS source) + the workspace-only @cotta/shared into one self-contained ESM file
// so the published tarball needs no workspace symlink. Everything in `dependencies` stays external and
// is installed by the user; @cotta/shared is inlined, but its own runtime deps (zod/saxes/
// micromark-util-sanitize-uri) are kept external and re-declared in this package's dependencies.
// Keep those three versions in sync with packages/shared/package.json — they ship inlined shared code,
// so a drift to a different major could change that code's runtime behavior.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: ['@cotta/shared'],
  external: ['zod', 'saxes', 'micromark-util-sanitize-uri'],
  // node:sqlite is stable-enough but still flagged experimental, so Node prints an ExperimentalWarning
  // on every start. The Agent SDK warns on every query() that canUseTool is shadowed under
  // bypassPermissions, but Cotta relies on it there for AskUserQuestion / ExitPlanMode prompts.
  // Silence just those two; other warnings still surface.
  banner: { js: '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  // tsup strips the `node:` prefix from builtins by default; that turns node:sqlite into a bare
  // `sqlite` specifier Node can't resolve. Keep every node: prefix verbatim.
  removeNodeProtocol: false,
})
