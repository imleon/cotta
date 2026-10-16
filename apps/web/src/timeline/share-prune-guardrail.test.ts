import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SHARE_RESULT_SHAPE_TOOLS, shareWhitelistedTools } from '@cotta/shared'
import { describe, expect, it } from 'vitest'

// Guardrail: a new tool with its own collapsed header must be taught to the Share pruner, or its body leaks / its header
// breaks. We derive the set of specially-rendered tools straight from the dispatch in tools.tsx and cross-check it against
// the Share whitelist in @cotta/shared. Adding a `toolName === 'X'` branch without a whitelist entry fails here, in CI.
const toolsSource = readFileSync(fileURLToPath(new URL('./tools.tsx', import.meta.url)), 'utf8')
const dispatchedTools = [...toolsSource.matchAll(/toolName === '([A-Za-z]+)'/g)].map((match) => match[1])

// EnterPlanMode's header reads only results.length — no input or result shape — so the generic prune is correct for it.
const GENERIC_OK = new Set(['EnterPlanMode'])

describe('share pruning guardrail', () => {
  it('every specially-rendered tool is covered by the Share input whitelist', () => {
    const whitelist = new Set(shareWhitelistedTools())
    const missing = [...new Set(dispatchedTools)].filter((name) => !whitelist.has(name) && !GENERIC_OK.has(name))
    expect(missing, `tools with a dedicated header but no SHARE_INPUT_KEYS entry: ${missing.join(', ')}`).toEqual([])
  })

  it('result-shape tools are a subset of whitelisted tools', () => {
    const whitelist = new Set(shareWhitelistedTools())
    const stray = SHARE_RESULT_SHAPE_TOOLS.filter((name) => !whitelist.has(name))
    expect(stray, `result-shape tools missing from the input whitelist: ${stray.join(', ')}`).toEqual([])
  })
})
