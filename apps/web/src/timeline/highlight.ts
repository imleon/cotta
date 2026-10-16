import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubLight from 'shiki/themes/github-light.mjs'
import type { TokensResult } from 'shiki/types'

const languageLoaders = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  docker: () => import('shiki/langs/dockerfile.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  js: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  make: () => import('shiki/langs/makefile.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sass: () => import('shiki/langs/sass.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ts: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
} as const

type HighlightLanguage = keyof typeof languageLoaders

const languageAliases: Record<string, HighlightLanguage> = {
  'c#': 'csharp',
  'c++': 'cpp',
  cjs: 'js',
  cs: 'csharp',
  cts: 'ts',
  dockerfile: 'docker',
  gql: 'graphql',
  javascript: 'js',
  kt: 'kotlin',
  kts: 'kotlin',
  makefile: 'make',
  md: 'markdown',
  mjs: 'js',
  mts: 'ts',
  objc: 'objective-c',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  protobuf: 'proto',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  tf: 'terraform',
  tfvars: 'terraform',
  typescript: 'ts',
  yml: 'yaml',
  zsh: 'bash',
}

const highlighterPromise = createHighlighterCore({
  themes: [githubLight],
  langs: [],
  engine: createJavaScriptRegexEngine(),
})
const languagePromises = new Map<HighlightLanguage, Promise<void>>()

export function resolveHighlightLanguage(language: string | null): HighlightLanguage | null {
  if (!language) return null
  const normalized = language.toLowerCase()
  if (normalized in languageLoaders) return normalized as HighlightLanguage
  return languageAliases[normalized] ?? null
}

async function loadLanguage(language: HighlightLanguage) {
  let pending = languagePromises.get(language)
  if (!pending) {
    pending = Promise.all([highlighterPromise, languageLoaders[language]()])
      .then(([highlighter, module]) => highlighter.loadLanguage(module.default))
      .catch((error) => {
        if (languagePromises.get(language) === pending) languagePromises.delete(language)
        throw error
      })
    languagePromises.set(language, pending)
  }
  await pending
  return highlighterPromise
}

export async function highlightCode(code: string, language: string | null): Promise<string | null> {
  const resolved = resolveHighlightLanguage(language)
  if (!resolved) return null
  const highlighter = await loadLanguage(resolved)
  return highlighter.codeToHtml(code, { lang: resolved, theme: 'github-light' })
}

export async function tokenizeCode(code: string, language: string | null): Promise<TokensResult | null> {
  const resolved = resolveHighlightLanguage(language)
  if (!resolved) return null
  const highlighter = await loadLanguage(resolved)
  return highlighter.codeToTokens(code, { lang: resolved, theme: 'github-light' })
}
