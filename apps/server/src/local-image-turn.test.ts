import type { TurnSummary } from '@cotta/shared'
import { describe, expect, it } from 'vitest'
import { resolveTurnImagePath, sanitizeTurnForShare, shareImageKey, turnImagePaths } from './local-image-turn.js'

/** Builds a turn whose single assistant message references `src` in its markdown, with optional per-message/turn cwd. */
function turnWith(src: string, cwd?: { message?: string; response?: string; user?: string }): TurnSummary {
  return {
    primaryUserUuid: 't',
    ...(cwd?.response ? { responseCwd: cwd.response } : {}),
    ...(cwd?.user ? { userCwd: cwd.user } : {}),
    messages: [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        ...(cwd?.message ? { cwd: cwd.message } : {}),
        message: { role: 'assistant', content: [{ type: 'text', text: `look ![shot](${src})` }] },
      },
    ],
  } as never
}

describe('resolveTurnImagePath', () => {
  it('returns null for a src the turn does not reference (authorization gate)', () => {
    expect(resolveTurnImagePath(turnWith('a.png', { message: '/proj' }), 'b.png')).toBeNull()
  })

  it('resolves an absolute src without needing a cwd', () => {
    expect(resolveTurnImagePath(turnWith('/abs/a.png'), '/abs/a.png')).toBe('/abs/a.png')
  })

  it('resolves a relative src against the owning message cwd', () => {
    expect(resolveTurnImagePath(turnWith('sub/a.png', { message: '/proj' }), 'sub/a.png')).toBe('/proj/sub/a.png')
  })

  it('needs a cwd for a relative src — null without one', () => {
    expect(resolveTurnImagePath(turnWith('a.png'), 'a.png')).toBeNull()
  })

  it('prefers message cwd over responseCwd over userCwd', () => {
    expect(resolveTurnImagePath(turnWith('a.png', { message: '/m', response: '/r', user: '/u' }), 'a.png')).toBe('/m/a.png')
    expect(resolveTurnImagePath(turnWith('a.png', { response: '/r', user: '/u' }), 'a.png')).toBe('/r/a.png')
    expect(resolveTurnImagePath(turnWith('a.png', { user: '/u' }), 'a.png')).toBe('/u/a.png')
  })

  it('rejects dangerous srcs even when referenced', () => {
    for (const bad of ['data:image/png;base64,xx', 'https://x/a.png', 'a\\b.png']) expect(resolveTurnImagePath(turnWith(bad, { message: '/proj' }), bad)).toBeNull()
  })
})

describe('turnImagePaths', () => {
  it('enumerates and dedups referenced images, emitting null for unresolvable', () => {
    const turn = {
      primaryUserUuid: 't',
      responseCwd: '/proj',
      messages: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '![a](a.png) ![a again](a.png)' }] } },
        { type: 'assistant', cwd: '/other', message: { role: 'assistant', content: [{ type: 'text', text: '![b](b.png) ![remote](https://x/c.png)' }] } },
      ],
    } as never
    expect(turnImagePaths(turn)).toEqual([
      { src: 'a.png', path: '/proj/a.png' },
      { src: 'b.png', path: '/other/b.png' },
    ])
  })
})

describe('sanitizeTurnForShare', () => {
  it('replaces local-image srcs with opaque keys and strips every cwd', () => {
    const turn = {
      primaryUserUuid: 't',
      userCwd: '/home/me/proj',
      responseCwd: '/home/me/proj',
      messages: [
        { type: 'user', message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          cwd: '/home/me/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'see ![a](/tmp/secret/a.png) and ![remote](https://x/c.png)' }] },
        },
      ],
    } as never as TurnSummary
    const keyBySrc = new Map([['/tmp/secret/a.png', shareImageKey(0)]])
    const sanitized = sanitizeTurnForShare(turn, keyBySrc)
    const text = JSON.stringify(sanitized)
    expect(text).not.toContain('/tmp/secret')
    expect(text).not.toContain('/home/me/proj')
    expect(sanitized.userCwd).toBeUndefined()
    expect(sanitized.responseCwd).toBeUndefined()
    expect(text).toContain('cotta-asset/0')
    expect(text).toContain('https://x/c.png') // remote image untouched
    expect(turn.userCwd).toBe('/home/me/proj') // source not mutated
  })

  it('strips cwd even when embedded mid-string (e.g. inside a Bash command), not just as a leading prefix', () => {
    const turn = {
      primaryUserUuid: 't',
      messages: [
        {
          type: 'assistant',
          cwd: '/home/me/proj',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat /home/me/proj/secret.txt' } }],
          },
        },
      ],
    } as never as TurnSummary
    const sanitized = sanitizeTurnForShare(turn, new Map())
    const text = JSON.stringify(sanitized)
    expect(text).not.toContain('/home/me/proj')
    expect(text).toContain('cat secret.txt')
  })

  it('rewrites reference-style image definitions too (parity with the mdast enumeration)', () => {
    const turn = {
      primaryUserUuid: 't',
      messages: [
        {
          type: 'assistant',
          cwd: '/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ref ![b][id]\n\n[id]: /tmp/secret/b.png' }] },
        },
      ],
    } as never as TurnSummary
    const sanitized = sanitizeTurnForShare(turn, new Map([['/tmp/secret/b.png', shareImageKey(0)]]))
    const text = JSON.stringify(sanitized)
    expect(text).not.toContain('/tmp/secret')
    expect(text).toContain('cotta-asset/0')
  })

  const assistantText = (text: string): TurnSummary => ({ primaryUserUuid: 't', messages: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }] }) as never
  const sanitizedText = (text: string, keyBySrc: Map<string, string>): string => {
    const content = (sanitizeTurnForShare(assistantText(text), keyBySrc).messages[0] as { message: { content: Array<{ text: string }> } }).message.content
    return content[0].text
  }

  it('rewrites images inside md payload fences, which render as markdown', () => {
    const text = 'before\n```md\n![a](/p/a.png)\n```js\nx\n```\n```\nafter ![b](/p/b.png)'
    const paths = turnImagePaths(assistantText(text)).map(({ src }) => src)
    expect(paths).toEqual(['/p/a.png', '/p/b.png'])
    const keyBySrc = new Map(paths.map((src, index) => [src, shareImageKey(index)]))
    expect(sanitizedText(text, keyBySrc)).toBe('before\n```md\n![a](cotta-asset/0)\n```js\nx\n```\n```\nafter ![b](cotta-asset/1)')
  })

  it('replaces the destination, not a title holding the same text', () => {
    const keyBySrc = new Map([['/p/x.png', shareImageKey(0)]])
    expect(sanitizedText('![a](/p/x.png "/p/x.png")\n\n![r][r]\n\n[r]: /p/x.png \'/p/x.png\'', keyBySrc)).toBe('![a](cotta-asset/0 "/p/x.png")\n\n![r][r]\n\n[r]: cotta-asset/0 \'/p/x.png\'')
  })

  it('rewrites destinations written with escapes, entities or angle brackets', () => {
    const text = '![a](/p/a\\(1\\).png) ![b](/p/a&amp;b.png) ![c](</p/c d.png>)'
    const paths = turnImagePaths(assistantText(text)).map(({ src }) => src)
    expect(paths).toHaveLength(3)
    const keyBySrc = new Map(paths.map((src, index) => [src, shareImageKey(index)]))
    expect(sanitizedText(text, keyBySrc)).toBe('![a](cotta-asset/0) ![b](cotta-asset/1) ![c](<cotta-asset/2>)')
  })

  it('relativizes cwd-prefixed tool paths and prunes bodies out of the snapshot', () => {
    const cwd = '/home/me/proj'
    const turn = {
      primaryUserUuid: 't',
      userCwd: cwd,
      messages: [
        { type: 'user', message: { role: 'user', content: 'go' } },
        { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: `${cwd}/src/a.ts` } }] } },
        {
          type: 'user',
          cwd,
          parent_tool_use_id: 'tu1',
          toolUseResult: { type: 'text', file: { filePath: `${cwd}/src/a.ts`, content: 'SECRET LINE 1\nSECRET LINE 2\n' } },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'SECRET RESULT' }] },
        },
      ],
    } as never as TurnSummary
    const text = JSON.stringify(sanitizeTurnForShare(turn, new Map()))
    expect(text).not.toContain(cwd) // no absolute path or cwd leaks
    expect(text).not.toContain('SECRET LINE 1')
    expect(text).not.toContain('SECRET RESULT')
    expect(text).toContain('src/a.ts') // path kept, now relative, so the Read header still shows it
  })

  it('strips cwd from a string-valued toolUseResult', () => {
    const cwd = '/home/me/proj'
    const turn = {
      primaryUserUuid: 't',
      messages: [
        { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', cwd, parent_tool_use_id: 'tu1', toolUseResult: `${cwd}/out.txt`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] } },
      ],
    } as never as TurnSummary
    expect(JSON.stringify(sanitizeTurnForShare(turn, new Map()))).not.toContain(cwd)
  })
})
