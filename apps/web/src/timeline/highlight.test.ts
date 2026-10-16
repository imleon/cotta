import { afterEach, describe, expect, it, vi } from 'vitest'
import { highlightCode, resolveHighlightLanguage, tokenizeCode } from './highlight'

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('shiki/core')
  vi.doUnmock('shiki/engine/javascript')
  vi.doUnmock('shiki/themes/github-light.mjs')
  vi.doUnmock('shiki/langs/typescript.mjs')
})

describe('timeline syntax highlighting', () => {
  it('normalizes supported language aliases', () => {
    expect(resolveHighlightLanguage('javascript')).toBe('js')
    expect(resolveHighlightLanguage('typescript')).toBe('ts')
    expect(resolveHighlightLanguage('shell')).toBe('bash')
    expect(resolveHighlightLanguage('yml')).toBe('yaml')
    expect(resolveHighlightLanguage('dockerfile')).toBe('docker')
    expect(resolveHighlightLanguage('makefile')).toBe('make')
    expect(resolveHighlightLanguage('ps1')).toBe('powershell')
    expect(resolveHighlightLanguage('tfvars')).toBe('terraform')
  })

  it('rejects unsupported languages explicitly', async () => {
    expect(resolveHighlightLanguage('text')).toBeNull()
    expect(resolveHighlightLanguage('wolfram')).toBeNull()
    await expect(highlightCode('x', 'wolfram')).resolves.toBeNull()
    await expect(tokenizeCode('x', 'wolfram')).resolves.toBeNull()
  })

  it('loads supported languages on demand', async () => {
    await expect(highlightCode('const value = 1', 'ts')).resolves.toContain('class="shiki github-light"')
    await expect(tokenizeCode('const value = 1', 'ts')).resolves.toMatchObject({ tokens: expect.any(Array) })
    for (const language of ['docker', 'make', 'dotenv', 'hcl', 'terraform', 'powershell']) {
      await expect(highlightCode('value = 1', language)).resolves.toContain('class="shiki github-light"')
      await expect(tokenizeCode('value = 1', language)).resolves.toMatchObject({ tokens: expect.any(Array) })
    }
  })

  it('retries loading a language after a transient failure', async () => {
    const loadLanguage = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
    vi.doMock('shiki/core', () => ({
      createHighlighterCore: () =>
        Promise.resolve({
          loadLanguage,
          codeToHtml: () => '<pre class="shiki github-light">ok</pre>',
        }),
    }))
    vi.doMock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }))
    vi.doMock('shiki/themes/github-light.mjs', () => ({ default: {} }))
    vi.doMock('shiki/langs/typescript.mjs', () => ({ default: { name: 'ts' } }))

    const { highlightCode: freshHighlightCode } = await import('./highlight')
    await expect(freshHighlightCode('const value = 1', 'ts')).rejects.toThrow('transient')
    await expect(freshHighlightCode('const value = 1', 'ts')).resolves.toContain('shiki github-light')
    expect(loadLanguage).toHaveBeenCalledTimes(2)
  })
})
